//! Rust-native chain layer for the Syndicate v2 program: Anchor discriminators, PDAs,
//! instruction argument encoding, instruction builders, account decoders, and (behind the
//! `rpc` feature) finalized-transaction verification helpers.
//!
//! Byte layouts mirror `services/programs/programs/syndicate_program/src/` exactly and
//! are enforced by the parity test in `services/programs/litesvm-tests/tests/chain_parity.rs`.

pub mod accounts;
pub mod disc;
pub mod ix;
pub mod params;
pub mod pda;
pub mod settle_args;
pub mod templates;

#[cfg(feature = "rpc")]
pub mod verify;

use solana_sdk::pubkey::Pubkey;

/// The deployed v2 program id (must match `declare_id!` in the program source).
pub const PROGRAM_ID_STR: &str = "EQsNZV4bBqaXFSSDkYKxuu57eBB9s83ouTjC4imDNvTv";

pub fn program_id() -> Pubkey {
    PROGRAM_ID_STR.parse().expect("valid program id")
}

/// Sentinel `engine_seat` for a seat not (yet) confirmed into the playing set.
pub const NO_ENGINE_SEAT: u8 = u8::MAX;

/// Normative room commitment: `sha256(roomcode_utf8 ‖ wallet_pubkey_bytes)`. Room codes
/// are normalized (trim + uppercase) BEFORE hashing.
pub fn room_commitment(room_code: &str, wallet: &Pubkey) -> [u8; 32] {
    use sha2::{Digest, Sha256};
    let mut h = Sha256::new();
    h.update(room_code.trim().to_ascii_uppercase().as_bytes());
    h.update(wallet.as_ref());
    h.finalize().into()
}

/// Pinned drand beacon (League of Entropy quicknet).
pub const DRAND_GENESIS_TIME: u64 = 1_692_803_367;
pub const DRAND_PERIOD_SEC: u64 = 3;

/// Expected unix publish time (seconds) of a drand round.
pub fn drand_round_publish_ts(round: u64) -> Option<u64> {
    round
        .checked_mul(DRAND_PERIOD_SEC)?
        .checked_add(DRAND_GENESIS_TIME)
}

/// Re-derive the on-chain dealer-button seed (normative preimage from `begin_live`).
/// `seats` are the confirmed seats in engine order:
/// `(player, commitment_set, prediction_commitment, timelock_target)`.
pub fn button_seed(
    match_key: &Pubkey,
    lock_ts: u64,
    seats: &[(Pubkey, bool, [u8; 32], u64)],
) -> ([u8; 32], u8) {
    use sha2::Digest;
    // keccak256 — matches solana_keccak_hasher on-chain.
    let mut preimage: Vec<u8> = Vec::with_capacity(19 + 32 + 8 + seats.len() * 73);
    preimage.extend_from_slice(b"syndicate:button:v2");
    preimage.extend_from_slice(match_key.as_ref());
    preimage.extend_from_slice(&lock_ts.to_le_bytes());
    for (player, set, commitment, target) in seats {
        preimage.extend_from_slice(player.as_ref());
        preimage.push(*set as u8);
        preimage.extend_from_slice(commitment);
        preimage.extend_from_slice(&target.to_le_bytes());
    }
    let seed: [u8; 32] = sha3::Keccak256::digest(&preimage).into();
    let rnd = u64::from_le_bytes(seed[0..8].try_into().unwrap());
    let button = (rnd % seats.len() as u64) as u8;
    (seed, button)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn room_commitment_normalizes() {
        let w = Pubkey::new_unique();
        assert_eq!(
            room_commitment(" kx7q2m ", &w),
            room_commitment("KX7Q2M", &w)
        );
    }
}
