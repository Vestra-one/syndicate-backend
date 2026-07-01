//! Settlement worker daemon (tokio).
//!
//! Production mode runs three durable loops:
//! - Postgres settlement outbox relay -> NATS JetStream
//! - JetStream durable pull consumer -> reconstruct outcome -> settlement-chain
//! - Postgres due-poller for crash-safe resume of retry/submitted attempts
//!
//! Demo mode (non-mainnet only) exercises the in-memory settlement path for local dev.

mod consumer;
mod health;
mod metrics;
mod poller;
mod public_feed;
mod reconstruct;
mod registry_http;
mod relay;
mod timelock_open;

use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use syndicate_settlement::ops::net::SettlementChainHttpClient;
use syndicate_settlement::ops::{
    InMemoryAttemptStore, MockSolanaClient, PostgresAttemptStore, RetryPolicy, SettlementBus,
    SettlementBusConfig, SettlementJob, SettlementOpsWorker, SettlementProcessResult,
};
use syndicate_store::FileStore;
use syndicate_store::Store;
use timelock_open::DrandTimelockOpenClient;
use tokio::signal;
use tokio::sync::{mpsc, oneshot};

pub use metrics::WorkerMetrics;
pub use reconstruct::{idempotency_key, parse_settlement_request, SettlementRequest};
pub use relay::{relay_loop, RelayConfig};

/// A unit of work for demo mode.
pub type Job = (SettlementJob, oneshot::Sender<SettlementProcessResult>);

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system clock before unix epoch")
        .as_millis() as u64
}

/// Demo worker loop: file-backed event log plus in-memory attempt store and mock chain.
pub async fn demo_worker_loop(mut rx: mpsc::Receiver<Job>, store_path: PathBuf) {
    let mut ops = SettlementOpsWorker {
        chain: MockSolanaClient::new(),
        store: InMemoryAttemptStore::new(),
        retry_policy: RetryPolicy::recommended(),
    };
    let mut store = FileStore::open(&store_path).expect("open event store");
    while let Some((job, reply)) = rx.recv().await {
        store
            .append(format!("{job:?}").as_bytes())
            .expect("persist settlement");
        let applied = ops
            .process(&job, now_ms())
            .await
            .expect("process settlement attempt");
        let _ = reply.send(applied);
    }
}

struct ProductionRuntime {
    chain: SettlementChainHttpClient,
    oracle: SettlementChainHttpClient,
    timelock: DrandTimelockOpenClient,
    database_url: String,
    bus_config: SettlementBusConfig,
}

#[tokio::main]
async fn main() {
    let app_env = std::env::var("APP_ENV").unwrap_or_else(|_| "localnet".into());
    let mode = std::env::var("SETTLEMENT_WORKER_MODE").unwrap_or_else(|_| {
        if app_env == "mainnet" || app_env == "mainnet-beta" {
            "production".into()
        } else {
            "demo".into()
        }
    });

    if mode == "production" {
        run_production().await;
        return;
    }

    if app_env == "mainnet" || app_env == "mainnet-beta" {
        eprintln!("refusing to run demo settlement worker in {app_env}");
        std::process::exit(2);
    }

    run_demo().await;
}

