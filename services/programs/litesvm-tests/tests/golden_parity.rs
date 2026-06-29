mod common;

use std::fs;
use std::path::PathBuf;

use common::{MatchConfig, MatchHarness, SeatPayout};
use syndicate_engine_core::{Action, DefaultAction, Engine};
use syndicate_shared::{
    intent::prediction_commitment_hash, settle, verify_settlement, Award, PlayerId, PlayerState,
    SettleInput, VerifiedOraclePrice,
};

const SETTLED: u8 = 3;
const PRICE_WAD: u128 = 1_000_000_000_000_000_000;

fn golden_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../golden/showdown_3handed.json")
}

#[test]
fn golden_showdown_parity_via_shared_core() {
    let raw = fs::read_to_string(golden_path()).expect("golden/showdown_3handed.json");
    let doc: serde_json::Value = serde_json::from_str(&raw).expect("json");
    let inputs = &doc["inputs"];
    let expected = &doc["expected"];

    let players: Vec<PlayerState> = inputs["players"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| PlayerState {
            id: PlayerId(p["seat"].as_u64().unwrap() as u16),
            contribution: p["contribution"].as_u64().unwrap(),
            folded: p["folded"].as_bool().unwrap(),
            prediction: Some(p["prediction"].as_i64().unwrap() as i128),
            seal_seq: p["seal_seq"].as_u64().unwrap(),
        })
        .collect();

    let oracle = &inputs["oracle_price"];
    let feed_id: [u8; 32] = hex::decode(oracle["feed_id"].as_str().unwrap())
        .unwrap()
        .try_into()
        .unwrap();
    let oracle_price = VerifiedOraclePrice {
        feed_id,
        price: oracle["price"].as_i64().unwrap() as i128,
        publish_time: oracle["publish_time"].as_u64().unwrap(),
        confidence: oracle["confidence"].as_u64().unwrap(),
        exponent: oracle["exponent"].as_i64().unwrap() as i32,
    };

    let input = SettleInput {
        players: &players,
        oracle_price,
        rake_bps: inputs["rake_bps"].as_u64().unwrap() as u32,
        rake_cap: inputs["rake_cap"].as_u64().unwrap(),
        dead_money: 0,
    };
    let result = settle(&input).expect("settle");
    verify_settlement(&input, &result).expect("verify");

    assert_eq!(
        result.settlement_price,
        expected["settlement_price"].as_i64().unwrap() as i128
    );
    assert_eq!(
        result.pot_awards,
        vec![Award {
            player: PlayerId(expected["pot_awards"][0]["seat"].as_u64().unwrap() as u16),
            amount: expected["pot_awards"][0]["amount"].as_u64().unwrap(),
        }]
    );
    assert_eq!(result.rake_collected, expected["rake_collected"].as_u64().unwrap());
}

#[test]
fn golden_conservation_holds() {
    let raw = fs::read_to_string(golden_path()).unwrap();
    let doc: serde_json::Value = serde_json::from_str(&raw).unwrap();
    let inputs = &doc["inputs"];
    let players: Vec<PlayerState> = inputs["players"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| PlayerState {
            id: PlayerId(p["seat"].as_u64().unwrap() as u16),
            contribution: p["contribution"].as_u64().unwrap(),
            folded: p["folded"].as_bool().unwrap(),
            prediction: Some(p["prediction"].as_i64().unwrap() as i128),
            seal_seq: p["seal_seq"].as_u64().unwrap(),
        })
        .collect();
    let total_in: u64 = players.iter().map(|p| p.contribution).sum();
    let oracle = &inputs["oracle_price"];
    let feed_id: [u8; 32] = hex::decode(oracle["feed_id"].as_str().unwrap())
        .unwrap()
        .try_into()
        .unwrap();
    let input = SettleInput {
        players: &players,
        oracle_price: VerifiedOraclePrice {
            feed_id,
            price: oracle["price"].as_i64().unwrap() as i128,
            publish_time: oracle["publish_time"].as_u64().unwrap(),
            confidence: oracle["confidence"].as_u64().unwrap(),
            exponent: oracle["exponent"].as_i64().unwrap() as i32,
        },
        rake_bps: 0,
        rake_cap: 0,
        dead_money: 0,
    };
    let result = settle(&input).unwrap();
    let paid: u64 = result
        .pot_awards
        .iter()
        .map(|a| a.amount)
        .sum::<u64>()
        + result
            .uncalled_returns
            .iter()
            .map(|(_, a)| *a)
            .sum::<u64>()
        + result.rake_collected;
    assert_eq!(paid, total_in);
}

#[test]
fn wrong_blinding_fails_binding_check() {
    let pred = 100_010i128;
    let blinding = [1u8; 32];
    let commitment = prediction_commitment_hash(pred, &blinding);
    let wrong = prediction_commitment_hash(pred, &[0xee; 32]);
    assert_ne!(commitment, wrong);
}

#[test]
fn correct_blinding_matches_commitment() {
    let pred = 100_010i128;
    let blinding = [1u8; 32];
    let commitment = prediction_commitment_hash(pred, &blinding);
    assert_eq!(commitment, prediction_commitment_hash(pred, &blinding));
}

