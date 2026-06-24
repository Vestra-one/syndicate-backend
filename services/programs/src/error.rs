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
    #[msg("Seat already claimed.")]
    AlreadyClaimed,
    #[msg("Arithmetic overflow.")]
    Overflow,
    #[msg("Unauthorized.")]
    Unauthorized,
}
