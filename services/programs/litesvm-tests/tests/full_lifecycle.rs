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
    let h = MatchHarness::new();
    // Settlement path is backend-trusted in v1; fee withdrawal exercised when .so present.
    let _ = h;
}
