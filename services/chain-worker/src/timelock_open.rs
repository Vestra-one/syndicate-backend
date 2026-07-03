//! Timelock (drand) round-key opening with grace polling — adapted from
//! `services/worker/src/timelock_open.rs` for the chain-worker.
//!
//! Differences from the v1 worker copy:
//! - The drand client is constructed lazily per open, so a beacon outage at boot does not
//!   crash-loop the daemon; construction failure maps to `Pending` inside the grace
//!   window and `UnavailableAfterGrace` past it (→ VOID path).
//! - No NATS metrics plumbing.

use syndicate_timelock::beacon::{
    hex_to_bytes, round_at, BeaconClient, BeaconError, DrandInfo, HttpBeaconClient,
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

pub trait TimelockOpenClient: Send {
    fn open(&mut self, request: &TimelockOpenRequest) -> TimelockOpenStatus;
}

/// On-chain permissionless-void grace for a stuck LIVE match, measured from
/// `scheduled_end_ts` (mirrors `syndicate_program::SETTLE_VOID_GRACE_SEC`). The off-chain
/// timelock grace must never be shorter, or the worker could route to VOID before the
/// chain's permissionless void becomes callable.
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
            // Clamp any override UP to the on-chain grace so an off-chain VOID can never
            // beat the chain's permissionless void.
            grace_sec: env_u64("TIMELOCK_GRACE_SEC", ONCHAIN_SETTLE_VOID_GRACE_SEC)
                .max(ONCHAIN_SETTLE_VOID_GRACE_SEC),
            timeout_ms: env_u64("TIMELOCK_HTTP_TIMEOUT_MS", 5_000),
        }
    }
}

/// Lazily-connecting drand open client. Info + round fetch happen per `open` call (two
/// HTTP GETs — negligible at v2 scale, and it self-heals across beacon outages).
#[derive(Clone, Debug)]
pub struct DrandTimelockOpenClient {
    config: DrandTimelockConfig,
}

impl DrandTimelockOpenClient {
    pub fn new(config: DrandTimelockConfig) -> Self {
        Self { config }
    }

    pub fn config(&self) -> &DrandTimelockConfig {
        &self.config
    }

    fn beacon(&self) -> HttpBeaconClient {
        HttpBeaconClient::new(&self.config.api, &self.config.chain_hash)
            .with_timeout_ms(self.config.timeout_ms)
    }

    fn validate_info(&self, info: &DrandInfo) -> Result<(Vec<u8>, Vec<u8>), String> {
        if info.hash != self.config.chain_hash {
            return Err(format!(
                "drand chain hash mismatch: configured={} info={}",
                self.config.chain_hash, info.hash
            ));
        }
        if info.scheme_id != self.config.expected_scheme_id {
            return Err(format!(
                "drand scheme mismatch: expected={} info={}",
                self.config.expected_scheme_id, info.scheme_id
            ));
        }
        if info.period == 0 || info.genesis_time == 0 {
            return Err("drand period/genesis_time must be non-zero".into());
        }
        let chain_hash_bytes = hex_to_bytes(&info.hash)
            .ok_or_else(|| "drand chain hash is not valid hex".to_string())?;
        let public_key_bytes = hex_to_bytes(&info.public_key)
            .ok_or_else(|| "drand public key is not valid hex".to_string())?;
        if chain_hash_bytes.is_empty() || public_key_bytes.is_empty() {
            return Err("drand chain hash/public key must be non-empty".into());
        }
        Ok((chain_hash_bytes, public_key_bytes))
    }

    fn pending_or_expired(
        &self,
        request: &TimelockOpenRequest,
        reason: String,
    ) -> TimelockOpenStatus {
        if request.now_ts
            < request
                .scheduled_end_ts
                .saturating_add(self.config.grace_sec)
        {
            TimelockOpenStatus::Pending {
                retry_after_ms: 2_000,
                reason,
            }
        } else {
            TimelockOpenStatus::UnavailableAfterGrace { reason }
        }
    }
}

