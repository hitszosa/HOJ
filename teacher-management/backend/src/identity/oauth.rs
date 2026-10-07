use axum::extract::{Extension, FromRequestParts, Query, State};
use axum::http::{HeaderMap, header, request::Parts};
use axum::response::{IntoResponse, Redirect, Response};
use axum::routing::{get, post};
use axum::{Form, Json, Router};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use chrono::{Duration, NaiveDateTime, Utc};
use diesel::prelude::*;
use diesel_async::{AsyncConnection, RunQueryDsl};
use rand::Rng;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;
use url::Url;

use crate::app::db::{self, Database, Db};
use crate::app::error::{AppError, Result};
use crate::app::state::AppState;
use crate::identity::auth::{self, CurrentUser};
use crate::schema::{
    oauth_access_tokens as tokens, oauth_authorization_codes as codes, oauth_clients as clients,
    oauth_consents as consents, users,
};

pub const VALID_SCOPES: &[&str] = &[
    "courses:read",
    "assignments:read",
    "submissions:read",
    "grades:read",
    "files:read",
];

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/oauth/authorize", get(authorize).post(authorize_decision))
        .route("/oauth/token", post(token))
}

pub fn sha256_hex(value: &str) -> String {
    hex::encode(Sha256::digest(value.as_bytes()))
}

pub fn random_token() -> String {
    let mut bytes = [0u8; 32];
    rand::rng().fill(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}

fn scopes(value: &str) -> Vec<String> {
    let mut result = Vec::new();
    for scope in value.split_whitespace() {
        if !result.iter().any(|existing| existing == scope) {
            result.push(scope.to_owned());
        }
    }
    result
}

fn valid_scopes(requested: &[String], allowed: &str) -> bool {
    !requested.is_empty()
        && requested.iter().all(|scope| {
            VALID_SCOPES.contains(&scope.as_str())
                && allowed.split_whitespace().any(|allowed| allowed == scope)
        })
}

fn bad(message: &str) -> AppError {
    AppError::BadRequest(message.to_owned())
}

#[derive(Deserialize, Serialize)]
struct AuthorizeRequest {
    response_type: String,
    client_id: String,
    redirect_uri: String,
    scope: Option<String>,
    state: Option<String>,
    code_challenge: Option<String>,
    code_challenge_method: Option<String>,
}

#[derive(Deserialize)]
struct AuthorizeDecision {
    #[serde(flatten)]
    request: AuthorizeRequest,
    csrf_token: String,
    decision: String,
}

#[derive(Serialize)]
struct AuthorizeInfo {
    response_type: String,
    client_id: String,
    client_name: String,
    redirect_uri: String,
    scope: String,
    scopes: Vec<String>,
    state: Option<String>,
    code_challenge: Option<String>,
    code_challenge_method: Option<String>,
    csrf_token: String,
    username: String,
}

#[derive(Queryable)]
struct Client {
    id: i64,
    name: String,
    redirect_uri: String,
    allowed_scopes: String,
    secret_hash: Option<String>,
}

async fn validate_authorize(
    conn: &mut diesel_async::AsyncMysqlConnection,
    request: &AuthorizeRequest,
) -> Result<(Client, Vec<String>)> {
    if request.response_type != "code" {
        return Err(bad("response_type must be code"));
    }
    let client = clients::table
        .filter(clients::client_id.eq(&request.client_id))
        .filter(clients::active.eq(true))
        .select((
            clients::id,
            clients::name,
            clients::redirect_uri,
            clients::allowed_scopes,
            clients::client_secret_hash,
        ))
        .first::<Client>(conn)
        .await
        .optional()?
        .ok_or_else(|| bad("invalid client_id"))?;
    if client.redirect_uri != request.redirect_uri {
        return Err(bad("invalid redirect_uri"));
    }
    let url = Url::parse(&request.redirect_uri).map_err(|_| bad("invalid redirect_uri"))?;
    if url.fragment().is_some() {
        return Err(bad("invalid redirect_uri"));
    }
    let requested = scopes(request.scope.as_deref().unwrap_or_default());
    if !valid_scopes(&requested, &client.allowed_scopes) {
        return Err(bad("invalid scope"));
    }
    match request
        .code_challenge
        .as_deref()
        .filter(|value| !value.is_empty())
    {
        Some(challenge) => {
            if request.code_challenge_method.as_deref() != Some("S256") {
                return Err(bad("code_challenge_method must be S256"));
            }
            if challenge.len() != 43
                || !challenge
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
            {
                return Err(bad("invalid code_challenge"));
            }
        }
        None if client.secret_hash.is_none() => return Err(bad("code_challenge is required")),
        None if request.code_challenge_method.is_some() => {
            return Err(bad("code_challenge is required"));
        }
        None => {}
    }
    Ok((client, requested))
}

async fn authorize(
    State(state): State<AppState>,
    user: CurrentUser,
    Db(mut conn): Db,
    headers: HeaderMap,
    Query(request): Query<AuthorizeRequest>,
) -> Result<Response> {
    let (client, scopes) = validate_authorize(&mut conn, &request).await?;
    let info = AuthorizeInfo {
        response_type: "code".to_owned(),
        client_id: request.client_id,
        client_name: client.name,
        redirect_uri: request.redirect_uri,
        scope: scopes.join(" "),
        scopes,
        state: request.state,
        code_challenge: request.code_challenge.filter(|value| !value.is_empty()),
        code_challenge_method: request.code_challenge_method,
        csrf_token: auth::form_csrf(&state, &headers).await?,
        username: user.username,
    };
    let mut response = Json(info).into_response();
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, "no-store".parse().unwrap());
    response
        .headers_mut()
        .insert(header::REFERRER_POLICY, "no-referrer".parse().unwrap());
    Ok(response)
}

