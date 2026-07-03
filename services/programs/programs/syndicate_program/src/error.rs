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
    #[msg("Conservation check failed: payouts + fees != deposits.")]
    ConservationViolation,
    #[msg("Oracle/settlement inputs invalid or insufficient.")]
    InvalidSettlementInput,
    #[msg("Signed price proof is missing, unauthenticated, or not from the whitelisted signer.")]
    InvalidOracleProof,
    #[msg("Seat already claimed.")]
    AlreadyClaimed,
    #[msg("Arithmetic overflow.")]
    Overflow,
    #[msg("Unauthorized.")]
    Unauthorized,
    #[msg("Protocol action is paused.")]
    Paused,
    #[msg("Seat is invalid or duplicated.")]
    InvalidSeat,
    #[msg("Settlement did not include exactly the confirmed seats.")]
    SeatSetMismatch,
    #[msg("Prediction reveal does not match signed commitment.")]
    PredictionCommitmentMismatch,
    #[msg("Settlement deadline passed; use void/refund path.")]
    SettlementDeadlinePassed,
    #[msg("Match fees were already withdrawn.")]
    FeesAlreadyWithdrawn,
    #[msg("Dealer button has not been recorded.")]
    ButtonNotSet,
    #[msg("Seal window has closed; commitment rejected (after seal_deadline_ts).")]
    SealWindowClosed,
    #[msg("Seal deadline has not been reached; cannot begin live yet.")]
    SealDeadlineNotReached,
    #[msg("Fill deadline has not been reached; cannot permissionlessly void yet.")]
    FillDeadlineNotReached,
    #[msg("Settlement grace has not elapsed; cannot permissionlessly void the live match yet.")]
    SettleGraceNotElapsed,
    #[msg("begin_live window elapsed; the operator did not start the match in time (void only).")]
    BeginLiveWindowPassed,
    #[msg("Seat has already recorded a seal commitment.")]
    AlreadySealed,
    #[msg("Timelock target round is invalid (must publish just after the latest match end).")]
    InvalidDrandRound,
    #[msg("Oracle tolerance window is too wide; must be tight (single-update).")]
    OracleToleranceTooWide,
    #[msg("Invalid match configuration parameter.")]
    InvalidConfig,
    #[msg("Refund not available for this seat in the current match state.")]
    RefundUnavailable,
    #[msg("Seat was not confirmed into the playing set at lock.")]
    SeatNotConfirmed,
    #[msg("Candidate limit reached for this match.")]
    CandidateLimitReached,
    #[msg("Room commitment is required for private rooms and must be zero for public rooms.")]
    InvalidRoomCommitment,
}
