//! Canonical signed-intent message bytes — shared by off-chain verifier, on-chain
//! program, and frontend (reproduce in TypeScript).

use crate::Price;

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
#[allow(clippy::too_many_arguments)]
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

/// Prediction commitment: during SEALING (before LIVE), the player signs a binding over
/// their seat, the time-lock ciphertext hash, and the `timelock_target` drand round.
/// `seal_seq` is NOT signed — it is assigned on-chain by arrival order so no player can
/// claim an early seal to grab tie-remainders (plan_v2 §1).
pub fn prediction_commitment_message(
    match_id: u64,
    onchain_match_id: u64,
    seat_index: u16,
    seat_pubkey: &[u8; 32],
    timelock_target: u64,
    commitment: &[u8; 32],
) -> Vec<u8> {
    let mut out = Vec::with_capacity(96);
    out.extend_from_slice(DOMAIN_PREDICTION);
    out.push(0);
    push_u64(&mut out, match_id);
    push_u64(&mut out, onchain_match_id);
    push_u16(&mut out, seat_index);
    out.extend_from_slice(seat_pubkey);
    push_u64(&mut out, timelock_target);
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

/// SHA-256 commitment over `(prediction, blinding)` — off-chain reveal binding
/// (`prediction(i128 LE, 16) ‖ blinding(32)`).
pub fn prediction_commitment_hash(prediction: Price, blinding: &[u8; 32]) -> [u8; 32] {
    let mut buf = [0u8; 48];
    buf[..16].copy_from_slice(&prediction.to_le_bytes());
    buf[16..].copy_from_slice(blinding);
    sha256(&buf)
}

/// v2 on-chain prediction commitment binding: `sha256(tlock_ciphertext_bytes)`. This is
/// the 32-byte commitment registered on the seat during Sealing and re-checked by the
/// settlement worker after timelock decryption.
pub fn ciphertext_commitment_hash(ciphertext: &[u8]) -> [u8; 32] {
    sha256(ciphertext)
}

/// Real SHA-256 (sha2 crate) — the normative commitment hash. Reproduce byte-identically
/// in TypeScript with `crypto.subtle.digest('SHA-256', ...)`.
pub fn sha256(data: &[u8]) -> [u8; 32] {
    use sha2::{Digest, Sha256};
    let mut out = [0u8; 32];
    out.copy_from_slice(&Sha256::digest(data));
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

    /// Interop vector: the commitment hash must be REAL SHA-256 (FIPS 180-4), so the
    /// frontend (tlock-js + WebCrypto) reproduces it byte-identically.
    #[test]
    fn ciphertext_commitment_is_real_sha256() {
        // sha256("abc") — canonical NIST test vector.
        let expected: [u8; 32] = [
            0xba, 0x78, 0x16, 0xbf, 0x8f, 0x01, 0xcf, 0xea, 0x41, 0x41, 0x40, 0xde, 0x5d, 0xae,
            0x22, 0x23, 0xb0, 0x03, 0x61, 0xa3, 0x96, 0x17, 0x7a, 0x9c, 0xb4, 0x10, 0xff, 0x61,
            0xf2, 0x00, 0x15, 0xad,
        ];
        assert_eq!(ciphertext_commitment_hash(b"abc"), expected);
        assert_eq!(sha256(b"abc"), expected);
        // Empty input — sha256("").
        let empty: [u8; 32] = [
            0xe3, 0xb0, 0xc4, 0x42, 0x98, 0xfc, 0x1c, 0x14, 0x9a, 0xfb, 0xf4, 0xc8, 0x99, 0x6f,
            0xb9, 0x24, 0x27, 0xae, 0x41, 0xe4, 0x64, 0x9b, 0x93, 0x4c, 0xa4, 0x95, 0x99, 0x1b,
            0x78, 0x52, 0xb8, 0x55,
        ];
        assert_eq!(ciphertext_commitment_hash(b""), empty);
    }

    #[test]
    fn prediction_commitment_hash_matches_sha256_of_price_le_and_blinding() {
        let blinding = [7u8; 32];
        let price: Price = 100_000;
        let mut buf = [0u8; 48];
        buf[..16].copy_from_slice(&price.to_le_bytes());
        buf[16..].copy_from_slice(&blinding);
        assert_eq!(prediction_commitment_hash(price, &blinding), sha256(&buf));
        assert_ne!(
            prediction_commitment_hash(price, &blinding),
            prediction_commitment_hash(price + 1, &blinding)
        );
    }

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
