//! Platform password login; the original account store stays behind a JSON adapter.
use std::time::Duration;

use axum::{Router, extract::State, http::{HeaderMap, header::{COOKIE, ORIGIN, SET_COOKIE}}, routing::post};
use serde::{Deserialize, Serialize};
use crate::{error::{AppError, AppResult}, extract::Json, response::{ApiOk, ok}, state::AppState};

pub fn router() -> Router<AppState> {
    Router::new().route("/api/account/login", post(login)).route("/api/account/password", post(change_password))
}

#[derive(Deserialize)]
struct Credentials { username: String, password: String }
#[derive(Deserialize)]
struct PasswordChange { old_password: String, new_password: String }
#[derive(Serialize, Deserialize)]
pub struct Account { pub user: String }

pub(crate) async fn exchange(s: &AppState, headers: &HeaderMap, mode: &str, body: serde_json::Value)
    -> AppResult<(HeaderMap, Account)> {
    let origin = headers.get(ORIGIN).and_then(|v| v.to_str().ok())
        .filter(|origin| s.cfg.allowed_origins.iter().any(|allowed| allowed == origin))
        .ok_or_else(|| AppError::forbidden("跨站请求被拒绝"))?;
    let mut url = reqwest::Url::parse(&s.cfg.hustoj_session_url)
        .map_err(|_| AppError::unavailable("账号服务配置不正确"))?;
    url.set_path("/platform-auth.php");
    url.set_query(Some(&format!("mode={mode}")));
    let mut request = s.http.post(url).header(ORIGIN, origin).json(&body).timeout(Duration::from_secs(10));
    if let Some(cookie) = headers.get(COOKIE) { request = request.header(COOKIE, cookie); }
    let reply = request.send().await.map_err(|_| AppError::unavailable("账号服务暂时不可用"))?;
    let status = reply.status();
    let mut cookies = HeaderMap::new();
    for cookie in reply.headers().get_all(SET_COOKIE) { cookies.append(SET_COOKIE, cookie.clone()); }
    let data: serde_json::Value = reply.json().await.map_err(|_| AppError::unavailable("账号服务暂时不可用"))?;
    if !status.is_success() {
        let message = data["error"].as_str().unwrap_or("登录失败");
        return Err(match status.as_u16() {
            400 => AppError::validation(message),
            401 => AppError::unauthorized(message),
            403 => AppError::forbidden(message),
            409 => AppError::conflict(message),
            429 => AppError::TooManyRequests { message: message.into(), retry_after: 300 },
            _ => AppError::unavailable("账号服务暂时不可用"),
        });
    }
    let account = serde_json::from_value(data).map_err(|_| AppError::unavailable("账号服务暂时不可用"))?;
    Ok((cookies, account))
}

async fn login(State(s): State<AppState>, headers: HeaderMap, Json(body): Json<Credentials>)
    -> AppResult<(HeaderMap, ApiOk<Account>)> {
    if !crate::auth::is_valid_user_id(&body.username) || body.password.is_empty() || body.password.len() > 1024 {
        return Err(AppError::validation("请输入有效的账号和密码"));
    }
    if let Some(sid) = crate::auth::cookie_header(&headers, &s.cfg.hustoj_cookie) { s.sessions.invalidate(sid); }
    let (mut cookies, account) = exchange(&s, &headers, "login", serde_json::json!({"username": body.username, "password": body.password})).await?;
    for name in [crate::auth::DEV_COOKIE, "sessionid", "csrftoken"] {
        cookies.append(SET_COOKIE, super::session::expire(name));
    }
    Ok((cookies, ok(account)))
}

async fn change_password(State(s): State<AppState>, who: crate::auth::Identity,
    headers: HeaderMap, Json(body): Json<PasswordChange>) -> AppResult<(HeaderMap, ApiOk<Account>)> {
    if body.old_password.is_empty() || body.old_password.len() > 1024
        || body.new_password.chars().count() < 8 || body.new_password.len() > 1024
        || body.old_password == body.new_password {
        return Err(AppError::validation("新密码至少需要 8 个字符，且不能与旧密码相同"));
    }
    let (cookies, account) = exchange(&s, &headers, "password", serde_json::json!({
        "old_password":body.old_password,"new_password":body.new_password
    })).await?;
    if account.user != who.user { return Err(AppError::forbidden("账号身份不一致，请重新登录")); }
    Ok((cookies, ok(account)))
}