async fn authorize_decision(
    State(state): State<AppState>,
    database: Database,
    Extension(pending): Extension<auth::ResponseCookies>,
    headers: HeaderMap,
    Form(form): Form<AuthorizeDecision>,
) -> Result<Redirect> {
    auth::verify_form_csrf(&state, &headers, form.csrf_token.trim()).await?;
    let user = auth::authenticate_cookie(&state, &headers, &pending, false).await?;

    let mut conn = database.connect().await?;
    let mut request = form.request;
    let (client, requested) = validate_authorize(&mut conn, &request).await?;
    let mut redirect =
        Url::parse(&request.redirect_uri).map_err(|_| bad("invalid redirect_uri"))?;
    let response_state = request.state.take();
    if form.decision == "approve" {
        let code = random_token();
        let hash = sha256_hex(&code);
        let scope = requested.join(" ");
        (*conn)
            .transaction::<_, AppError, _>(async |conn| {
                // Lock client before user, matching code exchange lock ordering.
                clients::table
                    .filter(clients::id.eq(client.id))
                    .filter(clients::active.eq(true))
                    .select(clients::id)
                    .for_update()
                    .first::<i64>(conn)
                    .await?;
                // Serialize grants for a user, including the initial consent insert.
                users::table
                    .filter(users::id.eq(user.id))
                    .filter(users::is_active.eq(true))
                    .select(users::id)
                    .for_update()
                    .first::<i64>(conn)
                    .await?;
                let now = Utc::now().naive_utc();
                diesel::insert_into(codes::table)
                    .values((
                        codes::code_hash.eq(hash),
                        codes::oauth_client_id.eq(client.id),
                        codes::user_id.eq(user.id),
                        codes::redirect_uri.eq(&request.redirect_uri),
                        codes::scopes.eq(&scope),
                        codes::code_challenge
                            .eq(request.code_challenge.filter(|value| !value.is_empty())),
                        codes::code_challenge_method.eq(request.code_challenge_method),
                        codes::expires_at.eq(now + Duration::minutes(10)),
                    ))
                    .execute(conn)
                    .await?;
                let existing = consents::table
                    .filter(consents::oauth_client_id.eq(client.id))
                    .filter(consents::user_id.eq(user.id))
                    .select(consents::id)
                    .first::<i64>(conn)
                    .await
                    .optional()?;
                if let Some(id) = existing {
                    diesel::update(consents::table.find(id))
                        .set((
                            consents::scopes.eq(&scope),
                            consents::granted_at.eq(now),
                            consents::revoked_at.eq(None::<NaiveDateTime>),
                        ))
                        .execute(conn)
                        .await?;
                } else {
                    diesel::insert_into(consents::table)
                        .values((
                            consents::oauth_client_id.eq(client.id),
                            consents::user_id.eq(user.id),
                            consents::scopes.eq(&scope),
                            consents::granted_at.eq(now),
                        ))
                        .execute(conn)
                        .await?;
                }
                Ok(())
            })
            .await?;
        redirect.query_pairs_mut().append_pair("code", &code);
    } else {
        redirect
            .query_pairs_mut()
            .append_pair("error", "access_denied")
            .append_pair(
                "error_description",
                "The user denied the authorization request",
            );
    }
    if let Some(value) = response_state.as_deref() {
        redirect.query_pairs_mut().append_pair("state", value);
    }
    Ok(Redirect::to(redirect.as_str()))
}

