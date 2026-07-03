//! Private-room commitment binding: create requires a non-zero commitment iff private;
//! deposits must carry a commitment iff the room is private. Content verification is a
//! backend concern (confirm-at-lock); the chain records the binding.

mod common;

use common::{room_commitment, MatchConfig, MatchHarness};
use solana_sdk::signature::Signer as SolSigner;

#[test]
fn private_create_requires_commitment() {
    let cfg = MatchConfig {
        is_private: true,
        ..Default::default()
    };
    let mut h = MatchHarness::bare(cfg);
    let mut params = h.build_create_params();
    assert!(params.is_private);
    params.room_commitment = [0u8; 32]; // private but zero commitment
    assert!(
        h.try_create_match_with(params).is_err(),
        "private create with zero commitment must be rejected"
    );
}

#[test]
fn public_create_rejects_commitment() {
    let cfg = MatchConfig::default();
    let mut h = MatchHarness::bare(cfg);
    let mut params = h.build_create_params();
    assert!(!params.is_private);
    params.room_commitment = [9u8; 32]; // public but non-zero commitment
    assert!(
        h.try_create_match_with(params).is_err(),
        "public create with non-zero commitment must be rejected"
    );
}

#[test]
fn private_room_full_flow_stores_commitments() {
    let cfg = MatchConfig {
        is_private: true,
        num_players: 2,
        ..Default::default()
    };
    let mut h = MatchHarness::bare(cfg);
    h.create_match();
    let m = h.match_account();
    assert!(m.is_private);
    assert_eq!(
        m.room_commitment,
        room_commitment(common::ROOM_CODE, &h.admin.pubkey())
    );

    h.deposit_all();
    for s in 0..2 {
        let seat = h.seat_account(s);
        assert_eq!(
            seat.room_commitment,
            room_commitment(common::ROOM_CODE, &h.players[s].pubkey()),
            "joiner commitment stored on seat"
        );
    }
}

#[test]
fn private_deposit_requires_commitment() {
    let cfg = MatchConfig {
        is_private: true,
        num_players: 1,
        ..Default::default()
    };
    let mut h = MatchHarness::bare(cfg);
    h.create_match();
    assert!(
        h.deposit_with_commitment(0, [0u8; 32]).is_err(),
        "private deposit with zero commitment must be rejected"
    );
}

#[test]
fn public_deposit_rejects_commitment() {
    let cfg = MatchConfig {
        num_players: 1,
        ..Default::default()
    };
    let mut h = MatchHarness::bare(cfg);
    h.create_match();
    assert!(
        h.deposit_with_commitment(0, [9u8; 32]).is_err(),
        "public deposit with non-zero commitment must be rejected"
    );
}
