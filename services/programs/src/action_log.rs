//! On-chain action log: replays signed intents through the shared engine core.

use anchor_lang::prelude::*;
use syndicate_engine_core::{
    Action, DefaultAction, Engine, EngineError, Phase, GENESIS_HEAD, MAX_SEATS,
};

use crate::error::SyndicateError;

pub const ACTION_LOG_SEED: &[u8] = b"actionlog";

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
pub enum OnChainDefaultPolicy {
    Unset,
    CheckFold,
    CheckCallAny,
}

impl OnChainDefaultPolicy {
    pub fn to_core(self) -> Option<DefaultAction> {
        match self {
            Self::Unset => None,
            Self::CheckFold => Some(DefaultAction::CheckFold),
            Self::CheckCallAny => Some(DefaultAction::CheckCallAny),
        }
    }
}

impl Default for OnChainDefaultPolicy {
    fn default() -> Self {
        Self::Unset
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Default)]
pub struct SeatMeta {
    pub player: Pubkey,
    pub nonce: u64,
    pub default_policy: OnChainDefaultPolicy,
    pub default_set: bool,
    pub prediction_commitment: [u8; 32],
    pub seal_seq: u64,
    pub commitment_set: bool,
    pub occupied: bool,
}

/// Serialized engine + per-seat metadata for on-chain replay.
#[account]
pub struct ActionLog {
    pub match_key: Pubkey,
    pub head: [u8; 32],
    pub event_root: [u8; 32],
    pub finalized: bool,
    pub action_count: u32,
    pub player_count: u8,
    pub scheduled_end_ts: u64,
    pub settle_deadline_ts: u64,
    pub engine_bytes: Vec<u8>,
    pub seats: [SeatMeta; MAX_SEATS],
    pub bump: u8,
}

impl ActionLog {
    pub const BASE_SPACE: usize = 8 + 32 + 32 + 32 + 1 + 4 + 1 + 8 + 8 + 4 + 512 + (SeatMeta::SPACE * MAX_SEATS) + 1;

    pub fn engine(&self) -> Result<Engine> {
        engine_borsh::from_slice(&self.engine_bytes)
            .map_err(|_| error!(SyndicateError::InvalidActionLog))
    }

    pub fn set_engine(&mut self, engine: &Engine) -> Result<()> {
        self.engine_bytes = engine_borsh::to_vec(engine)
            .map_err(|_| error!(SyndicateError::InvalidActionLog))?;
        Ok(())
    }

    pub fn seat_index_for_player(&self, player: &Pubkey) -> Option<usize> {
        self.seats
            .iter()
            .enumerate()
            .find(|(_, s)| s.occupied && s.player == *player)
            .map(|(i, _)| i)
    }
}

impl SeatMeta {
    pub const SPACE: usize = 32 + 8 + 1 + 1 + 32 + 8 + 1 + 1;
}

pub fn map_engine_err(err: EngineError) -> SyndicateError {
    match err {
        EngineError::BadPhase => SyndicateError::BadStatus,
        EngineError::NotYourTurn => SyndicateError::NotYourTurn,
        _ => SyndicateError::InvalidActionInput,
    }
}

pub fn core_action_from_tags(tag: u8, amount: u64) -> Result<Action> {
    Ok(match tag {
        0 => Action::Fold,
        1 => Action::Check,
        2 => Action::Call,
        3 => Action::BetTo(amount),
        4 => Action::RaiseTo(amount),
        5 => Action::AllIn,
        _ => return Err(error!(SyndicateError::InvalidActionInput)),
    })
}

pub fn init_engine_from_match(
    buy_in: u64,
    player_count: u8,
    button: u8,
    small_blind: u64,
    big_blind: u64,
    round_count: u8,
    seal_seq: &[u64; MAX_SEATS],
) -> Engine {
    let n = player_count as usize;
    let players: Vec<_> = (0..n)
        .map(|i| {
            (
                syndicate_shared::PlayerId(i as u16),
                buy_in,
                seal_seq[i],
            )
        })
        .collect();
    Engine::new(
        players,
        button as usize,
        small_blind,
        big_blind,
        round_count,
    )
}

pub fn advance_head(prev: &[u8; 32], step: &[u8]) -> [u8; 32] {
    syndicate_shared::action_head_step(prev, step)
}

pub fn canonical_action_step(
    seat_index: u16,
    nonce: u64,
    tag: u8,
    amount: u64,
    is_timeout: bool,
) -> Vec<u8> {
    let mut out = Vec::with_capacity(32);
    if is_timeout {
        out.extend_from_slice(b"timeout|");
    } else {
        out.extend_from_slice(b"action|");
    }
    out.extend_from_slice(&seat_index.to_le_bytes());
    out.extend_from_slice(&nonce.to_le_bytes());
    out.push(tag);
    out.extend_from_slice(&amount.to_le_bytes());
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn engine_roundtrip() {
        let e = init_engine_from_match(100, 3, 0, 1, 2, 3, &[0, 1, 2, 0, 0]);
        let bytes = engine_borsh::to_vec(&e).unwrap();
        let decoded: Engine = engine_borsh::from_slice(&bytes).unwrap();
        assert_eq!(decoded.seats.len(), 3);
    }
}
