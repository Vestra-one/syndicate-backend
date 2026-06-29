//! Instruction DTOs for settlement.

use anchor_lang::prelude::*;

/// EIP-191/secp256k1 signed price payload emitted by the signed-price-server.
///
/// The signed bytes are exactly:
/// `token(20) || price_in_wad(32 byte uint256 BE) || timestamp_ms(32 byte uint256 BE)`.
#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct SignedPriceDto {
    pub token: [u8; 20],
    pub price_in_wad: [u8; 32],
    pub timestamp_ms: u64,
    pub v: u8,
    pub r: [u8; 32],
    pub s: [u8; 32],
}

/// Per-sealer payout indexed by engine seat (contiguous 0..sealed_count).
#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct SeatPayout {
    pub engine_seat: u8,
    pub amount: u64,
}

/// Settlement args — v1 trusts backend-computed payouts; the chain enforces conservation
/// and signed-price authenticity only. See `submit_settlement` TODO(v1+) for restoring
/// on-chain action-log replay + `verify_settlement`.
#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct SettleArgs {
    pub signed_price: SignedPriceDto,
    pub rake_collected: u64,
    pub payouts: Vec<SeatPayout>,
}
