//! 错误类型：每个变体固定对应一个 HTTP 状态码与一个稳定的 `code`。
//! 面向用户的中文提示放在变体里，前端直接展示 `message`；按 `code` 分支。

use axum::{
    Json,
    extract::rejection::{JsonRejection, PathRejection, QueryRejection},
    http::{HeaderValue, StatusCode, header},
    response::{IntoResponse, Response},
};
use serde_json::{Value, json};
use thiserror::Error;

use crate::response::ApiResponse;

pub type AppResult<T> = Result<T, AppError>;

#[derive(Debug, Error)]
pub enum AppError {
    /// 400：请求参数不合法（前端可直接展示）。
    #[error("{0}")]
    Validation(String),
    /// 401：未登录或登录失效。
    #[error("{0}")]
    Unauthorized(String),
    /// 403：已登录但无权限。
    #[error("{0}")]
    Forbidden(String),
    /// 404：资源不存在或对当前用户不可见。
    #[error("{0}")]
    NotFound(String),
    /// 409：状态冲突（已发布、已截止、只读等）。
    #[error("{0}")]
    Conflict(String),
    /// 413：请求体过大。
    #[error("{0}")]
    PayloadTooLarge(String),
    /// 422：结构正确但内容不可处理（题单校验失败等）。
    #[error("{0}")]
    Unprocessable(String),
    /// 429：操作过快。
    #[error("{message}")]
    TooManyRequests { message: String, retry_after: u32 },
    /// 502：上游（AI 服务）返回无效内容。
    #[error("{0}")]
    Upstream(String),
    /// 503：依赖服务不可用（数据库、HUSTOJ、判题机）。
    #[error("{0}")]
    Unavailable(String),
    #[error(transparent)]
    Db(#[from] sqlx::Error),
    #[error("{0}")]
    Internal(String),
}

impl AppError {
    pub fn validation(m: impl Into<String>) -> Self { Self::Validation(m.into()) }
    pub fn unauthorized(m: impl Into<String>) -> Self { Self::Unauthorized(m.into()) }
    pub fn forbidden(m: impl Into<String>) -> Self { Self::Forbidden(m.into()) }
    pub fn not_found(m: impl Into<String>) -> Self { Self::NotFound(m.into()) }
    pub fn conflict(m: impl Into<String>) -> Self { Self::Conflict(m.into()) }
    pub fn unprocessable(m: impl Into<String>) -> Self { Self::Unprocessable(m.into()) }
    pub fn upstream(m: impl Into<String>) -> Self { Self::Upstream(m.into()) }
    pub fn unavailable(m: impl Into<String>) -> Self { Self::Unavailable(m.into()) }
    pub fn internal(m: impl Into<String>) -> Self { Self::Internal(m.into()) }

    pub fn status(&self) -> StatusCode {
        match self {
            Self::Validation(_) => StatusCode::BAD_REQUEST,
            Self::Unauthorized(_) => StatusCode::UNAUTHORIZED,
            Self::Forbidden(_) => StatusCode::FORBIDDEN,
            Self::NotFound(_) => StatusCode::NOT_FOUND,
            Self::Conflict(_) => StatusCode::CONFLICT,
            Self::PayloadTooLarge(_) => StatusCode::PAYLOAD_TOO_LARGE,
            Self::Unprocessable(_) => StatusCode::UNPROCESSABLE_ENTITY,
            Self::TooManyRequests { .. } => StatusCode::TOO_MANY_REQUESTS,
            Self::Upstream(_) => StatusCode::BAD_GATEWAY,
            Self::Unavailable(_) | Self::Db(_) => StatusCode::SERVICE_UNAVAILABLE,
            Self::Internal(_) => StatusCode::INTERNAL_SERVER_ERROR,
        }
    }

    pub fn code(&self) -> &'static str {
        match self {
            Self::Validation(_) => "VALIDATION_ERROR",
            Self::Unauthorized(_) => "UNAUTHORIZED",
            Self::Forbidden(_) => "FORBIDDEN",
            Self::NotFound(_) => "NOT_FOUND",
            Self::Conflict(_) => "CONFLICT",
            Self::PayloadTooLarge(_) => "PAYLOAD_TOO_LARGE",
            Self::Unprocessable(_) => "UNPROCESSABLE_ENTITY",
            Self::TooManyRequests { .. } => "TOO_MANY_REQUESTS",
            Self::Upstream(_) => "UPSTREAM_ERROR",
            Self::Unavailable(_) | Self::Db(_) => "SERVICE_UNAVAILABLE",
            Self::Internal(_) => "INTERNAL_ERROR",
        }
    }

    fn client_message(&self) -> String {
        match self {
            // 数据库细节只进日志，不外发。
            Self::Db(_) => "数据库操作失败，请查看课程服务配置与授权".to_owned(),
            Self::Internal(_) => "服务内部错误".to_owned(),
            other => other.to_string(),
        }
    }

    fn details(&self) -> Value {
        match self {
            Self::TooManyRequests { retry_after, .. } => json!({ "retry_after": retry_after }),
            _ => json!({}),
        }
    }
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        match &self {
            Self::Db(e) => tracing::error!(error = %e, "database error"),
            Self::Internal(e) => tracing::error!(error = %e, "internal error"),
            _ => {}
        }
        let status = self.status();
        let mut response =
            (status, Json(ApiResponse::new(self.code(), self.client_message(), self.details()))).into_response();
        if let Self::TooManyRequests { retry_after, .. } = self {
            response.headers_mut().insert(header::RETRY_AFTER, HeaderValue::from(retry_after));
        }
        response
    }
}

impl From<JsonRejection> for AppError {
    fn from(r: JsonRejection) -> Self {
        match r {
            JsonRejection::BytesRejection(_) => Self::PayloadTooLarge("请求体过大或读取失败".into()),
            _ => Self::Validation("请求格式不正确".into()),
        }
    }
}

impl From<PathRejection> for AppError {
    fn from(_: PathRejection) -> Self {
        Self::Validation("路径参数不合法".into())
    }
}

impl From<QueryRejection> for AppError {
    fn from(_: QueryRejection) -> Self {
        Self::Validation("查询参数不合法".into())
    }
}
