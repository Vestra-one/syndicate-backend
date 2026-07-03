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
            SELECT id, match_id, kind::text AS kind, status::text AS status
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

        if status == "confirmed" {
            if let Err(e) = sync_match_from_chain(st, rpc, match_id).await {
                warn!(%match_id, %kind, "chain sync failed (will retry): {e}");
                continue; // leave unacked; retried next tick
            }
            let event = match kind.as_str() {
                "lock" => Some(ChainEvent::Locked),
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
            ],
        )
        .await?;
    Ok(())
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
