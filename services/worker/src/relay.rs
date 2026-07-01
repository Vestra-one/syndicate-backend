//! Outbox relay: Postgres settlement outbox -> NATS JetStream.

use std::time::Duration;

use chrono::{DateTime, Utc};
use deadpool_postgres::Pool;
use syndicate_settlement::ops::{BusError, SettlementBus};
use syndicate_store::{
    CLAIM_SETTLEMENT_OUTBOX_SQL, MARK_OUTBOX_DEAD_LETTER_SQL, MARK_OUTBOX_PUBLISHED_SQL,
    MARK_OUTBOX_RETRY_SQL,
};

use crate::metrics::WorkerMetrics;

#[derive(Clone, Debug)]
pub struct RelayConfig {
    pub poll_interval_ms: u64,
    pub batch_size: i32,
    pub visibility_timeout_ms: i64,
    pub retry_delay_ms: i64,
    pub max_attempts: i32,
}

impl Default for RelayConfig {
    fn default() -> Self {
        Self {
            poll_interval_ms: 1_000,
            batch_size: 16,
            visibility_timeout_ms: 60_000,
            retry_delay_ms: 5_000,
            max_attempts: 10,
        }
    }
}

impl RelayConfig {
    pub fn from_env() -> Self {
        Self {
            poll_interval_ms: env_u64("SETTLEMENT_RELAY_POLL_MS", 1_000),
            batch_size: env_i32("SETTLEMENT_RELAY_BATCH_SIZE", 16),
            visibility_timeout_ms: env_i64("SETTLEMENT_RELAY_VISIBILITY_MS", 60_000),
            retry_delay_ms: env_i64("SETTLEMENT_RELAY_RETRY_MS", 5_000),
            max_attempts: env_i32("SETTLEMENT_RELAY_MAX_ATTEMPTS", 10),
        }
    }
}

#[derive(Clone, Debug)]
pub struct ClaimedOutboxRow {
    pub id: String,
    pub aggregate_id: String,
    pub event_type: String,
    pub payload: String,
    pub attempts: i32,
}

pub async fn relay_loop(
    pool: Pool,
    bus: SettlementBus,
    config: RelayConfig,
    metrics: WorkerMetrics,
    mut shutdown: tokio::sync::watch::Receiver<bool>,
) {
    let mut interval = tokio::time::interval(Duration::from_millis(config.poll_interval_ms));
    loop {
        tokio::select! {
            _ = interval.tick() => {
                if let Err(err) = relay_once(&pool, &bus, &config, &metrics).await {
                    eprintln!("settlement relay error: {err}");
                }
            }
            changed = shutdown.changed() => {
                if changed.is_ok() && *shutdown.borrow() {
                    break;
                }
            }
        }
    }
}

pub async fn relay_once(
    pool: &Pool,
    bus: &SettlementBus,
    config: &RelayConfig,
    metrics: &WorkerMetrics,
) -> Result<(), String> {
    let rows = claim_rows(pool, config).await?;
    metrics.set_outbox_backlog(rows.len() as u64);
    for row in rows {
        match bus
            .publish_settlement_request(&row.aggregate_id, row.payload.as_bytes(), &row.id)
            .await
        {
            Ok(()) => {
                mark_published(pool, &row.id).await?;
                metrics.inc_relay_published();
            }
            Err(BusError::Publish(err)) => {
                if row.attempts >= config.max_attempts {
                    mark_dead_letter(pool, &row.id, &err).await?;
                    metrics.inc_relay_dead_letter();
                } else {
                    mark_retry(pool, &row.id, config.retry_delay_ms, &err).await?;
                    metrics.inc_relay_retry();
                }
            }
            Err(other) => return Err(other.to_string()),
        }
    }
    Ok(())
}

async fn claim_rows(pool: &Pool, config: &RelayConfig) -> Result<Vec<ClaimedOutboxRow>, String> {
    let client = pool.get().await.map_err(|e| e.to_string())?;
    let now: DateTime<Utc> = Utc::now();
    let batch_size = i64::from(config.batch_size);
    let rows = client
        .query(
            CLAIM_SETTLEMENT_OUTBOX_SQL,
            &[&now, &batch_size, &config.visibility_timeout_ms],
        )
        .await
        .map_err(|e| e.to_string())?;
    Ok(rows
        .iter()
        .map(|row| ClaimedOutboxRow {
            id: row.get("id"),
            aggregate_id: row.get("aggregate_id"),
            event_type: row.get("event_type"),
            payload: row.get("payload"),
            attempts: row.get("attempts"),
        })
        .collect())
}

async fn mark_published(pool: &Pool, outbox_id: &str) -> Result<(), String> {
    let client = pool.get().await.map_err(|e| e.to_string())?;
    let id = uuid::Uuid::parse_str(outbox_id).map_err(|e| e.to_string())?;
    let now: DateTime<Utc> = Utc::now();
    client
        .execute(MARK_OUTBOX_PUBLISHED_SQL, &[&id, &now])
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

async fn mark_retry(
    pool: &Pool,
    outbox_id: &str,
    retry_delay_ms: i64,
    error: &str,
) -> Result<(), String> {
    let client = pool.get().await.map_err(|e| e.to_string())?;
    let id = uuid::Uuid::parse_str(outbox_id).map_err(|e| e.to_string())?;
    let now: DateTime<Utc> = Utc::now();
    client
        .execute(
            MARK_OUTBOX_RETRY_SQL,
            &[&id, &now, &retry_delay_ms, &error],
        )
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

async fn mark_dead_letter(pool: &Pool, outbox_id: &str, error: &str) -> Result<(), String> {
    let client = pool.get().await.map_err(|e| e.to_string())?;
    let id = uuid::Uuid::parse_str(outbox_id).map_err(|e| e.to_string())?;
    client
        .execute(MARK_OUTBOX_DEAD_LETTER_SQL, &[&id, &error])
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

fn env_u64(name: &str, default: u64) -> u64 {
    std::env::var(name)
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(default)
}

fn env_i32(name: &str, default: i32) -> i32 {
    std::env::var(name)
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(default)
}

fn env_i64(name: &str, default: i64) -> i64 {
    std::env::var(name)
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(default)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn relay_config_defaults_are_positive() {
        let cfg = RelayConfig::default();
        assert!(cfg.batch_size > 0);
        assert!(cfg.max_attempts > 0);
    }
}
