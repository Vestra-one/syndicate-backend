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
    /// Ethereum/secp256k1 address allowed to attest settlement prices.
    pub price_signer: [u8; 20],
    pub pause_new_matches: bool,
    pub pause_settlement: bool,
    pub bump: u8,
    pub reserved: [u8; 12],
}

impl ProtocolState {
    pub const SPACE: usize = 8 + 32 * 8 + 20 + 1 + 1 + 1 + 12;
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub enum MatchStatus {
    /// Accepting deposits (seats open).
    Filling,
    /// Seats frozen; predictions being time-lock-sealed on-chain (commitment recorded
    /// here, before LIVE — the §207 seal-before-LIVE guarantee, plan_v2 §1).
    Sealing,
    /// Match running; deposits locked.
    Live,
    /// Final, verified settlement recorded; payouts claimable.
    Settled,
    /// Aborted — refunds per `void_kind` (plan_v2 §3/§5).
    Void,
}

/// Why a match voided. Drives the per-seat refund computation (plan_v2 §5), so a
/// pull-based `refund` can pay the exact amount without scanning every seat.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub enum VoidKind {
    /// Not voided.
    None,
    /// Voided while still Filling (never locked): full refund, no penalty.
    FillingVoid,
    /// Voided at begin_live because fewer than `min_players` sealed: sealers get a full
    /// refund plus a pro-rata share of the non-sealer penalty pool; non-sealers get
    /// `deposit - penalty` (entry fee forfeited to treasury).
    UnderMinSealed,
    /// Operator emergency void or permissionless deadline void: full refund to all,
    /// penalties waived.
    Emergency,
}

impl Default for VoidKind {
    fn default() -> Self {
        Self::None
    }
}

/// One match. Holds the fee config, the bound-config hash (replay anchor), on-chain
/// timing (`lock_ts`/`seal_deadline_ts`/`live_start_ts`/`scheduled_end_ts`), the drand
/// button commitment, the non-sealer penalty pool, and running totals. Custody of funds
/// lives in the associated `vault` token account PDA.
#[account]
pub struct MatchAccount {
    pub authority: Pubkey, // creator (player or operator); never grants lifecycle power
    pub mint: Pubkey,      // chips_token (e.g. USDC)
    pub vault: Pubkey,     // token account PDA holding all deposits + fees
    pub match_id: u64,     // PDA seed; lets handlers reconstruct signer seeds
    pub buy_in: u64,       // fixed stack per seat (chips)
    pub status: MatchStatus,
    pub config_hash: [u8; 32], // hash of the bound MatchConfig (replay anchor)
    /// 20-byte token/feed identifier signed by the signed-price-server.
    pub price_token: [u8; 20],

    // ---- Timing (derived on-chain; trustless settlement window, plan_v2 §1/§2) ----
    /// Fill deadline; after this, permissionless `void_before_start` if still Filling.
    pub fill_deadline_ts: u64,
    /// Set at `lock`: Clock::now when Filling -> Sealing.
    pub lock_ts: u64,
    /// `lock_ts + seal_window_sec`; seals must be recorded at or before this.
    pub seal_deadline_ts: u64,
    /// Set at `begin_live`: Clock::now when Sealing -> Live.
    pub live_start_ts: u64,
    /// `live_start_ts + total_betting_duration_sec`; oracle window anchor.
    pub scheduled_end_ts: u64,
    /// Bound at create: total wall-clock betting span (Σ street durations + observation).
    pub total_betting_duration_sec: u64,
    /// Bound at create: SEALING window length.
    pub seal_window_sec: u64,
    /// Bound at create: max delay after `seal_deadline_ts` within which the operator must
    /// call `begin_live` (default 5s). Keeps `scheduled_end_ts` tightly pinned to the seal
    /// round so a timelock target can't be decrypted mid-match (plan_v2 §I hardening).
    pub begin_live_window_sec: u64,

    // ---- Signed price (manager/company attestation) ----
    pub max_oracle_confidence: u64,
    pub oracle_exponent: i32,
    /// EIP-191 hash of the signed server price accepted at settlement.
    pub signed_price_hash: [u8; 32],
    /// Signed server timestamp accepted at settlement, in Unix milliseconds.
    pub signed_price_timestamp_ms: u64,

    // ---- Economics ----
    pub entry_fee: u64, // fee taken on join
    pub rake_bps: u32,  // pot rake
    pub rake_cap: u64,
    /// Non-sealer penalty in basis points of `buy_in` (plan_v2 §5). Bound in config_hash.
    pub nonseal_penalty_bps: u32,
    pub min_players: u8,
    pub max_players: u8,
    pub player_count: u8,
    /// Seats that recorded a seal commitment by `seal_deadline_ts` (set at begin_live).
    pub sealed_count: u8,
    /// Monotonic seal-order counter assigned on-chain (arrival order) so a player cannot
    /// claim `seal_seq = 0` to grab tie-remainders. Each commitment takes the current
    /// value, then increments.
    pub next_seal_seq: u64,
    pub total_deposited: u64, // sum of buy-ins (stacks), excludes entry fees
    pub total_fees: u64,      // entry fees + pot rake accumulated (treasury-bound)
    /// Non-sealer entry fees forfeited to treasury (withdrawable post-terminal).
    pub forfeited_fees: u64,
    /// Non-sealer penalty pool: Live -> injected into the main pot at settlement;
    /// UnderMinSealed void -> split pro-rata among sealers (plan_v2 §4/§5).
    pub dead_money: u64,
    pub settled_payout: u64, // sum of per-seat payouts written at settlement

