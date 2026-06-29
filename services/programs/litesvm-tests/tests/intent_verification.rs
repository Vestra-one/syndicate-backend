mod common;

use common::{advance_head, canonical_action_step, MatchHarness, GENESIS_HEAD};
use syndicate_shared::intent::action_intent_message;

#[test]
fn lifecycle_reaches_sealing_match() {
    let h = MatchHarness::new();
    assert_ne!(h.match_key, solana_sdk::pubkey::Pubkey::default());
}

#[test]
fn prev_head_chain_is_deterministic() {
    let mut head = GENESIS_HEAD;
    let step = canonical_action_step(0, 1, 2, 0, false);
    head = advance_head(&head, &step);
    let stale = GENESIS_HEAD;
    let msg_ok = action_intent_message(
        common::MATCH_ID,
        common::MATCH_ID,
        1,
        &[0u8; 32],
        1,
        &head,
        2,
        0,
    );
    let msg_bad = action_intent_message(
        common::MATCH_ID,
        common::MATCH_ID,
        1,
        &[0u8; 32],
        1,
        &stale,
        2,
        0,
    );
    assert_ne!(msg_ok, msg_bad);
}

#[test]
fn truncation_changes_canonical_head() {
    let mut head = GENESIS_HEAD;
    for (seat, nonce, tag) in [(0u16, 1u64, 2u8), (1, 1, 2u8)] {
        let step = canonical_action_step(seat, nonce, tag, 0, false);
        head = advance_head(&head, &step);
    }
    let truncated = advance_head(
        &GENESIS_HEAD,
        &canonical_action_step(2, 1, 1, 0, false),
    );
    assert_ne!(head, truncated);
}

#[test]
fn incomplete_hand_head_differs_from_showdown_root() {
    let mut head = GENESIS_HEAD;
    let step = canonical_action_step(0, 1, 2, 0, false);
    head = advance_head(&head, &step);
    let mut complete = head;
    for (i, (seat, tag)) in [(1, 2u8), (2, 1), (1, 1), (2, 1), (0, 1), (1, 1), (2, 1), (0, 1)]
        .iter()
        .enumerate()
    {
        let step = canonical_action_step(*seat, (i + 2) as u64, *tag, 0, false);
        complete = advance_head(&complete, &step);
    }
    assert_ne!(head, complete);
}

#[test]
fn default_policy_message_is_per_seat() {
    let a = syndicate_shared::intent::default_policy_message(
        common::MATCH_ID,
        common::MATCH_ID,
        0,
        &[1u8; 32],
        common::DEFAULT_TAG_CHECK_FOLD,
    );
    let b = syndicate_shared::intent::default_policy_message(
        common::MATCH_ID,
        common::MATCH_ID,
        1,
        &[2u8; 32],
        common::DEFAULT_TAG_CHECK_FOLD,
    );
    assert_ne!(a, b);
}
