use axum::{
    Json,
    http::StatusCode,
    response::{IntoResponse, Response},
};
use serde::Serialize;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum AppError {
    #[error("Database error: {0}")]
    Database(#[from] diesel::result::Error),
    #[error("Authentication error: {0}")]
    Auth(String),
    #[error("CSRF verification failed")]
    Csrf,
    #[error("Authorization error: {0}")]
    Authorization(String),
    #[error("Validation error: {0}")]
    Validation(String),
    #[error("Not found: {0}")]
    NotFound(String),
    #[error("Bad request: {0}")]
    BadRequest(String),
    #[error("Conflict: {0}")]
    Conflict(String),
    #[error("Internal error: {0}")]
    Internal(String),
    #[error("Storage error: {0}")]
    S3(String),
    #[error("Service unavailable: {0}")]
    Unavailable(String),
}

#[derive(Serialize)]
pub struct ErrorResponse {
    pub error: &'static str,
    pub message: String,
    pub code: u16,
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let (status, kind, message) = match &self {
            Self::Auth(_) => (
                StatusCode::UNAUTHORIZED,
                "authentication_error",
                "Authentication failed",
            ),
            Self::Csrf => (
                StatusCode::FORBIDDEN,
                "csrf_failed",
                "CSRF verification failed",
            ),
            Self::Authorization(_) => (
                StatusCode::FORBIDDEN,
                "authorization_error",
                "Permission denied",
            ),
            Self::Validation(message) => (
                StatusCode::BAD_REQUEST,
                "validation_error",
                message.as_str(),
            ),
            Self::BadRequest(message) => (StatusCode::BAD_REQUEST, "bad_request", message.as_str()),
            Self::Conflict(message) => (StatusCode::CONFLICT, "conflict", message.as_str()),
            Self::NotFound(_) | Self::Database(diesel::result::Error::NotFound) => {
                (StatusCode::NOT_FOUND, "not_found", "Resource not found")
            }
            Self::Database(diesel::result::Error::DatabaseError(
                diesel::result::DatabaseErrorKind::UniqueViolation,
                _,
            )) => (StatusCode::CONFLICT, "conflict", "Resource already exists"),
            Self::S3(_) => (
                StatusCode::BAD_GATEWAY,
                "s3_error",
                "File storage service error",
            ),
            Self::Unavailable(_) => (
                StatusCode::SERVICE_UNAVAILABLE,
                "service_unavailable",
                "Service temporarily unavailable",
            ),
            Self::Database(_) | Self::Internal(_) => (
                StatusCode::INTERNAL_SERVER_ERROR,
                "internal_error",
                "Internal server error",
            ),
        };
        if status.is_server_error() {
            tracing::error!(error_type = kind, "Request failed");
        }
        (
            status,
            Json(ErrorResponse {
                error: kind,
                message: message.to_owned(),
                code: status.as_u16(),
            }),
        )
            .into_response()
    }
}

pub type Result<T, E = AppError> = std::result::Result<T, E>;
