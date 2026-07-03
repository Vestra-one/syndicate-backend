//! Full on-chain lifecycle integration tests (requires `cargo build-sbf`).

mod common;

use common::{MatchConfig, MatchHarness, SeatPayout};

const SEALING: u8 = 1;
const LIVE: u8 = 2;
const SETTLED: u8 = 3;

const PRICE_WAD: u128 = 1_000_000_000_000_000_000;

/// Drive Filling -> lock(confirm) -> seals -> begin_live -> Live, asserting each transition.
#[test]
fn sealing_to_live_lifecycle() {
    let cfg = MatchConfig {
        num_players: 3,
        min_players: 2,
        ..Default::default()
    };
    let mut h = MatchHarness::bare(cfg);
    h.create_match();
    h.deposit_all();
    h.lock_match(&[0, 1, 2]);
    let m = h.match_account();
    assert_eq!(m.status, SEALING);
    assert_eq!(m.candidate_count, 3);
    assert_eq!(m.confirmed_count, 3);

    // Engine seats were assigned at lock, in pass order.
    for s in 0..3 {
        let seat = h.seat_account(s);
        assert!(seat.confirmed);
        assert_eq!(seat.engine_seat, s as u8);
    }

    // All three seal within the window.
    let tlt = h.valid_timelock_target();
    for s in 0..3 {
        h.register_prediction_commitment(s, [s as u8 + 1; 32], tlt)
            .expect("seal");
    }
    // Warp just past the seal deadline and begin live.
    let m = h.match_account();
    h.set_clock(m.seal_deadline_ts + 1);
    h.begin_live().expect("begin_live");

    let m = h.match_account();
    assert_eq!(m.status, LIVE);
    assert_eq!(m.sealed_count, 3);
    assert!(m.button_set);
    assert!((m.button as usize) < 3);
    assert_ne!(m.button_seed, [0u8; 32]);
}

/// Settle a Live match, then withdraw fees (rake + entry fees) to the treasury and assert
/// the treasury received exactly `total_fees` and the vault fully drains after claims.
#[test]
fn withdraw_fees_after_settlement() {
    let cfg = MatchConfig {
        num_players: 2,
        min_players: 2,
        entry_fee: 10,
        rake_bps: 1000, // 10%
        rake_cap: 100,
        ..Default::default()
    };
    let mut h = MatchHarness::bare(cfg);
    h.create_match();
    h.deposit_all();
    h.lock_match(&[0, 1]);
    let tlt = h.valid_timelock_target();
    for s in 0..2 {
        h.register_prediction_commitment(s, [s as u8 + 1; 32], tlt)
            .expect("seal");
    }
    let m = h.match_account();
    h.set_clock(m.seal_deadline_ts + 1);
    h.begin_live().expect("begin_live");

    // 2*100 - rake(20) = 180. Engine seat 0 wins 180, seat 1 wins 0.
    let rake = 20u64;
    let payouts = vec![
        SeatPayout { engine_seat: 0, amount: 180 },
        SeatPayout { engine_seat: 1, amount: 0 },
    ];
    h.submit_settlement(rake, payouts, PRICE_WAD)
        .expect("submit_settlement");
    assert_eq!(h.match_account().status, SETTLED);

    h.claim(0).expect("claim 0");
    h.claim(1).expect("claim 1");

    // total_fees = confirmed entry fees (2*10=20) + rake (20) = 40.
    let m = h.match_account();
    assert_eq!(m.total_fees, 40);
    let treasury = h.new_treasury_token();
    h.withdraw_fees(&treasury).expect("withdraw_fees");
    assert_eq!(h.token_balance(&treasury), 40, "treasury gets rake + entry fees");
    assert_eq!(h.vault_balance(), 0, "vault fully drained after settle + fees");
}
