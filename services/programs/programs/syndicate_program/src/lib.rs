//! # Syndicate on-chain program (Anchor) — v2
//!
//! Custody + final-settlement for Syndicate matches. The program is the source of truth
//! for funds and enforces capital safety (conservation + signed-price authenticity).
//!
//! **v2 trust model:** the backend is the sole source of truth for game outcomes. The
//! chain does NOT replay action logs or re-derive payouts; it accepts backend-computed
//! per-seat payouts and only verifies that (a) the settlement price is signed by the
//! trusted `price_signer` at exactly `scheduled_end_ts`, and (b) total payouts + rake ==
//! confirmed deposits.
//!
//! **v2 seating model (candidate → confirm-at-lock):** a deposit creates a seat
//! CANDIDATE only. The backend confirms the playing set at `lock` (FCFS by deposit
//! finality; private-room codes verified off-chain against the recorded commitments).
//! Only confirmed seats play; unconfirmed candidates can `refund` in full the moment the
//! match leaves Filling.
//!
//! **v2 sealing model:** non-sealers are NOT dropped. Every confirmed seat plays; the
//! backend assigns the feed spot price at seal-close to seats without a commitment. The
//! dealer button derives on-chain from the recorded seal commitments.

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};
use solana_keccak_hasher as keccak;

pub mod action_handlers;
pub mod error;
pub mod settle_args;
pub mod signed_price;
pub mod state;

use action_handlers::{
    register_prediction_commitment_handler, RegisterPredictionCommitmentArgs,
};
use error::SyndicateError;
use settle_args::SettleArgs;
use state::{MatchAccount, MatchStatus, ProtocolState, SeatAccount};

declare_id!("91BSZ2pEGCk7Scq9bnfTwrHCYGo8CzGBq5mbpKHAR5FK");

/// Pinned drand beacon (League of Entropy `quicknet`, 3s period, time-lock capable).
/// Used to bound each seat's `timelock_target` to publish AFTER projected match end.
/// Round expected publish time = `DRAND_GENESIS_TIME + round * DRAND_PERIOD_SEC`.
pub const DRAND_GENESIS_TIME: u64 = 1_692_803_367;
pub const DRAND_PERIOD_SEC: u64 = 3;

/// Grace after `seal_deadline_ts` before a stuck Sealing match can be permissionlessly
/// voided (operator failed to `begin_live`).
pub const SEAL_VOID_GRACE_SEC: u64 = 60;

/// Generous last-resort grace after `scheduled_end_ts` before a stuck LIVE match can be
/// permissionlessly voided. An honest operator settles within seconds-to-a-minute of
/// match end; this backstop only fires if settlement never lands, so capital can never
/// strand. MatchAccount-only.
pub const SETTLE_VOID_GRACE_SEC: u64 = 300;

/// Maximum slack after the LATEST possible match end within which a prediction's
/// `timelock_target` round must publish. Bounds the seal both sides — a player cannot
/// seal to a far-future round that is undecryptable at settlement (a cheap grief), and
/// the key materializes ~20s after match end, keeping settlement live.
pub const MAX_TIMELOCK_SKEW_SEC: u64 = 20;

/// Default `begin_live_window_sec` if a caller passes 0 (operator must go live within
/// this many seconds of the seal deadline).
pub const DEFAULT_BEGIN_LIVE_WINDOW_SEC: u64 = 30;

/// Hard cap on seat candidates per match (anti-spam bound on lock-time scan work; each
/// candidate escrows the full buy-in + entry fee, so spam is capital-expensive anyway).
pub const MAX_CANDIDATES: u8 = 32;

/// Hard cap on the sealing window (keeps `latest_match_end` — and thus the timelock
/// target window — from drifting arbitrarily far).
pub const MAX_SEAL_WINDOW_SEC: u64 = 600;

/// Hard cap on the operator's begin_live window (same rationale).
pub const MAX_BEGIN_LIVE_WINDOW_SEC: u64 = 300;

/// Domain-separation prefix for the on-chain dealer-button derivation.
pub const BUTTON_DOMAIN: &[u8] = b"syndicate:button:v2";

/// Expected unix publish time (seconds) of a drand round for the pinned beacon.
pub fn drand_round_publish_ts(round: u64) -> Option<u64> {
    round
        .checked_mul(DRAND_PERIOD_SEC)?
        .checked_add(DRAND_GENESIS_TIME)
}

#[program]
pub mod syndicate_program {
    use super::*;

    /// Initialize the global protocol role registry and pause flags.
    pub fn initialize_protocol(
        ctx: Context<InitializeProtocol>,
        roles: ProtocolRoles,
        bounds: MatchBounds,
    ) -> Result<()> {
        require_keys_eq!(
            ctx.accounts.authority.key(),
            roles.protocol_admin,
            SyndicateError::Unauthorized
        );
        require!(roles.all_non_default(), SyndicateError::Unauthorized);
        bounds.validate()?;
        let p = &mut ctx.accounts.protocol_state;
        p.protocol_admin = roles.protocol_admin;
        p.settlement_admin = roles.settlement_admin;
        p.emergency_void_admin = roles.emergency_void_admin;
        p.pause_admin = roles.pause_admin;
        p.config_admin = roles.config_admin;
        p.fee_admin = roles.fee_admin;
        p.treasury_admin = roles.treasury_admin;
        p.upgrade_authority = roles.upgrade_authority;
        p.price_signer = roles.price_signer;
        p.pause_new_matches = false;
        p.pause_settlement = false;
        p.bump = ctx.bumps.protocol_state;
        p.buy_in_min = bounds.buy_in_min;
        p.buy_in_max = bounds.buy_in_max;
        p.fill_window_min_sec = bounds.fill_window_min_sec;
        p.fill_window_max_sec = bounds.fill_window_max_sec;
        p.total_betting_duration_min_sec = bounds.total_betting_duration_min_sec;
        p.total_betting_duration_max_sec = bounds.total_betting_duration_max_sec;
        p.reserved = [0u8; 12];
        Ok(())
    }

