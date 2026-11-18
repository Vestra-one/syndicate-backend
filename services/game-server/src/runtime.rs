//! Match actors: one tokio task per non-terminal match, owning the betting engine and
//! all phase deadlines. Commands arrive via mpsc; every subscriber (WS connections)
//! receives pre-serialized server frames via a broadcast channel.
//!
//! Persistence: gameplay mutations go through the fencing append
//! (`PostgresMatchStore::append_event`); phase state is derived from the `matches` row
//! (absolute timestamps only) so restarts recover exactly.

use std::collections::HashMap;
use std::sync::Arc;

use dashmap::DashMap;
use serde_json::{json, Value};
use tokio::sync::{broadcast, mpsc, oneshot};
use tracing::{info, warn};
use uuid::Uuid;

use syndicate_engine::service::{
    EngineLogEvent, FencedMatchRuntime, MatchConfig as RuntimeConfig, MatchLease,
    SignedActionIntent, SignedDefaultPolicy,
};
use syndicate_engine::DefaultAction;
use syndicate_shared::PlayerId;

use crate::app::AppState;
use crate::db::{self, MatchRow, SeatRow};
use crate::error::ApiError;
use crate::util::{now_ms, ts_ms};

pub const BROADCAST_CAPACITY: usize = 256;

/// Single-instance lease authorizer: the actor holds one long-lived Postgres lease
/// acquired at engine start; per-call TTL enforcement is unnecessary in-process.
struct ActorLease;
impl syndicate_engine::service::LeaseAuthorizer for ActorLease {
    fn assert_current(
        &self,
        _lease: &MatchLease,
        _now_ms: u64,
    ) -> Result<(), syndicate_engine::service::MatchServiceError> {
        Ok(())
    }
}
const LEASE_TTL_MS: u64 = 24 * 3600 * 1000; // single-instance: one long-lived lease

// ---------------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------------

#[derive(Clone)]
pub struct MatchHandle {
    pub cmd: mpsc::Sender<Cmd>,
    pub events: broadcast::Sender<Arc<Value>>,
}

#[derive(Clone, Default)]
pub struct Registry {
    inner: Arc<DashMap<Uuid, MatchHandle>>,
    pub lobby: Arc<LobbyChannel>,
}

#[derive(Default)]
pub struct LobbyChannel {
    tx: std::sync::OnceLock<broadcast::Sender<Arc<Value>>>,
}

impl LobbyChannel {
    pub fn sender(&self) -> &broadcast::Sender<Arc<Value>> {
        self.tx
            .get_or_init(|| broadcast::channel(BROADCAST_CAPACITY).0)
    }
    pub fn publish(&self, frame: Value) {
        let _ = self.sender().send(Arc::new(frame));
    }
}

impl Registry {
    pub fn get(&self, id: &Uuid) -> Option<MatchHandle> {
        self.inner.get(id).map(|h| h.clone())
    }

    pub fn remove(&self, id: &Uuid) {
        self.inner.remove(id);
    }

    pub fn active_count(&self) -> usize {
        self.inner.len()
    }

    /// Spawn (or return) the actor for a match.
    pub fn spawn(&self, st: &AppState, row: MatchRow) -> MatchHandle {
        if let Some(h) = self.get(&row.id) {
            return h;
        }
        let (cmd_tx, cmd_rx) = mpsc::channel(64);
        let (event_tx, _) = broadcast::channel(BROADCAST_CAPACITY);
        let handle = MatchHandle {
            cmd: cmd_tx,
            events: event_tx.clone(),
        };
        self.inner.insert(row.id, handle.clone());
        let actor = Actor {
            st: st.clone(),
            id: row.id,
            row,
            runtime: None,
            defaults: HashMap::new(),
            events: event_tx,
            cmd: cmd_rx,
            turn_started_ms: now_ms(),
            last_fill_broadcast_confirmed: None,
            seat_wallets: HashMap::new(),
            last_emote: HashMap::new(),
        };
        tokio::spawn(actor.run());
        handle
    }

    pub async fn send(&self, id: &Uuid, cmd: Cmd) -> bool {
        match self.get(id) {
            Some(h) => h.cmd.send(cmd).await.is_ok(),
            None => false,
        }
    }
}

// ---------------------------------------------------------------------------------
// Commands + chain events
// ---------------------------------------------------------------------------------

/// The reactions a seated player can send to the table. A fixed set: no free text, so
/// there is nothing to moderate.
pub const EMOTES: &[&str] = &["gg", "nice", "bluff", "sweat", "lol", "wow"];

pub enum Cmd {
    /// A seat candidacy changed (verifier); re-evaluate fill/lock.
    CandidatesChanged,
    /// A chain job reached a terminal state; `row` is the refreshed matches row.
    Chain(ChainEvent, Box<MatchRow>),
    /// Signed gameplay action from a player.
    Act {
        intent: SignedActionIntent,
        reply: oneshot::Sender<Result<Value, ApiError>>,
    },
    SetDefault {
        policy: SignedDefaultPolicy,
        reply: oneshot::Sender<Result<(), ApiError>>,
    },
    /// A verified seal was recorded (api layer already wrote match_seats); broadcast.
    Sealed { seat_index: u8 },
    /// The wallet (re)granted a session key for this match — swap it into the runtime.
    SessionKey { wallet: String, key: [u8; 32] },
    /// Table talk from a seated wallet (one of [`EMOTES`]).
    Emote { wallet: String, emote: String },
    /// Full state view (WS snapshot).
    Snapshot(oneshot::Sender<Value>),
    /// Cheap in-memory pot/round read for list rows — no DB queries, unlike `Snapshot`
    /// (which loads seats via `match_view`). `None` fields when the engine hasn't started.
    LiveStats(oneshot::Sender<LiveStats>),
    /// Sweeper tick: re-check deadlines even if the sleep was lost.
    Poke,
}

