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
    let lock_tx_sig = confirmed_lock_tx_sig(st, row.id).await;
    let (last_seq, head) = event_cursor(row, rt);

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
            "chips_token_mint": row.mint,
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
            // Needed by clients to compute the drand timelock target for sealing
            // (target = round after seal_deadline + total_betting + begin_live_window).
            "begin_live_window_sec": row.begin_live_window_sec,
            "total_betting_duration_sec": row.total_betting_duration_sec(),
            "config_hash": row.config_hash.as_ref().map(hex::encode),
        },
        "timing": {
            "fill_deadline": row.fill_deadline_ts.map(ts_ms),
            "lock_ts": row.lock_ts.map(ts_ms),
            "lock_confirmed": row.lock_ts.is_some(),
            "lock_tx_sig": lock_tx_sig,
            "seal_deadline": row.seal_deadline_ts.map(ts_ms),
            "live_start": row.live_start_ts.map(ts_ms),
            "scheduled_end": row.scheduled_end_ts.map(ts_ms).or_else(|| row.projected_scheduled_end_ms()),
            "projected_scheduled_end": row.projected_scheduled_end_ms(),
            "street_schedule": street_schedule,
            "timelock_target": row.effective_timelock_target(),
        },
        "button": row.button,
        "seats": seat_views,
        "pot": engine.map(|e| e.seats.iter().map(|s| s.total_contribution).sum::<u64>()),
        "round": engine.map(|e| e.round),
        "clock_round": clock_round(row, now_ms()),
        "current_bet": engine.map(|e| e.current_bet),
        "to_act": engine.and_then(|e| e.to_act),
        "open_turn": Value::Null,
        "turn": Value::Null,
        "reveal": reveal,
        "settlement_failure": settlement_failure_view(st, row.id).await,
        "last_seq": last_seq,
        "head": head,
        "void_kind": row.void_kind,
    })
}

fn event_cursor(row: &MatchRow, rt: Option<&FencedMatchRuntime>) -> (u64, String) {
    match rt {
        Some(rt) => (rt.next_seq(), hex::encode(rt.head())),
        None => (row.event_count, hex::encode(&row.event_head)),
    }
}

fn clock_round(row: &MatchRow, now: u64) -> Option<u8> {
    let live_start = row.live_start_ts.map(ts_ms)?;
    if now < live_start || row.round_count == 0 {
        return None;
    }
    let elapsed_sec = now.saturating_sub(live_start) / 1_000;
    let mut offset = 0u64;
    for round in 1..=row.round_count {
        let idx = round.saturating_sub(1) as usize;
        let duration = row.round_durations_sec.get(idx).copied().unwrap_or(0);
        let observation = row.observation_windows_sec.get(idx).copied().unwrap_or(0);
        offset = offset.saturating_add(duration).saturating_add(observation);
        if elapsed_sec < offset {
            return Some(round);
        }
    }
    Some(row.round_count)
}

async fn confirmed_lock_tx_sig(st: &AppState, match_id: uuid::Uuid) -> Option<String> {
    let client = st.pool.get().await.ok()?;
    let row = client
        .query_opt(
            r#"SELECT tx_signature
               FROM chain_jobs
               WHERE match_id = $1 AND kind = 'lock' AND status = 'confirmed'
               ORDER BY confirmed_at DESC NULLS LAST, updated_at DESC
               LIMIT 1"#,
            &[&match_id],
        )
        .await
        .ok()??;
    row.get("tx_signature")
}

