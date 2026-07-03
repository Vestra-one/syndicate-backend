//! Wallet sessions: nonce → ed25519 signature → bearer token (sha256 stored in the
//! `sessions` table, 24 h TTL). The same challenge/response is reused inside the WS
//! handshake (`Challenge`/`Auth` frames).

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use axum::extract::State;
use axum::http::HeaderMap;
use axum::Json;
use base64::Engine as _;
use rand::RngCore;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::app::AppState;
use crate::error::ApiError;
use crate::util::now_ms;

const NONCE_TTL: Duration = Duration::from_secs(120);
const SESSION_TTL_HOURS: i64 = 24;

#[derive(Default)]
pub struct NonceStore {
    inner: Mutex<HashMap<String, (String, Instant)>>,
}

impl NonceStore {
    pub fn issue(&self, wallet: &str) -> String {
        let mut bytes = [0u8; 32];
        rand::rngs::OsRng.fill_bytes(&mut bytes);
        let nonce = format!("syndicate-login:{}", hex::encode(bytes));
        let mut map = self.inner.lock().expect("nonce lock");
        map.retain(|_, (_, at)| at.elapsed() < NONCE_TTL);
        map.insert(wallet.to_string(), (nonce.clone(), Instant::now()));
        nonce
    }

    /// Install an externally-issued nonce (WS challenge path) so the shared
    /// verify-and-create-session flow can consume it.
    pub fn install(&self, wallet: &str, nonce: &str) {
        let mut map = self.inner.lock().expect("nonce lock");
        map.insert(wallet.to_string(), (nonce.to_string(), Instant::now()));
    }

    pub fn take(&self, wallet: &str) -> Option<String> {
        let mut map = self.inner.lock().expect("nonce lock");
        let (nonce, at) = map.remove(wallet)?;
        (at.elapsed() < NONCE_TTL).then_some(nonce)
    }
}

pub fn valid_wallet(wallet: &str) -> bool {
    syndicate_engine::verify::decode_wallet_pubkey(wallet).is_ok()
}

#[derive(Deserialize)]
pub struct NonceBody {
    pub wallet: String,
}

/// `POST /v1/auth/nonce`.
pub async fn post_nonce(
    State(st): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<NonceBody>,
) -> Result<Json<Value>, ApiError> {
    st.limits.check_auth(&client_ip(&headers))?;
    if !valid_wallet(&body.wallet) {
        return Err(ApiError::bad_request(
            "wallet must be a base58 ed25519 pubkey",
        ));
    }
    let nonce = st.nonces.issue(&body.wallet);
    Ok(Json(json!({
        "nonce": nonce,
        "expires_at": now_ms() + NONCE_TTL.as_millis() as u64,
    })))
}

#[derive(Deserialize)]
pub struct VerifyBody {
    pub wallet: String,
    /// base64 ed25519 signature over the nonce string bytes.
    pub signature: String,
}

/// `POST /v1/auth/verify`.
pub async fn post_verify(
    State(st): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<VerifyBody>,
) -> Result<Json<Value>, ApiError> {
    st.limits.check_auth(&client_ip(&headers))?;
    let token = verify_and_create_session(&st, &body.wallet, &body.signature).await?;
    Ok(Json(json!({
        "session": token.0,
        "wallet": body.wallet,
        "expires_at": token.1,
    })))
}

/// Shared by HTTP and the WS `Auth` frame. Returns `(token, expires_at_ms)`.
pub async fn verify_and_create_session(
    st: &AppState,
    wallet: &str,
    signature_b64: &str,
) -> Result<(String, u64), ApiError> {
    let nonce = st
        .nonces
        .take(wallet)
        .ok_or_else(|| ApiError::unauthorized("no active nonce for wallet"))?;
    syndicate_engine::verify::verify_ed25519(wallet, nonce.as_bytes(), signature_b64)
        .map_err(|_| ApiError::unauthorized("invalid signature over nonce"))?;

    let mut token_bytes = [0u8; 32];
    rand::rngs::OsRng.fill_bytes(&mut token_bytes);
    let token = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(token_bytes);
    let token_hash = syndicate_shared::intent::sha256(token.as_bytes());
    let expires_at = chrono::Utc::now() + chrono::Duration::hours(SESSION_TTL_HOURS);

    let client = st.pool.get().await?;
    client
        .execute(
            "INSERT INTO sessions (token_hash, wallet, expires_at) VALUES ($1, $2, $3)",
            &[&token_hash.as_slice(), &wallet, &expires_at],
        )
        .await?;
    Ok((token, expires_at.timestamp_millis() as u64))
}

/// Resolve a bearer token (raw string) to its wallet, if unexpired.
pub async fn wallet_for_token(st: &AppState, token: &str) -> Result<Option<String>, ApiError> {
    let token_hash = syndicate_shared::intent::sha256(token.as_bytes());
    let client = st.pool.get().await?;
    let row = client
        .query_opt(
            "SELECT wallet FROM sessions WHERE token_hash = $1 AND expires_at > now()",
            &[&token_hash.as_slice()],
        )
        .await?;
    Ok(row.map(|r| r.get("wallet")))
}

/// Require a valid `Authorization: Bearer <token>` header; returns the wallet.
pub async fn require_session(st: &AppState, headers: &HeaderMap) -> Result<String, ApiError> {
    let token = bearer_token(headers)
        .ok_or_else(|| ApiError::unauthorized("missing Authorization: Bearer token"))?;
    wallet_for_token(st, &token)
        .await?
        .ok_or_else(|| ApiError::unauthorized("invalid or expired session"))
}

pub fn bearer_token(headers: &HeaderMap) -> Option<String> {
    headers
        .get(axum::http::header::AUTHORIZATION)?
        .to_str()
        .ok()?
        .strip_prefix("Bearer ")
        .map(|s| s.trim().to_string())
}

/// Require a static admin token (constant-time compare against `ADMIN_TOKENS`).
pub fn require_admin(st: &AppState, headers: &HeaderMap) -> Result<(), ApiError> {
    let Some(token) = bearer_token(headers) else {
        return Err(ApiError::unauthorized("admin token required"));
    };
    let ok = st
        .cfg
        .admin_tokens
        .iter()
        .any(|t| constant_time_eq(t.as_bytes(), token.as_bytes()));
    if ok {
        Ok(())
    } else {
        Err(ApiError::unauthorized("invalid admin token"))
    }
}

pub fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

/// Best-effort client IP: CF/X-Forwarded-For first hop, else "unknown".
pub fn client_ip(headers: &HeaderMap) -> String {
    for h in ["cf-connecting-ip", "x-forwarded-for", "x-real-ip"] {
        if let Some(v) = headers.get(h).and_then(|v| v.to_str().ok()) {
            if let Some(first) = v.split(',').next() {
                let first = first.trim();
                if !first.is_empty() {
                    return first.to_string();
                }
            }
        }
    }
    "unknown".to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn constant_time_eq_basic() {
        assert!(constant_time_eq(b"secret", b"secret"));
        assert!(!constant_time_eq(b"secret", b"secreT"));
        assert!(!constant_time_eq(b"secret", b"secre"));
    }

    #[test]
    fn nonce_single_use() {
        let store = NonceStore::default();
        let n = store.issue("w1");
        assert_eq!(store.take("w1"), Some(n));
        assert_eq!(store.take("w1"), None);
    }
}
