//! v2 non-sealer semantics: seats without a commitment are NOT dropped — every confirmed
//! seat keeps its engine seat, plays, and is covered by settlement. Zero sealers still
//! goes Live (backend assigns the seal-close spot price off-chain).

mod common;

use common::{MatchConfig, MatchHarness, SeatPayout};

const LIVE: u8 = 2;
const SETTLED: u8 = 3;
const PRICE_WAD: u128 = 1_000_000_000_000_000_000;

#[test]
fn one_of_three_seals_all_three_play_and_settle() {
    let cfg = MatchConfig {
        num_players: 3,
        min_players: 2,
        rake_bps: 500,
        rake_cap: 100,
        ..Default::default()
    };
    let mut h = MatchHarness::bare(cfg);
    h.create_match();
    h.deposit_all();
    h.lock_match(&[0, 1, 2]);

    // Only player 0 seals.
    let tlt = h.valid_timelock_target();
    h.register_prediction_commitment(0, [1u8; 32], tlt).expect("seal");

    let m = h.match_account();
    h.set_clock(m.seal_deadline_ts + 1);
    h.begin_live().expect("begin_live with 1/3 sealed");

    let m = h.match_account();
    assert_eq!(m.status, LIVE, "non-sealers do not block going Live");
    assert_eq!(m.sealed_count, 1);
    assert_eq!(m.confirmed_count, 3);
    // Every confirmed seat keeps its engine seat.
    for s in 0..3 {
        assert_eq!(h.seat_account(s).engine_seat, s as u8);
    }

    // Settlement covers ALL 3 confirmed seats: 3*100 - rake(9) = 291.
    let rake = 9u64;
    let payouts = vec![
        SeatPayout { engine_seat: 0, amount: 200 },
        SeatPayout { engine_seat: 1, amount: 60 },
        SeatPayout { engine_seat: 2, amount: 31 },
    ];
    h.submit_settlement(rake, payouts, PRICE_WAD).expect("settle");
    assert_eq!(h.match_account().status, SETTLED);

    for s in 0..3 {
        h.claim(s).expect("claim");
    }
    let treasury = h.new_treasury_token();
    h.withdraw_fees(&treasury).expect("fees");
    assert_eq!(h.vault_balance(), 0, "vault drains with non-sealers settled in");
}

#[test]
fn zero_sealers_still_goes_live() {
    let cfg = MatchConfig {
        num_players: 2,
        min_players: 2,
        ..Default::default()
    };
    let mut h = MatchHarness::bare(cfg);
    h.create_match();
    h.deposit_all();
    h.lock_match(&[0, 1]);

    // Nobody seals.
    let m = h.match_account();
    h.set_clock(m.seal_deadline_ts + 1);
    h.begin_live().expect("begin_live with zero sealers");

    let m = h.match_account();
    assert_eq!(m.status, LIVE);
    assert_eq!(m.sealed_count, 0);
    assert!(m.button_set, "button still derives (from unset commitments)");

    // Settlement conservation: 2*100 - 0.
    let payouts = vec![
        SeatPayout { engine_seat: 0, amount: 120 },
        SeatPayout { engine_seat: 1, amount: 80 },
    ];
    h.submit_settlement(0, payouts, PRICE_WAD).expect("settle");
    h.claim(0).expect("claim");
    h.claim(1).expect("claim");
    assert_eq!(h.vault_balance(), 0);
}

#[test]
fn settlement_must_cover_every_confirmed_seat() {
    let cfg = MatchConfig {
        num_players: 3,
        min_players: 2,
        ..Default::default()
    };
    let mut h = MatchHarness::bare(cfg);
    h.create_match();
    h.deposit_all();
    h.lock_match(&[0, 1, 2]);
    let tlt = h.valid_timelock_target();
    h.register_prediction_commitment(0, [1u8; 32], tlt).expect("seal");
    let m = h.match_account();
    h.set_clock(m.seal_deadline_ts + 1);
    h.begin_live().expect("begin_live");

    // Payouts for only 2 of 3 confirmed seats must be rejected.
    let payouts = vec![
        SeatPayout { engine_seat: 0, amount: 200 },
        SeatPayout { engine_seat: 1, amount: 100 },
    ];
    assert!(
        h.submit_settlement(0, payouts, PRICE_WAD).is_err(),
        "settlement missing a confirmed seat must fail (SeatSetMismatch)"
    );
}
