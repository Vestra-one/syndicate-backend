//! On-chain account state for the Syndicate program.

use anchor_lang::prelude::*;

/// Global protocol controls and role registry.
#[account]
pub struct ProtocolState {
    pub protocol_admin: Pubkey,
    pub settlement_admin: Pubkey,
    pub emergency_void_admin: Pubkey,
    pub pause_admin: Pubkey,
    pub config_admin: Pubkey,
    pub fee_admin: Pubkey,
    pub treasury_admin: Pubkey,
    pub upgrade_authority: Pubkey,
    pub pause_new_matches: bool,
    pub pause_settlement: bool,
    pub bump: u8,
    pub reserved: [u8; 32],
}

impl ProtocolState {
    pub const SPACE: usize = 8 + 32 * 8 + 1 + 1 + 1 + 32;
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub enum MatchStatus {
    /// Accepting deposits (seats open).
    Filling,
    /// Seats frozen; predictions being time-lock-sealed off-chain.
    Sealing,
    /// Match running; deposits locked.
    Live,
    /// Final, verified settlement recorded; payouts claimable.
    Settled,
    /// Aborted — full refunds (entry fee included), no rake.
    Void,
}

/// One match. Holds the fee config, the bound-config hash (replay anchor), running
/// totals, and the vault bump. Custody of funds lives in the associated `vault` token
/// account PDA.
#[account]
pub struct MatchAccount {
    pub authority: Pubkey, // operator/creator
    pub mint: Pubkey,      // chips_token (e.g. USDC)
    pub vault: Pubkey,     // token account PDA holding all deposits + fees
    pub match_id: u64,     // PDA seed; lets handlers reconstruct signer seeds
    pub buy_in: u64,       // fixed stack per seat (chips)
    pub status: MatchStatus,
    pub config_hash: [u8; 32], // hash of the bound MatchConfig (04 §2, §18 replay anchor)
    pub price_feed_id: [u8; 32], // bound Pyth feed id
    pub scheduled_end_ts: u64, // lower bound for bounded exact-after settlement
    pub oracle_delay_window_sec: u64,
    pub max_oracle_confidence: u64,
    pub oracle_exponent: i32,
    pub entry_fee: u64, // fee taken on join (04 §14)
    pub rake_bps: u32,  // pot rake (04 §14)
    pub rake_cap: u64,
    pub min_players: u8,
    pub max_players: u8,
    pub player_count: u8,
    pub total_deposited: u64, // sum of buy-ins (stacks), excludes entry fees
    pub total_fees: u64,      // entry fees + pot rake accumulated
    pub settled_payout: u64,  // sum of per-seat payouts written at settlement
    pub vault_bump: u8,
    pub bump: u8,
    /// VRF output recorded at SEALING (audit/replay anchor).
    pub vrf_seed: [u8; 32],
    /// Hash of the VRF proof bytes (provider-specific; recorded for audit).
    pub vrf_proof_hash: [u8; 32],
    /// Dealer button seat index, derived deterministically from `vrf_seed`.
    pub button: u8,
    pub button_set: bool,
    pub fees_withdrawn: bool,
    pub reserved: [u8; 32],
}

impl MatchAccount {
    pub const SPACE: usize = 8
        + 32 * 3
        + 8
        + 8
        + 1
        + 32
        + 32
        + 8
        + 8
        + 8
        + 4
        + 8
        + 4
        + 8
        + 1
        + 1
        + 1
        + 8
        + 8
        + 8
        + 1
        + 1
        + 32
        + 32
        + 1
        + 1
        + 1
        + 32;
}

/// One player's seat in a match. `payout` is written during verified settlement; the
/// player then `claim`s it (pull-based, idempotent via `claimed`).
#[account]
pub struct SeatAccount {
    pub match_key: Pubkey,
    pub player: Pubkey,
    pub seat_index: u16, // maps to syndicate_shared::PlayerId
    pub deposit: u64,    // buy-in -> starting stack (chips)
    pub entry_fee_paid: u64,
    pub payout: u64, // claimable winnings+returns, set at settlement
    pub claimed: bool,
    pub bump: u8,
    pub reserved: [u8; 8],
}

impl SeatAccount {
    pub const SPACE: usize = 8 + 32 + 32 + 2 + 8 + 8 + 8 + 1 + 1 + 8;
}

/// One PDA per occupied seat index, preventing duplicate seat numbers in a match.
#[account]
pub struct SeatIndexAccount {
    pub match_key: Pubkey,
    pub player: Pubkey,
    pub seat_index: u16,
    pub bump: u8,
    pub reserved: [u8; 8],
}

impl SeatIndexAccount {
    pub const SPACE: usize = 8 + 32 + 32 + 2 + 1 + 8;
}