pub async fn settlement_failure_view(st: &AppState, match_id: uuid::Uuid) -> Value {
    let Ok(client) = st.pool.get().await else {
        return Value::Null;
    };
    let row = client
        .query_opt(
            r#"SELECT kind::text AS kind, status::text AS status, last_error, oracle_audit
               FROM chain_jobs
               WHERE match_id = $1
                 AND kind IN ('submit_settlement', 'void_live_after_deadline')
                 AND (last_error IS NOT NULL OR status IN ('dead_letter', 'skipped'))
               ORDER BY updated_at DESC
               LIMIT 1"#,
            &[&match_id],
        )
        .await
        .ok()
        .flatten();
    match row {
        Some(r) => json!({
            "kind": r.get::<_, String>("kind"),
            "status": r.get::<_, String>("status"),
            "error": r.get::<_, Option<String>>("last_error"),
            "audit": r.get::<_, Option<Value>>("oracle_audit"),
        }),
        None => Value::Null,
    }
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

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::{Duration, Utc};
    use syndicate_engine::service::{MatchConfig, MatchLease};
    use syndicate_shared::PlayerId;
    use uuid::Uuid;

    fn match_row() -> MatchRow {
        MatchRow {
            id: Uuid::nil(),
            match_key: "match-1".into(),
            onchain_match_id: 1,
            status: "live".into(),
            visibility: "public".into(),
            creator_wallet: None,
            room_code: None,
            room_commitment: None,
            feed_symbol: "BTC/USD".into(),
            config_hash: None,
            buy_in: 1_000,
            entry_fee: 0,
            rake_bps: 0,
            rake_cap: 0,
            round_count: 2,
            round_durations_sec: vec![10, 20],
            observation_windows_sec: vec![5, 0],
            action_timeout_ms: 25_000,
            time_bank_sec: 0,
            small_blind: 5,
            big_blind: 10,
            min_players: 2,
            max_players: 2,
            seal_window_sec: 90,
            begin_live_window_sec: 30,
            fill_deadline_ts: None,
            lock_ts: None,
            seal_deadline_ts: None,
            live_start_ts: Some(Utc::now()),
            scheduled_end_ts: None,
            button: Some(0),
            button_seed: None,
            timelock_target: None,
            void_kind: None,
            event_count: 0,
            event_head: vec![0u8; 32],
            mint: None,
        }
    }

    fn runtime() -> FencedMatchRuntime {
        FencedMatchRuntime::start(
            MatchConfig {
                match_id: Uuid::nil().to_string(),
                onchain_match_id: 1,
                players: vec![(PlayerId(0), 1_000, 0), (PlayerId(1), 1_000, 1)],
                button: 0,
                small_blind: 5,
                big_blind: 10,
                round_count: 2,
                round_durations_sec: vec![10, 20],
                observation_windows_sec: vec![5, 0],
                action_timeout_ms: 25_000,
                time_bank_sec: 0,
                lease_ttl_ms: 60_000,
            },
            MatchLease {
                match_id: Uuid::nil().to_string(),
                owner_id: "test".into(),
                fencing_token: 1,
                expires_at_ms: u64::MAX,
            },
        )
    }

    #[test]
    fn event_cursor_prefers_runtime_head_when_active() {
        let row = match_row();
        let rt = runtime();
        let (last_seq, head) = event_cursor(&row, Some(&rt));

        assert_eq!(last_seq, rt.next_seq());
        assert_eq!(head, hex::encode(rt.head()));
        assert_ne!(last_seq, row.event_count);
        assert_ne!(head, hex::encode(&row.event_head));
    }

    #[test]
    fn event_cursor_falls_back_to_row_without_runtime() {
        let row = MatchRow {
            event_count: 7,
            event_head: vec![9u8; 32],
            ..match_row()
        };

        assert_eq!(event_cursor(&row, None), (7, hex::encode(vec![9u8; 32])));
    }

    #[test]
    fn clock_round_tracks_wall_clock_schedule() {
        let now = Utc::now();
        let row = MatchRow {
            live_start_ts: Some(now - Duration::seconds(12)),
            ..match_row()
        };
        assert_eq!(clock_round(&row, now.timestamp_millis() as u64), Some(1));

        let row = MatchRow {
            live_start_ts: Some(now - Duration::seconds(16)),
            ..match_row()
        };
        assert_eq!(clock_round(&row, now.timestamp_millis() as u64), Some(2));
    }
}
