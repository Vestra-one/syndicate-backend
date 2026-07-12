//! Chain-job result handshake: LISTEN on `syndicate_chain_job_results` (+ poll) and, when
//! a job the actors care about confirms, refresh the on-chain state into the `matches`
//! row and dispatch the `ChainEvent` to the actor.

use deadpool_postgres::Pool;
use futures_util::{future, StreamExt};
use solana_client::nonblocking::rpc_client::RpcClient;
use tracing::{info, warn};
use uuid::Uuid;

use syndicate_chain::accounts::{
    decode_match, STATUS_LIVE, STATUS_SEALING, STATUS_SETTLED, STATUS_VOID,
};

use crate::app::AppState;
use crate::db::{self};
use crate::error::ApiError;
use crate::runtime::{ChainEvent, Cmd};

pub async fn run(st: AppState) {
    let rpc = RpcClient::new(st.cfg.rpc_url.clone());
    let (notify_tx, mut notify_rx) = tokio::sync::mpsc::channel::<()>(8);
    tokio::spawn(listen_task(st.cfg.database_url.clone(), notify_tx));
    loop {
        tokio::select! {
            _ = tokio::time::sleep(std::time::Duration::from_millis(2_000)) => {}
            _ = notify_rx.recv() => {}
        }
        if let Err(e) = tick(&st, &rpc).await {
            warn!("chainjobs tick: {e}");
        }
    }
}

/// Process freshly-terminal jobs the game-server hasn't acknowledged yet. We mark
/// acknowledgement by stamping `payload.acked = true` (single-writer: this loop).
async fn tick(st: &AppState, rpc: &RpcClient) -> Result<(), ApiError> {
    let client = st.pool.get().await?;
    let rows = client
        .query(
            r#"
            SELECT id, match_id, kind::text AS kind, status::text AS status, tx_signature
            FROM chain_jobs
            WHERE status IN ('confirmed', 'dead_letter', 'skipped')
              AND COALESCE((payload->>'acked')::boolean, false) = false
            ORDER BY updated_at ASC
            LIMIT 32
            "#,
            &[],
        )
        .await?;
    drop(client);

    for row in rows {
        let job_id: Uuid = row.get("id");
        let match_id: Uuid = row.get("match_id");
        let kind: String = row.get("kind");
        let status: String = row.get("status");
        let tx_signature: Option<String> = row.get("tx_signature");

        if status == "confirmed" {
            if let Err(e) = sync_match_from_chain(st, rpc, match_id).await {
                warn!(%match_id, %kind, "chain sync failed (will retry): {e}");
                continue; // leave unacked; retried next tick
            }
            if kind == "submit_settlement" {
                if let Err(e) = persist_settlement_outcome(st, match_id, job_id).await {
                    warn!(%match_id, "settlement persist failed (will retry): {e}");
                    continue; // leave unacked; retried next tick
                }
            }
            let event = match kind.as_str() {
                "lock" => Some(ChainEvent::Locked {
                    tx_sig: tx_signature.clone(),
                }),
                "begin_live" => Some(ChainEvent::LiveBegan),
                "submit_settlement" => Some(ChainEvent::Settled),
                "void" | "void_before_start" | "void_live_after_deadline" => {
                    Some(ChainEvent::Voided)
                }
                _ => None,
            };
            if let Some(event) = event {
                dispatch(st, match_id, event).await;
            }
        } else {
            info!(%match_id, %kind, %status, "chain job terminal without confirm");
        }

        let client = st.pool.get().await?;
        let _ = client
            .execute(
                "UPDATE chain_jobs SET payload = jsonb_set(payload, '{acked}', 'true'), updated_at = now() WHERE id = $1",
                &[&job_id],
            )
            .await;
    }
    Ok(())
}

