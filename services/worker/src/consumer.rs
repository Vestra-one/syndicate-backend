//! JetStream settlement consumer.

use std::time::{Duration, SystemTime, UNIX_EPOCH};

use async_nats::jetstream::Message;
use deadpool_postgres::Pool;
use futures_util::StreamExt;
use syndicate_settlement::ops::{
    net::SettlementChainHttpClient, PythResolveClient, SettlementAttemptStore, SettlementBus,
    SettlementOpsWorker, SettlementProcessResult, SolanaSettlementClient,
};
use syndicate_settlement::Outcome;

use crate::metrics::WorkerMetrics;
use crate::public_feed;
use crate::reconstruct::{parse_settlement_request, reconstruct_job, ReconstructError};
use crate::timelock_open::TimelockOpenClient;

pub async fn consumer_loop<C, S, P, T>(
    pool: Pool,
    chain: SettlementChainHttpClient,
    bus: SettlementBus,
    mut ops: SettlementOpsWorker<C, S>,
    mut oracle: P,
    mut timelock: T,
    metrics: WorkerMetrics,
    mut shutdown: tokio::sync::watch::Receiver<bool>,
) where
    C: SolanaSettlementClient + Send + 'static,
    S: SettlementAttemptStore + Send + 'static,
    P: PythResolveClient + Send + 'static,
    T: TimelockOpenClient + Send + 'static,
{
    let consumer = match bus.durable_pull_consumer().await {
        Ok(c) => c,
        Err(err) => {
            eprintln!("failed to create settlement consumer: {err}");
            return;
        }
    };
    let batch = 8usize;
    loop {
        if *shutdown.borrow() {
            break;
        }
        let messages = match consumer.fetch().max_messages(batch).messages().await {
            Ok(mut stream) => {
                let mut out = Vec::new();
                while let Some(msg) = stream.next().await {
                    match msg {
                        Ok(message) => out.push(message),
                        Err(err) => {
                            eprintln!("settlement consumer fetch error: {err}");
                            break;
                        }
                    }
                }
                out
            }
            Err(err) => {
                eprintln!("settlement consumer pull error: {err}");
                tokio::time::sleep(Duration::from_millis(500)).await;
                Vec::new()
            }
        };
        for message in messages {
            if fetched_message_decision(*shutdown.borrow()) == FetchedMessageDecision::LeaveUnacked
            {
                break;
            }
            if let Err(err) = handle_message(
                &pool,
                &chain,
                &mut ops,
                &mut oracle,
                &mut timelock,
                &metrics,
                message,
            )
            .await
            {
                eprintln!("settlement message error: {err}");
            }
        }
        tokio::select! {
            _ = tokio::time::sleep(Duration::from_millis(250)) => {}
            changed = shutdown.changed() => {
                if changed.is_ok() && *shutdown.borrow() {
                    break;
                }
            }
        }
    }
}

async fn handle_message<C, S, P, T>(
    pool: &Pool,
    chain: &SettlementChainHttpClient,
    ops: &mut SettlementOpsWorker<C, S>,
    oracle: &mut P,
    timelock: &mut T,
    metrics: &WorkerMetrics,
    message: Message,
) -> Result<(), String>
where
    C: SolanaSettlementClient,
    S: SettlementAttemptStore,
    P: PythResolveClient,
    T: TimelockOpenClient,
{
    let started = now_ms();
    metrics.inc_messages_received();
    let request = parse_settlement_request(&message.payload).map_err(|e| e.to_string())?;
    let job = match reconstruct_job(pool, &request, oracle, timelock, metrics).await {
        Ok(job) => job,
        Err(ReconstructError::TimelockPending {
            retry_after_ms,
            reason,
        }) => {
            message
                .ack_with(async_nats::jetstream::AckKind::Nak(Some(
                    Duration::from_millis(retry_after_ms),
                )))
                .await
                .map_err(|e| format!("{e:?}"))?;
            metrics.inc_attempt_retry();
            return Err(format!("timelock pending: {reason}"));
        }
        Err(e) => return Err(format!("{e:?}")),
    };
    let terminal_outcome = job.outcome.clone();
    let result = ops
        .process(&job, started)
        .await
        .map_err(|e| format!("{e:?}"))?;
    match result {
        SettlementProcessResult::Final(record) => {
            if let Err(err) =
                public_feed::publish_terminal_public_event(pool, &record.match_id, &terminal_outcome)
                    .await
            {
                eprintln!("public feed publish failed for {}: {err}", record.match_id);
            }
            message.ack().await.map_err(|e| e.to_string())?;
            metrics.inc_messages_acked();
            metrics.inc_attempt_final(record.status);
            metrics.observe_submit_confirm_latency_ms(now_ms().saturating_sub(started));
        }
        SettlementProcessResult::DeadLetter(_) => {
            message.ack().await.map_err(|e| e.to_string())?;
            metrics.inc_messages_acked();
            metrics.inc_attempt_dead_letter();
        }
        SettlementProcessResult::RetryScheduled(record) => {
            if let Some(delay_ms) = record
                .next_retry_at_ms
                .and_then(|at| at.checked_sub(started))
            {
                message
                    .ack_with(async_nats::jetstream::AckKind::Nak(Some(
                        Duration::from_millis(delay_ms),
                    )))
                    .await
                    .map_err(|e| format!("{e:?}"))?;
            } else {
                message
                    .ack_with(async_nats::jetstream::AckKind::Nak(None))
                    .await
                    .map_err(|e| format!("{e:?}"))?;
            }
            metrics.inc_attempt_retry();
        }
    }
    Ok(())
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock")
        .as_millis() as u64
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum FetchedMessageDecision {
    Process,
    LeaveUnacked,
}

fn fetched_message_decision(shutdown: bool) -> FetchedMessageDecision {
    if shutdown {
        FetchedMessageDecision::LeaveUnacked
    } else {
        FetchedMessageDecision::Process
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shutdown_leaves_fetched_messages_unacked() {
        assert_eq!(
            fetched_message_decision(true),
            FetchedMessageDecision::LeaveUnacked
        );
        assert_eq!(
            fetched_message_decision(false),
            FetchedMessageDecision::Process
        );
    }
}
