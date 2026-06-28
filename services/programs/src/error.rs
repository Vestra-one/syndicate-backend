//! Program errors. Every failure maps to a deterministic, capital-safe outcome.

use anchor_lang::prelude::*;

#[error_code]
pub enum SyndicateError {
    #[msg("Action not allowed in the current match status.")]
    BadStatus,
    #[msg("Match is full.")]
    MatchFull,
    #[msg("Not enough players to start.")]
    NotEnoughPlayers,
    #[msg("Settlement re-verification failed; funds will NOT be released (04 §18).")]
    SettlementMismatch,
    #[msg("Conservation check failed: payouts + fees != deposits.")]
    ConservationViolation,
    #[msg("Oracle/settlement inputs invalid or insufficient.")]
    InvalidSettlementInput,
    #[msg("Pyth Receiver price update account/proof is missing, unauthenticated, or does not match the bound feed.")]
    InvalidOracleProof,
    #[msg("Seat already claimed.")]
    AlreadyClaimed,
    #[msg("Arithmetic overflow.")]
    Overflow,
    #[msg("Unauthorized.")]
    Unauthorized,
    #[msg("Protocol action is paused.")]
    Paused,
    #[msg("Seat index is invalid or duplicated.")]
    InvalidSeat,
    #[msg("Settlement did not include exactly the occupied seats.")]
    SeatSetMismatch,
    #[msg("Invalid signed action input.")]
    InvalidActionInput,
    #[msg("Action log is invalid or not initialized.")]
    InvalidActionLog,
    #[msg("Ed25519 signature verification failed.")]
    InvalidSignature,
    #[msg("Not this player's turn.")]
    NotYourTurn,
    #[msg("Action log is not finalized.")]
    ActionLogNotFinalized,
    #[msg("Engine replay is not complete.")]
    EngineNotComplete,
    #[msg("Prediction reveal does not match signed commitment.")]
    PredictionCommitmentMismatch,
    #[msg("Settlement deadline passed; use void/refund path.")]
    SettlementDeadlinePassed,
}