#[derive(Debug, Clone, Copy, Default)]
pub struct LiveStats {
    pub pot: Option<u64>,
    pub round: Option<u8>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ChainEvent {
    Locked { tx_sig: Option<String> },
    LiveBegan,
    Settled,
    Voided,
}

// ---------------------------------------------------------------------------------
// Actor
// ---------------------------------------------------------------------------------

struct Actor {
    st: AppState,
    id: Uuid,
    row: MatchRow,
    runtime: Option<FencedMatchRuntime>,
    defaults: HashMap<usize, DefaultAction>,
    events: broadcast::Sender<Arc<Value>>,
    cmd: mpsc::Receiver<Cmd>,
    /// Wall-clock anchor of the current turn (per-turn timer base).
    turn_started_ms: u64,
    last_fill_broadcast_confirmed: Option<usize>,
    /// engine seat → owning wallet, loaded once the confirmed seats exist. Every gameplay
    /// frame is checked against it: a valid signature only proves WHO signed, not that
    /// the signer owns the seat it names.
    seat_wallets: HashMap<usize, String>,
    last_emote: HashMap<usize, std::time::Instant>,
}

impl Actor {
    async fn run(mut self) {
        info!(match_id = %self.id, status = %self.row.status, "actor spawned");
        // Recovery: a live match rebuilds its engine from the event log.
        if self.row.status == "live" {
            if let Err(e) = self.recover_live().await {
                warn!(match_id = %self.id, "live recovery failed: {e}");
            }
        }
        loop {
            let deadline = self.next_deadline_ms();
            let sleep = tokio::time::sleep(std::time::Duration::from_millis(
                deadline.saturating_sub(now_ms()).clamp(20, 60_000),
            ));
            tokio::select! {
                maybe = self.cmd.recv() => {
                    match maybe {
                        Some(cmd) => self.handle_cmd(cmd).await,
                        None => break,
                    }
                }
                _ = sleep => self.on_deadline().await,
            }
            if self.row.is_terminal() {
                info!(match_id = %self.id, status = %self.row.status, "actor terminal");
                self.st.registry.remove(&self.id);
                break;
            }
        }
    }

    // ---- deadlines -------------------------------------------------------------

    fn next_deadline_ms(&self) -> u64 {
        match self.row.status.as_str() {
            "filling" => self.row.fill_deadline_ts.map(ts_ms).unwrap_or(u64::MAX),
            "sealing" => self.row.seal_deadline_ts.map(ts_ms).unwrap_or(u64::MAX),
            "live" => {
                let end = self.row.scheduled_end_ts.map(ts_ms).unwrap_or(u64::MAX);
                match (&self.runtime, self.row.live_start_ts) {
                    (Some(rt), Some(live_start)) => {
                        let live_ms = ts_ms(live_start);
                        let street_close = self.fair_close_ms(rt, live_ms);
                        let turn = self.turn_deadline_ms(rt, live_ms).unwrap_or(u64::MAX);
                        street_close.min(turn).min(end)
                    }
                    _ => end,
                }
            }
            _ => u64::MAX,
        }
    }

    fn turn_deadline_ms(&self, rt: &FencedMatchRuntime, live_ms: u64) -> Option<u64> {
        rt.engine().to_act?;
        // Per-turn timer anchored at the last event (approximation: last broadcast);
        // we track it via `turn_started_ms` kept in the row of events — simplest correct
        // anchor is the max(now-of-last-action, street open). We keep it in memory:
        let street_start_ms = live_ms
            + rt.street_start_offset_sec(rt.engine().round)
                .saturating_mul(1_000);
        Some(turn_deadline_ms(
            self.turn_started_ms,
            street_start_ms,
            self.row.action_timeout_ms,
        ))
    }

    /// When the current round stops taking bets. Normally the round's scheduled close —
    /// but a player whose turn opened late in the round still gets `FAIR_TURN_MS` to act,
    /// borrowed from the quiet gap after the round. In the last round the borrowing stops
    /// short of the end, so bets are always shut for the final seconds before settlement.
    fn fair_close_ms(&self, rt: &FencedMatchRuntime, live_ms: u64) -> u64 {
        const FAIR_TURN_MS: u64 = 12_000;
        let close = rt.current_street_close_ms(live_ms);
        let round = rt.engine().round;
        if rt.engine().to_act.is_none() || round == 0 || round > rt.config().round_count {
            return close;
        }
        let street_start = live_ms + rt.street_start_offset_sec(round).saturating_mul(1_000);
        let gap_end = live_ms + rt.street_end_offset_sec(round).saturating_mul(1_000);
        let fair = self.turn_started_ms.max(street_start) + FAIR_TURN_MS;
        let keep_shut = if round == rt.config().round_count { 4_000 } else { 500 };
        close.max(fair.min(gap_end.saturating_sub(keep_shut)))
    }

