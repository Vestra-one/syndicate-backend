//! Action-log instruction handlers.

use anchor_lang::prelude::*;
use syndicate_engine_core::{Action, GENESIS_HEAD, MAX_SEATS};

use crate::action_log::{
    advance_head, canonical_action_step, core_action_from_tags, init_engine_from_match,
    map_engine_err, OnChainDefaultPolicy, SeatMeta,
};
use crate::{
    AppendPlayerAction, AppendTimeoutAction, FinalizeActionLog, InitActionLog, PermissionlessVoid,
    RegisterDefaultPolicy, RegisterPredictionCommitment,
};
use crate::ed25519_sysvar::verify_ed25519_instruction;
use crate::error::SyndicateError;
use crate::intent::{
    action_intent_message, default_policy_message, prediction_commitment_message,
};
use crate::state::{MatchAccount, MatchStatus, ProtocolState, SeatAccount};

pub const DEFAULT_TAG_CHECK_FOLD: u8 = 0;
pub const DEFAULT_TAG_CHECK_CALL_ANY: u8 = 1;

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct InitActionLogParams {
    pub button: u8,
    pub small_blind: u64,
    pub big_blind: u64,
    pub round_count: u8,
    pub settle_deadline_ts: u64,
    pub seal_seq: [u64; MAX_SEATS],
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct AppendPlayerActionArgs {
    pub seat_index: u16,
    pub nonce: u64,
    pub action_tag: u8,
    pub amount: u64,
    pub ed25519_ix_index: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct RegisterDefaultPolicyArgs {
    pub seat_index: u16,
    pub policy_tag: u8,
    pub ed25519_ix_index: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct RegisterPredictionCommitmentArgs {
    pub seat_index: u16,
    pub seal_seq: u64,
    pub commitment: [u8; 32],
    pub ed25519_ix_index: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct AppendTimeoutActionArgs {
    pub seat_index: u16,
}

pub fn init_action_log_handler(
    ctx: Context<InitActionLog>,
    params: InitActionLogParams,
) -> Result<()> {
    let m = &ctx.accounts.match_account;
    require!(m.status == MatchStatus::Live, SyndicateError::BadStatus);
    require!(m.button_set, SyndicateError::ButtonNotSet);
    require!(
        params.button == m.button,
        SyndicateError::InvalidActionInput
    );

    let log = &mut ctx.accounts.action_log;
    log.match_key = m.key();
    log.head = GENESIS_HEAD;
    log.event_root = [0u8; 32];
    log.finalized = false;
    log.action_count = 0;
    log.player_count = m.player_count;
    log.scheduled_end_ts = m.scheduled_end_ts;
    log.settle_deadline_ts = params.settle_deadline_ts;
    log.bump = ctx.bumps.action_log;

    let engine = init_engine_from_match(
        m.buy_in,
        m.player_count,
        params.button,
        params.small_blind,
        params.big_blind,
        params.round_count,
        &params.seal_seq,
    );
    log.set_engine(&engine)?;

    let mut seats = [SeatMeta::default(); MAX_SEATS];
    let seat_infos: Vec<_> = ctx.remaining_accounts.iter().cloned().collect();
    require!(
        seat_infos.len() == m.player_count as usize,
        SyndicateError::SeatSetMismatch
    );
    let mut seen = [false; MAX_SEATS];
    for seat_acc in seat_infos.iter() {
        let data = seat_acc.try_borrow_data()?;
        let seat = SeatAccount::try_deserialize(&mut &data[..])?;
        require_keys_eq!(seat.match_key, m.key(), SyndicateError::Unauthorized);
        let idx = seat.seat_index as usize;
        require!(idx < m.player_count as usize, SyndicateError::InvalidSeat);
        require!(!seen[idx], SyndicateError::SeatSetMismatch);
        seen[idx] = true;
        seats[idx] = SeatMeta {
            player: seat.player,
            seal_seq: params.seal_seq[idx],
            occupied: true,
            ..SeatMeta::default()
        };
    }
    log.seats = seats;
    Ok(())
}

pub fn register_default_policy_handler(
    ctx: Context<RegisterDefaultPolicy>,
    args: RegisterDefaultPolicyArgs,
) -> Result<()> {
    let m = &ctx.accounts.match_account;
    let log = &mut ctx.accounts.action_log;
    let idx = args.seat_index as usize;
    require!(idx < log.player_count as usize, SyndicateError::InvalidSeat);
    require!(!log.seats[idx].default_set, SyndicateError::InvalidActionInput);

    let policy = match args.policy_tag {
        DEFAULT_TAG_CHECK_FOLD => OnChainDefaultPolicy::CheckFold,
        DEFAULT_TAG_CHECK_CALL_ANY => OnChainDefaultPolicy::CheckCallAny,
        _ => return Err(error!(SyndicateError::InvalidActionInput)),
    };

    let seat_pubkey = log.seats[idx].player;
    let msg = default_policy_message(
        m.match_id,
        m.match_id,
        args.seat_index,
        &seat_pubkey,
        args.policy_tag,
    );
    verify_ed25519_instruction(
        &ctx.accounts.instructions.to_account_info(),
        args.ed25519_ix_index,
        &seat_pubkey,
        &msg,
    )?;

    log.seats[idx].default_policy = policy;
    log.seats[idx].default_set = true;
    Ok(())
}

pub fn register_prediction_commitment_handler(
    ctx: Context<RegisterPredictionCommitment>,
    args: RegisterPredictionCommitmentArgs,
) -> Result<()> {
    let m = &ctx.accounts.match_account;
    let log = &mut ctx.accounts.action_log;
    let idx = args.seat_index as usize;
    require!(idx < log.player_count as usize, SyndicateError::InvalidSeat);
    require!(!log.seats[idx].commitment_set, SyndicateError::InvalidActionInput);

    let seat_pubkey = log.seats[idx].player;
    let msg = prediction_commitment_message(
        m.match_id,
        m.match_id,
        args.seat_index,
        &seat_pubkey,
        args.seal_seq,
        &args.commitment,
    );
    verify_ed25519_instruction(
        &ctx.accounts.instructions.to_account_info(),
        args.ed25519_ix_index,
        &seat_pubkey,
        &msg,
    )?;

    log.seats[idx].prediction_commitment = args.commitment;
    log.seats[idx].seal_seq = args.seal_seq;
    log.seats[idx].commitment_set = true;
    Ok(())
}

pub fn append_player_action_handler(
    ctx: Context<AppendPlayerAction>,
    args: AppendPlayerActionArgs,
) -> Result<()> {
    require!(!ctx.accounts.action_log.finalized, SyndicateError::ActionLogNotFinalized);
    let m = &ctx.accounts.match_account;
    let p = &ctx.accounts.protocol_state;
    let log = &mut ctx.accounts.action_log;
    let idx = args.seat_index as usize;
    require!(idx < log.player_count as usize, SyndicateError::InvalidSeat);

    let seat_pubkey = log.seats[idx].player;
    let is_player = ctx.accounts.authority.key() == seat_pubkey;
    let is_admin = ctx.accounts.authority.key() == p.settlement_admin;
    require!(is_player || is_admin, SyndicateError::Unauthorized);

    let prev_head = log.head;
    let msg = action_intent_message(
        m.match_id,
        m.match_id,
        args.seat_index,
        &seat_pubkey,
        args.nonce,
        &prev_head,
        args.action_tag,
        args.amount,
    );
    verify_ed25519_instruction(
        &ctx.accounts.instructions.to_account_info(),
        args.ed25519_ix_index,
        &seat_pubkey,
        &msg,
    )?;

    require!(args.nonce > log.seats[idx].nonce, SyndicateError::InvalidActionInput);
    log.seats[idx].nonce = args.nonce;

    let mut engine = log.engine()?;
    let action = core_action_from_tags(args.action_tag, args.amount)?;
    engine
        .apply(idx, action)
        .map_err(map_engine_err)?;
    log.set_engine(&engine)?;

    let step = canonical_action_step(args.seat_index, args.nonce, args.action_tag, args.amount, false);
    log.head = advance_head(&prev_head, &step);
    log.action_count = log.action_count.saturating_add(1);
    Ok(())
}

pub fn append_timeout_action_handler(
    ctx: Context<AppendTimeoutAction>,
    args: AppendTimeoutActionArgs,
) -> Result<()> {
    require!(!ctx.accounts.action_log.finalized, SyndicateError::ActionLogNotFinalized);
    let log = &mut ctx.accounts.action_log;
    let idx = args.seat_index as usize;
    require!(idx < log.player_count as usize, SyndicateError::InvalidSeat);
    require!(log.seats[idx].default_set, SyndicateError::InvalidActionInput);
    let default = log.seats[idx]
        .default_policy
        .to_core()
        .ok_or(error!(SyndicateError::InvalidActionInput))?;
    let next_nonce = log.seats[idx].nonce.saturating_add(1);

    let prev_head = log.head;
    let mut engine = log.engine()?;
    let resolved = engine.default_action(idx, default);
    let (tag, amount) = action_to_tags(resolved);
    engine
        .apply_timeout(idx, default)
        .map_err(map_engine_err)?;
    log.set_engine(&engine)?;

    let step = canonical_action_step(args.seat_index, next_nonce, tag, amount, true);
    log.head = advance_head(&prev_head, &step);
    log.seats[idx].nonce = next_nonce;
    log.action_count = log.action_count.saturating_add(1);
    Ok(())
}

pub fn finalize_action_log_handler(
    ctx: Context<FinalizeActionLog>,
    event_root: [u8; 32],
) -> Result<()> {
    let log = &mut ctx.accounts.action_log;
    let engine = log.engine()?;
    require!(engine.is_complete(), SyndicateError::EngineNotComplete);
    log.event_root = event_root;
    require!(log.head == event_root, SyndicateError::InvalidActionInput);
    log.finalized = true;
    Ok(())
}

pub fn permissionless_void_after_deadline(ctx: Context<PermissionlessVoid>) -> Result<()> {
    let clock = Clock::get()?;
    let m = &mut ctx.accounts.match_account;
    require!(
        clock.unix_timestamp as u64 >= ctx.accounts.action_log.settle_deadline_ts,
        SyndicateError::BadStatus
    );
    require!(
        matches!(
            m.status,
            MatchStatus::Live | MatchStatus::Sealing
        ),
        SyndicateError::BadStatus
    );
    m.status = MatchStatus::Void;
    Ok(())
}

fn action_to_tags(action: Action) -> (u8, u64) {
    match action {
        Action::Fold => (0, 0),
        Action::Check => (1, 0),
        Action::Call => (2, 0),
        Action::BetTo(a) => (3, a),
        Action::RaiseTo(a) => (4, a),
        Action::AllIn => (5, 0),
    }
}
