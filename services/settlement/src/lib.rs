//! # syndicate-settlement — the convergence point (Phase 6)
//!
//! Orchestrates a finished match into either a verified on-chain submission or a VOID:
//! it collects the engine's contributions, finalizes `S` from the oracle window (guards
//! → VOID), auto-decrypts predictions via the time-lock (missing key → VOID), merges
//! them, computes the outcome with **`syndicate-shared`** (the single core), and packages
//! the **submission bundle** the on-chain program re-verifies with that same crate.
//!
//! It performs **no outcome math of its own** and **fails to VOID, never to a guess**
//! (`ARCHITECTURE.md §4`, `04_GAME_MECHANICS §11, §12, §17, §18`). The remaining glue —
//! actually submitting/ confirming the Solana tx, idempotent retry — is the network
//! layer on top of this pure orchestration.

use syndicate_engine::Engine;
use syndicate_oracle::WindowSampler;
use syndicate_shared::{settle, verify_settlement, Chips, CoreError, PlayerState, Price, SettleInput, SettleResult};
use syndicate_timelock::{RoundKey, SealRegistry, TimelockScheme};

/// Tunable settlement parameters (sourced from `config`; `08 OQ1, OQ11`).
#[derive(Clone, Copy, Debug)]
pub struct SettleParams {
    pub rake_bps: u32,
    pub rake_cap: Chips,
    pub min_samples: usize,
    pub window_start: u64,
    pub window_end: u64,
}

/// Why a match voided instead of settling — every one maps to a full, capital-safe
/// refund on-chain (`04 §17`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum VoidReason {
    EngineIncomplete,
    OracleDegraded,
    TimelockUnavailable,
    MissingPrediction,
    ConservationFailure,
}

/// What gets submitted on-chain. The program rebuilds `SettleInput` from
/// `(players, samples, params)` and calls `verify_settlement(input, result)` — accepting
/// the payout only if it re-derives the identical `result`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SettlementBundle {
    pub players: Vec<PlayerState>,
    pub samples: Vec<Price>,
    pub min_samples: usize,
    pub rake_bps: u32,
    pub rake_cap: Chips,
    pub settlement_price: Price,
    pub result: SettleResult,
}

