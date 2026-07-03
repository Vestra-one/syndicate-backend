//! Seal instruction handler (prediction commitment recorded during Sealing).

use anchor_lang::prelude::*;

use crate::{error::SyndicateError, state::MatchStatus, RegisterPredictionCommitment};

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct RegisterPredictionCommitmentArgs {
    /// Hash of the time-lock ciphertext (the prediction commitment): sha256(ciphertext).
    pub commitment: [u8; 32],
    /// drand round the prediction is time-lock encrypted to (must publish after match end).
    pub timelock_target: u64,
}

/// Record the player's seal commitment on their seat DURING Sealing, before LIVE.
/// Gated `status == Sealing && now <= seal_deadline_ts && seat.confirmed`. The player is
/// the transaction Signer (explicit seal signature; no session key). Seal ORDER is a
/// backend concern in v2 (off-chain event order); the chain only binds the commitment.
pub fn register_prediction_commitment_handler(
    ctx: Context<RegisterPredictionCommitment>,
    args: RegisterPredictionCommitmentArgs,
) -> Result<()> {
    let now = Clock::get()?.unix_timestamp as u64;
    {
        let m = &ctx.accounts.match_account;
        require!(m.status == MatchStatus::Sealing, SyndicateError::BadStatus);
        require!(now <= m.seal_deadline_ts, SyndicateError::SealWindowClosed);
        // The time-lock target must publish AFTER the projected match end, so no one can
        // decrypt mid-match. Projected end = seal_deadline + total betting duration.
        // begin_live may run up to `begin_live_window_sec` after the seal deadline, so the
        // LATEST possible match end is projected_end + that window. Bound the timelock
        // target against that worst case:
        //  - lower: must publish AFTER the latest match end (never decryptable mid-match).
        //  - upper: within MAX_TIMELOCK_SKEW_SEC of it, so it is always decryptable at
        //    settlement — a far-future round would force a void (grief vector).
        let latest_match_end = m
            .seal_deadline_ts
            .checked_add(m.total_betting_duration_sec)
            .and_then(|v| v.checked_add(m.begin_live_window_sec))
            .ok_or(SyndicateError::Overflow)?;
        let target_pub =
            crate::drand_round_publish_ts(args.timelock_target).ok_or(SyndicateError::Overflow)?;
        require!(target_pub > latest_match_end, SyndicateError::InvalidDrandRound);
        let max_target_pub = latest_match_end
            .checked_add(crate::MAX_TIMELOCK_SKEW_SEC)
            .ok_or(SyndicateError::Overflow)?;
        require!(target_pub <= max_target_pub, SyndicateError::InvalidDrandRound);
    }
    let seat = &mut ctx.accounts.seat;
    require!(seat.confirmed, SyndicateError::SeatNotConfirmed);
    require!(!seat.commitment_set, SyndicateError::AlreadySealed);

    seat.prediction_commitment = args.commitment;
    seat.timelock_target = args.timelock_target;
    seat.commitment_set = true;
    Ok(())
}
