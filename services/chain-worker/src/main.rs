//! syndicate-chain-worker entrypoint: preflight, then the ops server + job loop.

use std::sync::Arc;

use solana_sdk::signature::Signer;
use tracing::{info, warn};

use syndicate_chain_worker::config::WorkerConfig;
use syndicate_chain_worker::db;
use syndicate_chain_worker::executor::Executor;
use syndicate_chain_worker::http::OpsServer;
use syndicate_chain_worker::jobs;
use syndicate_chain_worker::metrics::WorkerMetrics;
use syndicate_chain_worker::oracle::SignedPriceClient;
use syndicate_chain_worker::rpc::{ChainRpc, FailoverRpc};
use syndicate_chain_worker::timelock_open::TimelockOpenBackend;

#[tokio::main(flavor = "multi_thread")]
async fn main() {
    init_tracing();
    let cfg = match WorkerConfig::from_env() {
        Ok(cfg) => cfg,
        Err(e) => {
            eprintln!("config error: {e}");
            std::process::exit(2);
        }
    };

    // ---- preflight ------------------------------------------------------------------
    let keypair = match solana_sdk::signature::read_keypair_file(&cfg.operator_keypair_path) {
        Ok(kp) => Arc::new(kp),
        Err(e) => {
            eprintln!("read operator keypair {}: {e}", cfg.operator_keypair_path);
            std::process::exit(2);
        }
    };
    let signer = keypair.pubkey();
    info!(%signer, program_id = %cfg.program_id, app_env = %cfg.app_env, "chain-worker starting");

    let pool = match db::connect_pool(&cfg.database_url) {
        Ok(p) => p,
        Err(e) => {
            eprintln!("db pool: {e}");
            std::process::exit(2);
        }
    };
    match pool.get().await {
        Ok(client) => {
            if let Err(e) = client.simple_query("SELECT 1").await {
                eprintln!("db preflight: {e}");
                std::process::exit(2);
            }
        }
        Err(e) => {
            eprintln!("db connect: {e}");
            std::process::exit(2);
        }
    }

    let rpc: Arc<dyn ChainRpc> = Arc::new(FailoverRpc::new(
        &cfg.rpc_primary,
        cfg.rpc_secondary.as_deref(),
    ));
    match rpc.balance(&signer).await {
        Ok(lamports) if lamports < cfg.min_signer_lamports => {
            warn!(
                lamports,
                min = cfg.min_signer_lamports,
                "operator balance below MIN_SIGNER_SOL — top up soon"
            );
        }
        Ok(lamports) => info!(lamports, "operator balance ok"),
        Err(e) => warn!("rpc preflight failed (continuing): {e}"),
    }

    let metrics = Arc::new(WorkerMetrics::default());
    let oracle = SignedPriceClient::new(cfg.signed_price_server_url.clone());
    {
        let oracle = oracle.clone();
        let ok = tokio::task::spawn_blocking(move || oracle.health())
            .await
            .unwrap_or(false);
        if !ok {
            warn!("signed-price-server /health not reachable (continuing)");
        }
    }

    let executor = Arc::new(Executor {
        cfg: cfg.clone(),
        pool: pool.clone(),
        rpc: rpc.clone(),
        keypair,
        metrics: metrics.clone(),
        oracle,
        timelock: tokio::sync::Mutex::new(Box::new(TimelockOpenBackend::from_env())),
    });

    let ops = Arc::new(OpsServer {
        cfg: cfg.clone(),
        metrics,
        rpc,
        signer,
        pool,
    });

    tokio::select! {
        _ = ops.run() => {},
        _ = jobs::run(executor) => {},
        _ = tokio::signal::ctrl_c() => {
            info!("shutdown signal received");
        }
    }
}

fn init_tracing() {
    let filter = tracing_subscriber::EnvFilter::try_from_env("LOG_LEVEL")
        .or_else(|_| tracing_subscriber::EnvFilter::try_new("info"))
        .unwrap();
    if std::env::var("LOG_FORMAT").as_deref() == Ok("json") {
        tracing_subscriber::fmt()
            .with_env_filter(filter)
            .json()
            .init();
    } else {
        tracing_subscriber::fmt().with_env_filter(filter).init();
    }
}
