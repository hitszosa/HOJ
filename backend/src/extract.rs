//! 把 axum 的提取失败统一转成 `AppError` 信封，handler 里用这三个代替 axum 原生版本。

use axum::extract::{FromRequest, FromRequestParts};

use crate::error::AppError;

#[derive(FromRequest)]
#[from_request(via(axum::Json), rejection(AppError))]
pub struct Json<T>(pub T);

#[derive(FromRequestParts)]
#[from_request(via(axum::extract::Path), rejection(AppError))]
pub struct Path<T>(pub T);

#[derive(FromRequestParts)]
#[from_request(via(axum::extract::Query), rejection(AppError))]
pub struct Query<T>(pub T);
