//! Wire-compatible instruction arg types (mirror Anchor layouts in the on-chain program).

use borsh::{BorshDeserialize, BorshSerialize};
use solana_sdk::pubkey::Pubkey;

pub const DEFAULT_TAG_CHECK_FOLD: u8 = 0;

#[derive(BorshSerialize, BorshDeserialize, Clone)]
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

#[derive(BorshSerialize, BorshDeserialize, Clone)]
pub struct CreateParams {
    pub match_id: u64,
    pub buy_in: u64,
    pub entry_fee: u64,
    pub rake_bps: u32,
    pub rake_cap: u64,
    pub nonseal_penalty_bps: u32,
    pub min_players: u8,
    pub max_players: u8,
    pub config_hash: [u8; 32],
    pub price_token: [u8; 20],
    pub total_betting_duration_sec: u64,
    pub seal_window_sec: u64,
    pub begin_live_window_sec: u64,
    pub fill_deadline_ts: u64,
    pub max_oracle_confidence: u64,
    pub oracle_exponent: i32,
}

#[derive(BorshSerialize, BorshDeserialize, Clone)]
pub struct BeginLiveArgs {
    pub button_randomness: [u8; 32],
}

#[derive(BorshSerialize, BorshDeserialize, Clone)]
pub struct RegisterPredictionCommitmentArgs {
    pub commitment: [u8; 32],
    pub timelock_target: u64,
}

#[derive(BorshSerialize, BorshDeserialize, Clone)]
pub struct SignedPriceDto {
    pub token: [u8; 20],
    pub price_in_wad: [u8; 32],
    pub timestamp_ms: u64,
    pub v: u8,
    pub r: [u8; 32],
    pub s: [u8; 32],
}

#[derive(BorshSerialize, BorshDeserialize, Clone)]
pub struct SeatPayout {
    pub engine_seat: u8,
    pub amount: u64,
}

#[derive(BorshSerialize, BorshDeserialize, Clone)]
pub struct SettleArgs {
    pub signed_price: SignedPriceDto,
    pub rake_collected: u64,
    pub payouts: Vec<SeatPayout>,
}

/// Borsh mirror of the on-chain `MatchAccount` (state.rs), field order identical, used to
/// decode account data after stripping the 8-byte Anchor discriminator. Anchor account
/// serialization is plain borsh, so this round-trips the on-chain layout exactly.
#[derive(BorshSerialize, BorshDeserialize, Clone)]
pub struct MatchAccountData {
    pub authority: Pubkey,
    pub mint: Pubkey,
    pub vault: Pubkey,
    pub match_id: u64,
    pub buy_in: u64,
    pub status: u8,
    pub config_hash: [u8; 32],
    pub price_token: [u8; 20],
    pub fill_deadline_ts: u64,
    pub lock_ts: u64,
    pub seal_deadline_ts: u64,
    pub live_start_ts: u64,
    pub scheduled_end_ts: u64,
    pub total_betting_duration_sec: u64,
    pub seal_window_sec: u64,
    pub begin_live_window_sec: u64,
    pub max_oracle_confidence: u64,
    pub oracle_exponent: i32,
    pub signed_price_hash: [u8; 32],
    pub signed_price_timestamp_ms: u64,
    pub entry_fee: u64,
    pub rake_bps: u32,
    pub rake_cap: u64,
    pub nonseal_penalty_bps: u32,
    pub min_players: u8,
    pub max_players: u8,
    pub player_count: u8,
    pub sealed_count: u8,
    pub next_seal_seq: u64,
    pub total_deposited: u64,
    pub total_fees: u64,
    pub forfeited_fees: u64,
    pub dead_money: u64,
    pub settled_payout: u64,
    pub button_randomness: [u8; 32],
    pub button: u8,
    pub button_set: bool,
    pub vault_bump: u8,
    pub bump: u8,
    pub fees_withdrawn: bool,
    pub void_kind: u8,
    pub reserved: [u8; 32],
}

/// Borsh mirror of the on-chain `SeatAccount` (state.rs) for decoding seat data.
#[derive(BorshSerialize, BorshDeserialize, Clone)]
pub struct SeatAccountData {
    pub match_key: Pubkey,
    pub player: Pubkey,
    pub seat_index: u16,
    pub deposit: u64,
    pub entry_fee_paid: u64,
    pub payout: u64,
    pub claimed: bool,
    pub bump: u8,
    pub prediction_commitment: [u8; 32],
    pub timelock_target: u64,
    pub seal_seq: u64,
    pub commitment_set: bool,
    pub is_non_sealer: bool,
    pub penalty: u64,
    pub engine_seat: u8,
    pub gets_remainder: bool,
    pub reserved: [u8; 8],
}