    /// Pause/unpause new exposure or settlement submission. Claims/refunds remain live.
    pub fn set_pauses(
        ctx: Context<ProtocolAdmin>,
        pause_new_matches: bool,
        pause_settlement: bool,
    ) -> Result<()> {
        let p = &mut ctx.accounts.protocol_state;
        require_keys_eq!(
            ctx.accounts.authority.key(),
            p.pause_admin,
            SyndicateError::Unauthorized
        );
        p.pause_new_matches = pause_new_matches;
        p.pause_settlement = pause_settlement;
        Ok(())
    }

    /// Rotate the Ethereum/secp256k1 address trusted for signed settlement prices.
    pub fn set_price_signer(ctx: Context<ProtocolAdmin>, price_signer: [u8; 20]) -> Result<()> {
        let p = &mut ctx.accounts.protocol_state;
        require_keys_eq!(
            ctx.accounts.authority.key(),
            p.config_admin,
            SyndicateError::Unauthorized
        );
        require!(price_signer != [0u8; 20], SyndicateError::InvalidConfig);
        p.price_signer = price_signer;
        Ok(())
    }

    /// Update the operator-governed match-creation bounds (config_admin). New matches must
    /// pick buy-in / fill window / total betting duration within these ranges.
    pub fn set_match_bounds(ctx: Context<ProtocolAdmin>, bounds: MatchBounds) -> Result<()> {
        let p = &mut ctx.accounts.protocol_state;
        require_keys_eq!(
            ctx.accounts.authority.key(),
            p.config_admin,
            SyndicateError::Unauthorized
        );
        bounds.validate()?;
        p.buy_in_min = bounds.buy_in_min;
        p.buy_in_max = bounds.buy_in_max;
        p.fill_window_min_sec = bounds.fill_window_min_sec;
        p.fill_window_max_sec = bounds.fill_window_max_sec;
        p.total_betting_duration_min_sec = bounds.total_betting_duration_min_sec;
        p.total_betting_duration_max_sec = bounds.total_betting_duration_max_sec;
        Ok(())
    }

    /// Create a match. **Permissionless**: any signer may create; the signer becomes
    /// `m.authority` but that grants NO lifecycle power — `lock`/`begin_live`/
    /// `submit_settlement` remain gated to operator ROLE keys.
    pub fn create_match(ctx: Context<CreateMatch>, params: CreateParams) -> Result<()> {
        require!(
            !ctx.accounts.protocol_state.pause_new_matches,
            SyndicateError::Paused
        );
        let now = Clock::get()?.unix_timestamp as u64;
        validate_create_params(&params, &ctx.accounts.protocol_state)?;
        let authority = ctx.accounts.authority.key();
        let mint = ctx.accounts.mint.key();
        let vault = ctx.accounts.vault.key();
        populate_match_account(
            &mut ctx.accounts.match_account,
            &params,
            now,
            authority,
            mint,
            vault,
            ctx.bumps.vault,
            ctx.bumps.match_account,
        );
        Ok(())
    }

    /// Atomic create + seat the creator (as the first CANDIDATE) in a single instruction.
    /// The creator (`authority`) is both the payer and the first depositor; their seat's
    /// `room_commitment` is the match's `room_commitment` (hash(roomcode ‖ creator) for
    /// private rooms, zero for public).
    pub fn create_and_deposit(ctx: Context<CreateAndDeposit>, params: CreateParams) -> Result<()> {
        require!(
            !ctx.accounts.protocol_state.pause_new_matches,
            SyndicateError::Paused
        );
        let now = Clock::get()?.unix_timestamp as u64;
        validate_create_params(&params, &ctx.accounts.protocol_state)?;

        let authority = ctx.accounts.authority.key();
        let mint = ctx.accounts.mint.key();
        let vault_key = ctx.accounts.vault.key();
        let room_commitment = params.room_commitment;
        populate_match_account(
            &mut ctx.accounts.match_account,
            &params,
            now,
            authority,
            mint,
            vault_key,
            ctx.bumps.vault,
            ctx.bumps.match_account,
        );

        // Seat the creator atomically (same path as `deposit`).
        let buy_in = params.buy_in;
        let entry_fee = params.entry_fee;
        let amount = buy_in
            .checked_add(entry_fee)
            .ok_or(SyndicateError::Overflow)?;
        deposit_into_vault(
            amount,
            &ctx.accounts.player_token,
            &ctx.accounts.vault,
            &ctx.accounts.authority,
            &ctx.accounts.token_program,
        )?;

        let match_key = ctx.accounts.match_account.key();
        write_seat(
            &mut ctx.accounts.seat,
            match_key,
            authority,
            buy_in,
            entry_fee,
            room_commitment,
            ctx.bumps.seat,
        );

        let m = &mut ctx.accounts.match_account;
        m.total_deposited = m
            .total_deposited
            .checked_add(amount)
            .ok_or(SyndicateError::Overflow)?;
        m.candidate_count += 1;
        Ok(())
    }

