//! HTTP 层回归：不连数据库（连接池惰性建立），只验证鉴权、CSRF 与统一信封。

use axum::{
    body::Body,
    http::{Request, StatusCode},
};
use http_body_util::BodyExt;
use serde_json::Value;
use tower::ServiceExt;

async fn app(sso: bool) -> axum::Router {
    let root = std::env::temp_dir().join(format!("hoj-http-test-{}-{sso}", std::process::id()));
    std::fs::create_dir_all(&root).unwrap();
    // SAFETY: 测试进程内只在构建配置前设置一次环境变量。
    unsafe {
        std::env::set_var("COURSE_ROOT", &root);
        std::env::set_var("COURSE_DATABASE_URL", "mysql://nobody:x@127.0.0.1:1/none");
        std::env::set_var("COURSE_OPS_DATABASE_URL", "mysql://nobody:x@127.0.0.1:1/none");
        std::env::set_var("COURSE_DEV_LOGIN", "1");
    }
    let mut cfg = hoj::config::Config::from_env();
    cfg.sso_configured = sso;
    let state = hoj::state::AppState::connect(cfg).await.unwrap();
    hoj::app::build(state)
}

async fn call(app: axum::Router, req: Request<Body>) -> (StatusCode, Value) {
    let res = app.oneshot(req).await.unwrap();
    let status = res.status();
    let bytes = res.into_body().collect().await.unwrap().to_bytes();
    (status, serde_json::from_slice(&bytes).unwrap())
}

#[tokio::test]
async fn health_uses_envelope() {
    let (status, body) = call(app(false).await, Request::get("/api/health").body(Body::empty()).unwrap()).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["code"], "OK");
    assert_eq!(body["data"]["dev_login"], true);
}

#[tokio::test]
async fn unauthenticated_request_is_rejected() {
    let (status, body) = call(app(false).await, Request::get("/api/courses").body(Body::empty()).unwrap()).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(body["code"], "UNAUTHORIZED");
}

#[tokio::test]
async fn sso_header_is_ignored_unless_configured() {
    let req = || Request::get("/api/me").header("X-Remote-User", "admin").body(Body::empty()).unwrap();
    let (status, _) = call(app(false).await, req()).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED, "未配置 SSO 时客户端自带的身份头必须被忽略");
}

#[tokio::test]
async fn forged_dev_cookie_is_rejected() {
    let req = Request::get("/api/courses").header("cookie", "course_session=e30=.fake").body(Body::empty()).unwrap();
    let (status, _) = call(app(false).await, req).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn cross_site_write_is_rejected() {
    let req = Request::post("/api/session")
        .header("origin", "https://attacker.invalid")
        .header("content-type", "application/json")
        .body(Body::from(r#"{"role":"teacher"}"#))
        .unwrap();
    let (status, body) = call(app(false).await, req).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(body["message"], "跨站请求被拒绝");
}

#[tokio::test]
async fn malformed_input_uses_envelope() {
    let req = Request::post("/api/session").header("content-type", "application/json").body(Body::from("{bad")).unwrap();
    let (status, body) = call(app(false).await, req).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body["code"], "VALIDATION_ERROR");
    let (status, body) = call(app(false).await, Request::get("/api/nope").body(Body::empty()).unwrap()).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(body["code"], "NOT_FOUND");
}

#[tokio::test]
async fn dev_login_sets_cookie() {
    let req = Request::post("/api/session").header("content-type", "application/json").body(Body::from(r#"{"role":"teacher"}"#)).unwrap();
    let res = app(false).await.oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let cookies: Vec<_> = res.headers().get_all("set-cookie").iter().map(|v| v.to_str().unwrap().to_owned()).collect();
    assert!(cookies.iter().any(|c| c.starts_with("course_session=") && c.contains("HttpOnly")));
    assert_eq!(res.headers()["cache-control"], "no-store");
}
