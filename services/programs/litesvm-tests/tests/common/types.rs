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
