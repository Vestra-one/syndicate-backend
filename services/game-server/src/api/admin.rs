//! Admin API: runtime-config knobs (seal window etc.) + emergency void.

use axum::extract::{Path, State};
use axum::http::HeaderMap;
use axum::Json;
use serde_json::{json, Value};
use uuid::Uuid;

use crate::app::AppState;
use crate::auth::session::require_admin;
use crate::config::Overlay;
use crate::db;
use crate::error::ApiError;
use crate::util::now_ms;

/// `GET /v1/admin/config`.
pub async fn get_config(
    State(st): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    require_admin(&st, &headers)?;
    let overlay = st.overlay.read().expect("overlay").clone();
    Ok(Json(json!({
        "v": 1, "server_time_ms": now_ms(),
        "overlay": serde_json::to_value(&overlay).map_err(ApiError::internal)?,
    })))
}

/// `PUT /v1/admin/config` — merge a partial overlay, persist to runtime_config.
pub async fn put_config(
    State(st): State<AppState>,
    headers: HeaderMap,
    Json(patch): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    require_admin(&st, &headers)?;
    let current = st.overlay.read().expect("overlay").clone();
    let mut merged = serde_json::to_value(&current).map_err(ApiError::internal)?;
    merge(&mut merged, &patch);
    let new_overlay: Overlay = serde_json::from_value(merged.clone())
        .map_err(|e| ApiError::bad_request(format!("invalid overlay: {e}")))?;

    let client = st.pool.get().await?;
    client
        .execute(
            r#"INSERT INTO runtime_config (key, value, updated_by)
               VALUES ('game_server', $1, 'admin')
               ON CONFLICT (key) DO UPDATE SET value = $1, updated_by = 'admin', updated_at = now()"#,
            &[&merged],
        )
        .await?;
    *st.overlay.write().expect("overlay") = new_overlay;
    Ok(Json(json!({ "v": 1, "applied": merged })))
}

fn merge(base: &mut Value, patch: &Value) {
    match (base, patch) {
        (Value::Object(base), Value::Object(patch)) => {
            for (k, v) in patch {
                match base.get_mut(k) {
                    Some(slot) => merge(slot, v),
                    None => {
                        base.insert(k.clone(), v.clone());
                    }
                }
            }
        }
        (base, patch) => *base = patch.clone(),
    }
}

/// `POST /v1/admin/matches/{id}/void` — enqueue an operator emergency void.
pub async fn post_void(
    State(st): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>, ApiError> {
    require_admin(&st, &headers)?;
    let client = st.pool.get().await?;
    client
        .execute(
            db::ENQUEUE_CHAIN_JOB_SQL,
            &[
                &id,
                &"void",
                &format!("{id}:void"),
                &json!({}),
                &Option::<chrono::DateTime<chrono::Utc>>::None,
            ],
        )
        .await?;
    Ok(Json(json!({ "v": 1, "enqueued": "void", "match_id": id })))
}
