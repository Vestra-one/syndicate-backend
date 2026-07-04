//! Match-scoped endpoints: deposit report, candidate status, seal submission, detail,
//! event log.

use axum::extract::{Path, Query, State};
use axum::http::HeaderMap;
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};
use uuid::Uuid;

use crate::app::AppState;
use crate::auth::geofence::{check_enforcement, check_geofence};
use crate::auth::session::require_session;
use crate::config::normalize_room_code;
use crate::db;
use crate::error::ApiError;
use crate::runtime::Cmd;
use crate::util::now_ms;

#[derive(Deserialize)]
pub struct DepositBody {
    pub tx_sig: String,
    #[serde(default)]
    pub room_code: Option<String>,
}

/// `POST /v1/matches/{id}/deposits` — joiner reports the finalized deposit txhash.
pub async fn post_deposit(
    State(st): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
    Json(body): Json<DepositBody>,
) -> Result<Json<Value>, ApiError> {
    check_geofence(&st, &headers)?;
    let wallet = require_session(&st, &headers).await?;
    check_enforcement(&st, &wallet).await?;

    let client = st.pool.get().await?;
    let Some(m) = db::load_match(&client, id).await? else {
        return Err(ApiError::not_found("match not found"));
    };
    if m.status != "filling" {
        return Err(ApiError::conflict(
            "not_filling",
            "match is no longer filling",
        ));
    }
    if m.visibility == "private" {
        let provided = body
            .room_code
            .as_deref()
            .map(normalize_room_code)
            .unwrap_or_default();
        if Some(provided) != m.room_code {
            return Err(ApiError::forbidden(
                "bad_room_code",
                "room code required/invalid",
            ));
        }
    }
    let inserted = client
        .execute(
            r#"INSERT INTO seat_candidates (match_id, wallet, tx_sig)
               VALUES ($1, $2, $3) ON CONFLICT (tx_sig) DO NOTHING"#,
            &[&id, &wallet, &body.tx_sig],
        )
        .await;
    match inserted {
        Ok(_) => {}
        Err(e) if e.to_string().contains("seat_candidates_wallet_active") => {
            return Err(ApiError::conflict(
                "already_joined",
                "wallet already has a live candidacy",
            ));
        }
        Err(e) => return Err(e.into()),
    }
    Ok(Json(json!({
        "v": 1, "server_time_ms": now_ms(),
        "match_id": id, "status": "pending_verify",
    })))
}

/// `GET /v1/matches/{id}/candidates/{wallet}`.
pub async fn get_candidate(
    State(st): State<AppState>,
    Path((id, wallet)): Path<(Uuid, String)>,
) -> Result<Json<Value>, ApiError> {
    let client = st.pool.get().await?;
    let Some(row) = client
        .query_opt(
            r#"SELECT status, seat_index, finalized_slot, reject_reason
               FROM seat_candidates WHERE match_id = $1 AND wallet = $2
               ORDER BY reported_at DESC LIMIT 1"#,
            &[&id, &wallet],
        )
        .await?
    else {
        return Err(ApiError::not_found("no candidacy for this wallet"));
    };
    Ok(Json(json!({
        "v": 1, "server_time_ms": now_ms(),
        "status": row.get::<_, String>("status"),
        "seat_index": row.get::<_, Option<i16>>("seat_index"),
        "finalized_slot": row.get::<_, Option<i64>>("finalized_slot"),
        "reason": row.get::<_, Option<String>>("reject_reason"),
    })))
}

#[derive(Deserialize)]
pub struct SealBody {
    pub ciphertext_b64: String,
    pub commitment_hex: String,
    pub timelock_target: u64,
    pub signature: String,
    #[serde(default)]
    pub seal_tx_sig: Option<String>,
}

/// `POST /v1/matches/{id}/seal` (also reachable via WS).
pub async fn post_seal(
    State(st): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
    Json(body): Json<SealBody>,
) -> Result<Json<Value>, ApiError> {
    let wallet = require_session(&st, &headers).await?;
    submit_seal(&st, id, &wallet, body).await
}