    /// Deposit buy-in + entry fee → seat CANDIDACY. Confirmation happens at `lock`
    /// (backend FCFS by deposit finality). For private rooms, `join_commitment` must be
    /// `sha256(roomcode ‖ player_pubkey)` (recorded for audit; verified off-chain by the
    /// backend before confirming the seat). Entry fees are NOT accrued to the treasury
    /// here — unconfirmed candidates get them back in full via `refund`.
    pub fn deposit(ctx: Context<Deposit>, join_commitment: [u8; 32]) -> Result<()> {
        require!(
            !ctx.accounts.protocol_state.pause_new_matches,
            SyndicateError::Paused
        );
        let now = Clock::get()?.unix_timestamp as u64;
        {
            let m = &ctx.accounts.match_account;
            require!(m.status == MatchStatus::Filling, SyndicateError::BadStatus);
            require!(
                m.candidate_count < MAX_CANDIDATES,
                SyndicateError::CandidateLimitReached
            );
            // Room binding: private rooms require a commitment, public rooms forbid one.
            require!(
                m.is_private == (join_commitment != [0u8; 32]),
                SyndicateError::InvalidRoomCommitment
            );
            // Do not join a room past its fill deadline (it is about to VOID or lock).
            require!(now <= m.fill_deadline_ts, SyndicateError::BadStatus);
        }

        let buy_in = ctx.accounts.match_account.buy_in;
        let entry_fee = ctx.accounts.match_account.entry_fee;
        let amount = buy_in
            .checked_add(entry_fee)
            .ok_or(SyndicateError::Overflow)?;
        deposit_into_vault(
            amount,
            &ctx.accounts.player_token,
            &ctx.accounts.vault,
            &ctx.accounts.player,
            &ctx.accounts.token_program,
        )?;

        let match_key = ctx.accounts.match_account.key();
        let player = ctx.accounts.player.key();
        write_seat(
            &mut ctx.accounts.seat,
            match_key,
            player,
            buy_in,
            entry_fee,
            join_commitment,
            ctx.bumps.seat,
        );

        let m = &mut ctx.accounts.match_account;
        m.total_deposited = m
            .total_deposited
            .checked_add(amount)
            .ok_or(SyndicateError::Overflow)?;
        m.candidate_count += 1;
        Ok(())
    }

