//! # Syndicate on-chain program (Anchor)
//!
//! Custody + final-settlement **verification** for Syndicate matches. The program is
//! the source of truth for funds and the last line of capital safety. It never trusts
//! the off-chain settlement: it re-derives the result with the **same** deterministic
//! crate (`syndicate-shared`) and only releases funds if the submitted result matches
//! and conservation holds (`04_GAME_MECHANICS §9, §10, §14, §18`; `services/programs/ARCHITECTURE.md`).
//!
//! BUILD STATUS: source-complete for Phase 2. Compiled/tested in the Solana CI
//! (`anchor build && anchor test`); the Solana platform toolchain is not available in
//! the doc-authoring sandbox, so this crate is not compiled there. The trust-critical
//! verification logic it calls (`syndicate_shared::verify_settlement`) IS compiled and
//! unit-tested in `services/shared` (see `tests/core.rs`).

use anchor_lang::prelude::*;
use anchor_lang::solana_program::sysvar::instructions::ID as IX_SYSVAR_ID;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

pub mod action_handlers;
pub mod action_log;
pub mod ed25519_sysvar;
pub mod error;
pub mod intent;
pub mod pyth_receiver;
pub mod settle_args;
pub mod state;

use action_handlers::{
    append_player_action_handler, append_timeout_action_handler, finalize_action_log_handler,
    init_action_log_handler, permissionless_void_after_deadline,
    register_default_policy_handler, register_prediction_commitment_handler,
    AppendPlayerActionArgs, AppendTimeoutActionArgs, InitActionLogParams,
    RegisterDefaultPolicyArgs, RegisterPredictionCommitmentArgs,
};
use action_log::{ActionLog, ACTION_LOG_SEED};
use error::SyndicateError;
use pyth_receiver::verified_update_from_pyth_account;
use pyth_solana_receiver_sdk::price_update::PriceUpdateV2;
use settle_args::{player_states_from_engine, SettleArgs};
use state::{MatchAccount, MatchStatus, ProtocolState, SeatAccount, SeatIndexAccount};

