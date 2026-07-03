//! SettleArgs wire encoding (Borsh mirror of `settle_args.rs` in the program).

use borsh::{BorshDeserialize, BorshSerialize};

#[derive(BorshSerialize, BorshDeserialize, Clone, Debug, PartialEq, Eq)]
pub struct SignedPriceDto {
    /// 20-byte token/feed identifier (Ethereum address) the price is signed for.
    pub token: [u8; 20],
    /// 256-bit big-endian unsigned price in wad (1e18); upper 128 bits must be zero.
    pub price_in_wad: [u8; 32],
    /// Signed server timestamp in Unix milliseconds; `floor(ms/1000)` must equal the
    /// match's `scheduled_end_ts` exactly.
    pub timestamp_ms: u64,
    /// secp256k1 recovery id (27/28 or 0/1).
    pub v: u8,
    pub r: [u8; 32],
    pub s: [u8; 32],
}

#[derive(BorshSerialize, BorshDeserialize, Clone, Debug, PartialEq, Eq)]
pub struct SeatPayout {
    /// Engine seat index (0..confirmed_count).
    pub engine_seat: u8,
    pub amount: u64,
}

#[derive(BorshSerialize, BorshDeserialize, Clone, Debug, PartialEq, Eq)]
pub struct SettleArgs {
    pub signed_price: SignedPriceDto,
    pub rake_collected: u64,
    /// One entry per confirmed seat, indexed by engine_seat.
    pub payouts: Vec<SeatPayout>,
}

impl SettleArgs {
    pub fn encode(&self) -> Vec<u8> {
        borsh::to_vec(self).expect("encode SettleArgs")
    }
}