    /// Lock the match: confirm the playing set and freeze it, status → Sealing.
    ///
    /// `remaining_accounts` = the confirmed seat PDAs (writable), in the backend's FCFS
    /// order — position `i` becomes `engine_seat = i`. Everything else stays a candidate
    /// and becomes refundable immediately (see `refund`). Confirmed entry fees accrue to
    /// the treasury here. Operator-gated.
    pub fn lock<'info>(ctx: Context<'_, '_, 'info, 'info, AdminMatch<'info>>) -> Result<()> {
        let p = &ctx.accounts.protocol_state;
        require!(
            ctx.accounts.authority.key() == p.settlement_admin
                || ctx.accounts.authority.key() == p.config_admin,
            SyndicateError::Unauthorized
        );
        let now = Clock::get()?.unix_timestamp as u64;
        let match_key = ctx.accounts.match_account.key();
        let m = &mut ctx.accounts.match_account;
        require!(m.status == MatchStatus::Filling, SyndicateError::BadStatus);

        let n = ctx.remaining_accounts.len();
        require!(
            n >= m.min_players as usize,
            SyndicateError::NotEnoughPlayers
        );
        require!(n <= m.max_players as usize, SyndicateError::SeatSetMismatch);

        for (i, acc) in ctx.remaining_accounts.iter().enumerate() {
            let mut seat: Account<SeatAccount> = Account::try_from(acc)?;
            require_keys_eq!(seat.match_key, match_key, SyndicateError::Unauthorized);
            let (expected, _bump) = Pubkey::find_program_address(
                &[b"seat", match_key.as_ref(), seat.player.as_ref()],
                &crate::ID,
            );
            require_keys_eq!(expected, acc.key(), SyndicateError::Unauthorized);
            // Duplicate guard: `exit` serializes `confirmed = true` back before the next
            // iteration reads, so passing the same seat twice trips this.
            require!(!seat.confirmed, SyndicateError::SeatSetMismatch);
            seat.confirmed = true;
            seat.engine_seat = i as u8;
            seat.exit(&crate::ID)?;
        }

        m.confirmed_count = n as u8;
        m.total_fees = (n as u64)
            .checked_mul(m.entry_fee)
            .ok_or(SyndicateError::Overflow)?;
        m.lock_ts = now;
        m.seal_deadline_ts = now
            .checked_add(m.seal_window_sec)
            .ok_or(SyndicateError::Overflow)?;
        m.status = MatchStatus::Sealing;
        Ok(())
    }

    pub fn register_prediction_commitment(
        ctx: Context<RegisterPredictionCommitment>,
        args: RegisterPredictionCommitmentArgs,
    ) -> Result<()> {
        register_prediction_commitment_handler(ctx, args)
    }

    /// Advance Sealing → Live. Operator-gated; requires the seal deadline reached and the
    /// begin_live window open. Reads the confirmed seats (passed as `remaining_accounts`
    /// in engine order, read-only), counts sealers for audit, and derives the dealer
    /// button ON-CHAIN from the recorded seal commitments:
    ///
    /// ```text
    /// seed   = keccak256("syndicate:button:v2" ‖ match_key ‖ lock_ts(u64 LE)
    ///          ‖ for each confirmed seat in engine order:
    ///              player(32) ‖ commitment_set(1) ‖ prediction_commitment(32)
    ///              ‖ timelock_target(u64 LE))
    /// button = u64::from_le_bytes(seed[0..8]) % confirmed_count
    /// ```
    ///
    /// Non-sealers are NOT dropped (v2): every confirmed seat plays; the backend assigns
    /// the feed spot price at seal-close to seats without a commitment. Zero sealers is
    /// valid.
    pub fn begin_live<'info>(ctx: Context<'_, '_, 'info, 'info, AdminMatch<'info>>) -> Result<()> {
        let p = &ctx.accounts.protocol_state;
        require!(
            ctx.accounts.authority.key() == p.settlement_admin
                || ctx.accounts.authority.key() == p.config_admin,
            SyndicateError::Unauthorized
        );
        let now = Clock::get()?.unix_timestamp as u64;
        let match_key = ctx.accounts.match_account.key();
        let m = &mut ctx.accounts.match_account;
        require!(m.status == MatchStatus::Sealing, SyndicateError::BadStatus);
        require!(
            now >= m.seal_deadline_ts,
            SyndicateError::SealDeadlineNotReached
        );
        // Operator must go live within begin_live_window_sec of the seal deadline, so the
        // match end stays pinned to the seal round (timelock concealment). Miss it and the
        // match can only be permissionlessly voided (void_before_start).
        let begin_live_deadline = m
            .seal_deadline_ts
            .checked_add(m.begin_live_window_sec)
            .ok_or(SyndicateError::Overflow)?;
        require!(
            now <= begin_live_deadline,
            SyndicateError::BeginLiveWindowPassed
        );
        require!(
            ctx.remaining_accounts.len() == m.confirmed_count as usize,
            SyndicateError::SeatSetMismatch
        );

        // Single read pass: validate the engine-ordered confirmed set, count sealers,
        // and accumulate the button preimage.
        let lock_ts_le = m.lock_ts.to_le_bytes();
        let mut preimage: Vec<u8> = Vec::with_capacity(
            BUTTON_DOMAIN.len() + 32 + 8 + ctx.remaining_accounts.len() * (32 + 1 + 32 + 8),
        );
        preimage.extend_from_slice(BUTTON_DOMAIN);
        preimage.extend_from_slice(match_key.as_ref());
        preimage.extend_from_slice(&lock_ts_le);

        let mut sealed_count: u8 = 0;
        for (i, acc) in ctx.remaining_accounts.iter().enumerate() {
            let data = acc.try_borrow_data()?;
            let seat = SeatAccount::try_deserialize(&mut &data[..])?;
            require_keys_eq!(seat.match_key, match_key, SyndicateError::Unauthorized);
            let (expected, _b) = Pubkey::find_program_address(
                &[b"seat", match_key.as_ref(), seat.player.as_ref()],
                &crate::ID,
            );
            require_keys_eq!(expected, acc.key(), SyndicateError::Unauthorized);
            require!(
                seat.confirmed && seat.engine_seat == i as u8,
                SyndicateError::SeatSetMismatch
            );
            if seat.commitment_set {
                sealed_count += 1;
            }
            preimage.extend_from_slice(seat.player.as_ref());
            preimage.push(seat.commitment_set as u8);
            preimage.extend_from_slice(&seat.prediction_commitment);
            preimage.extend_from_slice(&seat.timelock_target.to_le_bytes());
        }

        let seed = keccak::hash(&preimage).to_bytes();
        let rnd = u64::from_le_bytes(seed[0..8].try_into().unwrap());

        m.sealed_count = sealed_count;
        m.button_seed = seed;
        m.button = (rnd % m.confirmed_count as u64) as u8;
        m.button_set = true;
        m.live_start_ts = now;
        m.scheduled_end_ts = now
            .checked_add(m.total_betting_duration_sec)
            .ok_or(SyndicateError::Overflow)?;
        m.status = MatchStatus::Live;
        Ok(())
    }

    /// Submit the final settlement (backend-trusted payouts).
    ///
    /// Verifies the signed price at exactly `scheduled_end_ts`, writes per-seat payouts
    /// supplied by the backend for ALL confirmed seats (non-sealers included — the
    /// backend settled them with the seal-close spot price), and enforces conservation:
    /// `Σ payouts == confirmed_count × buy_in − rake_collected`.
    ///
    /// Pass the confirmed seats as `remaining_accounts`.
    pub fn submit_settlement<'info>(
        ctx: Context<'_, '_, 'info, 'info, SubmitSettlement<'info>>,
        args: SettleArgs,
    ) -> Result<()> {
        let p = &ctx.accounts.protocol_state;
        require_keys_eq!(
            ctx.accounts.authority.key(),
            p.settlement_admin,
            SyndicateError::Unauthorized
        );
        require!(!p.pause_settlement, SyndicateError::Paused);

        let m = &mut ctx.accounts.match_account;
        require!(m.status == MatchStatus::Live, SyndicateError::BadStatus);
        require!(m.button_set, SyndicateError::ButtonNotSet);
        let match_key = m.key();
        let buy_in = m.buy_in;
        let confirmed_count = m.confirmed_count;

        require!(
            ctx.remaining_accounts.len() == confirmed_count as usize,
            SyndicateError::SeatSetMismatch
        );
        require!(
            args.payouts.len() == confirmed_count as usize,
            SyndicateError::SeatSetMismatch
        );

        let verified_signed_price =
            signed_price::verify_signed_price(&args.signed_price, p.price_signer)?;
        signed_price::validate_for_match(
            &verified_signed_price,
            &m.price_token,
            m.scheduled_end_ts,
            m.max_oracle_confidence,
            m.oracle_exponent,
        )?;

        let confirmed_deposited = (confirmed_count as u64)
            .checked_mul(buy_in)
            .ok_or(SyndicateError::Overflow)?;
        require!(
            args.rake_collected <= confirmed_deposited,
            SyndicateError::ConservationViolation
        );
        require!(
            args.rake_collected <= m.rake_cap,
            SyndicateError::ConservationViolation
        );

        let mut payout_by_engine = [None::<u64>; 5];
        for p in &args.payouts {
            let idx = p.engine_seat as usize;
            require!(idx < confirmed_count as usize, SyndicateError::InvalidSeat);
            require!(payout_by_engine[idx].is_none(), SyndicateError::SeatSetMismatch);
            payout_by_engine[idx] = Some(p.amount);
        }

        let mut seen_seats = [false; 5];
        let mut total_payout: u64 = 0;
        for acc in ctx.remaining_accounts.iter() {
            let mut seat: Account<SeatAccount> = Account::try_from(acc)?;
            require_keys_eq!(seat.match_key, match_key, SyndicateError::Unauthorized);
            require!(seat.confirmed, SyndicateError::SeatNotConfirmed);
            let idx = seat.engine_seat as usize;
            require!(idx < confirmed_count as usize, SyndicateError::InvalidSeat);
            require!(!seen_seats[idx], SyndicateError::SeatSetMismatch);
            seen_seats[idx] = true;
            let (expected, _bump) = Pubkey::find_program_address(
                &[b"seat", match_key.as_ref(), seat.player.as_ref()],
                &crate::ID,
            );
            require_keys_eq!(expected, acc.key(), SyndicateError::Unauthorized);

            let payout = payout_by_engine[idx].ok_or(SyndicateError::SeatSetMismatch)?;
            seat.payout = payout;
            total_payout = total_payout
                .checked_add(payout)
                .ok_or(SyndicateError::Overflow)?;
            seat.exit(&crate::ID)?;
        }

        let expected_payout = confirmed_deposited
            .checked_sub(args.rake_collected)
            .ok_or(SyndicateError::ConservationViolation)?;
        require!(
            total_payout == expected_payout,
            SyndicateError::ConservationViolation
        );

        m.total_fees = m
            .total_fees
            .checked_add(args.rake_collected)
            .ok_or(SyndicateError::Overflow)?;
        m.settled_payout = total_payout;
        m.signed_price_hash = verified_signed_price.eth_signed_message_hash;
        m.signed_price_timestamp_ms = args.signed_price.timestamp_ms;
        m.status = MatchStatus::Settled;
        Ok(())
    }

    /// Pull-based, idempotent claim of a settled seat's payout (confirmed seats only —
    /// unconfirmed candidates use `refund`).
    pub fn claim(ctx: Context<Claim>) -> Result<()> {
        let m = &ctx.accounts.match_account;
        require!(m.status == MatchStatus::Settled, SyndicateError::BadStatus);
        let seat = &mut ctx.accounts.seat;
        require!(seat.confirmed, SyndicateError::SeatNotConfirmed);
        require!(!seat.claimed, SyndicateError::AlreadyClaimed);

        let amount = seat.payout;
        seat.claimed = true;
        if amount > 0 {
            transfer_from_vault(
                amount,
                &ctx.accounts.vault,
                &ctx.accounts.player_token,
                &ctx.accounts.match_account,
                &ctx.accounts.token_program,
            )?;
        }
        Ok(())
    }

    /// Operator emergency void (oracle/timelock fault, incident). Status → Void with
    /// `Emergency` kind: full refund to all.
    pub fn void(ctx: Context<AdminMatch>) -> Result<()> {
        let p = &ctx.accounts.protocol_state;
        require_keys_eq!(
            ctx.accounts.authority.key(),
            p.emergency_void_admin,
            SyndicateError::Unauthorized
        );
        let m = &mut ctx.accounts.match_account;
        require!(
            matches!(
                m.status,
                MatchStatus::Filling | MatchStatus::Sealing | MatchStatus::Live
            ),
            SyndicateError::BadStatus
        );
        m.void_kind = state::VoidKind::Emergency;
        m.status = MatchStatus::Void;
        Ok(())
    }

    /// Permissionless void of an abandoned pre-LIVE match — no operator needed, so funds
    /// can never strand. Filling past `fill_deadline_ts`, or Sealing past
    /// `seal_deadline_ts + SEAL_VOID_GRACE_SEC` (operator failed to begin_live). Full
    /// refund either way.
    pub fn void_before_start(ctx: Context<PermissionlessVoidPreStart>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp as u64;
        let m = &mut ctx.accounts.match_account;
        match m.status {
            MatchStatus::Filling => {
                require!(
                    now >= m.fill_deadline_ts,
                    SyndicateError::FillDeadlineNotReached
                );
            }
            MatchStatus::Sealing => {
                let grace = m
                    .seal_deadline_ts
                    .checked_add(SEAL_VOID_GRACE_SEC)
                    .ok_or(SyndicateError::Overflow)?;
                require!(now >= grace, SyndicateError::SealDeadlineNotReached);
            }
            _ => return Err(error!(SyndicateError::BadStatus)),
        }
        m.void_kind = state::VoidKind::FillingVoid;
        m.status = MatchStatus::Void;
        Ok(())
    }

    /// Permissionless void of a stuck LIVE match (capital-safety backstop). Reads ONLY
    /// the `MatchAccount`. Anyone may call once `now >= scheduled_end_ts +
    /// SETTLE_VOID_GRACE_SEC`, guaranteeing funds can never strand if the operator
    /// vanishes after the match goes live. Full refund to all.
    pub fn void_live_after_deadline(ctx: Context<PermissionlessVoidLive>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp as u64;
        let m = &mut ctx.accounts.match_account;
        require!(m.status == MatchStatus::Live, SyndicateError::BadStatus);
        let deadline = m
            .scheduled_end_ts
            .checked_add(SETTLE_VOID_GRACE_SEC)
            .ok_or(SyndicateError::Overflow)?;
        require!(now >= deadline, SyndicateError::SettleGraceNotElapsed);
        m.void_kind = state::VoidKind::Emergency;
        m.status = MatchStatus::Void;
        Ok(())
    }

    /// Pull-based, idempotent refund. v2 single rule: the amount is always the seat's
    /// full `deposit + entry_fee_paid`.
    ///
    /// - Unconfirmed candidate: refundable the moment the match leaves Filling (lock
    ///   landed without them, or any void) — including after Settled.
    /// - Confirmed seat: refundable only on Void (settled seats use `claim`).
    pub fn refund(ctx: Context<Claim>) -> Result<()> {
        let m = &ctx.accounts.match_account;
        let seat = &mut ctx.accounts.seat;
        require!(!seat.claimed, SyndicateError::AlreadyClaimed);
        if seat.confirmed {
            require!(m.status == MatchStatus::Void, SyndicateError::BadStatus);
            require!(
                m.void_kind != state::VoidKind::None,
                SyndicateError::RefundUnavailable
            );
        } else {
            require!(m.status != MatchStatus::Filling, SyndicateError::BadStatus);
        }

        let amount = seat
            .deposit
            .checked_add(seat.entry_fee_paid)
            .ok_or(SyndicateError::Overflow)?;
        seat.claimed = true;
        if amount > 0 {
            transfer_from_vault(
                amount,
                &ctx.accounts.vault,
                &ctx.accounts.player_token,
                &ctx.accounts.match_account,
                &ctx.accounts.token_program,
            )?;
        }
        Ok(())
    }

    /// Withdraw fees to the protocol treasury. Settled → confirmed entry fees + rake
    /// (`total_fees`). Voids waive all fees (nothing to withdraw). Idempotent via
    /// `fees_withdrawn`.
    pub fn withdraw_fees(ctx: Context<WithdrawFees>) -> Result<()> {
        let p = &ctx.accounts.protocol_state;
        require_keys_eq!(
            ctx.accounts.authority.key(),
            p.treasury_admin,
            SyndicateError::Unauthorized
        );
        let m = &mut ctx.accounts.match_account;
        require!(!m.fees_withdrawn, SyndicateError::FeesAlreadyWithdrawn);
        let amount: u64 = match m.status {
            MatchStatus::Settled => m.total_fees,
            _ => return Err(error!(SyndicateError::BadStatus)),
        };
        m.fees_withdrawn = true;
        if amount > 0 {
            transfer_from_vault(
                amount,
                &ctx.accounts.vault,
                &ctx.accounts.treasury_token,
                &ctx.accounts.match_account,
                &ctx.accounts.token_program,
            )?;
        }
        Ok(())
    }
}