    fn turn_view(&self) -> Option<Value> {
        if self.row.status != "live" {
            return None;
        }
        let rt = self.runtime.as_ref()?;
        let live_ms = self.row.live_start_ts.map(ts_ms)?;
        let engine = rt.engine();
        let idx = engine.to_act?;
        let turn_deadline = self.turn_deadline_ms(rt, live_ms)?;
        let street_close = self.fair_close_ms(rt, live_ms);
        let scheduled_end = self.row.scheduled_end_ts.map(ts_ms).unwrap_or(u64::MAX);
        let deadline = turn_deadline.min(street_close).min(scheduled_end);
        Some(json!({
            "seat": idx,
            "to_call": engine.to_call(idx),
            "min_raise_to": engine.current_bet + engine.big_blind.max(1),
            "deadline_ms": deadline,
            "round": engine.round,
            "head_hex": hex::encode(rt.head()),
        }))
    }

    async fn wallet_for_engine_seat(&self, seat: usize) -> Option<String> {
        self.seats()
            .await
            .ok()?
            .into_iter()
            .find(|s| s.engine_seat as usize == seat)
            .map(|s| s.wallet)
    }

    fn clock_round(&self) -> Option<u8> {
        let live_start = self.row.live_start_ts.map(ts_ms)?;
        let now = now_ms();
        if now < live_start || self.row.round_count == 0 {
            return None;
        }
        let elapsed_sec = now.saturating_sub(live_start) / 1_000;
        let mut offset = 0u64;
        for round in 1..=self.row.round_count {
            let idx = round.saturating_sub(1) as usize;
            let duration = self.row.round_durations_sec.get(idx).copied().unwrap_or(0);
            let observation = self
                .row
                .observation_windows_sec
                .get(idx)
                .copied()
                .unwrap_or(0);
            offset = offset.saturating_add(duration).saturating_add(observation);
            if elapsed_sec < offset {
                return Some(round);
            }
        }
        Some(self.row.round_count)
    }

    async fn on_deadline(&mut self) {
        match self.row.status.as_str() {
            "filling" => self.on_fill_deadline().await,
            "sealing" => self.on_seal_deadline().await,
            "live" => self.on_live_tick().await,
            _ => {}
        }
    }

    // ---- command dispatch --------------------------------------------------------

    async fn handle_cmd(&mut self, cmd: Cmd) {
        match cmd {
            Cmd::CandidatesChanged => self.evaluate_fill(false).await,
            Cmd::Poke => self.on_deadline().await,
            Cmd::Chain(event, row) => self.on_chain_event(event, *row).await,
            Cmd::Sealed { seat_index } => {
                self.broadcast(self.seal_status_frame(Some(seat_index)).await);
            }
            Cmd::Emote { wallet, emote } => {
                if self.seat_wallets.is_empty() {
                    if let Ok(seats) = self.seats().await {
                        self.seat_wallets = seats
                            .into_iter()
                            .map(|s| (s.engine_seat as usize, s.wallet))
                            .collect();
                    }
                }
                let seat = self
                    .seat_wallets
                    .iter()
                    .find(|(_, w)| **w == wallet)
                    .map(|(seat, _)| *seat);
                // One reaction per seat every two seconds keeps the table readable.
                let now = std::time::Instant::now();
                let fresh = seat.is_some_and(|s| {
                    self.last_emote
                        .get(&s)
                        .is_none_or(|at| now.duration_since(*at).as_millis() >= 2_000)
                });
                if let (Some(seat), true) = (seat, fresh) {
                    self.last_emote.insert(seat, now);
                    self.broadcast(json!({
                        "t": "emote",
                        "match_id": self.row.id.to_string(),
                        "seat_index": seat,
                        "emote": emote,
                    }));
                }
            }
            Cmd::SessionKey { wallet, key } => {
                let seat = self
                    .seat_wallets
                    .iter()
                    .find(|(_, w)| **w == wallet)
                    .map(|(seat, _)| *seat);
                if let (Some(seat), Some(rt)) = (seat, self.runtime.as_mut()) {
                    rt.set_session_key(seat, key);
                }
            }
            Cmd::Snapshot(reply) => {
                let _ = reply.send(self.view().await);
            }
            Cmd::LiveStats(reply) => {
                let engine = self.runtime.as_ref().map(|rt| rt.engine());
                let stats = LiveStats {
                    pot: engine.map(|e| e.seats.iter().map(|s| s.total_contribution).sum::<u64>()),
                    round: engine.map(|e| e.round),
                };
                let _ = reply.send(stats);
            }
            Cmd::Act { intent, reply } => {
                let result = self.apply_action(intent).await;
                let _ = reply.send(result);
            }
            Cmd::SetDefault { policy, reply } => {
                let result = self.register_default(policy).await;
                let _ = reply.send(result);
            }
        }
    }

    // ---- Filling ------------------------------------------------------------------

    /// Full → lock now; deadline+quorum → lock; deadline−quorum → void.
    async fn evaluate_fill(&mut self, deadline_hit: bool) {
        if self.row.status != "filling" {
            return;
        }
        let confirmed = match self.confirmed_candidates().await {
            Ok(c) => c,
            Err(e) => {
                warn!(match_id = %self.id, "confirmed load failed: {e}");
                return;
            }
        };
        if self.last_fill_broadcast_confirmed != Some(confirmed.len()) {
            self.last_fill_broadcast_confirmed = Some(confirmed.len());
            self.broadcast(json!({
                "v": 1, "t": "seat_update", "server_time_ms": now_ms(),
                "match_id": self.id, "confirmed": confirmed.len(),
            }));
            self.st.registry.lobby.publish(json!({
                "v": 1, "t": "lobby_delta", "server_time_ms": now_ms(),
                "kind": "upsert", "match_id": self.id, "confirmed": confirmed.len(),
                "max_players": self.row.max_players,
            }));
        }

        let full = confirmed.len() >= self.row.max_players as usize;
        let quorum = confirmed.len() >= self.row.min_players as usize;
        if full || (deadline_hit && quorum) {
            if let Err(e) = self.enqueue_lock(&confirmed).await {
                warn!(match_id = %self.id, "enqueue lock failed: {e}");
            }
        } else if deadline_hit {
            if let Err(e) = self.enqueue_job("void_before_start", json!({}), None).await {
                warn!(match_id = %self.id, "enqueue void failed: {e}");
            }
        }
    }