/// Shared by HTTP and the WS `seal` frame.
pub async fn submit_seal(
    st: &AppState,
    id: Uuid,
    wallet: &str,
    body: SealBody,
) -> Result<Json<Value>, ApiError> {
    use base64::Engine as _;
    let client = st.pool.get().await?;
    let Some(m) = db::load_match(&client, id).await? else {
        return Err(ApiError::not_found("match not found"));
    };
    if m.status != "sealing" {
        return Err(ApiError::conflict("not_sealing", "sealing window not open"));
    }
    if let Some(deadline) = m.seal_deadline_ts {
        if chrono::Utc::now() > deadline {
            return Err(ApiError::conflict("seal_closed", "seal window closed"));
        }
    }
    match m.effective_timelock_target() {
        Some(expected) if body.timelock_target == expected => {}
        Some(expected) => {
            return Err(ApiError::conflict(
                "bad_timelock_target",
                format!("expected server timelock_target {expected}"),
            ));
        }
        None => {
            return Err(ApiError::conflict(
                "timelock_target_pending",
                "server timelock target is not ready",
            ));
        }
    }
    let ciphertext = base64::engine::general_purpose::STANDARD
        .decode(&body.ciphertext_b64)
        .map_err(|e| ApiError::bad_request(format!("ciphertext_b64: {e}")))?;
    let commitment: [u8; 32] = hex::decode(&body.commitment_hex)
        .ok()
        .and_then(|v| v.try_into().ok())
        .ok_or_else(|| ApiError::bad_request("commitment_hex must be 32 bytes hex"))?;
    if syndicate_shared::intent::ciphertext_commitment_hash(&ciphertext) != commitment {
        return Err(ApiError::bad_request("commitment != sha256(ciphertext)"));
    }
    // Seat must be confirmed.
    let Some(seat) = client
        .query_opt(
            "SELECT seat_index, sealed FROM match_seats WHERE match_id = $1 AND wallet_address = $2",
            &[&id, &wallet],
        )
        .await?
    else {
        return Err(ApiError::forbidden("not_confirmed", "wallet has no confirmed seat"));
    };
    if seat.get::<_, bool>("sealed") {
        return Err(ApiError::conflict("already_sealed", "seat already sealed"));
    }
    let seat_index: i16 = seat.get("seat_index");

    // Signature over the seal intent (the on-chain register tx is the strong proof; this
    // binds the ciphertext upload to the wallet).
    let seat_pubkey: solana_sdk::pubkey::Pubkey = wallet
        .parse()
        .map_err(|_| ApiError::bad_request("bad wallet"))?;
    let msg = syndicate_shared::intent::prediction_commitment_message(
        m.onchain_match_id,
        m.onchain_match_id,
        seat_index as u16,
        &seat_pubkey.to_bytes(),
        body.timelock_target,
        &commitment,
    );
    syndicate_engine::verify::verify_ed25519(wallet, &msg, &body.signature)
        .map_err(|_| ApiError::unauthorized("invalid seal signature"))?;

    // Record; seal_seq = arrival order among sealers.
    client
        .execute(
            r#"UPDATE match_seats SET
                 sealed = true,
                 prediction_source = 'sealed',
                 seal_ciphertext = $3,
                 seal_commitment = $4,
                 seal_timelock_target = $5,
                 seal_seq = (SELECT count(*) FROM match_seats WHERE match_id = $1 AND sealed)::smallint
               WHERE match_id = $1 AND wallet_address = $2"#,
            &[
                &id,
                &wallet,
                &ciphertext,
                &commitment.as_slice(),
                &(body.timelock_target as i64),
            ],
        )
        .await?;

    // Async on-chain cross-check (finalized SeatAccount.commitment_set + bytes).
    {
        let st = st.clone();
        let wallet = wallet.to_string();
        let onchain = m.onchain_match_id;
        tokio::spawn(async move {
            let (match_pda, _) = syndicate_chain::pda::match_account(&st.program_id, onchain);
            let Ok(pk) = wallet.parse() else { return };
            for _ in 0..20 {
                tokio::time::sleep(std::time::Duration::from_millis(1_500)).await;
                match st.verify.seat_commitment(&match_pda, &pk).await {
                    Ok(Some(onchain_commitment)) => {
                        let ok = onchain_commitment == commitment;
                        if let Ok(client) = st.pool.get().await {
                            let _ = client
                                .execute(
                                    "UPDATE match_seats SET seal_chain_confirmed = $3 WHERE match_id = $1 AND wallet_address = $2",
                                    &[&id, &wallet, &ok],
                                )
                                .await;
                        }
                        return;
                    }
                    Ok(None) => continue,
                    Err(_) => continue,
                }
            }
        });
    }

    let _ = st
        .registry
        .send(
            &id,
            Cmd::Sealed {
                seat_index: seat_index as u8,
            },
        )
        .await;
    Ok(Json(json!({
        "v": 1, "server_time_ms": now_ms(),
        "sealed": true, "seat_index": seat_index,
    })))
}

