//! 应用组装：路由挂载与全局中间件。

use axum::{
    Router,
    body::Body,
    extract::{Request, State},
    http::{HeaderValue, Method, header},
    middleware::{self, Next},
    response::{IntoResponse, Response},
};
use tower_http::trace::TraceLayer;

use crate::{error::AppError, routes, state::AppState};

/// 请求体上限（与旧版一致 1MB）。
pub const MAX_BODY: usize = 1_048_576;

pub fn build(state: AppState) -> Router {
    Router::new()
        .merge(routes::all())
        .fallback(|| async { AppError::not_found("接口不存在") })
        .layer(middleware::from_fn_with_state(state.clone(), request_guard))
        .layer(axum::extract::DefaultBodyLimit::max(MAX_BODY))
        .layer(TraceLayer::new_for_http())
        .with_state(state)
}

/// 写请求校验 Origin（CSRF 兜底，不替代鉴权）与请求体大小；所有响应禁止缓存。
async fn request_guard(State(s): State<AppState>, req: Request<Body>, next: Next) -> Response {
    if !matches!(*req.method(), Method::GET | Method::HEAD | Method::OPTIONS) {
        if let Some(origin) = req.headers().get(header::ORIGIN).and_then(|v| v.to_str().ok())
            && !s.cfg.allowed_origins.iter().any(|o| o == origin)
        {
            return AppError::forbidden("跨站请求被拒绝").into_response();
        }
        let length = req.headers().get(header::CONTENT_LENGTH).and_then(|v| v.to_str().ok()).and_then(|v| v.parse::<usize>().ok());
        if length.is_some_and(|n| n > MAX_BODY) {
            return AppError::PayloadTooLarge("文件不能超过 1MB".into()).into_response();
        }
    }
    let mut response = next.run(req).await;
    response.headers_mut().insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}
