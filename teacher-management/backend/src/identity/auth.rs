mod mobile;

use crate::app::cache::{self, AuthEpoch};
use crate::app::db::{self, Database, Db};
use crate::app::error::{AppError, Result};
use crate::app::state::AppState;
use crate::identity::password;
use crate::identity::users::{self as user_service, UserInfo};
use crate::schema::{user_sessions, users};
use axum::extract::{FromRequestParts, Request, State};
use axum::http::{HeaderMap, HeaderValue, Method, StatusCode, header, request::Parts};
use axum::middleware::Next;
use axum::response::Response;
use axum::routing::{get, post};
use axum::{Json, Router};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use chrono::{Duration, NaiveDateTime, Utc};
use cookie::{Cookie, CookieJar, SameSite};
use diesel::prelude::*;
use diesel_async::{AsyncConnection, AsyncMysqlConnection, RunQueryDsl};
use hmac::{Hmac, Mac};
use rand::{TryRngCore, rngs::OsRng};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::sync::{Arc, Mutex};
use subtle::ConstantTimeEq;

#[derive(Clone, Debug)]
pub struct CurrentUser {
    pub id: i64,
    pub username: String,
    pub role: i32,
    pub(crate) auth_epoch: Option<AuthEpoch>,
    pub(crate) profile: Option<UserInfo>,
}

impl CurrentUser {
    pub fn require_admin(&self) -> Result<()> {
        if self.role == 2 {
            Ok(())
        } else {
            Err(AppError::Authorization("Super administrator role required".into()))
        }
    }
    pub fn require_teacher(&self) -> Result<()> {
        if self.role >= 1 {
            Ok(())
        } else {
            Err(AppError::Authorization("Teacher role required".into()))
        }
    }
}

pub struct Teacher(pub CurrentUser);

pub struct Admin(pub CurrentUser);

impl FromRequestParts<AppState> for Admin {
    type Rejection = AppError;

    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> Result<Self> {
        let user = CurrentUser::from_request_parts(parts, state).await?;
        user.require_admin()?;
        Ok(Self(user))
    }
}

impl FromRequestParts<AppState> for Teacher {
    type Rejection = AppError;

    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> Result<Self> {
        let user = CurrentUser::from_request_parts(parts, state).await?;
        user.require_teacher()?;
        Ok(Self(user))
    }
}

/// Inside a transaction, lock any existing course first, then all affected users.
pub(crate) async fn lock_teacher(
    conn: &mut AsyncMysqlConnection,
    user_id: i64,
    target_ids: &[i64],
) -> Result<()> {
    lock_staff(conn, user_id, target_ids, 1).await
}

pub(crate) async fn lock_admin(
    conn: &mut AsyncMysqlConnection,
    user_id: i64,
    target_ids: &[i64],
) -> Result<()> {
    lock_staff(conn, user_id, target_ids, 2).await
}

async fn lock_staff(
    conn: &mut AsyncMysqlConnection,
    user_id: i64,
    target_ids: &[i64],
    minimum_role: i32,
) -> Result<()> {
    let mut ids = Vec::with_capacity(target_ids.len() + 1);
    ids.extend_from_slice(target_ids);
    ids.push(user_id);
    ids.sort_unstable();
    ids.dedup();
    let mut authorized = false;
    for chunk in ids.chunks(1000) {
        let locked = users::table
            .filter(users::id.eq_any(chunk))
            .order(users::id.asc())
            .select((users::id, users::is_active, users::role))
            .for_update()
            .load::<(i64, bool, i32)>(conn)
            .await?;
        authorized |= locked
            .iter()
            .any(|&(id, active, role)| id == user_id && active && role >= minimum_role);
    }
    if authorized {
        Ok(())
    } else {
        Err(AppError::Authorization("Teacher role required".into()))
    }
}

#[derive(Clone, Default)]
pub(crate) struct ResponseCookies(Arc<Mutex<HeaderMap>>);

/// Bridges request-parts authentication to response cookies, including failures.
pub async fn session_response(mut request: Request, next: Next) -> Response {
    let pending = ResponseCookies::default();
    request.extensions_mut().insert(pending.clone());
    let mut response = next.run(request).await;
    let has_session_cookie = response
        .headers()
        .get_all(header::SET_COOKIE)
        .iter()
        .any(|value| {
            value
                .to_str()
                .is_ok_and(|value| value.starts_with("sessionid="))
        });
    if !has_session_cookie && let Ok(headers) = pending.0.lock() {
        for value in headers.get_all(header::SET_COOKIE) {
            response
                .headers_mut()
                .append(header::SET_COOKIE, value.clone());
        }
    }
    response
}

