//! syndicate-game-server entrypoint.

use std::sync::{Arc, RwLock};

use tracing::{info, warn};

use syndicate_game_server::app::{router, AppState};
use syndicate_game_server::auth::rate_limit::RateLimits;
use syndicate_game_server::auth::session::NonceStore;
use syndicate_game_server::config::{validate_overlay, Overlay, ServerConfig};
use syndicate_game_server::price::PriceCache;
use syndicate_game_server::runtime::Registry;
use syndicate_game_server::{chainjobs, sweeper, verifier};

#[tokio::main(flavor = "multi_thread")]
async fn main() {
    init_tracing();
    let cfg = match ServerConfig::from_env() {
        Ok(cfg) => Arc::new(cfg),
        Err(e) => {
            eprintln!("config error: {e}");
            std::process::exit(2);
        }
    };
    info!(port = cfg.port, program_id = %cfg.program_id, "game-server starting");

    // ---- infrastructure ---------------------------------------------------------------
    let store = match syndicate_engine::persistence::PostgresMatchStore::from_url(
        &cfg.database_url,
        cfg.node_id.clone(),
    ) {
        Ok(s) => Arc::new(s),
        Err(e) => {
            eprintln!("db pool: {e:?}");
            std::process::exit(2);
        }
    };
    let pool = store.pool().clone();
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

    let program_id: solana_sdk::pubkey::Pubkey = match cfg.program_id.parse() {
        Ok(p) => p,
        Err(e) => {
            eprintln!("bad SYNDICATE_PROGRAM_ID: {e}");
            std::process::exit(2);
        }
    };

    // runtime_config overlay
    let overlay = load_overlay(&pool).await.unwrap_or_default();
    let price = Arc::new(PriceCache::new(cfg.signed_price_server_url.clone()));

    let state = AppState {
        cfg: cfg.clone(),
        pool,
        nonces: Arc::new(NonceStore::default()),
        limits: Arc::new(RateLimits::new()),
        overlay: Arc::new(RwLock::new(overlay)),
        price: price.clone(),
        registry: Registry::default(),
        verify: verifier::rpc_verifier(&cfg.rpc_url, program_id),
        program_id,
        store,
    };

    // ---- background tasks ----------------------------------------------------------------
    tokio::spawn(price.run());
    tokio::spawn(verifier::run(state.clone()));
    tokio::spawn(chainjobs::run(state.clone()));
    tokio::spawn(sweeper::run(state.clone()));
    match sweeper::recover_all(&state).await {
        Ok(n) => info!(matches = n, "recovered non-terminal matches"),
        Err(e) => warn!("recovery scan failed: {e}"),
    }

    // ---- serve ------------------------------------------------------------------------------
    let addr = format!("0.0.0.0:{}", cfg.port);
    let listener = tokio::net::TcpListener::bind(&addr)
        .await
        .unwrap_or_else(|e| {
            eprintln!("bind {addr}: {e}");
            std::process::exit(2);
        });
    info!(%addr, "listening");
    axum::serve(listener, router(state))
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
            info!("shutdown signal");
        })
        .await
        .expect("server error");
}

async fn load_overlay(pool: &deadpool_postgres::Pool) -> Option<Overlay> {
    let client = pool.get().await.ok()?;
    let row = client
        .query_opt(
            "SELECT value FROM runtime_config WHERE key = 'game_server'",
            &[],
        )
        .await
        .ok()??;
    let overlay: Overlay = serde_json::from_value(row.get::<_, serde_json::Value>("value")).ok()?;
    validate_overlay(&overlay).ok()?;
    Some(overlay)
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
