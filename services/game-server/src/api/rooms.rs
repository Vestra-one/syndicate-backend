//! Config + create-room flow: intents (reservation + CreateParams for the FE), the
//! create-report, and private room-code validation.

use axum::extract::{Path, State};
use axum::http::HeaderMap;
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};
use uuid::Uuid;

use crate::app::AppState;
use crate::auth::geofence::{check_enforcement, check_geofence};
use crate::auth::rate_limit::check_active_room_cap;
use crate::auth::session::{client_ip, require_session};
use crate::config::{
    self, canonical_config_json, config_hash, derive_blinds, generate_room_code,
    normalize_room_code, CanonicalConfig,
};
use crate::error::ApiError;
use crate::util::{now_ms, now_sec, ts_ms};

/// `GET /v1/config` — everything the FE needs to render the create form + build txs.
pub async fn get_config(State(st): State<AppState>) -> Json<Value> {
    let overlay = st.overlay.read().expect("overlay").clone();
    let b = &overlay.bounds;
    Json(json!({
        "v": 1, "server_time_ms": now_ms(),
        "program_id": st.cfg.program_id,
        // Default chip token + the full allowlist. The create form must restrict the token
        // picker to `chips_token_mints`; the backend re-enforces it at create.
        "chips_token_mint": st.cfg.chips_token_mint,
        "chips_token_mints": st.cfg.chips_token_mints,
        // Clients may delegate gameplay signatures to a per-match session key
        // (POST /v1/matches/{id}/session-key).
        "session_keys": true,
        // House bots keep a public table open; clients label these wallets as bots.
        "house_bot_wallets": st.cfg.house_bot_wallets,
        "feeds": config::FEEDS.iter().map(|(feed, sym, token)| json!({
            "feed": feed, "oracle_symbol": sym, "oracle_token": token,
        })).collect::<Vec<_>>(),
        "bounds": {
            "buy_in": { "min": b.buy_in_min, "max": b.buy_in_max },
            "fill_window_sec": { "min": b.fill_window_min_sec, "max": b.fill_window_max_sec },
            "streets": { "min": b.streets_min, "max": b.streets_max },
            "street_duration_sec": { "min": b.street_duration_min_sec, "max": b.street_duration_max_sec },
            "observation_sec": { "min": b.observation_min_sec, "max": b.observation_max_sec },
            "players": { "min": b.players_min, "max": b.players_max },
        },
        "defaults": {
            "seal_window_sec": overlay.seal_window_sec,
            "begin_live_window_sec": overlay.begin_live_window_sec,
            "action_timeout_ms": overlay.action_timeout_ms,
            "time_bank_sec": overlay.time_bank_sec,
            "rake_bps": overlay.rake_bps,
            "entry_fee": overlay.entry_fee,
        },
        "drand": {
            "api": st.cfg.drand_api,
            "chain_hash": st.cfg.drand_chain_hash,
            "genesis_time": syndicate_chain::DRAND_GENESIS_TIME,
            "period_sec": syndicate_chain::DRAND_PERIOD_SEC,
            "scheme": config::DRAND_SCHEME,
        },
    }))
}

#[derive(Deserialize)]
pub struct StreetsBody {
    pub count: u8,
    pub durations_sec: Vec<u64>,
    #[serde(default)]
    pub observation_sec: Vec<u64>,
}

#[derive(Deserialize)]
pub struct IntentBody {
    pub feed: String,
    pub buy_in: u64,
    pub fill_window_sec: u64,
    pub min_players: u8,
    pub max_players: u8,
    pub streets: StreetsBody,
    pub visibility: String,
    /// Chip token for this match. Must be one of the operator allowlist
    /// (`GET /v1/config.chips_token_mints`). Defaults to the primary mint when omitted.
    #[serde(default)]
    pub chips_token_mint: Option<String>,
}