    async fn on_fill_deadline(&mut self) {
        // FCFS-promote whatever is finalized, then decide.
        if let Ok(client) = self.st.pool.get().await {
            let _ = client
                .execute(
                    db::FCFS_PROMOTE_SQL,
                    &[&self.id, &(self.row.max_players as i64)],
                )
                .await;
        }
        // This runs from BOTH the real fill-deadline timer and the sweeper `Poke` backstop.
        // Only treat the fill window as elapsed once now >= fill_deadline_ts — otherwise a
        // Poke would lock a merely quorum-met room (min ≤ n < max) long before its deadline.
        let deadline_hit = self
            .row
            .fill_deadline_ts
            .map(|d| now_ms() >= ts_ms(d))
            .unwrap_or(false);
        self.evaluate_fill(deadline_hit).await;
    }

    async fn confirmed_candidates(&self) -> Result<Vec<(String, i16)>, ApiError> {
        let client = self.st.pool.get().await?;
        let rows = client
            .query(
                "SELECT wallet, seat_index FROM seat_candidates
                 WHERE match_id = $1 AND status = 'confirmed' ORDER BY seat_index ASC",
                &[&self.id],
            )
            .await?;
        Ok(rows
            .iter()
            .map(|r| (r.get("wallet"), r.get::<_, i16>("seat_index")))
            .collect())
    }

    async fn enqueue_lock(&mut self, confirmed: &[(String, i16)]) -> Result<(), ApiError> {
        let payload = json!({
            "confirmed": confirmed.iter().map(|(wallet, seat)| json!({
                "wallet": wallet, "seat_index": seat,
            })).collect::<Vec<_>>(),
        });
        self.enqueue_job("lock", payload, None).await
    }

    async fn enqueue_job(
        &self,
        kind: &str,
        payload: Value,
        idempotency_suffix: Option<String>,
    ) -> Result<(), ApiError> {
        let key = match idempotency_suffix {
            Some(suffix) => format!("{}:{kind}:{suffix}", self.id),
            None => format!("{}:{kind}", self.id),
        };
        let client = self.st.pool.get().await?;
        client
            .execute(
                db::ENQUEUE_CHAIN_JOB_SQL,
                &[
                    &self.id,
                    &kind,
                    &key,
                    &payload,
                    &Option::<chrono::DateTime<chrono::Utc>>::None,
                ],
            )
            .await?;
        Ok(())
    }

    // ---- chain events ---------------------------------------------------------------

    async fn on_chain_event(&mut self, event: ChainEvent, row: MatchRow) {
        self.row = row;
        match event {
            ChainEvent::Locked { tx_sig } => {
                // Mark the losers (not_confirmed) + write confirmed seats to match_seats.
                if let Err(e) = self.materialize_confirmed_seats().await {
                    warn!(match_id = %self.id, "materialize seats: {e}");
                }
                let timelock_target = self.row.effective_timelock_target();
                self.broadcast(json!({
                    "v": 1, "t": "phase", "server_time_ms": now_ms(),
                    "match_id": self.id, "phase": "sealing",
                    "lock_confirmed": true,
                    "lock_tx_sig": tx_sig,
                    "seal_deadline": self.row.seal_deadline_ts.map(ts_ms),
                    "scheduled_end": self.row.projected_scheduled_end_ms(),
                    "projected_scheduled_end": self.row.projected_scheduled_end_ms(),
                    "timelock_target": timelock_target,
                }));
                self.st.registry.lobby.publish(json!({
                    "v": 1, "t": "lobby_delta", "server_time_ms": now_ms(),
                    "kind": "started", "match_id": self.id,
                }));
            }
            ChainEvent::LiveBegan => {
                let started = match self.start_engine().await {
                    Ok(started) => started,
                    Err(e) => {
                        warn!(match_id = %self.id, "engine start failed: {e}");
                        false
                    }
                };
                self.broadcast(json!({
                    "v": 1, "t": "phase", "server_time_ms": now_ms(),
                    "match_id": self.id, "phase": "live",
                    "live_start": self.row.live_start_ts.map(ts_ms),
                    "scheduled_end": self.row.scheduled_end_ts.map(ts_ms),
                    "button": self.row.button,
                }));
                if started {
                    self.broadcast_action_frame(0).await;
                }
                self.announce_turn().await;
            }
            ChainEvent::Settled => {
                let payouts = self.load_payout_view().await.unwrap_or_default();
                self.broadcast(json!({
                    "v": 1, "t": "settled", "server_time_ms": now_ms(),
                    "match_id": self.id, "payouts": payouts,
                }));
            }
            ChainEvent::Voided => {
                let settlement_failure =
                    crate::view::settlement_failure_view(&self.st, self.id).await;
                self.broadcast(json!({
                    "v": 1, "t": "voided", "server_time_ms": now_ms(),
                    "match_id": self.id, "kind": self.row.void_kind,
                    "settlement_failure": settlement_failure,
                }));
                self.st.registry.lobby.publish(json!({
                    "v": 1, "t": "lobby_delta", "server_time_ms": now_ms(),
                    "kind": "retired", "match_id": self.id,
                }));
            }
        }
    }