/// Persist the settlement outcome (per-seat payouts/pot-won/prediction + match-level
/// settle price/final pot/rake/tx sig) computed by the chain-worker, once the settlement
/// job has confirmed. Read-after-confirm, additive-only, and idempotent — safe to retry.
/// Never touches the on-chain submission path (see settlement.rs / executor.rs).
async fn persist_settlement_outcome(
    st: &AppState,
    match_id: Uuid,
    job_id: Uuid,
) -> Result<(), ApiError> {
    let mut client = st.pool.get().await?;
    let row = client
        .query_opt(
            "SELECT oracle_audit, tx_signature FROM chain_jobs WHERE id = $1",
            &[&job_id],
        )
        .await?;
    let Some(row) = row else {
        return Ok(()); // job vanished; nothing to persist
    };
    let audit: Option<serde_json::Value> = row.get("oracle_audit");
    let tx_sig: Option<String> = row.get("tx_signature");
    let Some(audit) = audit else {
        info!(%match_id, "settlement confirmed with no oracle_audit yet; skipping persist");
        return Ok(());
    };
    let predictions = audit.get("predictions").and_then(|v| v.as_array());
    // Legacy audit format (pre-migration-0013) carries no per-seat payout_chips — nothing
    // new to persist for these matches; don't wedge the ack loop retrying forever.
    let has_payouts = predictions
        .map(|p| p.iter().any(|e| e.get("payout_chips").is_some()))
        .unwrap_or(false);
    if !has_payouts {
        info!(%match_id, "settlement audit missing payouts (legacy format); skipping persist");
        return Ok(());
    }

    let settlement_price_wad = audit
        .get("settlement_price_wad")
        .and_then(|v| v.as_str())
        .map(str::to_string);
    let final_pot_chips = audit.get("final_pot_chips").and_then(|v| v.as_i64());
    let rake_chips = audit.get("rake_collected").and_then(|v| v.as_i64());

    let tx = client.transaction().await?;
    for entry in predictions.into_iter().flatten() {
        let Some(engine_seat) = entry.get("engine_seat").and_then(|v| v.as_i64()) else {
            continue;
        };
        let payout_chips = entry.get("payout_chips").and_then(|v| v.as_i64());
        let pot_won_chips = entry.get("pot_won_chips").and_then(|v| v.as_i64());
        let prediction_wad = entry
            .get("prediction_wad")
            .and_then(|v| v.as_str())
            .map(str::to_string);
        tx.execute(
            db::UPDATE_SEAT_SETTLEMENT_SQL,
            &[
                &match_id,
                &(engine_seat as i16),
                &payout_chips,
                &pot_won_chips,
                &prediction_wad,
            ],
        )
        .await?;
    }
    tx.execute(
        db::UPDATE_MATCH_SETTLEMENT_SQL,
        &[
            &match_id,
            &settlement_price_wad,
            &final_pot_chips,
            &rake_chips,
            &tx_sig,
        ],
    )
    .await?;
    tx.commit().await?;
    Ok(())
}

async fn dispatch(st: &AppState, match_id: Uuid, event: ChainEvent) {
    let Ok(client) = st.pool.get().await else {
        return;
    };
    let Ok(Some(row)) = db::load_match(&client, match_id).await else {
        return;
    };
    drop(client);
    // Ensure an actor exists (restart between enqueue and confirm).
    let handle = match st.registry.get(&match_id) {
        Some(h) => h,
        None if !row.is_terminal()
            || event == ChainEvent::Settled
            || event == ChainEvent::Voided =>
        {
            st.registry.spawn(st, row.clone())
        }
        None => return,
    };
    let _ = handle.cmd.send(Cmd::Chain(event, Box::new(row))).await;
}

