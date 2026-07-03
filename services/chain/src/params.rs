//! Instruction argument types (Borsh mirrors of the on-chain v2 layouts).

use borsh::{BorshDeserialize, BorshSerialize};
use solana_sdk::pubkey::Pubkey;

/// v2 CreateParams — 167 bytes Borsh, field order identical to the program.
#[derive(BorshSerialize, BorshDeserialize, Clone, Debug, PartialEq, Eq)]
pub struct CreateParams {
    pub match_id: u64,
    pub buy_in: u64,
    pub entry_fee: u64,
    pub rake_bps: u32,
    pub rake_cap: u64,
    pub min_players: u8,
    pub max_players: u8,
    pub is_private: bool,
    pub room_commitment: [u8; 32],
    pub config_hash: [u8; 32],
    pub price_token: [u8; 20],
    pub total_betting_duration_sec: u64,
    pub seal_window_sec: u64,
    pub begin_live_window_sec: u64,
    pub fill_window_sec: u64,
    pub max_oracle_confidence: u64,
    pub oracle_exponent: i32,
}

pub const CREATE_PARAMS_LEN: usize = 167;

impl CreateParams {
    pub fn encode(&self) -> Vec<u8> {
        let out = borsh::to_vec(self).expect("encode CreateParams");
        debug_assert_eq!(out.len(), CREATE_PARAMS_LEN);
        out
    }
}

#[derive(BorshSerialize, BorshDeserialize, Clone, Debug, PartialEq, Eq)]
pub struct ProtocolRoles {
    pub protocol_admin: Pubkey,
    pub settlement_admin: Pubkey,
    pub emergency_void_admin: Pubkey,
    pub pause_admin: Pubkey,
    pub config_admin: Pubkey,
    pub fee_admin: Pubkey,
    pub treasury_admin: Pubkey,
    pub upgrade_authority: Pubkey,
    pub price_signer: [u8; 20],
}

#[derive(BorshSerialize, BorshDeserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub struct MatchBounds {
    pub buy_in_min: u64,
    pub buy_in_max: u64,
    pub fill_window_min_sec: u64,
    pub fill_window_max_sec: u64,
    pub total_betting_duration_min_sec: u64,
    pub total_betting_duration_max_sec: u64,
}

#[derive(BorshSerialize, BorshDeserialize, Clone, Debug, PartialEq, Eq)]
pub struct RegisterPredictionCommitmentArgs {
    /// `sha256(tlock_ciphertext_bytes)`.
    pub commitment: [u8; 32],
    /// drand round the prediction is encrypted to.
    pub timelock_target: u64,
}
