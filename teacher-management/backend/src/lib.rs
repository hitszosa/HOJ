pub mod academic;
pub mod app;
pub mod external;
pub mod files;
pub mod identity;
pub mod management;
pub mod schema;

pub mod proto {
    tonic::include_proto!("suggest.extractor.v1");
}

use crate::academic::{assignments, courses, grading, statistics, submissions};
use crate::app::{cache, db::Db, error, metrics::Metrics, state::AppState};
use crate::identity::{auth, oauth, sso, users};
use crate::management::{announcements, audit};
use axum::{
    Router,
    extract::Request,
    http::{HeaderValue, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::get,
};
use diesel::prelude::*;
use diesel_async::RunQueryDsl;
use tower_http::{cors::CorsLayer, trace::TraceLayer};

async fn healthy(Db(mut conn): Db) -> error::Result<&'static str> {
    diesel::select(1_i32.into_sql::<diesel::sql_types::Integer>())
        .get_result::<i32>(&mut conn)
        .await?;
    Ok("ok")
}

async fn errors(request: Request, next: Next) -> Response {
    let response = next.run(request).await;
    let status = response.status();
    let json = response
        .headers()
        .get("content-type")
        .is_some_and(|v| v.as_bytes().starts_with(b"application/json"));
    if !status.is_client_error() || json {
        return response;
    }
    let kind = match status {
        StatusCode::NOT_FOUND => "not_found",
        StatusCode::METHOD_NOT_ALLOWED => "method_not_allowed",
        StatusCode::PAYLOAD_TOO_LARGE => "payload_too_large",
        _ => "bad_request",
    };
    let (parts, _) = response.into_parts();
    let message = status
        .canonical_reason()
        .unwrap_or("Request rejected")
        .to_owned();
    let body = axum::Json(error::ErrorResponse {
        error: kind,
        message,
        code: status.as_u16(),
    })
    .into_response()
    .into_body();
    let mut response = Response::from_parts(parts, body);
    response
        .headers_mut()
        .insert("content-type", HeaderValue::from_static("application/json"));
    response.headers_mut().remove("content-length");
    response
}

pub fn router(state: AppState, metrics: Metrics) -> error::Result<Router> {
    let api = Router::new()
        .merge(auth::router())
        .merge(crate::identity::hoj::router())
        .merge(users::router())
        .merge(courses::router())
        .merge(assignments::router())
        .merge(submissions::router())
        .merge(grading::router())
        .merge(statistics::router())
        .merge(files::router())
        .merge(announcements::router())
        .merge(audit::router())
        .merge(oauth::router())
        .merge(sso::router())
        .merge(external::router());
    let origins = state
        .config
        .cors_origins
        .iter()
        .map(|value| value.parse::<HeaderValue>())
        .collect::<std::result::Result<Vec<_>, _>>()
        .map_err(|_| error::AppError::Internal("Invalid CORS_ORIGINS".into()))?;
    let cors = CorsLayer::new()
        .allow_origin(origins)
        .allow_credentials(true)
        .allow_methods([
            http::Method::GET,
            http::Method::POST,
            http::Method::PUT,
            http::Method::PATCH,
            http::Method::DELETE,
            http::Method::OPTIONS,
        ])
        .allow_headers([
            http::header::CONTENT_TYPE,
            http::header::AUTHORIZATION,
            http::header::HeaderName::from_static("x-csrftoken"),
        ]);
    let router = Router::new()
        .nest("/api", api)
        .route("/healthz", get(healthy))
        .route(
            "/metrics",
            get(move || async move {
                (
                    [("content-type", "text/plain; version=0.0.4; charset=utf-8")],
                    metrics.handle.render(),
                )
            }),
        )
        .layer(axum::extract::DefaultBodyLimit::max(50 * 1024 * 1024))
        .layer(middleware::from_fn(auth::session_response))
        .layer(middleware::from_fn_with_state(
            state.clone(),
            cache::invalidate_auth_response,
        ))
        .layer(middleware::from_fn(audit::request_context))
        .layer(middleware::from_fn(errors))
        .layer(cors)
        .layer(
            TraceLayer::new_for_http().make_span_with(|request: &Request| {
                tracing::debug_span!(
                    "http_request",
                    method = %request.method(),
                    path = request.uri().path(),
                    version = ?request.version(),
                )
            }),
        )
        .layer(metrics.layer)
        .with_state(state);
    // Normalize before matching routes; an inner Router layer runs too late.
    Ok(Router::new()
        .fallback_service(tower_http::normalize_path::NormalizePath::trim_trailing_slash(router)))
}
