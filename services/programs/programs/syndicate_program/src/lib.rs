//! # Syndicate on-chain program (Anchor)
//!
//! Custody + final-settlement for Syndicate matches. The program is the source of truth
//! for funds and enforces capital safety (conservation + signed-price authenticity).
//!
//! **v1 trust model:** the backend is the sole source of truth for game outcomes. The
//! chain does NOT replay action logs or re-derive payouts via `verify_settlement`; it
//! accepts backend-computed per-seat payouts and only verifies that (a) the settlement
//! price is signed by the trusted `price_signer` at exactly `scheduled_end_ts`, and
//! (b) total payouts + rake == deposits + dead_money.
//!
//! TODO(v1+): restore on-chain action-log replay + `syndicate_shared::verify_settlement`
//! re-derivation so the program independently validates outcomes before releasing funds.
//! This will require re-introducing `init_action_log` / `append_*` / `finalize_action_log`
//! instructions and the `ActionLog` account.

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

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
use state::{MatchAccount, MatchStatus, ProtocolState, SeatAccount, SeatIndexAccount};

declare_id!("8D2Wt3pLyoS8wLaTb3mcnC5WVja6xYMoumNqG2yZs1qX");

/// Pinned drand beacon (League of Entropy `quicknet`, 3s period, time-lock capable).
/// Used to (a) bound the committed button round to publish AFTER the seal deadline and
/// (b) bound each seat's `timelock_target` to publish AFTER projected match end. Round
/// expected publish time = `DRAND_GENESIS_TIME + round * DRAND_PERIOD_SEC`.
pub const DRAND_GENESIS_TIME: u64 = 1_692_803_367;
pub const DRAND_PERIOD_SEC: u64 = 3;

/// Grace after `seal_deadline_ts` before a stuck Sealing match can be permissionlessly
/// voided (operator failed to `begin_live`) — covers the drand/operator liveness window.
pub const SEAL_VOID_GRACE_SEC: u64 = 60;

/// Generous last-resort grace after `scheduled_end_ts` before a stuck LIVE match can be
/// permissionlessly voided. An honest operator settles within seconds-to-a-minute of
/// match end (oracle window + drand decrypt + tx); this backstop only fires if settlement
/// never lands, so capital can never strand even though the on-chain action log may not
/// exist yet under the batch-at-settlement model (plan_v2 §H). MatchAccount-only.
pub const SETTLE_VOID_GRACE_SEC: u64 = 300;

/// Maximum slack after the LATEST possible match end within which a prediction's
/// `timelock_target` round must publish (plan_v2 §I hardening). Bounds the seal both sides
/// — a player cannot seal to a far-future round that is undecryptable at settlement (which
/// would force a MissingPrediction VOID, a cheap grief). Kept tight (the `begin_live`
/// window pins match end to within `begin_live_window_sec` of the seal round) so the key
/// materializes ~20s after match end, keeping settlement live.
pub const MAX_TIMELOCK_SKEW_SEC: u64 = 20;