declare_id!("FR4tqVX41CDmUbJEbM7Qx5hxfQnfLmCJspTab7fou3WS");

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
        p.pause_new_matches = false;
        p.pause_settlement = false;
        p.bump = ctx.bumps.protocol_state;
        p.reserved = [0u8; 32];
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

    /// Create a match: bind fee config + the MatchConfig hash, open the vault, status → Filling.
    pub fn create_match(ctx: Context<CreateMatch>, params: CreateParams) -> Result<()> {
        let p = &ctx.accounts.protocol_state;
        require_keys_eq!(
            ctx.accounts.authority.key(),
            p.config_admin,
            SyndicateError::Unauthorized
        );
        require!(!p.pause_new_matches, SyndicateError::Paused);
        require!(params.min_players >= 2, SyndicateError::InvalidActionInput);
        require!(params.max_players <= 5, SyndicateError::InvalidActionInput);
        require!(
            params.min_players <= params.max_players,
            SyndicateError::InvalidActionInput
        );
        require!(params.buy_in > 0, SyndicateError::InvalidActionInput);
        require!(params.rake_bps <= 10_000, SyndicateError::InvalidActionInput);
        require!(params.rake_cap <= params.buy_in, SyndicateError::InvalidActionInput);

        let m = &mut ctx.accounts.match_account;
        m.authority = ctx.accounts.authority.key();
        m.mint = ctx.accounts.mint.key();
        m.vault = ctx.accounts.vault.key();
        m.match_id = params.match_id;
        m.buy_in = params.buy_in;
        m.status = MatchStatus::Filling;
        m.config_hash = params.config_hash;
        m.price_feed_id = params.price_feed_id;
        m.scheduled_end_ts = params.scheduled_end_ts;
        m.oracle_delay_window_sec = params.oracle_delay_window_sec;
        m.max_oracle_confidence = params.max_oracle_confidence;
        m.oracle_exponent = params.oracle_exponent;
        m.entry_fee = params.entry_fee;
        m.rake_bps = params.rake_bps;
        m.rake_cap = params.rake_cap;
        m.min_players = params.min_players;
        m.max_players = params.max_players;
        m.player_count = 0;
        m.total_deposited = 0;
        m.total_fees = 0;
        m.settled_payout = 0;
        m.vault_bump = ctx.bumps.vault;
        m.bump = ctx.bumps.match_account;
        m.vrf_seed = [0u8; 32];
        m.vrf_proof_hash = [0u8; 32];
        m.button = 0;
        m.button_set = false;
        m.fees_withdrawn = false;
        m.reserved = [0u8; 32];
        Ok(())
    }

    /// Deposit buy-in + entry fee → seat eligibility (the anti-spam gate, `05 §4`).
    pub fn deposit(ctx: Context<Deposit>, seat_index: u16) -> Result<()> {
        require!(
            !ctx.accounts.protocol_state.pause_new_matches,
            SyndicateError::Paused
        );
        let m = &mut ctx.accounts.match_account;
        require!(m.status == MatchStatus::Filling, SyndicateError::BadStatus);
        require!(m.player_count < m.max_players, SyndicateError::MatchFull);
        require!(
            seat_index < m.max_players as u16,
            SyndicateError::InvalidSeat
        );

        let amount = m
            .buy_in
            .checked_add(m.entry_fee)
            .ok_or(SyndicateError::Overflow)?;
        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.player_token.to_account_info(),
                    to: ctx.accounts.vault.to_account_info(),
                    authority: ctx.accounts.player.to_account_info(),
                },
            ),
            amount,
        )?;

        let seat = &mut ctx.accounts.seat;
        seat.match_key = m.key();
        seat.player = ctx.accounts.player.key();
        seat.seat_index = seat_index;
        seat.deposit = m.buy_in;
        seat.entry_fee_paid = m.entry_fee;
        seat.payout = 0;
        seat.claimed = false;
        seat.bump = ctx.bumps.seat;
        seat.reserved = [0u8; 8];

        let seat_index_account = &mut ctx.accounts.seat_index_account;
        seat_index_account.match_key = m.key();
        seat_index_account.player = ctx.accounts.player.key();
        seat_index_account.seat_index = seat_index;
        seat_index_account.bump = ctx.bumps.seat_index_account;
        seat_index_account.reserved = [0u8; 8];

        m.total_deposited = m
            .total_deposited
            .checked_add(m.buy_in)
            .ok_or(SyndicateError::Overflow)?;
        m.total_fees = m
            .total_fees
            .checked_add(m.entry_fee)
            .ok_or(SyndicateError::Overflow)?;
        m.player_count += 1;
        Ok(())
    }

    /// Lock the match: enough players present → seats frozen, status → Sealing.
    pub fn lock(ctx: Context<AdminMatch>) -> Result<()> {
        let p = &ctx.accounts.protocol_state;
        require!(
            ctx.accounts.authority.key() == p.settlement_admin
                || ctx.accounts.authority.key() == p.config_admin,
            SyndicateError::Unauthorized
        );
        let m = &mut ctx.accounts.match_account;
        require!(m.status == MatchStatus::Filling, SyndicateError::BadStatus);
        require!(
            m.player_count >= m.min_players,
            SyndicateError::NotEnoughPlayers
        );
        m.status = MatchStatus::Sealing;
        Ok(())
    }

    /// Record VRF output and derive the dealer button (once per match, at SEALING).
    pub fn set_button_seed(ctx: Context<SetButtonSeed>, args: SetButtonSeedArgs) -> Result<()> {
        let p = &ctx.accounts.protocol_state;
        require!(
            ctx.accounts.authority.key() == p.settlement_admin
                || ctx.accounts.authority.key() == p.config_admin,
            SyndicateError::Unauthorized
        );
        let m = &mut ctx.accounts.match_account;
        require!(m.status == MatchStatus::Sealing, SyndicateError::BadStatus);
        require!(!m.button_set, SyndicateError::InvalidActionInput);
        require!(m.player_count > 0, SyndicateError::NotEnoughPlayers);
        m.vrf_seed = args.vrf_seed;
        m.vrf_proof_hash = args.vrf_proof_hash;
        let seed_u64 = u64::from_le_bytes(args.vrf_seed[0..8].try_into().unwrap());
        m.button = (seed_u64 % m.player_count as u64) as u8;
        m.button_set = true;
        Ok(())
    }

    /// Advance Sealing → Live after button + off-chain seals are ready.
    pub fn begin_live(ctx: Context<AdminMatch>) -> Result<()> {
        let p = &ctx.accounts.protocol_state;
        require!(
            ctx.accounts.authority.key() == p.settlement_admin
                || ctx.accounts.authority.key() == p.config_admin,
            SyndicateError::Unauthorized
        );
        let m = &mut ctx.accounts.match_account;
        require!(m.status == MatchStatus::Sealing, SyndicateError::BadStatus);
        require!(m.button_set, SyndicateError::ButtonNotSet);
        m.status = MatchStatus::Live;
        Ok(())
    }

    /// Initialize the on-chain action log for replay after lock.
    pub fn init_action_log(ctx: Context<InitActionLog>, params: InitActionLogParams) -> Result<()> {
        let p = &ctx.accounts.protocol_state;
        require!(
            ctx.accounts.authority.key() == p.settlement_admin
                || ctx.accounts.authority.key() == p.config_admin,
            SyndicateError::Unauthorized
        );
        init_action_log_handler(ctx, params)
    }

    pub fn register_default_policy(
        ctx: Context<RegisterDefaultPolicy>,
        args: RegisterDefaultPolicyArgs,
    ) -> Result<()> {
        register_default_policy_handler(ctx, args)
    }

    pub fn register_prediction_commitment(
        ctx: Context<RegisterPredictionCommitment>,
        args: RegisterPredictionCommitmentArgs,
    ) -> Result<()> {
        register_prediction_commitment_handler(ctx, args)
    }

    pub fn append_player_action(
        ctx: Context<AppendPlayerAction>,
        args: AppendPlayerActionArgs,
    ) -> Result<()> {
        append_player_action_handler(ctx, args)
    }

    pub fn append_timeout_action(
        ctx: Context<AppendTimeoutAction>,
        args: AppendTimeoutActionArgs,
    ) -> Result<()> {
        let p = &ctx.accounts.protocol_state;
        require_keys_eq!(
            ctx.accounts.authority.key(),
            p.settlement_admin,
            SyndicateError::Unauthorized
        );
        append_timeout_action_handler(ctx, args)
    }

    pub fn finalize_action_log(
        ctx: Context<FinalizeActionLog>,
        event_root: [u8; 32],
    ) -> Result<()> {
        let p = &ctx.accounts.protocol_state;
        require_keys_eq!(
            ctx.accounts.authority.key(),
            p.settlement_admin,
            SyndicateError::Unauthorized
        );
        finalize_action_log_handler(ctx, event_root)
    }

    /// Permissionless void after settle deadline (anti-censorship liveness).
    pub fn void_after_deadline(ctx: Context<PermissionlessVoid>) -> Result<()> {
        permissionless_void_after_deadline(ctx)
    }

    /// Submit the final settlement. Replays the action log on-chain and re-verifies.
    /// Pass the seats as `remaining_accounts`.
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
        require!(args.vrf_seed == m.vrf_seed, SyndicateError::VrfSeedMismatch);

        let log = &ctx.accounts.action_log;
        require!(log.finalized, SyndicateError::ActionLogNotFinalized);
        require_keys_eq!(log.match_key, m.key(), SyndicateError::Unauthorized);

        let engine = log.engine().map_err(|_| error!(SyndicateError::InvalidActionLog))?;
        require!(engine.is_complete(), SyndicateError::EngineNotComplete);
        require!(log.head == log.event_root, SyndicateError::InvalidActionInput);

        require!(
            ctx.remaining_accounts.len() == m.player_count as usize,
            SyndicateError::SeatSetMismatch
        );

        let mut seen_seats = [false; 5];
        for acc in ctx.remaining_accounts.iter() {
            let seat: Account<SeatAccount> = Account::try_from(acc)?;
            require_keys_eq!(seat.match_key, m.key(), SyndicateError::Unauthorized);
            require!(
                seat.seat_index < m.max_players as u16,
                SyndicateError::InvalidSeat
            );
            let idx = seat.seat_index as usize;
            require!(!seen_seats[idx], SyndicateError::SeatSetMismatch);
            seen_seats[idx] = true;
            let (expected, _bump) = Pubkey::find_program_address(
                &[b"seat", m.key().as_ref(), seat.player.as_ref()],
                &crate::ID,
            );
            require_keys_eq!(expected, acc.key(), SyndicateError::Unauthorized);
        }

        let players = player_states_from_engine(&engine, &args.revealed, &log.seats)
            .map_err(|_| error!(SyndicateError::PredictionCommitmentMismatch))?;

        let oracle_rules = syndicate_shared::OracleValidation {
            expected_feed_id: m.price_feed_id,
            scheduled_end_ts: m.scheduled_end_ts,
            oracle_delay_window_sec: m.oracle_delay_window_sec,
            max_confidence: m.max_oracle_confidence,
            expected_exponent: m.oracle_exponent,
        };
        let authenticated_update =
            verified_update_from_pyth_account(&ctx.accounts.price_update, m.price_feed_id)?;
        require!(
            args.oracle_price.to_update() == authenticated_update,
            SyndicateError::InvalidSettlementInput
        );
        let oracle_price =
            syndicate_shared::validate_oracle_update(&authenticated_update, &oracle_rules)
                .map_err(|_| SyndicateError::InvalidSettlementInput)?;
        let input = syndicate_shared::SettleInput {
            players: &players,
            oracle_price,
            rake_bps: m.rake_bps,
            rake_cap: m.rake_cap,
        };
        let claimed = args.claimed.to_shared();

        syndicate_shared::verify_settlement(&input, &claimed).map_err(|e| match e {
            syndicate_shared::CoreError::SettlementMismatch => SyndicateError::SettlementMismatch,
            _ => SyndicateError::InvalidSettlementInput,
        })?;

        let paid: u128 = args
            .claimed
            .pot_awards
            .iter()
            .map(|a| a.amount as u128)
            .sum::<u128>()
            + args
                .claimed
                .uncalled_returns
                .iter()
                .map(|r| r.amount as u128)
                .sum::<u128>()
            + args.claimed.rake_collected as u128;
        require!(
            paid == m.total_deposited as u128,
            SyndicateError::ConservationViolation
        );

        let mut total_payout: u64 = 0;
        for acc in ctx.remaining_accounts.iter() {
            let mut seat: Account<SeatAccount> = Account::try_from(acc)?;
            require_keys_eq!(seat.match_key, m.key(), SyndicateError::Unauthorized);
            let payout = args.claimed.payout_for(seat.seat_index);
            seat.payout = payout;
            total_payout = total_payout
                .checked_add(payout)
                .ok_or(SyndicateError::Overflow)?;
            seat.exit(&crate::ID)?;
        }
        let expected_payout = m
            .total_deposited
            .checked_sub(args.claimed.rake_collected)
            .ok_or(SyndicateError::ConservationViolation)?;
        require!(
            total_payout == expected_payout,
            SyndicateError::ConservationViolation
        );

        m.total_fees = m
            .total_fees
            .checked_add(args.claimed.rake_collected)
            .ok_or(SyndicateError::Overflow)?;
        m.settled_payout = total_payout;
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

    /// Abort a match (insufficient players, oracle/timelock fault). Status → Void.
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
        m.status = MatchStatus::Void;
        Ok(())
    }

    /// Full refund of deposit **and entry fee** on VOID (no game, no fee — `04 §14`).
    pub fn refund(ctx: Context<Claim>) -> Result<()> {
        let m = &ctx.accounts.match_account;
        require!(m.status == MatchStatus::Void, SyndicateError::BadStatus);
        let seat = &mut ctx.accounts.seat;
        require!(!seat.claimed, SyndicateError::AlreadyClaimed);

        let amount = seat
            .deposit
            .checked_add(seat.entry_fee_paid)
            .ok_or(SyndicateError::Overflow)?;
        seat.claimed = true;
        transfer_from_vault(
            amount,
            &ctx.accounts.vault,
            &ctx.accounts.player_token,
            &ctx.accounts.match_account,
            &ctx.accounts.token_program,
        )?;
        Ok(())
    }

    /// Withdraw accumulated entry fees + rake to the protocol treasury (post-settlement).
    pub fn withdraw_fees(ctx: Context<WithdrawFees>) -> Result<()> {
        let p = &ctx.accounts.protocol_state;
        require_keys_eq!(
            ctx.accounts.authority.key(),
            p.treasury_admin,
            SyndicateError::Unauthorized
        );
        let m = &mut ctx.accounts.match_account;
        require!(m.status == MatchStatus::Settled, SyndicateError::BadStatus);
        require!(!m.fees_withdrawn, SyndicateError::FeesAlreadyWithdrawn);
        let amount = m.total_fees;
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
    pub min_players: u8,
    pub max_players: u8,
    pub config_hash: [u8; 32],
    pub price_feed_id: [u8; 32],
    pub scheduled_end_ts: u64,
    pub oracle_delay_window_sec: u64,
    pub max_oracle_confidence: u64,
    pub oracle_exponent: i32,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct SetButtonSeedArgs {
    pub vrf_seed: [u8; 32],
    pub vrf_proof_hash: [u8; 32],
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

#[derive(Accounts)]
pub struct AdminMatch<'info> {
    pub authority: Signer<'info>,
    #[account(seeds = [b"protocol"], bump = protocol_state.bump)]
    pub protocol_state: Account<'info, ProtocolState>,
    #[account(mut, seeds = [b"match", match_account.match_id.to_le_bytes().as_ref()], bump = match_account.bump)]
    pub match_account: Account<'info, MatchAccount>,
}

#[derive(Accounts)]
pub struct SetButtonSeed<'info> {
    pub authority: Signer<'info>,
    #[account(seeds = [b"protocol"], bump = protocol_state.bump)]
    pub protocol_state: Account<'info, ProtocolState>,
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
    #[account(
        seeds = [action_log::ACTION_LOG_SEED, match_account.key().as_ref()],
        bump = action_log.bump,
        constraint = action_log.match_key == match_account.key(),
        constraint = action_log.finalized @ SyndicateError::ActionLogNotFinalized,
    )]
    pub action_log: Account<'info, action_log::ActionLog>,
    pub price_update: Account<'info, PriceUpdateV2>,
    // Seats are provided as `remaining_accounts`.
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

