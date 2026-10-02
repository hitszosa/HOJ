//! 开发登录 / 登出 / 当前身份。生产环境身份来自 HUSTOJ 会话或 SSO 头，这里只做门户选择。

use axum::{
    Router,
    extract::State,
    http::{HeaderMap, HeaderValue, header::SET_COOKIE},
    routing::{get, post},
};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::{
    auth::{AuthSource, DEV_COOKIE, DEV_USERS, Identity, is_valid_user_id},
    error::{AppError, AppResult},
    extract::Json,
    response::{ApiOk, ok},
    state::AppState,
};

pub fn router() -> Router<AppState> {
    Router::new().route("/api/session", post(login).delete(logout)).route("/api/me", get(me))
}

#[derive(Deserialize, TS)]
#[ts(export)]
pub struct LoginRequest {
    /// 直接指定账号；缺省时按 role 取默认体验账号。
    #[serde(default)]
    #[ts(optional)]
    pub user_id: Option<String>,
    #[serde(default)]
    #[ts(optional)]
    pub role: Option<String>,
}

#[derive(Serialize, TS)]
#[ts(export)]
pub struct LoginResponse {
    pub user: String,
}

fn expire(name: &str) -> HeaderValue {
    HeaderValue::from_str(&format!("{name}=\"\"; expires=Thu, 01 Jan 1970 00:00:00 GMT; Max-Age=0; Path=/; SameSite=lax"))
        .expect("cookie name is ascii")
}

async fn login(State(s): State<AppState>, Json(body): Json<LoginRequest>) -> AppResult<(HeaderMap, ApiOk<LoginResponse>)> {
    if !s.cfg.dev_login {
        return Err(AppError::forbidden("开发登录已关闭，请接入学校身份认证"));
    }
    let user = body
        .user_id
        .filter(|u| !u.is_empty())
        .or_else(|| body.role.and_then(|r| DEV_USERS.iter().find(|(k, _)| *k == r).map(|(_, u)| (*u).to_owned())))
        .filter(|u| is_valid_user_id(u))
        .ok_or_else(|| AppError::validation("未知测试身份或用户不存在"))?;
    let mut headers = HeaderMap::new();
    let cookie = format!("{DEV_COOKIE}={}; HttpOnly; Max-Age=43200; Path=/; SameSite=strict", s.key.dev_cookie(&user));
    headers.append(SET_COOKIE, HeaderValue::from_str(&cookie).map_err(|e| AppError::internal(e.to_string()))?);
    // 显式选择开发身份时不能沿用原生会话。
    headers.append(SET_COOKIE, expire(&s.cfg.hustoj_cookie));
    Ok((headers, ok(LoginResponse { user })))
}

#[derive(Serialize, TS)]
#[ts(export)]
pub struct LogoutResponse {
    /// 前端随后跳转到 HUSTOJ 登出页销毁原生会话。
    pub logout_url: &'static str,
}

async fn logout() -> (HeaderMap, ApiOk<LogoutResponse>) {
    // PHPSESSID 保留到 HUSTOJ 登出页销毁服务端会话为止。
    let mut headers = HeaderMap::new();
    headers.append(SET_COOKIE, expire(DEV_COOKIE));
    (headers, ok(LogoutResponse { logout_url: "/oj/logout.php" }))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum PortalRole {
    Admin,
    Student,
    Ta,
    Teacher,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum Portal {
    Teacher,
    Student,
}

#[derive(Serialize, TS)]
#[ts(export)]
pub struct Me {
    pub user: String,
    pub dev_login: bool,
    pub auth_source: AuthSource,
    pub roles: Vec<PortalRole>,
    pub portal: Portal,
    pub home: String,
}

async fn me(State(s): State<AppState>, who: Identity) -> AppResult<ApiOk<Me>> {
    // 门户只由持久化的权限推导，不看请求参数；具体教学班授权仍由 offering_access 负责。
    let assigned = sqlx::query_scalar!(
        r#"SELECT 'teacher' AS "role!: String" FROM jol.privilege WHERE user_id=? AND rightstr IN ('teacher','administrator')
           UNION SELECT 'teacher' FROM cm_offering WHERE teacher_id=?
           UNION SELECT role FROM cm_enrollment WHERE user_id=? AND status='active'"#,
        who.user,
        who.user,
        who.user
    )
    .fetch_all(&s.db)
    .await?;
    let mut roles: Vec<PortalRole> = assigned
        .iter()
        .filter_map(|r| match r.as_str() {
            "student" => Some(PortalRole::Student),
            "teacher" => Some(PortalRole::Teacher),
            "ta" => Some(PortalRole::Ta),
            _ => None,
        })
        .collect();
    roles.sort();
    roles.dedup();
    if roles.is_empty() {
        roles.push(PortalRole::Student);
    }
    if who.is_admin() {
        roles = vec![PortalRole::Admin, PortalRole::Teacher];
    }
    let portal = if roles.iter().any(|r| matches!(r, PortalRole::Teacher | PortalRole::Ta | PortalRole::Admin)) {
        Portal::Teacher
    } else {
        Portal::Student
    };
    let home = match portal {
        Portal::Teacher => "/teacher",
        Portal::Student => "/student",
    };
    Ok(ok(Me { user: who.user, dev_login: s.cfg.dev_login, auth_source: who.source, roles, portal, home: home.into() }))
}