/// Validate `CreateParams` (shared by `create_match` and `create_and_deposit` so the two
/// paths can never diverge). Pause + field bounds + tight oracle tolerance +
/// operator-governed buy-in / fill-window / betting-duration ranges (from `ProtocolState`).
fn validate_create_params(params: &CreateParams, p: &ProtocolState) -> Result<()> {
    require!(params.min_players >= 2, SyndicateError::InvalidConfig);
    require!(params.max_players <= 5, SyndicateError::InvalidConfig);
    require!(
        params.min_players <= params.max_players,
        SyndicateError::InvalidConfig
    );
    require!(params.buy_in > 0, SyndicateError::InvalidConfig);
    require!(
        params.buy_in >= p.buy_in_min && params.buy_in <= p.buy_in_max,
        SyndicateError::InvalidConfig
    );
    require!(params.rake_bps <= 10_000, SyndicateError::InvalidConfig);
    require!(
        params.rake_cap <= params.buy_in,
        SyndicateError::InvalidConfig
    );
    require!(
        params.total_betting_duration_sec >= p.total_betting_duration_min_sec
            && params.total_betting_duration_sec <= p.total_betting_duration_max_sec,
        SyndicateError::InvalidConfig
    );
    require!(
        params.seal_window_sec >= 1 && params.seal_window_sec <= MAX_SEAL_WINDOW_SEC,
        SyndicateError::InvalidConfig
    );
    require!(
        params.begin_live_window_sec <= MAX_BEGIN_LIVE_WINDOW_SEC,
        SyndicateError::InvalidConfig
    );
    require!(
        params.price_token != [0u8; 20],
        SyndicateError::InvalidConfig
    );
    require!(
        params.oracle_exponent == signed_price::SIGNED_PRICE_EXPONENT,
        SyndicateError::InvalidConfig
    );
    // Operator-governed fill-window range. The absolute deadline is derived on-chain as
    // `now + fill_window_sec`, so this also guarantees a future deadline.
    require!(
        params.fill_window_sec >= p.fill_window_min_sec
            && params.fill_window_sec <= p.fill_window_max_sec,
        SyndicateError::InvalidConfig
    );
    // Room binding: private rooms require a commitment, public rooms forbid one.
    require!(
        params.is_private == (params.room_commitment != [0u8; 32]),
        SyndicateError::InvalidRoomCommitment
    );
    Ok(())
}

