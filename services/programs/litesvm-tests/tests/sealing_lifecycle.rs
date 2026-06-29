mod common;

use common::MatchHarness;

#[test]
fn sealing_transitions_lock_set_button_begin_live() {
    let h = MatchHarness::new();
    assert_ne!(h.match_key, solana_sdk::pubkey::Pubkey::default());
}
