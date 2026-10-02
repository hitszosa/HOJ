use hoj::{app, config::Config, state::AppState};
use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt().with_env_filter(EnvFilter::try_from_default_env().unwrap_or_else(|_| "hoj=info,tower_http=warn".into())).init();
    let cfg = Config::from_env();
    let bind = cfg.bind.clone();
    let state = match AppState::connect(cfg).await {
        Ok(s) => s,
        Err(e) => {
            tracing::error!(error = %e, "startup failed");
            std::process::exit(1);
        }
    };
    let listener = tokio::net::TcpListener::bind(&bind).await.unwrap_or_else(|e| panic!("bind {bind}: {e}"));
    tracing::info!(%bind, "listening");
    axum::serve(listener, app::build(state))
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await
        .expect("server error");
}
