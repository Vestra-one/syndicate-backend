//! The claim loop: LISTEN wake-up + interval poll (poll is the correctness path),
//! bounded-concurrency execution, startup + periodic stale sweeps.

use std::sync::Arc;

use futures_util::{future, StreamExt};
use tracing::{info, warn};

use crate::db;
use crate::executor::Executor;
use crate::rpc::SigStatus;

pub const EXECUTOR_CONCURRENCY: usize = 4;

pub async fn run(executor: Arc<Executor>) {
    let node_id = format!("chain-worker-{}", &uuid::Uuid::new_v4().to_string()[..8]);
    info!(%node_id, "job loop starting");

    sweep_stale(&executor).await;

    // LISTEN task: nudges the poll loop when a job is inserted.
    let (notify_tx, mut notify_rx) = tokio::sync::mpsc::channel::<()>(8);
    tokio::spawn(listen_task(executor.cfg.database_url.clone(), notify_tx));

    let poll = std::time::Duration::from_millis(executor.cfg.poll_ms);
    let semaphore = Arc::new(tokio::sync::Semaphore::new(EXECUTOR_CONCURRENCY));
    let mut sweep_tick = tokio::time::interval(std::time::Duration::from_secs(60));

    loop {
        tokio::select! {
            _ = tokio::time::sleep(poll) => {}
            _ = notify_rx.recv() => {}
            _ = sweep_tick.tick() => {
                sweep_stale(&executor).await;
                if let Ok(due) = db::count_due_jobs(&executor.pool).await {
                    executor.metrics.set_due(due);
                }
                continue;
            }
        }

        let jobs =
            match db::claim_due_jobs(&executor.pool, &node_id, executor.cfg.claim_batch).await {
                Ok(jobs) => jobs,
                Err(e) => {
                    warn!("claim failed: {e}");
                    continue;
                }
            };
        if jobs.is_empty() {
            continue;
        }
        // Execute the batch with bounded concurrency; wait for the batch so claims
        // don't pile up unboundedly.
        future::join_all(jobs.into_iter().map(|job| {
            let executor = executor.clone();
            let semaphore = semaphore.clone();
            async move {
                let _permit = semaphore.acquire().await.expect("semaphore open");
                executor.execute(job).await;
            }
        }))
        .await;
    }
}

/// Reset jobs stuck in claimed/submitted past the confirmation timeout. Submitted jobs
/// with a signature get a status check first (crash recovery).
async fn sweep_stale(executor: &Executor) {
    let stale =
        match db::list_stale_jobs(&executor.pool, executor.cfg.confirmation_timeout_ms).await {
            Ok(s) => s,
            Err(e) => {
                warn!("stale sweep list failed: {e}");
                return;
            }
        };
    for (job_id, tx_signature) in stale {
        if let Some(sig_str) = &tx_signature {
            if let Ok(sig) = sig_str.parse() {
                match executor.rpc.signature_status(&sig).await {
                    Ok(SigStatus::Confirmed) => {
                        let _ = db::mark_confirmed(&executor.pool, job_id, Some(sig_str)).await;
                        continue;
                    }
                    Ok(SigStatus::Processed) => continue, // still landing
                    _ => {}
                }
            }
        }
        info!(%job_id, "resetting stale job");
        let _ = db::reset_stale_job(&executor.pool, job_id).await;
    }
}

/// Dedicated LISTEN connection; reconnects with backoff on failure.
async fn listen_task(database_url: String, tx: tokio::sync::mpsc::Sender<()>) {
    loop {
        match tokio_postgres::connect(&database_url, tokio_postgres::NoTls).await {
            Ok((client, mut connection)) => {
                let tx_inner = tx.clone();
                let stream = futures_util::stream::poll_fn(move |cx| connection.poll_message(cx));
                let notify_pump = stream.for_each(move |message| {
                    if let Ok(tokio_postgres::AsyncMessage::Notification(_)) = message {
                        let _ = tx_inner.try_send(());
                    }
                    future::ready(())
                });
                if let Err(e) = client.batch_execute("LISTEN syndicate_chain_jobs").await {
                    warn!("LISTEN failed: {e}");
                } else {
                    info!("listening on syndicate_chain_jobs");
                    notify_pump.await; // runs until the connection drops
                }
            }
            Err(e) => warn!("listen connect failed: {e}"),
        }
        tokio::time::sleep(std::time::Duration::from_secs(5)).await;
    }
}
