//! 签名：开发登录 cookie 与自测 runId。格式与旧 Python 版一致，session.key 可以沿用。

use std::{
    fs,
    io::Write,
    os::unix::fs::OpenOptionsExt,
    path::Path,
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};

use base64::{
    Engine,
    engine::general_purpose::{URL_SAFE, URL_SAFE_NO_PAD},
};
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use sha2::Sha256;

use crate::error::AppError;

#[derive(Clone)]
pub struct SigningKey(Arc<Vec<u8>>);

fn now_secs() -> f64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs_f64()).unwrap_or(0.0)
}

impl SigningKey {
    /// 首次启动原子地生成 32 字节随机 hex 密钥（0600），之后只读。
    pub fn load_or_create(path: &Path) -> std::io::Result<Self> {
        if let Some(dir) = path.parent() {
            fs::create_dir_all(dir)?;
        }
        match fs::OpenOptions::new().write(true).create_new(true).mode(0o600).open(path) {
            Ok(mut f) => {
                let bytes: [u8; 32] = rand::random();
                f.write_all(hex::encode(bytes).as_bytes())?;
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(e) => return Err(e),
        }
        Ok(Self(Arc::new(fs::read(path)?)))
    }

    #[cfg(test)]
    pub fn from_bytes(bytes: &[u8]) -> Self {
        Self(Arc::new(bytes.to_vec()))
    }

    fn sign(&self, message: &str) -> String {
        let mut mac = Hmac::<Sha256>::new_from_slice(&self.0).expect("hmac accepts any key length");
        mac.update(message.as_bytes());
        hex::encode(mac.finalize().into_bytes())
    }

    fn verify(&self, message: &str, signature: &str) -> bool {
        let mut mac = Hmac::<Sha256>::new_from_slice(&self.0).expect("hmac accepts any key length");
        mac.update(message.as_bytes());
        hex::decode(signature).is_ok_and(|sig| mac.verify_slice(&sig).is_ok())
    }

    /// 开发登录 cookie：`base64url(json{user,exp}).hex(hmac)`，有效期 12 小时。
    pub fn dev_cookie(&self, user: &str) -> String {
        let payload = URL_SAFE.encode(serde_json::json!({"user": user, "exp": now_secs() + 43200.0}).to_string());
        let sig = self.sign(&payload);
        format!("{payload}.{sig}")
    }

    pub fn read_dev_cookie(&self, value: &str) -> Option<String> {
        #[derive(Deserialize)]
        struct Payload {
            user: String,
            exp: f64,
        }
        let (payload, sig) = value.split_once('.')?;
        if !self.verify(payload, sig) {
            return None;
        }
        let decoded: Payload = serde_json::from_slice(&URL_SAFE.decode(payload).ok()?).ok()?;
        (decoded.exp >= now_secs()).then_some(decoded.user)
    }

    /// 自测 runId：绑定 solution_id、题单、题目与用户，1 小时有效。
    pub fn trial_token(&self, sid: u32, bid: u32, pid: i32, user: &str) -> String {
        let claims = TrialClaims { sid, bid, pid, user: user.to_owned(), exp: now_secs() as i64 + 3600 };
        let payload = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&claims).expect("claims serialize"));
        let sig = self.sign(&format!("trial:{payload}"));
        format!("{payload}.{sig}")
    }

    pub fn read_trial_token(&self, token: &str, user: &str) -> Result<TrialClaims, AppError> {
        let invalid = || AppError::not_found("自测记录不存在或已过期");
        if token.len() > 2048 {
            return Err(invalid());
        }
        let (payload, sig) = token.split_once('.').ok_or_else(invalid)?;
        if sig.contains('.') || !self.verify(&format!("trial:{payload}"), sig) {
            return Err(invalid());
        }
        let bytes = URL_SAFE_NO_PAD.decode(payload.trim_end_matches('=')).map_err(|_| invalid())?;
        let claims: TrialClaims = serde_json::from_slice(&bytes).map_err(|_| invalid())?;
        if claims.user != user || (claims.exp as f64) <= now_secs() || claims.sid == 0 || claims.bid == 0 || claims.pid <= 0 {
            return Err(invalid());
        }
        Ok(claims)
    }
}

#[derive(Debug, Serialize, Deserialize)]
pub struct TrialClaims {
    pub sid: u32,
    pub bid: u32,
    pub pid: i32,
    pub user: String,
    pub exp: i64,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dev_cookie_roundtrip_and_forgery() {
        let key = SigningKey::from_bytes(b"k");
        let c = key.dev_cookie("alice");
        assert_eq!(key.read_dev_cookie(&c).as_deref(), Some("alice"));
        assert!(key.read_dev_cookie("e30=.fake").is_none());
        assert!(SigningKey::from_bytes(b"other").read_dev_cookie(&c).is_none());
    }

    #[test]
    fn trial_token_is_bound_to_user() {
        let key = SigningKey::from_bytes(b"k");
        let t = key.trial_token(5, 6, 7, "alice");
        let claims = key.read_trial_token(&t, "alice").unwrap();
        assert_eq!((claims.sid, claims.bid, claims.pid), (5, 6, 7));
        assert!(key.read_trial_token(&t, "bob").is_err());
        assert!(key.read_trial_token(&format!("{t}x"), "alice").is_err());
    }
}
