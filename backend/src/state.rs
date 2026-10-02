use std::sync::Arc;

use sqlx::{MySqlPool, mysql::MySqlPoolOptions};

use crate::{auth::SessionCache, config::Config, problem_bank::ProblemBank, security::SigningKey};

#[derive(Clone)]
pub struct AppState {
    pub cfg: Arc<Config>,
    /// 业务账号：教学域全权，jol 只读 + 提交链路的精确写权限。
    pub db: MySqlPool,
    /// 运维账号：写 jol.problem / jol.users / custominput。
    pub ops: MySqlPool,
    pub http: reqwest::Client,
    pub key: SigningKey,
    pub sessions: SessionCache,
    pub bank: Arc<ProblemBank>,
}

impl AppState {
    pub async fn connect(cfg: Config) -> anyhow_like::Result<Self> {
        let pool = |url: &str| {
            MySqlPoolOptions::new()
                .max_connections(cfg.db_max_connections)
                .acquire_timeout(std::time::Duration::from_secs(5))
                // 与 HUSTOJ 同一时区口径：NOW() 与 DATETIME 列都按会话时区解释。
                .connect_lazy(url)
        };
        let db = pool(&cfg.database_url)?;
        let ops = pool(&cfg.ops_database_url)?;
        let http = reqwest::Client::builder().no_proxy().redirect(reqwest::redirect::Policy::none()).build()?;
        let key = SigningKey::load_or_create(&cfg.root.join("data/local/session.key"))?;
        let bank = Arc::new(ProblemBank::load(&cfg.root.join("data")));
        let sessions = SessionCache::new(cfg.session_cache_ttl);
        Ok(Self { cfg: Arc::new(cfg), db, ops, http, key, sessions, bank })
    }
}

/// 启动期错误只需要打印，不值得引入 anyhow。
pub mod anyhow_like {
    pub type Result<T> = std::result::Result<T, Box<dyn std::error::Error + Send + Sync>>;
}
