use crate::app::error::{AppError, Result};
use pbkdf2::pbkdf2_hmac;
use rand::{TryRngCore, rngs::OsRng};
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;
use tokio::sync::Semaphore;

const PREFIX: &str = "pbkdf2_sha256_legacy";
const MAX_ITERATIONS: u32 = 10_000_000;
static PASSWORD_WORKERS: Semaphore = Semaphore::const_new(4);

fn check_iterations(iterations: u32) -> Result<()> {
    if iterations == 0 || iterations > MAX_ITERATIONS {
        return Err(AppError::Internal("Invalid password work factor".into()));
    }
    Ok(())
}

fn random_salt() -> Result<[u8; 16]> {
    let mut salt = [0; 16];
    OsRng
        .try_fill_bytes(&mut salt)
        .map_err(|_| AppError::Internal("Secure randomness unavailable".into()))?;
    Ok(salt)
}

fn encode(inner: &[u8; 16], digest: &[u8], iterations: u32) -> Result<String> {
    check_iterations(iterations)?;
    let outer = random_salt()?;
    let mut derived = [0; 32];
    pbkdf2_hmac::<Sha256>(digest, &outer, iterations, &mut derived);
    Ok(format!(
        "{PREFIX}$v1${iterations}${}${}${}",
        hex::encode(inner),
        hex::encode(outer),
        hex::encode(derived)
    ))
}

pub fn hash(password: &str, iterations: u32) -> Result<String> {
    let inner = random_salt()?;
    let mut digest = Sha256::new();
    digest.update(inner);
    digest.update(password.as_bytes());
    encode(&inner, &digest.finalize(), iterations)
}

/// Unversioned legacy records are deliberately never accepted at runtime.
pub fn verify(password: &str, stored: &str) -> Result<bool> {
    let mut parts = stored.split('$');
    if parts.next() != Some(PREFIX) || parts.next() != Some("v1") {
        return Ok(false);
    }
    let Some(iterations) = parts.next().and_then(|value| value.parse::<u32>().ok()) else {
        return Ok(false);
    };
    if iterations == 0 || iterations > MAX_ITERATIONS {
        return Ok(false);
    }
    let mut inner = [0; 16];
    let mut outer = [0; 16];
    let mut expected = [0; 32];
    if hex::decode_to_slice(parts.next().unwrap_or_default(), &mut inner).is_err()
        || hex::decode_to_slice(parts.next().unwrap_or_default(), &mut outer).is_err()
        || hex::decode_to_slice(parts.next().unwrap_or_default(), &mut expected).is_err()
        || parts.next().is_some()
    {
        return Ok(false);
    }
    let mut digest = Sha256::new();
    digest.update(inner);
    digest.update(password.as_bytes());
    let mut actual = [0; 32];
    pbkdf2_hmac::<Sha256>(&digest.finalize(), &outer, iterations, &mut actual);
    Ok(bool::from(actual.ct_eq(&expected)))
}

/// Holds the permit in the worker even if its request is cancelled.
pub(crate) async fn blocking<T, F>(work: F) -> Result<T>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T> + Send + 'static,
{
    let permit = PASSWORD_WORKERS
        .acquire()
        .await
        .map_err(|_| AppError::Unavailable("Password service unavailable".into()))?;
    tokio::task::spawn_blocking(move || {
        let _permit = permit;
        work()
    })
    .await
    .map_err(|_| AppError::Internal("Password processing failed".into()))?
}

pub(crate) fn require_strength(password: &str, context: &[&str]) -> Result<()> {
    let entropy = zxcvbn::zxcvbn(password, context);
    match entropy.score() {
        zxcvbn::Score::Zero | zxcvbn::Score::One | zxcvbn::Score::Two => Err(AppError::BadRequest(
            format!("Password too weak, feedback:{:?}", entropy.feedback()),
        )),
        _ => Ok(()),
    }
}
