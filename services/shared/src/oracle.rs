//! Pyth bounded exact-after oracle validation.
//!
//! The canonical settlement price is the first valid Pyth update whose publish time is
//! inside `[scheduled_end_ts, scheduled_end_ts + oracle_delay_window_sec]`. This module
//! is pure and signature-agnostic: the Solana program is responsible for verifying the
//! Pyth account/proof, then feeds the authenticated metadata through these same rules.

use crate::types::{CoreError, Price};

/// Pyth price feed id. Pyth feed ids are 32-byte identifiers.
pub type FeedId = [u8; 32];

/// Authenticated Pyth price metadata after receiver/proof verification.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct OraclePriceUpdate {
    pub feed_id: FeedId,
    pub price: Price,
    pub publish_time: u64,
    pub confidence: u64,
    pub exponent: i32,
}

/// Oracle rules bound into the match config at creation.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct OracleValidation {
    pub expected_feed_id: FeedId,
    pub scheduled_end_ts: u64,
    pub oracle_delay_window_sec: u64,
    pub max_confidence: u64,
    pub expected_exponent: i32,
}

/// The single oracle price consumed by settlement.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct VerifiedOraclePrice {
    pub feed_id: FeedId,
    pub price: Price,
    pub publish_time: u64,
    pub confidence: u64,
    pub exponent: i32,
}

impl OracleValidation {
    pub fn window_end(&self) -> Result<u64, CoreError> {
        self.scheduled_end_ts
            .checked_add(self.oracle_delay_window_sec)
            .ok_or(CoreError::InvalidOraclePrice)
    }
}

/// Validate one authenticated Pyth update against the bound match rules.
pub fn validate_oracle_update(
    update: &OraclePriceUpdate,
    rules: &OracleValidation,
) -> Result<VerifiedOraclePrice, CoreError> {
    if update.feed_id != rules.expected_feed_id {
        return Err(CoreError::InvalidOraclePrice);
    }
    if update.exponent != rules.expected_exponent {
        return Err(CoreError::InvalidOraclePrice);
    }
    if update.confidence > rules.max_confidence {
        return Err(CoreError::InvalidOraclePrice);
    }
    let window_end = rules.window_end()?;
    if update.publish_time < rules.scheduled_end_ts || update.publish_time > window_end {
        return Err(CoreError::InvalidOraclePrice);
    }
    Ok(VerifiedOraclePrice {
        feed_id: update.feed_id,
        price: update.price,
        publish_time: update.publish_time,
        confidence: update.confidence,
        exponent: update.exponent,
    })
}

/// Select the first valid Pyth update in the configured bounded exact-after window.
///
/// If multiple valid updates share the same publish time, the first one in the provided
/// slice wins. In production the settlement worker should pass updates in provider
/// order; on-chain verification still validates the selected update's metadata.
pub fn first_valid_oracle_update(
    updates: &[OraclePriceUpdate],
    rules: &OracleValidation,
) -> Result<VerifiedOraclePrice, CoreError> {
    let mut selected: Option<(usize, VerifiedOraclePrice)> = None;
    for (idx, update) in updates.iter().enumerate() {
        let verified = match validate_oracle_update(update, rules) {
            Ok(v) => v,
            Err(_) => continue,
        };
        match selected {
            None => selected = Some((idx, verified)),
            Some((best_idx, best)) => {
                if verified.publish_time < best.publish_time
                    || (verified.publish_time == best.publish_time && idx < best_idx)
                {
                    selected = Some((idx, verified));
                }
            }
        }
    }
    selected.map(|(_, v)| v).ok_or(CoreError::OracleUnavailable)
}

#[cfg(test)]
mod tests {
    use super::*;

    const FEED: FeedId = [7u8; 32];
    const OTHER: FeedId = [8u8; 32];

    fn rules() -> OracleValidation {
        OracleValidation {
            expected_feed_id: FEED,
            scheduled_end_ts: 1_000,
            oracle_delay_window_sec: 5,
            max_confidence: 50,
            expected_exponent: -8,
        }
    }

    fn u(
        feed_id: FeedId,
        price: Price,
        publish_time: u64,
        confidence: u64,
        exponent: i32,
    ) -> OraclePriceUpdate {
        OraclePriceUpdate {
            feed_id,
            price,
            publish_time,
            confidence,
            exponent,
        }
    }

    #[test]
    fn selects_first_valid_update_inside_window() {
        let updates = vec![
            u(FEED, 99, 999, 10, -8),    // before lower bound
            u(FEED, 102, 1_002, 10, -8), // valid, but later
            u(FEED, 100, 1_000, 10, -8), // first valid by publish_time
        ];
        let selected = first_valid_oracle_update(&updates, &rules()).unwrap();
        assert_eq!(selected.price, 100);
        assert_eq!(selected.publish_time, 1_000);
    }

    #[test]
    fn rejects_wrong_feed_confidence_exponent_and_window_miss() {
        let r = rules();
        assert_eq!(
            validate_oracle_update(&u(OTHER, 100, 1_000, 10, -8), &r),
            Err(CoreError::InvalidOraclePrice)
        );
        assert_eq!(
            validate_oracle_update(&u(FEED, 100, 1_000, 51, -8), &r),
            Err(CoreError::InvalidOraclePrice)
        );
        assert_eq!(
            validate_oracle_update(&u(FEED, 100, 1_000, 10, -9), &r),
            Err(CoreError::InvalidOraclePrice)
        );
        assert_eq!(
            validate_oracle_update(&u(FEED, 100, 1_006, 10, -8), &r),
            Err(CoreError::InvalidOraclePrice)
        );
        assert_eq!(
            first_valid_oracle_update(&[u(OTHER, 100, 1_000, 10, -8)], &r),
            Err(CoreError::OracleUnavailable)
        );
    }
}
