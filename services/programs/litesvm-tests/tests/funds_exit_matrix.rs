//! Funds-exit × terminal-state matrix (Phase 09).
//!
//! The pre-audit capital-safety gate: for EVERY reachable terminal state, after all
//! claims / refunds / fee-withdrawals the match vault token balance must drain to
//! **exactly zero**. Each row drives a distinct lifecycle path on the real program `.so`
//! (loaded by the harness) and asserts `h.vault_balance() == 0` at the end.
//!
//! Status constants (borsh enum order): Filling=0 Sealing=1 Live=2 Settled=3 Void=4.
//! VoidKind: None=0 FillingVoid=1 UnderMinSealed=2 Emergency=3.

mod common;

use common::{MatchConfig, MatchHarness, SeatPayout};

const FILLING: u8 = 0;
const SEALING: u8 = 1;
const LIVE: u8 = 2;
const SETTLED: u8 = 3;
const VOID: u8 = 4;

const VK_FILLING: u8 = 1;
const VK_UNDER_MIN: u8 = 2;
const VK_EMERGENCY: u8 = 3;

/// A deterministic, valid settlement price (1e18 wad, exponent -18) for Live settlement.
const PRICE_WAD: u128 = 1_000_000_000_000_000_000;

fn commitment(seed: u8) -> [u8; 32] {
    [seed; 32]
}

/// Seal a set of seated players (advances the clock is NOT done here).
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
// Row 1: Filling never reaches min by fill_deadline_ts -> void_before_start -> full refund.
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
    // Still Filling (never locked). Warp past the fill deadline.
    assert_eq!(h.match_account().status, FILLING);
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
// Row 2: Sealing < min sealed by deadline -> begin_live -> UnderMinSealed VOID.
//   Sealers: buy_in + fee + penalty-share (remainder to earliest seal).
//   Non-sealers: deposit - penalty (entry fee forfeited -> withdraw_fees).
// ---------------------------------------------------------------------------------------
#[test]
fn row_under_min_sealed_void() {
    // 3 players, min 3 so a single sealer is under-min. Penalty 1000bps (10%), fee 5.
    let cfg = MatchConfig {
        num_players: 3,
        min_players: 3,
        entry_fee: 5,
        nonseal_penalty_bps: 1000,
        ..Default::default()
    };
    let mut h = MatchHarness::bare(cfg);
    h.create_match();
    h.deposit_all();
    h.lock_match();
    assert_eq!(h.match_account().status, SEALING);

    // Only seat 0 seals -> sealed_count(1) < min_players(3) -> UnderMinSealed void.
    seal(&mut h, &[0]);
    warp_to_begin_live(&mut h);
    h.begin_live([9u8; 32]).expect("begin_live -> under-min void");

    let m = h.match_account();
    assert_eq!(m.status, VOID);
    assert_eq!(m.void_kind, VK_UNDER_MIN);
    assert_eq!(m.sealed_count, 1);
    // dead_money = 2 non-sealers * (100 * 10%) = 20; forfeited_fees = 2 * 5 = 10.
    assert_eq!(m.dead_money, 20);
    assert_eq!(m.forfeited_fees, 10);

    for s in 0..cfg.num_players {
        h.refund(s).expect("refund");
    }
    // Forfeited non-sealer entry fees remain in the vault until withdrawn.
    let treasury = h.new_treasury_token();
    h.withdraw_fees(&treasury).expect("withdraw forfeited fees");
    assert_eq!(h.vault_balance(), 0, "under-min void vault must drain to 0");
}

// ---------------------------------------------------------------------------------------
// Row 2b: UnderMinSealed with ZERO sealers -> the orphaned penalty pool is withdrawable.
// ---------------------------------------------------------------------------------------
#[test]
fn row_under_min_zero_sealers_void() {
    let cfg = MatchConfig {
        num_players: 2,
        min_players: 2,
        entry_fee: 3,
        nonseal_penalty_bps: 2000, // 20%
        ..Default::default()
    };
    let mut h = MatchHarness::bare(cfg);
    h.create_match();
    h.deposit_all();
    h.lock_match();
    // Nobody seals.
    warp_to_begin_live(&mut h);
    h.begin_live([5u8; 32]).expect("begin_live -> zero-sealer void");
    let m = h.match_account();
    assert_eq!(m.status, VOID);
    assert_eq!(m.void_kind, VK_UNDER_MIN);
    assert_eq!(m.sealed_count, 0);
    assert_eq!(m.dead_money, 40); // 2 * (100 * 20%)
    assert_eq!(m.forfeited_fees, 6); // 2 * 3

    for s in 0..cfg.num_players {
        h.refund(s).expect("refund"); // each gets deposit - penalty = 80
    }
    let treasury = h.new_treasury_token();
    h.withdraw_fees(&treasury).expect("withdraw forfeited fees + orphaned pool");
    assert_eq!(h.vault_balance(), 0, "zero-sealer void vault must drain to 0");
}

