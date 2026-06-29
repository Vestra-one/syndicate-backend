//! Signed-price oracle validation.
//!
//! The canonical settlement price is the signed price whose publish time exactly equals
//! `scheduled_end_ts`. This module is pure and signature-agnostic: the Solana program
//! is responsible for verifying the secp256k1 signature, then feeds the authenticated
//! metadata through these same rules.

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

/// Validate one authenticated price update against the bound match rules (exact timestamp).
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
    if update.publish_time != rules.scheduled_end_ts {
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

/// Select the first valid update whose publish time exactly matches `scheduled_end_ts`.
pub fn first_valid_oracle_update(
    updates: &[OraclePriceUpdate],
    rules: &OracleValidation,
) -> Result<VerifiedOraclePrice, CoreError> {
    for update in updates {
        if let Ok(verified) = validate_oracle_update(update, rules) {
            return Ok(verified);
        }
    }
    Err(CoreError::OracleUnavailable)
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
    fn accepts_exact_timestamp_match() {
        let selected = validate_oracle_update(&u(FEED, 100, 1_000, 10, -8), &rules()).unwrap();
        assert_eq!(selected.price, 100);
        assert_eq!(selected.publish_time, 1_000);
    }

    #[test]
    fn rejects_wrong_feed_confidence_exponent_and_timestamp() {
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
            validate_oracle_update(&u(FEED, 100, 1_001, 10, -8), &r),
            Err(CoreError::InvalidOraclePrice)
        );
        assert_eq!(
            validate_oracle_update(&u(FEED, 100, 999, 10, -8), &r),
            Err(CoreError::InvalidOraclePrice)
        );
        assert_eq!(
            first_valid_oracle_update(&[u(OTHER, 100, 1_000, 10, -8)], &r),
            Err(CoreError::OracleUnavailable)
        );
    }
}