/// Write all `MatchAccount` fields for a freshly created match (shared by `create_match`
/// and `create_and_deposit`). Status → Filling; counters/button zeroed; timing bound at
/// create with lock/seal/live timestamps derived on-chain later.
#[allow(clippy::too_many_arguments)]
fn populate_match_account(
    m: &mut MatchAccount,
    params: &CreateParams,
    now: u64,
    authority: Pubkey,
    mint: Pubkey,
    vault: Pubkey,
    vault_bump: u8,
    bump: u8,
) {
    m.authority = authority;
    m.mint = mint;
    m.vault = vault;
    m.match_id = params.match_id;
    m.buy_in = params.buy_in;
    m.status = MatchStatus::Filling;
    m.config_hash = params.config_hash;
    m.price_token = params.price_token;
    m.is_private = params.is_private;
    m.room_commitment = params.room_commitment;

    // Derive the absolute fill deadline from the chosen window so on-chain
    // `fill_deadline_ts` semantics (deposit gate, permissionless void) stay uniform.
    m.fill_deadline_ts = now.saturating_add(params.fill_window_sec);
    m.lock_ts = 0;
    m.seal_deadline_ts = 0;
    m.live_start_ts = 0;
    m.scheduled_end_ts = 0;
    m.total_betting_duration_sec = params.total_betting_duration_sec;
    m.seal_window_sec = params.seal_window_sec;
    m.begin_live_window_sec = if params.begin_live_window_sec == 0 {
        DEFAULT_BEGIN_LIVE_WINDOW_SEC
    } else {
        params.begin_live_window_sec
    };

    m.max_oracle_confidence = params.max_oracle_confidence;
    m.oracle_exponent = params.oracle_exponent;
    m.signed_price_hash = [0u8; 32];
    m.signed_price_timestamp_ms = 0;

    m.entry_fee = params.entry_fee;
    m.rake_bps = params.rake_bps;
    m.rake_cap = params.rake_cap;
    m.min_players = params.min_players;
    m.max_players = params.max_players;
    m.candidate_count = 0;
    m.confirmed_count = 0;
    m.sealed_count = 0;
    m.total_deposited = 0;
    m.total_fees = 0;
    m.settled_payout = 0;

    m.button_seed = [0u8; 32];
    m.button = 0;
    m.button_set = false;

    m.vault_bump = vault_bump;
    m.bump = bump;
    m.fees_withdrawn = false;
    m.void_kind = state::VoidKind::None;
    m.reserved = [0u8; 32];
}