/// `POST /v1/rooms/intents` — validate, reserve an onchain_match_id, hand back everything
/// needed to build `create_and_deposit`.
pub async fn post_intent(
    State(st): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<IntentBody>,
) -> Result<Json<Value>, ApiError> {
    st.limits.check_intents(&client_ip(&headers))?;
    check_geofence(&st, &headers)?;
    let wallet = require_session(&st, &headers).await?;
    check_enforcement(&st, &wallet).await?;
    check_active_room_cap(&st.pool, &wallet).await?;

    let overlay = st.overlay.read().expect("overlay").clone();
    let b = &overlay.bounds;

    // ---- validation against bounds ---------------------------------------------------
    if config::feed_oracle_symbol(&body.feed).is_none() {
        return Err(ApiError::bad_request(format!("unknown feed {}", body.feed)));
    }
    if body.buy_in < b.buy_in_min || body.buy_in > b.buy_in_max {
        return Err(ApiError::bad_request("buy_in out of bounds"));
    }
    if body.fill_window_sec < b.fill_window_min_sec || body.fill_window_sec > b.fill_window_max_sec
    {
        return Err(ApiError::bad_request("fill_window_sec out of bounds"));
    }
    if body.min_players < b.players_min
        || body.max_players > b.players_max
        || body.min_players > body.max_players
    {
        return Err(ApiError::bad_request("player counts out of bounds"));
    }
    let n = body.streets.count as usize;
    if body.streets.count < b.streets_min
        || body.streets.count > b.streets_max
        || body.streets.durations_sec.len() != n
        || (!body.streets.observation_sec.is_empty() && body.streets.observation_sec.len() != n)
    {
        return Err(ApiError::bad_request("streets shape invalid"));
    }
    let observation: Vec<u64> = if body.streets.observation_sec.is_empty() {
        vec![0; n]
    } else {
        body.streets.observation_sec.clone()
    };
    for d in &body.streets.durations_sec {
        if *d < b.street_duration_min_sec || *d > b.street_duration_max_sec {
            return Err(ApiError::bad_request("street duration out of bounds"));
        }
    }
    for o in &observation {
        if *o > b.observation_max_sec {
            return Err(ApiError::bad_request("observation window out of bounds"));
        }
    }
    let visibility = match body.visibility.as_str() {
        "public" | "private" => body.visibility.clone(),
        _ => return Err(ApiError::bad_request("visibility must be public|private")),
    };
    // Chip token: caller-chosen but must be on the operator allowlist; default to primary.
    let chips_token_mint = match &body.chips_token_mint {
        Some(m) if st.cfg.is_mint_allowed(m) => m.clone(),
        Some(m) => {
            return Err(ApiError::bad_request(format!(
                "chip token {m} is not in the allowed list"
            )))
        }
        None => {
            if st.cfg.chips_token_mint.is_empty() {
                return Err(ApiError::internal("no chip token configured"));
            }
            st.cfg.chips_token_mint.clone()
        }
    };

    // ---- derived params ----------------------------------------------------------------
    let (small_blind, big_blind) = derive_blinds(body.buy_in);
    let rake_cap = config::default_rake_cap(body.buy_in);
    let total_betting: u64 =
        body.streets.durations_sec.iter().sum::<u64>() + observation.iter().sum::<u64>();
    let canonical = CanonicalConfig {
        feed_symbol: body.feed.clone(),
        buy_in: body.buy_in,
        entry_fee: overlay.entry_fee,
        rake_bps: overlay.rake_bps,
        rake_cap,
        min_players: body.min_players,
        max_players: body.max_players,
        streets: body
            .streets
            .durations_sec
            .iter()
            .copied()
            .zip(observation.iter().copied())
            .collect(),
        seal_window_sec: overlay.seal_window_sec,
        begin_live_window_sec: overlay.begin_live_window_sec,
        fill_window_sec: body.fill_window_sec,
        action_timeout_ms: overlay.action_timeout_ms,
        time_bank_sec: overlay.time_bank_sec,
        small_blind,
        big_blind,
        visibility: visibility.clone(),
    };
    let hash = config_hash(&canonical);

    let room_code = if visibility == "private" {
        Some(generate_room_code())
    } else {
        None
    };
    let creator_pk: solana_sdk::pubkey::Pubkey = wallet
        .parse()
        .map_err(|_| ApiError::bad_request("bad wallet"))?;
    let room_commitment = match &room_code {
        Some(code) => syndicate_chain::room_commitment(code, &creator_pk),
        None => [0u8; 32],
    };

    // ---- reservation ---------------------------------------------------------------------
    let client = st.pool.get().await?;
    let onchain: i64 = client
        .query_one("SELECT nextval('onchain_match_id_seq') AS id", &[])
        .await?
        .get("id");
    let expires_at = chrono::Utc::now() + chrono::Duration::seconds(overlay.intent_ttl_sec as i64);
    let params_json = json!({
        "feed": body.feed,
        "buy_in": body.buy_in,
        "entry_fee": overlay.entry_fee,
        "rake_bps": overlay.rake_bps,
        "rake_cap": rake_cap,
        "min_players": body.min_players,
        "max_players": body.max_players,
        "durations_sec": body.streets.durations_sec,
        "observation_sec": observation,
        "seal_window_sec": overlay.seal_window_sec,
        "begin_live_window_sec": overlay.begin_live_window_sec,
        "fill_window_sec": body.fill_window_sec,
        "action_timeout_ms": overlay.action_timeout_ms,
        "time_bank_sec": overlay.time_bank_sec,
        "small_blind": small_blind,
        "big_blind": big_blind,
        "chips_token_mint": chips_token_mint,
        "config_hash": hex::encode(hash),
        "canonical_json": canonical_config_json(&canonical),
    });
    let intent_id: Uuid = client
        .query_one(
            r#"INSERT INTO match_intents (onchain_match_id, creator_wallet, params, room_code, visibility, expires_at)
               VALUES ($1, $2, $3, $4, $5, $6) RETURNING id"#,
            &[&onchain, &wallet, &params_json, &room_code, &visibility, &expires_at],
        )
        .await?
        .get("id");

    let (match_pda, _) = syndicate_chain::pda::match_account(&st.program_id, onchain as u64);
    let price_token = config::feed_token_bytes(&body.feed)
        .ok_or_else(|| ApiError::bad_request("feed token missing"))?;

    // Timelock target hint (exact value re-pushed after lock lands).
    let projected_end = now_sec()
        + body.fill_window_sec
        + overlay.seal_window_sec
        + total_betting
        + overlay.begin_live_window_sec;
    let timelock_hint = config::timelock_target_round(projected_end);

    Ok(Json(json!({
        "v": 1, "server_time_ms": now_ms(),
        "intent_id": intent_id,
        "onchain_match_id": onchain as u64,
        "match_pda": match_pda.to_string(),
        // The FE must pass this exact SPL mint as the `mint` account of create_and_deposit.
        "chips_token_mint": chips_token_mint,
        "room_code": room_code,
        "room_commitment": hex::encode(room_commitment),
        "config_hash": hex::encode(hash),
        "timelock_target_hint": timelock_hint,
        "expires_at": ts_ms(expires_at),
        "create_params": {
            "match_id": onchain as u64,
            "buy_in": body.buy_in,
            "entry_fee": overlay.entry_fee,
            "rake_bps": overlay.rake_bps,
            "rake_cap": rake_cap,
            "min_players": body.min_players,
            "max_players": body.max_players,
            "is_private": visibility == "private",
            "room_commitment": hex::encode(room_commitment),
            "config_hash": hex::encode(hash),
            "price_token": hex::encode(price_token),
            "total_betting_duration_sec": total_betting,
            "seal_window_sec": overlay.seal_window_sec,
            "begin_live_window_sec": overlay.begin_live_window_sec,
            "fill_window_sec": body.fill_window_sec,
            "max_oracle_confidence": u64::MAX,
            "oracle_exponent": config::DEFAULT_ORACLE_EXPONENT,
        },
        "derived": {
            "small_blind": small_blind, "big_blind": big_blind,
            "total_betting_duration_sec": total_betting,
        },
    })))
}

