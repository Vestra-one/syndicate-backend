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
}

#[derive(BorshSerialize, BorshDeserialize, Clone)]
pub struct CreateParams {
    pub match_id: u64,
    pub buy_in: u64,
    pub entry_fee: u64,
    pub rake_bps: u32,
    pub rake_cap: u64,
    pub min_players: u8,
    pub max_players: u8,
    pub config_hash: [u8; 32],
    pub price_feed_id: [u8; 32],
    pub scheduled_end_ts: u64,
    pub oracle_delay_window_sec: u64,
    pub max_oracle_confidence: u64,
    pub oracle_exponent: i32,
}

#[derive(BorshSerialize, BorshDeserialize, Clone)]
pub struct InitActionLogParams {
    pub button: u8,
    pub small_blind: u64,
    pub big_blind: u64,
    pub round_count: u8,
    pub settle_deadline_ts: u64,
    pub seal_seq: [u64; 5],
}

#[derive(BorshSerialize, BorshDeserialize, Clone)]
pub struct RegisterDefaultPolicyArgs {
    pub seat_index: u16,
    pub policy_tag: u8,
    pub ed25519_ix_index: u8,
}

#[derive(BorshSerialize, BorshDeserialize, Clone)]
pub struct AppendPlayerActionArgs {
    pub seat_index: u16,
    pub nonce: u64,
    pub action_tag: u8,
    pub amount: u64,
    pub ed25519_ix_index: u8,
}

#[derive(BorshSerialize, BorshDeserialize, Clone)]
pub struct AppendTimeoutActionArgs {
    pub seat_index: u16,
}

#[derive(BorshSerialize, BorshDeserialize, Clone, Copy, Default)]
pub enum OnChainDefaultPolicy {
    #[default]
    Unset,
    CheckFold,
    CheckCallAny,
}

#[derive(BorshSerialize, BorshDeserialize, Clone, Default)]
pub struct SeatMeta {
    pub player: Pubkey,
    pub nonce: u64,
    pub default_policy: OnChainDefaultPolicy,
    pub default_set: bool,
    pub prediction_commitment: [u8; 32],
    pub seal_seq: u64,
    pub commitment_set: bool,
    pub occupied: bool,
}

#[derive(BorshSerialize, BorshDeserialize, Clone)]
pub struct ActionLogAccount {
    pub match_key: Pubkey,
    pub head: [u8; 32],
    pub event_root: [u8; 32],
    pub finalized: bool,
    pub action_count: u32,
    pub player_count: u8,
    pub scheduled_end_ts: u64,
    pub settle_deadline_ts: u64,
    pub engine_bytes: Vec<u8>,
    pub seats: [SeatMeta; 5],
    pub bump: u8,
}
