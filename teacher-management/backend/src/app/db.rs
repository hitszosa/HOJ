use crate::app::{
    error::{AppError, Result},
    metrics::Metrics,
    state::AppState,
};
use axum::{extract::FromRequestParts, http::request::Parts};
use axum_prometheus::metrics::Counter;
use diesel::{
    ConnectionError,
    connection::{Instrumentation, InstrumentationEvent},
};
use diesel_async::{
    AsyncConnection, AsyncMysqlConnection, SimpleAsyncConnection,
    pooled_connection::{AsyncDieselConnectionManager, ManagerConfig, bb8},
};
use futures_util::FutureExt;
use std::time::Duration;

pub type Pool = bb8::Pool<AsyncMysqlConnection>;
pub type Connection = bb8::PooledConnection<'static, AsyncMysqlConnection>;

/// A checked-out connection for a SQL-only request phase.
/// Extract authentication first; it may briefly borrow the same pool.
pub struct Db(pub Connection);

impl FromRequestParts<AppState> for Db {
    type Rejection = AppError;

    async fn from_request_parts(_parts: &mut Parts, state: &AppState) -> Result<Self> {
        Ok(Self(connect(state).await?))
    }
}

/// Inject the pool instead when work alternates between SQL and external I/O.
/// Each connection is returned before waiting on S3, providers or password work.
#[derive(Clone)]
pub struct Database(Pool);

impl FromRequestParts<AppState> for Database {
    type Rejection = AppError;

    async fn from_request_parts(_parts: &mut Parts, state: &AppState) -> Result<Self> {
        Ok(Self(state.pool.clone()))
    }
}

impl Database {
    pub async fn connect(&self) -> Result<Connection> {
        checkout(&self.0).await
    }
}

struct QueryMetrics(Counter);
impl Instrumentation for QueryMetrics {
    fn on_connection_event(&mut self, event: InstrumentationEvent<'_>) {
        if matches!(event, InstrumentationEvent::StartQuery { .. }) {
            self.0.increment(1);
        }
    }
}

pub async fn pool(database_url: &str, metrics: &Metrics) -> Result<Pool> {
    let queries = metrics.queries.clone();
    let mut manager_config = ManagerConfig::default();
    manager_config.custom_setup = Box::new(move |url| {
        let queries = queries.clone();
        async move {
            let mut conn = AsyncMysqlConnection::establish(url).await?;
            conn.batch_execute(
                "SET SESSION TRANSACTION ISOLATION LEVEL READ COMMITTED; SET time_zone = '+00:00';",
            )
            .await
            .map_err(ConnectionError::CouldntSetupConfiguration)?;
            conn.set_instrumentation(QueryMetrics(queries));
            Ok(conn)
        }
        .boxed()
    });
    let manager = AsyncDieselConnectionManager::new_with_config(database_url, manager_config);
    let max_connections = std::env::var("DATABASE_MAX_CONNECTIONS")
        .ok()
        .map(|v| v.parse::<u32>())
        .transpose()
        .map_err(|_| AppError::Internal("Invalid DATABASE_MAX_CONNECTIONS".into()))?
        .unwrap_or(50);
    if max_connections == 0 {
        return Err(AppError::Internal("Database pool cannot be empty".into()));
    }
    Pool::builder()
        .max_size(max_connections)
        .min_idle(Some(2.min(max_connections)))
        .connection_timeout(Duration::from_secs(10))
        .idle_timeout(Some(Duration::from_secs(300)))
        .build(manager)
        .await
        .map_err(|_| AppError::Unavailable("Cannot connect to database".into()))
}

pub async fn connect(state: &AppState) -> Result<Connection> {
    checkout(&state.pool).await
}

async fn checkout(pool: &Pool) -> Result<Connection> {
    pool.get_owned()
        .await
        .map_err(|_| AppError::Unavailable("Database pool unavailable".into()))
}
