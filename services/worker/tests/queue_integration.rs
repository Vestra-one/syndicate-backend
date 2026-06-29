//! Integration tests for the durable settlement queue SQL contract.

use syndicate_store::schema::POSTGRES_SCHEMA_V2;
use syndicate_store::{
    CLAIM_SETTLEMENT_OUTBOX_SQL, ENQUEUE_SETTLEMENT_REQUEST_SQL, LIST_DUE_SETTLEMENT_ATTEMPTS_SQL,
    LOAD_ALL_MATCH_EVENTS_SQL, MARK_OUTBOX_PUBLISHED_SQL, POSTGRES_SCHEMA_V1,
};

fn database_url() -> Option<String> {
    std::env::var("SYNDICATE_TEST_DATABASE_URL").ok()
}

async fn apply_schema(url: &str) {
    let (client, connection) = tokio_postgres::connect(url, tokio_postgres::NoTls)
        .await
        .expect("connect test database");
    tokio::spawn(async move {
        if let Err(err) = connection.await {
            eprintln!("postgres connection error: {err}");
        }
    });
    client
        .batch_execute(POSTGRES_SCHEMA_V1)
        .await
        .expect("apply schema v1");
    client
        .batch_execute(POSTGRES_SCHEMA_V2)
        .await
        .expect("apply schema v2");
}

#[tokio::test]
async fn settlement_outbox_claim_publish_cycle() {
    let Some(url) = database_url() else {
        eprintln!(
            "skipping settlement_outbox_claim_publish_cycle: SYNDICATE_TEST_DATABASE_URL unset"
        );
        return;
    };
    apply_schema(&url).await;
    let (client, connection) = tokio_postgres::connect(&url, tokio_postgres::NoTls)
        .await
        .expect("connect");
    tokio::spawn(async move {
        let _ = connection.await;
    });

    let match_id = uuid::Uuid::new_v4();
    let config_id = uuid::Uuid::new_v4();
    client
        .execute(
            "INSERT INTO match_configs (id, config_version, price_feed_symbol, pyth_feed_id, oracle_exponent, max_oracle_confidence, buy_in_chips, rake_bps, rake_cap_chips, max_players, created_by)
             VALUES ($1, 1, 'ETH/USD', decode(repeat('11', 32), 'hex'), -8, 1000, 100, 0, 0, 3, 'test')",
            &[&config_id],
        )
        .await
        .expect("insert config");
    client
        .execute(
            "INSERT INTO matches (id, match_key, onchain_match_id, config_id, scheduled_end_ts)
             VALUES ($1, $2, 42, $3, now() + interval '1 hour')",
            &[&match_id, &format!("match-{match_id}"), &config_id],
        )
        .await
        .expect("insert match");

    let payload = serde_json::json!({
        "match_id": match_id.to_string(),
        "event_root": "aa".repeat(32),
        "scheduled_end_ts": 1_000,
        "pyth_feed_id": "bb".repeat(32),
        "oracle_exponent": -8,
        "max_oracle_confidence": 1000,
        "rake_bps": 0,
        "rake_cap": 0,
        "timelock_target_round": 42
    });
    let row = client
        .query_one(ENQUEUE_SETTLEMENT_REQUEST_SQL, &[&match_id, &payload])
        .await
        .expect("enqueue settlement");
    let outbox_id: String = row.get("id");

    let claimed = client
        .query(
            CLAIM_SETTLEMENT_OUTBOX_SQL,
            &[&chrono::Utc::now(), &1i64, &60_000i64],
        )
        .await
        .expect("claim");
    assert_eq!(claimed.len(), 1);
    assert_eq!(claimed[0].get::<_, String>("id"), outbox_id);

    client
        .execute(
            MARK_OUTBOX_PUBLISHED_SQL,
            &[&outbox_id, &chrono::Utc::now()],
        )
        .await
        .expect("mark published");

    let status: String = client
        .query_one(
            "SELECT status::text FROM outbox_events WHERE id = $1::uuid",
            &[&outbox_id],
        )
        .await
        .expect("load status")
        .get("status");
    assert_eq!(status, "published");
}

#[tokio::test]
async fn due_attempt_poller_selects_retry_scheduled_rows() {
    let Some(url) = database_url() else {
        eprintln!("skipping due_attempt_poller_selects_retry_scheduled_rows: SYNDICATE_TEST_DATABASE_URL unset");
        return;
    };
    apply_schema(&url).await;
    let (client, connection) = tokio_postgres::connect(&url, tokio_postgres::NoTls)
        .await
        .expect("connect");
    tokio::spawn(async move {
        let _ = connection.await;
    });

    let match_id = uuid::Uuid::new_v4();
    let config_id = uuid::Uuid::new_v4();
    client
        .execute(
            "INSERT INTO match_configs (id, config_version, price_feed_symbol, pyth_feed_id, oracle_exponent, max_oracle_confidence, buy_in_chips, rake_bps, rake_cap_chips, max_players, created_by)
             VALUES ($1, 1, 'ETH/USD', decode(repeat('11', 32), 'hex'), -8, 1000, 100, 0, 0, 3, 'test')",
            &[&config_id],
        )
        .await
        .expect("insert config");
    client
        .execute(
            "INSERT INTO matches (id, match_key, onchain_match_id, config_id, scheduled_end_ts)
             VALUES ($1, $2, 43, $3, now() + interval '1 hour')",
            &[&match_id, &format!("match-{match_id}"), &config_id],
        )
        .await
        .expect("insert match");
    client
        .execute(
            "INSERT INTO settlement_attempts (match_id, idempotency_key, event_root, status, next_retry_at)
             VALUES ($1, 'match:retry-1', decode(repeat('22', 32), 'hex'), 'retry_scheduled', now() - interval '1 second')",
            &[&match_id],
        )
        .await
        .expect("insert attempt");

    let due = client
        .query(
            LIST_DUE_SETTLEMENT_ATTEMPTS_SQL,
            &[&chrono::Utc::now(), &60_000i64, &10i64],
        )
        .await
        .expect("list due");
    assert!(!due.is_empty());
    assert_eq!(due[0].get::<_, String>("idempotency_key"), "match:retry-1");
}

#[test]
fn queue_sql_contract_is_present() {
    assert!(LOAD_ALL_MATCH_EVENTS_SQL.contains("ORDER BY seq ASC"));
    assert!(CLAIM_SETTLEMENT_OUTBOX_SQL.contains("aggregate_type = 'settlement'"));
}
