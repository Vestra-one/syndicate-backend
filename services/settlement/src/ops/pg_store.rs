//! Postgres-backed settlement attempt store for production runtimes.

use async_trait::async_trait;
use deadpool_postgres::{Config, Pool, Runtime};
use tokio_postgres::Row;
use tokio_postgres::types::Json;

use syndicate_store::{
    INSERT_SETTLEMENT_DEAD_LETTER_SQL, LOAD_SETTLEMENT_ATTEMPT_SQL, LOCK_SETTLEMENT_ATTEMPT_SQL,
    MARK_SETTLEMENT_CONFIRMED_SQL, MARK_SETTLEMENT_DEAD_LETTER_SQL, MARK_SETTLEMENT_RETRY_SQL,
    MARK_SETTLEMENT_SUBMITTED_SQL, MARK_SETTLEMENT_VOIDED_SQL, UPSERT_SETTLEMENT_ATTEMPT_SQL,
};

use super::{
    AttemptRecord, AttemptStatus, AttemptStoreError, SettlementAttemptStore, SettlementJob,
};
use crate::Outcome;

#[derive(Clone)]
pub struct PostgresAttemptStore {
    pool: Pool,
}

impl PostgresAttemptStore {
    pub fn new(pool: Pool) -> Self {
        Self { pool }
    }

    pub fn pool_from_url(database_url: &str) -> Result<Pool, AttemptStoreError> {
        let mut cfg = Config::new();
        cfg.url = Some(database_url.to_string());
        cfg.create_pool(Some(Runtime::Tokio1), tokio_postgres::NoTls)
            .map_err(map_pool_err)
    }

    async fn connection(&self) -> Result<deadpool_postgres::Object, AttemptStoreError> {
        self.pool.get().await.map_err(map_pool_err)
    }
}

fn map_pool_err(err: impl std::fmt::Display) -> AttemptStoreError {
    AttemptStoreError::Backend(err.to_string())
}

fn map_pg_err(err: tokio_postgres::Error) -> AttemptStoreError {
    if let Some(db) = err.as_db_error() {
        let mut msg = db.message().to_string();
        if let Some(constraint) = db.constraint() {
            msg.push_str(&format!(" (constraint: {constraint})"));
        }
        if let Some(detail) = db.detail() {
            msg.push_str(&format!(" — {detail}"));
        }
        if let Some(hint) = db.hint() {
            msg.push_str(&format!(" [hint: {hint}]"));
        }
        return AttemptStoreError::Backend(msg);
    }
    AttemptStoreError::Backend(format!("{err:?}"))
}

fn attempt_kind(job: &SettlementJob) -> &'static str {
    match &job.outcome {
        Outcome::Settled(_) => "settle",
        Outcome::Void(_) => "void",
    }
}

fn parse_status(raw: &str) -> Result<AttemptStatus, AttemptStoreError> {
    match raw {
        "pending" => Ok(AttemptStatus::Pending),
        "submitted" => Ok(AttemptStatus::Submitted),
        "confirmed" => Ok(AttemptStatus::Confirmed),
        "voided" => Ok(AttemptStatus::Voided),
        "retry_scheduled" => Ok(AttemptStatus::RetryScheduled),
        "dead_letter" => Ok(AttemptStatus::DeadLetter),
        other => Err(AttemptStoreError::Backend(format!(
            "unknown settlement attempt status: {other}"
        ))),
    }
}

fn row_to_attempt(row: &Row) -> Result<AttemptRecord, AttemptStoreError> {
    let event_root: Vec<u8> = row.get("event_root");
    if event_root.len() != 32 {
        return Err(AttemptStoreError::Backend(format!(
            "event_root must be 32 bytes, got {}",
            event_root.len()
        )));
    }
    let mut root = [0u8; 32];
    root.copy_from_slice(&event_root);
    let next_retry_at_ms: Option<i64> = row.try_get("next_retry_at_ms").ok().flatten();
    Ok(AttemptRecord {
        match_id: row.get("match_id"),
        idempotency_key: row.get("idempotency_key"),
        event_root: root,
        status: parse_status(row.get("status"))?,
        attempt_count: row.get::<_, i32>("attempt_count") as u32,
        tx_sig: row.get("tx_signature"),
        next_retry_at_ms: next_retry_at_ms.map(|v| v as u64),
        last_error: row.get("last_error"),
        oracle_audit: row.try_get("oracle_audit").ok().flatten(),
    })
}

async fn query_one_attempt(
    client: &deadpool_postgres::Object,
    sql: &str,
    params: &[&(dyn tokio_postgres::types::ToSql + Sync)],
) -> Result<AttemptRecord, AttemptStoreError> {
    let row = client
        .query_opt(sql, params)
        .await
        .map_err(map_pg_err)?
        .ok_or(AttemptStoreError::NotFound)?;
    row_to_attempt(&row)
}

async fn load_attempt(
    client: &deadpool_postgres::Object,
    idempotency_key: &str,
) -> Result<AttemptRecord, AttemptStoreError> {
    query_one_attempt(client, LOAD_SETTLEMENT_ATTEMPT_SQL, &[&idempotency_key]).await
}

