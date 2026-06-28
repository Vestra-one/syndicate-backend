//! # syndicate-engine — authoritative match engine service
//!
//! Re-exports the pure engine from `syndicate-engine-core`. Networking, persistence,
//! signed-intent verification, and leasing live in submodules.

pub use syndicate_engine_core::{
    Action, DefaultAction, Engine, EngineError, Phase, Seat, GENESIS_HEAD, MAX_SEATS,
};

pub mod coordinator;
pub mod lease;
pub mod persistence;
pub mod server;
pub mod service;
pub mod verify;

#[cfg(test)]
mod engine_tests {
    pub use syndicate_engine_core::*;

    use syndicate_shared::{settle, SettleInput, VerifiedOraclePrice};

    fn pid(n: u16) -> syndicate_shared::PlayerId {
        syndicate_shared::PlayerId(n)
    }

    fn three_handed() -> Engine {
        Engine::new(
            vec![(pid(0), 100, 0), (pid(1), 100, 1), (pid(2), 100, 2)],
            0,
            1,
            2,
            3,
        )
    }

    fn oracle(price: i128) -> VerifiedOraclePrice {
        VerifiedOraclePrice {
            feed_id: [7u8; 32],
            price,
            publish_time: 1_000,
            confidence: 10,
            exponent: -8,
        }
    }

    #[test]
    fn cannot_check_facing_a_bet() {
        let mut e = three_handed();
        assert_eq!(e.apply(0, Action::Check), Err(EngineError::CannotCheck));
    }

    #[test]
    fn limped_hand_runs_to_settlement() {
        let mut e = three_handed();
        e.apply(0, Action::Call).unwrap();
        e.apply(1, Action::Call).unwrap();
        e.apply(2, Action::Check).unwrap();
        for _ in 0..2 {
            e.apply(1, Action::Check).unwrap();
            e.apply(2, Action::Check).unwrap();
            e.apply(0, Action::Check).unwrap();
        }
        assert_eq!(e.phase, Phase::Settlement);
        let preds = |id: syndicate_shared::PlayerId| match id.0 {
            0 => Some(100_010_i128),
            1 => Some(99_000),
            2 => Some(100_500),
            _ => None,
        };
        let players = e.to_player_states(preds);
        let input = SettleInput {
            players: &players,
            oracle_price: oracle(100_000),
            rake_bps: 0,
            rake_cap: 0,
        };
        let r = settle(&input).unwrap();
        assert_eq!(r.pot_awards[0].amount, 6);
    }
}
