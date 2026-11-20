//! Shared application state + the axum router.

use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, RwLock};

use axum::routing::{get, post, put};
use axum::Router;
use deadpool_postgres::Pool;
use solana_sdk::pubkey::Pubkey;

use crate::auth::rate_limit::RateLimits;
use crate::auth::session::NonceStore;
use crate::config::{Overlay, ServerConfig};
use crate::price::PriceCache;
use crate::runtime::Registry;
use crate::verifier::ChainVerify;

#[derive(Clone)]
pub struct AppState {
    pub cfg: Arc<ServerConfig>,
    pub pool: Pool,
    pub nonces: Arc<NonceStore>,
    pub limits: Arc<RateLimits>,
    pub overlay: Arc<RwLock<Overlay>>,
    pub price: Arc<PriceCache>,
    pub registry: Registry,
    pub verify: Arc<dyn ChainVerify>,
    pub program_id: Pubkey,
    /// The match store used for gameplay event appends (fencing).
    pub store: Arc<syndicate_engine::persistence::PostgresMatchStore>,
    /// Live spectator counts per match (in-memory, advisory — resets on restart).
    pub watchers: Watchers,
}

/// Per-match live watcher counts, tracked via an RAII guard so every unsubscribe path
/// (explicit unsubscribe, re-subscribe replace, connection teardown, forwarder exit)
/// decrements through one mechanism: dropping the guard.
#[derive(Clone, Default)]
pub struct Watchers(Arc<dashmap::DashMap<uuid::Uuid, Arc<AtomicI64>>>);

impl Watchers {
    pub fn inc(&self, id: uuid::Uuid) -> WatcherGuard {
        let counter = self.0.entry(id).or_default().clone();
        counter.fetch_add(1, Ordering::Relaxed);
        WatcherGuard { counter }
    }

    pub fn count(&self, id: &uuid::Uuid) -> i64 {
        self.0
            .get(id)
            .map(|c| c.load(Ordering::Relaxed).max(0))
            .unwrap_or(0)
    }
}

pub struct WatcherGuard {
    counter: Arc<AtomicI64>,
}

impl Drop for WatcherGuard {
    fn drop(&mut self) {
        self.counter.fetch_sub(1, Ordering::Relaxed);
    }
}

pub fn router(state: AppState) -> Router {
    let cors = cors_layer(&state.cfg.cors_allowed_origins);
    Router::new()
        // health / metrics
        .route("/healthz", get(crate::api::misc::healthz))
        .route("/metrics", get(crate::api::misc::metrics))
        // auth
        .route("/v1/auth/nonce", post(crate::auth::session::post_nonce))
        .route("/v1/auth/verify", post(crate::auth::session::post_verify))
        // config + rooms
        .route("/v1/config", get(crate::api::rooms::get_config))
        .route("/v1/rooms/intents", post(crate::api::rooms::post_intent))
        .route("/v1/rooms", post(crate::api::rooms::post_room))
        .route(
            "/v1/rooms/code/{code}",
            get(crate::api::rooms::get_room_code),
        )
        // matches
        .route(
            "/v1/matches/{id}/deposits",
            post(crate::api::matches::post_deposit),
        )
        .route(
            "/v1/matches/{id}/candidates/{wallet}",
            get(crate::api::matches::get_candidate),
        )
        .route(
            "/v1/matches/{id}/seal",
            post(crate::api::matches::post_seal),
        )
        .route(
            "/v1/matches/{id}/session-key",
            post(crate::api::matches::post_session_key),
        )
        .route("/v1/matches/{id}", get(crate::api::matches::get_match))
        .route(
            "/v1/matches/{id}/events",
            get(crate::api::matches::get_events),
        )
        // lists
        .route("/v1/lobby", get(crate::api::lists::get_lobby))
        .route("/v1/matches/live", get(crate::api::lists::get_live))
        .route("/v1/matches/history", get(crate::api::lists::get_history))
        .route(
            "/v1/wallets/{wallet}/active",
            get(crate::api::lists::get_active),
        )
        .route(
            "/v1/wallets/{wallet}/matches",
            get(crate::api::lists::get_wallet_matches),
        )
        .route(
            "/v1/wallets/{wallet}/claimables",
            get(crate::api::lists::get_claimables),
        )
        // leaderboard + profiles
        .route("/v1/leaderboard", get(crate::api::profiles::get_leaderboard))
        .route("/v1/profiles/me", put(crate::api::profiles::put_profile_me))
        .route("/v1/faucet", post(crate::api::faucet::post_faucet))
        .route("/v1/faucet/fees", post(crate::api::faucet::post_fees))
        .route("/v1/fibs", post(crate::api::fibs::post_fibs))
        .route("/v1/fibs/board", get(crate::api::fibs::get_board))
        .route("/v1/profiles/{wallet}", get(crate::api::profiles::get_profile))
        // admin
        .route(
            "/v1/admin/config",
            get(crate::api::admin::get_config).put(crate::api::admin::put_config),
        )
        .route(
            "/v1/admin/matches/{id}/void",
            post(crate::api::admin::post_void),
        )
        // websocket
        .route("/v1/ws", get(crate::ws::upgrade))
        .layer(cors)
        .with_state(state)
}

fn cors_layer(origins: &[String]) -> tower_http::cors::CorsLayer {
    use tower_http::cors::{AllowOrigin, Any, CorsLayer};
    let layer = CorsLayer::new().allow_methods(Any).allow_headers(Any);
    if origins.iter().any(|o| o == "*") {
        layer.allow_origin(Any)
    } else {
        let parsed: Vec<_> = origins
            .iter()
            .filter_map(|o| o.parse::<axum::http::HeaderValue>().ok())
            .collect();
        layer.allow_origin(AllowOrigin::list(parsed))
    }
}
