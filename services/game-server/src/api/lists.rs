//! List endpoints: public lobby, live (spectate), history, wallet session-restore,
//! wallet history, claimables.

use axum::extract::{Path, Query, State};
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::app::AppState;
use crate::db;
use crate::error::ApiError;
use crate::runtime::Cmd;
use crate::util::{now_ms, ts_ms};

#[derive(Deserialize)]
pub struct PageQuery {
    #[serde(default)]
    pub cursor: Option<String>,
    #[serde(default = "default_limit")]
    pub limit: i64,
    #[serde(default)]
    pub feed: Option<String>,
    #[serde(default)]
    pub buy_in_min: Option<i64>,
    #[serde(default)]
    pub buy_in_max: Option<i64>,
}
fn default_limit() -> i64 {
    50
}

fn lobby_row(r: &tokio_postgres::Row) -> Value {
    json!({
        "match_id": r.get::<_, uuid::Uuid>("id"),
        "onchain_match_id": r.get::<_, i64>("onchain_match_id") as u64,
        "phase": r.get::<_, String>("status"),
        "feed": r.get::<_, Option<String>>("feed_symbol"),
        "buy_in": r.get::<_, Option<i64>>("buy_in_chips").unwrap_or(0),
        "chips_token_mint": r.get::<_, Option<String>>("mint"),
        "min_players": r.get::<_, Option<i16>>("min_players"),
        "max_players": r.get::<_, Option<i16>>("max_players"),
        "round_count": r.get::<_, Option<i16>>("round_count"),
        "confirmed": r.get::<_, i64>("confirmed"),
        "candidates": r.get::<_, i64>("candidates"),
        "fill_deadline": r.get::<_, Option<chrono::DateTime<chrono::Utc>>>("fill_deadline_ts").map(ts_ms),
        "created_at": ts_ms(r.get::<_, chrono::DateTime<chrono::Utc>>("created_at")),
    })
}

/// `GET /v1/lobby` — public Filling rooms (private excluded).
pub async fn get_lobby(
    State(st): State<AppState>,
    Query(q): Query<PageQuery>,
) -> Result<Json<Value>, ApiError> {
    let client = st.pool.get().await?;
    let rows = client
        .query(
            r#"
            SELECT m.id, m.onchain_match_id, m.status::text AS status, m.feed_symbol,
                   m.buy_in_chips, m.mint, m.min_players, m.max_players, m.round_count,
                   m.fill_deadline_ts, m.created_at,
                   count(sc.*) FILTER (WHERE sc.status = 'confirmed') AS confirmed,
                   count(sc.*) FILTER (WHERE sc.status IN ('reported','candidate')) AS candidates
            FROM matches m
            LEFT JOIN seat_candidates sc ON sc.match_id = m.id
            WHERE m.status = 'filling' AND m.visibility = 'public'
              AND ($2::text IS NULL OR m.feed_symbol = $2)
              AND ($3::bigint IS NULL OR m.buy_in_chips >= $3)
              AND ($4::bigint IS NULL OR m.buy_in_chips <= $4)
            GROUP BY m.id
            ORDER BY m.created_at DESC
            LIMIT $1
            "#,
            &[
                &q.limit.clamp(1, 200),
                &q.feed,
                &q.buy_in_min,
                &q.buy_in_max,
            ],
        )
        .await?;
    Ok(Json(json!({
        "v": 1, "server_time_ms": now_ms(),
        "rooms": rows.iter().map(lobby_row).collect::<Vec<_>>(),
    })))
}

