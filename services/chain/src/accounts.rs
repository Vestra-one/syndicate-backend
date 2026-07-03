//! On-chain account decoders (Borsh mirrors of the v2 `state.rs` layouts). Callers strip
//! nothing: `decode_*` checks the 8-byte Anchor discriminator itself.

use borsh::{BorshDeserialize, BorshSerialize};
use solana_sdk::pubkey::Pubkey;

use crate::disc;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DecodeError {
    TooShort,
    BadDiscriminator,
    Borsh,
}

impl std::fmt::Display for DecodeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            DecodeError::TooShort => write!(f, "account data too short"),
            DecodeError::BadDiscriminator => write!(f, "account discriminator mismatch"),
            DecodeError::Borsh => write!(f, "borsh decode failed"),
        }
    }
}
impl std::error::Error for DecodeError {}

#[derive(BorshSerialize, BorshDeserialize, Clone, Debug)]
pub struct ProtocolStateData {
    pub protocol_admin: Pubkey,
    pub settlement_admin: Pubkey,
    pub emergency_void_admin: Pubkey,
    pub pause_admin: Pubkey,
    pub config_admin: Pubkey,
    pub fee_admin: Pubkey,
    pub treasury_admin: Pubkey,
    pub upgrade_authority: Pubkey,
    pub price_signer: [u8; 20],
    pub pause_new_matches: bool,
    pub pause_settlement: bool,
    pub bump: u8,
    pub buy_in_min: u64,
    pub buy_in_max: u64,
    pub fill_window_min_sec: u64,
    pub fill_window_max_sec: u64,
    pub total_betting_duration_min_sec: u64,
    pub total_betting_duration_max_sec: u64,
    pub reserved: [u8; 12],
}

/// Borsh enum order: Filling=0 Sealing=1 Live=2 Settled=3 Void=4.
pub const STATUS_FILLING: u8 = 0;
pub const STATUS_SEALING: u8 = 1;
pub const STATUS_LIVE: u8 = 2;
pub const STATUS_SETTLED: u8 = 3;
pub const STATUS_VOID: u8 = 4;

/// VoidKind order: None=0 FillingVoid=1 Emergency=2.
pub const VOID_KIND_NONE: u8 = 0;
pub const VOID_KIND_FILLING: u8 = 1;
pub const VOID_KIND_EMERGENCY: u8 = 2;

#[derive(BorshSerialize, BorshDeserialize, Clone, Debug)]
pub struct MatchAccountData {
    pub authority: Pubkey,
    pub mint: Pubkey,
    pub vault: Pubkey,
    pub match_id: u64,
    pub buy_in: u64,
    pub status: u8,
    pub config_hash: [u8; 32],
    pub price_token: [u8; 20],
    pub is_private: bool,
    pub room_commitment: [u8; 32],
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
    pub min_players: u8,
    pub max_players: u8,
    pub candidate_count: u8,
    pub confirmed_count: u8,
    pub sealed_count: u8,
    pub total_deposited: u64,
    pub total_fees: u64,
    pub settled_payout: u64,
    pub button_seed: [u8; 32],
    pub button: u8,
    pub button_set: bool,
    pub vault_bump: u8,
    pub bump: u8,
    pub fees_withdrawn: bool,
    pub void_kind: u8,
    pub reserved: [u8; 32],
}

#[derive(BorshSerialize, BorshDeserialize, Clone, Debug)]
pub struct SeatAccountData {
    pub match_key: Pubkey,
    pub player: Pubkey,
    pub deposit: u64,
    pub entry_fee_paid: u64,
    pub payout: u64,
    pub claimed: bool,
    pub bump: u8,
    pub room_commitment: [u8; 32],
    pub confirmed: bool,
    pub engine_seat: u8,
    pub prediction_commitment: [u8; 32],
    pub timelock_target: u64,
    pub commitment_set: bool,
    pub reserved: [u8; 8],
}

/// On-chain account sizes (incl. 8-byte discriminator) — used for getProgramAccounts
/// dataSize filters.
pub const SEAT_ACCOUNT_SPACE: u64 = 181;
pub const MATCH_ACCOUNT_SPACE: u64 = 441;

fn decode<T: BorshDeserialize>(data: &[u8], expected_disc: [u8; 8]) -> Result<T, DecodeError> {
    if data.len() < 8 {
        return Err(DecodeError::TooShort);
    }
    if data[0..8] != expected_disc {
        return Err(DecodeError::BadDiscriminator);
    }
    T::try_from_slice(&data[8..]).map_err(|_| DecodeError::Borsh)
}

pub fn decode_match(data: &[u8]) -> Result<MatchAccountData, DecodeError> {
    decode(data, disc::account("MatchAccount"))
}

pub fn decode_seat(data: &[u8]) -> Result<SeatAccountData, DecodeError> {
    decode(data, disc::account("SeatAccount"))
}

pub fn decode_protocol(data: &[u8]) -> Result<ProtocolStateData, DecodeError> {
    decode(data, disc::account("ProtocolState"))
}
