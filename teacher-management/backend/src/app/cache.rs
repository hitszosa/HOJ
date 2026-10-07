use crate::{
    app::{
        db,
        error::{AppError, Result},
        state::AppState,
    },
    schema::cache_revision,
};
use axum::{
    body::{Body, Bytes},
    extract::{FromRequestParts, Request, State},
    http::{header::CONTENT_TYPE, request::Parts},
    middleware::Next,
    response::{IntoResponse, Response},
};
use axum_prometheus::metrics::{counter, describe_counter};
use chrono::{NaiveDateTime, Utc};
use diesel::prelude::*;
use diesel_async::{AsyncMysqlConnection, RunQueryDsl};
use redis::{AsyncConnectionConfig, Client, aio::MultiplexedConnection};
use serde::{
    Deserialize, Serialize,
    de::{DeserializeOwned, IgnoredAny},
};
use sha2::{Digest, Sha256};
use std::{
    cell::Cell,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tokio::time::timeout;

const FRAME: &[u8; 4] = b"GRC1";
const HEADER_LEN: usize = 12;
const RECONNECT_DELAY: Duration = Duration::from_secs(1);
const AUTH_FRAME: &[u8; 4] = b"GRA1";
const AUTH_LEASE_MS: i64 = 2_000;
const AUTH_VALUE_TTL: Duration = Duration::from_secs(300);
// A single key holds either a fill token or an epoch. DEL therefore fences every
// already-started fill; a late reader cannot publish after invalidation.
const PUBLISH_AUTH_EPOCH: &str = r#"
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
redis.call('SET', KEYS[1], ARGV[2], 'PXAT', ARGV[3])
return 1
"#;

tokio::task_local! {
    static AUTH_MUTATED: Cell<bool>;
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct AuthEpoch {
    pub revision: String,
    pub expires_at_ms: i64,
}

impl AuthEpoch {
    fn valid(&self) -> bool {
        let now = Utc::now().timestamp_millis();
        self.revision.len() == 36
            && now < self.expires_at_ms
            && self.expires_at_ms <= now.saturating_add(AUTH_LEASE_MS)
    }
}

/// Optional acceleration only. The database revision is never cached in memory.
#[derive(Clone)]
pub struct Cache {
    inner: Option<Arc<Backend>>,
}

struct Backend {
    client: Client,
    namespace: String,
    auth_namespace: String,
    ttl: Duration,
    timeout: Duration,
    connection: Mutex<ConnectionState>,
}

struct ConnectionState {
    connection: Option<MultiplexedConnection>,
    generation: u64,
    retry_at: Instant,
}

impl Cache {
    /// Construction validates configuration but never waits for Redis startup.
    pub fn from_env() -> Result<Self> {
        describe_counter!("grader_cache_hits_total", "Authorized JSON cache hits");
        describe_counter!(
            "grader_cache_misses_total",
            "JSON reads falling back to the database"
        );
        describe_counter!(
            "grader_cache_errors_total",
            "Redis failures or invalid cache entries"
        );
        counter!("grader_cache_hits_total").increment(0);
        counter!("grader_cache_misses_total").increment(0);
        for operation in ["connect", "get", "set", "entry"] {
            counter!("grader_cache_errors_total", "operation" => operation).increment(0);
        }
        describe_counter!("grader_auth_cache_hits_total", "Authentication cache hits");
        describe_counter!(
            "grader_auth_cache_misses_total",
            "Authentication cache fallbacks"
        );
        describe_counter!(
            "grader_auth_cache_errors_total",
            "Authentication Redis failures or invalid entries"
        );
        for kind in ["epoch", "entry"] {
            counter!("grader_auth_cache_hits_total", "kind" => kind).increment(0);
            counter!("grader_auth_cache_misses_total", "kind" => kind).increment(0);
        }
        for operation in [
            "connect",
            "get",
            "entry",
            "claim",
            "publish",
            "set",
            "invalidate",
        ] {
            counter!("grader_auth_cache_errors_total", "operation" => operation).increment(0);
        }
        let redis_url = std::env::var("REDIS_URL").unwrap_or_default();
        if redis_url.trim().is_empty() {
            return Ok(Self { inner: None });
        }
        let ttl = bounded_env("REDIS_CACHE_TTL_SECONDS", 60, 300)?;
        let timeout_ms = bounded_env("REDIS_TIMEOUT_MS", 50, 1000)?;
        let database_url = std::env::var("DATABASE_URL")
            .map_err(|_| AppError::Internal("Missing DATABASE_URL".into()))?;
        // Hash the full connection identity, including socket/query options. Changing
        // credentials merely produces a cold namespace; secrets never appear in keys.
        let identity = hex::encode(Sha256::digest(database_url.as_bytes()));
        let prefix = std::env::var("REDIS_KEY_PREFIX").unwrap_or_else(|_| "grader-backend".into());
        let client =
            Client::open(redis_url).map_err(|_| AppError::Internal("Invalid REDIS_URL".into()))?;
        Ok(Self {
            inner: Some(Arc::new(Backend {
                client,
                namespace: format!("{prefix}:json-v1:{identity}"),
                auth_namespace: format!("{prefix}:auth-v1:{identity}"),
                ttl: Duration::from_secs(ttl),
                timeout: Duration::from_millis(timeout_ms),
                connection: Mutex::new(ConnectionState {
                    connection: None,
                    generation: 0,
                    retry_at: Instant::now(),
                }),
            })),
        })
    }
}

fn bounded_env(name: &str, default: u64, max: u64) -> Result<u64> {
    let value = std::env::var(name)
        .ok()
        .map(|value| value.parse::<u64>())
        .transpose()
        .map_err(|_| AppError::Internal(format!("Invalid {name}")))?
        .unwrap_or(default);
    if !(1..=max).contains(&value) {
        return Err(AppError::Internal(format!(
            "{name} must be between 1 and {max}"
        )));
    }
    Ok(value)
}

impl Backend {
    async fn connection(&self) -> Option<(u64, MultiplexedConnection)> {
        let generation = {
            let mut state = self
                .connection
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            if let Some(connection) = &state.connection {
                return Some((state.generation, connection.clone()));
            }
            if Instant::now() < state.retry_at {
                return None;
            }
            state.retry_at = Instant::now() + RECONNECT_DELAY;
            state.generation = state.generation.wrapping_add(1);
            state.generation
        };
        // No lock or database lease is held while the extractor connects. Other
        // requests bypass instead of queuing behind a failed reconnect attempt.
        let config = AsyncConnectionConfig::new()
            .set_connection_timeout(self.timeout)
            .set_response_timeout(self.timeout);
        let result = timeout(
            self.timeout,
            self.client
                .get_multiplexed_async_connection_with_config(&config),
        )
        .await;
        let mut state = self
            .connection
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        match result {
            Ok(Ok(connection)) if state.generation == generation => {
                state.connection = Some(connection.clone());
                Some((generation, connection))
            }
            Ok(Ok(_)) => None,
            _ => {
                counter!("grader_cache_errors_total", "operation" => "connect").increment(1);
                if state.generation == generation {
                    state.retry_at = Instant::now() + RECONNECT_DELAY;
                }
                None
            }
        }
    }

    fn failed(&self, generation: u64, operation: &'static str) {
        counter!("grader_cache_errors_total", "operation" => operation).increment(1);
        let mut state = self
            .connection
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        // An old in-flight failure must not discard a replacement connection.
        if state.generation == generation {
            state.connection = None;
            state.retry_at = Instant::now() + RECONNECT_DELAY;
        }
    }
}

/// Extract FIRST, before authentication or any resource/DB extractor. This makes
/// it impossible to fill a new revision using a previously loaded old resource.
/// Call get only AFTER request authorization (including its auth epoch); no headers are cached.
pub struct ReadCache {
    cache: Cache,
    revision: Option<String>,
    started: Instant,
    started_at: i64,
}

impl FromRequestParts<AppState> for ReadCache {
    type Rejection = AppError;

    async fn from_request_parts(_parts: &mut Parts, state: &AppState) -> Result<Self> {
        let mut read = Self {
            cache: state.cache.clone(),
            revision: None,
            started: Instant::now(),
            started_at: Utc::now().timestamp_millis(),
        };
        if let Some(backend) = &read.cache.inner
            && backend.connection().await.is_some()
        {
            let mut conn = db::connect(state).await?;
            read.revision = Some(
                cache_revision::table
                    .find(1)
                    .select(cache_revision::revision)
                    .first::<String>(&mut conn)
                    .await?,
            );
        }
        Ok(read)
    }
}

impl ReadCache {
    pub fn enabled(&self) -> bool {
        self.revision.is_some()
    }

    pub async fn get(
        &self,
        key: &str,
        conn: &mut AsyncMysqlConnection,
    ) -> Result<Option<Response>> {
        if let Some((response, deadline)) = self.get_entry(key).await {
            // A membership/role change may have committed while authentication or
            // Redis was awaited. Revalidate on the existing lease before serving.
            let current = cache_revision::table
                .find(1)
                .select(cache_revision::revision)
                .first::<String>(conn)
                .await?;
            if Some(&current) == self.revision.as_ref() && Utc::now().timestamp_millis() < deadline
            {
                counter!("grader_cache_hits_total").increment(1);
                return Ok(Some(response));
            }
        }
        counter!("grader_cache_misses_total").increment(1);
        Ok(None)
    }

    async fn get_entry(&self, key: &str) -> Option<(Response, i64)> {
        let backend = self.cache.inner.as_ref()?;
        let revision = self.revision.as_ref()?;
        let (generation, mut connection) = backend.connection().await?;
        let result = timeout(
            backend.timeout,
            redis::cmd("GET")
                .arg(format!("{}:{revision}:{key}", backend.namespace))
                .query_async::<Option<Vec<u8>>>(&mut connection),
        )
        .await;
        let frame = match result {
            Ok(Ok(Some(frame))) => frame,
            Ok(Ok(None)) => return None,
            _ => {
                backend.failed(generation, "get");
                return None;
            }
        };
        if frame.len() <= HEADER_LEN || &frame[..4] != FRAME {
            counter!("grader_cache_errors_total", "operation" => "entry").increment(1);
            return None;
        }
        let deadline = i64::from_be_bytes(frame[4..HEADER_LEN].try_into().ok()?);
        let Ok(body) = std::str::from_utf8(&frame[HEADER_LEN..]) else {
            counter!("grader_cache_errors_total", "operation" => "entry").increment(1);
            return None;
        };
        let mut json = serde_json::Deserializer::from_str(body);
        if IgnoredAny::deserialize(&mut json).is_err() || json.end().is_err() {
            counter!("grader_cache_errors_total", "operation" => "entry").increment(1);
            return None;
        }
        // Check after the Redis read AND JSON validation, not before network I/O.
        if Utc::now().timestamp_millis() >= deadline {
            return None;
        }
        Some((
            json_response(Bytes::from(frame).slice(HEADER_LEN..)),
            deadline,
        ))
    }

    pub async fn json(
        &self,
        key: &str,
        value: &impl Serialize,
        valid_until: Option<NaiveDateTime>,
    ) -> Result<Response> {
        let mut frame = Vec::with_capacity(128);
        frame.extend_from_slice(FRAME);
        frame.extend_from_slice(&0_i64.to_be_bytes());
        serde_json::to_writer(&mut frame, value)
            .map_err(|_| AppError::Internal("Cannot serialize JSON response".into()))?;
        if let (Some(backend), Some(revision)) = (&self.cache.inner, &self.revision) {
            let deadline = valid_until
                .map(|value| value.and_utc().timestamp_millis())
                .unwrap_or(i64::MAX)
                .min(self.started_at + backend.ttl.as_millis() as i64);
            frame[4..HEADER_LEN].copy_from_slice(&deadline.to_be_bytes());
            self.store(backend, revision, key, &frame, deadline).await;
        }
        // The exact serialized body is both stored and returned, without a parse
        // or a second serialization. Only status 200 and content type are emitted.
        Ok(json_response(Bytes::from(frame).slice(HEADER_LEN..)))
    }

    async fn store(
        &self,
        backend: &Backend,
        revision: &str,
        key: &str,
        frame: &[u8],
        deadline: i64,
    ) {
        if self.started.elapsed() >= backend.ttl || Utc::now().timestamp_millis() >= deadline {
            return;
        }
        let Some((generation, mut connection)) = backend.connection().await else {
            return;
        };
        let remaining = backend
            .ttl
            .saturating_sub(self.started.elapsed())
            .as_millis() as i64;
        let remaining = remaining.min(deadline.saturating_sub(Utc::now().timestamp_millis()));
        if remaining <= 0 {
            return;
        }
        let result = timeout(
            backend.timeout,
            redis::cmd("SET")
                .arg(format!("{}:{revision}:{key}", backend.namespace))
                .arg(frame)
                .arg("PX")
                .arg(remaining)
                .query_async::<()>(&mut connection),
        )
        .await;
        if !matches!(result, Ok(Ok(()))) {
            backend.failed(generation, "set");
        }
    }
}

fn json_response(body: Bytes) -> Response {
    ([(CONTENT_TYPE, "application/json")], Body::from(body)).into_response()
}

/// LAST database statement of every successful cached-data mutation transaction.
/// Lock business rows first. Failure rolls the mutation back even without Redis.
pub async fn invalidate(conn: &mut AsyncMysqlConnection) -> Result<()> {
    let updated = diesel::update(cache_revision::table.find(1))
        .set(cache_revision::revision.eq(uuid::Uuid::new_v4().to_string()))
        .execute(conn)
        .await?;
    if updated != 1 {
        return Err(diesel::result::Error::NotFound.into());
    }
    Ok(())
}

/// LAST SQL statement for mutations affecting sessions, users or memberships.
/// Business locks must precede the singleton lock, just as for `invalidate`.
/// Notify request middleware after the UPDATE succeeds, not necessarily commits.
pub async fn invalidate_auth(conn: &mut AsyncMysqlConnection) -> Result<()> {
    let updated = diesel::update(cache_revision::table.find(1))
        .set((
            cache_revision::revision.eq(uuid::Uuid::new_v4().to_string()),
            cache_revision::auth_revision.eq(uuid::Uuid::new_v4().to_string()),
        ))
        .execute(conn)
        .await?;
    if updated != 1 {
        return Err(diesel::result::Error::NotFound.into());
    }
    let _ = AUTH_MUTATED.try_with(|mutated| mutated.set(true));
    Ok(())
}

impl Backend {
    async fn auth_command<T: redis::FromRedisValue>(
        &self,
        operation: &'static str,
        command: &redis::Cmd,
    ) -> Option<T> {
        let Some((generation, mut connection)) = self.connection().await else {
            counter!("grader_auth_cache_errors_total", "operation" => "connect").increment(1);
            return None;
        };
        match timeout(self.timeout, command.query_async::<T>(&mut connection)).await {
            Ok(Ok(value)) => Some(value),
            _ => {
                counter!("grader_auth_cache_errors_total", "operation" => operation).increment(1);
                self.failed(generation, operation);
                None
            }
        }
    }

    fn auth_key(&self, epoch: &AuthEpoch, key: &str) -> String {
        // Defense in depth: even a caller accidentally passing a raw session
        // secret cannot put that credential into a Redis key.
        let digest = hex::encode(Sha256::digest(key.as_bytes()));
        format!("{}:value:{}:{digest}", self.auth_namespace, epoch.revision)
    }
}

impl Cache {
    /// Shared bounded lease, never a process-local memo. A failed or contested
    /// fill is an authoritative-DB fallback, not permission to reuse an old epoch.
    pub async fn auth_epoch(&self, state: &AppState) -> Result<Option<AuthEpoch>> {
        let mut hit = false;
        let epoch = self.load_auth_epoch(state, &mut hit).await?;
        let metric = if hit {
            "grader_auth_cache_hits_total"
        } else {
            "grader_auth_cache_misses_total"
        };
        counter!(metric, "kind" => "epoch").increment(1);
        Ok(epoch)
    }

    async fn load_auth_epoch(&self, state: &AppState, hit: &mut bool) -> Result<Option<AuthEpoch>> {
        let Some(backend) = &self.inner else {
            return Ok(None);
        };
        let key = format!("{}:epoch", backend.auth_namespace);
        let Some(cached) = backend
            .auth_command::<Option<Vec<u8>>>("get", redis::cmd("GET").arg(&key))
            .await
        else {
            return Ok(None);
        };
        if let Some(cached) = cached {
            if cached.starts_with(b"fill:") {
                return Ok(None);
            }
            let epoch = match serde_json::from_slice::<AuthEpoch>(&cached) {
                Ok(epoch) => epoch,
                Err(_) => {
                    counter!("grader_auth_cache_errors_total", "operation" => "entry").increment(1);
                    return Ok(None);
                }
            };
            *hit = epoch.valid();
            return Ok((*hit).then_some(epoch));
        }

        // Fix the absolute deadline BEFORE pool acquisition and DB SELECT, not
        // when a potentially delayed query completes. Redis uses the same date.
        let expires_at_ms = Utc::now().timestamp_millis() + AUTH_LEASE_MS;
        let token = format!("fill:{}", uuid::Uuid::new_v4());
        let claimed = backend
            .auth_command::<Option<String>>(
                "claim",
                redis::cmd("SET")
                    .arg(&key)
                    .arg(&token)
                    .arg("NX")
                    .arg("PXAT")
                    .arg(expires_at_ms),
            )
            .await;
        if !matches!(&claimed, Some(Some(value)) if value == "OK") {
            return Ok(None);
        }
        let revision = {
            let mut conn = db::connect(state).await?;
            cache_revision::table
                .find(1)
                .select(cache_revision::auth_revision)
                .first::<String>(&mut conn)
                .await?
        };
        let epoch = AuthEpoch {
            revision,
            expires_at_ms,
        };
        if !epoch.valid() {
            return Ok(None);
        }
        let Ok(encoded) = serde_json::to_vec(&epoch) else {
            counter!("grader_auth_cache_errors_total", "operation" => "entry").increment(1);
            return Ok(None);
        };
        let published = backend
            .auth_command::<i64>(
                "publish",
                redis::cmd("EVAL")
                    .arg(PUBLISH_AUTH_EPOCH)
                    .arg(1)
                    .arg(&key)
                    .arg(&token)
                    .arg(encoded)
                    .arg(expires_at_ms),
            )
            .await;
        // Both publication and the deadline must survive ALL intervening waits.
        Ok((published == Some(1) && epoch.valid()).then_some(epoch))
    }

    pub async fn auth_get<T: DeserializeOwned>(&self, epoch: &AuthEpoch, key: &str) -> Option<T> {
        let value = self.auth_entry(epoch, key).await;
        let metric = if value.is_some() {
            "grader_auth_cache_hits_total"
        } else {
            "grader_auth_cache_misses_total"
        };
        counter!(metric, "kind" => "entry").increment(1);
        value
    }

    async fn auth_entry<T: DeserializeOwned>(&self, epoch: &AuthEpoch, key: &str) -> Option<T> {
        let backend = self.inner.as_ref()?;
        if !epoch.valid() {
            return None;
        }
        let frame = backend
            .auth_command::<Option<Vec<u8>>>(
                "get",
                redis::cmd("GET").arg(backend.auth_key(epoch, key)),
            )
            .await??;
        if frame.len() <= HEADER_LEN || &frame[..4] != AUTH_FRAME {
            counter!("grader_auth_cache_errors_total", "operation" => "entry").increment(1);
            return None;
        }
        let deadline = i64::from_be_bytes(frame[4..HEADER_LEN].try_into().ok()?);
        let value = match serde_json::from_slice(&frame[HEADER_LEN..]) {
            Ok(value) => value,
            Err(_) => {
                counter!("grader_auth_cache_errors_total", "operation" => "entry").increment(1);
                return None;
            }
        };
        (epoch.valid() && Utc::now().timestamp_millis() < deadline).then_some(value)
    }

    /// Values survive successive leases of the SAME database revision. A new
    /// revision makes all previous session and permission values unreachable.
    pub async fn auth_put<T: Serialize>(
        &self,
        epoch: &AuthEpoch,
        key: &str,
        value: &T,
        ttl: Duration,
    ) {
        let Some(backend) = &self.inner else {
            return;
        };
        if !epoch.valid() || ttl.is_zero() {
            return;
        }
        let deadline = Utc::now().timestamp_millis() + ttl.min(AUTH_VALUE_TTL).as_millis() as i64;
        let mut frame = Vec::with_capacity(128);
        frame.extend_from_slice(AUTH_FRAME);
        frame.extend_from_slice(&deadline.to_be_bytes());
        if serde_json::to_writer(&mut frame, value).is_err() {
            counter!("grader_auth_cache_errors_total", "operation" => "entry").increment(1);
            return;
        }
        if !epoch.valid() || Utc::now().timestamp_millis() >= deadline {
            return;
        }
        let _ = backend
            .auth_command::<()>(
                "set",
                redis::cmd("SET")
                    .arg(backend.auth_key(epoch, key))
                    .arg(frame)
                    .arg("PXAT")
                    .arg(deadline),
            )
            .await;
    }

    pub async fn invalidate_auth_epoch(&self) {
        let Some(backend) = &self.inner else {
            return;
        };
        let _ = backend
            .auth_command::<i64>(
                "invalidate",
                redis::cmd("DEL").arg(format!("{}:epoch", backend.auth_namespace)),
            )
            .await;
    }
}

/// Evict after marked handlers finish, regardless of response status or rollback.
/// The marker records a successful UPDATE, not a commit. Cancellation, process
/// death and failed Redis DEL remain covered by the two-second DB-bounded lease.
pub async fn invalidate_auth_response(
    State(state): State<AppState>,
    request: Request,
    next: Next,
) -> Response {
    let (response, auth_mutated) = AUTH_MUTATED
        .scope(Cell::new(false), async {
            let response = next.run(request).await;
            (response, AUTH_MUTATED.with(Cell::get))
        })
        .await;
    if auth_mutated {
        state.cache.invalidate_auth_epoch().await;
    }
    response
}