// ---------------------------------------------------------------------------------------
// Row 3: Stuck Sealing past grace -> void_before_start (FillingVoid) -> full refund.
// ---------------------------------------------------------------------------------------
#[test]
fn row_stuck_sealing_void_full_refund() {
    let cfg = MatchConfig {
        num_players: 3,
        entry_fee: 4,
        ..Default::default()
    };
    let mut h = MatchHarness::bare(cfg);
    h.create_match();
    h.deposit_all();
    h.lock_match();
    // Some players sealed, but the operator vanished. Warp past seal_deadline + grace (60s).
    seal(&mut h, &[0, 1]);
    let m = h.match_account();
    h.set_clock(m.seal_deadline_ts + 61);
    h.void_before_start().expect("void_before_start (stuck sealing)");
    let m = h.match_account();
    assert_eq!(m.status, VOID);
    assert_eq!(m.void_kind, VK_FILLING); // pre-LIVE: full refund, no penalty

    for s in 0..cfg.num_players {
        h.refund(s).expect("refund");
    }
    assert_eq!(h.vault_balance(), 0, "stuck-sealing void vault must drain to 0");
}

// ---------------------------------------------------------------------------------------
// Row 4: Live -> submit_settlement -> claims (incl. leftover-stack payout) + withdraw_fees.
//   Includes a non-sealer who is dropped (deposit - penalty claimable) and rake.
// ---------------------------------------------------------------------------------------
#[test]
fn row_live_settled_claims_and_fees() {
    // 3 players, min 2. Seats 0 & 1 seal (engine seats 0,1); seat 2 is a non-sealer.
    // Penalty 1000bps -> dead_money = 100*10% = 10. Rake = 7.
    let cfg = MatchConfig {
        num_players: 3,
        min_players: 2,
        entry_fee: 6,
        rake_bps: 500,
        rake_cap: 100,
        nonseal_penalty_bps: 1000,
        ..Default::default()
    };
    let mut h = MatchHarness::bare(cfg);
    h.create_match();
    h.deposit_all();
    h.lock_match();
    seal(&mut h, &[0, 1]);
    warp_to_begin_live(&mut h);
    h.begin_live([3u8; 32]).expect("begin_live -> live");
    let m = h.match_account();
    assert_eq!(m.status, LIVE);
    assert_eq!(m.sealed_count, 2);
    assert_eq!(m.dead_money, 10); // seat 2 penalty
    assert_eq!(m.forfeited_fees, 6); // seat 2 fee

    // Conservation for sealers: sum(payouts) == sealed_count*buy_in + dead_money - rake
    //   = 2*100 + 10 - 7 = 203. Engine seat 0 gets 150 (incl leftover stack), seat 1 gets 53.
    let rake = 7u64;
    let payouts = vec![
        SeatPayout { engine_seat: 0, amount: 150 },
        SeatPayout { engine_seat: 1, amount: 53 },
    ];
    h.submit_settlement(&[0, 1], rake, payouts, PRICE_WAD)
        .expect("submit_settlement");
    let m = h.match_account();
    assert_eq!(m.status, SETTLED);
    assert_eq!(m.settled_payout, 203);

    // Sealers claim their payouts; the dropped non-sealer (seat 2) claims deposit-penalty=90.
    h.claim(0).expect("claim sealer 0");
    h.claim(1).expect("claim sealer 1");
    h.claim(2).expect("claim non-sealer");

    // Fees in vault = entry fees from all (3*6=18) wait: only sealers' fees counted in
    // total_fees? total_fees accrues each deposit's entry_fee; non-sealer fee is forfeited
    // (still in total_fees) plus rake. withdraw_fees(Settled) drains total_fees.
    let treasury = h.new_treasury_token();
    h.withdraw_fees(&treasury).expect("withdraw rake + fees");
    assert_eq!(h.vault_balance(), 0, "settled vault must drain to 0");
}

