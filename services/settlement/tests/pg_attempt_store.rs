//! Integration tests for PostgresAttemptStore against a live Postgres instance.
//!
//! Skipped unless `SYNDICATE_TEST_DATABASE_URL` is set.

#![cfg(feature = "pg")]

use std::sync::Arc;

use syndicate_settlement::ops::{
    AttemptStatus, MockSolanaClient, PostgresAttemptStore, PythFetchRequest, PythSettlementContext,
    RetryPolicy, SettlementAttemptStore, SettlementJob, SettlementOpsWorker,
    SettlementProcessResult, SolanaMatchContext,
};
use syndicate_settlement::{Outcome, VoidReason};
use syndicate_store::POSTGRES_SCHEMA_V1;
use tokio::sync::Barrier;

fn test_database_url() -> Option<String> {
    std::env::var("SYNDICATE_TEST_DATABASE_URL")
        .ok()
        .filter(|v| !v.is_empty())
}

async fn setup_pool() -> deadpool_postgres::Pool {
    let url = test_database_url().expect("SYNDICATE_TEST_DATABASE_URL must be set");
    let pool = PostgresAttemptStore::pool_from_url(&url).expect("connect postgres");
    let client = pool.get().await.expect("pool connection");
    client
        .batch_execute(POSTGRES_SCHEMA_V1)
        .await
        .expect("apply schema");
    pool
}

async fn insert_match(client: &deadpool_postgres::Object) -> (String, [u8; 32]) {
    let config_id: String = client
        .query_one(
            r#"
            INSERT INTO match_configs (
                config_version,
                price_feed_symbol,
                pyth_feed_id,
                oracle_exponent,
                max_oracle_confidence,
                buy_in_chips,
                rake_bps,
                rake_cap_chips,
                max_players,
                created_by
            )
            VALUES (1, 'SOL/USD', decode(repeat('07', 32), 'hex'), -8, 1000, 100, 0, 0, 3, 'pg-test')
            RETURNING id::text
            "#,
            &[],
        )
        .await
        .expect("insert match config")
        .get(0);

    let match_id: String = client
        .query_one(
            r#"
            INSERT INTO matches (
                match_key,
                onchain_match_id,
                config_id,
                scheduled_end_ts
            )
            VALUES ($1, $2, $3::uuid, now() + interval '1 hour')
            RETURNING id::text
            "#,
            &[
                &format!("pg-test-{}", uuid_suffix()),
                &(rand_onchain_id() as i64),
                &config_id,
            ],
        )
        .await
        .expect("insert match")
        .get(0);

    let event_root = [9u8; 32];
    (match_id, event_root)
}

fn uuid_suffix() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos() as u64
}

fn rand_onchain_id() -> u64 {
    uuid_suffix() % 900_000_000_000 + 100_000_000_000
}

fn void_job(match_id: &str, idempotency_key: &str, event_root: [u8; 32]) -> SettlementJob {
    SettlementJob {
        match_id: match_id.into(),
        idempotency_key: idempotency_key.into(),
        event_root,
        chain_context: SolanaMatchContext {
            onchain_match_id: 42,
            seat_wallets: Vec::new(),
        },
        pyth_context: PythSettlementContext {
            rules: PythFetchRequest {
                feed_id: [7u8; 32],
                scheduled_end_ts: 1_000,
                oracle_delay_window_sec: 5,
                max_confidence: 50,
                expected_exponent: -8,
            },
            selected: None,
        },
        outcome: Outcome::Void(VoidReason::OracleDegraded),
    }
}

#[tokio::test]
async fn pg_begin_submit_confirm_is_idempotent() {
    let Some(_) = test_database_url() else {
        eprintln!(
            "skipping pg_begin_submit_confirm_is_idempotent: SYNDICATE_TEST_DATABASE_URL unset"
        );
        return;
    };
    let pool = setup_pool().await;
    let client = pool.get().await.expect("pool connection");
    let (match_id, event_root) = insert_match(&client).await;
    drop(client);

    let store = PostgresAttemptStore::new(pool.clone());
    let idempotency_key = format!("{match_id}:root-idempotent");
    let job = void_job(&match_id, &idempotency_key, event_root);

    let mut worker = SettlementOpsWorker {
        chain: MockSolanaClient::new(),
        store,
        retry_policy: RetryPolicy::recommended(),
    };

    let first = worker.process(&job, 1_000).await.unwrap();
    let second = worker.process(&job, 2_000).await.unwrap();
    assert!(matches!(first, SettlementProcessResult::Final(_)));
    assert!(matches!(second, SettlementProcessResult::Final(_)));

    let reload = PostgresAttemptStore::new(pool);
    let record = reload
        .get(&idempotency_key)
        .await
        .unwrap()
        .expect("attempt persisted");
    assert_eq!(record.status, AttemptStatus::Voided);
    assert_eq!(record.attempt_count, 1);
}

