//! v2 candidate lifecycle: deposits are candidacy; unconfirmed candidates refund in full
//! the moment the match leaves Filling; confirmed seats only refund on Void.

mod common;

use common::{MatchConfig, MatchHarness, SeatPayout};

const PRICE_WAD: u128 = 1_000_000_000_000_000_000;

fn locked_harness(num_players: usize, confirmed: &[usize]) -> MatchHarness {
    let cfg = MatchConfig {
        num_players,
        max_players: confirmed.len() as u8,
        min_players: 2,
        entry_fee: 5,
        ..Default::default()
    };
    let mut h = MatchHarness::bare(cfg);
    h.create_match();
    h.deposit_all();
    h.lock_match(confirmed);
    h
}

#[test]
fn candidate_refund_available_in_sealing() {
    let mut h = locked_harness(3, &[0, 1]);
    let before = h.token_balance(&h.player_tokens[2]);
    h.refund(2).expect("candidate refund during Sealing");
    let after = h.token_balance(&h.player_tokens[2]);
    assert_eq!(after - before, 100 + 5, "full deposit + entry fee back");
}

#[test]
fn candidate_refund_available_in_live_and_settled() {
    let mut h = locked_harness(4, &[0, 1]);
    let tlt = h.valid_timelock_target();
    h.register_prediction_commitment(0, [1u8; 32], tlt).expect("seal");
    h.register_prediction_commitment(1, [2u8; 32], tlt).expect("seal");
    let m = h.match_account();
    h.set_clock(m.seal_deadline_ts + 1);
    h.begin_live().expect("begin_live");

    h.refund(2).expect("candidate refund during Live");

    let payouts = vec![
        SeatPayout { engine_seat: 0, amount: 200 },
        SeatPayout { engine_seat: 1, amount: 0 },
    ];
    h.submit_settlement(0, payouts, PRICE_WAD).expect("settle");
    h.refund(3).expect("candidate refund after Settled");

    h.claim(0).expect("claim");
    h.claim(1).expect("claim");
    let treasury = h.new_treasury_token();
    h.withdraw_fees(&treasury).expect("fees");
    assert_eq!(h.vault_balance(), 0);
}

#[test]
fn candidate_refund_rejected_during_filling() {
    let cfg = MatchConfig {
        num_players: 2,
        ..Default::default()
    };
    let mut h = MatchHarness::bare(cfg);
    h.create_match();
    h.deposit_all();
    assert!(h.refund(0).is_err(), "no exit while Filling (race safety)");
}

#[test]
fn confirmed_seat_refund_rejected_outside_void() {
    let mut h = locked_harness(3, &[0, 1]);
    // Sealing: confirmed seat cannot refund.
    assert!(h.refund(0).is_err(), "confirmed seat cannot refund in Sealing");

    let tlt = h.valid_timelock_target();
    h.register_prediction_commitment(0, [1u8; 32], tlt).expect("seal");
    h.register_prediction_commitment(1, [2u8; 32], tlt).expect("seal");
    let m = h.match_account();
    h.set_clock(m.seal_deadline_ts + 1);
    h.begin_live().expect("begin_live");
    assert!(h.refund(0).is_err(), "confirmed seat cannot refund in Live");

    let payouts = vec![
        SeatPayout { engine_seat: 0, amount: 200 },
        SeatPayout { engine_seat: 1, amount: 0 },
    ];
    h.submit_settlement(0, payouts, PRICE_WAD).expect("settle");
    assert!(h.refund(0).is_err(), "confirmed seat cannot refund after Settled (use claim)");
    h.claim(0).expect("claim works");
}

#[test]
fn candidate_double_refund_rejected() {
    let mut h = locked_harness(3, &[0, 1]);
    h.refund(2).expect("first refund");
    assert!(h.refund(2).is_err(), "double refund must be rejected (PDA closed)");
}

#[test]
fn deposit_after_lock_rejected() {
    let mut h = locked_harness(3, &[0, 1]);
    assert!(h.deposit(3).is_err(), "deposit after lock must be rejected (BadStatus)");
}

#[test]
fn candidate_cap_enforced() {
    let cfg = MatchConfig {
        num_players: 0, // fixed keypairs unused; use fresh ones below
        ..Default::default()
    };
    let mut h = MatchHarness::bare(cfg);
    h.create_match();
    for i in 0..32 {
        h.deposit_new_player()
            .unwrap_or_else(|e| panic!("candidate {i} should be accepted: {e}"));
    }
    assert_eq!(h.match_account().candidate_count, 32);
    assert!(
        h.deposit_new_player().is_err(),
        "33rd candidate must be rejected (CandidateLimitReached)"
    );
}

#[test]
fn lock_below_min_players_rejected() {
    let cfg = MatchConfig {
        num_players: 1,
        min_players: 2,
        ..Default::default()
    };
    let mut h = MatchHarness::bare(cfg);
    h.create_match();
    h.deposit_all();
    assert!(h.try_lock_match(&[0]).is_err(), "lock below min_players must fail");
}