/// `GET /v1/matches/live` — sealing/live matches (spectate list).
pub async fn get_live(
    State(st): State<AppState>,
    Query(q): Query<PageQuery>,
) -> Result<Json<Value>, ApiError> {
    let client = st.pool.get().await?;
    let rows = client
        .query(
            &format!(
                r#"SELECT {} FROM matches m
                   WHERE m.status IN ('sealing', 'live', 'settlement_pending')
                   ORDER BY m.live_start_ts DESC NULLS LAST LIMIT $1"#,
                db::MATCH_COLUMNS
            ),
            &[&q.limit.clamp(1, 200)],
        )
        .await?;
    let mut out = Vec::with_capacity(rows.len());
    for r in &rows {
        let m = db::MatchRow::from_row(r)?;
        let tick =
            crate::config::feed_oracle_symbol(&m.feed_symbol).and_then(|s| st.price.latest(s));
        out.push(json!({
            "match_id": m.id,
            "onchain_match_id": m.onchain_match_id,
            "phase": m.status,
            "feed": m.feed_symbol,
            "buy_in": m.buy_in,
            "chips_token_mint": m.mint,
            "round_count": m.round_count,
            "live_start": m.live_start_ts.map(ts_ms),
            "scheduled_end": m.scheduled_end_ts.map(ts_ms),
            "feed_price": tick.as_ref().map(|t| t.price.clone()),
        }));
    }
    Ok(Json(
        json!({ "v": 1, "server_time_ms": now_ms(), "matches": out }),
    ))
}

/// `GET /v1/matches/history` — terminal matches, newest first.
pub async fn get_history(
    State(st): State<AppState>,
    Query(q): Query<PageQuery>,
) -> Result<Json<Value>, ApiError> {
    let client = st.pool.get().await?;
    let rows = client
        .query(
            r#"
            SELECT id, onchain_match_id, status::text AS status, feed_symbol, buy_in_chips,
                   min_players, max_players, round_count, void_kind, settled_at, voided_at,
                   created_at
            FROM matches
            WHERE status IN ('settled', 'voided')
            ORDER BY COALESCE(settled_at, voided_at, created_at) DESC
            LIMIT $1
            "#,
            &[&q.limit.clamp(1, 200)],
        )
        .await?;
    let out: Vec<Value> = rows
        .iter()
        .map(|r| {
            json!({
                "match_id": r.get::<_, uuid::Uuid>("id"),
                "onchain_match_id": r.get::<_, i64>("onchain_match_id") as u64,
                "phase": r.get::<_, String>("status"),
                "feed": r.get::<_, Option<String>>("feed_symbol"),
                "buy_in": r.get::<_, Option<i64>>("buy_in_chips").unwrap_or(0),
                "void_kind": r.get::<_, Option<String>>("void_kind"),
                "ended_at": r.get::<_, Option<chrono::DateTime<chrono::Utc>>>("settled_at")
                    .or(r.get::<_, Option<chrono::DateTime<chrono::Utc>>>("voided_at"))
                    .map(ts_ms),
            })
        })
        .collect();
    Ok(Json(
        json!({ "v": 1, "server_time_ms": now_ms(), "matches": out }),
    ))
}

