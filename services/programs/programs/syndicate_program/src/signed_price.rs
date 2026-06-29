//! Signed-price-server verification for settlement prices.
//!
//! The signer is an Ethereum/secp256k1 address controlled by the company/manager.
//! The Go server signs `keccak256(token || priceInWad || timestampMs)` with the
//! EIP-191 `"\x19Ethereum Signed Message:\n32"` prefix and emits v/r/s.

use anchor_lang::prelude::*;
use solana_keccak_hasher as keccak;
use solana_secp256k1_recover::secp256k1_recover;
use syndicate_shared::{OraclePriceUpdate, Price};

use crate::{error::SyndicateError, settle_args::SignedPriceDto};

pub const SIGNED_PRICE_EXPONENT: i32 = -18;
pub const SIGNED_PRICE_CONFIDENCE: u64 = 0;

pub struct VerifiedSignedPrice {
    pub update: OraclePriceUpdate,
    pub eth_signed_message_hash: [u8; 32],
}

pub fn feed_id_from_token(token: &[u8; 20]) -> [u8; 32] {
    let mut feed_id = [0u8; 32];
    feed_id[..20].copy_from_slice(token);
    feed_id
}

pub fn verify_signed_price(
    signed_price: &SignedPriceDto,
    trusted_signer: [u8; 20],
) -> Result<VerifiedSignedPrice> {
    require!(
        trusted_signer != [0u8; 20],
        SyndicateError::InvalidOracleProof
    );
    require!(
        signed_price.token != [0u8; 20],
        SyndicateError::InvalidSettlementInput
    );

    let price = price_in_wad_to_i128(&signed_price.price_in_wad)?;
    let publish_time = signed_price
        .timestamp_ms
        .checked_div(1_000)
        .ok_or(SyndicateError::InvalidSettlementInput)?;
    let eth_signed_message_hash = eth_signed_price_hash(
        &signed_price.token,
        &signed_price.price_in_wad,
        signed_price.timestamp_ms,
    );
    let recovered = recover_eth_address(
        &eth_signed_message_hash,
        signed_price.v,
        &signed_price.r,
        &signed_price.s,
    )?;
    require!(
        recovered == trusted_signer,
        SyndicateError::InvalidOracleProof
    );

    Ok(VerifiedSignedPrice {
        update: OraclePriceUpdate {
            feed_id: feed_id_from_token(&signed_price.token),
            price,
            publish_time,
            confidence: SIGNED_PRICE_CONFIDENCE,
            exponent: SIGNED_PRICE_EXPONENT,
        },
        eth_signed_message_hash,
    })
}

/// Validate a verified signed price against match-bound oracle rules (exact timestamp).
pub fn validate_for_match(
    verified: &VerifiedSignedPrice,
    expected_token: &[u8; 20],
    scheduled_end_ts: u64,
    max_confidence: u64,
    expected_exponent: i32,
) -> Result<()> {
    require!(
        verified.update.feed_id == feed_id_from_token(expected_token),
        SyndicateError::InvalidSettlementInput
    );
    require!(
        verified.update.exponent == expected_exponent,
        SyndicateError::InvalidSettlementInput
    );
    require!(
        verified.update.confidence <= max_confidence,
        SyndicateError::InvalidSettlementInput
    );
    require!(
        verified.update.publish_time == scheduled_end_ts,
        SyndicateError::InvalidSettlementInput
    );
    Ok(())
}

pub fn eth_signed_price_hash(
    token: &[u8; 20],
    price_in_wad: &[u8; 32],
    timestamp_ms: u64,
) -> [u8; 32] {
    let mut timestamp_bytes = [0u8; 32];
    timestamp_bytes[24..].copy_from_slice(&timestamp_ms.to_be_bytes());

    let message_hash = keccak::hashv(&[
        token.as_ref(),
        price_in_wad.as_ref(),
        timestamp_bytes.as_ref(),
    ]);
    keccak::hashv(&[b"\x19Ethereum Signed Message:\n32", message_hash.as_ref()]).to_bytes()
}

fn price_in_wad_to_i128(price_in_wad: &[u8; 32]) -> Result<Price> {
    require!(
        price_in_wad[..16] == [0u8; 16],
        SyndicateError::InvalidSettlementInput
    );
    let mut low = [0u8; 16];
    low.copy_from_slice(&price_in_wad[16..]);
    let value = u128::from_be_bytes(low);
    require!(
        value <= i128::MAX as u128,
        SyndicateError::InvalidSettlementInput
    );
    require!(value > 0, SyndicateError::InvalidSettlementInput);
    Ok(value as i128)
}

fn recover_eth_address(
    eth_signed_message_hash: &[u8; 32],
    v: u8,
    r: &[u8; 32],
    s: &[u8; 32],
) -> Result<[u8; 20]> {
    let recovery_id = match v {
        27 | 28 => v - 27,
        0 | 1 => v,
        _ => return Err(error!(SyndicateError::InvalidOracleProof)),
    };
    let mut signature = [0u8; 64];
    signature[..32].copy_from_slice(r);
    signature[32..].copy_from_slice(s);
    let pubkey = secp256k1_recover(eth_signed_message_hash, recovery_id, &signature)
        .map_err(|_| error!(SyndicateError::InvalidOracleProof))?;
    let pubkey_hash = keccak::hash(&pubkey.to_bytes());
    let mut address = [0u8; 20];
    address.copy_from_slice(&pubkey_hash.as_ref()[12..]);
    Ok(address)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn feed_id_is_token_left_padded_to_32_bytes() {
        let token = [7u8; 20];
        let feed_id = feed_id_from_token(&token);
        assert_eq!(&feed_id[..20], &token);
        assert_eq!(&feed_id[20..], &[0u8; 12]);
    }

    #[test]
    fn wad_conversion_rejects_values_that_do_not_fit_i128() {
        let mut too_large = [0u8; 32];
        too_large[0] = 1;
        assert!(price_in_wad_to_i128(&too_large).is_err());
    }
}