impl FromRequestParts<AppState> for CurrentUser {
    type Rejection = AppError;

    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> Result<Self> {
        if let Some(user) = parts.extensions.get::<Self>() {
            return Ok(user.clone());
        }
        let pending = parts
            .extensions
            .get::<ResponseCookies>()
            .cloned()
            .unwrap_or_default();
        let require_csrf = !matches!(parts.method, Method::GET | Method::HEAD | Method::OPTIONS);
        let user = authenticate_cookie(state, &parts.headers, &pending, require_csrf).await?;
        parts.extensions.insert(user.clone());
        Ok(user)
    }
}

fn queue_cookies(pending: &ResponseCookies, headers: HeaderMap) {
    if let Ok(mut pending) = pending.0.lock() {
        for value in headers.get_all(header::SET_COOKIE) {
            pending.append(header::SET_COOKIE, value.clone());
        }
    }
}

fn missing_session() -> AppError {
    AppError::Auth("Missing or invalid session cookie".into())
}

fn cookie_jar(headers: &HeaderMap) -> CookieJar {
    let mut jar = CookieJar::new();
    for header in headers.get_all(header::COOKIE) {
        if let Ok(value) = header.to_str() {
            for item in value.split(';') {
                if let Ok(cookie) = Cookie::parse_encoded(item.trim().to_owned()) {
                    jar.add_original(cookie.into_owned());
                }
            }
        }
    }
    jar
}

fn session_key(state: &AppState, headers: &HeaderMap) -> Result<String> {
    if let Some(key) = super::hoj::credential_key(state, headers) { return Ok(key); }
    let jar = cookie_jar(headers);
    let cookie = jar
        .private(&state.config.cookie_key)
        .get("sessionid")
        .ok_or_else(missing_session)?;
    let key = cookie.value();
    if key.len() != 32 || !key.bytes().all(|byte| byte.is_ascii_alphanumeric()) {
        return Err(missing_session());
    }
    Ok(key.to_owned())
}

#[derive(Serialize, Deserialize)]
struct SessionInfo {
    profile: UserInfo,
    expires_at: NaiveDateTime,
}

async fn load_session(state: &AppState, session: &str) -> Result<SessionInfo> {
    let mut conn = db::connect(state).await?;
    let (profile, expires_at) = user_sessions::table
        .inner_join(users::table)
        .filter(user_sessions::session_key.eq(session))
        .filter(user_sessions::expires_at.gt(Utc::now().naive_utc()
            - Duration::seconds(state.config.session_refresh_grace_seconds as i64)))
        .filter(users::is_active.eq(true))
        .select((UserInfo::as_select(), user_sessions::expires_at))
        .first::<(UserInfo, NaiveDateTime)>(&mut *conn)
        .await
        .optional()?
        .ok_or_else(missing_session)?;
    Ok(SessionInfo {
        profile,
        expires_at,
    })
}

async fn renew_session(state: &AppState, session: &str, user_id: i64) -> Result<SessionInfo> {
    let mut conn = db::connect(state).await?;
    (*conn)
        .transaction::<_, AppError, _>(async |conn| {
            // Match login/password lock order; never recreate a deleted session.
            let profile = users::table
                .find(user_id)
                .filter(users::is_active.eq(true))
                .select(UserInfo::as_select())
                .for_update()
                .first::<UserInfo>(conn)
                .await
                .optional()?
                .ok_or_else(missing_session)?;
            let mut expires_at = user_sessions::table
                .filter(user_sessions::session_key.eq(session))
                .filter(user_sessions::user_id.eq(user_id))
                .select(user_sessions::expires_at)
                .for_update()
                .first::<NaiveDateTime>(conn)
                .await
                .optional()?
                .ok_or_else(missing_session)?;
            let now = Utc::now().naive_utc();
            if expires_at
                <= now - Duration::seconds(state.config.session_refresh_grace_seconds as i64)
            {
                return Err(missing_session());
            }
            if expires_at - now < Duration::days(1) {
                expires_at = now + Duration::days(7);
                diesel::update(user_sessions::table.filter(user_sessions::session_key.eq(session)))
                    .set(user_sessions::expires_at.eq(expires_at))
                    .execute(conn)
                    .await?;
            }
            Ok(SessionInfo {
                profile,
                expires_at,
            })
        })
        .await
}