async fn resolve_match_uuid(
    client: &deadpool_postgres::Transaction<'_>,
    match_id: &str,
) -> Result<uuid::Uuid, AttemptStoreError> {
    if let Ok(id) = uuid::Uuid::parse_str(match_id) {
        return Ok(id);
    }
    let row = client
        .query_opt(
            r#"
            SELECT id
            FROM matches
            WHERE match_key = $1 OR onchain_match_id::text = $1
            LIMIT 1
            "#,
            &[&match_id],
        )
        .await
        .map_err(map_pg_err)?;
    row.map(|r| r.get("id"))
        .ok_or_else(|| AttemptStoreError::Backend(format!("match not found: {match_id}")))
}

#[async_trait]
impl SettlementAttemptStore for PostgresAttemptStore {
    async fn begin_attempt(
        &mut self,
        job: &SettlementJob,
        now_ms: u64,
    ) -> Result<AttemptRecord, AttemptStoreError> {
        let mut client = self.connection().await?;
        let transaction = client.transaction().await.map_err(map_pg_err)?;
        transaction
            .query_opt(LOCK_SETTLEMENT_ATTEMPT_SQL, &[&job.idempotency_key])
            .await
            .map_err(map_pg_err)?;
        let match_uuid = resolve_match_uuid(&transaction, &job.match_id).await?;
        let next_retry: Option<f64> = None;
        let oracle_audit = super::oracle_audit_for_job(job);
        let oracle_audit_json = oracle_audit.as_ref().map(Json);
        let row = transaction
            .query_one(
                UPSERT_SETTLEMENT_ATTEMPT_SQL,
                &[
                    &match_uuid,
                    &job.idempotency_key,
                    &attempt_kind(job),
                    &job.event_root.as_slice(),
                    &oracle_audit_json,
                    &next_retry,
                ],
            )
            .await
            .map_err(map_pg_err)?;
        transaction.commit().await.map_err(map_pg_err)?;
        let _ = now_ms;
        row_to_attempt(&row)
    }

    async fn mark_submitted(
        &mut self,
        idempotency_key: &str,
        tx_sig: String,
    ) -> Result<AttemptRecord, AttemptStoreError> {
        let client = self.connection().await?;
        query_one_attempt(
            &client,
            MARK_SETTLEMENT_SUBMITTED_SQL,
            &[&idempotency_key, &tx_sig],
        )
        .await
    }

    async fn mark_confirmed(
        &mut self,
        idempotency_key: &str,
    ) -> Result<AttemptRecord, AttemptStoreError> {
        let client = self.connection().await?;
        let now_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|e| AttemptStoreError::Backend(e.to_string()))?
            .as_millis() as f64;
        match client
            .query_opt(MARK_SETTLEMENT_CONFIRMED_SQL, &[&idempotency_key, &now_ms])
            .await
            .map_err(map_pg_err)?
        {
            Some(row) => row_to_attempt(&row),
            None => load_attempt(&client, idempotency_key).await,
        }
    }

    async fn mark_voided(
        &mut self,
        idempotency_key: &str,
        tx_sig: String,
        reason: String,
    ) -> Result<AttemptRecord, AttemptStoreError> {
        let client = self.connection().await?;
        query_one_attempt(
            &client,
            MARK_SETTLEMENT_VOIDED_SQL,
            &[&idempotency_key, &tx_sig, &reason],
        )
        .await
    }

    async fn mark_retry(
        &mut self,
        idempotency_key: &str,
        error: String,
        next_retry_at_ms: u64,
    ) -> Result<AttemptRecord, AttemptStoreError> {
        let client = self.connection().await?;
        let next_retry_at = next_retry_at_ms as f64;
        query_one_attempt(
            &client,
            MARK_SETTLEMENT_RETRY_SQL,
            &[&idempotency_key, &error, &next_retry_at],
        )
        .await
    }

    async fn dead_letter(
        &mut self,
        job: &SettlementJob,
        reason: String,
        payload: String,
    ) -> Result<AttemptRecord, AttemptStoreError> {
        let mut client = self.connection().await?;
        let transaction = client.transaction().await.map_err(map_pg_err)?;
        let row = transaction
            .query_opt(
                MARK_SETTLEMENT_DEAD_LETTER_SQL,
                &[&job.idempotency_key, &reason],
            )
            .await
            .map_err(map_pg_err)?
            .ok_or(AttemptStoreError::NotFound)?;
        let payload_json = Json(serde_json::json!({ "payload": payload }));
        transaction
            .execute(
                INSERT_SETTLEMENT_DEAD_LETTER_SQL,
                &[&job.idempotency_key, &reason, &payload_json],
            )
            .await
            .map_err(map_pg_err)?;
        transaction.commit().await.map_err(map_pg_err)?;
        row_to_attempt(&row)
    }

    async fn get(&self, idempotency_key: &str) -> Result<Option<AttemptRecord>, AttemptStoreError> {
        let client = self.connection().await?;
        match client
            .query_opt(LOAD_SETTLEMENT_ATTEMPT_SQL, &[&idempotency_key])
            .await
            .map_err(map_pg_err)?
        {
            Some(row) => Ok(Some(row_to_attempt(&row)?)),
            None => Ok(None),
        }
    }
}