    /// After lock confirms: copy confirmed candidates into match_seats (engine order) and
    /// flip leftover candidates to not_confirmed (their refund is live on-chain now).
    async fn materialize_confirmed_seats(&self) -> Result<(), ApiError> {
        let mut client = self.st.pool.get().await?;
        let tx = client.transaction().await?;
        tx.execute(
            r#"
            INSERT INTO match_seats (match_id, seat_index, wallet_address, buy_in_chips, entry_fee_chips)
            SELECT match_id, seat_index, wallet, $2, $3
            FROM seat_candidates
            WHERE match_id = $1 AND status = 'confirmed'
            ON CONFLICT (match_id, seat_index) DO NOTHING
            "#,
            &[
                &self.id,
                &(self.row.buy_in as i64),
                &(self.row.entry_fee as i64),
            ],
        )
        .await?;
        tx.execute(
            "UPDATE match_seats SET engine_seat = seat_index WHERE match_id = $1",
            &[&self.id],
        )
        .await?;
        tx.execute(
            r#"
            UPDATE seat_candidates SET status = 'not_confirmed'
            WHERE match_id = $1 AND status IN ('reported', 'candidate')
            "#,
            &[&self.id],
        )
        .await?;
        tx.commit().await?;
        Ok(())
    }

    // ---- Sealing --------------------------------------------------------------------

    async fn on_seal_deadline(&mut self) {
        // Snapshot the signed spot price for non-sealers, assign seal_seqs, enqueue
        // begin_live. Idempotent: the snapshot has a UNIQUE(match_id, kind) and the job
        // an idempotency key.
        if let Err(e) = self.seal_close().await {
            warn!(match_id = %self.id, "seal close failed (retrying next tick): {e}");
            // Backstop: the sweeper pokes us again; the chain-side begin_live window is
            // the hard bound (past it, void_before_start refunds everyone).
            tokio::time::sleep(std::time::Duration::from_millis(500)).await;
            return;
        }
        // Move local status forward so the deadline loop stops re-firing; the authoritative
        // 'live' flip arrives with ChainEvent::LiveBegan.
        self.row.status = "sealing_closed".into();
    }

    async fn seal_close(&mut self) -> Result<(), ApiError> {
        let deadline_sec = self
            .row
            .seal_deadline_ts
            .map(|t| t.timestamp().max(0) as u64)
            .unwrap_or_else(crate::util::now_sec);
        let symbol = crate::config::feed_oracle_symbol(&self.row.feed_symbol).unwrap_or("BTCUSD");
        let tick = self
            .st
            .price
            .price_at(symbol, deadline_sec)
            .await
            .map_err(ApiError::internal)?;

        let client = self.st.pool.get().await?;
        client
            .execute(
                r#"
                INSERT INTO price_snapshots (match_id, kind, feed_symbol, price, exponent, price_ts, signed_payload)
                VALUES ($1, 'seal_close', $2, $3::text::numeric, $4, to_timestamp($5::double precision), $6)
                ON CONFLICT (match_id, kind) DO NOTHING
                "#,
                &[
                    &self.id,
                    &self.row.feed_symbol,
                    &tick.price,
                    &crate::price::PRICE_EXPO,
                    &(tick.timestamp_ms as f64 / 1000.0),
                    &tick.raw,
                ],
            )
            .await?;

        // seal_seq: sealers by arrival (already set at seal time); non-sealers get
        // sealed_count + seat_index (deterministically later than every sealer).
        client
            .execute(
                r#"
                WITH sealed_count AS (
                    SELECT count(*) AS n FROM match_seats WHERE match_id = $1 AND sealed
                )
                UPDATE match_seats ms
                SET prediction_source = 'spot',
                    seal_seq = (SELECT n FROM sealed_count)::smallint + ms.seat_index
                WHERE ms.match_id = $1 AND NOT ms.sealed
                "#,
                &[&self.id],
            )
            .await?;

        // begin_live with the confirmed players in engine order.
        let seats = self.seats().await?;
        let players: Vec<Value> = seats.iter().map(|s| json!(s.wallet)).collect();
        self.enqueue_job("begin_live", json!({ "players": players }), None)
            .await?;
        self.broadcast(json!({
            "v": 1, "t": "seal_status", "server_time_ms": now_ms(),
            "match_id": self.id, "closed": true,
        }));
        Ok(())
    }

    async fn seats(&self) -> Result<Vec<SeatRow>, ApiError> {
        let client = self.st.pool.get().await?;
        db::load_seats(&client, self.id).await
    }

    async fn seal_status_frame(&self, just_sealed: Option<u8>) -> Value {
        let sealed: Vec<u8> = match self.seats().await {
            Ok(seats) => seats
                .iter()
                .filter(|s| s.sealed)
                .map(|s| s.engine_seat)
                .collect(),
            Err(_) => Vec::new(),
        };
        json!({
            "v": 1, "t": "seal_status", "server_time_ms": now_ms(),
            "match_id": self.id, "sealed": sealed, "just_sealed": just_sealed,
            "deadline_ms": self.row.seal_deadline_ts.map(ts_ms),
        })
    }

    // ---- Live -----------------------------------------------------------------------