async fn authenticate(
    state: &AppState,
    session: &str,
) -> Result<(CurrentUser, Option<NaiveDateTime>)> {
    let epoch = state.cache.auth_epoch(state).await?;
    let key = epoch.as_ref().map(|_| {
        format!(
            "session:{}",
            hex::encode(Sha256::digest(session.as_bytes()))
        )
    });
    let cached = if let (Some(epoch), Some(key)) = (epoch.as_ref(), key.as_ref()) {
        state.cache.auth_get::<SessionInfo>(epoch, key).await
    } else {
        None
    };
    let now = Utc::now().naive_utc();
    let cached = cached.filter(|info| {
        epoch
            .as_ref()
            .is_some_and(|epoch| epoch.expires_at_ms > Utc::now().timestamp_millis())
            && info.expires_at
                > now - Duration::seconds(state.config.session_refresh_grace_seconds as i64)
    });
    let cache_hit = cached.is_some();
    let mut info = match cached {
        Some(info) => info,
        None => load_session(state, session).await?,
    };
    let renewed = if info.expires_at - Utc::now().naive_utc() < Duration::days(1) {
        info = renew_session(state, session, info.profile.id).await?;
        Some(info.expires_at)
    } else {
        None
    };
    if (!cache_hit || renewed.is_some())
        && let (Some(epoch), Some(key)) = (epoch.as_ref(), key.as_ref())
    {
        let remaining = info.expires_at
            + Duration::seconds(state.config.session_refresh_grace_seconds as i64)
            - Utc::now().naive_utc();
        if let Ok(ttl) = remaining.to_std() {
            state
                .cache
                .auth_put(
                    epoch,
                    key,
                    &info,
                    ttl.min(std::time::Duration::from_secs(300)),
                )
                .await;
        }
    }
    Ok((
        CurrentUser {
            id: info.profile.id,
            username: info.profile.username.clone(),
            role: info.profile.role,
            auth_epoch: epoch.filter(|epoch| epoch.expires_at_ms > Utc::now().timestamp_millis()),
            profile: Some(info.profile),
        },
        renewed,
    ))
}

pub(crate) async fn authenticate_cookie(
    state: &AppState,
    headers: &HeaderMap,
    pending: &ResponseCookies,
    require_csrf: bool,
) -> Result<CurrentUser> {
    let result = async {
        if let Some(key) = super::hoj::credential_key(state, headers) {
            let user = super::hoj::authenticate(state, headers).await?;
            if require_csrf { verify_csrf_session(state, headers, &key)?; }
            let jar = cookie_jar(headers);
            let old = jar.get("csrftoken").map(|c| c.value());
            let token = match old {
                Some(token) if valid_csrf(state, &key, token)? => token.to_owned(),
                _ => csrf_token(state, &key)?,
            };
            let mut response = HeaderMap::new();
            append_cookie(&mut response, &Cookie::build(("csrftoken", token))
                .path("/").same_site(SameSite::Lax).secure(state.config.cookie_secure).build())?;
            queue_cookies(pending, response);
            return Ok(user);
        }
        let session = session_key(state, headers)?;
        if require_csrf {
            verify_csrf_session(state, headers, &session)?;
        }
        let (user, renewed) = authenticate(state, &session).await?;
        if let Some(expires) = renewed {
            let jar = cookie_jar(headers);
            let previous_csrf = jar.get("csrftoken").map(|cookie| cookie.value());
            let mut response = HeaderMap::new();
            set_cookies(state, &session, expires, previous_csrf, &mut response)?;
            queue_cookies(pending, response);
        }
        Ok(user)
    }
    .await;
    if matches!(&result, Err(AppError::Auth(_))) {
        let mut response = HeaderMap::new();
        clear_cookies(state, &mut response)?;
        queue_cookies(pending, response);
    }
    result
}

fn csrf_mac(state: &AppState, session: &str, nonce: &str) -> Result<Hmac<Sha256>> {
    let mut mac = Hmac::<Sha256>::new_from_slice(&state.config.csrf_secret)
        .map_err(|_| AppError::Internal("Invalid CSRF configuration".into()))?;
    mac.update(session.as_bytes());
    mac.update(b".");
    mac.update(nonce.as_bytes());
    Ok(mac)
}

