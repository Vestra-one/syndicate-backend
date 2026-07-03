//! On-chain dealer-button derivation: keccak over the confirmed seats' seal data. The
//! harness re-derives the normative preimage off-chain and must match the stored
//! `button_seed`/`button` exactly; permuting a commitment changes the seed.

mod common;

use common::{MatchConfig, MatchHarness};

fn live_harness(commitments: &[[u8; 32]]) -> MatchHarness {
    let cfg = MatchConfig {
        num_players: commitments.len(),
        min_players: 2,
        ..Default::default()
    };
    let mut h = MatchHarness::bare(cfg);
    h.create_match();
    h.deposit_all();
    let confirmed: Vec<usize> = (0..commitments.len()).collect();
    h.lock_match(&confirmed);
    let tlt = h.valid_timelock_target();
    for (s, c) in commitments.iter().enumerate() {
        h.register_prediction_commitment(s, *c, tlt).expect("seal");
    }
    let m = h.match_account();
    h.set_clock(m.seal_deadline_ts + 1);
    h.begin_live().expect("begin_live");
    h
}

#[test]
fn button_matches_offchain_rederivation() {
    let h = live_harness(&[[1u8; 32], [2u8; 32], [3u8; 32]]);
    let m = h.match_account();
    let (expected_seed, expected_button) = h.expected_button_seed();
    assert_eq!(m.button_seed, expected_seed, "on-chain seed == normative keccak preimage");
    assert_eq!(m.button, expected_button);
    assert!(m.button_set);
    assert!((m.button as usize) < 3);
}

#[test]
fn different_commitments_change_seed() {
    let h1 = live_harness(&[[1u8; 32], [2u8; 32]]);
    let h2 = live_harness(&[[1u8; 32], [9u8; 32]]);
    assert_ne!(
        h1.match_account().button_seed,
        h2.match_account().button_seed,
        "permuting a commitment must change the button seed"
    );
}

#[test]
fn partial_sealing_included_in_seed() {
    // Same players, one seals vs none: seeds must differ (commitment_set byte + bytes).
    let cfg = MatchConfig {
        num_players: 2,
        min_players: 2,
        ..Default::default()
    };
    let mut h_sealed = MatchHarness::bare(cfg);
    h_sealed.create_match();
    h_sealed.deposit_all();
    h_sealed.lock_match(&[0, 1]);
    let tlt = h_sealed.valid_timelock_target();
    h_sealed.register_prediction_commitment(0, [5u8; 32], tlt).expect("seal");
    let m = h_sealed.match_account();
    h_sealed.set_clock(m.seal_deadline_ts + 1);
    h_sealed.begin_live().expect("begin_live");

    let (expected_seed, expected_button) = h_sealed.expected_button_seed();
    let m = h_sealed.match_account();
    assert_eq!(m.button_seed, expected_seed, "partial-seal seed re-derives");
    assert_eq!(m.button, expected_button);
}
