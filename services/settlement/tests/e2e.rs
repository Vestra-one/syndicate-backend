//! Phase 9 — end-to-end integration + off-chain↔on-chain **parity** proof.
//!
//! Drives a full match through every off-chain core — match-engine → oracle-adapter →
//! time-lock → settlement — and asserts:
//!   1. the resulting `SettlementBundle` **self-verifies** (`bundle.verify()` runs the
//!      exact `syndicate_shared::verify_settlement` the on-chain program links, so the
//!      chain would accept it), and a **tampered** bundle is rejected (chain rejects);
//!   2. every fault routes to a typed VOID (full refund), never a payout;
//!   3. settlement is **deterministic / replayable** (identical inputs → identical bytes).
//!
//! The contested-showdown vector here is the cross-implementation golden (see
//! `golden/showdown_3handed.json`): the Anchor program's litesvm test must reproduce the
//! same awards from the same inputs — that equality IS the parity guarantee (`04 §18`).

use syndicate_engine::{Action, Engine};
use syndicate_oracle::{Guards, Sample, WindowSampler};
use syndicate_settlement::{settle_match, Outcome, SettleParams, VoidReason};
use syndicate_shared::{Award, PlayerId};
use syndicate_timelock::{MockScheme, RoundKey, SealRegistry, TimelockScheme};

const ROUND: u64 = 42;

fn params() -> SettleParams {
    SettleParams { rake_bps: 0, rake_cap: 0, min_samples: 3, window_start: 0, window_end: 5 }
}

fn good_sampler(price: i128) -> WindowSampler {
    let mut s = WindowSampler::new(Guards { max_confidence: 100, max_staleness: 5, min_samples: 3 });
    for ts in 0..5 {
        s.record(Sample { ts, price, confidence: 10, publish_ts: ts });
    }
    s
}

fn seal(scheme: &MockScheme, preds: &[(u16, i128)]) -> SealRegistry {
    let mut reg = SealRegistry::new(ROUND);
    for (id, p) in preds {
        reg.seal(PlayerId(*id), scheme.encrypt(*p, ROUND)).unwrap();
    }
    reg.lock();
    reg
}

fn key() -> RoundKey {
    RoundKey { round: ROUND, key: vec![1] }
}

/// 3-handed limped hand → showdown. Button 0 → SB 1, BB 2, UTG 0 first.
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
    e
}

#[test]
fn e2e_contested_showdown_parity_and_tamper_rejection() {
    let engine = limped_three_handed();
    let sampler = good_sampler(100_000);
    let scheme = MockScheme;
    let reg = seal(&scheme, &[(0, 100_010), (1, 99_000), (2, 100_500)]); // seat 0 closest
    let key = key();

    let outcome = settle_match(&engine, &sampler, &reg, &scheme, Some(&key), &params());
    let bundle = match outcome {
        Outcome::Settled(b) => b,
        other => panic!("expected Settled, got {other:?}"),
    };

    // GOLDEN VECTOR (parity contract with the on-chain program):
    assert_eq!(bundle.settlement_price, 100_000);
    assert_eq!(bundle.result.pot_awards, vec![Award { player: PlayerId(0), amount: 6 }]);
    assert_eq!(bundle.result.rake_collected, 0);
    assert!(bundle.result.uncalled_returns.is_empty());

    // The chain re-verifies with the SAME crate → accepts.
    assert!(bundle.verify(), "on-chain verification must accept the honest bundle");

    // Tamper the payout → the chain's re-verification must REJECT it.
    let mut tampered = bundle.clone();
    tampered.result.pot_awards[0].amount += 1;
    assert!(!tampered.verify(), "on-chain verification must reject a tampered bundle");

    // Tamper the winner identity → also rejected.
    let mut wrong_winner = bundle.clone();
    wrong_winner.result.pot_awards[0].player = PlayerId(1);
    assert!(!wrong_winner.verify());
}

