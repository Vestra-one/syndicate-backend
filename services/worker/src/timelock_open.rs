//! Worker-facing timelock opening.
//!
//! Production uses drand quicknet + tlock. Local/demo tests use the deterministic
//! mock scheme, but the reconstruction path talks to both through this module.

use std::time::{SystemTime, UNIX_EPOCH};

use syndicate_timelock::beacon::{
    hex_to_bytes, BeaconClient, BeaconError, DrandInfo, HttpBeaconClient,
};
use syndicate_timelock::{DrandTlockScheme, MockScheme, RoundKey, TimelockScheme};

#[derive(Clone, Debug)]
pub struct TimelockOpenRequest {
    pub target_round: u64,
    pub scheduled_end_ts: u64,
    pub now_ts: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TimelockOpenReceipt {
    pub drand_api: String,
    pub chain_hash: String,
    pub scheme_id: String,
    pub target_round: u64,
    pub signature_hash: Option<String>,
}

pub struct TimelockOpenMaterial {
    pub scheme: OpenedTimelockScheme,
    pub round_key: RoundKey,
    pub receipt: TimelockOpenReceipt,
}

pub enum OpenedTimelockScheme {
    Mock(MockScheme),
    Drand(DrandTlockScheme),
}

impl TimelockScheme for OpenedTimelockScheme {
    fn encrypt(&self, price: syndicate_shared::Price, target_round: u64) -> Vec<u8> {
        match self {
            OpenedTimelockScheme::Mock(s) => s.encrypt(price, target_round),
            OpenedTimelockScheme::Drand(s) => s.encrypt(price, target_round),
        }
    }

    fn decrypt(&self, ciphertext: &[u8], key: &RoundKey) -> Option<syndicate_shared::Price> {
        match self {
            OpenedTimelockScheme::Mock(s) => s.decrypt(ciphertext, key),
            OpenedTimelockScheme::Drand(s) => s.decrypt(ciphertext, key),
        }
    }
}

pub enum TimelockOpenStatus {
    Available(TimelockOpenMaterial),
    Pending { retry_after_ms: u64, reason: String },
    UnavailableAfterGrace { reason: String },
    Invalid { reason: String },
}

pub trait TimelockOpenClient {
    fn open(&mut self, request: &TimelockOpenRequest) -> TimelockOpenStatus;
}

/// On-chain permissionless-void grace for a stuck LIVE match, measured from
/// `scheduled_end_ts`. Mirrors `syndicate_program::SETTLE_VOID_GRACE_SEC` (300s).
/// The off-chain timelock grace must never be shorter than this, or the worker
/// could declare `UnavailableAfterGrace` (and VOID) before the chain's
/// permissionless void becomes callable — racing on-chain state. Kept in sync
/// with the contract constant; both are post-`scheduled_end_ts` settle-side graces.
pub const ONCHAIN_SETTLE_VOID_GRACE_SEC: u64 = 300;

#[derive(Clone, Debug)]
pub struct DrandTimelockConfig {
    pub api: String,
    pub chain_hash: String,
    pub expected_scheme_id: String,
    pub grace_sec: u64,
    pub timeout_ms: u64,
}

impl DrandTimelockConfig {
    pub fn from_env() -> Self {
        Self {
            api: std::env::var("DRAND_API").unwrap_or_else(|_| "https://api.drand.sh".into()),
            chain_hash: std::env::var("DRAND_CHAIN_HASH").unwrap_or_else(|_| {
                "52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971".into()
            }),
            expected_scheme_id: std::env::var("DRAND_EXPECTED_SCHEME_ID")
                .unwrap_or_else(|_| "bls-unchained-g1-rfc9380".into()),
            // Default to the on-chain settle-side void grace; a TIMELOCK_GRACE_SEC
            // override is clamped up so the off-chain VOID can never beat the chain.
            grace_sec: env_u64("TIMELOCK_GRACE_SEC", ONCHAIN_SETTLE_VOID_GRACE_SEC)
                .max(ONCHAIN_SETTLE_VOID_GRACE_SEC),
            timeout_ms: env_u64("TIMELOCK_HTTP_TIMEOUT_MS", 5_000),
        }
    }
}

#[derive(Clone, Debug)]
pub struct DrandTimelockOpenClient {
    config: DrandTimelockConfig,
    info: DrandInfo,
    chain_hash_bytes: Vec<u8>,
    public_key_bytes: Vec<u8>,
}

impl DrandTimelockOpenClient {
    pub fn from_env() -> Result<Self, String> {
        Self::new(DrandTimelockConfig::from_env())
    }

    pub fn new(config: DrandTimelockConfig) -> Result<Self, String> {
        let beacon = HttpBeaconClient::new(&config.api, &config.chain_hash)
            .with_timeout_ms(config.timeout_ms);
        let info = beacon
            .info()
            .map_err(|e| format!("fetch drand info failed: {e:?}"))?;
        Self::from_info(config, info)
    }

    pub fn from_info(config: DrandTimelockConfig, info: DrandInfo) -> Result<Self, String> {
        if info.hash != config.chain_hash {
            return Err(format!(
                "drand chain hash mismatch: configured={} info={}",
                config.chain_hash, info.hash
            ));
        }
        if info.scheme_id != config.expected_scheme_id {
            return Err(format!(
                "drand scheme mismatch: expected={} info={}",
                config.expected_scheme_id, info.scheme_id
            ));
        }
        if info.period == 0 {
            return Err("drand period must be non-zero".into());
        }
        if info.genesis_time == 0 {
            return Err("drand genesis_time must be non-zero".into());
        }
        let chain_hash_bytes = hex_to_bytes(&info.hash)
            .ok_or_else(|| "drand chain hash is not valid hex".to_string())?;
        let public_key_bytes = hex_to_bytes(&info.public_key)
            .ok_or_else(|| "drand public key is not valid hex".to_string())?;
        if chain_hash_bytes.is_empty() || public_key_bytes.is_empty() {
            return Err("drand chain hash/public key must be non-empty".into());
        }
        Ok(Self {
            config,
            info,
            chain_hash_bytes,
            public_key_bytes,
        })
    }

