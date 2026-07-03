//! Byte-parity gate between `syndicate-chain` (host encoders/decoders) and the on-chain
//! program: instruction args, discriminators, PDAs, account layouts, and the button-seed
//! derivation must all match the program the harness loads.

mod common;

use borsh::BorshSerialize;
use common::{MatchConfig, MatchHarness};
use solana_sdk::pubkey::Pubkey;
use solana_sdk::signature::Signer as SolSigner;

#[test]
fn create_params_encoding_matches_harness_mirror() {
    let harness_params = common::CreateParams {
        match_id: 42,
        buy_in: 5_000_000,
        entry_fee: 100,
        rake_bps: 300,
        rake_cap: 1_000,
        min_players: 2,
        max_players: 5,
        is_private: true,
        room_commitment: [7u8; 32],
        config_hash: [9u8; 32],
        price_token: [3u8; 20],
        total_betting_duration_sec: 600,
        seal_window_sec: 20,
        begin_live_window_sec: 30,
        fill_window_sec: 300,
        max_oracle_confidence: u64::MAX,
        oracle_exponent: -18,
    };
    let chain_params = syndicate_chain::params::CreateParams {
        match_id: 42,
        buy_in: 5_000_000,
        entry_fee: 100,
        rake_bps: 300,
        rake_cap: 1_000,
        min_players: 2,
        max_players: 5,
        is_private: true,
        room_commitment: [7u8; 32],
        config_hash: [9u8; 32],
        price_token: [3u8; 20],
        total_betting_duration_sec: 600,
        seal_window_sec: 20,
        begin_live_window_sec: 30,
        fill_window_sec: 300,
        max_oracle_confidence: u64::MAX,
        oracle_exponent: -18,
    };
    let mut harness_bytes = Vec::new();
    harness_params.serialize(&mut harness_bytes).unwrap();
    let chain_bytes = chain_params.encode();
    assert_eq!(harness_bytes, chain_bytes);
    assert_eq!(chain_bytes.len(), syndicate_chain::params::CREATE_PARAMS_LEN);
}

#[test]
fn settle_args_encoding_matches_harness_mirror() {
    let harness_args = common::build_settle_args_fixture();
    let chain_args = syndicate_chain::settle_args::SettleArgs {
        signed_price: syndicate_chain::settle_args::SignedPriceDto {
            token: harness_args.signed_price.token,
            price_in_wad: harness_args.signed_price.price_in_wad,
            timestamp_ms: harness_args.signed_price.timestamp_ms,
            v: harness_args.signed_price.v,
            r: harness_args.signed_price.r,
            s: harness_args.signed_price.s,
        },
        rake_collected: harness_args.rake_collected,
        payouts: harness_args
            .payouts
            .iter()
            .map(|p| syndicate_chain::settle_args::SeatPayout {
                engine_seat: p.engine_seat,
                amount: p.amount,
            })
            .collect(),
    };
    let mut harness_bytes = Vec::new();
    harness_args.serialize(&mut harness_bytes).unwrap();
    assert_eq!(harness_bytes, chain_args.encode());
}

#[test]
fn discriminators_match() {
    for name in [
        "initialize_protocol",
        "set_pauses",
        "set_price_signer",
        "set_match_bounds",
        "create_match",
        "create_and_deposit",
        "deposit",
        "lock",
        "begin_live",
        "register_prediction_commitment",
        "submit_settlement",
        "claim",
        "refund",
        "void",
        "void_before_start",
        "void_live_after_deadline",
        "withdraw_fees",
    ] {
        assert_eq!(
            syndicate_chain::disc::instruction(name),
            common::anchor_discriminator(name),
            "instruction discriminator mismatch for {name}"
        );
    }
    for name in ["MatchAccount", "SeatAccount", "ProtocolState"] {
        assert_eq!(
            syndicate_chain::disc::account(name),
            common::account_discriminator(name),
            "account discriminator mismatch for {name}"
        );
    }
}

#[test]
fn pdas_match() {
    let program_id = common::PROGRAM_ID;
    let (p1, b1) = syndicate_chain::pda::protocol(&program_id);
    let (p2, b2) = common::protocol_pda();
    assert_eq!((p1, b1), (p2, b2));

    let (m1, _) = syndicate_chain::pda::match_account(&program_id, 12345);
    let (m2, _) = common::match_pda(12345);
    assert_eq!(m1, m2);

    let (v1, _) = syndicate_chain::pda::vault(&program_id, &m1);
    let (v2, _) = common::vault_pda(&m2);
    assert_eq!(v1, v2);

    let player = Pubkey::new_unique();
    let (s1, _) = syndicate_chain::pda::seat(&program_id, &m1, &player);
    let (s2, _) = common::seat_pda(&m2, &player);
    assert_eq!(s1, s2);
}

#[test]
fn room_commitment_matches_harness() {
    let w = Pubkey::new_unique();
    assert_eq!(
        syndicate_chain::room_commitment("KX7Q2M", &w),
        common::room_commitment("KX7Q2M", &w)
    );
}

/// Decode real on-chain account bytes (produced by the loaded `.so`) with the chain
/// decoders — the strongest layout check available.
#[test]
fn account_decoders_roundtrip_live_program_state() {
    let cfg = MatchConfig {
        num_players: 2,
        min_players: 2,
        is_private: false,
        ..Default::default()
    };
    let mut h = MatchHarness::bare(cfg);
    h.create_match();
    h.deposit_all();
    h.lock_match(&[0, 1]);
    let tlt = h.valid_timelock_target();
    h.register_prediction_commitment(0, [1u8; 32], tlt).unwrap();
    let m = h.match_account();
    h.set_clock(m.seal_deadline_ts + 1);
    h.begin_live().unwrap();

    // Match account via chain decoder.
    let raw = h.svm.get_account(&h.match_key).unwrap();
    let decoded = syndicate_chain::accounts::decode_match(&raw.data).expect("decode match");
    assert_eq!(decoded.match_id, h.cfg.match_id);
    assert_eq!(decoded.status, syndicate_chain::accounts::STATUS_LIVE);
    assert_eq!(decoded.confirmed_count, 2);
    assert_eq!(decoded.sealed_count, 1);
    assert!(decoded.button_set);
    assert_eq!(raw.data.len() as u64, syndicate_chain::accounts::MATCH_ACCOUNT_SPACE);

    // Seat account via chain decoder.
    let (seat_key, _) = common::seat_pda(&h.match_key, &h.players[0].pubkey());
    let raw_seat = h.svm.get_account(&seat_key).unwrap();
    let seat = syndicate_chain::accounts::decode_seat(&raw_seat.data).expect("decode seat");
    assert!(seat.confirmed && seat.commitment_set);
    assert_eq!(seat.engine_seat, 0);
    assert_eq!(seat.prediction_commitment, [1u8; 32]);
    assert_eq!(raw_seat.data.len() as u64, syndicate_chain::accounts::SEAT_ACCOUNT_SPACE);

    // Button-seed re-derivation via the chain helper equals the on-chain value.
    let seats: Vec<(Pubkey, bool, [u8; 32], u64)> = (0..2)
        .map(|i| {
            let s = h.seat_account(i);
            (
                h.players[i].pubkey(),
                s.commitment_set,
                s.prediction_commitment,
                s.timelock_target,
            )
        })
        .collect();
    let (seed, button) = syndicate_chain::button_seed(&h.match_key, decoded.lock_ts, &seats);
    assert_eq!(seed, decoded.button_seed);
    assert_eq!(button, decoded.button);
}
