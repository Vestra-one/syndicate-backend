//! Public views: match detail + redacted event log. Seal ciphertexts stay hidden until
//! the match settles (reveal); action stamps and structure are public for spectators.

use serde_json::{json, Value};

use syndicate_engine::service::{EngineLogEvent, EventEnvelope, FencedMatchRuntime};

use crate::app::AppState;
use crate::db::{self, MatchRow};
use crate::util::{now_ms, ts_ms};

/// One public event frame (backfill + live share this shape).
pub fn public_event(envelope: &EventEnvelope) -> Value {
    let (event_type, body) = match &envelope.event {
        EngineLogEvent::MatchStarted { config } => (
            "match_started",
            json!({
                "button": config.button,
                "small_blind": config.small_blind,
                "big_blind": config.big_blind,
                "round_count": config.round_count,
            }),
        ),
        EngineLogEvent::PlayerAction { intent } => (
            "action",
            json!({
                "seat": intent.seat_index,
                "action": format!("{:?}", intent.action),
                "nonce": intent.nonce,
            }),
        ),
        EngineLogEvent::TimeoutDefaultApplied {
            seat_index,
            default,
            ..
        } => (
            "timeout_default",
            json!({ "seat": seat_index, "default": format!("{default:?}") }),
        ),
        EngineLogEvent::DefaultPolicyRegistered { policy } => {
            ("default_registered", json!({ "seat": policy.seat_index }))
        }
        EngineLogEvent::SnapshotWritten { round, .. } => {
            ("street_closed", json!({ "round": round }))
        }
        // Redaction: the ciphertext is NOT exposed pre-reveal; only the fact of sealing.
        EngineLogEvent::PredictionSealed { player_id, .. } => {
            ("sealed", json!({ "seat": player_id }))
        }
        EngineLogEvent::MatchCompleted { event_root, .. } => {
            ("match_completed", json!({ "event_root": event_root }))
        }
    };
    json!({
        "seq": envelope.seq,
        "type": event_type,
        "body": body,
        "hash": hex::encode(envelope.hash),
    })
}

/// Full match detail (REST `GET /v1/matches/{id}` + WS snapshot).
pub async fn match_view(st: &AppState, row: &MatchRow, rt: Option<&FencedMatchRuntime>) -> Value {
    let seats = match st.pool.get().await {
        Ok(client) => db::load_seats(&client, row.id).await.unwrap_or_default(),
        Err(_) => Vec::new(),
    };
    let engine = rt.map(|rt| rt.engine());
    let seat_views: Vec<Value> = seats
        .iter()
        .map(|s| {
            let live = engine.and_then(|e| e.seats.get(s.engine_seat as usize));
            json!({
                "seat_index": s.engine_seat,
                "wallet": s.wallet,
                "sealed": s.sealed,
                "prediction_source": s.prediction_source,
                "stack": live.map(|l| l.stack),
                "committed": live.map(|l| l.street_committed),
                "total_contribution": live.map(|l| l.total_contribution),
                "folded": live.map(|l| l.folded),
                "all_in": live.map(|l| l.all_in),
            })
        })
        .collect();

    // Street schedule as absolute timestamps (UI renders countdowns from these).
    let street_schedule: Vec<Value> = row
        .live_start_ts
        .map(|live| {
            let live_ms = ts_ms(live);
            let mut offset = 0u64;
            row.round_durations_sec
                .iter()
                .zip(
                    row.observation_windows_sec
                        .iter()
                        .chain(std::iter::repeat(&0)),
                )
                .enumerate()
                .map(|(i, (dur, obs))| {
                    let open = live_ms + offset * 1000;
                    let close = open + dur * 1000;
                    let end = close + obs * 1000;
                    offset += dur + obs;
                    json!({ "street": i, "open": open, "close": close, "end": end })
                })
                .collect()
        })
        .unwrap_or_default();

    let reveal = if row.status == "settled" {
        reveal_view(st, row).await
    } else {
        Value::Null
    };

    json!({
        "v": 1,
        "server_time_ms": now_ms(),
        "match_id": row.id,
        "onchain_match_id": row.onchain_match_id,
        "phase": row.status,
        "visibility": row.visibility,
        "feed": row.feed_symbol,
        "params": {
            "buy_in": row.buy_in,
            "entry_fee": row.entry_fee,
            "rake_bps": row.rake_bps,
            "rake_cap": row.rake_cap,
            "min_players": row.min_players,
            "max_players": row.max_players,
            "round_count": row.round_count,
            "round_durations_sec": row.round_durations_sec,
            "observation_windows_sec": row.observation_windows_sec,
            "action_timeout_ms": row.action_timeout_ms,
            "small_blind": row.small_blind,
            "big_blind": row.big_blind,
            "seal_window_sec": row.seal_window_sec,
            "config_hash": row.config_hash.as_ref().map(hex::encode),
        },
        "timing": {
            "fill_deadline": row.fill_deadline_ts.map(ts_ms),
            "lock_ts": row.lock_ts.map(ts_ms),
            "seal_deadline": row.seal_deadline_ts.map(ts_ms),
            "live_start": row.live_start_ts.map(ts_ms),
            "scheduled_end": row.scheduled_end_ts.map(ts_ms),
            "street_schedule": street_schedule,
            "timelock_target": row.timelock_target,
        },
        "button": row.button,
        "seats": seat_views,
        "pot": engine.map(|e| e.seats.iter().map(|s| s.total_contribution).sum::<u64>()),
        "round": engine.map(|e| e.round),
        "current_bet": engine.map(|e| e.current_bet),
        "to_act": engine.and_then(|e| e.to_act),
        "reveal": reveal,
        "last_seq": row.event_count,
        "head": hex::encode(&row.event_head),
        "void_kind": row.void_kind,
    })
}

/// Post-settlement reveal: predictions + settlement price from the confirmed settle job's
/// oracle audit (written by the chain-worker).
async fn reveal_view(st: &AppState, row: &MatchRow) -> Value {
    let Ok(client) = st.pool.get().await else {
        return Value::Null;
    };
    let audit = client
        .query_opt(
            r#"SELECT oracle_audit, tx_signature FROM chain_jobs
               WHERE match_id = $1 AND kind = 'submit_settlement' AND status = 'confirmed'
               ORDER BY confirmed_at DESC LIMIT 1"#,
            &[&row.id],
        )
        .await
        .ok()
        .flatten();
    match audit {
        Some(r) => {
            let audit: Option<Value> = r.get("oracle_audit");
            let tx: Option<String> = r.get("tx_signature");
            json!({
                "settlement_price_wad": audit.as_ref().and_then(|a| a.get("settlement_price_wad")).cloned(),
                "predictions": audit.as_ref().and_then(|a| a.get("predictions")).cloned(),
                "rake": audit.as_ref().and_then(|a| a.get("rake_collected")).cloned(),
                "tx_sig": tx,
            })
        }
        None => Value::Null,
    }
}
