use clap::{Parser, Subcommand};
use diesel::prelude::*;
use diesel_async::{AsyncConnection, AsyncMysqlConnection, RunQueryDsl};
use grader_backend::{
    app::{
        cache::{self, Cache},
        config::Config,
        db,
        error::AppError,
        metrics::Metrics,
        migrations,
        state::AppState,
    },
    files::storage::Storage,
    identity::password,
    schema::users,
};
use std::sync::Arc;
use tracing_subscriber::EnvFilter;

#[derive(Parser)]
#[command(version, about = "Grader Axum backend and database lifecycle")]
struct Cli {
    #[command(subcommand)]
    command: Option<Command>,
}

#[derive(Subcommand)]
enum Command {
    Serve,
    /// Apply pending database migrations.
    Migrate,
    /// Initialize the isolated local object-storage bucket.
    InitStorage,
    /// Create an administrator; password is read from GRADER_ADMIN_PASSWORD.
    CreateAdmin {
        #[arg(long)]
        username: String,
        #[arg(long)]
        real_name: String,
    },
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    dotenvy::dotenv().ok();
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::builder()
                .with_default_directive(tracing::level_filters::LevelFilter::INFO.into())
                .from_env_lossy(),
        )
        .init();
    let cli = Cli::parse();
    let database_url = std::env::var("DATABASE_URL")?;
    match cli.command.unwrap_or(Command::Serve) {
        Command::Migrate => migrations::migrate(&database_url).await?,
        Command::InitStorage => {
            let config = Config::from_env()?;
            let url = url::Url::parse(&config.s3_internal_url)?;
            if !matches!(url.host_str(), Some("127.0.0.1" | "localhost" | "::1")) {
                anyhow::bail!("init-storage only supports loopback storage");
            }
            Storage::new(&config).await?.ensure_bucket().await?;
        }
        Command::CreateAdmin {
            username,
            real_name,
        } => {
            migrations::assert_current(&database_url).await?;
            if username.is_empty()
                || username.chars().count() > 150
                || real_name.is_empty()
                || real_name.chars().count() > 1000
            {
                anyhow::bail!("Invalid administrator username or real name");
            }
            let secret = std::env::var("GRADER_ADMIN_PASSWORD")?;
            if secret.len() < 12 {
                anyhow::bail!("Administrator password must contain at least 12 bytes");
            }
            let iterations = std::env::var("PASSWORD_ITERATIONS")
                .unwrap_or_else(|_| "100000".into())
                .parse::<u32>()?;
            let hash =
                tokio::task::spawn_blocking(move || password::hash(&secret, iterations)).await??;
            let mut conn = AsyncMysqlConnection::establish(&database_url).await?;
            conn.transaction::<_, AppError, _>(async |conn| {
                diesel::insert_into(users::table)
                    .values((
                        users::username.eq(&username),
                        users::real_name.eq(&real_name),
                        users::password.eq(hash),
                        users::role.eq(2),
                        users::is_staff.eq(true),
                        users::is_active.eq(true),
                        users::password_expired.eq(false),
                    ))
                    .execute(conn)
                    .await?;
                cache::invalidate_auth(conn).await?;
                Ok(())
            })
            .await?;
            tracing::info!("Administrator created");
        }
        Command::Serve => {
            let config = Arc::new(Config::from_env()?);
            let metrics = Metrics::install()?;
            let cache = Cache::from_env()?;
            migrations::assert_current(&config.database_url).await?;
            let pool = db::pool(&config.database_url, &metrics).await?;
            let storage = Arc::new(Storage::new(&config).await?);
            let extractor = tonic::transport::Endpoint::from_shared(config.extractor_url.clone())?
                .connect_timeout(std::time::Duration::from_secs(
                    config.extractor_connect_timeout_seconds,
                ))
                .timeout(std::time::Duration::from_secs(
                    config.extractor_timeout_seconds,
                ))
                .connect_lazy();
            let listener = tokio::net::TcpListener::bind(config.bind).await?;
            let address = listener.local_addr()?;
            let state = AppState {
                pool,
                cache,
                config,
                storage,
                extractor,
            };
            let app = grader_backend::router(state, metrics)?;
            tracing::info!(%address, "Grader backend listening");
            axum::serve(
                listener,
                app.into_make_service_with_connect_info::<std::net::SocketAddr>(),
            )
            .with_graceful_shutdown(shutdown())
            .await?;
        }
    }
    Ok(())
}

async fn shutdown() {
    #[cfg(unix)]
    {
        let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("Cannot install termination handler");
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {},
            _ = term.recv() => {},
        }
    }
    #[cfg(not(unix))]
    let _ = tokio::signal::ctrl_c().await;
}