async fn run_production() {
    let runtime = production_preflight();
    let metrics = WorkerMetrics::default();
    let host = std::env::var("SETTLEMENT_WORKER_HOST").unwrap_or_else(|_| "0.0.0.0".into());
    let port = std::env::var("SETTLEMENT_WORKER_PORT")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(8084);
    let registry_store = syndicate_store::MatchRegistryStore::from_database_url(&runtime.database_url)
        .expect("connect postgres for match registry");
    let registry_auth = read_optional_secret(
        "MATCH_PERSISTENCE_AUTH_TOKEN",
        "MATCH_PERSISTENCE_AUTH_TOKEN_FILE",
    )
    .or_else(|| {
        std::env::var("SETTLEMENT_CHAIN_AUTH_TOKEN_FILE")
            .ok()
            .map(|path| read_secret_file("SETTLEMENT_CHAIN_AUTH_TOKEN_FILE", &path))
    })
    .unwrap_or_default();
    registry_http::spawn_registry_server(
        &host,
        port,
        registry_http::RegistryHttpState {
            store: registry_store,
            auth_token: registry_auth,
            metrics: metrics.clone(),
        },
    );

    let pool = PostgresAttemptStore::pool_from_url(&runtime.database_url)
        .expect("connect postgres for settlement worker");
    let pool_for_relay = pool.clone();
    let pool_for_consumer = pool.clone();
    let pool_for_poller = pool.clone();

    let bus = SettlementBus::connect(runtime.bus_config.clone())
        .await
        .expect("connect NATS JetStream settlement bus");
    let bus_for_consumer = bus.clone();

    let chain_for_consumer = runtime.chain.clone();
    let ops_consumer = SettlementOpsWorker {
        chain: runtime.chain.clone(),
        store: PostgresAttemptStore::new(pool.clone()),
        retry_policy: RetryPolicy::recommended(),
    };
    let ops_poller = SettlementOpsWorker {
        chain: runtime.chain,
        store: PostgresAttemptStore::new(pool),
        retry_policy: RetryPolicy::recommended(),
    };

    let (shutdown_tx, shutdown_rx) = tokio::sync::watch::channel(false);
    let shutdown_relay = shutdown_rx.clone();
    let shutdown_consumer = shutdown_rx.clone();
    let shutdown_poller = shutdown_rx.clone();

    let relay_metrics = metrics.clone();
    let consumer_metrics = metrics.clone();
    let poller_metrics = metrics.clone();

    let relay_handle = tokio::spawn(async move {
        relay::relay_loop(
            pool_for_relay,
            bus,
            RelayConfig::from_env(),
            relay_metrics,
            shutdown_relay,
        )
        .await;
    });

    let oracle_for_consumer = runtime.oracle.clone();
    let oracle_for_poller = runtime.oracle;
    let timelock_for_consumer = runtime.timelock.clone();
    let timelock_for_poller = runtime.timelock;

    let consumer_handle = tokio::spawn(async move {
        consumer::consumer_loop(
            pool_for_consumer,
            chain_for_consumer,
            bus_for_consumer,
            ops_consumer,
            oracle_for_consumer,
            timelock_for_consumer,
            consumer_metrics,
            shutdown_consumer,
        )
        .await;
    });

    let poller_handle = tokio::spawn(async move {
        poller::poller_loop(
            pool_for_poller,
            ops_poller,
            oracle_for_poller,
            timelock_for_poller,
            poller::PollerConfig::from_env(),
            poller_metrics,
            shutdown_poller,
        )
        .await;
    });

    println!(
        "settlement worker production runtime ready (outbox relay + JetStream consumer + due-poller)"
    );

    if let Err(err) = signal::ctrl_c().await {
        eprintln!("failed to listen for shutdown signal: {err}");
    }
    let _ = shutdown_tx.send(true);
    let _ = tokio::join!(relay_handle, consumer_handle, poller_handle);
}

async fn run_demo() {
    let path = std::env::temp_dir().join("syndicate-worker-demo.log");
    let _ = std::fs::remove_file(&path);

    let (tx, rx) = mpsc::channel::<Job>(16);
    let handle = tokio::spawn(demo_worker_loop(rx, path.clone()));

    let (reply_tx, reply_rx) = oneshot::channel();
    tx.send((demo::sample_job(), reply_tx)).await.unwrap();
    println!("worker applied: {:?}", reply_rx.await.unwrap());

    drop(tx);
    handle.await.unwrap();

    let store = FileStore::open(&path).unwrap();
    println!("persisted settlement records: {}", store.len());
    let _ = std::fs::remove_file(&path);
}

