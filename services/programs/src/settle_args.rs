//! Instruction DTOs for settlement, and conversion to the `syndicate-shared` types.
//!
//! The program never re-implements settlement: it deserializes these recorded inputs,
//! rebuilds the shared types, and calls `syndicate_shared::verify_settlement` (the same
//! code the off-chain builder ran). Prices are fixed-point `i64` here (ample for any
//! feed precision) and widened to the shared `Price` (`i128`).

use anchor_lang::prelude::*;
use syndicate_shared::{Award, Chips, PlayerId, PlayerState, Price, SettleResult};

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct PlayerInput {
    pub seat_index: u16,
    pub contribution: u64,
    pub folded: bool,
    pub has_prediction: bool,
    pub prediction: i64,
    pub seal_seq: u64,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct AwardDto {
    pub seat_index: u16,
    pub amount: u64,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct ReturnDto {
    pub seat_index: u16,
    pub amount: u64,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct ClaimedResult {
    pub settlement_price: i64,
    pub pot_awards: Vec<AwardDto>,
    pub uncalled_returns: Vec<ReturnDto>,
    pub rake_collected: u64,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct SettleArgs {
    pub players: Vec<PlayerInput>,
    pub settlement_samples: Vec<i64>,
    pub min_samples: u32,
    pub rake_bps: u32,
    pub rake_cap: u64,
    pub claimed: ClaimedResult,
}

impl PlayerInput {
    pub fn to_shared(&self) -> PlayerState {
        PlayerState {
            id: PlayerId(self.seat_index),
            contribution: self.contribution,
            folded: self.folded,
            prediction: if self.has_prediction { Some(self.prediction as Price) } else { None },
            seal_seq: self.seal_seq,
        }
    }
}

impl ClaimedResult {
    pub fn to_shared(&self) -> SettleResult {
        SettleResult {
            settlement_price: self.settlement_price as Price,
            pot_awards: self
                .pot_awards
                .iter()
                .map(|a| Award { player: PlayerId(a.seat_index), amount: a.amount as Chips })
                .collect(),
            uncalled_returns: self
                .uncalled_returns
                .iter()
                .map(|r| (PlayerId(r.seat_index), r.amount as Chips))
                .collect(),
            rake_collected: self.rake_collected as Chips,
        }
    }

    /// Total payable (winnings + returns) for a given seat — written to the seat at
    /// settlement so the player can later pull it via `claim`.
    pub fn payout_for(&self, seat_index: u16) -> u64 {
        let won: u64 = self.pot_awards.iter().filter(|a| a.seat_index == seat_index).map(|a| a.amount).sum();
        let ret: u64 = self.uncalled_returns.iter().filter(|r| r.seat_index == seat_index).map(|r| r.amount).sum();
        won.saturating_add(ret)
    }
}