#[derive(Deserialize)]
pub struct RoomBody {
    pub intent_id: Uuid,
    pub tx_sig: String,
}

/// `POST /v1/rooms` — the creator reports the finalized create_and_deposit txhash.
pub async fn post_room(
    State(st): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<RoomBody>,
) -> Result<Json<Value>, ApiError> {
    let wallet = require_session(&st, &headers).await?;
    let client = st.pool.get().await?;

    let Some(intent) = client
        .query_opt(
            "SELECT * FROM match_intents WHERE id = $1 AND creator_wallet = $2",
            &[&body.intent_id, &wallet],
        )
        .await?
    else {
        return Err(ApiError::not_found("intent not found for this wallet"));
    };
    let consumed: Option<chrono::DateTime<chrono::Utc>> = intent.get("consumed_at");
    let onchain: i64 = intent.get("onchain_match_id");
    if let Some(_prior) = consumed {
        // Idempotent replay: return the existing match.
        if let Some(existing) = client
            .query_opt(
                "SELECT id FROM matches WHERE onchain_match_id = $1",
                &[&onchain],
            )
            .await?
        {
            let match_id: Uuid = existing.get("id");
            return Ok(Json(json!({
                "v": 1, "match_id": match_id, "seat_status": "pending_verify",
                "replayed": true,
            })));
        }
    }
    let expires: chrono::DateTime<chrono::Utc> = intent.get("expires_at");
    if expires < chrono::Utc::now() {
        return Err(ApiError::new(
            axum::http::StatusCode::GONE,
            "intent_expired",
            "create intent expired; request a new one",
        ));
    }
    let params: Value = intent.get("params");
    let room_code: Option<String> = intent.get("room_code");
    let visibility: String = intent.get("visibility");

    // Insert the match row (status filling) + creator candidacy; verification is async.
    let g = |k: &str| params.get(k).cloned().unwrap_or(Value::Null);
    let durations: Vec<i32> = g("durations_sec")
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|v| v.as_u64())
                .map(|v| v as i32)
                .collect()
        })
        .unwrap_or_default();
    let observations: Vec<i32> = g("observation_sec")
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|v| v.as_u64())
                .map(|v| v as i32)
                .collect()
        })
        .unwrap_or_default();
    let feed: String = params
        .get("feed")
        .and_then(Value::as_str)
        .unwrap_or("BTC/USD")
        .to_string();
    let hash_bytes: Vec<u8> = g("config_hash")
        .as_str()
        .and_then(|h| hex::decode(h).ok())
        .ok_or_else(|| ApiError::internal("intent missing config_hash"))?;
    let fill_window = g("fill_window_sec").as_u64().unwrap_or(300);
    let fill_deadline = chrono::Utc::now() + chrono::Duration::seconds(fill_window as i64);
    let chips_token_mint: Option<String> = g("chips_token_mint")
        .as_str()
        .map(|s| s.to_string())
        .filter(|s| !s.is_empty());
    let creator_room_commitment = room_code.as_ref().map(|code| {
        let pk: solana_sdk::pubkey::Pubkey = wallet.parse().expect("validated wallet");
        syndicate_chain::room_commitment(code, &pk).to_vec()
    });

    let row = client
        .query_opt(
            db::INSERT_MATCH_V2_SQL,
            &[
                &format!("match-{onchain}"),
                &onchain,
                &visibility,
                &wallet,
                &room_code,
                &creator_room_commitment,
                &feed,
                &hash_bytes,
                &(g("buy_in").as_u64().unwrap_or(0) as i64),
                &(g("entry_fee").as_u64().unwrap_or(0) as i64),
                &(g("rake_bps").as_u64().unwrap_or(0) as i32),
                &(g("rake_cap").as_u64().unwrap_or(0) as i64),
                &(durations.len() as i16),
                &durations,
                &observations,
                &(g("action_timeout_ms").as_u64().unwrap_or(25_000) as i32),
                &(g("time_bank_sec").as_u64().unwrap_or(60) as i32),
                &(g("small_blind").as_u64().unwrap_or(1) as i64),
                &(g("big_blind").as_u64().unwrap_or(2) as i64),
                &(g("min_players").as_u64().unwrap_or(2) as i16),
                &(g("max_players").as_u64().unwrap_or(5) as i16),
                &(g("seal_window_sec")
                    .as_u64()
                    .unwrap_or(config::DEFAULT_SEAL_WINDOW_SEC) as i32),
                &(g("begin_live_window_sec").as_u64().unwrap_or(30) as i32),
                &fill_deadline,
                &Option::<i64>::None,
                &chips_token_mint,
            ],
        )
        .await?;
    let match_id: Uuid = match row {
        Some(r) => r.get("id"),
        None => {
            // Conflict on onchain_match_id — already created (idempotent).
            client
                .query_one(
                    "SELECT id FROM matches WHERE onchain_match_id = $1",
                    &[&onchain],
                )
                .await?
                .get("id")
        }
    };

    // Creator candidacy (verified against create_and_deposit).
    client
        .execute(
            r#"INSERT INTO seat_candidates (match_id, wallet, tx_sig)
               VALUES ($1, $2, $3) ON CONFLICT (tx_sig) DO NOTHING"#,
            &[&match_id, &wallet, &body.tx_sig],
        )
        .await?;
    client
        .execute(
            "UPDATE match_intents SET consumed_at = now() WHERE id = $1",
            &[&body.intent_id],
        )
        .await?;

    // Spawn the actor (drives the fill deadline from here on).
    if let Some(row) = db::load_match(&client, match_id).await? {
        st.registry.spawn(&st, row);
    }

    Ok(Json(json!({
        "v": 1, "server_time_ms": now_ms(),
        "match_id": match_id,
        "onchain_match_id": onchain as u64,
        "seat_status": "pending_verify",
    })))
}

