//! On-chain account state for the Syndicate program (v2).

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
    /// Operator-governed match-creation bounds (config_admin). A match's `buy_in` must lie in
    /// `[buy_in_min, buy_in_max]`, its fill window in `[fill_window_min_sec, fill_window_max_sec]`,
    /// and its total betting duration in `[total_betting_duration_min_sec, total_betting_duration_max_sec]`,
    /// enforced on-chain at create. Params are otherwise free-form (config_hash binds them).
    pub buy_in_min: u64,
    pub buy_in_max: u64,
    pub fill_window_min_sec: u64,
    pub fill_window_max_sec: u64,
    pub total_betting_duration_min_sec: u64,
    pub total_betting_duration_max_sec: u64,
    pub reserved: [u8; 12],
}

impl ProtocolState {
    pub const SPACE: usize = 8 + 32 * 8 + 20 + 1 + 1 + 1 + 8 * 6 + 12;
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub enum MatchStatus {
    /// Accepting deposits (seat candidates).
    Filling,
    /// Confirmed set frozen at `lock`; predictions being time-lock-sealed on-chain.
    Sealing,
    /// Match running; deposits locked.
    Live,
    /// Final settlement recorded; payouts claimable by confirmed seats, refunds by
    /// unconfirmed candidates.
    Settled,
    /// Aborted — full refund (`deposit + entry_fee_paid`) to every seat.
    Void,
}

/// Why a match voided. Retained for audit; in v2 every void refunds the full
/// `deposit + entry_fee_paid` regardless of kind.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub enum VoidKind {
    /// Not voided.
    None,
    /// Voided before going Live (fill deadline passed, or stuck in Sealing).
    FillingVoid,
    /// Operator emergency void or permissionless deadline void.
    Emergency,
}

impl Default for VoidKind {
    fn default() -> Self {
        Self::None
    }
}

/// One match. Holds the fee config, the bound-config hash (canonical hash of the full
/// creator-chosen param set), the private-room commitment, on-chain timing, the
/// commitment-derived button seed, and running totals. Custody of funds lives in the
/// associated `vault` token account PDA.
///
/// v2 seating model: a deposit creates a seat CANDIDATE. The backend confirms the playing
/// set at `lock` (FCFS by deposit finality, room-code-verified off-chain); only confirmed
/// seats play. Unconfirmed candidates can `refund` the moment the match leaves Filling.
#[account]
pub struct MatchAccount {
    pub authority: Pubkey, // creator (player); never grants lifecycle power
    pub mint: Pubkey,      // chips_token (e.g. USDC)
    pub vault: Pubkey,     // token account PDA holding all deposits + fees
    pub match_id: u64,     // PDA seed; lets handlers reconstruct signer seeds
    pub buy_in: u64,       // fixed stack per seat (chips)
    pub status: MatchStatus,
    /// Canonical SHA-256 of the full creator-chosen param set (streets, durations, feed,
    /// buy-in, fees…). Not interpreted on-chain; binds the off-chain config for audit.
    pub config_hash: [u8; 32],
    /// 20-byte token/feed identifier signed by the signed-price-server.
    pub price_token: [u8; 20],
    /// True for private rooms (room-code gated off-chain, commitment recorded here).
    pub is_private: bool,
    /// `sha256(roomcode ‖ creator_pubkey)` for private rooms; all zero for public.
    pub room_commitment: [u8; 32],

    // ---- Timing (derived on-chain; trustless settlement window) ----
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
    /// call `begin_live`. Keeps `scheduled_end_ts` tightly pinned to the seal round so a
    /// timelock target can't be decrypted mid-match.
    pub begin_live_window_sec: u64,

    // ---- Signed price (company attestation) ----
    pub max_oracle_confidence: u64,
    pub oracle_exponent: i32,
    /// EIP-191 hash of the signed server price accepted at settlement.
    pub signed_price_hash: [u8; 32],
    /// Signed server timestamp accepted at settlement, in Unix milliseconds.
    pub signed_price_timestamp_ms: u64,

