//! Pyth Core receiver integration for on-chain settlement verification.
//!
//! Syndicate accepts `PriceUpdateV2` accounts from **both** Pyth Core Solana receiver
//! generations without a `pro-compatible` Cargo feature on `pyth-solana-receiver-sdk`:
//! - **Current** (`rec5EKM…`) — devnet-friendly; pairs with Hermes Core + legacy Wormhole.
//! - **Upgraded** (`rec2HHD…`) — mainnet target; pairs with upgraded Hermes + Wormhole stack.
//!
//! Off-chain operators select the stack via `PYTH_RECEIVER_STACK=legacy|upgraded` (see
//! `services/settlement-chain/pyth-stack.json`). On-chain verification is stack-agnostic:
//! owner check + full Wormhole guardian verification + feed/timestamp rules in `shared`.

use anchor_lang::prelude::*;
use pyth_solana_receiver_sdk::price_update::{PriceUpdateV2, VerificationLevel};
use syndicate_shared::{OraclePriceUpdate, Price};

use crate::error::SyndicateError;

/// Pyth Core **current** Solana receiver (devnet / legacy Wormhole path).
pub const CURRENT_RECEIVER_PROGRAM_ID: Pubkey =
    pubkey!("rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ");
/// Pyth Core **upgraded** Solana receiver (mainnet production target).
pub const UPGRADED_RECEIVER_PROGRAM_ID: Pubkey =
    pubkey!("rec2HHDDnjLfj4kE7VyEtFA1HPGQLK33259532cRyHp");


pub fn load_price_update_v2(account: &AccountInfo) -> Result<PriceUpdateV2> {
    require!(
        account.owner == &CURRENT_RECEIVER_PROGRAM_ID
            || account.owner == &UPGRADED_RECEIVER_PROGRAM_ID,
        SyndicateError::InvalidOracleProof
    );
    let mut data: &[u8] = &account.try_borrow_data()?;
    PriceUpdateV2::try_deserialize(&mut data).map_err(|_| error!(SyndicateError::InvalidOracleProof))
}

pub fn verified_update_from_pyth_account(
    price_update: &PriceUpdateV2,
    expected_feed_id: [u8; 32],
) -> Result<OraclePriceUpdate> {
    require!(
        price_update.verification_level.gte(VerificationLevel::Full),
        SyndicateError::InvalidOracleProof
    );

    let price = price_update
        .get_price_unchecked(&expected_feed_id)
        .map_err(|_| error!(SyndicateError::InvalidOracleProof))?;
    require!(price.publish_time >= 0, SyndicateError::InvalidOracleProof);

    Ok(OraclePriceUpdate {
        feed_id: expected_feed_id,
        price: price.price as Price,
        publish_time: price.publish_time as u64,
        confidence: price.conf,
        exponent: price.exponent,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use pyth_solana_receiver_sdk::price_update::{PriceFeedMessage, VerificationLevel};

    fn price_update(feed_id: [u8; 32], verification_level: VerificationLevel) -> PriceUpdateV2 {
        PriceUpdateV2 {
            write_authority: Pubkey::new_unique(),
            verification_level,
            price_message: PriceFeedMessage {
                feed_id,
                price: 100_000,
                conf: 10,
                exponent: -8,
                publish_time: 1_000,
                prev_publish_time: 999,
                ema_price: 100_001,
                ema_conf: 11,
            },
            posted_slot: 42,
        }
    }

    #[test]
    fn full_verification_converts_to_shared_update() {
        let feed_id = [7u8; 32];
        let update = verified_update_from_pyth_account(
            &price_update(feed_id, VerificationLevel::Full),
            feed_id,
        )
        .expect("full verification");
        assert_eq!(update.feed_id, feed_id);
        assert_eq!(update.price, 100_000);
        assert_eq!(update.publish_time, 1_000);
        assert_eq!(update.confidence, 10);
        assert_eq!(update.exponent, -8);
    }

    #[test]
    fn partial_verification_and_wrong_feed_are_rejected() {
        let feed_id = [7u8; 32];
        assert!(verified_update_from_pyth_account(
            &price_update(feed_id, VerificationLevel::Partial { num_signatures: 5 }),
            feed_id,
        )
        .is_err());
        assert!(verified_update_from_pyth_account(
            &price_update([8u8; 32], VerificationLevel::Full),
            feed_id,
        )
        .is_err());
    }
}