fn csrf_token(state: &AppState, session: &str) -> Result<String> {
    let mut nonce = [0; 32];
    OsRng
        .try_fill_bytes(&mut nonce)
        .map_err(|_| AppError::Internal("Secure randomness unavailable".into()))?;
    let nonce = URL_SAFE_NO_PAD.encode(nonce);
    let signature = csrf_mac(state, session, &nonce)?.finalize().into_bytes();
    Ok(format!("{nonce}.{}", URL_SAFE_NO_PAD.encode(signature)))
}

fn valid_csrf(state: &AppState, session: &str, token: &str) -> Result<bool> {
    let Some((nonce, signature)) = token.split_once('.') else {
        return Ok(false);
    };
    if nonce.is_empty() {
        return Ok(false);
    }
    let Ok(signature) = URL_SAFE_NO_PAD.decode(signature) else {
        return Ok(false);
    };
    Ok(csrf_mac(state, session, nonce)?
        .verify_slice(&signature)
        .is_ok())
}

fn verify_csrf_session(state: &AppState, headers: &HeaderMap, session: &str) -> Result<()> {
    let jar = cookie_jar(headers);
    let cookie = jar.get("csrftoken").ok_or(AppError::Csrf)?;
    let token = headers
        .get("x-csrftoken")
        .and_then(|value| value.to_str().ok())
        .ok_or(AppError::Csrf)?;
    if !bool::from(token.as_bytes().ct_eq(cookie.value().as_bytes()))
        || !valid_csrf(state, session, token)?
    {
        return Err(AppError::Csrf);
    }
    Ok(())
}

pub async fn verify_csrf(state: &AppState, headers: &HeaderMap) -> Result<()> {
    let session = session_key(state, headers)?;
    verify_csrf_session(state, headers, &session)
}

pub async fn form_csrf(state: &AppState, headers: &HeaderMap) -> Result<String> {
    csrf_token(state, &session_key(state, headers)?)
}

pub async fn verify_form_csrf(state: &AppState, headers: &HeaderMap, token: &str) -> Result<()> {
    if valid_csrf(state, &session_key(state, headers)?, token)? {
        Ok(())
    } else {
        Err(AppError::Csrf)
    }
}

fn append_cookie(headers: &mut HeaderMap, cookie: &Cookie<'_>) -> Result<()> {
    let value = HeaderValue::from_str(&cookie.encoded().to_string())
        .map_err(|_| AppError::Internal("Invalid response cookie".into()))?;
    headers.append(header::SET_COOKIE, value);
    Ok(())
}

fn set_cookies(
    state: &AppState,
    session: &str,
    expires: NaiveDateTime,
    previous_csrf: Option<&str>,
    headers: &mut HeaderMap,
) -> Result<()> {
    // Keep browser credentials available throughout the server's renewal grace.
    let expires = expires + Duration::seconds(state.config.session_refresh_grace_seconds as i64);
    let expires = time::OffsetDateTime::from_unix_timestamp(expires.and_utc().timestamp())
        .map_err(|_| AppError::Internal("Invalid session expiry".into()))?;
    let mut jar = CookieJar::new();
    jar.private_mut(&state.config.cookie_key).add(
        Cookie::build(("sessionid", session.to_owned()))
            .path("/")
            .http_only(true)
            .same_site(SameSite::Lax)
            .secure(state.config.cookie_secure)
            .expires(expires)
            .build(),
    );
    for cookie in jar.delta() {
        append_cookie(headers, cookie)?;
    }
    let token = match previous_csrf {
        Some(token) if valid_csrf(state, session, token)? => token.to_owned(),
        _ => csrf_token(state, session)?,
    };
    append_cookie(
        headers,
        &Cookie::build(("csrftoken", token))
            .path("/")
            .http_only(false)
            .same_site(SameSite::Lax)
            .secure(state.config.cookie_secure)
            .expires(expires)
            .build(),
    )
}

fn clear_cookies(state: &AppState, headers: &mut HeaderMap) -> Result<()> {
    for name in ["sessionid", "csrftoken"] {
        let mut cookie = Cookie::build((name, ""))
            .path("/")
            .http_only(name == "sessionid")
            .same_site(SameSite::Lax)
            .secure(state.config.cookie_secure)
            .build();
        cookie.make_removal();
        append_cookie(headers, &cookie)?;
    }
    Ok(())
}

