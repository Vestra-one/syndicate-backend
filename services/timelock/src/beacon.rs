//! Real drand beacon client (`04 §12`, `08 OQ3`).
//!
//! drand's HTTP API: `GET {base}/{chainHash}/info` → chain parameters, and
//! `GET {base}/{chainHash}/public/{round}` → the round's randomness + **BLS signature**.
//! For time-lock encryption (`tlock`) that round signature *is* the IBE decryption key
//! for messages encrypted to that round. This module models those responses, builds the
//! URLs, parses them, and maps a fetched round to the [`crate::RoundKey`] consumed by
//! [`crate::SealRegistry::decrypt_all`].
//!
//! The structs/parsers/round-math are real and unit-tested offline. The live HTTP fetch
//! ([`HttpBeaconClient`]) is behind the `net` feature. The IBE crypto that turns the
//! round signature into a plaintext is the production [`crate::TimelockScheme`] impl
//! (a `tlock`/IBE crate over BLS12-381) — this module supplies its key input.

use serde::Deserialize;

use crate::RoundKey;

/// `GET /{chainHash}/info`
#[derive(Debug, Clone, Deserialize)]
pub struct DrandInfo {
    pub public_key: String,
    pub period: u64,
    pub genesis_time: u64,
    pub hash: String,
    #[serde(rename = "schemeID", default)]
    pub scheme_id: String,
}

/// `GET /{chainHash}/public/{round}`
#[derive(Debug, Clone, Deserialize)]
pub struct DrandRound {
    pub round: u64,
    pub randomness: String,
    /// Hex BLS signature — the IBE decryption key for this round.
    pub signature: String,
}

pub fn info_url(base: &str, chain_hash: &str) -> String {
    format!("{}/{}/info", base.trim_end_matches('/'), chain_hash)
}
pub fn round_url(base: &str, chain_hash: &str, round: u64) -> String {
    format!(
        "{}/{}/public/{}",
        base.trim_end_matches('/'),
        chain_hash,
        round
    )
}
pub fn latest_url(base: &str, chain_hash: &str) -> String {
    format!(
        "{}/{}/public/latest",
        base.trim_end_matches('/'),
        chain_hash
    )
}

pub fn parse_info(json: &str) -> Result<DrandInfo, serde_json::Error> {
    serde_json::from_str(json)
}
pub fn parse_round(json: &str) -> Result<DrandRound, serde_json::Error> {
    serde_json::from_str(json)
}

/// The drand round whose publication time is >= `unix_time` — i.e. the round to seal
/// predictions to so they open at (or just after) match end (`timelock_target`).
pub fn round_at(genesis_time: u64, period: u64, unix_time: u64) -> u64 {
    if period == 0 || unix_time <= genesis_time {
        return 1;
    }
    (unix_time - genesis_time + period - 1) / period + 1
}

impl DrandRound {
    /// Map a fetched round to the time-lock [`RoundKey`]. The signature bytes are the
    /// IBE decryption key for `round`.
    pub fn to_round_key(&self) -> Option<RoundKey> {
        Some(RoundKey {
            round: self.round,
            key: hex_to_bytes(&self.signature)?,
        })
    }
}

#[derive(Debug)]
pub enum BeaconError {
    Http(String),
    Parse(String),
}

/// Fetch chain info and rounds from a drand beacon. Real impl behind `net`; tests inject
/// a recorded-response client.
pub trait BeaconClient {
    fn info(&self) -> Result<DrandInfo, BeaconError>;
    fn round(&self, round: u64) -> Result<DrandRound, BeaconError>;
}

#[cfg(feature = "net")]
pub struct HttpBeaconClient {
    pub base: String,
    pub chain_hash: String,
    pub timeout_ms: u64,
}

