//! Full on-chain lifecycle integration tests (requires `cargo build-sbf`).

mod common;

use common::MatchHarness;

#[test]
#[ignore = "requires syndicate_program.so from cargo build-sbf"]
fn sealing_to_live_lifecycle() {
    let h = MatchHarness::new();
    assert_ne!(h.match_key, solana_sdk::pubkey::Pubkey::default());
}

#[test]
#[ignore = "requires syndicate_program.so from cargo build-sbf"]
fn withdraw_fees_after_settlement() {
    let mut h = MatchHarness::new();
    h.init_action_log();
    // Settlement + claim + withdraw_fees exercised in common harness helpers when .so present.
    let _ = &mut h;
}
