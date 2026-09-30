//! 运行配置：全部来自环境变量（启动时先加载 backend/.env，已存在的变量不覆盖）。

use std::{env, path::PathBuf, time::Duration};

#[derive(Debug, Clone)]
pub struct Config {
    /// backend/ 根目录：data/ 与 schema/ 相对它定位。
    pub root: PathBuf,
    pub bind: String,
    /// 业务账号（codemind）连接串，默认库 codemind_course。
    pub database_url: String,
    /// 运维账号（codemind_ops）连接串：写 jol.problem、jol.users、custominput 等。
    pub ops_database_url: String,
    pub db_max_connections: u32,
    pub allowed_origins: Vec<String>,
    pub dev_login: bool,
    /// 显式配置了 SSO 头（用于 /api/health 报告）；未配置时仍按默认头名读取。
    pub sso_configured: bool,
    pub sso_header: String,
    pub sso_role_header: String,
    pub hustoj_cookie: String,
    pub hustoj_session_url: String,
    pub session_cache_ttl: Duration,
    /// 判题数据目录（与 HUSTOJ 共享的卷）。设置后直接写文件，否则回退到 docker exec。
    pub judge_data_dir: Option<PathBuf>,
    pub hustoj_container: String,
    pub ai: AiConfig,
}

#[derive(Debug, Clone)]
pub struct AiConfig {
    pub url: Option<String>,
    pub model: Option<String>,
    pub key: Option<String>,
    /// 学习建议的超时（COURSE_AI_TIMEOUT，1–60 秒，默认 20）。出题固定 45 秒。
    pub hint_timeout: Duration,
}

impl AiConfig {
    pub fn configured(&self) -> bool {
        self.url.as_deref().is_some_and(|s| !s.is_empty()) && self.model.as_deref().is_some_and(|s| !s.is_empty())
    }
}

fn var(key: &str) -> Option<String> {
    env::var(key).ok().filter(|v| !v.is_empty())
}

fn var_or(key: &str, default: &str) -> String {
    var(key).unwrap_or_else(|| default.to_owned())
}

/// 未显式给连接串时，由 COURSE_DB_* 拼出。`COURSE_DB_SOCKET` 优先于 host/port：
/// 通过挂载 HUSTOJ 容器的 mysqld.sock 连接时，MySQL 视来源为 localhost，沿用现有授权。
fn build_url(prefix: &str, default_user: &str) -> String {
    let user = var(&format!("{prefix}USER")).unwrap_or_else(|| default_user.to_owned());
    let password = var(&format!("{prefix}PASSWORD")).or_else(|| var("COURSE_DB_PASSWORD")).unwrap_or_default();
    let db = var_or("COURSE_DB_NAME", "codemind_course");
    let enc = |s: &str| {
        s.bytes()
            .map(|b| match b {
                b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => (b as char).to_string(),
                _ => format!("%{b:02X}"),
            })
            .collect::<String>()
    };
    match var("COURSE_DB_SOCKET") {
        Some(socket) => format!("mysql://{}:{}@localhost/{db}?socket={}", enc(&user), enc(&password), enc(&socket)),
        None => format!(
            "mysql://{}:{}@{}:{}/{db}",
            enc(&user),
            enc(&password),
            var_or("COURSE_DB_HOST", "127.0.0.1"),
            var_or("COURSE_DB_PORT", "3306")
        ),
    }
}

impl Config {
    pub fn from_env() -> Self {
        let root = var("COURSE_ROOT").map(PathBuf::from).unwrap_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")));
        let _ = dotenvy::from_path(root.join(".env"));
        let hint_timeout = var("COURSE_AI_TIMEOUT").and_then(|v| v.parse::<f64>().ok()).unwrap_or(20.0).clamp(1.0, 60.0);
        Self {
            bind: var_or("COURSE_BIND", "127.0.0.1:8100"),
            database_url: var("COURSE_DATABASE_URL").unwrap_or_else(|| build_url("COURSE_DB_", "codemind")),
            ops_database_url: var("COURSE_OPS_DATABASE_URL").unwrap_or_else(|| build_url("COURSE_OPS_", "codemind_ops")),
            db_max_connections: var("COURSE_DB_MAX_CONNECTIONS").and_then(|v| v.parse().ok()).unwrap_or(16),
            allowed_origins: var_or("COURSE_ALLOWED_ORIGINS", "http://localhost:3100,http://127.0.0.1:3100")
                .split(',')
                .map(|s| s.trim().to_owned())
                .filter(|s| !s.is_empty())
                .collect(),
            dev_login: var("COURSE_DEV_LOGIN").as_deref() == Some("1"),
            sso_configured: var("COURSE_SSO_HEADER").is_some(),
            sso_header: var_or("COURSE_SSO_HEADER", "X-Remote-User"),
            sso_role_header: var_or("COURSE_SSO_ROLE_HEADER", "X-Remote-Role"),
            hustoj_cookie: var_or("COURSE_HUSTOJ_COOKIE", "PHPSESSID"),
            hustoj_session_url: var_or("COURSE_HUSTOJ_SESSION_URL", "http://127.0.0.1:8080/course.php?mode=session"),
            session_cache_ttl: Duration::from_secs(var("COURSE_SESSION_CACHE_TTL").and_then(|v| v.parse().ok()).unwrap_or(30)),
            judge_data_dir: var("COURSE_JUDGE_DATA_DIR").map(PathBuf::from),
            hustoj_container: var_or("COURSE_CONTAINER", "hustoj"),
            ai: AiConfig {
                url: var("COURSE_AI_URL"),
                model: var("COURSE_AI_MODEL"),
                key: var("COURSE_AI_KEY"),
                hint_timeout: Duration::from_secs_f64(hint_timeout),
            },
            root,
        }
    }
}
