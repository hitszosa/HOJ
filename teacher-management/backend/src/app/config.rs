use crate::app::error::{AppError, Result};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use cookie::Key;
use std::{env, net::SocketAddr};

#[derive(Clone)]
pub struct Config {
    pub database_url: String,
    pub hoj_api_url: Option<String>,
    pub bind: SocketAddr,
    pub cookie_key: Key,
    pub csrf_secret: Vec<u8>,
    pub cookie_secure: bool,
    pub session_refresh_grace_seconds: u64,
    pub password_iterations: u32,
    pub s3_public_url: String,
    pub s3_internal_url: String,
    pub s3_bucket: String,
    pub aws_region: String,
    pub upload_ttl_seconds: u64,
    pub extractor_url: String,
    pub extractor_timeout_seconds: u64,
    pub extractor_connect_timeout_seconds: u64,
    pub sso_auth_url: String,
    pub sso_token_url: String,
    pub sso_profile_url: String,
    pub sso_client_id: String,
    pub sso_client_secret: String,
    pub sso_redirect_url: String,
    pub cors_origins: Vec<String>,
}

fn required(name: &str) -> Result<String> {
    env::var(name)
        .ok()
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| AppError::Internal(format!("{name} must be configured")))
}

fn value(name: &str, default: &str) -> String {
    env::var(name).unwrap_or_else(|_| default.to_owned())
}

fn number<T: std::str::FromStr>(name: &str, default: &str) -> Result<T> {
    value(name, default)
        .parse()
        .map_err(|_| AppError::Internal(format!("Invalid {name}")))
}

impl Config {
    pub fn from_env() -> Result<Self> {
        let secret = env::var("SESSION_SECRET_KEY")
            .or_else(|_| env::var("ROCKET_SECRET_KEY"))
            .map_err(|_| AppError::Internal("SESSION_SECRET_KEY must be configured".into()))?;
        let bytes = if secret.trim().len() == 64 {
            hex::decode(secret.trim())
                .map_err(|_| AppError::Internal("Invalid hexadecimal session key".into()))?
        } else {
            STANDARD.decode(secret.trim()).map_err(|_| {
                AppError::Internal("Session key must be base64 or 64 hexadecimal characters".into())
            })?
        };
        if bytes.iter().all(|byte| *byte == 0) {
            return Err(AppError::Internal(
                "Session key must not be all zeroes".into(),
            ));
        }
        let cookie_key = match bytes.len() {
            32 => Key::derive_from(&bytes),
            64 => Key::from(&bytes),
            _ => {
                return Err(AppError::Internal(
                    "Session key must decode to 32 or 64 bytes".into(),
                ));
            }
        };
        let password_iterations = number("PASSWORD_ITERATIONS", "100000")?;
        if !(10000..=2000000).contains(&password_iterations) {
            return Err(AppError::Internal(
                "PASSWORD_ITERATIONS outside supported range".into(),
            ));
        }
        let upload_ttl_seconds = number("UPLOAD_TTL_SECONDS", "3600")?;
        if !(30..=3600).contains(&upload_ttl_seconds) {
            return Err(AppError::Internal(
                "UPLOAD_TTL_SECONDS must be between 30 and 3600".into(),
            ));
        }
        let session_refresh_grace_seconds = number("SESSION_REFRESH_GRACE_SECONDS", "86400")?;
        if session_refresh_grace_seconds > 604800 {
            return Err(AppError::Internal(
                "SESSION_REFRESH_GRACE_SECONDS must not exceed seven days".into(),
            ));
        }
        Ok(Self {
            database_url: required("DATABASE_URL")?,
            hoj_api_url: env::var("HOJ_API_URL").ok().filter(|s| !s.is_empty()),
            bind: number("BIND", "0.0.0.0:8000")?,
            cookie_key,
            csrf_secret: env::var("CSRF_SECRET")
                .unwrap_or(secret)
                .trim()
                .as_bytes()
                .to_vec(),
            cookie_secure: number("COOKIE_SECURE", "true")?,
            session_refresh_grace_seconds,
            password_iterations,
            s3_public_url: required("S3_PUBLIC_URL")?,
            s3_internal_url: required("S3_INTERNAL_URL")?,
            s3_bucket: value("S3_BUCKET_NAME", "grader-uploads"),
            aws_region: value("AWS_REGION", "us-east-1"),
            upload_ttl_seconds,
            extractor_url: value("SUGGEST_EXTRACTOR_ENDPOINT", "http://127.0.0.1:50051"),
            extractor_timeout_seconds: number("SUGGEST_EXTRACTOR_TIMEOUT_SECS", "60")?,
            extractor_connect_timeout_seconds: number(
                "SUGGEST_EXTRACTOR_CONNECT_TIMEOUT_SECS",
                "5",
            )?,
            sso_auth_url: value(
                "HITIDS_AUTH_URI",
                "https://ids.hit.edu.cn/authserver/oauth2.0/authorize",
            ),
            sso_token_url: value(
                "HITIDS_TOKEN_URI",
                "https://ids.hit.edu.cn/authserver/oauth2.0/accessToken",
            ),
            sso_profile_url: value(
                "HITIDS_PROFILE_URI",
                "https://ids.hit.edu.cn/authserver/oauthApi/user/profile",
            ),
            sso_client_id: value("HITIDS_CLIENT_ID", ""),
            sso_client_secret: value("HITIDS_CLIENT_SECRET", ""),
            sso_redirect_url: value(
                "HITIDS_REDIRECT_URI",
                "http://localhost:8000/api/auth/callback",
            ),
            cors_origins: value("CORS_ORIGINS", "")
                .split(',')
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_owned)
                .collect(),
        })
    }
}
