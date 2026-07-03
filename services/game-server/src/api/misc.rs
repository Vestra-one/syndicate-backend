//! Health + metrics.

use axum::extract::State;
use axum::Json;
use serde_json::{json, Value};

use crate::app::AppState;
use crate::error::ApiError;

pub async fn healthz(State(st): State<AppState>) -> Result<Json<Value>, ApiError> {
    let db_ok = match st.pool.get().await {
        Ok(client) => client.simple_query("SELECT 1").await.is_ok(),
        Err(_) => false,
    };
    let price_fresh = st.price.is_fresh();
    Ok(Json(json!({
        "ok": db_ok,
        "db": db_ok,
        "price_fresh": price_fresh,
        "server_time_ms": crate::util::now_ms(),
    })))
}

pub async fn metrics(State(st): State<AppState>) -> String {
    let mut out = String::new();
    let active = st.registry.active_count();
    out.push_str("# TYPE game_server_active_matches gauge\n");
    out.push_str(&format!("game_server_active_matches {active}\n"));
    out
}