async fn insert_session(
    conn: &mut AsyncMysqlConnection,
    user_id: i64,
) -> Result<(String, NaiveDateTime)> {
    let mut random = [0; 16];
    OsRng
        .try_fill_bytes(&mut random)
        .map_err(|_| AppError::Internal("Secure randomness unavailable".into()))?;
    let key = hex::encode(random);
    let expires = Utc::now().naive_utc() + Duration::days(7);
    diesel::insert_into(user_sessions::table)
        .values((
            user_sessions::session_key.eq(&key),
            user_sessions::user_id.eq(user_id),
            user_sessions::expires_at.eq(expires),
        ))
        .execute(conn)
        .await?;
    Ok((key, expires))
}

pub async fn issue_session(state: &AppState, user_id: i64, headers: &mut HeaderMap) -> Result<()> {
    let mut conn = db::connect(state).await?;
    let (key, expires) = (*conn)
        .transaction::<_, AppError, _>(async |conn| {
            users::table
                .find(user_id)
                .filter(users::is_active.eq(true))
                .select(users::id)
                .for_update()
                .first::<i64>(conn)
                .await
                .optional()?
                .ok_or_else(missing_session)?;
            insert_session(conn, user_id).await
        })
        .await?;
    set_cookies(state, &key, expires, None, headers)
}

#[derive(Deserialize)]
struct LoginRequest {
    username: String,
    password: String,
}

async fn login(
    State(state): State<AppState>,
    database: Database,
    Json(request): Json<LoginRequest>,
) -> Result<(HeaderMap, Json<UserInfo>)> {
    let mut conn = database.connect().await?;
    let (id, stored) = users::table
        .filter(users::username.eq(&request.username))
        .filter(users::is_active.eq(true))
        .select((users::id, users::password))
        .first::<(i64, String)>(&mut *conn)
        .await
        .optional()?
        .ok_or_else(|| AppError::Auth("Authenticate failed.".into()))?;
    // Imported identities must continue to authenticate through HOJ, even after a password reset.
    if crate::schema::hoj_users::table.find(id).select(crate::schema::hoj_users::user_id)
        .first::<i64>(&mut *conn).await.optional()?.is_some() {
        return Err(AppError::Auth("Use HOJ login for this account".into()));
    }
    drop(conn);

    let stored = password::blocking(move || {
        if !password::verify(&request.password, &stored)? {
            return Err(AppError::Auth("Authenticate failed.".into()));
        }
        Ok(stored)
    })
    .await?;

    let mut conn = database.connect().await?;
    let (user, key, expires) = (*conn)
        .transaction::<_, AppError, _>(async |conn| {
            let (user, current) = users::table
                .find(id)
                .filter(users::is_active.eq(true))
                .select((UserInfo::as_select(), users::password))
                .for_update()
                .first::<(UserInfo, String)>(conn)
                .await
                .optional()?
                .ok_or_else(|| AppError::Auth("Authenticate failed.".into()))?;
            if current != stored {
                return Err(AppError::Auth("Authenticate failed.".into()));
            }
            diesel::update(users::table.find(id))
                .set(users::last_login.eq(Utc::now().naive_utc()))
                .execute(conn)
                .await?;
            let (key, expires) = insert_session(conn, id).await?;
            Ok((user, key, expires))
        })
        .await?;
    let mut headers = HeaderMap::new();
    set_cookies(&state, &key, expires, None, &mut headers)?;
    if state.config.hoj_api_url.is_some() {
        for name in ["course_session", "PHPSESSID"] {
            let mut cookie = Cookie::build((name, "")).path("/").http_only(true).same_site(SameSite::Lax).build();
            cookie.make_removal();
            append_cookie(&mut headers, &cookie)?;
        }
    }
    Ok((headers, Json(user)))
}

async fn logout(
    State(state): State<AppState>,
    database: Database,
    headers: HeaderMap,
) -> Result<(StatusCode, HeaderMap)> {
    if let Ok(session) = session_key(&state, &headers) {
        let mut conn = database.connect().await?;
        (*conn)
            .transaction::<_, AppError, _>(async |conn| {
                diesel::delete(user_sessions::table.filter(user_sessions::session_key.eq(session)))
                    .execute(conn)
                    .await?;
                cache::invalidate_auth(conn).await
            })
            .await?;
    }
    let mut headers = HeaderMap::new();
    clear_cookies(&state, &mut headers)?;
    Ok((StatusCode::CREATED, headers))
}

#[derive(Deserialize)]
struct ChangePasswordRequest {
    old_password: String,
    new_password: String,
}

