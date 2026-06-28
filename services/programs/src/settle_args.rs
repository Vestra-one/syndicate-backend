//! Instruction DTOs for settlement, and conversion to the `syndicate-shared` types.

use anchor_lang::prelude::*;
use syndicate_shared::{
    Award, Chips, OraclePriceUpdate, PlayerId, PlayerState, Price, SettleResult,
    VerifiedOraclePrice,
};

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct RevealedPrediction {
    pub seat_index: u16,
    pub prediction: i64,
    pub blinding: [u8; 32],
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
pub struct OraclePriceDto {
    pub feed_id: [u8; 32],
    pub price: i64,
    pub publish_time: u64,
    pub confidence: u64,
    pub exponent: i32,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct ClaimedResult {
    pub settlement_price: i64,
    pub oracle_publish_time: u64,
    pub pot_awards: Vec<AwardDto>,
    pub uncalled_returns: Vec<ReturnDto>,
    pub rake_collected: u64,
}

/// Settlement args — player states come from the on-chain action-log replay, not from trust.
#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct SettleArgs {
    pub vrf_seed: [u8; 32],
    pub oracle_price: OraclePriceDto,
    pub claimed: ClaimedResult,
    pub revealed: Vec<RevealedPrediction>,
}

impl OraclePriceDto {
    pub fn to_update(&self) -> OraclePriceUpdate {
        OraclePriceUpdate {
            feed_id: self.feed_id,
            price: self.price as Price,
            publish_time: self.publish_time,
            confidence: self.confidence,
            exponent: self.exponent,
        }
    }

    pub fn to_shared(&self) -> VerifiedOraclePrice {
        VerifiedOraclePrice {
            feed_id: self.feed_id,
            price: self.price as Price,
            publish_time: self.publish_time,
            confidence: self.confidence,
            exponent: self.exponent,
        }
    }
}

impl ClaimedResult {
    pub fn to_shared(&self) -> SettleResult {
        SettleResult {
            settlement_price: self.settlement_price as Price,
            oracle_publish_time: self.oracle_publish_time,
            pot_awards: self
                .pot_awards
                .iter()
                .map(|a| Award {
                    player: PlayerId(a.seat_index),
                    amount: a.amount as Chips,
                })
                .collect(),
            uncalled_returns: self
                .uncalled_returns
                .iter()
                .map(|r| (PlayerId(r.seat_index), r.amount as Chips))
                .collect(),
            rake_collected: self.rake_collected as Chips,
        }
    }

    pub fn payout_for(&self, seat_index: u16) -> u64 {
        let won: u64 = self
            .pot_awards
            .iter()
            .filter(|a| a.seat_index == seat_index)
            .map(|a| a.amount)
            .sum();
        let ret: u64 = self
            .uncalled_returns
            .iter()
            .filter(|r| r.seat_index == seat_index)
            .map(|r| r.amount)
            .sum();
        won.saturating_add(ret)
    }
}

pub fn player_states_from_engine(
    engine: &syndicate_engine_core::Engine,
    revealed: &[RevealedPrediction],
    seats: &[crate::action_log::SeatMeta; syndicate_engine_core::MAX_SEATS],
) -> Result<Vec<PlayerState>> {
    let mut pred_map = [None::<i64>; syndicate_engine_core::MAX_SEATS];
    for r in revealed {
        let idx = r.seat_index as usize;
        if idx >= syndicate_engine_core::MAX_SEATS {
            return Err(error!(crate::error::SyndicateError::InvalidSeat));
        }
        let seat = &seats[idx];
        if !seat.occupied {
            return Err(error!(crate::error::SyndicateError::InvalidSeat));
        }
        let expected =
            crate::intent::prediction_commitment_hash(r.prediction as i128, &r.blinding);
        if expected != seat.prediction_commitment {
            return Err(error!(crate::error::SyndicateError::PredictionCommitmentMismatch));
        }
        if seat.seal_seq != engine.seats[idx].seal_seq {
            return Err(error!(crate::error::SyndicateError::PredictionCommitmentMismatch));
        }
        pred_map[idx] = Some(r.prediction);
    }

    Ok(engine.to_player_states(|id| {
        let idx = id.0 as usize;
        if engine.seats[idx].folded {
            None
        } else {
            pred_map[idx].map(|p| p as Price)
        }
    }))
}
