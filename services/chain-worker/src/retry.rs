//! Retry policy: base 1s ×2 exponential; cap 30s (60s for the unbounded void kinds).
//!
//! Attempts are consumed only by real execution failures (simulate/send/confirm/tx
//! errors and settlement pipeline faults). Gate waits (e.g. "scheduled_end not reached",
//! drand round not yet published inside the grace window) reschedule WITHOUT consuming an
//! attempt — they are time-driven, not failure-driven.

use crate::db::JobKind;

pub const BASE_DELAY_MS: u64 = 1_000;
pub const CAP_DELAY_MS: u64 = 30_000;
pub const VOID_CAP_DELAY_MS: u64 = 60_000;

/// Max failure attempts before dead-letter. `None` = unbounded (permissionless voids —
/// they are the capital-safety backstop and must never give up).
pub fn max_attempts(kind: JobKind) -> Option<u32> {
    match kind {
        JobKind::Lock | JobKind::BeginLive => Some(5),
        JobKind::SubmitSettlement => Some(8),
        JobKind::WithdrawFees => Some(5),
        JobKind::VoidBeforeStart | JobKind::VoidLiveAfterDeadline | JobKind::Void => None,
    }
}

/// Delay before retry number `attempt` (1-based: the delay scheduled AFTER the
/// `attempt`-th failure).
pub fn retry_delay_ms(kind: JobKind, attempt: u32) -> u64 {
    let cap = match kind {
        JobKind::VoidBeforeStart | JobKind::VoidLiveAfterDeadline | JobKind::Void => {
            VOID_CAP_DELAY_MS
        }
        _ => CAP_DELAY_MS,
    };
    let shift = attempt.saturating_sub(1).min(20);
    BASE_DELAY_MS.saturating_mul(1u64 << shift).min(cap)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn schedule_doubles_and_caps() {
        assert_eq!(retry_delay_ms(JobKind::Lock, 1), 1_000);
        assert_eq!(retry_delay_ms(JobKind::Lock, 2), 2_000);
        assert_eq!(retry_delay_ms(JobKind::Lock, 3), 4_000);
        assert_eq!(retry_delay_ms(JobKind::Lock, 5), 16_000);
        assert_eq!(retry_delay_ms(JobKind::Lock, 6), 30_000); // capped
        assert_eq!(retry_delay_ms(JobKind::Lock, 60), 30_000); // shift-safe
                                                               // Void kinds cap at 60s.
        assert_eq!(retry_delay_ms(JobKind::VoidLiveAfterDeadline, 6), 32_000);
        assert_eq!(retry_delay_ms(JobKind::VoidLiveAfterDeadline, 7), 60_000);
        assert_eq!(retry_delay_ms(JobKind::Void, 30), 60_000);
    }

    #[test]
    fn attempt_budgets_match_plan() {
        assert_eq!(max_attempts(JobKind::Lock), Some(5));
        assert_eq!(max_attempts(JobKind::BeginLive), Some(5));
        assert_eq!(max_attempts(JobKind::SubmitSettlement), Some(8));
        assert_eq!(max_attempts(JobKind::WithdrawFees), Some(5));
        assert_eq!(max_attempts(JobKind::VoidBeforeStart), None);
        assert_eq!(max_attempts(JobKind::VoidLiveAfterDeadline), None);
        assert_eq!(max_attempts(JobKind::Void), None);
    }
}
