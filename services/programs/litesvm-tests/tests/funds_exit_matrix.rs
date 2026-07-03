//! Funds-exit × terminal-state matrix (v2).
//!
//! The pre-audit capital-safety gate: for EVERY reachable terminal state, after all
//! claims / refunds / fee-withdrawals the match vault token balance must drain to
//! **exactly zero** — including unconfirmed candidates left behind at lock.
//!
//! Status constants (borsh enum order): Filling=0 Sealing=1 Live=2 Settled=3 Void=4.
//! VoidKind (v2): None=0 FillingVoid=1 Emergency=2.

mod common;

use common::{MatchConfig, MatchHarness, SeatPayout};

const FILLING: u8 = 0;
const LIVE: u8 = 2;
const SETTLED: u8 = 3;
const VOID: u8 = 4;

const VK_FILLING: u8 = 1;
const VK_EMERGENCY: u8 = 2;

/// A deterministic, valid settlement price (1e18 wad, exponent -18) for Live settlement.
const PRICE_WAD: u128 = 1_000_000_000_000_000_000;

fn commitment(seed: u8) -> [u8; 32] {
    [seed; 32]
}

/// Seal a set of confirmed players (does NOT advance the clock).
fn seal(h: &mut MatchHarness, seats: &[usize]) {
    let tlt = h.valid_timelock_target();
    for &s in seats {
        h.register_prediction_commitment(s, commitment(s as u8 + 1), tlt)
            .expect("seal");
    }
}

/// Advance the on-chain clock just past the seal deadline so `begin_live` is in-window.
fn warp_to_begin_live(h: &mut MatchHarness) {
    let m = h.match_account();
    h.set_clock(m.seal_deadline_ts + 1);
}

// ---------------------------------------------------------------------------------------
// Row 1: Filling never locks by fill_deadline_ts -> void_before_start -> full refund,
//        including candidates (nobody was confirmed).
// ---------------------------------------------------------------------------------------
#[test]
fn row_filling_void_full_refund() {
    let cfg = MatchConfig {
        num_players: 3,
        fill_deadline_ts: 2_000_000_000,
        ..Default::default()
    };
    let mut h = MatchHarness::bare(cfg);
    h.create_match();
    h.deposit_all();
    assert_eq!(h.match_account().status, FILLING);
    // Refund is NOT available while still Filling.
    assert!(h.refund(0).is_err(), "no refund during Filling");
    h.set_clock(cfg.fill_deadline_ts + 1);
    h.void_before_start().expect("void_before_start (filling)");
    let m = h.match_account();
    assert_eq!(m.status, VOID);
    assert_eq!(m.void_kind, VK_FILLING);

    for s in 0..cfg.num_players {
        h.refund(s).expect("refund");
    }
    assert_eq!(h.vault_balance(), 0, "filling-void vault must drain to 0");
}

// ---------------------------------------------------------------------------------------
// Row 2: Stuck Sealing past grace -> void_before_start (FillingVoid) -> full refund for
//        confirmed seats AND the unconfirmed candidate.
// ---------------------------------------------------------------------------------------
#[test]
fn row_stuck_sealing_void_full_refund() {
    let cfg = MatchConfig {
        num_players: 4,
        max_players: 3,
        entry_fee: 4,
        ..Default::default()
    };
    let mut h = MatchHarness::bare(cfg);
    h.create_match();
    h.deposit_all();
    h.lock_match(&[0, 1, 2]); // player 3 stays an unconfirmed candidate
    seal(&mut h, &[0, 1]);
    let m = h.match_account();
    h.set_clock(m.seal_deadline_ts + 61);
    h.void_before_start().expect("void_before_start (stuck sealing)");
    let m = h.match_account();
    assert_eq!(m.status, VOID);
    assert_eq!(m.void_kind, VK_FILLING);

    for s in 0..cfg.num_players {
        h.refund(s).expect("refund");
    }
    assert_eq!(h.vault_balance(), 0, "stuck-sealing void vault must drain to 0");
}