    // ---- Economics ----
    pub entry_fee: u64, // fee taken on join; returned to unconfirmed candidates
    pub rake_bps: u32,  // pot rake
    pub rake_cap: u64,
    pub min_players: u8,
    pub max_players: u8,
    /// Deposits recorded (confirmed or not). Bounded by `MAX_CANDIDATES`.
    pub candidate_count: u8,
    /// Seats confirmed into the playing set at `lock`. Settlement covers exactly this many.
    pub confirmed_count: u8,
    /// Confirmed seats that recorded a seal commitment by `seal_deadline_ts` (audit; set
    /// at begin_live). Non-sealers still play — backend assigns the seal-close spot price.
    pub sealed_count: u8,
    /// Gross candidate inflow (buy-ins + entry fees). Audit total, NOT the pot.
    pub total_deposited: u64,
    /// Confirmed entry fees (set at lock) + pot rake (added at settlement). Treasury-bound.
    pub total_fees: u64,
    pub settled_payout: u64, // sum of per-seat payouts written at settlement

    // ---- Button (derived on-chain at begin_live from seal commitments) ----
    /// keccak256 digest over the confirmed seats' seal data (normative preimage in
    /// `begin_live`); recorded for audit/re-derivation.
    pub button_seed: [u8; 32],
    /// Dealer button engine-seat index: `u64::from_le(seed[0..8]) % confirmed_count`.
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
        + 1                               // is_private
        + 32                              // room_commitment
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
        + 1 * 5                           // min_players, max_players, candidate_count,
                                          //   confirmed_count, sealed_count
        + 8                               // total_deposited
        + 8                               // total_fees
        + 8                               // settled_payout
        + 32                              // button_seed
        + 1                               // button
        + 1                               // button_set
        + 1                               // vault_bump
        + 1                               // bump
        + 1                               // fees_withdrawn
        + 1                               // void_kind
        + 32; // reserved
}

/// One player's seat in a match. A deposit creates the seat as an unconfirmed CANDIDATE;
/// `lock` flips `confirmed` and assigns `engine_seat` for the playing set. The seal
/// commitment is recorded during Sealing (confirmed seats only). `payout` is written at
/// settlement; `refund` pays `deposit + entry_fee_paid`. Pull-based, idempotent via
/// `claimed`; account closes to the player on claim/refund.
#[account]
pub struct SeatAccount {
    pub match_key: Pubkey,
    pub player: Pubkey,
    pub deposit: u64, // buy-in -> starting stack (chips)
    pub entry_fee_paid: u64,
    pub payout: u64, // claimable winnings+returns, set at settlement
    pub claimed: bool,
    pub bump: u8,
    /// `sha256(roomcode ‖ player_pubkey)` for private rooms (audit binding; enforcement is
    /// backend confirm-at-lock); all zero for public rooms.
    pub room_commitment: [u8; 32],
    /// True once the backend confirmed this seat into the playing set at `lock`.
    pub confirmed: bool,
    /// Contiguous engine seat index (position in the confirmed set passed to `lock`);
    /// `NO_ENGINE_SEAT` until confirmed. The engine + settlement index by this.
    pub engine_seat: u8,

    // ---- Seal (recorded during Sealing, before LIVE) ----
    /// Hash of the time-lock ciphertext (prediction commitment).
    pub prediction_commitment: [u8; 32],
    /// drand round the prediction is time-lock encrypted to (match end).
    pub timelock_target: u64,
    /// True once a valid commitment was recorded at or before `seal_deadline_ts`.
    pub commitment_set: bool,

    pub reserved: [u8; 8],
}

/// Sentinel `engine_seat` for a seat not (yet) confirmed into the playing set.
pub const NO_ENGINE_SEAT: u8 = u8::MAX;

impl SeatAccount {
    pub const SPACE: usize = 8 // discriminator
        + 32 // match_key
        + 32 // player
        + 8  // deposit
        + 8  // entry_fee_paid
        + 8  // payout
        + 1  // claimed
        + 1  // bump
        + 32 // room_commitment
        + 1  // confirmed
        + 1  // engine_seat
        + 32 // prediction_commitment
        + 8  // timelock_target
        + 1  // commitment_set
        + 8; // reserved
}