/// `GET /v1/wallets/{wallet}/active` — cold-return session restore.
pub async fn get_active(
    State(st): State<AppState>,
    Path(wallet): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let client = st.pool.get().await?;
    let rows = client
        .query(
            r#"
            SELECT m.id, m.status::text AS status, ms.seat_index,
                   m.fill_deadline_ts, m.seal_deadline_ts, m.scheduled_end_ts
            FROM matches m
            LEFT JOIN match_seats ms ON ms.match_id = m.id AND ms.wallet_address = $1
            LEFT JOIN seat_candidates sc ON sc.match_id = m.id AND sc.wallet = $1
            WHERE (ms.wallet_address = $1 OR sc.status IN ('reported','candidate','confirmed'))
              AND m.status NOT IN ('settled', 'voided')
            GROUP BY m.id, ms.seat_index
            ORDER BY m.created_at DESC
            "#,
            &[&wallet],
        )
        .await?;
    let mut active = Vec::with_capacity(rows.len());
    for r in rows {
        let match_id: uuid::Uuid = r.get("id");
        let status: String = r.get("status");
        let seat_index: Option<i16> = r.get("seat_index");
        let deadline = match status.as_str() {
            "filling" => r.get::<_, Option<chrono::DateTime<chrono::Utc>>>("fill_deadline_ts"),
            "sealing" => r.get::<_, Option<chrono::DateTime<chrono::Utc>>>("seal_deadline_ts"),
            _ => r.get::<_, Option<chrono::DateTime<chrono::Utc>>>("scheduled_end_ts"),
        };
        let mut open_turn = Value::Null;
        let mut your_turn = false;
        let mut deadline_ts = deadline.map(ts_ms);
        if let Some(handle) = st.registry.get(&match_id) {
            let (tx, rx) = tokio::sync::oneshot::channel();
            if handle.cmd.send(Cmd::Snapshot(tx)).await.is_ok() {
                if let Ok(view) = rx.await {
                    open_turn = view.get("open_turn").cloned().unwrap_or(Value::Null);
                    if let (Some(seat), Some(turn_seat)) = (
                        seat_index,
                        open_turn.get("seat").and_then(Value::as_u64).map(|v| v as i16),
                    ) {
                        your_turn = seat == turn_seat;
                        if your_turn {
                            deadline_ts = open_turn.get("deadline_ms").and_then(Value::as_u64);
                        }
                    }
                }
            }
        }
        active.push(json!({
            "match_id": match_id,
            "phase": status,
            "seat_index": seat_index,
            "your_turn": your_turn,
            "deadline_ts": deadline_ts,
            "open_turn": open_turn,
        }));
    }
    Ok(Json(
        json!({ "v": 1, "server_time_ms": now_ms(), "active": active }),
    ))
}

/// `GET /v1/wallets/{wallet}/matches` — the wallet's match history.
pub async fn get_wallet_matches(
    State(st): State<AppState>,
    Path(wallet): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let client = st.pool.get().await?;
    let rows = client
        .query(
            r#"
            SELECT m.id, m.onchain_match_id, m.status::text AS status, m.feed_symbol,
                   m.buy_in_chips, ms.seat_index, m.created_at
            FROM matches m
            JOIN match_seats ms ON ms.match_id = m.id
            WHERE ms.wallet_address = $1
            ORDER BY m.created_at DESC
            LIMIT 200
            "#,
            &[&wallet],
        )
        .await?;
    let out: Vec<Value> = rows
        .iter()
        .map(|r| {
            json!({
                "match_id": r.get::<_, uuid::Uuid>("id"),
                "onchain_match_id": r.get::<_, i64>("onchain_match_id") as u64,
                "phase": r.get::<_, String>("status"),
                "feed": r.get::<_, Option<String>>("feed_symbol"),
                "buy_in": r.get::<_, Option<i64>>("buy_in_chips").unwrap_or(0),
                "seat_index": r.get::<_, i16>("seat_index"),
                "created_at": ts_ms(r.get::<_, chrono::DateTime<chrono::Utc>>("created_at")),
            })
        })
        .collect();
    Ok(Json(
        json!({ "v": 1, "server_time_ms": now_ms(), "matches": out }),
    ))
}