    async fn start_engine(&mut self) -> Result<bool, ApiError> {
        if self.runtime.is_some() {
            return Ok(false);
        }
        let seats = self.seats().await?;
        let players: Vec<(PlayerId, u64, u64)> = seats
            .iter()
            .map(|s| {
                (
                    PlayerId(s.engine_seat as u16),
                    s.buy_in,
                    s.seal_seq.unwrap_or(s.engine_seat as u16) as u64,
                )
            })
            .collect();
        let config = RuntimeConfig {
            match_id: self.id.to_string(),
            onchain_match_id: self.row.onchain_match_id,
            players,
            button: self.row.button.unwrap_or(0) as usize,
            small_blind: self.row.small_blind,
            big_blind: self.row.big_blind,
            ante: crate::config::derive_ante(self.row.buy_in),
            round_count: self.row.round_count,
            round_durations_sec: self.row.round_durations_sec.clone(),
            observation_windows_sec: self.row.observation_windows_sec.clone(),
            action_timeout_ms: self.row.action_timeout_ms,
            time_bank_sec: self.row.time_bank_sec,
            lease_ttl_ms: LEASE_TTL_MS,
        };
        let lease = self
            .st
            .store
            .acquire_lease(
                &self.id.to_string(),
                &self.st.cfg.node_id,
                now_ms(),
                LEASE_TTL_MS,
            )
            .await
            .map_err(ApiError::internal)?;
        let runtime = FencedMatchRuntime::start(config, lease);
        // Persist the genesis events (MatchStarted etc.) the runtime just wrote.
        for envelope in runtime.events().to_vec() {
            self.persist(&runtime, &envelope).await?;
        }
        self.runtime = Some(runtime);
        self.turn_started_ms = now_ms();
        Ok(true)
    }

    /// Recovery after restart: rebuild the engine by replaying the persisted log.
    async fn recover_live(&mut self) -> Result<(), ApiError> {
        let events = crate::chainjobs::load_events(&self.st.pool, self.id).await?;
        if events.is_empty() {
            self.start_engine().await?;
            return Ok(());
        }
        let snapshot = FencedMatchRuntime::replay(&events)
            .map_err(|e| ApiError::internal(format!("{e:?}")))?;
        let lease = self
            .st
            .store
            .acquire_lease(
                &self.id.to_string(),
                &self.st.cfg.node_id,
                now_ms(),
                LEASE_TTL_MS,
            )
            .await
            .map_err(ApiError::internal)?;
        self.runtime = Some(FencedMatchRuntime::from_snapshot(snapshot, lease));
        self.turn_started_ms = now_ms();
        Ok(())
    }

    async fn on_live_tick(&mut self) {
        let Some(live_start) = self.row.live_start_ts.map(ts_ms) else {
            return;
        };
        let now = now_ms();
        let end = self.row.scheduled_end_ts.map(ts_ms).unwrap_or(u64::MAX);

        if now >= end {
            self.finish_live().await;
            return;
        }
        let Some(rt) = self.runtime.as_ref() else {
            return;
        };
        // Street close: force-resolve outstanding turns.
        let street_close = self.fair_close_ms(rt, live_start);
        if now >= street_close {
            let Some(rt) = self.runtime.as_mut() else {
                return;
            };
            let seq_before = rt.events().len();
            if let Err(e) = rt.force_resolve_street(&ActorLease, now) {
                warn!(match_id = %self.id, "force_resolve_street: {e:?}");
            }
            self.flush_events(seq_before).await;
            self.broadcast_action_frame(seq_before).await;
            self.turn_started_ms = now;
            self.announce_turn().await;
            return;
        }
        // Per-turn timeout → default action.
        let timeout = rt.engine().to_act.and_then(|idx| {
            self.turn_deadline_ms(rt, live_start)
                .map(|deadline| (idx, deadline))
        });
        if let Some((idx, deadline)) = timeout {
            if now < deadline {
                return;
            }
            let policy = self
                .defaults
                .get(&idx)
                .copied()
                .unwrap_or(DefaultAction::CheckFold);
            let Some(rt) = self.runtime.as_mut() else {
                return;
            };
            let seq_before = rt.events().len();
            if let Err(e) = rt.apply_timeout_default(&ActorLease, now, idx, policy, deadline) {
                warn!(match_id = %self.id, seat = idx, "timeout default: {e:?}");
            }
            self.flush_events(seq_before).await;
            self.broadcast_action_frame(seq_before).await;
            self.turn_started_ms = now;
            self.announce_turn().await;
        }
    }

    /// Match end: force the engine to completion and enqueue settlement pinned to the
    /// final event root.
    async fn finish_live(&mut self) {
        if self.runtime.is_none() {
            return;
        }
        let now = now_ms();
        let (seq_before, root) = {
            let rt = self.runtime.as_mut().expect("checked above");
            let seq_before = rt.events().len();
            if !rt.engine().is_complete() {
                if let Err(e) = rt.force_resolve_street(&ActorLease, now) {
                    warn!(match_id = %self.id, "final resolve: {e:?}");
                }
            }
            let _ = rt.write_snapshot_marker();
            (seq_before, rt.head())
        };
        self.flush_events(seq_before).await;
        self.broadcast_action_frame(seq_before).await;
        let key_suffix = format!("root-{}", hex::encode(root));
        if let Err(e) = self
            .enqueue_job("submit_settlement", json!({}), Some(key_suffix))
            .await
        {
            warn!(match_id = %self.id, "enqueue settlement: {e}");
            return;
        }
        // Pre-schedule the capital-safety backstop.
        let not_before = self
            .row
            .scheduled_end_ts
            .map(|t| t + chrono::Duration::seconds(300));
        let client = match self.st.pool.get().await {
            Ok(c) => c,
            Err(_) => return,
        };
        let _ = client
            .execute(
                db::ENQUEUE_CHAIN_JOB_SQL,
                &[
                    &self.id,
                    &"void_live_after_deadline",
                    &format!("{}:void_live_after_deadline", self.id),
                    &json!({}),
                    &not_before,
                ],
            )
            .await;
        self.row.status = "settlement_pending".into();
        self.broadcast(json!({
            "v": 1, "t": "phase", "server_time_ms": now_ms(),
            "match_id": self.id, "phase": "settlement_pending",
        }));
    }

