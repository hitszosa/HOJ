//! 身份解析。顺序：SSO 反向代理头 → HUSTOJ 原生会话（PHPSESSID 回源校验，带短缓存）→ 开发登录 cookie。
//! handler 参数里写 `Identity` 即要求登录。

use std::{sync::LazyLock, time::Duration};

use axum::{extract::FromRequestParts, http::request::Parts};
use moka::sync::Cache;
use regex::Regex;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::{error::AppError, state::AppState};

pub const DEV_USERS: [(&str, &str); 4] =
    [("student", "cm_pilot_student"), ("teacher", "cm_pilot_teacher"), ("ta", "cm_pilot_ta"), ("outsider", "cm_pilot_outsider")];

pub const DEV_COOKIE: &str = "course_session";

static USER_ID: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[A-Za-z0-9_.-]{1,64}$").unwrap());
static SESSION_ID: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[A-Za-z0-9,-]{16,256}$").unwrap());

pub fn is_valid_user_id(user: &str) -> bool {
    USER_ID.is_match(user)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum AuthSource {
    Sso,
    Hustoj,
    Development,
}

#[derive(Debug, Clone)]
pub struct Identity {
    pub user: String,
    pub source: AuthSource,
}

impl Identity {
    pub fn is_admin(&self) -> bool {
        self.user == "admin"
    }
}

/// PHPSESSID → 用户名。只缓存成功结果；HUSTOJ 登出后最多 TTL 秒内仍被视为已登录。
#[derive(Clone)]
pub struct SessionCache(Cache<String, String>);

impl SessionCache {
    pub fn new(ttl: Duration) -> Self {
        Self(Cache::builder().max_capacity(10_000).time_to_live(ttl).build())
    }
}

pub fn cookie<'a>(parts: &'a Parts, name: &str) -> Option<&'a str> {
    parts
        .headers
        .get_all(axum::http::header::COOKIE)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(';'))
        .filter_map(|kv| kv.trim().split_once('='))
        .find(|(k, _)| *k == name)
        .map(|(_, v)| v)
}

async fn native_session(state: &AppState, sid: &str) -> Result<String, AppError> {
    if !SESSION_ID.is_match(sid) {
        return Err(AppError::unauthorized("HUSTOJ 登录已失效，请重新登录"));
    }
    if let Some(user) = state.sessions.0.get(sid) {
        return Ok(user);
    }
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct SessionReply {
        auth_source: String,
        user: String,
    }
    let unavailable = || AppError::unavailable("HUSTOJ 身份服务暂时不可用");
    let response = state
        .http
        .get(&state.cfg.hustoj_session_url)
        .header(axum::http::header::COOKIE, format!("{}={sid}", state.cfg.hustoj_cookie))
        .timeout(Duration::from_secs(5))
        .send()
        .await
        .map_err(|_| unavailable())?;
    if response.status() == reqwest::StatusCode::UNAUTHORIZED {
        return Err(AppError::unauthorized("请先登录 HUSTOJ"));
    }
    if response.status() != reqwest::StatusCode::OK {
        return Err(unavailable());
    }
    let body = response.bytes().await.map_err(|_| unavailable())?;
    if body.len() > 8192 {
        return Err(unavailable());
    }
    let reply: SessionReply = serde_json::from_slice(&body).map_err(|_| unavailable())?;
    let chars = reply.user.chars().count();
    if reply.auth_source != "hustoj" || !(1..=64).contains(&chars) || reply.user.chars().any(|c| (c as u32) < 32) {
        return Err(unavailable());
    }
    state.sessions.0.insert(sid.to_owned(), reply.user.clone());
    Ok(reply.user)
}

impl FromRequestParts<AppState> for Identity {
    type Rejection = AppError;

    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> Result<Self, Self::Rejection> {
        if let Some(identity) = parts.extensions.get::<Identity>() {
            return Ok(identity.clone());
        }
        let identity = resolve(parts, state).await?;
        parts.extensions.insert(identity.clone());
        Ok(identity)
    }
}

async fn resolve(parts: &Parts, state: &AppState) -> Result<Identity, AppError> {
    // SSO 头只在显式配置 COURSE_SSO_HEADER 时才信任（旧版默认就信任 X-Remote-User，可被客户端伪造）。
    // 网关必须剥掉客户端自带的同名头，只由认证代理注入。
    if state.cfg.sso_configured
        && let Some(user) = parts.headers.get(&state.cfg.sso_header).and_then(|v| v.to_str().ok()).map(str::trim)
        && is_valid_user_id(user)
    {
        return Ok(Identity { user: user.to_owned(), source: AuthSource::Sso });
    }
    if let Some(sid) = cookie(parts, &state.cfg.hustoj_cookie) {
        let user = native_session(state, sid).await?;
        return Ok(Identity { user, source: AuthSource::Hustoj });
    }
    if !state.cfg.dev_login {
        return Err(AppError::unauthorized("请先登录 HUSTOJ"));
    }
    cookie(parts, DEV_COOKIE)
        .and_then(|c| state.key.read_dev_cookie(c))
        .filter(|u| is_valid_user_id(u))
        .map(|user| Identity { user, source: AuthSource::Development })
        .ok_or_else(|| AppError::unauthorized("请先登录课程平台"))
}
