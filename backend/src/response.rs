//! 统一响应信封：成功与失败同构 `{code, message, data}`，HTTP 状态码照常使用。
//! 成功时 `code == "OK"`；失败时见 `error::AppError::code`，细节放在 `data`。

use axum::{
    Json,
    response::{IntoResponse, Response},
};
use serde::Serialize;
use ts_rs::TS;

#[derive(Debug, Clone, Serialize, TS)]
#[ts(export)]
pub struct ApiResponse<T> {
    pub code: &'static str,
    pub message: String,
    pub data: T,
}

impl<T> ApiResponse<T> {
    pub fn new(code: &'static str, message: impl Into<String>, data: T) -> Self {
        Self { code, message: message.into(), data }
    }
}

/// 无载荷的成功响应。
#[derive(Debug, Clone, Copy, Default, Serialize, TS)]
#[ts(export)]
pub struct Empty {}

/// handler 的成功返回值：`Ok(ok(data))`。
pub struct ApiOk<T>(pub T);

pub fn ok<T: Serialize>(data: T) -> ApiOk<T> {
    ApiOk(data)
}

impl<T: Serialize> IntoResponse for ApiOk<T> {
    fn into_response(self) -> Response {
        Json(ApiResponse::new("OK", "success", self.0)).into_response()
    }
}