// ---------------------------------------------------------------------------------------
// Row 3: Live -> submit_settlement covering ALL confirmed seats (incl. a non-sealer who
//        keeps playing) -> claims + candidate refund + withdraw_fees.
// ---------------------------------------------------------------------------------------
#[test]
fn row_live_settled_claims_and_fees() {
    // 4 candidates, 3 confirmed (players 0,1,2); player 3 unconfirmed. Seats 0 & 1 seal;
    // seat 2 is a non-sealer but still plays (v2). Rake = 7.
    let cfg = MatchConfig {
        num_players: 4,
        max_players: 3,
        min_players: 2,
        entry_fee: 6,
        rake_bps: 500,
        rake_cap: 100,
        ..Default::default()
    };
    let mut h = MatchHarness::bare(cfg);
    h.create_match();
    h.deposit_all();
    h.lock_match(&[0, 1, 2]);
    seal(&mut h, &[0, 1]);
    warp_to_begin_live(&mut h);
    h.begin_live().expect("begin_live -> live");
    let m = h.match_account();
    assert_eq!(m.status, LIVE);
    assert_eq!(m.sealed_count, 2);
    assert_eq!(m.confirmed_count, 3);
    // Non-sealer keeps its engine seat.
    assert_eq!(h.seat_account(2).engine_seat, 2);

    // The unconfirmed candidate can refund DURING Live (lock happened without them).
    h.refund(3).expect("unconfirmed candidate refund during Live");

    // Conservation v2: sum(payouts) == confirmed_count*buy_in - rake = 3*100 - 7 = 293.
    let rake = 7u64;
    let payouts = vec![
        SeatPayout { engine_seat: 0, amount: 150 },
        SeatPayout { engine_seat: 1, amount: 90 },
        SeatPayout { engine_seat: 2, amount: 53 },
    ];
    h.submit_settlement(rake, payouts, PRICE_WAD)
        .expect("submit_settlement");
    let m = h.match_account();
    assert_eq!(m.status, SETTLED);
    assert_eq!(m.settled_payout, 293);

    h.claim(0).expect("claim sealer 0");
    h.claim(1).expect("claim sealer 1");
    h.claim(2).expect("claim non-sealer (played)");

    // total_fees = confirmed entry fees (3*6=18) + rake (7) = 25.
    let m = h.match_account();
    assert_eq!(m.total_fees, 25);
    let treasury = h.new_treasury_token();
    h.withdraw_fees(&treasury).expect("withdraw rake + fees");
    assert_eq!(h.token_balance(&treasury), 25);
    assert_eq!(h.vault_balance(), 0, "settled vault must drain to 0");
}

// ---------------------------------------------------------------------------------------
// Row 4: Live, settlement never lands -> void_live_after_deadline (Emergency) -> full
//        refund for everyone (confirmed + candidate).
// ---------------------------------------------------------------------------------------
#[test]
fn row_live_settle_never_lands_void() {
    let cfg = MatchConfig {
        num_players: 3,
        min_players: 2,
        entry_fee: 5,
        ..Default::default()
    };
    let mut h = MatchHarness::bare(cfg);
    h.create_match();
    h.deposit_all();
    h.lock_match(&[0, 1, 2]);
    seal(&mut h, &[0, 1, 2]);
    warp_to_begin_live(&mut h);
    h.begin_live().expect("begin_live -> live");
    let m = h.match_account();
    assert_eq!(m.status, LIVE);

    // Operator vanishes. Warp past scheduled_end + SETTLE_VOID_GRACE_SEC (300s).
    h.set_clock(m.scheduled_end_ts + 301);
    h.void_live_after_deadline().expect("void_live_after_deadline");
    let m = h.match_account();
    assert_eq!(m.status, VOID);
    assert_eq!(m.void_kind, VK_EMERGENCY);

    for s in 0..cfg.num_players {
        h.refund(s).expect("refund");
    }
    assert_eq!(h.vault_balance(), 0, "live-deadline void vault must drain to 0");
}

