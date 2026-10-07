use axum::Router;
use axum::extract::{Query, State};
use axum::http::{HeaderMap, HeaderValue, header};
use axum::response::{IntoResponse, Redirect, Response};
use axum::routing::get;
use cookie::{Cookie, CookieJar, SameSite};
use serde::{Deserialize, Serialize};
use std::time::Duration;
use subtle::ConstantTimeEq;
use url::Url;

use crate::app::db::Database;
use crate::app::error::{AppError, Result};
use crate::app::state::AppState;
use crate::identity::auth;
use crate::identity::oauth::random_token;
use crate::identity::users;

const STATE_COOKIE: &str = "sso_state";

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/login/sso", get(login))
        .route("/auth/callback", get(callback))
}

#[derive(Deserialize)]
struct LoginQuery {
    next: Option<String>,
}

#[derive(Serialize, Deserialize)]
struct LoginState {
    nonce: String,
    next: String,
    expires: i64,
}

#[derive(Deserialize)]
struct CallbackQuery {
    code: Option<String>,
    state: Option<String>,
    error: Option<String>,
}

#[derive(Deserialize)]
struct Token {
    access_token: String,
}

#[derive(Deserialize)]
struct Profile {
    id: String,
    attributes: Attributes,
}

#[derive(Deserialize)]
struct Attributes {
    cn: String,
    #[serde(rename = "memberOf")]
    member_of: Membership,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum Membership {
    One(String),
    Many(Vec<String>),
}

fn valid_local_next(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 2048
        && value.starts_with('/')
        && !value.starts_with("//")
        && !value.contains('\\')
        && !value.chars().any(char::is_control)
}

fn cookie_jar(headers: &HeaderMap) -> CookieJar {
    let mut jar = CookieJar::new();
    for header in headers.get_all(header::COOKIE) {
        if let Ok(value) = header.to_str() {
            for part in value.split(';') {
                if let Ok(cookie) = Cookie::parse(part.trim().to_owned()) {
                    jar.add_original(cookie);
                }
            }
        }
    }
    jar
}

fn append_cookie(headers: &mut HeaderMap, cookie: &Cookie<'_>) -> Result<()> {
    headers.append(
        header::SET_COOKIE,
        HeaderValue::from_str(&cookie.to_string())
            .map_err(|_| AppError::Internal("Invalid SSO cookie".to_owned()))?,
    );
    Ok(())
}

async fn login(State(state): State<AppState>, Query(query): Query<LoginQuery>) -> Result<Response> {
    if state.config.sso_client_id.is_empty() || state.config.sso_redirect_url.is_empty() {
        return Err(AppError::Unavailable("SSO is not configured".to_owned()));
    }
    let pending = LoginState {
        nonce: random_token(),
        next: query
            .next
            .filter(|next| valid_local_next(next))
            .unwrap_or_else(|| "/".to_owned()),
        expires: chrono::Utc::now().timestamp() + 600,
    };
    let mut url = Url::parse(&state.config.sso_auth_url)
        .map_err(|_| AppError::Unavailable("SSO is not configured".to_owned()))?;
    url.query_pairs_mut()
        .append_pair("response_type", "code")
        .append_pair("client_id", &state.config.sso_client_id)
        .append_pair("redirect_uri", &state.config.sso_redirect_url)
        .append_pair("state", &pending.nonce);
    let value = serde_json::to_string(&pending)
        .map_err(|_| AppError::Internal("Cannot encode SSO state".to_owned()))?;
    let mut jar = CookieJar::new();
    jar.private_mut(&state.config.cookie_key).add(
        Cookie::build((STATE_COOKIE, value))
            .path("/")
            .http_only(true)
            .secure(state.config.cookie_secure)
            .same_site(SameSite::Lax)
            .max_age(cookie::time::Duration::minutes(10))
            .build(),
    );
    let mut response = Redirect::to(url.as_str()).into_response();
    for cookie in jar.delta() {
        append_cookie(response.headers_mut(), cookie)?;
    }
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    Ok(response)
}

async fn callback(
    State(state): State<AppState>,
    database: Database,
    headers: HeaderMap,
    Query(query): Query<CallbackQuery>,
) -> Response {
    let result = complete_callback(&state, &database, &headers, query).await;
    let mut response = match result {
        Ok(response) => response,
        Err(error) => error.into_response(),
    };
    let mut removal = Cookie::build((STATE_COOKIE, ""))
        .path("/")
        .http_only(true)
        .secure(state.config.cookie_secure)
        .same_site(SameSite::Lax)
        .build();
    removal.make_removal();
    if let Err(error) = append_cookie(response.headers_mut(), &removal) {
        return error.into_response();
    }
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

async fn complete_callback(
    state: &AppState,
    database: &Database,
    headers: &HeaderMap,
    query: CallbackQuery,
) -> Result<Response> {
    let jar = cookie_jar(headers);
    let cookie = jar
        .private(&state.config.cookie_key)
        .get(STATE_COOKIE)
        .ok_or(AppError::Csrf)?;
    let pending: LoginState = serde_json::from_str(cookie.value()).map_err(|_| AppError::Csrf)?;
    let supplied = query.state.as_deref().ok_or(AppError::Csrf)?;
    if pending.expires <= chrono::Utc::now().timestamp()
        || !bool::from(supplied.as_bytes().ct_eq(pending.nonce.as_bytes()))
    {
        return Err(AppError::Csrf);
    }
    if query.error.is_some() {
        return Ok(login_error("SSO authorization was denied"));
    }
    let code = query
        .code
        .filter(|code| !code.is_empty())
        .ok_or_else(|| AppError::BadRequest("Missing SSO code".to_owned()))?;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| AppError::Internal("Cannot create SSO client".to_owned()))?;
    let profile = fetch_profile(state, &client, &code).await;
    let profile = match profile {
        Ok(profile) => profile,
        Err(_) => return Ok(login_error("SSO profile is unavailable")),
    };
    let groups = match profile.attributes.member_of {
        Membership::One(value) => vec![value],
        Membership::Many(values) => values,
    };
    let role = groups
        .iter()
        .flat_map(|group| group.split(','))
        .find_map(|part| match part.trim().to_ascii_lowercase().as_str() {
            "cn=bks" | "cn=yjs" | "cn=sss" | "cn=xs" | "cn=bss" | "cn=jyyjs" | "cn=xy"
            | "cn=xysz" | "cn=jieye_sz_temp" => Some(0),
            "cn=jzg" | "cn=jzbd" => Some(1),
            _ => None,
        });
    let Some(role) = role else {
        return Ok(login_error("Forbidden identity type"));
    };
    if profile.id.trim().is_empty() || profile.attributes.cn.trim().is_empty() {
        return Ok(login_error("SSO profile is unavailable"));
    }
    let user = users::ensure_sso(
        database,
        &profile.id,
        &profile.attributes.cn,
        role,
        state.config.password_iterations,
    )
    .await?;

    let next = if valid_local_next(&pending.next) {
        pending.next.as_str()
    } else {
        "/"
    };
    let mut response = Redirect::to(next).into_response();
    auth::issue_session(state, user.id, response.headers_mut()).await?;
    Ok(response)
}

async fn fetch_profile(state: &AppState, client: &reqwest::Client, code: &str) -> Result<Profile> {
    let unavailable = |_| AppError::Unavailable("SSO profile is unavailable".to_owned());
    let token = client
        .post(&state.config.sso_token_url)
        .header(header::ACCEPT, "application/json")
        .basic_auth(
            &state.config.sso_client_id,
            Some(&state.config.sso_client_secret),
        )
        .form(&[
            ("grant_type", "authorization_code"),
            ("code", code),
            ("redirect_uri", state.config.sso_redirect_url.as_str()),
        ])
        .send()
        .await
        .map_err(unavailable)?
        .error_for_status()
        .map_err(unavailable)?
        .json::<Token>()
        .await
        .map_err(unavailable)?;
    client
        .post(&state.config.sso_profile_url)
        .form(&[("access_token", token.access_token.as_str())])
        .send()
        .await
        .map_err(unavailable)?
        .error_for_status()
        .map_err(unavailable)?
        .json::<Profile>()
        .await
        .map_err(unavailable)
}

fn login_error(message: &str) -> Response {
    let query = url::form_urlencoded::Serializer::new(String::new())
        .append_pair("error", message)
        .finish();
    Redirect::to(&format!("/login/error?{query}")).into_response()
}