    // ---- Randomness (backend-native; low-risk, no on-chain verification — plan_v2 §3) ----
    /// Operator-supplied CSPRNG randomness recorded at `begin_live` for audit. Backend-
    /// native (NOT drand): the dealer button only sets blind/action order, so this is a
    /// deliberately low-stakes, server-attested value rather than a verified beacon.
    pub button_randomness: [u8; 32],
    /// Dealer button seat index (engine index), derived from `button_randomness`.
    pub button: u8,
    pub button_set: bool,

    // ---- Bumps / flags ----
    pub vault_bump: u8,
    pub bump: u8,
    pub fees_withdrawn: bool,
    pub void_kind: VoidKind,
    pub reserved: [u8; 32],
}

impl MatchAccount {
    pub const SPACE: usize = 8            // discriminator
        + 32 * 3                          // authority, mint, vault
        + 8                               // match_id
        + 8                               // buy_in
        + 1                               // status
        + 32                              // config_hash
        + 20                              // price_token
        + 8 * 8                           // fill_deadline_ts, lock_ts, seal_deadline_ts,
                                          //   live_start_ts, scheduled_end_ts,
                                          //   total_betting_duration_sec, seal_window_sec,
                                          //   begin_live_window_sec
        + 8                               // max_oracle_confidence
        + 4                               // oracle_exponent
        + 32                              // signed_price_hash
        + 8                               // signed_price_timestamp_ms
        + 8                               // entry_fee
        + 4                               // rake_bps
        + 8                               // rake_cap
        + 4                               // nonseal_penalty_bps
        + 1 * 4                           // min_players, max_players, player_count, sealed_count
        + 8                               // next_seal_seq
        + 8                               // total_deposited
        + 8                               // total_fees
        + 8                               // forfeited_fees
        + 8                               // dead_money
        + 8                               // settled_payout
        + 32                              // button_randomness
        + 1                               // button
        + 1                               // button_set
        + 1                               // vault_bump
        + 1                               // bump
        + 1                               // fees_withdrawn
        + 1                               // void_kind
        + 32; // reserved
}

/// One player's seat in a match. The seal commitment is recorded here DURING Sealing
/// (before LIVE), gated by `seal_deadline_ts` — the §207 fix. `payout` is written at
/// verified settlement; `refund` pays per `MatchAccount::void_kind`. Pull-based,
/// idempotent via `claimed`.
#[account]
pub struct SeatAccount {
    pub match_key: Pubkey,
    pub player: Pubkey,
    pub seat_index: u16, // deposit-time seat slot (PDA seed for SeatIndexAccount)
    pub deposit: u64,    // buy-in -> starting stack (chips)
    pub entry_fee_paid: u64,
    pub payout: u64, // claimable winnings+returns, set at settlement
    pub claimed: bool,
    pub bump: u8,

    // ---- Seal (recorded during Sealing, before LIVE — plan_v2 §1) ----
    /// Hash of the time-lock ciphertext (prediction commitment).
    pub prediction_commitment: [u8; 32],
    /// drand round the prediction is time-lock encrypted to (match end).
    pub timelock_target: u64,
    /// Deterministic seal order (earlier seal => smaller). Tiebreak for remainders.
    pub seal_seq: u64,
    /// True once a valid commitment was recorded at or before `seal_deadline_ts`.
    pub commitment_set: bool,

    // ---- begin_live outcome (plan_v2 §5) ----
    /// True if this seat had the seal window but did not commit (dropped + penalized).
    pub is_non_sealer: bool,
    /// Penalty forfeited to the pot/sealers if `is_non_sealer` (= buy_in * penalty_bps).
    pub penalty: u64,
    /// Contiguous engine seat index assigned to a sealer at begin_live; `NO_ENGINE_SEAT`
    /// for dropped non-sealers. The engine + settlement index by this, not `seat_index`.
    pub engine_seat: u8,
    /// On an UnderMinSealed void, the one sealer that receives the penalty-pool remainder.
    pub gets_remainder: bool,

    pub reserved: [u8; 8],
}

/// Sentinel `engine_seat` for a dropped non-sealer (no engine slot).
pub const NO_ENGINE_SEAT: u8 = u8::MAX;

impl SeatAccount {
    pub const SPACE: usize = 8 // discriminator
        + 32 // match_key
        + 32 // player
        + 2  // seat_index
        + 8  // deposit
        + 8  // entry_fee_paid
        + 8  // payout
        + 1  // claimed
        + 1  // bump
        + 32 // prediction_commitment
        + 8  // timelock_target
        + 8  // seal_seq
        + 1  // commitment_set
        + 1  // is_non_sealer
        + 8  // penalty
        + 1  // engine_seat
        + 1  // gets_remainder
        + 8; // reserved
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