/// Default `begin_live_window_sec` if a caller passes 0 (operator must go live within this
/// many seconds of the seal deadline).
pub const DEFAULT_BEGIN_LIVE_WINDOW_SEC: u64 = 5;

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
    ) -> Result<()> {
        require_keys_eq!(
            ctx.accounts.authority.key(),
            roles.protocol_admin,
            SyndicateError::Unauthorized
        );
        require!(roles.all_non_default(), SyndicateError::Unauthorized);
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

    /// Create a match. **Permissionless** (plan_v2 §3): any signer may create; the
    /// signer becomes `m.authority` but that grants NO lifecycle power — `lock`/
    /// `begin_live`/`submit_settlement` remain gated to operator ROLE keys, so the
    /// operator monopoly on progression is preserved automatically. Clients submit
    /// `[create_match, deposit]` in one transaction so the creator is seated atomically.
    pub fn create_match(ctx: Context<CreateMatch>, params: CreateParams) -> Result<()> {
        require!(
            !ctx.accounts.protocol_state.pause_new_matches,
            SyndicateError::Paused
        );
        let now = Clock::get()?.unix_timestamp as u64;
        validate_create_params(&params, now)?;
        let authority = ctx.accounts.authority.key();
        let mint = ctx.accounts.mint.key();
        let vault = ctx.accounts.vault.key();
        populate_match_account(
            &mut ctx.accounts.match_account,
            &params,
            authority,
            mint,
            vault,
            ctx.bumps.vault,
            ctx.bumps.match_account,
        );
        Ok(())
    }

    /// Atomic create + seat the creator in a single instruction (plan_v2 §3 convenience).
    /// Equivalent to `[create_match, deposit]` in one tx — same shared logic — but a single
    /// instruction guarantees atomicity regardless of how a client assembles the tx. The
    /// creator (`authority`) is both the payer and the first depositor.
    pub fn create_and_deposit(
        ctx: Context<CreateAndDeposit>,
        params: CreateParams,
        seat_index: u16,
    ) -> Result<()> {
        require!(
            !ctx.accounts.protocol_state.pause_new_matches,
            SyndicateError::Paused
        );
        let now = Clock::get()?.unix_timestamp as u64;
        validate_create_params(&params, now)?;
        require!(
            seat_index < params.max_players as u16,
            SyndicateError::InvalidSeat
        );

        let authority = ctx.accounts.authority.key();
        let mint = ctx.accounts.mint.key();
        let vault_key = ctx.accounts.vault.key();
        populate_match_account(
            &mut ctx.accounts.match_account,
            &params,
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
            seat_index,
            buy_in,
            entry_fee,
            ctx.bumps.seat,
        );
        write_seat_index(
            &mut ctx.accounts.seat_index_account,
            match_key,
            authority,
            seat_index,
            ctx.bumps.seat_index_account,
        );

        let m = &mut ctx.accounts.match_account;
        m.total_deposited = m
            .total_deposited
            .checked_add(buy_in)
            .ok_or(SyndicateError::Overflow)?;
        m.total_fees = m
            .total_fees
            .checked_add(entry_fee)
            .ok_or(SyndicateError::Overflow)?;
        m.player_count += 1;
        Ok(())
    }

    /// Deposit buy-in + entry fee → seat eligibility (the anti-spam gate, `05 §4`).
    pub fn deposit(ctx: Context<Deposit>, seat_index: u16) -> Result<()> {
        require!(
            !ctx.accounts.protocol_state.pause_new_matches,
            SyndicateError::Paused
        );
        let now = Clock::get()?.unix_timestamp as u64;
        {
            let m = &ctx.accounts.match_account;
            require!(m.status == MatchStatus::Filling, SyndicateError::BadStatus);
            require!(m.player_count < m.max_players, SyndicateError::MatchFull);
            require!(
                seat_index < m.max_players as u16,
                SyndicateError::InvalidSeat
            );
            // Do not seat into a room past its fill deadline (it is about to VOID).
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
            seat_index,
            buy_in,
            entry_fee,
            ctx.bumps.seat,
        );
        write_seat_index(
            &mut ctx.accounts.seat_index_account,
            match_key,
            player,
            seat_index,
            ctx.bumps.seat_index_account,
        );

        let m = &mut ctx.accounts.match_account;
        m.total_deposited = m
            .total_deposited
            .checked_add(buy_in)
            .ok_or(SyndicateError::Overflow)?;
        m.total_fees = m
            .total_fees
            .checked_add(entry_fee)
            .ok_or(SyndicateError::Overflow)?;
        m.player_count += 1;
        Ok(())
    }

    /// Lock the match: enough players present → seats frozen, status → Sealing. Records
    /// `lock_ts` and derives `seal_deadline_ts`. The dealer button uses backend-native
    /// randomness submitted at `begin_live` (plan_v2 §3), so no drand round is committed
    /// here. Operator-gated.
    pub fn lock(ctx: Context<AdminMatch>) -> Result<()> {
        let p = &ctx.accounts.protocol_state;
        require!(
            ctx.accounts.authority.key() == p.settlement_admin
                || ctx.accounts.authority.key() == p.config_admin,
            SyndicateError::Unauthorized
        );
        let now = Clock::get()?.unix_timestamp as u64;
        let m = &mut ctx.accounts.match_account;
        require!(m.status == MatchStatus::Filling, SyndicateError::BadStatus);
        require!(
            m.player_count >= m.min_players,
            SyndicateError::NotEnoughPlayers
        );
        m.lock_ts = now;
        m.seal_deadline_ts = now
            .checked_add(m.seal_window_sec)
            .ok_or(SyndicateError::Overflow)?;
        m.status = MatchStatus::Sealing;
        Ok(())
    }

    /// Advance Sealing → Live (plan_v2 §1/§3/§5). Operator-gated. Requires the seal
    /// deadline reached. Drops + penalizes non-sealers (penalty → `dead_money`, entry
    /// fee → `forfeited_fees`); if fewer than `min_players` sealed, VOIDs with the
    /// penalty pool split among sealers. Otherwise re-indexes sealers into contiguous
    /// engine seats, derives the dealer button from the committed drand round's
    /// randomness, and stamps `live_start_ts` + `scheduled_end_ts`.
    ///
    /// All seat accounts (exactly `player_count`) are passed as `remaining_accounts`.
    pub fn begin_live<'info>(
        ctx: Context<'_, '_, 'info, 'info, AdminMatch<'info>>,
        args: BeginLiveArgs,
    ) -> Result<()> {
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
        // match end stays pinned to the seal round (timelock concealment, plan_v2 §I). Miss
        // it and the match can only be permissionlessly voided (void_before_start).
        let begin_live_deadline = m
            .seal_deadline_ts
            .checked_add(m.begin_live_window_sec)
            .ok_or(SyndicateError::Overflow)?;
        require!(
            now <= begin_live_deadline,
            SyndicateError::BeginLiveWindowPassed
        );
        require!(
            ctx.remaining_accounts.len() == m.player_count as usize,
            SyndicateError::SeatSetMismatch
        );

        // Pass 1: read every seat (read-only), validate, classify sealers/non-sealers.
        struct SeatRead {
            seat_index: u16,
            commitment_set: bool,
            deposit: u64,
            entry_fee: u64,
            seal_seq: u64,
        }
        let mut reads: Vec<SeatRead> = Vec::with_capacity(ctx.remaining_accounts.len());
        let mut seen = [false; 5];
        for acc in ctx.remaining_accounts.iter() {
            let data = acc.try_borrow_data()?;
            let seat = SeatAccount::try_deserialize(&mut &data[..])?;
            require_keys_eq!(seat.match_key, match_key, SyndicateError::Unauthorized);
            require!(
                seat.seat_index < m.max_players as u16,
                SyndicateError::InvalidSeat
            );
            let (expected, _b) = Pubkey::find_program_address(
                &[b"seat", match_key.as_ref(), seat.player.as_ref()],
                &crate::ID,
            );
            require_keys_eq!(expected, acc.key(), SyndicateError::Unauthorized);
            let si = seat.seat_index as usize;
            require!(si < 5 && !seen[si], SyndicateError::SeatSetMismatch);
            seen[si] = true;
            reads.push(SeatRead {
                seat_index: seat.seat_index,
                commitment_set: seat.commitment_set,
                deposit: seat.deposit,
                entry_fee: seat.entry_fee_paid,
                seal_seq: seat.seal_seq,
            });
        }

        // Accumulate the penalty pool and the sealer set (ordered by seat_index).
        let mut dead_money: u64 = 0;
        let mut forfeited_fees: u64 = 0;
        let mut sealed_seat_indices: Vec<u16> = Vec::new();
        let mut earliest_seal_seq: Option<(u64, u16)> = None; // (seal_seq, seat_index)
        for r in &reads {
            if r.commitment_set {
                sealed_seat_indices.push(r.seat_index);
                match earliest_seal_seq {
                    None => earliest_seal_seq = Some((r.seal_seq, r.seat_index)),
                    Some((s, _)) if r.seal_seq < s => {
                        earliest_seal_seq = Some((r.seal_seq, r.seat_index))
                    }
                    _ => {}
                }
            } else {
                let penalty =
                    (r.deposit as u128 * m.nonseal_penalty_bps as u128 / 10_000u128) as u64;
                dead_money = dead_money
                    .checked_add(penalty)
                    .ok_or(SyndicateError::Overflow)?;
                forfeited_fees = forfeited_fees
                    .checked_add(r.entry_fee)
                    .ok_or(SyndicateError::Overflow)?;
            }
        }
        sealed_seat_indices.sort_unstable();
        let sealed_count = sealed_seat_indices.len() as u8;

        let under_min = (sealed_count as u8) < m.min_players;
        m.sealed_count = sealed_count;
        m.dead_money = dead_money;
        m.forfeited_fees = forfeited_fees;

        // engine_seat assignment: contiguous 0..sealed_count by seat_index order.
        let engine_seat_of = |seat_index: u16| -> u8 {
            sealed_seat_indices
                .iter()
                .position(|&s| s == seat_index)
                .map(|i| i as u8)
                .unwrap_or(state::NO_ENGINE_SEAT)
        };

        if !under_min {
            // Derive the dealer button from operator-supplied backend-native randomness
            // (server-attested, low-stakes — plan_v2 §3; recorded for audit, not verified).
            require!(
                args.button_randomness != [0u8; 32],
                SyndicateError::InvalidButtonRandomness
            );
            let rnd = u64::from_le_bytes(args.button_randomness[0..8].try_into().unwrap());
            m.button = (rnd % sealed_count as u64) as u8;
            m.button_randomness = args.button_randomness;
            m.button_set = true;
            m.live_start_ts = now;
            m.scheduled_end_ts = now
                .checked_add(m.total_betting_duration_sec)
                .ok_or(SyndicateError::Overflow)?;
            m.status = MatchStatus::Live;
        } else {
            // Too few sealed: VOID. Sealers get a full refund + a pro-rata share of the
            // penalty pool; non-sealers get deposit - penalty (entry fee forfeited).
            m.void_kind = state::VoidKind::UnderMinSealed;
            m.status = MatchStatus::Void;
        }

        // Pass 2: write per-seat outcomes back to the remaining_accounts.
        let nonseal_bps = m.nonseal_penalty_bps;
        let remainder_seat = earliest_seal_seq.map(|(_, si)| si);
        for acc in ctx.remaining_accounts.iter() {
            let mut seat: Account<SeatAccount> = Account::try_from(acc)?;
            if seat.commitment_set {
                // Sealer.
                seat.is_non_sealer = false;
                seat.penalty = 0;
                if under_min {
                    seat.engine_seat = state::NO_ENGINE_SEAT;
                    seat.gets_remainder = Some(seat.seat_index) == remainder_seat;
                } else {
                    seat.engine_seat = engine_seat_of(seat.seat_index);
                    seat.gets_remainder = false;
                }
            } else {
                // Non-sealer: dropped + penalized.
                let penalty = (seat.deposit as u128 * nonseal_bps as u128 / 10_000u128) as u64;
                seat.is_non_sealer = true;
                seat.penalty = penalty;
                seat.engine_seat = state::NO_ENGINE_SEAT;
                seat.gets_remainder = false;
                if !under_min {
                    // Live path: claimable after Settled via `claim` (deposit - penalty).
                    seat.payout = seat
                        .deposit
                        .checked_sub(penalty)
                        .ok_or(SyndicateError::Overflow)?;
                }
            }
            seat.exit(&crate::ID)?;
        }
        Ok(())
    }

    pub fn register_prediction_commitment(
        ctx: Context<RegisterPredictionCommitment>,
        args: RegisterPredictionCommitmentArgs,
    ) -> Result<()> {
        register_prediction_commitment_handler(ctx, args)
    }

    /// Submit the final settlement (v1: backend-trusted payouts).
    ///
    /// Verifies the signed price at exactly `scheduled_end_ts`, writes per-seat payouts
    /// supplied by the backend, and enforces conservation. Does NOT replay action logs.
    ///
    /// TODO(v1+): restore on-chain action-log replay + `verify_settlement` — see crate header.
    /// Pass the sealed seats as `remaining_accounts`.
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
        let sealed_count = m.sealed_count;
        let dead_money = m.dead_money;

        require!(
            ctx.remaining_accounts.len() == sealed_count as usize,
            SyndicateError::SeatSetMismatch
        );
        require!(
            args.payouts.len() == sealed_count as usize,
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

        let sealer_deposited = (sealed_count as u64)
            .checked_mul(buy_in)
            .ok_or(SyndicateError::Overflow)?;
        require!(
            args.rake_collected <= sealer_deposited,
            SyndicateError::ConservationViolation
        );

        let mut payout_by_engine = [None::<u64>; 5];
        for p in &args.payouts {
            let idx = p.engine_seat as usize;
            require!(idx < sealed_count as usize, SyndicateError::InvalidSeat);
            require!(payout_by_engine[idx].is_none(), SyndicateError::SeatSetMismatch);
            payout_by_engine[idx] = Some(p.amount);
        }

        let mut seen_seats = [false; 5];
        let mut total_payout: u64 = 0;
        for acc in ctx.remaining_accounts.iter() {
            let mut seat: Account<SeatAccount> = Account::try_from(acc)?;
            require_keys_eq!(seat.match_key, match_key, SyndicateError::Unauthorized);
            require!(!seat.is_non_sealer, SyndicateError::SeatSetMismatch);
            let idx = seat.engine_seat as usize;
            require!(idx < sealed_count as usize, SyndicateError::InvalidSeat);
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

        let expected_payout = sealer_deposited
            .checked_add(dead_money)
            .ok_or(SyndicateError::Overflow)?
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

    /// Pull-based, idempotent claim of a settled seat's payout.
    pub fn claim(ctx: Context<Claim>) -> Result<()> {
        let m = &ctx.accounts.match_account;
        require!(m.status == MatchStatus::Settled, SyndicateError::BadStatus);
        let seat = &mut ctx.accounts.seat;
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
    /// `Emergency` kind: full refund to all, penalties waived (plan_v2 §5).
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

    /// Permissionless void of an abandoned pre-LIVE match (plan_v2 §3) — no operator
    /// needed, so funds can never strand. Filling past `fill_deadline_ts`, or Sealing
    /// past `seal_deadline_ts + SEAL_VOID_GRACE_SEC` (operator failed to begin_live).
    /// Either way no game ran, so it is a full refund (no penalty).
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

    /// Permissionless void of a stuck LIVE match (plan_v2 §H capital-safety backstop).
    /// Reads ONLY the `MatchAccount` — it does NOT depend on the `ActionLog`, which under
    /// the batch-at-settlement model may not exist yet between `begin_live` and
    /// settlement. Anyone may call once `now >= scheduled_end_ts + SETTLE_VOID_GRACE_SEC`,
    /// guaranteeing funds can never strand if the operator vanishes after the match goes
    /// live. Settlement was never recorded, so this is a full refund to all (penalties
    /// waived): `VoidKind::Emergency`.
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

    /// Pull-based, idempotent refund on VOID. The amount depends on `void_kind`
    /// (plan_v2 §5): pre-LIVE voids fully refund (deposit + entry fee); an UnderMinSealed
    /// void refunds sealers in full plus their pro-rata share of the non-sealer penalty
    /// pool, while non-sealers get `deposit - penalty` (entry fee forfeited).
    pub fn refund(ctx: Context<Claim>) -> Result<()> {
        let m = &ctx.accounts.match_account;
        require!(m.status == MatchStatus::Void, SyndicateError::BadStatus);
        let void_kind = m.void_kind;
        let dead_money = m.dead_money;
        let sealed_count = m.sealed_count;
        let seat = &mut ctx.accounts.seat;
        require!(!seat.claimed, SyndicateError::AlreadyClaimed);

        let amount: u64 = match void_kind {
            // Pre-LIVE: no game, no penalty — full refund.
            state::VoidKind::FillingVoid | state::VoidKind::Emergency => seat
                .deposit
                .checked_add(seat.entry_fee_paid)
                .ok_or(SyndicateError::Overflow)?,
            // Under-min sealed: penalize non-sealers; sealers get full refund + share.
            state::VoidKind::UnderMinSealed => {
                if seat.is_non_sealer {
                    seat.deposit
                        .checked_sub(seat.penalty)
                        .ok_or(SyndicateError::Overflow)?
                } else {
                    require!(sealed_count > 0, SyndicateError::ConservationViolation);
                    let share = dead_money / sealed_count as u64;
                    let remainder = if seat.gets_remainder {
                        dead_money % sealed_count as u64
                    } else {
                        0
                    };
                    seat.deposit
                        .checked_add(seat.entry_fee_paid)
                        .and_then(|v| v.checked_add(share))
                        .and_then(|v| v.checked_add(remainder))
                        .ok_or(SyndicateError::Overflow)?
                }
            }
            state::VoidKind::None => return Err(error!(SyndicateError::RefundUnavailable)),
        };

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

    /// Withdraw fees to the protocol treasury. Settled → all entry fees + rake
    /// (`total_fees`). UnderMinSealed void → only the forfeited non-sealer entry fees
    /// (plus the whole penalty pool if zero sealers remained to receive it). Other void
    /// kinds waive all fees (nothing to withdraw). Idempotent via `fees_withdrawn`.
    pub fn withdraw_fees(ctx: Context<WithdrawFees>) -> Result<()> {
        let p = &ctx.accounts.protocol_state;
        require_keys_eq!(
            ctx.accounts.authority.key(),
            p.treasury_admin,
            SyndicateError::Unauthorized
        );
        let m = &mut ctx.accounts.match_account;
        require!(!m.fees_withdrawn, SyndicateError::FeesAlreadyWithdrawn);
        let amount: u64 = match (m.status, m.void_kind) {
            (MatchStatus::Settled, _) => m.total_fees,
            (MatchStatus::Void, state::VoidKind::UnderMinSealed) => {
                let orphaned_pool = if m.sealed_count == 0 { m.dead_money } else { 0 };
                m.forfeited_fees
                    .checked_add(orphaned_pool)
                    .ok_or(SyndicateError::Overflow)?
            }
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
/// paths can never diverge). Pause + field bounds + tight oracle tolerance + future fill
/// deadline. `now` is the current unix time.
fn validate_create_params(params: &CreateParams, now: u64) -> Result<()> {
    require!(params.min_players >= 2, SyndicateError::InvalidConfig);
    require!(params.max_players <= 5, SyndicateError::InvalidConfig);
    require!(
        params.min_players <= params.max_players,
        SyndicateError::InvalidConfig
    );
    require!(params.buy_in > 0, SyndicateError::InvalidConfig);
    require!(params.rake_bps <= 10_000, SyndicateError::InvalidConfig);
    require!(
        params.rake_cap <= params.buy_in,
        SyndicateError::InvalidConfig
    );
    require!(
        params.nonseal_penalty_bps <= 10_000,
        SyndicateError::InvalidConfig
    );
    require!(
        params.total_betting_duration_sec > 0,
        SyndicateError::InvalidConfig
    );
    require!(params.seal_window_sec > 0, SyndicateError::InvalidConfig);
    require!(
        params.price_token != [0u8; 20],
        SyndicateError::InvalidConfig
    );
    require!(
        params.oracle_exponent == signed_price::SIGNED_PRICE_EXPONENT,
        SyndicateError::InvalidConfig
    );
    require!(params.fill_deadline_ts > now, SyndicateError::InvalidConfig);
    Ok(())
}

/// Write all `MatchAccount` fields for a freshly created match (shared by `create_match`
/// and `create_and_deposit`). Status → Filling; counters/randomness zeroed; timing bound
/// at create with lock/seal/live timestamps derived on-chain later.
#[allow(clippy::too_many_arguments)]
fn populate_match_account(
    m: &mut MatchAccount,
    params: &CreateParams,
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

    m.fill_deadline_ts = params.fill_deadline_ts;
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
    m.nonseal_penalty_bps = params.nonseal_penalty_bps;
    m.min_players = params.min_players;
    m.max_players = params.max_players;
    m.player_count = 0;
    m.sealed_count = 0;
    m.next_seal_seq = 0;
    m.total_deposited = 0;
    m.total_fees = 0;
    m.forfeited_fees = 0;
    m.dead_money = 0;
    m.settled_payout = 0;

    m.button_randomness = [0u8; 32];
    m.button = 0;
    m.button_set = false;

    m.vault_bump = vault_bump;
    m.bump = bump;
    m.fees_withdrawn = false;
    m.void_kind = state::VoidKind::None;
    m.reserved = [0u8; 32];
}

/// Initialize a fresh `SeatAccount` (shared by `deposit` and `create_and_deposit`).
#[allow(clippy::too_many_arguments)]
fn write_seat(
    seat: &mut SeatAccount,
    match_key: Pubkey,
    player: Pubkey,
    seat_index: u16,
    buy_in: u64,
    entry_fee: u64,
    bump: u8,
) {
    seat.match_key = match_key;
    seat.player = player;
    seat.seat_index = seat_index;
    seat.deposit = buy_in;
    seat.entry_fee_paid = entry_fee;
    seat.payout = 0;
    seat.claimed = false;
    seat.bump = bump;
    seat.prediction_commitment = [0u8; 32];
    seat.timelock_target = 0;
    seat.seal_seq = 0;
    seat.commitment_set = false;
    seat.is_non_sealer = false;
    seat.penalty = 0;
    seat.engine_seat = state::NO_ENGINE_SEAT;
    seat.gets_remainder = false;
    seat.reserved = [0u8; 8];
}

/// Initialize the per-index dedupe `SeatIndexAccount`.
fn write_seat_index(
    sia: &mut SeatIndexAccount,
    match_key: Pubkey,
    player: Pubkey,
    seat_index: u16,
    bump: u8,
) {
    sia.match_key = match_key;
    sia.player = player;
    sia.seat_index = seat_index;
    sia.bump = bump;
    sia.reserved = [0u8; 8];
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

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
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
    /// 20-byte token/feed identifier signed by the signed-price-server.
    pub price_token: [u8; 20],
    /// Total wall-clock betting span (Σ street durations + observation), bound in config.
    /// `scheduled_end_ts` is derived on-chain at begin_live (= live_start + this).
    pub total_betting_duration_sec: u64,
    pub seal_window_sec: u64,
    /// Max delay after seal deadline for the operator to call begin_live (0 → default 5s).
    pub begin_live_window_sec: u64,
    pub fill_deadline_ts: u64,
    pub max_oracle_confidence: u64,
    pub oracle_exponent: i32,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct BeginLiveArgs {
    /// Backend-native CSPRNG randomness (server-attested, plan_v2 §3) used to derive the
    /// dealer button over the sealed seats. Recorded for audit; not on-chain verified —
    /// the button only sets blind/action order, so this is a deliberate low-risk choice.
    pub button_randomness: [u8; 32],
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
#[instruction(seat_index: u16)]
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
    #[account(
        init, payer = player, space = SeatIndexAccount::SPACE,
        seeds = [b"seat-index", match_account.key().as_ref(), seat_index.to_le_bytes().as_ref()], bump
    )]
    pub seat_index_account: Box<Account<'info, SeatIndexAccount>>,
    #[account(mut, constraint = player_token.mint == match_account.mint)]
    pub player_token: Box<Account<'info, TokenAccount>>,
    #[account(mut, address = match_account.vault)]
    pub vault: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

/// Atomic create + seat the creator (plan_v2 §3). Combines `CreateMatch` (match PDA +
/// vault init) with `Deposit` (creator's seat + seat-index + token transfer) so the
/// creator (`authority`) is seated in the same instruction. Account constraints reference
/// the passed `mint` (not `match_account.mint`, which is zeroed until the handler runs).
#[derive(Accounts)]
#[instruction(params: CreateParams, seat_index: u16)]
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
    #[account(
        init, payer = authority, space = SeatIndexAccount::SPACE,
        seeds = [b"seat-index", match_account.key().as_ref(), seat_index.to_le_bytes().as_ref()], bump
    )]
    pub seat_index_account: Box<Account<'info, SeatIndexAccount>>,
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

/// Permissionless LIVE void backstop: MatchAccount only, no ActionLog. Anyone may call.
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
    // Sealed seats are provided as `remaining_accounts`.
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
    #[account(mut,
        seeds = [b"seat-index", match_account.key().as_ref(), seat.seat_index.to_le_bytes().as_ref()],
        bump = seat_index_account.bump,
        constraint = seat_index_account.match_key == match_account.key(),
        constraint = seat_index_account.player == player.key(),
        constraint = seat_index_account.seat_index == seat.seat_index,
        close = player)]
    pub seat_index_account: Account<'info, SeatIndexAccount>,
    #[account(mut, address = match_account.vault)]
    pub vault: Account<'info, TokenAccount>,
    #[account(mut, constraint = player_token.mint == match_account.mint)]
    pub player_token: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

/// Seal during SEALING (before LIVE), recorded on the player's own seat. The player is
/// the transaction Signer — this IS the explicit seal signature (plan_v2 §1; no session
/// keys, no relayer, so no ed25519-sysvar binding is needed).
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