#[tokio::test]
async fn pg_retry_schedules_next_retry_at() {
    let Some(_) = test_database_url() else {
        eprintln!("skipping pg_retry_schedules_next_retry_at: SYNDICATE_TEST_DATABASE_URL unset");
        return;
    };
    let pool = setup_pool().await;
    let client = pool.get().await.expect("pool connection");
    let (match_id, event_root) = insert_match(&client).await;
    drop(client);

    let mut store = PostgresAttemptStore::new(pool.clone());
    let idempotency_key = format!("{match_id}:root-retry");
    let job = void_job(&match_id, &idempotency_key, event_root);
    store.begin_attempt(&job, 10).await.unwrap();
    let record = store
        .mark_retry(&idempotency_key, "rpc down".into(), 110)
        .await
        .unwrap();
    assert_eq!(record.status, AttemptStatus::RetryScheduled);
    assert_eq!(record.next_retry_at_ms, Some(110));

    let reloaded = store.get(&idempotency_key).await.unwrap().unwrap();
    assert_eq!(reloaded.status, AttemptStatus::RetryScheduled);
    assert_eq!(reloaded.next_retry_at_ms, Some(110));
}

#[tokio::test]
async fn pg_dead_letter_persists_audit_row() {
    let Some(_) = test_database_url() else {
        eprintln!("skipping pg_dead_letter_persists_audit_row: SYNDICATE_TEST_DATABASE_URL unset");
        return;
    };
    let pool = setup_pool().await;
    let client = pool.get().await.expect("pool connection");
    let (match_id, event_root) = insert_match(&client).await;
    drop(client);

    let mut store = PostgresAttemptStore::new(pool.clone());
    let idempotency_key = format!("{match_id}:root-dead");
    let job = void_job(&match_id, &idempotency_key, event_root);
    let record = store
        .dead_letter(&job, "operator required".into(), "payload-body".into())
        .await
        .unwrap();
    assert_eq!(record.status, AttemptStatus::DeadLetter);

    let client = pool.get().await.expect("pool connection");
    let count: i64 = client
        .query_one(
            "SELECT COUNT(*) FROM settlement_dead_letters WHERE idempotency_key = $1",
            &[&idempotency_key],
        )
        .await
        .expect("count dead letters")
        .get(0);
    assert_eq!(count, 1);
}

#[tokio::test]
async fn pg_concurrent_begin_serializes_on_idempotency_key() {
    let Some(_) = test_database_url() else {
        eprintln!(
            "skipping pg_concurrent_begin_serializes_on_idempotency_key: SYNDICATE_TEST_DATABASE_URL unset"
        );
        return;
    };
    let pool = setup_pool().await;
    let client = pool.get().await.expect("pool connection");
    let (match_id, event_root) = insert_match(&client).await;
    drop(client);

    let idempotency_key = format!("{match_id}:root-concurrent");
    let job = Arc::new(void_job(&match_id, &idempotency_key, event_root));
    let barrier = Arc::new(Barrier::new(2));

    let pool_a = pool.clone();
    let pool_b = pool.clone();
    let job_a = Arc::clone(&job);
    let job_b = Arc::clone(&job);
    let barrier_a = Arc::clone(&barrier);
    let barrier_b = Arc::clone(&barrier);

    let first = tokio::spawn(async move {
        barrier_a.wait().await;
        let mut store = PostgresAttemptStore::new(pool_a);
        store.begin_attempt(&job_a, 1).await.unwrap()
    });
    let second = tokio::spawn(async move {
        barrier_b.wait().await;
        let mut store = PostgresAttemptStore::new(pool_b);
        store.begin_attempt(&job_b, 1).await.unwrap()
    });

    let record_a = first.await.unwrap();
    let record_b = second.await.unwrap();
    assert_eq!(record_a.idempotency_key, record_b.idempotency_key);
    assert_eq!(record_a.status, AttemptStatus::Pending);
    assert_eq!(record_b.status, AttemptStatus::Pending);

    let client = pool.get().await.expect("pool connection");
    let count: i64 = client
        .query_one(
            "SELECT COUNT(*) FROM settlement_attempts WHERE idempotency_key = $1",
            &[&idempotency_key],
        )
        .await
        .expect("count attempts")
        .get(0);
    assert_eq!(count, 1);
}