// ---------------------------------------------------------------------------------------
// Row 5: Settled -> double-claim is rejected (idempotency); single claim still drains.
// ---------------------------------------------------------------------------------------
#[test]
fn row_double_claim_rejected() {
    let cfg = MatchConfig {
        num_players: 2,
        min_players: 2,
        ..Default::default()
    };
    let mut h = MatchHarness::bare(cfg);
    h.create_match();
    h.deposit_all();
    h.lock_match(&[0, 1]);
    seal(&mut h, &[0, 1]);
    warp_to_begin_live(&mut h);
    h.begin_live().expect("begin_live -> live");

    let payouts = vec![
        SeatPayout { engine_seat: 0, amount: 200 },
        SeatPayout { engine_seat: 1, amount: 0 },
    ];
    h.submit_settlement(0, payouts, PRICE_WAD)
        .expect("submit_settlement");
    assert_eq!(h.match_account().status, SETTLED);

    h.claim(0).expect("first claim");
    // Second claim must fail (seat PDA closed on first claim).
    assert!(h.claim(0).is_err(), "double-claim must be rejected");
    h.claim(1).expect("claim zero-payout seat closes it");
    assert_eq!(h.vault_balance(), 0, "settled vault must drain to 0");
}

// ---------------------------------------------------------------------------------------
// Row 6: Emergency void during Live -> full refund all.
// ---------------------------------------------------------------------------------------
#[test]
fn row_emergency_void_live_full_refund() {
    let cfg = MatchConfig {
        num_players: 3,
        min_players: 2,
        entry_fee: 5,
        ..Default::default()
    };
    let mut h = MatchHarness::bare(cfg);
    h.create_match();
    h.deposit_all();
    h.lock_match(&[0, 1, 2]);
    seal(&mut h, &[0, 1]); // seat 2 is a non-sealer, but voids always refund in full
    warp_to_begin_live(&mut h);
    h.begin_live().expect("begin_live -> live");
    assert_eq!(h.match_account().status, LIVE);

    h.void().expect("operator emergency void");
    let m = h.match_account();
    assert_eq!(m.status, VOID);
    assert_eq!(m.void_kind, VK_EMERGENCY);

    for s in 0..cfg.num_players {
        h.refund(s).expect("refund"); // each gets deposit + entry_fee
    }
    assert_eq!(h.vault_balance(), 0, "emergency-void vault must drain to 0");
}

// ---------------------------------------------------------------------------------------
// Row 7: Emergency void during Filling -> full refund all.
// ---------------------------------------------------------------------------------------
#[test]
fn row_emergency_void_filling_full_refund() {
    let cfg = MatchConfig {
        num_players: 2,
        entry_fee: 7,
        ..Default::default()
    };
    let mut h = MatchHarness::bare(cfg);
    h.create_match();
    h.deposit_all();
    assert_eq!(h.match_account().status, FILLING);
    h.void().expect("emergency void while filling");
    assert_eq!(h.match_account().void_kind, VK_EMERGENCY);
    for s in 0..cfg.num_players {
        h.refund(s).expect("refund");
    }
    assert_eq!(h.vault_balance(), 0, "filling emergency-void vault must drain to 0");
}

// ---------------------------------------------------------------------------------------
// Row 8: Settled with an unconfirmed candidate -> candidate refunds AFTER Settled too.
// ---------------------------------------------------------------------------------------
#[test]
fn row_settled_candidate_refund_after_settlement() {
    let cfg = MatchConfig {
        num_players: 3,
        max_players: 2,
        min_players: 2,
        entry_fee: 2,
        ..Default::default()
    };
    let mut h = MatchHarness::bare(cfg);
    h.create_match();
    h.deposit_all();
    h.lock_match(&[0, 1]); // player 2 left behind
    seal(&mut h, &[0, 1]);
    warp_to_begin_live(&mut h);
    h.begin_live().expect("begin_live");
    let payouts = vec![
        SeatPayout { engine_seat: 0, amount: 200 },
        SeatPayout { engine_seat: 1, amount: 0 },
    ];
    h.submit_settlement(0, payouts, PRICE_WAD)
        .expect("submit_settlement");
    assert_eq!(h.match_account().status, SETTLED);

    h.claim(0).expect("claim winner");
    h.claim(1).expect("claim loser");
    // Candidate refund still works after settlement (full deposit + fee).
    h.refund(2).expect("candidate refund after Settled");

    let treasury = h.new_treasury_token();
    h.withdraw_fees(&treasury).expect("withdraw fees");
    // total_fees = confirmed fees only (2*2=4); candidate's fee went back to them.
    assert_eq!(h.token_balance(&treasury), 4);
    assert_eq!(h.vault_balance(), 0, "vault must drain to 0 incl. candidate exit");
}