fn production_preflight() -> ProductionRuntime {
    let database_url = required_env("DATABASE_URL");
    required_env("NATS_URL");
    let chain_url = required_env("SETTLEMENT_CHAIN_URL");
    let auth_token_file = required_env("SETTLEMENT_CHAIN_AUTH_TOKEN_FILE");
    let auth_token = read_secret_file("SETTLEMENT_CHAIN_AUTH_TOKEN_FILE", &auth_token_file);
    let _pyth_api_key = std::env::var("PYTH_API_KEY")
        .ok()
        .filter(|v| !v.trim().is_empty())
        .or_else(|| {
            std::env::var("PYTH_API_KEY_FILE")
                .ok()
                .map(|path| read_secret_file("PYTH_API_KEY_FILE", &path))
        })
        .unwrap_or_else(|| panic!("missing PYTH_API_KEY or PYTH_API_KEY_FILE"));
    required_env("SOLANA_RPC_URL_PRIMARY");
    required_env("SYNDICATE_PROGRAM_ID");
    require_pyth_receiver_env();
    required_env("SETTLEMENT_SIGNER_KEYPAIR_PATH");
    let timelock = DrandTimelockOpenClient::from_env()
        .unwrap_or_else(|e| panic!("drand timelock preflight failed: {e}"));

    let chain = SettlementChainHttpClient {
        base_url: chain_url.clone(),
        auth_token: auth_token.clone(),
        timeout_ms: std::env::var("SOLANA_RPC_TIMEOUT_MS")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(5_000),
    };
    let health_url = format!("{}/health", chain_url.trim_end_matches('/'));
    let health = ureq::get(&health_url)
        .timeout(std::time::Duration::from_millis(2_000))
        .call()
        .unwrap_or_else(|e| panic!("settlement-chain health check failed at {health_url}: {e}"));
    if health.status() != 200 {
        panic!(
            "settlement-chain health check failed at {health_url}: HTTP {}",
            health.status()
        );
    }

    ProductionRuntime {
        oracle: chain.clone(),
        chain,
        timelock,
        database_url,
        bus_config: SettlementBusConfig::from_env(),
    }
}

fn require_pyth_receiver_env() {
    let stack = std::env::var("PYTH_RECEIVER_STACK")
        .ok()
        .filter(|v| !v.trim().is_empty())
        .or_else(|| {
            std::env::var("SYNDICATE_PYTH_RECEIVER_STACK")
                .ok()
                .filter(|v| !v.trim().is_empty())
        });
    if stack.is_some() {
        return;
    }
    required_env("PYTH_HERMES_URL");
    required_env("PYTH_RECEIVER_PROGRAM_ID");
    required_env("PYTH_WORMHOLE_PROGRAM_ID");
    required_env("PYTH_PUSH_ORACLE_PROGRAM_ID");
}

fn required_env(name: &str) -> String {
    std::env::var(name).unwrap_or_else(|_| panic!("missing required environment variable: {name}"))
}

fn read_secret_file(name: &str, path: &str) -> String {
    let value = std::fs::read_to_string(path)
        .unwrap_or_else(|e| panic!("read {name} from configured path failed: {e}"))
        .trim()
        .to_string();
    if value.is_empty() {
        panic!("{name} points to an empty secret file");
    }
    value
}

fn read_optional_secret(direct: &str, file_env: &str) -> Option<String> {
    if let Ok(value) = std::env::var(direct) {
        let trimmed = value.trim().to_string();
        if !trimmed.is_empty() {
            return Some(trimmed);
        }
    }
    std::env::var(file_env)
        .ok()
        .map(|path| read_secret_file(file_env, &path))
}

mod demo {
    use std::collections::BTreeMap;
    use syndicate_engine::{Action, Engine};
    use syndicate_settlement::ops::{
        PythFetchRequest, PythSelectedProof, PythSettlementContext, SettlementJob,
        SignedPricePayload, SolanaMatchContext,
    };
    use syndicate_settlement::{seal_binding_for, settle_match, Outcome, SettleParams};
    use syndicate_shared::{PlayerId, VerifiedOraclePrice};
    use syndicate_timelock::{MockScheme, RoundKey, SealRegistry, TimelockScheme};

