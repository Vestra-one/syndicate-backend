//! Integration tests for MatchRegistryStore against a live Postgres instance.
//!
//! Skipped unless `SYNDICATE_TEST_DATABASE_URL` is set.

use chrono::{Duration, Utc};
use syndicate_store::{InsertMatchParams, MatchRegistryStore};

fn test_database_url() -> Option<String> {
    std::env::var("SYNDICATE_TEST_DATABASE_URL")
        .ok()
        .filter(|v| !v.is_empty())
}

async fn apply_schema(url: &str) {
    let (client, connection) = tokio_postgres::connect(url, tokio_postgres::NoTls)
        .await
        .expect("connect test database");
    tokio::spawn(async move {
        let _ = connection.await;
    });
    let ready = client
        .query_opt(
            "SELECT 1 FROM information_schema.columns
             WHERE table_name = 'matches' AND column_name = 'fill_deadline_ts'",
            &[],
        )
        .await
        .expect("probe lifecycle columns")
        .is_some();
    if ready {
        return;
    }
    use std::process::Command;
    let status = Command::new("bash")
        .args([concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../scripts/db-migrate-local.sh"
        )])
        .env("DATABASE_URL", url)
        .status()
        .expect("spawn db-migrate-local.sh");
    assert!(status.success(), "db-migrate-local.sh failed with {status}");
}

#[tokio::test]
async fn insert_match_round_trips_config_and_match_row() {
    let Some(url) = test_database_url() else {
        eprintln!(
            "skipping insert_match_round_trips_config_and_match_row: SYNDICATE_TEST_DATABASE_URL unset"
        );
        return;
    };
    apply_schema(&url).await;

    let store = MatchRegistryStore::from_database_url(&url).expect("registry store");
    let onchain_match_id = 62_631_764_307_083_389_i64;
    let match_key = onchain_match_id.to_string();
    let fill_deadline = Utc::now() + Duration::hours(1);

    let row = store
        .insert_match(InsertMatchParams {
            match_key: match_key.clone(),
            onchain_match_id,
            config_hash_hex: "f45b21238906ada52fd0e7486c123843359713860161d9afdeacba821343f93d"
                .into(),
            fill_deadline,
            price_feed_symbol: "BTC/USD".into(),
            oracle_token_hex: "0xa7BaE7da3E4950700BE9f107EB186e89a474d180".into(),
            oracle_exponent: -18,
            max_oracle_confidence: i64::MAX,
            buy_in_chips: 1_000_000,
            entry_fee_chips: 0,
            rake_bps: 300,
            rake_cap_chips: 1_000_000,
            max_players: 5,
        })
        .await
        .expect("insert_match");

    assert_eq!(row.match_key, match_key);
    assert_eq!(row.onchain_match_id, onchain_match_id);
    assert_eq!(row.room_status, "Filling");
    assert!(!row.match_id.is_empty());

    // Idempotent on match_key.
    let again = store
        .insert_match(InsertMatchParams {
            match_key,
            onchain_match_id,
            config_hash_hex: "f45b21238906ada52fd0e7486c123843359713860161d9afdeacba821343f93d"
                .into(),
            fill_deadline,
            price_feed_symbol: "BTC/USD".into(),
            oracle_token_hex: "0xa7BaE7da3E4950700BE9f107EB186e89a474d180".into(),
            oracle_exponent: -18,
            max_oracle_confidence: i64::MAX,
            buy_in_chips: 1_000_000,
            entry_fee_chips: 0,
            rake_bps: 300,
            rake_cap_chips: 1_000_000,
            max_players: 5,
        })
        .await
        .expect("insert_match idempotent");
    assert_eq!(again.match_id, row.match_id);
}