/// Initialize a fresh `SeatAccount` as an unconfirmed CANDIDATE (shared by `deposit` and
/// `create_and_deposit`).
fn write_seat(
    seat: &mut SeatAccount,
    match_key: Pubkey,
    player: Pubkey,
    buy_in: u64,
    entry_fee: u64,
    room_commitment: [u8; 32],
    bump: u8,
) {
    seat.match_key = match_key;
    seat.player = player;
    seat.deposit = buy_in;
    seat.entry_fee_paid = entry_fee;
    seat.payout = 0;
    seat.claimed = false;
    seat.bump = bump;
    seat.room_commitment = room_commitment;
    seat.confirmed = false;
    seat.engine_seat = state::NO_ENGINE_SEAT;
    seat.prediction_commitment = [0u8; 32];
    seat.timelock_target = 0;
    seat.commitment_set = false;
    seat.reserved = [0u8; 8];
}

/// CPI: move `buy_in + entry_fee` from the player's token account into the match vault,
/// authorized by the depositing player (shared by `deposit` and `create_and_deposit`).
fn deposit_into_vault<'info>(
    amount: u64,
    player_token: &Account<'info, TokenAccount>,
    vault: &Account<'info, TokenAccount>,
    player: &Signer<'info>,
    token_program: &Program<'info, Token>,
) -> Result<()> {
    token::transfer(
        CpiContext::new(
            token_program.to_account_info(),
            Transfer {
                from: player_token.to_account_info(),
                to: vault.to_account_info(),
                authority: player.to_account_info(),
            },
        ),
        amount,
    )
}

/// Transfer `amount` from the match vault to `dest`, signed by the match PDA.
fn transfer_from_vault<'info>(
    amount: u64,
    vault: &Account<'info, TokenAccount>,
    dest: &Account<'info, TokenAccount>,
    match_account: &Account<'info, MatchAccount>,
    token_program: &Program<'info, Token>,
) -> Result<()> {
    let match_id = match_account.match_id.to_le_bytes();
    let seeds: &[&[u8]] = &[b"match", match_id.as_ref(), &[match_account.bump]];
    let signer: &[&[&[u8]]] = &[seeds];
    token::transfer(
        CpiContext::new_with_signer(
            token_program.to_account_info(),
            Transfer {
                from: vault.to_account_info(),
                to: dest.to_account_info(),
                authority: match_account.to_account_info(),
            },
            signer,
        ),
        amount,
    )
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
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

/// Operator-governed match-creation bounds (see `ProtocolState`). Passed at
/// `initialize_protocol` and updatable via `set_match_bounds` (config_admin).
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy)]
pub struct MatchBounds {
    pub buy_in_min: u64,
    pub buy_in_max: u64,
    pub fill_window_min_sec: u64,
    pub fill_window_max_sec: u64,
    pub total_betting_duration_min_sec: u64,
    pub total_betting_duration_max_sec: u64,
}

impl MatchBounds {
    fn validate(&self) -> Result<()> {
        require!(self.buy_in_min > 0, SyndicateError::InvalidConfig);
        require!(
            self.buy_in_min <= self.buy_in_max,
            SyndicateError::InvalidConfig
        );
        require!(self.fill_window_min_sec >= 1, SyndicateError::InvalidConfig);
        require!(
            self.fill_window_min_sec <= self.fill_window_max_sec,
            SyndicateError::InvalidConfig
        );
        require!(
            self.total_betting_duration_min_sec >= 1,
            SyndicateError::InvalidConfig
        );
        require!(
            self.total_betting_duration_min_sec <= self.total_betting_duration_max_sec,
            SyndicateError::InvalidConfig
        );
        Ok(())
    }
}

impl ProtocolRoles {
    fn all_non_default(&self) -> bool {
        let zero = Pubkey::default();
        self.protocol_admin != zero
            && self.settlement_admin != zero
            && self.emergency_void_admin != zero
            && self.pause_admin != zero
            && self.config_admin != zero
            && self.fee_admin != zero
            && self.treasury_admin != zero
            && self.upgrade_authority != zero
            && self.price_signer != [0u8; 20]
    }
}

#[derive(Accounts)]
pub struct InitializeProtocol<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(init, payer = authority, space = ProtocolState::SPACE, seeds = [b"protocol"], bump)]
    pub protocol_state: Account<'info, ProtocolState>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ProtocolAdmin<'info> {
    pub authority: Signer<'info>,
    #[account(mut, seeds = [b"protocol"], bump = protocol_state.bump)]
    pub protocol_state: Account<'info, ProtocolState>,
}

/// v2 CreateParams (Borsh, 171 bytes). `config_hash` is the canonical SHA-256 of the FULL
/// creator-chosen param set (streets, durations, feed, buy-in, fees…) — free-form within
/// operator bounds, no allowlist. `room_commitment` = sha256(roomcode ‖ creator) for
/// private rooms, zero for public.
#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
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
    /// 20-byte token/feed identifier signed by the signed-price-server.
    pub price_token: [u8; 20],
    /// Total wall-clock betting span (Σ street durations + observation), bound in config.
    /// `scheduled_end_ts` is derived on-chain at begin_live (= live_start + this).
    pub total_betting_duration_sec: u64,
    pub seal_window_sec: u64,
    /// Max delay after seal deadline for the operator to call begin_live (0 → default 30s).
    pub begin_live_window_sec: u64,
    /// Fill window (seconds). The on-chain `fill_deadline_ts` is derived as
    /// `create_ts + fill_window_sec`; must lie within the operator-governed bounds.
    pub fill_window_sec: u64,
    pub max_oracle_confidence: u64,
    pub oracle_exponent: i32,
}