    pub fn info(&self) -> &DrandInfo {
        &self.info
    }

    fn beacon(&self) -> HttpBeaconClient {
        HttpBeaconClient::new(&self.config.api, &self.config.chain_hash)
            .with_timeout_ms(self.config.timeout_ms)
    }
}

impl TimelockOpenClient for DrandTimelockOpenClient {
    fn open(&mut self, request: &TimelockOpenRequest) -> TimelockOpenStatus {
        let beacon = self.beacon();
        let round = match beacon.round(request.target_round) {
            Ok(round) => round,
            Err(e) => {
                let reason = format!("drand round {} unavailable: {e:?}", request.target_round);
                if request.now_ts
                    < request
                        .scheduled_end_ts
                        .saturating_add(self.config.grace_sec)
                {
                    return TimelockOpenStatus::Pending {
                        retry_after_ms: retry_after_ms(&e),
                        reason,
                    };
                }
                return TimelockOpenStatus::UnavailableAfterGrace { reason };
            }
        };
        if round.round != request.target_round {
            return TimelockOpenStatus::Invalid {
                reason: format!(
                    "drand returned round {} for requested {}",
                    round.round, request.target_round
                ),
            };
        }
        let round_key = match round.to_round_key() {
            Some(key) => key,
            None => {
                return TimelockOpenStatus::Invalid {
                    reason: "drand round signature is not valid hex".into(),
                }
            }
        };
        let signature_hash = Some(sha256_hex(&round.signature));
        TimelockOpenStatus::Available(TimelockOpenMaterial {
            scheme: OpenedTimelockScheme::Drand(DrandTlockScheme::new(
                self.chain_hash_bytes.clone(),
                self.public_key_bytes.clone(),
            )),
            round_key,
            receipt: TimelockOpenReceipt {
                drand_api: self.config.api.clone(),
                chain_hash: self.config.chain_hash.clone(),
                scheme_id: self.info.scheme_id.clone(),
                target_round: request.target_round,
                signature_hash,
            },
        })
    }
}

#[derive(Clone, Debug, Default)]
pub struct LocalMockTimelockOpenClient;

impl TimelockOpenClient for LocalMockTimelockOpenClient {
    fn open(&mut self, request: &TimelockOpenRequest) -> TimelockOpenStatus {
        TimelockOpenStatus::Available(TimelockOpenMaterial {
            scheme: OpenedTimelockScheme::Mock(MockScheme),
            round_key: RoundKey {
                round: request.target_round,
                key: vec![1],
            },
            receipt: TimelockOpenReceipt {
                drand_api: "mock".into(),
                chain_hash: "mock".into(),
                scheme_id: "mock".into(),
                target_round: request.target_round,
                signature_hash: None,
            },
        })
    }
}

pub fn now_ts() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system clock before unix epoch")
        .as_secs()
}

fn retry_after_ms(err: &BeaconError) -> u64 {
    match err {
        BeaconError::Http(_) => 1_000,
        BeaconError::Parse(_) => 5_000,
    }
}

fn sha256_hex(value: &str) -> String {
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(value.as_bytes());
    let mut out = String::with_capacity(64);
    for b in digest {
        out.push_str(&format!("{b:02x}"));
    }
    out
}

fn env_u64(name: &str, fallback: u64) -> u64 {
    std::env::var(name)
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(fallback)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config() -> DrandTimelockConfig {
        DrandTimelockConfig {
            api: "https://api.drand.sh".into(),
            chain_hash: "52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971".into(),
            expected_scheme_id: "bls-unchained-g1-rfc9380".into(),
            grace_sec: ONCHAIN_SETTLE_VOID_GRACE_SEC,
            timeout_ms: 5_000,
        }
    }

    fn info() -> DrandInfo {
        DrandInfo {
            public_key: "83cf0f2896adee7eb8b5f01fcad3912212c437e0073e911fb90022d3e760183c8c4b450b6a0a6c3ac6a5776a2d1064510d1fec758c921cc22b0e17e63aaf4bcb5ed66304de9cf809bad274b9d62b1aaa1a36dac7e8fb6b1d6f5e0c9b3a1b2c3d".into(),
            period: 3,
            genesis_time: 1_692_803_367,
            hash: "52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971".into(),
            scheme_id: "bls-unchained-g1-rfc9380".into(),
        }
    }

    #[test]
    fn validates_drand_info_shape() {
        let client = DrandTimelockOpenClient::from_info(config(), info()).unwrap();
        assert_eq!(client.info().period, 3);
    }

    #[test]
    fn rejects_wrong_drand_scheme() {
        let mut bad = info();
        bad.scheme_id = "wrong".into();
        assert!(DrandTimelockOpenClient::from_info(config(), bad)
            .unwrap_err()
            .contains("scheme mismatch"));
    }

    #[test]
    fn mock_open_returns_matching_round_key() {
        let mut client = LocalMockTimelockOpenClient;
        let opened = client.open(&TimelockOpenRequest {
            target_round: 42,
            scheduled_end_ts: 1_000,
            now_ts: 1_000,
        });
        match opened {
            TimelockOpenStatus::Available(material) => {
                assert_eq!(material.round_key.round, 42);
                assert_eq!(material.receipt.scheme_id, "mock");
            }
            _ => panic!("expected available"),
        }
    }
}