    // ---- gameplay --------------------------------------------------------------------

    /// Gate for every gameplay frame: the authenticated wallet must own the seat it is
    /// acting for. Without this, any signed-in wallet could send a correctly signed (by
    /// its OWN key) intent naming someone else's seat — fold them, or shove their stack.
    /// Also installs the seat's session key (if the wallet granted one) into the runtime.
    async fn authorize_seat(&mut self, seat_index: usize, wallet: &str) -> Result<(), ApiError> {
        if self.seat_wallets.is_empty() {
            self.seat_wallets = self
                .seats()
                .await?
                .into_iter()
                .map(|s| (s.engine_seat as usize, s.wallet))
                .collect();
        }
        if !seat_owned_by(&self.seat_wallets, seat_index, wallet) {
            return Err(ApiError::forbidden(
                "not_your_seat",
                "this wallet does not hold that seat",
            ));
        }
        let needs_key = self
            .runtime
            .as_ref()
            .is_some_and(|rt| !rt.has_session_key(seat_index));
        if needs_key {
            let key = crate::db::load_session_key(&self.st.pool, self.id, wallet).await;
            if let (Some(key), Some(rt)) = (key, self.runtime.as_mut()) {
                rt.set_session_key(seat_index, key);
            }
        }
        Ok(())
    }

    async fn apply_action(&mut self, intent: SignedActionIntent) -> Result<Value, ApiError> {
        if self.row.status != "live" {
            return Err(ApiError::conflict("not_live", "match is not live"));
        }
        self.authorize_seat(intent.seat_index, &intent.wallet)
            .await?;
        let live_start = self.row.live_start_ts.map(ts_ms).unwrap_or(0);
        let fair_close = self
            .runtime
            .as_ref()
            .map(|rt| self.fair_close_ms(rt, live_start))
            .unwrap_or(0);
        let rt = self
            .runtime
            .as_mut()
            .ok_or_else(|| ApiError::internal("engine not started"))?;
        let now = now_ms();
        let street_open = live_start
            + rt.street_start_offset_sec(rt.engine().round.max(1))
                .saturating_mul(1_000);
        if !(rt.betting_open(live_start, now) || (now >= street_open && now < fair_close)) {
            return Err(ApiError::conflict(
                "betting_closed",
                "street is in observation",
            ));
        }
        let seq_before = rt.events().len();
        rt.apply_signed_action(&ActorLease, now_ms(), intent)
            .map_err(|e| ApiError::conflict("bad_action", format!("{e:?}")))?;
        self.flush_events(seq_before).await;
        self.turn_started_ms = now_ms();
        let frame = self.action_frame(seq_before).await;
        self.broadcast(frame.clone());
        self.announce_turn().await;
        Ok(frame)
    }

    async fn register_default(&mut self, policy: SignedDefaultPolicy) -> Result<(), ApiError> {
        self.authorize_seat(policy.seat_index, &policy.wallet)
            .await?;
        let rt = self
            .runtime
            .as_mut()
            .ok_or_else(|| ApiError::conflict("not_live", "match is not live"))?;
        let seat = policy.seat_index;
        let seq_before = rt.events().len();
        rt.register_default_policy(&ActorLease, now_ms(), policy.clone())
            .map_err(|e| ApiError::conflict("bad_default", format!("{e:?}")))?;
        self.defaults.insert(seat, policy.policy);
        self.flush_events(seq_before).await;
        self.broadcast_action_frame(seq_before).await;
        Ok(())
    }

    /// Persist every engine event appended since `seq_before` and broadcast actions with
    /// the live feed-price stamp.
    async fn flush_events(&mut self, seq_before: usize) {
        let Some(rt) = self.runtime.as_ref() else {
            return;
        };
        let new: Vec<_> = rt.events()[seq_before..].to_vec();
        for envelope in &new {
            if let Err(e) = self.persist(rt, envelope).await {
                // A rejected append (fencing/hash) is fatal for consistency — freeze.
                warn!(match_id = %self.id, seq = envelope.seq, "append failed: {e}");
            }
        }
    }

    async fn persist(
        &self,
        rt: &FencedMatchRuntime,
        envelope: &syndicate_engine::service::EventEnvelope,
    ) -> Result<(), ApiError> {
        self.st
            .store
            .append_event(rt, envelope)
            .await
            .map(|_| ())
            .map_err(ApiError::internal)?;
        // Bet-price display stamp (side columns, outside the hash chain).
        if matches!(
            envelope.event,
            EngineLogEvent::PlayerAction { .. } | EngineLogEvent::TimeoutDefaultApplied { .. }
        ) {
            if let Some(tick) = self.st.price.latest(
                crate::config::feed_oracle_symbol(&self.row.feed_symbol).unwrap_or("BTCUSD"),
            ) {
                if let Ok(client) = self.st.pool.get().await {
                    let _ = client
                        .execute(
                            r#"UPDATE match_events
                               SET feed_price = $3::text::numeric, feed_price_expo = $4,
                                   feed_price_ts = to_timestamp($5::double precision)
                               WHERE match_id = $1 AND seq = $2"#,
                            &[
                                &self.id,
                                &(envelope.seq as i64),
                                &tick.price,
                                &crate::price::PRICE_EXPO,
                                &(tick.timestamp_ms as f64 / 1000.0),
                            ],
                        )
                        .await;
                }
            }
        }
        Ok(())
    }