/// `GET /v1/matches/{id}` — full detail (live view when an actor is running).
pub async fn get_match(
    State(st): State<AppState>,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>, ApiError> {
    if let Some(handle) = st.registry.get(&id) {
        let (tx, rx) = tokio::sync::oneshot::channel();
        if handle.cmd.send(Cmd::Snapshot(tx)).await.is_ok() {
            if let Ok(view) = rx.await {
                return Ok(Json(view));
            }
        }
    }
    let client = st.pool.get().await?;
    let Some(m) = db::load_match(&client, id).await? else {
        return Err(ApiError::not_found("match not found"));
    };
    drop(client);
    Ok(Json(crate::view::match_view(&st, &m, None).await))
}

#[derive(Deserialize)]
pub struct EventsQuery {
    #[serde(default)]
    pub after_seq: u64,
    #[serde(default = "default_limit")]
    pub limit: i64,
}
fn default_limit() -> i64 {
    500
}

/// `GET /v1/matches/{id}/events?after_seq=&limit=` — redacted, with feed-price stamps.
pub async fn get_events(
    State(st): State<AppState>,
    Path(id): Path<Uuid>,
    Query(q): Query<EventsQuery>,
) -> Result<Json<Value>, ApiError> {
    let client = st.pool.get().await?;
    let rows = client
        .query(
            r#"SELECT seq, event_type, payload, hash, feed_price::text AS feed_price,
                      feed_price_expo,
                      CAST(EXTRACT(EPOCH FROM feed_price_ts) * 1000 AS bigint) AS feed_price_ms
               FROM match_events
               WHERE match_id = $1 AND seq > $2
               ORDER BY seq ASC LIMIT $3"#,
            &[&id, &(q.after_seq as i64), &q.limit.clamp(1, 1000)],
        )
        .await?;
    let events: Vec<Value> = rows
        .iter()
        .map(|r| {
            let mut payload: Value = r.get("payload");
            redact_event_payload(&mut payload);
            json!({
                "seq": r.get::<_, i64>("seq"),
                "type": r.get::<_, String>("event_type"),
                "body": payload,
                "hash": hex::encode(r.get::<_, Vec<u8>>("hash")),
                "feed_price": r.get::<_, Option<String>>("feed_price"),
                "feed_price_expo": r.get::<_, Option<i32>>("feed_price_expo"),
                "feed_price_ts": r.get::<_, Option<i64>>("feed_price_ms"),
            })
        })
        .collect();
    Ok(Json(json!({
        "v": 1, "server_time_ms": now_ms(),
        "match_id": id, "events": events,
    })))
}

/// Strip seal ciphertexts (secret until reveal) and raw signatures from public payloads.
pub fn redact_event_payload(payload: &mut Value) {
    if let Some(obj) = payload.as_object_mut() {
        obj.remove("ciphertext");
        obj.remove("ciphertext_b64");
        obj.remove("blinding");
        if let Some(commitment) = obj.get_mut("commitment") {
            if commitment.is_object() {
                *commitment = json!("sealed");
            }
        }
        for v in obj.values_mut() {
            redact_event_payload(v);
        }
    } else if let Some(arr) = payload.as_array_mut() {
        for v in arr {
            redact_event_payload(v);
        }
    }
}