async fn change_password(
    State(state): State<AppState>,
    user: CurrentUser,
    database: Database,
    headers: HeaderMap,
    Json(request): Json<ChangePasswordRequest>,
) -> Result<Json<UserInfo>> {
    let mut conn = database.connect().await?;
    let stored = users::table
        .find(user.id)
        .filter(users::is_active.eq(true))
        .select(users::password)
        .first::<String>(&mut *conn)
        .await?;
    let native = crate::identity::hoj::credential_key(&state, &headers).is_some()
        && crate::schema::hoj_users::table.find(user.id).select(crate::schema::hoj_users::user_id)
            .first::<i64>(&mut *conn).await.optional()?.is_some();
    drop(conn);

    let candidate = stored.clone();
    let username = user.username.clone();
    let iterations = state.config.password_iterations;
    let upstream_passwords = if native { Some(serde_json::json!({
        "old_password": request.old_password, "new_password": request.new_password
    })) } else { None };
    let hashed = password::blocking(move || {
        if !native && !password::verify(&request.old_password, &candidate)? {
            return Err(AppError::Auth("Invalid current password".into()));
        }
        password::require_strength(&request.new_password, &[&request.old_password, &username])?;
        password::hash(&request.new_password, iterations)
    })
    .await?;

    // The native account is authoritative; the management hash may be a random
    // import placeholder. Verify the old password there and update both stores.
    if let Some(body) = upstream_passwords {
        let _: serde_json::Value = crate::identity::hoj::write(&state, &headers, "/api/account/password", body).await?;
    }

    let mut conn = database.connect().await?;
    let updated = (*conn)
        .transaction::<_, AppError, _>(async |conn| {
            let changed = diesel::update(
                users::table
                    .find(user.id)
                    .filter(users::is_active.eq(true))
                    .filter(users::password.eq(stored)),
            )
            .set((
                users::password.eq(hashed),
                users::password_expired.eq(false),
                users::updated_at.eq(Utc::now().naive_utc()),
            ))
            .execute(conn)
            .await?;
            if changed == 0 {
                return Err(AppError::Auth("Invalid current password".into()));
            }
            user_service::invalidate_sessions(conn, &[user.id]).await?;
            let user = user_service::get(conn, user.id).await?;
            cache::invalidate_auth(conn).await?;
            Ok(user)
        })
        .await?;
    Ok(Json(updated))
}

async fn current_user(user: CurrentUser, database: Database) -> Result<Json<UserInfo>> {
    if let Some(profile) = user.profile {
        return Ok(Json(profile));
    }
    let mut conn = database.connect().await?;
    Ok(Json(user_service::get(&mut conn, user.id).await?))
}

#[derive(Serialize)]
struct PasswordReminder { show: bool }

/// Atomically deliver each pending reminder once for this account, across browsers.
async fn password_reminder(State(state): State<AppState>, user: CurrentUser,
    headers: HeaderMap, Db(mut conn): Db) -> Result<Json<PasswordReminder>> {
    let trusted = headers.get(header::ORIGIN).and_then(|value| value.to_str().ok())
        .is_some_and(|origin| state.config.cors_origins.iter().any(|allowed| allowed == origin));
    if !trusted { return Err(AppError::Authorization("Trusted origin required".into())); }
    let changed = (*conn).transaction::<_, AppError, _>(async |conn| {
        let changed = diesel::update(users::table.find(user.id)
            .filter(users::is_active.eq(true)).filter(users::password_expired.eq(true)))
            .set(users::password_expired.eq(false)).execute(conn).await?;
        if changed > 0 { cache::invalidate_auth(conn).await?; }
        Ok(changed)
    }).await?;
    Ok(Json(PasswordReminder { show: changed > 0 }))
}

async fn clean_all_sessions(
    State(state): State<AppState>,
    Teacher(user): Teacher,
    Db(mut conn): Db,
) -> Result<HeaderMap> {
    (*conn)
        .transaction::<_, AppError, _>(async |conn| {
            lock_teacher(conn, user.id, &[]).await?;
            diesel::delete(user_sessions::table).execute(conn).await?;
            cache::invalidate_auth(conn).await?;
            Ok(())
        })
        .await?;
    let mut headers = HeaderMap::new();
    clear_cookies(&state, &mut headers)?;
    Ok(headers)
}

pub fn router() -> Router<AppState> {
    Router::new()
        .merge(mobile::router())
        .route("/auth/login", post(login))
        .route("/auth/logout", post(logout))
        .route("/auth/change_password", post(change_password))
        .route("/auth/password_reminder", post(password_reminder))
        .route("/auth/current_user", get(current_user))
        .route("/clean_all_sessions", post(clean_all_sessions))
}
