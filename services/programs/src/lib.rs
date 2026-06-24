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
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

pub mod error;
pub mod settle_args;
pub mod state;

use error::SyndicateError;
use settle_args::SettleArgs;
use state::{MatchAccount, MatchStatus, SeatAccount};

// Placeholder program id — replace via `anchor keys sync` before deploy.
declare_id!("Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS");

#[program]
pub mod syndicate_program {
    use super::*;

    /// Create a match: bind fee config + the MatchConfig hash, open the vault, status → Filling.
    pub fn create_match(ctx: Context<CreateMatch>, params: CreateParams) -> Result<()> {
        let m = &mut ctx.accounts.match_account;
        m.authority = ctx.accounts.authority.key();
        m.mint = ctx.accounts.mint.key();
        m.vault = ctx.accounts.vault.key();
        m.match_id = params.match_id;
        m.buy_in = params.buy_in;
        m.status = MatchStatus::Filling;
        m.config_hash = params.config_hash;
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
        Ok(())
    }

    /// Deposit buy-in + entry fee → seat eligibility (the anti-spam gate, `05 §4`).
    pub fn deposit(ctx: Context<Deposit>, seat_index: u16) -> Result<()> {
        let m = &mut ctx.accounts.match_account;
        require!(m.status == MatchStatus::Filling, SyndicateError::BadStatus);
        require!(m.player_count < m.max_players, SyndicateError::MatchFull);

        let amount = m.buy_in.checked_add(m.entry_fee).ok_or(SyndicateError::Overflow)?;
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

        m.total_deposited = m.total_deposited.checked_add(m.buy_in).ok_or(SyndicateError::Overflow)?;
        m.total_fees = m.total_fees.checked_add(m.entry_fee).ok_or(SyndicateError::Overflow)?;
        m.player_count += 1;
        Ok(())
    }

    /// Lock the match: enough players present → deposits frozen, status → Live.
    /// (The SEALING sub-phase — time-lock encryption — is coordinated off-chain.)
    pub fn lock(ctx: Context<AdminMatch>) -> Result<()> {
        let m = &mut ctx.accounts.match_account;
        require!(m.status == MatchStatus::Filling, SyndicateError::BadStatus);
        require!(m.player_count >= m.min_players, SyndicateError::NotEnoughPlayers);
        m.status = MatchStatus::Live;
        Ok(())
    }

