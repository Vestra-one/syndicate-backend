//! # syndicate-chain-worker — the chain execution daemon (Phase D)
//!
//! Claims `chain_jobs` rows from Postgres (`FOR UPDATE SKIP LOCKED`, LISTEN wake-up +
//! interval poll), builds the corresponding Solana instruction via `syndicate-chain`,
//! signs with the operator keypair, simulates, submits with compute-budget instructions,
//! confirms at `confirmed` commitment, and marks the job terminal (the DB trigger NOTIFYs
//! the game-server).
//!
//! The `submit_settlement` kind runs the full v2 settlement pipeline: engine replay from
//! `match_events`, drand timelock open + ciphertext decryption, non-sealer spot-price
//! predictions, company-signed settlement price at exactly `scheduled_end_ts`, payout
//! mapping, self-verification, and conservation checks. Every failure path is
//! capital-safe: VOID (full refund via `void_live_after_deadline`) rather than a guessed
//! payout.
//!
//! Design notes / documented choices:
//! - SQL stays local to this crate (`db.rs`) rather than in `services/store` — the job
//!   queue is owned end-to-end by this daemon and the game-server enqueue side; keeping
//!   the claim/mark statements next to the state machine that drives them makes the
//!   lifecycle auditable in one file.
//! - Settlement math goes through `syndicate_shared::settle` + `verify_settlement`
//!   directly instead of `syndicate_settlement::settle_match`: the v1 orchestration binds
//!   commitments as `sha256(prediction ‖ blinding)`, while v2's on-chain commitment is
//!   `sha256(tlock_ciphertext)` (verified here after decryption) and non-sealers receive
//!   the seal-close spot price — neither fits the v1 `SealRegistry`/blinding model.
//! - The engine state is recovered by FULL hash-chained replay
//!   (`FencedMatchRuntime::replay` over `match_events`), not a snapshot fold: replay
//!   re-verifies the whole chain, which is the strongest correctness guarantee available
//!   off-chain and is cheap at v2 table sizes (≤ 5 seats, ≤ 5 streets).

pub mod config;
pub mod db;
pub mod executor;
pub mod http;
pub mod jobs;
pub mod metrics;
pub mod oracle;
pub mod payouts;
pub mod retry;
pub mod rpc;
pub mod settlement;
pub mod timelock_open;

/// Idempotency key for non-settlement job kinds: `<match_uuid>:<kind>`.
pub fn idempotency_key(match_id: &str, kind: db::JobKind) -> String {
    format!("{match_id}:{}", kind.as_str())
}

/// Idempotency key for `submit_settlement`: `<match_uuid>:submit_settlement:root-<hex>`
/// — the event root pins the exact log the payouts were derived from.
pub fn settlement_idempotency_key(match_id: &str, event_root: &[u8; 32]) -> String {
    format!(
        "{match_id}:submit_settlement:root-{}",
        hex::encode(event_root)
    )
}

pub fn now_unix() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("system clock before unix epoch")
        .as_secs()
}

pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("system clock before unix epoch")
        .as_millis() as u64
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn idempotency_key_formats() {
        assert_eq!(
            idempotency_key("11111111-2222-3333-4444-555555555555", db::JobKind::Lock),
            "11111111-2222-3333-4444-555555555555:lock"
        );
        assert_eq!(
            idempotency_key("m", db::JobKind::VoidLiveAfterDeadline),
            "m:void_live_after_deadline"
        );
        let root = [0xabu8; 32];
        assert_eq!(
            settlement_idempotency_key("m", &root),
            format!("m:submit_settlement:root-{}", "ab".repeat(32))
        );
    }
}
