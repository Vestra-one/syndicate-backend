//! Due settlement attempt poller for crash-safe resume.

use std::time::Duration;

use chrono::{DateTime, Utc};
use deadpool_postgres::Pool;
use syndicate_settlement::ops::{
    PythResolveClient, SettlementAttemptStore, SettlementOpsWorker, SettlementProcessResult,
    SolanaSettlementClient,
};
use syndicate_store::LIST_DUE_SETTLEMENT_ATTEMPTS_SQL;

use crate::metrics::WorkerMetrics;
use crate::reconstruct::{reconstruct_job_from_attempt, ReconstructError};
use crate::timelock_open::TimelockOpenClient;

#[derive(Clone, Debug)]
pub struct PollerConfig {
    pub interval_ms: u64,
    pub batch_size: i32,
    pub confirm_timeout_ms: i64,
}

impl Default for PollerConfig {
    fn default() -> Self {
        Self {
            interval_ms: 5_000,
            batch_size: 16,
            confirm_timeout_ms: 60_000,
        }
    }
}

impl PollerConfig {
    pub fn from_env() -> Self {
        Self {
            interval_ms: env_u64("SETTLEMENT_POLLER_INTERVAL_MS", 5_000),
            batch_size: env_i32("SETTLEMENT_POLLER_BATCH_SIZE", 16),
            confirm_timeout_ms: env_i64("SETTLEMENT_CONFIRMATION_TIMEOUT_MS", 60_000),
        }
    }
}

#[derive(Clone, Debug)]
pub struct DueAttempt {
    pub match_id: String,
    pub idempotency_key: String,
    pub event_root: [u8; 32],
    pub status: String,
}

pub async fn poller_loop<C, S, P, T>(
    pool: Pool,
    mut ops: SettlementOpsWorker<C, S>,
    mut oracle: P,
    mut timelock: T,
    config: PollerConfig,
    metrics: WorkerMetrics,
    mut shutdown: tokio::sync::watch::Receiver<bool>,
) where
    C: SolanaSettlementClient + Send + 'static,
    S: SettlementAttemptStore + Send + 'static,
    P: PythResolveClient + Send + 'static,
    T: TimelockOpenClient + Send + 'static,
{
    let mut interval = tokio::time::interval(Duration::from_millis(config.interval_ms));
    loop {
        tokio::select! {
            _ = interval.tick() => {
                if let Err(err) = poll_once(&pool, &mut ops, &mut oracle, &mut timelock, &config, &metrics).await {
                    eprintln!("settlement poller error: {err}");
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

pub async fn poll_once<C, S, P, T>(
    pool: &Pool,
    ops: &mut SettlementOpsWorker<C, S>,
    oracle: &mut P,
    timelock: &mut T,
    config: &PollerConfig,
    metrics: &WorkerMetrics,
) -> Result<(), String>
where
    C: SolanaSettlementClient,
    S: SettlementAttemptStore,
    P: PythResolveClient,
    T: TimelockOpenClient,
{
    let due = list_due_attempts(pool, config).await?;
    metrics.set_due_attempts(due.len() as u64);
    for attempt in due {
        if matches!(
            attempt.status.as_str(),
            "confirmed" | "voided" | "dead_letter"
        ) {
            continue;
        }
        let job = match reconstruct_job_from_attempt(
            pool,
            &attempt.match_id,
            &attempt.event_root,
            oracle,
            timelock,
            metrics,
        )
        .await
        {
            Ok(job) => job,
            Err(ReconstructError::TimelockPending { reason, .. }) => {
                eprintln!("settlement poller timelock pending: {reason}");
                metrics.inc_attempt_retry();
                continue;
            }
            Err(e) => return Err(e.to_string()),
        };
        let started = now_ms();
        let result = ops
            .process(&job, started)
            .await
            .map_err(|e| format!("{e:?}"))?;
        match result {
            SettlementProcessResult::Final(record) => {
                metrics.inc_attempt_final(record.status);
                metrics.observe_submit_confirm_latency_ms(now_ms().saturating_sub(started));
            }
            SettlementProcessResult::RetryScheduled(_) => metrics.inc_attempt_retry(),
            SettlementProcessResult::DeadLetter(_) => metrics.inc_attempt_dead_letter(),
        }
    }
    Ok(())
}

pub async fn list_due_attempts(
    pool: &Pool,
    config: &PollerConfig,
) -> Result<Vec<DueAttempt>, String> {
    let client = pool.get().await.map_err(|e| e.to_string())?;
    let now: DateTime<Utc> = Utc::now();
    let batch_size = i64::from(config.batch_size);
    let rows = client
        .query(
            LIST_DUE_SETTLEMENT_ATTEMPTS_SQL,
            &[&now, &config.confirm_timeout_ms, &batch_size],
        )
        .await
        .map_err(|e| e.to_string())?;
    rows.iter()
        .map(|row| {
            let event_root: Vec<u8> = row.get("event_root");
            if event_root.len() != 32 {
                return Err("invalid event_root length".to_string());
            }
            let mut root = [0u8; 32];
            root.copy_from_slice(&event_root);
            Ok(DueAttempt {
                match_id: row.get("match_id"),
                idempotency_key: row.get("idempotency_key"),
                event_root: root,
                status: row.get("status"),
            })
        })
        .collect()
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("clock")
        .as_millis() as u64
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
    fn poller_config_defaults() {
        let cfg = PollerConfig::default();
        assert!(cfg.interval_ms > 0);
        assert!(cfg.batch_size > 0);
    }
}
