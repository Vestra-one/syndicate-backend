//! `lock` / `begin_live` seat-set validation: duplicates, foreign seats, wrong counts,
//! and engine-order enforcement.

mod common;

use common::{seat_pda, MatchConfig, MatchHarness};
use solana_sdk::signature::Signer as SolSigner;

#[test]
fn lock_rejects_duplicate_seat() {
    let cfg = MatchConfig {
        num_players: 2,
        min_players: 2,
        ..Default::default()
    };
    let mut h = MatchHarness::bare(cfg);
    h.create_match();
    h.deposit_all();
    // Pass player 0's seat twice.
    assert!(
        h.try_lock_match(&[0, 0]).is_err(),
        "duplicate seat in the confirmed set must be rejected"
    );
    // Recovery: a valid lock still works afterwards.
    h.lock_match(&[0, 1]);
}

#[test]
fn lock_rejects_foreign_and_non_pda_accounts() {
    let cfg = MatchConfig {
        num_players: 2,
        min_players: 2,
        ..Default::default()
    };
    let mut h = MatchHarness::bare(cfg);
    h.create_match();
    h.deposit_all();

    // A random account is not a seat PDA of this match.
    let bogus = solana_sdk::pubkey::Pubkey::new_unique();
    let (real, _) = seat_pda(&h.match_key, &h.players[0].pubkey());
    assert!(
        h.try_lock_match_raw(&[real, bogus]).is_err(),
        "non-seat account must be rejected"
    );

    // A seat PDA derived for a player who never deposited doesn't exist on-chain.
    let (ghost, _) = seat_pda(&h.match_key, &h.players[5].pubkey());
    assert!(
        h.try_lock_match_raw(&[real, ghost]).is_err(),
        "uninitialized seat PDA must be rejected"
    );
}

#[test]
fn lock_rejects_above_max_players() {
    let cfg = MatchConfig {
        num_players: 4,
        min_players: 2,
        max_players: 3,
        ..Default::default()
    };
    let mut h = MatchHarness::bare(cfg);
    h.create_match();
    h.deposit_all();
    assert!(
        h.try_lock_match(&[0, 1, 2, 3]).is_err(),
        "confirming more than max_players must be rejected"
    );
}

#[test]
fn begin_live_rejects_wrong_order_and_count() {
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
    for s in 0..3 {
        h.register_prediction_commitment(s, [s as u8 + 1; 32], tlt)
            .expect("seal");
    }
    let m = h.match_account();
    h.set_clock(m.seal_deadline_ts + 1);

    // Wrong engine order (engine_seat mismatch) must be rejected.
    assert!(
        h.begin_live_with(&[1, 0, 2]).is_err(),
        "begin_live with permuted seat order must be rejected"
    );
    // Wrong count must be rejected.
    assert!(
        h.begin_live_with(&[0, 1]).is_err(),
        "begin_live missing a confirmed seat must be rejected"
    );
    // Correct order succeeds.
    h.begin_live().expect("begin_live in engine order");
}

#[test]
fn double_lock_rejected() {
    let cfg = MatchConfig {
        num_players: 2,
        min_players: 2,
        ..Default::default()
    };
    let mut h = MatchHarness::bare(cfg);
    h.create_match();
    h.deposit_all();
    h.lock_match(&[0, 1]);
    assert!(
        h.try_lock_match(&[0, 1]).is_err(),
        "second lock must be rejected (BadStatus)"
    );
}
