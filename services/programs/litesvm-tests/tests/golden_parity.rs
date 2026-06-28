use std::fs;
use std::path::PathBuf;

use syndicate_shared::{
    intent::prediction_commitment_hash, settle, verify_settlement, Award, PlayerId, PlayerState,
    SettleInput, VerifiedOraclePrice,
};

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