#[derive(Accounts)]
pub struct InitActionLog<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(seeds = [b"protocol"], bump = protocol_state.bump)]
    pub protocol_state: Account<'info, ProtocolState>,
    #[account(
        mut,
        seeds = [b"match", match_account.match_id.to_le_bytes().as_ref()],
        bump = match_account.bump,
        constraint = match_account.status == MatchStatus::Live @ SyndicateError::BadStatus,
    )]
    pub match_account: Account<'info, MatchAccount>,
    #[account(
        init,
        payer = authority,
        space = 8 + ActionLog::BASE_SPACE,
        seeds = [ACTION_LOG_SEED, match_account.key().as_ref()],
        bump,
    )]
    pub action_log: Account<'info, ActionLog>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RegisterDefaultPolicy<'info> {
    pub player: Signer<'info>,
    #[account(
        mut,
        seeds = [ACTION_LOG_SEED, match_account.key().as_ref()],
        bump = action_log.bump,
        constraint = action_log.match_key == match_account.key(),
    )]
    pub action_log: Account<'info, ActionLog>,
    pub match_account: Account<'info, MatchAccount>,
    /// CHECK: instructions sysvar
    #[account(address = IX_SYSVAR_ID)]
    pub instructions: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct RegisterPredictionCommitment<'info> {
    pub player: Signer<'info>,
    #[account(
        mut,
        seeds = [ACTION_LOG_SEED, match_account.key().as_ref()],
        bump = action_log.bump,
        constraint = action_log.match_key == match_account.key(),
    )]
    pub action_log: Account<'info, ActionLog>,
    pub match_account: Account<'info, MatchAccount>,
    /// CHECK: instructions sysvar
    #[account(address = IX_SYSVAR_ID)]
    pub instructions: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct AppendPlayerAction<'info> {
    pub authority: Signer<'info>,
    #[account(seeds = [b"protocol"], bump = protocol_state.bump)]
    pub protocol_state: Account<'info, ProtocolState>,
    #[account(
        mut,
        seeds = [ACTION_LOG_SEED, match_account.key().as_ref()],
        bump = action_log.bump,
        constraint = action_log.match_key == match_account.key(),
    )]
    pub action_log: Account<'info, ActionLog>,
    pub match_account: Account<'info, MatchAccount>,
    /// CHECK: instructions sysvar
    #[account(address = IX_SYSVAR_ID)]
    pub instructions: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct AppendTimeoutAction<'info> {
    pub authority: Signer<'info>,
    #[account(seeds = [b"protocol"], bump = protocol_state.bump)]
    pub protocol_state: Account<'info, ProtocolState>,
    #[account(
        mut,
        seeds = [ACTION_LOG_SEED, match_account.key().as_ref()],
        bump = action_log.bump,
        constraint = action_log.match_key == match_account.key(),
    )]
    pub action_log: Account<'info, ActionLog>,
    pub match_account: Account<'info, MatchAccount>,
}

#[derive(Accounts)]
pub struct FinalizeActionLog<'info> {
    pub authority: Signer<'info>,
    #[account(seeds = [b"protocol"], bump = protocol_state.bump)]
    pub protocol_state: Account<'info, ProtocolState>,
    #[account(
        mut,
        seeds = [ACTION_LOG_SEED, match_account.key().as_ref()],
        bump = action_log.bump,
        constraint = action_log.match_key == match_account.key(),
    )]
    pub action_log: Account<'info, ActionLog>,
    pub match_account: Account<'info, MatchAccount>,
}

#[derive(Accounts)]
pub struct PermissionlessVoid<'info> {
    #[account(
        mut,
        seeds = [b"match", match_account.match_id.to_le_bytes().as_ref()],
        bump = match_account.bump,
    )]
    pub match_account: Account<'info, MatchAccount>,
    #[account(
        seeds = [ACTION_LOG_SEED, match_account.key().as_ref()],
        bump = action_log.bump,
        constraint = action_log.match_key == match_account.key(),
    )]
    pub action_log: Account<'info, ActionLog>,
}
