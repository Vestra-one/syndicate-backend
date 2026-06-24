//! Settlement worker daemon (tokio).
//!
//! A real async service runtime: completed matches arrive on an mpsc channel; a worker
//! task settles each via `syndicate-settlement` (which delegates outcome math to the
//! shared core), `finalize`s it (idempotent on-chain submit, or refund on VOID), and
//! **persists** the settlement to the hash-chained event store. This is the runnable
//! shell that production wraps with real transport + the Solana RPC submitter.
//!
//!   cargo run -p syndicate-worker        # runs a one-shot demo
//!   cargo test -p syndicate-worker       # async worker test

use std::path::PathBuf;

use syndicate_settlement::{finalize, Applied, MockSubmitter, Outcome};
use syndicate_store::{FileStore, Store};
use tokio::sync::{mpsc, oneshot};

/// A unit of work: an already-computed settlement outcome to persist + finalize, plus a
/// reply channel for the applied result.
pub type Job = (Outcome, oneshot::Sender<Applied>);

/// The worker loop: persist each outcome to the event store, then finalize it. The
/// submitter is idempotent, so a replayed job never double-submits.
pub async fn worker_loop(mut rx: mpsc::Receiver<Job>, store_path: PathBuf) {
    let mut submitter = MockSubmitter::new();
    let mut store = FileStore::open(&store_path).expect("open event store");
    while let Some((outcome, reply)) = rx.recv().await {
        // Append a durable, tamper-evident record of the settlement.
        store.append(format!("{outcome:?}").as_bytes()).expect("persist settlement");
        let applied = finalize(outcome, &mut submitter).expect("finalize");
        let _ = reply.send(applied);
    }
}

#[tokio::main]
async fn main() {
    let path = std::env::temp_dir().join("syndicate-worker-demo.log");
    let _ = std::fs::remove_file(&path);

    let (tx, rx) = mpsc::channel::<Job>(16);
    let handle = tokio::spawn(worker_loop(rx, path.clone()));

    let (reply_tx, reply_rx) = oneshot::channel();
    tx.send((demo::sample_outcome(), reply_tx)).await.unwrap();
    println!("worker applied: {:?}", reply_rx.await.unwrap());

    drop(tx);
    handle.await.unwrap();

    let store = FileStore::open(&path).unwrap();
    println!("persisted settlement records: {}", store.len());
    let _ = std::fs::remove_file(&path);
}

/// Builds a completed sample match and its settlement outcome (shared by main + tests).
mod demo {
    use syndicate_engine::{Action, Engine};
    use syndicate_oracle::{Guards, Sample, WindowSampler};
    use syndicate_settlement::{settle_match, Outcome, SettleParams};
    use syndicate_shared::PlayerId;
    use syndicate_timelock::{MockScheme, RoundKey, SealRegistry, TimelockScheme};

    pub fn sample_outcome() -> Outcome {
        let mut engine = Engine::new(
            vec![(PlayerId(0), 100, 0), (PlayerId(1), 100, 1), (PlayerId(2), 100, 2)],
            0,
            1,
            2,
            3,
        );
        engine.apply(0, Action::Call).unwrap();
        engine.apply(1, Action::Call).unwrap();
        engine.apply(2, Action::Check).unwrap();
        for _ in 0..2 {
            engine.apply(1, Action::Check).unwrap();
            engine.apply(2, Action::Check).unwrap();
            engine.apply(0, Action::Check).unwrap();
        }

        let mut sampler = WindowSampler::new(Guards { max_confidence: 100, max_staleness: 5, min_samples: 3 });
        for ts in 0..5 {
            sampler.record(Sample { ts, price: 100_000, confidence: 10, publish_ts: ts });
        }

        let scheme = MockScheme;
        let mut reg = SealRegistry::new(42);
        reg.seal(PlayerId(0), scheme.encrypt(100_010, 42)).unwrap();
        reg.seal(PlayerId(1), scheme.encrypt(99_000, 42)).unwrap();
        reg.seal(PlayerId(2), scheme.encrypt(100_500, 42)).unwrap();
        reg.lock();
        let key = RoundKey { round: 42, key: vec![1] };

        let params = SettleParams { rake_bps: 0, rake_cap: 0, min_samples: 3, window_start: 0, window_end: 5 };
        settle_match(&engine, &sampler, &reg, &scheme, Some(&key), &params)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn worker_settles_finalizes_and_persists() {
        let path = std::env::temp_dir().join(format!("synd-worker-test-{}.log", std::process::id()));
        let _ = std::fs::remove_file(&path);

        let (tx, rx) = mpsc::channel::<Job>(8);
        let handle = tokio::spawn(worker_loop(rx, path.clone()));

        let (reply_tx, reply_rx) = oneshot::channel();
        tx.send((demo::sample_outcome(), reply_tx)).await.unwrap();
        let applied = reply_rx.await.unwrap();
        assert!(matches!(applied, Applied::Settled(_)));

        drop(tx);
        handle.await.unwrap();

        // The settlement was durably persisted to the hash-chained store.
        let store = FileStore::open(&path).unwrap();
        assert_eq!(store.len(), 1);
        store.verify().unwrap();
        std::fs::remove_file(&path).unwrap();
    }
}
