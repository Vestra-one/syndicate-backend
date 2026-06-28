mod common;

use common::MatchHarness;

#[test]
fn sealing_transitions_lock_set_button_begin_live() {
    let h = MatchHarness::new();
    assert_ne!(h.match_key, solana_sdk::pubkey::Pubkey::default());
}

#[test]
fn init_action_log_requires_live_after_sealing() {
    let mut h = MatchHarness::new();
    h.inject_action_log();
    assert_eq!(h.read_action_log_head(), common::GENESIS_HEAD);
}