    pub fn sample_job() -> SettlementJob {
        SettlementJob {
            match_id: "demo-match".into(),
            idempotency_key: "demo-match:root-1".into(),
            event_root: [4u8; 32],
            chain_context: SolanaMatchContext {
                onchain_match_id: 42,
                seat_wallets: vec![
                    "demo-wallet-0".into(),
                    "demo-wallet-1".into(),
                    "demo-wallet-2".into(),
                ],
                buy_in_chips: 100,
            },
            pyth_context: PythSettlementContext {
                rules: PythFetchRequest {
                    symbol: "BTCUSD".into(),
                    feed_id: [7u8; 32],
                    scheduled_end_ts: 1_000,
                    max_confidence: 50,
                    expected_exponent: -8,
                },
                selected: Some(PythSelectedProof {
                    feed_id_hex: "07".repeat(32),
                    price: "100000".into(),
                    confidence: "10".into(),
                    exponent: -8,
                    publish_time: 1_000,
                    requested_timestamp: 1_000,
                    binary_data_hex: vec!["00".into()],
                    price_update_data: vec!["AA==".into()],
                    hermes_response_hash: "11".repeat(32),
                    binary_update_hash: "22".repeat(32),
                    hermes_url: None,
                }),
                signed_price: Some(SignedPricePayload {
                    token: "0xa7BaE7da3E4950700BE9f107EB186e89a474d180".into(),
                    symbol: "BTCUSD".into(),
                    price_in_wad: "100000".into(),
                    timestamp: 1_000_000,
                    v: 27,
                    r: format!("0x{}", "11".repeat(32)),
                    s: format!("0x{}", "22".repeat(32)),
                    signed_at: Some(1_000_001),
                }),
                signed_price_source_url: Some(
                    "http://127.0.0.1:8080/prices/at?symbol=BTCUSD&timestamp=1000".into(),
                ),
            },
            outcome: sample_outcome(),
        }
    }

    fn sample_outcome() -> Outcome {
        let mut engine = Engine::new(
            vec![
                (PlayerId(0), 100, 0),
                (PlayerId(1), 100, 1),
                (PlayerId(2), 100, 2),
            ],
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

        let oracle_price = VerifiedOraclePrice {
            feed_id: [7u8; 32],
            price: 100_000,
            publish_time: 1_000,
            confidence: 10,
            exponent: -8,
        };

        let scheme = MockScheme;
        let mut reg = SealRegistry::new(42);
        reg.seal(PlayerId(0), scheme.encrypt(100_010, 42)).unwrap();
        reg.seal(PlayerId(1), scheme.encrypt(99_000, 42)).unwrap();
        reg.seal(PlayerId(2), scheme.encrypt(100_500, 42)).unwrap();
        reg.lock();
        let key = RoundKey {
            round: 42,
            key: vec![1],
        };

        let params = SettleParams {
            rake_bps: 0,
            rake_cap: 0,
            dead_money: 0,
        };
        let mut bindings = BTreeMap::new();
        for (id, pred) in [(0u16, 100_010i128), (1, 99_000), (2, 100_500)] {
            let blinding = [(id + 1) as u8; 32];
            bindings.insert(PlayerId(id), seal_binding_for(pred, blinding));
        }
        settle_match(
            &engine,
            Some(oracle_price),
            &reg,
            &scheme,
            Some(&key),
            &params,
            &bindings,
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn worker_settles_finalizes_and_persists() {
        let path =
            std::env::temp_dir().join(format!("synd-worker-test-{}.log", std::process::id()));
        let _ = std::fs::remove_file(&path);

        let (tx, rx) = mpsc::channel::<Job>(8);
        let handle = tokio::spawn(demo_worker_loop(rx, path.clone()));

        let (reply_tx, reply_rx) = oneshot::channel();
        tx.send((demo::sample_job(), reply_tx)).await.unwrap();
        let applied = reply_rx.await.unwrap();
        match applied {
            SettlementProcessResult::Final(record) => {
                assert_eq!(
                    record.status,
                    syndicate_settlement::ops::AttemptStatus::Confirmed
                );
            }
            other => panic!("expected confirmed settlement, got {other:?}"),
        }

        drop(tx);
        handle.await.unwrap();

        let store = FileStore::open(&path).unwrap();
        assert_eq!(store.len(), 1);
        store.verify().unwrap();
        std::fs::remove_file(&path).unwrap();
    }

    #[test]
    fn idempotency_key_format() {
        let root = [1u8; 32];
        assert!(idempotency_key("match-1", &root).contains("match-1:root-"));
    }
}