    async fn action_frame(&self, seq_before: usize) -> Value {
        let Some(rt) = self.runtime.as_ref() else {
            return Value::Null;
        };
        let engine = rt.engine();
        let last = rt.events()[seq_before..]
            .iter()
            .map(crate::view::public_event)
            .collect::<Vec<_>>();
        let tick = self
            .st
            .price
            .latest(crate::config::feed_oracle_symbol(&self.row.feed_symbol).unwrap_or("BTCUSD"));
        json!({
            "v": 1, "t": "action", "server_time_ms": now_ms(),
            "match_id": self.id,
            "seq": rt.next_seq(),
            "events": last,
            "pot": engine.seats.iter().map(|s| s.total_contribution).sum::<u64>(),
            "current_bet": engine.current_bet,
            "to_act": engine.to_act,
            "round": engine.round,
            "clock_round": self.clock_round(),
            "feed_price": tick.as_ref().map(|t| t.price.clone()),
            "feed_price_expo": crate::price::PRICE_EXPO,
            "feed_price_ts": tick.as_ref().map(|t| t.timestamp_ms),
            "head_hex": hex::encode(rt.head()),
        })
    }

    async fn broadcast_action_frame(&self, seq_before: usize) {
        let Some(rt) = self.runtime.as_ref() else {
            return;
        };
        if rt.events().len() <= seq_before {
            return;
        }
        self.broadcast(self.action_frame(seq_before).await);
    }

    async fn announce_turn(&mut self) {
        let Some(turn) = self.turn_view() else {
            return;
        };
        let mut public = turn.clone();
        if let Some(obj) = public.as_object_mut() {
            obj.insert("v".into(), json!(1));
            obj.insert("t".into(), json!("turn_update"));
            obj.insert("server_time_ms".into(), json!(now_ms()));
            obj.insert("match_id".into(), json!(self.id));
        }
        self.broadcast(public);

        let Some(seat) = turn.get("seat").and_then(Value::as_u64).map(|v| v as usize) else {
            return;
        };
        let Some(wallet) = self.wallet_for_engine_seat(seat).await else {
            return;
        };
        let mut private = turn;
        if let Some(obj) = private.as_object_mut() {
            obj.insert("v".into(), json!(1));
            obj.insert("t".into(), json!("your_turn"));
            obj.insert("server_time_ms".into(), json!(now_ms()));
            obj.insert("match_id".into(), json!(self.id));
            obj.insert("_to_wallet".into(), json!(wallet));
        }
        self.broadcast(private);
    }

    // ---- views ------------------------------------------------------------------------

    async fn view(&self) -> Value {
        let mut view = crate::view::match_view(&self.st, &self.row, self.runtime.as_ref()).await;
        if let Some(obj) = view.as_object_mut() {
            let turn = self.turn_view().unwrap_or(Value::Null);
            obj.insert("open_turn".into(), turn.clone());
            obj.insert("turn".into(), turn);
        }
        view
    }

    async fn load_payout_view(&self) -> Result<Vec<Value>, ApiError> {
        let seats = self.seats().await?;
        // Payouts live on-chain (seat accounts); the UI's claimables endpoint reads them.
        Ok(seats
            .iter()
            .map(|s| json!({ "seat": s.engine_seat, "wallet": s.wallet }))
            .collect())
    }

    fn broadcast(&self, frame: Value) {
        let _ = self.events.send(Arc::new(frame));
    }
}

fn seat_owned_by(seat_wallets: &HashMap<usize, String>, seat_index: usize, wallet: &str) -> bool {
    seat_wallets.get(&seat_index).is_some_and(|w| w == wallet)
}

fn turn_deadline_ms(turn_started_ms: u64, street_start_ms: u64, action_timeout_ms: u64) -> u64 {
    turn_started_ms
        .max(street_start_ms)
        .saturating_add(action_timeout_ms)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_seat_owner_may_act_for_a_seat() {
        let seats: HashMap<usize, String> =
            [(0, "alice".to_string()), (1, "bob".to_string())].into();
        assert!(seat_owned_by(&seats, 0, "alice"));
        assert!(seat_owned_by(&seats, 1, "bob"));
        // A signed-in outsider, or another player, naming someone else's seat.
        assert!(!seat_owned_by(&seats, 0, "mallory"));
        assert!(!seat_owned_by(&seats, 0, "bob"));
        // Unknown seat.
        assert!(!seat_owned_by(&seats, 7, "alice"));
    }

    #[test]
    fn turn_timeout_waits_for_street_open_after_early_advance() {
        let turn_started_ms = 1_000;
        let raw_deadline = turn_started_ms + 25_000;
        let next_street_open_ms = 200_000;

        let deadline = turn_deadline_ms(turn_started_ms, next_street_open_ms, 25_000);

        assert!(raw_deadline < next_street_open_ms);
        assert_eq!(deadline, 225_000);
    }
}