#[test]
fn e2e_uncontested_fold_out() {
    // UTG folds, SB folds → BB wins uncontested.
    let mut e = limped_three_handed_fresh();
    e.apply(0, Action::Fold).unwrap();
    e.apply(1, Action::Fold).unwrap();
    let scheme = MockScheme;
    // Predictions present for the survivor; folded players need none.
    let reg = seal(&scheme, &[(2, 100_000)]);
    let outcome = settle_match(&e, &good_sampler(100_000), &reg, &scheme, Some(&key()), &params());
    match outcome {
        Outcome::Settled(b) => {
            assert!(b.verify());
            // BB (seat 2) collects; total out == total in (3 chips: SB 1 + BB 2).
            let out: u64 = b.result.pot_awards.iter().map(|a| a.amount).sum::<u64>()
                + b.result.uncalled_returns.iter().map(|(_, c)| *c).sum::<u64>();
            assert_eq!(out, 3);
            assert!(b.result.pot_awards.iter().all(|a| a.player == PlayerId(2)));
        }
        other => panic!("expected Settled, got {other:?}"),
    }
}

fn limped_three_handed_fresh() -> Engine {
    Engine::new(
        vec![(PlayerId(0), 100, 0), (PlayerId(1), 100, 1), (PlayerId(2), 100, 2)],
        0,
        1,
        2,
        3,
    )
}

#[test]
fn e2e_heads_up_all_in() {
    // button 0 → SB 0 acts first. Seat 0 all-in 40, seat 1 calls.
    let mut e = Engine::new(vec![(PlayerId(0), 40, 0), (PlayerId(1), 100, 1)], 0, 1, 2, 3);
    e.apply(0, Action::AllIn).unwrap();
    e.apply(1, Action::Call).unwrap();
    let scheme = MockScheme;
    let reg = seal(&scheme, &[(0, 100_000), (1, 100_050)]); // seat 0 closer
    let outcome = settle_match(&e, &good_sampler(100_000), &reg, &scheme, Some(&key()), &params());
    match outcome {
        Outcome::Settled(b) => {
            assert!(b.verify());
            assert_eq!(b.result.pot_awards, vec![Award { player: PlayerId(0), amount: 80 }]);
        }
        other => panic!("expected Settled, got {other:?}"),
    }
}

#[test]
fn e2e_every_void_path() {
    let scheme = MockScheme;
    let reg = seal(&scheme, &[(0, 1), (1, 2), (2, 3)]);

    // (a) incomplete engine → VOID
    let live = limped_three_handed_fresh();
    assert_eq!(
        settle_match(&live, &good_sampler(1), &reg, &scheme, Some(&key()), &params()),
        Outcome::Void(VoidReason::EngineIncomplete)
    );

    let done = limped_three_handed();

    // (b) oracle degraded (no samples) → VOID
    let empty = WindowSampler::new(Guards { max_confidence: 100, max_staleness: 5, min_samples: 3 });
    assert_eq!(
        settle_match(&done, &empty, &reg, &scheme, Some(&key()), &params()),
        Outcome::Void(VoidReason::OracleDegraded)
    );

    // (c) time-lock key unavailable → VOID
    assert_eq!(
        settle_match(&done, &good_sampler(1), &reg, &scheme, None, &params()),
        Outcome::Void(VoidReason::TimelockUnavailable)
    );

    // (d) wrong-round key (can't open) → VOID
    let wrong = RoundKey { round: ROUND + 1, key: vec![] };
    assert_eq!(
        settle_match(&done, &good_sampler(1), &reg, &scheme, Some(&wrong), &params()),
        Outcome::Void(VoidReason::TimelockUnavailable)
    );
}

#[test]
fn e2e_replay_is_deterministic() {
    let scheme = MockScheme;
    let build = || {
        let engine = limped_three_handed();
        let sampler = good_sampler(100_000);
        let reg = seal(&scheme, &[(0, 100_010), (1, 99_000), (2, 100_500)]);
        settle_match(&engine, &sampler, &reg, &scheme, Some(&key()), &params())
    };
    // Identical inputs ⇒ identical outcome (the §18 replay guarantee).
    assert_eq!(build(), build());
}