// ---------------------------------------------------------------------------------------
// Row 5: Live, settlement never lands -> void_live_after_deadline (Emergency) -> full refund.
// ---------------------------------------------------------------------------------------
#[test]
fn row_live_settle_never_lands_void() {
    let cfg = MatchConfig {
        num_players: 3,
        min_players: 2,
        entry_fee: 5,
        nonseal_penalty_bps: 1000,
        ..Default::default()
    };
    let mut h = MatchHarness::bare(cfg);
    h.create_match();
    h.deposit_all();
    h.lock_match();
    seal(&mut h, &[0, 1, 2]); // all seal
    warp_to_begin_live(&mut h);
    h.begin_live([2u8; 32]).expect("begin_live -> live");
    let m = h.match_account();
    assert_eq!(m.status, LIVE);

    // Operator vanishes. Warp past scheduled_end + SETTLE_VOID_GRACE_SEC (300s).
    h.set_clock(m.scheduled_end_ts + 301);
    h.void_live_after_deadline().expect("void_live_after_deadline");
    let m = h.match_account();
    assert_eq!(m.status, VOID);
    assert_eq!(m.void_kind, VK_EMERGENCY); // full refund, penalties waived

    for s in 0..cfg.num_players {
        h.refund(s).expect("refund");
    }
    // Emergency void waives all fees (nothing withdrawable) -> full refund already drains.
    assert_eq!(h.vault_balance(), 0, "live-deadline void vault must drain to 0");
}

// ---------------------------------------------------------------------------------------
// Row 6: Settled -> double-claim is rejected (idempotency); single claim still drains.
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
    h.lock_match();
    seal(&mut h, &[0, 1]);
    warp_to_begin_live(&mut h);
    h.begin_live([8u8; 32]).expect("begin_live -> live");

    // 2*100 + 0 - 0 = 200; seat 0 wins 200, seat 1 wins 0.
    let payouts = vec![
        SeatPayout { engine_seat: 0, amount: 200 },
        SeatPayout { engine_seat: 1, amount: 0 },
    ];
    h.submit_settlement(&[0, 1], 0, payouts, PRICE_WAD)
        .expect("submit_settlement");
    assert_eq!(h.match_account().status, SETTLED);

    h.claim(0).expect("first claim");
    // Second claim must fail (seat PDA closed on first claim; AlreadyClaimed otherwise).
    assert!(h.claim(0).is_err(), "double-claim must be rejected");
    h.claim(1).expect("claim zero-payout seat closes it");
    assert_eq!(h.vault_balance(), 0, "settled vault must drain to 0");
}

// ---------------------------------------------------------------------------------------
// Row 7: Emergency void during Live -> full refund all, penalties waived.
// ---------------------------------------------------------------------------------------
#[test]
fn row_emergency_void_live_full_refund() {
    let cfg = MatchConfig {
        num_players: 3,
        min_players: 2,
        entry_fee: 5,
        nonseal_penalty_bps: 1000,
        ..Default::default()
    };
    let mut h = MatchHarness::bare(cfg);
    h.create_match();
    h.deposit_all();
    h.lock_match();
    seal(&mut h, &[0, 1]); // seat 2 is a non-sealer, but penalties waived on Emergency
    warp_to_begin_live(&mut h);
    h.begin_live([4u8; 32]).expect("begin_live -> live");
    assert_eq!(h.match_account().status, LIVE);

    h.void().expect("operator emergency void");
    let m = h.match_account();
    assert_eq!(m.status, VOID);
    assert_eq!(m.void_kind, VK_EMERGENCY);

    for s in 0..cfg.num_players {
        h.refund(s).expect("refund"); // each gets deposit + entry_fee (penalties waived)
    }
    assert_eq!(h.vault_balance(), 0, "emergency-void vault must drain to 0");
}

// ---------------------------------------------------------------------------------------
// Row 8: Emergency void during Filling -> full refund all.
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