/// `GET /v1/wallets/{wallet}/claimables` — payouts (settled, confirmed seats), refunds
/// (voids + unconfirmed candidates). The exact claimable amount lives on-chain in the
/// seat account; `claimed` flips when the seat PDA closes.
pub async fn get_claimables(
    State(st): State<AppState>,
    Path(wallet): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let client = st.pool.get().await?;
    let mut claimables: Vec<Value> = Vec::new();

    // Confirmed seats in settled matches → claim; in voided matches → refund.
    let rows = client
        .query(
            r#"
            SELECT m.id, m.onchain_match_id, m.status::text AS status, m.void_kind,
                   m.buy_in_chips, m.entry_fee_chips, ms.seat_index
            FROM matches m
            JOIN match_seats ms ON ms.match_id = m.id
            WHERE ms.wallet_address = $1 AND m.status IN ('settled', 'voided')
            "#,
            &[&wallet],
        )
        .await?;
    for r in &rows {
        let status: String = r.get("status");
        let onchain = r.get::<_, i64>("onchain_match_id") as u64;
        let (kind, reason) = if status == "settled" {
            ("payout", "settled payout".to_string())
        } else {
            (
                "refund",
                format!(
                    "void:{}",
                    r.get::<_, Option<String>>("void_kind").unwrap_or_default()
                ),
            )
        };
        claimables.push(json!({
            "match_id": r.get::<_, uuid::Uuid>("id"),
            "onchain_match_id": onchain,
            "match_pda": syndicate_chain::pda::match_account(&st.program_id, onchain).0.to_string(),
            "kind": kind,
            "reason": reason,
            "seat_index": r.get::<_, i16>("seat_index"),
            "refund_amount_hint": if kind == "refund" {
                Some(r.get::<_, Option<i64>>("buy_in_chips").unwrap_or(0)
                    + r.get::<_, i64>("entry_fee_chips"))
            } else { None },
        }));
    }

    // Unconfirmed candidates after the match left Filling → on-chain refund available.
    let rows = client
        .query(
            r#"
            SELECT m.id, m.onchain_match_id, m.buy_in_chips, m.entry_fee_chips,
                   sc.status::text AS cand_status
            FROM matches m
            JOIN seat_candidates sc ON sc.match_id = m.id
            WHERE sc.wallet = $1 AND sc.status = 'not_confirmed'
            "#,
            &[&wallet],
        )
        .await?;
    for r in &rows {
        let onchain = r.get::<_, i64>("onchain_match_id") as u64;
        claimables.push(json!({
            "match_id": r.get::<_, uuid::Uuid>("id"),
            "onchain_match_id": onchain,
            "match_pda": syndicate_chain::pda::match_account(&st.program_id, onchain).0.to_string(),
            "kind": "refund",
            "reason": "candidate_not_confirmed_at_lock",
            "refund_amount_hint": r.get::<_, Option<i64>>("buy_in_chips").unwrap_or(0)
                + r.get::<_, i64>("entry_fee_chips"),
        }));
    }

    // Depositors in a match that VOIDED BEFORE LOCK. `match_seats` is only populated at lock,
    // so a pre-lock void (filling_void, or an emergency void while still filling) leaves the
    // depositor with an on-chain refund but no match_seats row — surface it from the
    // candidacy. Skip rows already covered by the match_seats path above (post-lock voids).
    let rows = client
        .query(
            r#"
            SELECT m.id, m.onchain_match_id, m.buy_in_chips, m.entry_fee_chips
            FROM matches m
            JOIN seat_candidates sc ON sc.match_id = m.id
            WHERE sc.wallet = $1 AND m.status = 'voided'
              AND sc.status IN ('reported', 'candidate', 'confirmed')
              AND NOT EXISTS (
                  SELECT 1 FROM match_seats ms
                  WHERE ms.match_id = m.id AND ms.wallet_address = $1
              )
            "#,
            &[&wallet],
        )
        .await?;
    for r in &rows {
        let onchain = r.get::<_, i64>("onchain_match_id") as u64;
        claimables.push(json!({
            "match_id": r.get::<_, uuid::Uuid>("id"),
            "onchain_match_id": onchain,
            "match_pda": syndicate_chain::pda::match_account(&st.program_id, onchain).0.to_string(),
            "kind": "refund",
            "reason": "voided_before_lock",
            "refund_amount_hint": r.get::<_, Option<i64>>("buy_in_chips").unwrap_or(0)
                + r.get::<_, i64>("entry_fee_chips"),
        }));
    }

    Ok(Json(json!({
        "v": 1, "server_time_ms": now_ms(),
        "wallet": wallet,
        "claimables": claimables,
    })))
}