/// Step 5: golden parity THROUGH the program `.so`. Settle a known 2-sealer scenario
/// on-chain and assert the per-seat payouts the program stored equal the reference
/// `shared::settle()` awards (engine seat == PlayerId). This proves determinism end to
/// end — the chain stores exactly what the deterministic core computes.
#[test]
fn settle_on_chain_matches_shared_core() {
    // Two sealers, each contributes buy_in=100 (no entry fee, no rake, no dead money).
    let cfg = MatchConfig {
        num_players: 2,
        min_players: 2,
        buy_in: 100,
        ..Default::default()
    };
    let mut h = MatchHarness::bare(cfg);
    h.create_match();
    h.deposit_all();
    h.lock_match();
    let tlt = h.valid_timelock_target();
    for s in 0..2 {
        h.register_prediction_commitment(s, [s as u8 + 1; 32], tlt)
            .expect("seal");
    }
    let m = h.match_account();
    h.set_clock(m.seal_deadline_ts + 1);
    h.begin_live([1u8; 32]).expect("begin_live");

    // Reference settlement via the shared core. S = 100000; seat 0 predicts closest.
    let players = vec![
        PlayerState {
            id: PlayerId(0),
            contribution: 100,
            folded: false,
            prediction: Some(100_010),
            seal_seq: 0,
        },
        PlayerState {
            id: PlayerId(1),
            contribution: 100,
            folded: false,
            prediction: Some(99_000),
            seal_seq: 1,
        },
    ];
    let oracle = VerifiedOraclePrice {
        feed_id: {
            let mut f = [0u8; 32];
            f[..20].copy_from_slice(&[7u8; 20]); // PRICE_TOKEN left-padded
            f
        },
        price: 100_000,
        publish_time: h.match_account().scheduled_end_ts,
        confidence: 0,
        exponent: -18,
    };
    let input = SettleInput {
        players: &players,
        oracle_price: oracle,
        rake_bps: 0,
        rake_cap: 0,
        dead_money: 0,
    };
    let reference = settle(&input).expect("settle");
    verify_settlement(&input, &reference).expect("verify");

    // Map shared awards (by PlayerId) into on-chain per-engine-seat payouts.
    let mut payouts = vec![
        SeatPayout { engine_seat: 0, amount: 0 },
        SeatPayout { engine_seat: 1, amount: 0 },
    ];
    for a in &reference.pot_awards {
        payouts[a.player.0 as usize].amount += a.amount;
    }
    for (id, amt) in &reference.uncalled_returns {
        payouts[id.0 as usize].amount += *amt;
    }

    h.submit_settlement(&[0, 1], reference.rake_collected, payouts.clone(), PRICE_WAD)
        .expect("submit_settlement");
    assert_eq!(h.match_account().status, SETTLED);

    // On-chain stored payout per seat must equal the shared-core award, seat by seat.
    for s in 0..2 {
        let seat = h.seat_account(s);
        let engine = seat.engine_seat as usize;
        assert_eq!(
            seat.payout, payouts[engine].amount,
            "seat {s} (engine {engine}) on-chain payout must match shared::settle()"
        );
    }

    // Vault drains to exactly zero after both claims (capital-safety end to end).
    h.claim(0).expect("claim 0");
    h.claim(1).expect("claim 1");
    assert_eq!(h.vault_balance(), 0, "settled-via-core vault must drain to 0");
}

/// Step 6: multi-street fairness. A free CHECK (and therefore pot eligibility) is granted
/// to a defaulted/timed-out actor ONLY when `to_call == 0`; with chips owed the default
/// is FOLD (no free pot eligibility). Drives the engine that feeds `submit_settlement`.
#[test]
fn auto_check_only_when_to_call_zero() {
    // 3-handed; button 0 => SB=1, BB=2, UTG=0. Blinds 1/2.
    let players = vec![
        (PlayerId(0), 100u64, 0u64),
        (PlayerId(1), 100, 1),
        (PlayerId(2), 100, 2),
    ];
    let engine = Engine::new(players, 0, 1, 2, 4);

    // The big blind (seat 2) faces no further bet preflop after a limp-around situation
    // would be to_call==0; the SB (seat 1) still owes the limp. Assert the rule directly
    // across every seat: default action is CHECK iff to_call==0, else FOLD.
    for idx in 0..3 {
        let to_call = engine.to_call(idx);
        let default = engine.default_action(idx, DefaultAction::CheckFold);
        if to_call == 0 {
            assert_eq!(
                default,
                Action::Check,
                "seat {idx} owes nothing -> free CHECK keeps pot eligibility"
            );
        } else {
            assert_eq!(
                default,
                Action::Fold,
                "seat {idx} owes {to_call} -> FOLD, never a free CHECK into the pot"
            );
        }
    }

    // The big blind option: BB has matched the bet (to_call==0) so its default is a
    // free CHECK (stays in, eligible). This is the only seat granted free eligibility.
    let bb = 2usize;
    assert_eq!(engine.to_call(bb), 0, "BB has posted the full current bet");
    assert_eq!(
        engine.default_action(bb, DefaultAction::CheckFold),
        Action::Check
    );
}
