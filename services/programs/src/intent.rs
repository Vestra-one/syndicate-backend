//! Canonical intent messages — byte-identical to `syndicate_shared::intent`.

use anchor_lang::prelude::*;

pub const DOMAIN_ACTION: &[u8] = b"syndicate/action/v1";
pub const DOMAIN_DEFAULT: &[u8] = b"syndicate/default/v1";
pub const DOMAIN_PREDICTION: &[u8] = b"syndicate/prediction/v1";

pub fn action_intent_message(
    match_id: u64,
    onchain_match_id: u64,
    seat_index: u16,
    seat_pubkey: &Pubkey,
    nonce: u64,
    prev_head: &[u8; 32],
    action_tag: u8,
    amount: u64,
) -> Vec<u8> {
    let mut out = Vec::with_capacity(128);
    out.extend_from_slice(DOMAIN_ACTION);
    out.push(0);
    out.extend_from_slice(&match_id.to_le_bytes());
    out.extend_from_slice(&onchain_match_id.to_le_bytes());
    out.extend_from_slice(&seat_index.to_le_bytes());
    out.extend_from_slice(seat_pubkey.as_ref());
    out.extend_from_slice(&nonce.to_le_bytes());
    out.extend_from_slice(prev_head);
    out.push(action_tag);
    out.extend_from_slice(&amount.to_le_bytes());
    out
}

pub fn default_policy_message(
    match_id: u64,
    onchain_match_id: u64,
    seat_index: u16,
    seat_pubkey: &Pubkey,
    policy_tag: u8,
) -> Vec<u8> {
    let mut out = Vec::with_capacity(64);
    out.extend_from_slice(DOMAIN_DEFAULT);
    out.push(0);
    out.extend_from_slice(&match_id.to_le_bytes());
    out.extend_from_slice(&onchain_match_id.to_le_bytes());
    out.extend_from_slice(&seat_index.to_le_bytes());
    out.extend_from_slice(seat_pubkey.as_ref());
    out.push(policy_tag);
    out
}

pub fn prediction_commitment_message(
    match_id: u64,
    onchain_match_id: u64,
    seat_index: u16,
    seat_pubkey: &Pubkey,
    seal_seq: u64,
    commitment: &[u8; 32],
) -> Vec<u8> {
    let mut out = Vec::with_capacity(96);
    out.extend_from_slice(DOMAIN_PREDICTION);
    out.push(0);
    out.extend_from_slice(&match_id.to_le_bytes());
    out.extend_from_slice(&onchain_match_id.to_le_bytes());
    out.extend_from_slice(&seat_index.to_le_bytes());
    out.extend_from_slice(seat_pubkey.as_ref());
    out.extend_from_slice(&seal_seq.to_le_bytes());
    out.extend_from_slice(commitment);
    out
}

pub fn prediction_commitment_hash(prediction: i128, blinding: &[u8; 32]) -> [u8; 32] {
    let mut buf = [0u8; 48];
    buf[..16].copy_from_slice(&prediction.to_le_bytes());
    buf[16..].copy_from_slice(blinding);
    syndicate_shared::intent::simple_sha256(&buf)
}