/// Read the on-chain match account and mirror status/timing into the matches row.
async fn sync_match_from_chain(
    st: &AppState,
    rpc: &RpcClient,
    match_id: Uuid,
) -> Result<(), ApiError> {
    let client = st.pool.get().await?;
    let Some(row) = db::load_match(&client, match_id).await? else {
        return Err(ApiError::internal("match missing"));
    };
    let (match_pda, _) = syndicate_chain::pda::match_account(&st.program_id, row.onchain_match_id);
    let account = rpc
        .get_account_with_commitment(
            &match_pda,
            solana_sdk::commitment_config::CommitmentConfig::confirmed(),
        )
        .await
        .map_err(ApiError::internal)?
        .value
        .ok_or_else(|| ApiError::internal("match account missing on chain"))?;
    let m = decode_match(&account.data).map_err(ApiError::internal)?;

    let status = match m.status {
        STATUS_SEALING => "sealing",
        STATUS_LIVE => "live",
        STATUS_SETTLED => "settled",
        STATUS_VOID => "voided",
        _ => "filling",
    };
    let void_kind = match m.void_kind {
        1 => Some("filling_void"),
        2 => Some("emergency"),
        _ => None,
    };
    client
        .execute(
            r#"
            UPDATE matches SET
                status = ($2::text)::match_status,
                lock_ts = CASE WHEN $3::double precision > 0 THEN to_timestamp($3::double precision) ELSE lock_ts END,
                seal_deadline_ts = CASE WHEN $4::double precision > 0 THEN to_timestamp($4::double precision) ELSE seal_deadline_ts END,
                live_start_ts = CASE WHEN $5::double precision > 0 THEN to_timestamp($5::double precision) ELSE live_start_ts END,
                scheduled_end_ts = CASE WHEN $6::double precision > 0 THEN to_timestamp($6::double precision) ELSE scheduled_end_ts END,
                button = CASE WHEN $7 THEN $8::smallint ELSE button END,
                button_seed = CASE WHEN $7 THEN $9 ELSE button_seed END,
                void_kind = COALESCE($10, void_kind),
                timelock_target = COALESCE($11, timelock_target),
                locked_at = CASE WHEN $2 = 'sealing' AND locked_at IS NULL THEN now() ELSE locked_at END,
                settled_at = CASE WHEN $2 = 'settled' AND settled_at IS NULL THEN now() ELSE settled_at END,
                voided_at = CASE WHEN $2 = 'voided' AND voided_at IS NULL THEN now() ELSE voided_at END
            WHERE id = $1
            "#,
            &[
                &match_id,
                &status,
                &(m.lock_ts as f64),
                &(m.seal_deadline_ts as f64),
                &(m.live_start_ts as f64),
                &(m.scheduled_end_ts as f64),
                &m.button_set,
                &(m.button as i16),
                &m.button_seed.as_slice(),
                &void_kind,
                &timelock_target_for_match(&row, m.seal_deadline_ts).map(|t| t as i64),
            ],
        )
        .await?;
    Ok(())
}

fn timelock_target_for_match(row: &db::MatchRow, seal_deadline_sec: u64) -> Option<u64> {
    if seal_deadline_sec == 0 {
        return None;
    }
    let latest_match_end = crate::config::latest_match_end_sec(
        seal_deadline_sec,
        row.total_betting_duration_sec(),
        row.begin_live_window_sec,
    );
    Some(crate::config::timelock_target_round(latest_match_end))
}

/// Ordered event log for replay (shared with the actor's recovery path).
pub async fn load_events(
    pool: &Pool,
    match_id: Uuid,
) -> Result<Vec<syndicate_engine::service::EventEnvelope>, ApiError> {
    use syndicate_engine::persistence::parse_persisted_event;
    let client = pool.get().await?;
    let rows = client
        .query(
            syndicate_store::LOAD_ALL_MATCH_EVENTS_SQL,
            &[&match_id.to_string()],
        )
        .await?;
    rows.iter()
        .map(|row| {
            let prev: Vec<u8> = row.get("prev_hash");
            let hash: Vec<u8> = row.get("hash");
            let mut prev_hash = [0u8; 32];
            let mut event_hash = [0u8; 32];
            prev_hash.copy_from_slice(&prev);
            event_hash.copy_from_slice(&hash);
            let payload: serde_json::Value = row.get("payload");
            let event = parse_persisted_event(&payload)
                .map_err(|e| ApiError::internal(format!("{e:?}")))?;
            Ok(syndicate_engine::service::EventEnvelope {
                seq: row.get::<_, i64>("seq") as u64,
                owner_fencing_token: row.get::<_, i64>("owner_fencing_token") as u64,
                prev_hash,
                hash: event_hash,
                event,
            })
        })
        .collect()
}

async fn listen_task(database_url: String, tx: tokio::sync::mpsc::Sender<()>) {
    loop {
        match tokio_postgres::connect(&database_url, tokio_postgres::NoTls).await {
            Ok((client, mut connection)) => {
                let tx_inner = tx.clone();
                let stream = futures_util::stream::poll_fn(move |cx| connection.poll_message(cx));
                let pump = stream.for_each(move |message| {
                    if let Ok(tokio_postgres::AsyncMessage::Notification(_)) = message {
                        let _ = tx_inner.try_send(());
                    }
                    future::ready(())
                });
                if client
                    .batch_execute("LISTEN syndicate_chain_job_results")
                    .await
                    .is_ok()
                {
                    pump.await;
                }
            }
            Err(e) => warn!("chainjobs listen connect: {e}"),
        }
        tokio::time::sleep(std::time::Duration::from_secs(5)).await;
    }
}