/// `GET /v1/rooms/code/{code}` — validate a private room code for the caller.
pub async fn get_room_code(
    State(st): State<AppState>,
    headers: HeaderMap,
    Path(code): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let wallet = require_session(&st, &headers).await?;
    let code = normalize_room_code(&code);
    let client = st.pool.get().await?;
    let Some(row) = client
        .query_opt(
            &format!(
                "SELECT {} FROM matches m WHERE m.room_code = $1 AND m.status = 'filling'",
                db::MATCH_COLUMNS
            ),
            &[&code],
        )
        .await?
    else {
        return Err(ApiError::not_found("unknown or expired room code"));
    };
    let m = db::MatchRow::from_row(&row)?;
    let pk: solana_sdk::pubkey::Pubkey = wallet
        .parse()
        .map_err(|_| ApiError::bad_request("bad wallet"))?;
    let join_commitment = syndicate_chain::room_commitment(&code, &pk);
    let counts = client
        .query_one(
            r#"SELECT
                 count(*) FILTER (WHERE status = 'confirmed') AS confirmed,
                 count(*) FILTER (WHERE status IN ('reported','candidate')) AS candidates
               FROM seat_candidates WHERE match_id = $1"#,
            &[&m.id],
        )
        .await?;
    Ok(Json(json!({
        "v": 1, "server_time_ms": now_ms(),
        "match_id": m.id,
        "onchain_match_id": m.onchain_match_id,
        "match_pda": syndicate_chain::pda::match_account(&st.program_id, m.onchain_match_id).0.to_string(),
        "feed": m.feed_symbol,
        "buy_in": m.buy_in,
        "chips_token_mint": m.mint,
        "min_players": m.min_players,
        "max_players": m.max_players,
        "seats_confirmed": counts.get::<_, i64>("confirmed"),
        "candidates": counts.get::<_, i64>("candidates"),
        "fill_deadline": m.fill_deadline_ts.map(ts_ms),
        "join_commitment": hex::encode(join_commitment),
    })))
}

use crate::db;