#[derive(Accounts)]
#[instruction(params: CreateParams)]
pub struct CreateMatch<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(seeds = [b"protocol"], bump = protocol_state.bump)]
    pub protocol_state: Box<Account<'info, ProtocolState>>,
    pub mint: Box<Account<'info, Mint>>,
    #[account(
        init, payer = authority, space = MatchAccount::SPACE,
        seeds = [b"match", params.match_id.to_le_bytes().as_ref()], bump
    )]
    pub match_account: Box<Account<'info, MatchAccount>>,
    #[account(
        init, payer = authority,
        token::mint = mint, token::authority = match_account,
        seeds = [b"vault", match_account.key().as_ref()], bump
    )]
    pub vault: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct Deposit<'info> {
    #[account(mut)]
    pub player: Signer<'info>,
    #[account(seeds = [b"protocol"], bump = protocol_state.bump)]
    pub protocol_state: Box<Account<'info, ProtocolState>>,
    #[account(mut, seeds = [b"match", match_account.match_id.to_le_bytes().as_ref()], bump = match_account.bump)]
    pub match_account: Box<Account<'info, MatchAccount>>,
    #[account(
        init, payer = player, space = SeatAccount::SPACE,
        seeds = [b"seat", match_account.key().as_ref(), player.key().as_ref()], bump
    )]
    pub seat: Box<Account<'info, SeatAccount>>,
    #[account(mut, constraint = player_token.mint == match_account.mint)]
    pub player_token: Box<Account<'info, TokenAccount>>,
    #[account(mut, address = match_account.vault)]
    pub vault: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

/// Atomic create + seat the creator. Combines `CreateMatch` (match PDA + vault init) with
/// `Deposit` (creator's seat + token transfer) so the creator (`authority`) is seated as
/// the first candidate in the same instruction. Account constraints reference the passed
/// `mint` (not `match_account.mint`, which is zeroed until the handler runs).
#[derive(Accounts)]
#[instruction(params: CreateParams)]
pub struct CreateAndDeposit<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(seeds = [b"protocol"], bump = protocol_state.bump)]
    pub protocol_state: Box<Account<'info, ProtocolState>>,
    pub mint: Box<Account<'info, Mint>>,
    #[account(
        init, payer = authority, space = MatchAccount::SPACE,
        seeds = [b"match", params.match_id.to_le_bytes().as_ref()], bump
    )]
    pub match_account: Box<Account<'info, MatchAccount>>,
    #[account(
        init, payer = authority,
        token::mint = mint, token::authority = match_account,
        seeds = [b"vault", match_account.key().as_ref()], bump
    )]
    pub vault: Box<Account<'info, TokenAccount>>,
    #[account(
        init, payer = authority, space = SeatAccount::SPACE,
        seeds = [b"seat", match_account.key().as_ref(), authority.key().as_ref()], bump
    )]
    pub seat: Box<Account<'info, SeatAccount>>,
    #[account(mut, constraint = player_token.mint == mint.key())]
    pub player_token: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct AdminMatch<'info> {
    pub authority: Signer<'info>,
    #[account(seeds = [b"protocol"], bump = protocol_state.bump)]
    pub protocol_state: Account<'info, ProtocolState>,
    #[account(mut, seeds = [b"match", match_account.match_id.to_le_bytes().as_ref()], bump = match_account.bump)]
    pub match_account: Account<'info, MatchAccount>,
}

/// Permissionless pre-LIVE void: no protocol-state / role check (anyone may call).
#[derive(Accounts)]
pub struct PermissionlessVoidPreStart<'info> {
    #[account(mut, seeds = [b"match", match_account.match_id.to_le_bytes().as_ref()], bump = match_account.bump)]
    pub match_account: Account<'info, MatchAccount>,
}

/// Permissionless LIVE void backstop: MatchAccount only. Anyone may call.
#[derive(Accounts)]
pub struct PermissionlessVoidLive<'info> {
    #[account(mut, seeds = [b"match", match_account.match_id.to_le_bytes().as_ref()], bump = match_account.bump)]
    pub match_account: Account<'info, MatchAccount>,
}

#[derive(Accounts)]
pub struct WithdrawFees<'info> {
    pub authority: Signer<'info>,
    #[account(seeds = [b"protocol"], bump = protocol_state.bump)]
    pub protocol_state: Account<'info, ProtocolState>,
    #[account(mut, seeds = [b"match", match_account.match_id.to_le_bytes().as_ref()], bump = match_account.bump)]
    pub match_account: Account<'info, MatchAccount>,
    #[account(mut, address = match_account.vault)]
    pub vault: Account<'info, TokenAccount>,
    #[account(mut, constraint = treasury_token.mint == match_account.mint)]
    pub treasury_token: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct SubmitSettlement<'info> {
    pub authority: Signer<'info>,
    #[account(seeds = [b"protocol"], bump = protocol_state.bump)]
    pub protocol_state: Account<'info, ProtocolState>,
    #[account(mut, seeds = [b"match", match_account.match_id.to_le_bytes().as_ref()], bump = match_account.bump)]
    pub match_account: Account<'info, MatchAccount>,
    // Confirmed seats are provided as `remaining_accounts`.
}

#[derive(Accounts)]
pub struct Claim<'info> {
    #[account(mut)]
    pub player: Signer<'info>,
    #[account(mut, seeds = [b"match", match_account.match_id.to_le_bytes().as_ref()], bump = match_account.bump)]
    pub match_account: Account<'info, MatchAccount>,
    #[account(mut, has_one = player,
        seeds = [b"seat", match_account.key().as_ref(), player.key().as_ref()], bump = seat.bump,
        close = player)]
    pub seat: Account<'info, SeatAccount>,
    #[account(mut, address = match_account.vault)]
    pub vault: Account<'info, TokenAccount>,
    #[account(mut, constraint = player_token.mint == match_account.mint)]
    pub player_token: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

/// Seal during SEALING (before LIVE), recorded on the player's own seat. The player is
/// the transaction Signer — this IS the explicit seal signature (no session keys, no
/// relayer, so no ed25519-sysvar binding is needed).
#[derive(Accounts)]
pub struct RegisterPredictionCommitment<'info> {
    pub player: Signer<'info>,
    #[account(
        mut,
        seeds = [b"match", match_account.match_id.to_le_bytes().as_ref()],
        bump = match_account.bump,
    )]
    pub match_account: Account<'info, MatchAccount>,
    #[account(
        mut,
        has_one = player,
        seeds = [b"seat", match_account.key().as_ref(), player.key().as_ref()],
        bump = seat.bump,
    )]
    pub seat: Account<'info, SeatAccount>,
}