impl SettlementBundle {
    /// Re-verify exactly as the chain will (independent recompute + exact match).
    pub fn verify(&self) -> bool {
        let input = SettleInput {
            players: &self.players,
            settlement_samples: &self.samples,
            min_samples: self.min_samples,
            rake_bps: self.rake_bps,
            rake_cap: self.rake_cap,
        };
        verify_settlement(&input, &self.result).is_ok()
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Outcome {
    Settled(SettlementBundle),
    Void(VoidReason),
}

/// Orchestrate settlement from the live components. Pure and deterministic: identical
/// inputs always yield the identical `Outcome` (idempotency at the logic layer; on-chain
/// submission is idempotent separately).
pub fn settle_match<S: TimelockScheme>(
    engine: &Engine,
    sampler: &WindowSampler,
    seal_registry: &SealRegistry,
    scheme: &S,
    round_key: Option<&RoundKey>,
    params: &SettleParams,
) -> Outcome {
    // 1. The match must actually be finished.
    if !engine.is_complete() {
        return Outcome::Void(VoidReason::EngineIncomplete);
    }

    // 2. Oracle: guard-passing samples in the settlement window (else VOID, 04 §11).
    let samples = sampler.samples_in_window(params.window_start, params.window_end);
    if samples.len() < params.min_samples {
        return Outcome::Void(VoidReason::OracleDegraded);
    }

    // 3. Time-lock: auto-decrypt all sealed predictions at match end (else VOID, 04 §12).
    let predictions = match seal_registry.decrypt_all(scheme, round_key) {
        Ok(m) => m,
        Err(_) => return Outcome::Void(VoidReason::TimelockUnavailable),
    };

    // 4. Merge predictions into the engine's contributions (engine never held them).
    let players = engine.to_player_states(|id| predictions.get(&id).copied());

    // 5. Compute with the single core; self-verify exactly as the chain will.
    let result = {
        let input = SettleInput {
            players: &players,
            settlement_samples: &samples,
            min_samples: params.min_samples,
            rake_bps: params.rake_bps,
            rake_cap: params.rake_cap,
        };
        match settle(&input) {
            Ok(r) => {
                debug_assert!(verify_settlement(&input, &r).is_ok(), "self-verify must pass");
                r
            }
            Err(e) => return Outcome::Void(map_core_error(e)),
        }
    };

    Outcome::Settled(SettlementBundle {
        players,
        samples,
        min_samples: params.min_samples,
        rake_bps: params.rake_bps,
        rake_cap: params.rake_cap,
        settlement_price: result.settlement_price,
        result,
    })
}

fn map_core_error(e: CoreError) -> VoidReason {
    match e {
        CoreError::InsufficientOracleSamples => VoidReason::OracleDegraded,
        CoreError::MissingPrediction => VoidReason::MissingPrediction,
        CoreError::ConservationViolation | CoreError::SettlementMismatch => VoidReason::ConservationFailure,
    }
}

/// Thin delegation kept for callers that already hold a `SettleInput` (e.g. replay).
pub fn build_settlement(input: &SettleInput) -> Result<SettleResult, CoreError> {
    settle(input)
}

// ---- On-chain submission seam ----

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SubmitReceipt {
    pub tx_sig: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SubmitError {
    Rpc(String),
    SelfVerifyFailed,
}

/// Submits a verified settlement bundle to the on-chain program. The production impl is
/// a Solana RPC client (feature-gated) that builds the `submit_settlement` instruction
/// from the bundle and confirms it; submission must be **idempotent** (the program
/// rejects double-settlement). Tests use [`MockSubmitter`].
pub trait ChainSubmitter {
    fn submit(&mut self, bundle: &SettlementBundle) -> Result<SubmitReceipt, SubmitError>;
}

/// In-memory, idempotent submitter for tests/sims.
#[derive(Default)]
pub struct MockSubmitter {
    seen: std::collections::HashMap<String, SubmitReceipt>,
    n: u64,
}

impl MockSubmitter {
    pub fn new() -> Self {
        Self::default()
    }
    fn key(b: &SettlementBundle) -> String {
        format!("{}|{:?}|{:?}|{}", b.settlement_price, b.result.pot_awards, b.result.uncalled_returns, b.result.rake_collected)
    }
    pub fn submitted(&self) -> usize {
        self.seen.len()
    }
}

impl ChainSubmitter for MockSubmitter {
    fn submit(&mut self, bundle: &SettlementBundle) -> Result<SubmitReceipt, SubmitError> {
        // Mirror the chain's check: never submit a bundle that wouldn't verify.
        if !bundle.verify() {
            return Err(SubmitError::SelfVerifyFailed);
        }
        let k = Self::key(bundle);
        if let Some(r) = self.seen.get(&k) {
            return Ok(r.clone()); // idempotent: already submitted
        }
        self.n += 1;
        let receipt = SubmitReceipt { tx_sig: format!("mocktx-{}", self.n) };
        self.seen.insert(k, receipt.clone());
        Ok(receipt)
    }
}

/// Result of applying an [`Outcome`]: a settled tx receipt, or a refund (VOID).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Applied {
    Settled(SubmitReceipt),
    Refunded(VoidReason),
}

/// Apply an outcome: submit the settlement on-chain, or route to the refund/VOID path
/// (which the program's `void`/`refund` instructions execute).
pub fn finalize<S: ChainSubmitter>(outcome: Outcome, submitter: &mut S) -> Result<Applied, SubmitError> {
    match outcome {
        Outcome::Settled(b) => Ok(Applied::Settled(submitter.submit(&b)?)),
        Outcome::Void(r) => Ok(Applied::Refunded(r)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use syndicate_engine::{Action, Engine};
    use syndicate_oracle::{Guards, Sample, WindowSampler};
    use syndicate_shared::PlayerId;
    use syndicate_timelock::{MockScheme, RoundKey, SealRegistry, TimelockScheme};

    const ROUND: u64 = 42;

    fn limped_three_handed() -> Engine {
        let mut e = Engine::new(
            vec![(PlayerId(0), 100, 0), (PlayerId(1), 100, 1), (PlayerId(2), 100, 2)],
            0,
            1,
            2,
            3,
        );
        e.apply(0, Action::Call).unwrap();
        e.apply(1, Action::Call).unwrap();
        e.apply(2, Action::Check).unwrap();
        for _ in 0..2 {
            e.apply(1, Action::Check).unwrap();
            e.apply(2, Action::Check).unwrap();
            e.apply(0, Action::Check).unwrap();
        }
        assert!(e.is_complete());
        e
    }

    fn good_sampler() -> WindowSampler {
        let mut s = WindowSampler::new(Guards { max_confidence: 100, max_staleness: 5, min_samples: 3 });
        for ts in 0..5 {
            s.record(Sample { ts, price: 100_000, confidence: 10, publish_ts: ts });
        }
        s
    }

    fn sealed_registry(scheme: &MockScheme) -> SealRegistry {
        let mut reg = SealRegistry::new(ROUND);
        reg.seal(PlayerId(0), scheme.encrypt(100_010, ROUND)).unwrap(); // closest (dist 10)
        reg.seal(PlayerId(1), scheme.encrypt(99_000, ROUND)).unwrap();
        reg.seal(PlayerId(2), scheme.encrypt(100_500, ROUND)).unwrap();
        reg.lock();
        reg
    }

    fn params() -> SettleParams {
        SettleParams { rake_bps: 0, rake_cap: 0, min_samples: 3, window_start: 0, window_end: 5 }
    }

    #[test]
    fn happy_path_settles_and_bundle_self_verifies() {
        let engine = limped_three_handed();
        let sampler = good_sampler();
        let scheme = MockScheme;
        let reg = sealed_registry(&scheme);
        let key = RoundKey { round: ROUND, key: vec![1] };

        match settle_match(&engine, &sampler, &reg, &scheme, Some(&key), &params()) {
            Outcome::Settled(bundle) => {
                assert_eq!(bundle.settlement_price, 100_000);
                // Each contributed 2 → pot 6, seat 0 closest → wins all 6.
                assert_eq!(bundle.result.pot_awards, vec![syndicate_shared::Award { player: PlayerId(0), amount: 6 }]);
                // The chain would accept it.
                assert!(bundle.verify());
            }
            other => panic!("expected Settled, got {other:?}"),
        }
    }

    #[test]
    fn oracle_degraded_voids() {
        let engine = limped_three_handed();
        let empty = WindowSampler::new(Guards { max_confidence: 100, max_staleness: 5, min_samples: 3 });
        let scheme = MockScheme;
        let reg = sealed_registry(&scheme);
        let key = RoundKey { round: ROUND, key: vec![1] };
        assert_eq!(
            settle_match(&engine, &empty, &reg, &scheme, Some(&key), &params()),
            Outcome::Void(VoidReason::OracleDegraded)
        );
    }

    #[test]
    fn missing_timelock_key_voids() {
        let engine = limped_three_handed();
        let sampler = good_sampler();
        let scheme = MockScheme;
        let reg = sealed_registry(&scheme);
        assert_eq!(
            settle_match(&engine, &sampler, &reg, &scheme, None, &params()),
            Outcome::Void(VoidReason::TimelockUnavailable)
        );
    }

    #[test]
    fn incomplete_engine_voids() {
        // Fresh engine (still Live) must not settle.
        let engine = Engine::new(vec![(PlayerId(0), 100, 0), (PlayerId(1), 100, 1)], 0, 1, 2, 3);
        let sampler = good_sampler();
        let scheme = MockScheme;
        let mut reg = SealRegistry::new(ROUND);
        reg.seal(PlayerId(0), scheme.encrypt(1, ROUND)).unwrap();
        reg.seal(PlayerId(1), scheme.encrypt(2, ROUND)).unwrap();
        reg.lock();
        let key = RoundKey { round: ROUND, key: vec![1] };
        assert_eq!(
            settle_match(&engine, &sampler, &reg, &scheme, Some(&key), &params()),
            Outcome::Void(VoidReason::EngineIncomplete)
        );
    }

    #[test]
    fn idempotent_same_inputs_same_outcome() {
        let engine = limped_three_handed();
        let sampler = good_sampler();
        let scheme = MockScheme;
        let reg = sealed_registry(&scheme);
        let key = RoundKey { round: ROUND, key: vec![1] };
        let a = settle_match(&engine, &sampler, &reg, &scheme, Some(&key), &params());
        let b = settle_match(&engine, &sampler, &reg, &scheme, Some(&key), &params());
        assert_eq!(a, b);
    }

    #[test]
    fn finalize_submits_settled_idempotently_and_refunds_void() {
        let engine = limped_three_handed();
        let scheme = MockScheme;
        let reg = sealed_registry(&scheme);
        let key = RoundKey { round: ROUND, key: vec![1] };
        let outcome = settle_match(&engine, &good_sampler(), &reg, &scheme, Some(&key), &params());

        let mut sub = MockSubmitter::new();
        let a = finalize(outcome.clone(), &mut sub).unwrap();
        assert!(matches!(a, Applied::Settled(_)));
        // Re-applying the same outcome must NOT double-submit (idempotent).
        let b = finalize(outcome, &mut sub).unwrap();
        assert_eq!(a, b);
        assert_eq!(sub.submitted(), 1);

        // A VOID outcome routes to refund, never an on-chain submit.
        let v = finalize(Outcome::Void(VoidReason::OracleDegraded), &mut sub).unwrap();
        assert_eq!(v, Applied::Refunded(VoidReason::OracleDegraded));
        assert_eq!(sub.submitted(), 1);
    }
}
