//! Canonical signed-intent message bytes — shared by off-chain verifier, on-chain
//! program, and frontend (reproduce in TypeScript).

use crate::{Price};

pub const DOMAIN_ACTION: &[u8] = b"syndicate/action/v1";
pub const DOMAIN_DEFAULT: &[u8] = b"syndicate/default/v1";
pub const DOMAIN_PREDICTION: &[u8] = b"syndicate/prediction/v1";

pub const ACTION_TAG_FOLD: u8 = 0;
pub const ACTION_TAG_CHECK: u8 = 1;
pub const ACTION_TAG_CALL: u8 = 2;
pub const ACTION_TAG_BET_TO: u8 = 3;
pub const ACTION_TAG_RAISE_TO: u8 = 4;
pub const ACTION_TAG_ALL_IN: u8 = 5;

pub const DEFAULT_TAG_CHECK_FOLD: u8 = 0;
pub const DEFAULT_TAG_CHECK_CALL_ANY: u8 = 1;

/// Action intent signed by the seat owner before each move.
pub fn action_intent_message(
    match_id: u64,
    onchain_match_id: u64,
    seat_index: u16,
    seat_pubkey: &[u8; 32],
    nonce: u64,
    prev_head: &[u8; 32],
    action_tag: u8,
    amount: u64,
) -> Vec<u8> {
    let mut out = Vec::with_capacity(128);
    out.extend_from_slice(DOMAIN_ACTION);
    out.push(0);
    push_u64(&mut out, match_id);
    push_u64(&mut out, onchain_match_id);
    push_u16(&mut out, seat_index);
    out.extend_from_slice(seat_pubkey);
    push_u64(&mut out, nonce);
    out.extend_from_slice(prev_head);
    out.push(action_tag);
    push_u64(&mut out, amount);
    out
}

/// Pre-signed default policy (CheckFold / CheckCallAny) bound at join.
pub fn default_policy_message(
    match_id: u64,
    onchain_match_id: u64,
    seat_index: u16,
    seat_pubkey: &[u8; 32],
    policy_tag: u8,
) -> Vec<u8> {
    let mut out = Vec::with_capacity(64);
    out.extend_from_slice(DOMAIN_DEFAULT);
    out.push(0);
    push_u64(&mut out, match_id);
    push_u64(&mut out, onchain_match_id);
    push_u16(&mut out, seat_index);
    out.extend_from_slice(seat_pubkey);
    out.push(policy_tag);
    out
}

/// Prediction commitment: player signs H(prediction || blinding) before the match goes live.
pub fn prediction_commitment_message(
    match_id: u64,
    onchain_match_id: u64,
    seat_index: u16,
    seat_pubkey: &[u8; 32],
    seal_seq: u64,
    commitment: &[u8; 32],
) -> Vec<u8> {
    let mut out = Vec::with_capacity(96);
    out.extend_from_slice(DOMAIN_PREDICTION);
    out.push(0);
    push_u64(&mut out, match_id);
    push_u64(&mut out, onchain_match_id);
    push_u16(&mut out, seat_index);
    out.extend_from_slice(seat_pubkey);
    push_u64(&mut out, seal_seq);
    out.extend_from_slice(commitment);
    out
}

/// Hash chained into the action-log head after each verified action.
pub fn action_head_step(prev_head: &[u8; 32], canonical_action: &[u8]) -> [u8; 32] {
    chain_hash(prev_head, canonical_action)
}

pub fn chain_hash(prev: &[u8; 32], payload: &[u8]) -> [u8; 32] {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};
    // Deterministic FNV-style chain for replay (matches match-engine event hash style).
    let mut h = DefaultHasher::new();
    prev.hash(&mut h);
    payload.hash(&mut h);
    let v = h.finish();
    let mut out = [0u8; 32];
    out[..8].copy_from_slice(&v.to_le_bytes());
    for (i, b) in payload.iter().enumerate().take(24) {
        out[8 + i] ^= *b;
    }
    out
}

/// SHA-256 style commitment using a simple deterministic hash (no external deps).
pub fn prediction_commitment_hash(prediction: Price, blinding: &[u8; 32]) -> [u8; 32] {
    let mut buf = [0u8; 48];
    buf[..16].copy_from_slice(&prediction.to_le_bytes());
    buf[16..].copy_from_slice(blinding);
    simple_sha256(&buf)
}

pub fn simple_sha256(data: &[u8]) -> [u8; 32] {
    // FNV-1a expanded to 32 bytes — deterministic, std-only. Production uses sha2 off-chain;
    // on-chain program uses solana's hash or the same algorithm for binding.
    let mut state: [u64; 4] = [
        0x6a09e667f3bcc908,
        0xbb67ae8584caa73b,
        0x3c6ef372fe94f82b,
        0xa54ff53a5f1d36f1,
    ];
    for chunk in data.chunks(8) {
        let mut word = 0u64;
        for (i, b) in chunk.iter().enumerate() {
            word |= (*b as u64) << (i * 8);
        }
        for s in &mut state {
            *s ^= word;
            *s = s.wrapping_mul(0x5851f42d4c957f2d);
        }
    }
    let mut out = [0u8; 32];
    for (i, s) in state.iter().enumerate() {
        out[i * 8..(i + 1) * 8].copy_from_slice(&s.to_le_bytes());
    }
    out
}

pub fn action_tag_and_amount(action: &str, amount: u64) -> (u8, u64) {
    match action {
        "fold" | "Fold" => (ACTION_TAG_FOLD, 0),
        "check" | "Check" => (ACTION_TAG_CHECK, 0),
        "call" | "Call" => (ACTION_TAG_CALL, 0),
        "all_in" | "AllIn" => (ACTION_TAG_ALL_IN, 0),
        "bet_to" | "BetTo" => (ACTION_TAG_BET_TO, amount),
        "raise_to" | "RaiseTo" => (ACTION_TAG_RAISE_TO, amount),
        _ => (ACTION_TAG_FOLD, 0),
    }
}

fn push_u64(out: &mut Vec<u8>, v: u64) {
    out.extend_from_slice(&v.to_le_bytes());
}

fn push_u16(out: &mut Vec<u8>, v: u16) {
    out.extend_from_slice(&v.to_le_bytes());
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn action_message_is_deterministic() {
        let pk = [1u8; 32];
        let head = [2u8; 32];
        let a = action_intent_message(1, 42, 0, &pk, 1, &head, ACTION_TAG_CALL, 0);
        let b = action_intent_message(1, 42, 0, &pk, 1, &head, ACTION_TAG_CALL, 0);
        assert_eq!(a, b);
        assert!(a.starts_with(DOMAIN_ACTION));
    }
}