#[derive(Deserialize)]
struct TokenRequest {
    grant_type: String,
    code: String,
    redirect_uri: String,
    client_id: String,
    client_secret: Option<String>,
    code_verifier: Option<String>,
}

#[derive(Serialize)]
struct TokenResponse {
    access_token: String,
    token_type: &'static str,
    expires_in: i64,
    scope: String,
}

#[derive(Queryable)]
struct Code {
    id: i64,
    client: i64,
    user: i64,
    redirect_uri: String,
    scopes: String,
    challenge: Option<String>,
    method: Option<String>,
    expires: NaiveDateTime,
    used: Option<NaiveDateTime>,
}

async fn token(database: Database, Form(form): Form<TokenRequest>) -> Result<Response> {
    if form.grant_type != "authorization_code" {
        return Err(bad("grant_type must be authorization_code"));
    }

    let mut conn = database.connect().await?;
    let result = (*conn)
        .transaction::<_, AppError, _>(async |conn| {
            let code = codes::table
                .filter(codes::code_hash.eq(sha256_hex(&form.code)))
                .select((
                    codes::id,
                    codes::oauth_client_id,
                    codes::user_id,
                    codes::redirect_uri,
                    codes::scopes,
                    codes::code_challenge,
                    codes::code_challenge_method,
                    codes::expires_at,
                    codes::used_at,
                ))
                .for_update()
                .first::<Code>(conn)
                .await
                .optional()?
                .ok_or_else(|| bad("invalid authorization code"))?;
            if code.used.is_some() || code.expires <= Utc::now().naive_utc() {
                return Err(bad("authorization code expired or already used"));
            }
            if code.redirect_uri != form.redirect_uri {
                return Err(bad("invalid redirect_uri"));
            }
            let (secret, allowed) = clients::table
                .find(code.client)
                .filter(clients::client_id.eq(&form.client_id))
                .filter(clients::active.eq(true))
                .select((clients::client_secret_hash, clients::allowed_scopes))
                .for_update()
                .first::<(Option<String>, String)>(conn)
                .await
                .optional()?
                .ok_or_else(|| bad("invalid client_id"))?;
            if let Some(expected) = secret.as_deref() {
                let supplied = form
                    .client_secret
                    .as_deref()
                    .ok_or_else(|| AppError::Auth("client_secret is required".to_owned()))?;
                if !bool::from(expected.as_bytes().ct_eq(sha256_hex(supplied).as_bytes())) {
                    return Err(AppError::Auth("invalid client_secret".to_owned()));
                }
            }
            verify_pkce(secret.is_none(), &code, form.code_verifier.as_deref())?;
            let active = users::table
                .find(code.user)
                .filter(users::is_active.eq(true))
                .select(users::id)
                .for_update()
                .first::<i64>(conn)
                .await
                .optional()?;
            if active.is_none() {
                return Err(AppError::Auth("User is inactive".to_owned()));
            }
            let consent = consents::table
                .filter(consents::oauth_client_id.eq(code.client))
                .filter(consents::user_id.eq(code.user))
                .filter(consents::revoked_at.is_null())
                .select(consents::scopes)
                .for_update()
                .first::<String>(conn)
                .await
                .optional()?;
            let requested = scopes(&code.scopes);
            if !valid_scopes(&requested, &allowed)
                || !consent.is_some_and(|consent| valid_scopes(&requested, &consent))
            {
                return Err(bad("invalid scope or revoked consent"));
            }
            let access_token = random_token();
            let now = Utc::now().naive_utc();
            diesel::update(codes::table.find(code.id))
                .set(codes::used_at.eq(now))
                .execute(conn)
                .await?;
            diesel::insert_into(tokens::table)
                .values((
                    tokens::token_hash.eq(sha256_hex(&access_token)),
                    tokens::oauth_client_id.eq(code.client),
                    tokens::user_id.eq(code.user),
                    tokens::scopes.eq(&code.scopes),
                    tokens::expires_at.eq(now + Duration::seconds(3600)),
                ))
                .execute(conn)
                .await?;
            Ok(TokenResponse {
                access_token,
                token_type: "Bearer",
                expires_in: 3600,
                scope: code.scopes,
            })
        })
        .await?;
    Ok((
        [
            (header::CACHE_CONTROL, "no-store"),
            (header::PRAGMA, "no-cache"),
        ],
        Json(result),
    )
        .into_response())
}