    /// Submit the final settlement. The program **re-verifies** it with the shared core
    /// and writes each seat's claimable payout; it never trusts the submitted result.
    /// Pass the seats as `remaining_accounts`.
    pub fn submit_settlement(ctx: Context<SubmitSettlement>, args: SettleArgs) -> Result<()> {
        let m = &mut ctx.accounts.match_account;
        require!(m.status == MatchStatus::Live, SyndicateError::BadStatus);

        // Rebuild shared inputs from recorded data and RE-VERIFY (04 §18).
        let players: Vec<syndicate_shared::PlayerState> =
            args.players.iter().map(|p| p.to_shared()).collect();
        let samples: Vec<syndicate_shared::Price> =
            args.settlement_samples.iter().map(|&s| s as syndicate_shared::Price).collect();
        let input = syndicate_shared::SettleInput {
            players: &players,
            settlement_samples: &samples,
            min_samples: args.min_samples as usize,
            rake_bps: args.rake_bps,
            rake_cap: args.rake_cap,
        };
        let claimed = args.claimed.to_shared();

        syndicate_shared::verify_settlement(&input, &claimed).map_err(|e| match e {
            syndicate_shared::CoreError::SettlementMismatch => SyndicateError::SettlementMismatch,
            _ => SyndicateError::InvalidSettlementInput,
        })?;

        // On-chain conservation: winnings + returns + rake must equal the locked stacks.
        let paid: u128 = args.claimed.pot_awards.iter().map(|a| a.amount as u128).sum::<u128>()
            + args.claimed.uncalled_returns.iter().map(|r| r.amount as u128).sum::<u128>()
            + args.claimed.rake_collected as u128;
        require!(paid == m.total_deposited as u128, SyndicateError::ConservationViolation);

        // Write each seat's pull-claimable payout (seats passed as remaining_accounts).
        let mut total_payout: u64 = 0;
        for acc in ctx.remaining_accounts.iter() {
            let mut seat: Account<SeatAccount> = Account::try_from(acc)?;
            require_keys_eq!(seat.match_key, m.key(), SyndicateError::Unauthorized);
            let payout = args.claimed.payout_for(seat.seat_index);
            seat.payout = payout;
            total_payout = total_payout.checked_add(payout).ok_or(SyndicateError::Overflow)?;
            seat.exit(&crate::ID)?;
        }

        m.total_fees = m.total_fees.checked_add(args.claimed.rake_collected).ok_or(SyndicateError::Overflow)?;
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
        let m = &mut ctx.accounts.match_account;
        require!(
            matches!(m.status, MatchStatus::Filling | MatchStatus::Sealing | MatchStatus::Live),
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

        let amount = seat.deposit.checked_add(seat.entry_fee_paid).ok_or(SyndicateError::Overflow)?;
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
pub struct CreateParams {
    pub match_id: u64,
    pub buy_in: u64,
    pub entry_fee: u64,
    pub rake_bps: u32,
    pub rake_cap: u64,
    pub min_players: u8,
    pub max_players: u8,
    pub config_hash: [u8; 32],
}

#[derive(Accounts)]
#[instruction(params: CreateParams)]
pub struct CreateMatch<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    pub mint: Account<'info, Mint>,
    #[account(
        init, payer = authority, space = MatchAccount::SPACE,
        seeds = [b"match", params.match_id.to_le_bytes().as_ref()], bump
    )]
    pub match_account: Account<'info, MatchAccount>,
    #[account(
        init, payer = authority,
        token::mint = mint, token::authority = match_account,
        seeds = [b"vault", match_account.key().as_ref()], bump
    )]
    pub vault: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
#[instruction(seat_index: u16)]
pub struct Deposit<'info> {
    #[account(mut)]
    pub player: Signer<'info>,
    #[account(mut, seeds = [b"match", match_account.match_id.to_le_bytes().as_ref()], bump = match_account.bump)]
    pub match_account: Account<'info, MatchAccount>,
    #[account(
        init, payer = player, space = SeatAccount::SPACE,
        seeds = [b"seat", match_account.key().as_ref(), player.key().as_ref()], bump
    )]
    pub seat: Account<'info, SeatAccount>,
    #[account(mut, constraint = player_token.mint == match_account.mint)]
    pub player_token: Account<'info, TokenAccount>,
    #[account(mut, address = match_account.vault)]
    pub vault: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AdminMatch<'info> {
    pub authority: Signer<'info>,
    #[account(mut, has_one = authority,
        seeds = [b"match", match_account.match_id.to_le_bytes().as_ref()], bump = match_account.bump)]
    pub match_account: Account<'info, MatchAccount>,
}

#[derive(Accounts)]
pub struct SubmitSettlement<'info> {
    pub authority: Signer<'info>,
    #[account(mut, has_one = authority,
        seeds = [b"match", match_account.match_id.to_le_bytes().as_ref()], bump = match_account.bump)]
    pub match_account: Account<'info, MatchAccount>,
    // Seats are provided as `remaining_accounts`.
}

#[derive(Accounts)]
pub struct Claim<'info> {
    #[account(mut)]
    pub player: Signer<'info>,
    #[account(mut, seeds = [b"match", match_account.match_id.to_le_bytes().as_ref()], bump = match_account.bump)]
    pub match_account: Account<'info, MatchAccount>,
    #[account(mut, has_one = player,
        seeds = [b"seat", match_account.key().as_ref(), player.key().as_ref()], bump = seat.bump)]
    pub seat: Account<'info, SeatAccount>,
    #[account(mut, address = match_account.vault)]
    pub vault: Account<'info, TokenAccount>,
    #[account(mut, constraint = player_token.mint == match_account.mint)]
    pub player_token: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}