#[cfg(feature = "net")]
impl HttpBeaconClient {
    pub fn new(base: impl Into<String>, chain_hash: impl Into<String>) -> Self {
        Self {
            base: base.into(),
            chain_hash: chain_hash.into(),
            timeout_ms: 5_000,
        }
    }
    pub fn with_timeout_ms(mut self, timeout_ms: u64) -> Self {
        self.timeout_ms = timeout_ms;
        self
    }
    /// drand "quicknet" (fast, unchained) — the chain used for time-lock encryption.
    pub fn mainnet_quicknet() -> Self {
        Self::new(
            "https://api.drand.sh",
            "52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971",
        )
    }
}

#[cfg(feature = "net")]
impl BeaconClient for HttpBeaconClient {
    fn info(&self) -> Result<DrandInfo, BeaconError> {
        let url = info_url(&self.base, &self.chain_hash);
        let body = ureq::get(&url)
            .timeout(std::time::Duration::from_millis(self.timeout_ms))
            .call()
            .map_err(|e| BeaconError::Http(e.to_string()))?
            .into_string()
            .map_err(|e| BeaconError::Http(e.to_string()))?;
        parse_info(&body).map_err(|e| BeaconError::Parse(e.to_string()))
    }
    fn round(&self, round: u64) -> Result<DrandRound, BeaconError> {
        let url = round_url(&self.base, &self.chain_hash, round);
        let body = ureq::get(&url)
            .timeout(std::time::Duration::from_millis(self.timeout_ms))
            .call()
            .map_err(|e| BeaconError::Http(e.to_string()))?
            .into_string()
            .map_err(|e| BeaconError::Http(e.to_string()))?;
        parse_round(&body).map_err(|e| BeaconError::Parse(e.to_string()))
    }
}

pub fn hex_to_bytes(s: &str) -> Option<Vec<u8>> {
    let s = s.strip_prefix("0x").unwrap_or(s);
    if s.len() % 2 != 0 {
        return None;
    }
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).ok())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    // Recorded drand quicknet `/info` shape (signature/key hex shortened for the test).
    const INFO_JSON: &str = r#"{
        "public_key": "83cf0f2896adee7eb8b5f01fcad3912212c437e0073e911fb90022d3e760183c8c4b450b6a0a6c3ac6a5776a2d1064510d1fec758c921cc22b0e17e63aaf4bcb5ed66304de9cf809bad274b9d62b1aaa1a36dac7e8fb6b1d6f5e0c9b3a1b2c3d",
        "period": 3,
        "genesis_time": 1692803367,
        "hash": "52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971",
        "schemeID": "bls-unchained-g1-rfc9380"
    }"#;

    const ROUND_JSON: &str = r#"{
        "round": 1000,
        "randomness": "aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899",
        "signature": "b1c2d3e4f50617283940a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f6"
    }"#;

    #[test]
    fn parses_info_and_builds_urls() {
        let info = parse_info(INFO_JSON).unwrap();
        assert_eq!(info.period, 3);
        assert_eq!(info.scheme_id, "bls-unchained-g1-rfc9380");
        assert_eq!(
            info_url("https://api.drand.sh/", &info.hash),
            format!("https://api.drand.sh/{}/info", info.hash)
        );
        assert_eq!(
            round_url("https://api.drand.sh", &info.hash, 1000),
            format!("https://api.drand.sh/{}/public/1000", info.hash)
        );
    }

    #[test]
    fn parses_round_and_maps_to_round_key() {
        let r = parse_round(ROUND_JSON).unwrap();
        assert_eq!(r.round, 1000);
        let key = r.to_round_key().unwrap();
        assert_eq!(key.round, 1000);
        // 64 hex chars → 32 bytes (the signature → IBE key bytes).
        assert_eq!(key.key.len(), 32);
    }

    #[test]
    fn round_at_maps_match_end_to_a_round() {
        // genesis 1000, period 3s; a match ending at t=1060 → round (60/3)+1 = 21.
        assert_eq!(round_at(1000, 3, 1060), 21);
        // before genesis clamps to round 1.
        assert_eq!(round_at(1000, 3, 500), 1);
    }
}
