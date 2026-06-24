//! Runnable end-to-end demo of the off-chain pipeline (not just a test):
//! engine → oracle → time-lock → settlement → finalize/submit.
//!
//!   cargo run -p syndicate-settlement --example full_match
//!
//! Uses the mock time-lock scheme + mock submitter (the real drand/Switchboard clients
//! and Solana RPC submitter plug in behind the same traits via the `net` feature).

use syndicate_engine::{Action, Engine};
use syndicate_oracle::{Guards, Sample, WindowSampler};
use syndicate_settlement::{finalize, settle_match, Applied, MockSubmitter, Outcome, SettleParams};
use syndicate_shared::PlayerId;
use syndicate_timelock::{MockScheme, RoundKey, SealRegistry, TimelockScheme};

fn main() {
    // 1) Match engine: a 3-handed limped hand played to showdown.
    let mut engine = Engine::new(
        vec![(PlayerId(0), 100, 0), (PlayerId(1), 100, 1), (PlayerId(2), 100, 2)],
        0,
        1,
        2,
        3,
    );
    engine.apply(0, Action::Call).unwrap();
    engine.apply(1, Action::Call).unwrap();
    engine.apply(2, Action::Check).unwrap();
    for _ in 0..2 {
        engine.apply(1, Action::Check).unwrap();
        engine.apply(2, Action::Check).unwrap();
        engine.apply(0, Action::Check).unwrap();
    }
    println!("engine complete: {}", engine.is_complete());

    // 2) Oracle: settlement-window samples (S = median).
    let mut sampler = WindowSampler::new(Guards { max_confidence: 100, max_staleness: 5, min_samples: 3 });
    for ts in 0..5 {
        sampler.record(Sample { ts, price: 100_000, confidence: 10, publish_ts: ts });
    }

    // 3) Time-lock: predictions sealed before LIVE, opened at match end.
    let scheme = MockScheme;
    let mut reg = SealRegistry::new(42);
    reg.seal(PlayerId(0), scheme.encrypt(100_010, 42)).unwrap(); // closest
    reg.seal(PlayerId(1), scheme.encrypt(99_000, 42)).unwrap();
    reg.seal(PlayerId(2), scheme.encrypt(100_500, 42)).unwrap();
    reg.lock();
    let key = RoundKey { round: 42, key: vec![1] };

    // 4) Settlement: compute via shared, build the on-chain submission bundle.
    let params = SettleParams { rake_bps: 0, rake_cap: 0, min_samples: 3, window_start: 0, window_end: 5 };
    let outcome = settle_match(&engine, &sampler, &reg, &scheme, Some(&key), &params);

    match &outcome {
        Outcome::Settled(b) => {
            println!("settlement price : {}", b.settlement_price);
            println!("pot awards       : {:?}", b.result.pot_awards);
            println!("rake             : {}", b.result.rake_collected);
            println!("self-verifies    : {} (the chain re-verifies with the same crate)", b.verify());
        }
        Outcome::Void(r) => println!("VOID: {r:?}"),
    }

    // 5) Finalize: submit on-chain (idempotent) or route to refund.
    let mut submitter = MockSubmitter::new();
    match finalize(outcome, &mut submitter).unwrap() {
        Applied::Settled(receipt) => println!("submitted tx     : {}", receipt.tx_sig),
        Applied::Refunded(reason) => println!("refunded (VOID)  : {reason:?}"),
    }
}