fn verify_pkce(public: bool, code: &Code, verifier: Option<&str>) -> Result<()> {
    let Some(challenge) = code.challenge.as_deref() else {
        return if public {
            Err(bad("code_verifier is required"))
        } else {
            Ok(())
        };
    };
    let verifier = verifier.ok_or_else(|| bad("code_verifier is required"))?;
    if code.method.as_deref() != Some("S256")
        || !(43..=128).contains(&verifier.len())
        || !verifier
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'-' | b'.' | b'_' | b'~'))
    {
        return Err(bad("invalid code_verifier"));
    }
    let actual = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
    if !bool::from(challenge.as_bytes().ct_eq(actual.as_bytes())) {
        return Err(bad("invalid code_verifier"));
    }
    Ok(())
}

pub struct OAuthContext {
    pub access_token_id: i64,
    pub user: CurrentUser,
    scopes: Vec<String>,
}

impl OAuthContext {
    pub fn has_scope(&self, scope: &str) -> bool {
        self.scopes.iter().any(|value| value == scope)
    }

    pub fn require_scope(&self, scope: &str) -> Result<()> {
        if self.has_scope(scope) {
            Ok(())
        } else {
            Err(AppError::Authorization(format!(
                "Missing required scope: {scope}"
            )))
        }
    }
}

impl FromRequestParts<AppState> for OAuthContext {
    type Rejection = AppError;

    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> Result<Self> {
        let bearer = parts
            .headers
            .get(header::AUTHORIZATION)
            .and_then(|v| v.to_str().ok())
            .and_then(|value| value.split_once(' '))
            .filter(|(scheme, value)| {
                scheme.eq_ignore_ascii_case("Bearer") && !value.trim().is_empty()
            })
            .map(|(_, value)| value.trim())
            .ok_or_else(|| AppError::Auth("Bearer token required".to_owned()))?;
        let mut conn = db::connect(state).await?;
        let row = tokens::table
            .inner_join(clients::table.on(tokens::oauth_client_id.eq(clients::id)))
            .inner_join(users::table.on(tokens::user_id.eq(users::id)))
            .filter(tokens::token_hash.eq(sha256_hex(bearer)))
            .filter(tokens::revoked_at.is_null())
            .filter(tokens::expires_at.gt(Utc::now().naive_utc()))
            .filter(clients::active.eq(true))
            .filter(users::is_active.eq(true))
            .select((
                tokens::id,
                users::id,
                users::username,
                users::role,
                tokens::scopes,
                clients::allowed_scopes,
            ))
            .first::<(i64, i64, String, i32, String, String)>(&mut *conn)
            .await
            .optional()?
            .ok_or_else(|| AppError::Auth("Invalid OAuth token".to_owned()))?;
        let scopes = scopes(&row.4);
        if !valid_scopes(&scopes, &row.5) {
            return Err(AppError::Auth("Invalid OAuth token scope".to_owned()));
        }
        diesel::update(tokens::table.find(row.0))
            .set(tokens::last_used_at.eq(Utc::now().naive_utc()))
            .execute(&mut *conn)
            .await?;
        Ok(Self {
            access_token_id: row.0,
            user: CurrentUser {
                id: row.1,
                username: row.2,
                role: row.3,
                auth_epoch: None,
                profile: None,
            },
            scopes,
        })
    }
}