impl TimelockOpenClient for DrandTimelockOpenClient {
    fn open(&mut self, request: &TimelockOpenRequest) -> TimelockOpenStatus {
        let beacon = self.beacon();
        let info = match beacon.info() {
            Ok(info) => info,
            Err(e) => return self.pending_or_expired(request, format!("drand info: {e:?}")),
        };
        let (chain_hash_bytes, public_key_bytes) = match self.validate_info(&info) {
            Ok(v) => v,
            // A malformed/mismatched beacon is a configuration fault, not a transient
            // outage — surfacing Invalid routes settlement to the capital-safe VOID.
            Err(reason) => return TimelockOpenStatus::Invalid { reason },
        };
        let round = match beacon.round(request.target_round) {
            Ok(round) => round,
            Err(e) => {
                let reason = format!("drand round {} unavailable: {e:?}", request.target_round);
                return match e {
                    BeaconError::Http(_) => self.pending_or_expired(request, reason),
                    BeaconError::Parse(_) => self.pending_or_expired(request, reason),
                };
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
        let Some(round_key) = round.to_round_key() else {
            return TimelockOpenStatus::Invalid {
                reason: "drand round signature is not valid hex".into(),
            };
        };
        let signature_hash = Some(sha256_hex(&round.signature));
        TimelockOpenStatus::Available(TimelockOpenMaterial {
            scheme: OpenedTimelockScheme::Drand(DrandTlockScheme::new(
                chain_hash_bytes,
                public_key_bytes,
            )),
            round_key,
            receipt: TimelockOpenReceipt {
                drand_api: self.config.api.clone(),
                chain_hash: self.config.chain_hash.clone(),
                scheme_id: info.scheme_id,
                target_round: request.target_round,
                signature_hash,
            },
        })
    }
}

#[derive(Clone)]
pub enum TimelockOpenBackend {
    Drand(DrandTimelockOpenClient),
    Mock(LocalMockTimelockOpenClient),
}

impl TimelockOpenBackend {
    pub fn from_env() -> Self {
        if matches!(
            std::env::var("TIMELOCK_OPEN_MODE").as_deref(),
            Ok("mock") | Ok("local")
        ) {
            return TimelockOpenBackend::Mock(LocalMockTimelockOpenClient);
        }
        TimelockOpenBackend::Drand(DrandTimelockOpenClient::new(DrandTimelockConfig::from_env()))
    }
}

impl TimelockOpenClient for TimelockOpenBackend {
    fn open(&mut self, request: &TimelockOpenRequest) -> TimelockOpenStatus {
        match self {
            Self::Drand(client) => client.open(request),
            Self::Mock(client) => client.open(request),
        }
    }
}

/// Deterministic mock (local dev / integration tests without a beacon).
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

/// The drand round covering `unix_time` on quicknet parameters (used as a fallback when
/// neither the match row nor the seats carry a timelock target).
pub fn quicknet_round_at(unix_time: u64) -> u64 {
    round_at(
        syndicate_chain::DRAND_GENESIS_TIME,
        syndicate_chain::DRAND_PERIOD_SEC,
        unix_time,
    )
}

fn sha256_hex(value: &str) -> String {
    use sha2::{Digest, Sha256};
    hex::encode(Sha256::digest(value.as_bytes()))
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

    #[test]
    fn mock_open_returns_matching_round_key() {
        let mut client = LocalMockTimelockOpenClient;
        match client.open(&TimelockOpenRequest {
            target_round: 42,
            scheduled_end_ts: 1_000,
            now_ts: 1_000,
        }) {
            TimelockOpenStatus::Available(material) => {
                assert_eq!(material.round_key.round, 42);
                assert_eq!(material.receipt.scheme_id, "mock");
            }
            _ => panic!("expected available"),
        }
    }

    #[test]
    fn grace_clamps_up_to_onchain_void_grace() {
        std::env::remove_var("TIMELOCK_GRACE_SEC");
        let cfg = DrandTimelockConfig::from_env();
        assert!(cfg.grace_sec >= ONCHAIN_SETTLE_VOID_GRACE_SEC);
    }
}
