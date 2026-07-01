//! Postgres-backed match persistence and settlement enqueue.

use deadpool_postgres::{Config, Pool, Runtime};
use serde_json::{json, Value};
use tokio_postgres::Row;

use syndicate_store::{
    ACQUIRE_MATCH_LEASE_SQL, APPEND_MATCH_EVENT_WITH_OUTBOX_SQL, ENQUEUE_SETTLEMENT_REQUEST_SQL,
    INSERT_MATCH_SNAPSHOT_SQL, LOAD_LATEST_MATCH_SNAPSHOT_SQL, LOAD_MATCH_EVENTS_AFTER_SQL,
    LOAD_MATCH_SETTLEMENT_CONTEXT_SQL, RENEW_MATCH_LEASE_SQL,
};

use crate::service::MatchLease;

use crate::service::{
    EngineLogEvent, EventEnvelope, FencedMatchRuntime, MatchConfig, MatchServiceError,
    SignedActionIntent, SignedDefaultPolicy, SignedPredictionCommitment,
};

#[derive(Clone, Debug)]
pub struct PostgresMatchStore {
    pool: Pool,
    node_id: String,
}

#[derive(Clone, Debug)]
pub struct SettlementContext {
    pub match_id: String,
    pub event_root: [u8; 32],
    pub scheduled_end_ts: u64,
    pub pyth_feed_id: [u8; 32],
    pub oracle_exponent: i32,
    pub max_oracle_confidence: u64,
    pub rake_bps: u32,
    pub rake_cap: u64,
}

#[derive(Clone, Debug)]
pub struct PersistedMatchEvent {
    pub seq: u64,
    pub event_type: String,
    pub payload: Value,
    pub prev_hash: [u8; 32],
    pub hash: [u8; 32],
    pub owner_fencing_token: u64,
}

#[derive(Debug)]
pub enum PersistenceError {
    Pool(String),
    Postgres(String),
    Service(MatchServiceError),
    Invalid(String),
}

impl std::fmt::Display for PersistenceError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            PersistenceError::Pool(e) => write!(f, "pool: {e}"),
            PersistenceError::Postgres(e) => write!(f, "postgres: {e}"),
            PersistenceError::Service(e) => write!(f, "service: {e:?}"),
            PersistenceError::Invalid(e) => write!(f, "invalid: {e}"),
        }
    }
}

impl std::error::Error for PersistenceError {}

impl From<MatchServiceError> for PersistenceError {
    fn from(value: MatchServiceError) -> Self {
        PersistenceError::Service(value)
    }
}

impl PostgresMatchStore {
    pub fn from_url(
        database_url: &str,
        node_id: impl Into<String>,
    ) -> Result<Self, PersistenceError> {
        let mut cfg = Config::new();
        cfg.url = Some(database_url.to_string());
        let pool = cfg
            .create_pool(Some(Runtime::Tokio1), tokio_postgres::NoTls)
            .map_err(|e| PersistenceError::Pool(e.to_string()))?;
        Ok(Self {
            pool,
            node_id: node_id.into(),
        })
    }

    pub fn pool(&self) -> &Pool {
        &self.pool
    }

    pub fn node_id(&self) -> &str {
        &self.node_id
    }

    /// Acquire a match lease via Postgres (production path).
    pub async fn acquire_lease(
        &self,
        match_id: &str,
        owner_id: &str,
        now_ms: u64,
        ttl_ms: u64,
    ) -> Result<MatchLease, PersistenceError> {
        let match_uuid = self.resolve_match_uuid(match_id).await?;
        let now = chrono::DateTime::from_timestamp_millis(now_ms as i64)
            .ok_or_else(|| PersistenceError::Invalid("invalid now_ms".into()))?;
        let client = self.pool.get().await.map_err(map_pool)?;
        let row = client
            .query_opt(
                ACQUIRE_MATCH_LEASE_SQL,
                &[&match_uuid, &owner_id, &now, &(ttl_ms as i64)],
            )
            .await
            .map_err(map_pg)?;
        let Some(row) = row else {
            return Err(PersistenceError::Invalid(
                "lease held by another node".into(),
            ));
        };
        let fencing_token: i64 = row.get("owner_fencing_token");
        let expires_at: chrono::DateTime<chrono::Utc> = row.get("owner_lease_expires_at");
        Ok(MatchLease {
            match_id: match_id.to_string(),
            owner_id: owner_id.to_string(),
            fencing_token: fencing_token as u64,
            expires_at_ms: expires_at.timestamp_millis() as u64,
        })
    }

    pub async fn renew_lease(
        &self,
        lease: &MatchLease,
        now_ms: u64,
        ttl_ms: u64,
    ) -> Result<MatchLease, PersistenceError> {
        let match_uuid = self.resolve_match_uuid(&lease.match_id).await?;
        let now = chrono::DateTime::from_timestamp_millis(now_ms as i64)
            .ok_or_else(|| PersistenceError::Invalid("invalid now_ms".into()))?;
        let client = self.pool.get().await.map_err(map_pool)?;
        let row = client
            .query_opt(
                RENEW_MATCH_LEASE_SQL,
                &[
                    &match_uuid,
                    &lease.owner_id,
                    &(lease.fencing_token as i64),
                    &now,
                    &(ttl_ms as i64),
                ],
            )
            .await
            .map_err(map_pg)?;
        let Some(row) = row else {
            return Err(PersistenceError::Invalid("lease renew failed".into()));
        };
        let expires_at: chrono::DateTime<chrono::Utc> = row.get("owner_lease_expires_at");
        Ok(MatchLease {
            expires_at_ms: expires_at.timestamp_millis() as u64,
            ..lease.clone()
        })
    }

    pub async fn append_event(
        &self,
        runtime: &FencedMatchRuntime,
        envelope: &EventEnvelope,
    ) -> Result<String, PersistenceError> {
        let mut payload = event_payload(&envelope.event)?;
        if let Some(obj) = payload.as_object_mut() {
            obj.insert("seq".to_string(), serde_json::json!(envelope.seq));
            obj.insert(
                "ts".to_string(),
                serde_json::json!(chrono::Utc::now().timestamp_millis()),
            );
        }
        let event_type = event_type_name(&envelope.event);
        let now = chrono_now();
        let match_uuid = self.resolve_match_uuid(&runtime.config().match_id).await?;
        let client = self.pool.get().await.map_err(map_pool)?;
        let row = client
            .query_opt(
                APPEND_MATCH_EVENT_WITH_OUTBOX_SQL,
                &[
                    &match_uuid,
                    &self.node_id,
                    &(runtime.lease().fencing_token as i64),
                    &now,
                    &(envelope.seq as i64),
                    &envelope.prev_hash.as_slice(),
                    &event_type,
                    &payload,
                    &envelope.hash.as_slice(),
                    &self.node_id,
                ],
            )
            .await
            .map_err(map_pg)?;
        let Some(row) = row else {
            return Err(PersistenceError::Invalid(
                "append rejected: stale seq/hash or lease lost".into(),
            ));
        };
        Ok(row.get::<_, uuid::Uuid>("outbox_id").to_string())
    }

    pub async fn persist_snapshot(
        &self,
        runtime: &FencedMatchRuntime,
        snapshot_payload: Value,
    ) -> Result<(), PersistenceError> {
        let snapshot = runtime.snapshot();
        let match_uuid = self.resolve_match_uuid(&runtime.config().match_id).await?;
        let client = self.pool.get().await.map_err(map_pool)?;
        client
            .execute(
                INSERT_MATCH_SNAPSHOT_SQL,
                &[
                    &match_uuid,
                    &((snapshot.next_seq.saturating_sub(1)) as i64),
                    &snapshot.head.as_slice(),
                    &(runtime.lease().fencing_token as i64),
                    &snapshot_payload,
                ],
            )
            .await
            .map_err(map_pg)?;
        Ok(())
    }

    pub async fn enqueue_settlement(
        &self,
        match_id: &str,
        event_root: &[u8; 32],
        context: &SettlementContext,
    ) -> Result<String, PersistenceError> {
        let payload = serde_json::json!({
            "match_id": match_id,
            "event_root": hex::encode(event_root),
            "scheduled_end_ts": context.scheduled_end_ts,
            "pyth_feed_id": hex::encode(context.pyth_feed_id),
            "oracle_exponent": context.oracle_exponent,
            "max_oracle_confidence": context.max_oracle_confidence,
            "rake_bps": context.rake_bps,
            "rake_cap": context.rake_cap,
        });
        let match_uuid = self.resolve_match_uuid(match_id).await?;
        let client = self.pool.get().await.map_err(map_pool)?;
        let row = client
            .query_one(ENQUEUE_SETTLEMENT_REQUEST_SQL, &[&match_uuid, &payload])
            .await
            .map_err(map_pg)?;
        Ok(row.get::<_, String>("id"))
    }

    pub async fn load_settlement_context(
        &self,
        match_id: &str,
    ) -> Result<SettlementContext, PersistenceError> {
        let match_uuid = self.resolve_match_uuid(match_id).await?;
        let client = self.pool.get().await.map_err(map_pool)?;
        let row = client
            .query_one(LOAD_MATCH_SETTLEMENT_CONTEXT_SQL, &[&match_uuid.to_string()])
            .await
            .map_err(map_pg)?;
        let mut context = row_to_settlement_context(&row)?;
        context.match_id = match_id.to_string();
        Ok(context)
    }

    pub async fn load_replay_events(
        &self,
        match_id: &str,
    ) -> Result<Vec<PersistedMatchEvent>, PersistenceError> {
        let match_uuid = self.resolve_match_uuid(match_id).await?;
        let client = self.pool.get().await.map_err(map_pool)?;
        let snapshot_seq: i64 = match client
            .query_opt(LOAD_LATEST_MATCH_SNAPSHOT_SQL, &[&match_uuid])
            .await
            .map_err(map_pg)?
        {
            Some(row) => row.get("last_seq"),
            None => -1,
        };
        let rows = client
            .query(LOAD_MATCH_EVENTS_AFTER_SQL, &[&match_uuid, &snapshot_seq])
            .await
            .map_err(map_pg)?;
        rows.iter().map(row_to_persisted_event).collect()
    }

    async fn resolve_match_uuid(&self, match_id: &str) -> Result<uuid::Uuid, PersistenceError> {
        if let Ok(id) = uuid::Uuid::parse_str(match_id) {
            return Ok(id);
        }
        let client = self.pool.get().await.map_err(map_pool)?;
        let row = client
            .query_opt(
                r#"
                SELECT id
                FROM matches
                WHERE match_key = $1 OR onchain_match_id::text = $1
                LIMIT 1
                "#,
                &[&match_id],
            )
            .await
            .map_err(map_pg)?;
        row.map(|r| r.get("id")).ok_or_else(|| {
            PersistenceError::Invalid(format!("match not found for protocol match id: {match_id}"))
        })
    }
}

fn row_to_settlement_context(row: &Row) -> Result<SettlementContext, PersistenceError> {
    let feed: Vec<u8> = row.get("pyth_feed_id");
    if feed.len() != 32 {
        return Err(PersistenceError::Invalid(format!(
            "pyth_feed_id must be 32 bytes, got {}",
            feed.len()
        )));
    }
    let mut pyth_feed_id = [0u8; 32];
    pyth_feed_id.copy_from_slice(&feed);
    let event_root: Vec<u8> = row.get("event_head");
    if event_root.len() != 32 {
        return Err(PersistenceError::Invalid(format!(
            "event_head must be 32 bytes, got {}",
            event_root.len()
        )));
    }
    let mut root = [0u8; 32];
    root.copy_from_slice(&event_root);
    Ok(SettlementContext {
        match_id: row.get("id"),
        event_root: root,
        scheduled_end_ts: row.get::<_, i64>("scheduled_end_ts_sec") as u64,
        pyth_feed_id,
        oracle_exponent: row.get::<_, i16>("oracle_exponent") as i32,
        max_oracle_confidence: row.get::<_, i64>("max_oracle_confidence") as u64,
        rake_bps: row.get::<_, i32>("rake_bps") as u32,
        rake_cap: row.get::<_, i64>("rake_cap_chips") as u64,
    })
}

fn row_to_persisted_event(row: &Row) -> Result<PersistedMatchEvent, PersistenceError> {
    let prev: Vec<u8> = row.get("prev_hash");
    let hash: Vec<u8> = row.get("hash");
    if prev.len() != 32 || hash.len() != 32 {
        return Err(PersistenceError::Invalid(
            "event hash must be 32 bytes".into(),
        ));
    }
    let mut prev_hash = [0u8; 32];
    let mut event_hash = [0u8; 32];
    prev_hash.copy_from_slice(&prev);
    event_hash.copy_from_slice(&hash);
    Ok(PersistedMatchEvent {
        seq: row.get::<_, i64>("seq") as u64,
        event_type: row.get("event_type"),
        payload: row.get("payload"),
        prev_hash,
        hash: event_hash,
        owner_fencing_token: row.get::<_, i64>("owner_fencing_token") as u64,
    })
}

fn event_type_name(event: &EngineLogEvent) -> &'static str {
    match event {
        EngineLogEvent::MatchStarted { .. } => "match.started",
        EngineLogEvent::PlayerAction { .. } => "player.action",
        EngineLogEvent::TimeoutDefaultApplied { .. } => "timeout.default",
        EngineLogEvent::DefaultPolicyRegistered { .. } => "default.registered",
        EngineLogEvent::SnapshotWritten { .. } => "snapshot.written",
        EngineLogEvent::PredictionSealed { .. } => "prediction.sealed",
        EngineLogEvent::MatchCompleted { .. } => "match.completed",
    }
}

fn event_payload(event: &EngineLogEvent) -> Result<Value, PersistenceError> {
    Ok(match event {
        EngineLogEvent::MatchStarted { config } => json!({
            "kind": "match.started",
            "match_id": config.match_id,
            "onchain_match_id": config.onchain_match_id,
            "button": config.button,
            "small_blind": config.small_blind,
            "big_blind": config.big_blind,
            "round_count": config.round_count,
            "round_durations_sec": config.round_durations_sec,
            "observation_windows_sec": config.observation_windows_sec,
            "action_timeout_ms": config.action_timeout_ms,
            "time_bank_sec": config.time_bank_sec,
            "lease_ttl_ms": config.lease_ttl_ms,
            "players": config.players.iter().map(|(id, stack, seal)| json!({
                "player_id": id.0,
                "stack": stack,
                "seal_seq": seal,
            })).collect::<Vec<_>>(),
        }),
        EngineLogEvent::PlayerAction { intent } => json!({
            "kind": "player.action",
            "seat_index": intent.seat_index,
            "wallet": intent.wallet,
            "nonce": intent.nonce,
            "prev_head": hex::encode(intent.prev_head),
            "signature": intent.signature,
            "action": format!("{:?}", intent.action),
        }),
        EngineLogEvent::DefaultPolicyRegistered { policy } => json!({
            "kind": "default.registered",
            "seat_index": policy.seat_index,
            "wallet": policy.wallet,
            "policy": format!("{:?}", policy.policy),
            "signature": policy.signature,
        }),
        EngineLogEvent::TimeoutDefaultApplied {
            seat_index,
            default,
            deadline_ms,
            fired_at_ms,
        } => json!({
            "kind": "timeout.default",
            "seat_index": seat_index,
            "default": format!("{default:?}"),
            "deadline_ms": deadline_ms,
            "fired_at_ms": fired_at_ms,
        }),
        EngineLogEvent::SnapshotWritten { round, phase } => json!({
            "kind": "snapshot.written",
            "round": round,
            "phase": format!("{phase:?}"),
        }),
        EngineLogEvent::PredictionSealed {
            player_id,
            target_round,
            ciphertext,
            commitment,
        } => json!({
            "kind": "prediction.sealed",
            "player_id": player_id,
            "target_round": target_round,
            "ciphertext": hex::encode(ciphertext),
            "wallet": commitment.wallet,
            "seal_seq": commitment.seal_seq,
            "commitment": hex::encode(commitment.commitment),
            "blinding": hex::encode(commitment.blinding),
            "commitment_signature": commitment.signature,
        }),
        EngineLogEvent::MatchCompleted {
            event_root,
            timelock_target_round,
        } => json!({
            "kind": "match.completed",
            "event_root": event_root,
            "timelock_target_round": timelock_target_round,
        }),
    })
}

fn map_pool(err: impl std::fmt::Display) -> PersistenceError {
    PersistenceError::Pool(err.to_string())
}

fn map_pg(err: tokio_postgres::Error) -> PersistenceError {
    PersistenceError::Postgres(err.to_string())
}

fn chrono_now() -> chrono::DateTime<chrono::Utc> {
    chrono::Utc::now()
}

/// Parse a persisted JSON payload back into an engine log event for replay.
pub fn parse_persisted_event(payload: &Value) -> Result<EngineLogEvent, PersistenceError> {
    let kind = payload
        .get("kind")
        .and_then(|v| v.as_str())
        .ok_or_else(|| PersistenceError::Invalid("missing event kind".into()))?;
    match kind {
        "match.started" => {
            let players = payload
                .get("players")
                .and_then(|v| v.as_array())
                .ok_or_else(|| PersistenceError::Invalid("missing players".into()))?
                .iter()
                .map(|p| {
                    let player_id = p
                        .get("player_id")
                        .and_then(|v| v.as_u64())
                        .ok_or_else(|| PersistenceError::Invalid("player_id".into()))?;
                    let stack = p
                        .get("stack")
                        .and_then(|v| v.as_u64())
                        .ok_or_else(|| PersistenceError::Invalid("stack".into()))?;
                    let seal_seq = p
                        .get("seal_seq")
                        .and_then(|v| v.as_u64())
                        .ok_or_else(|| PersistenceError::Invalid("seal_seq".into()))?;
                    Ok((
                        syndicate_shared::PlayerId(player_id as u16),
                        stack,
                        seal_seq,
                    ))
                })
                .collect::<Result<Vec<(syndicate_shared::PlayerId, u64, u64)>, PersistenceError>>(
                )?;
            Ok(EngineLogEvent::MatchStarted {
                config: MatchConfig {
                    match_id: payload
                        .get("match_id")
                        .and_then(|v| v.as_str())
                        .unwrap_or_default()
                        .to_string(),
                    onchain_match_id: payload
                        .get("onchain_match_id")
                        .and_then(|v| v.as_u64())
                        .unwrap_or(0),
                    players,
                    button: payload.get("button").and_then(|v| v.as_u64()).unwrap_or(0) as usize,
                    small_blind: payload
                        .get("small_blind")
                        .and_then(|v| v.as_u64())
                        .unwrap_or(0),
                    big_blind: payload
                        .get("big_blind")
                        .and_then(|v| v.as_u64())
                        .unwrap_or(0),
                    round_count: payload
                        .get("round_count")
                        .and_then(|v| v.as_u64())
                        .unwrap_or(1) as u8,
                    round_durations_sec: payload
                        .get("round_durations_sec")
                        .and_then(|v| v.as_array())
                        .map(|a| a.iter().filter_map(|x| x.as_u64()).collect())
                        .unwrap_or_default(),
                    observation_windows_sec: payload
                        .get("observation_windows_sec")
                        .and_then(|v| v.as_array())
                        .map(|a| a.iter().filter_map(|x| x.as_u64()).collect())
                        .unwrap_or_default(),
                    action_timeout_ms: payload
                        .get("action_timeout_ms")
                        .and_then(|v| v.as_u64())
                        .unwrap_or(25_000),
                    time_bank_sec: payload
                        .get("time_bank_sec")
                        .and_then(|v| v.as_u64())
                        .unwrap_or(0),
                    lease_ttl_ms: payload
                        .get("lease_ttl_ms")
                        .and_then(|v| v.as_u64())
                        .unwrap_or(1_000),
                },
            })
        }
        "player.action" => {
            let prev_head_hex = payload
                .get("prev_head")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let mut prev_head = [0u8; 32];
            if !prev_head_hex.is_empty() {
                let bytes = hex::decode(prev_head_hex)
                    .map_err(|e| PersistenceError::Invalid(e.to_string()))?;
                if bytes.len() == 32 {
                    prev_head.copy_from_slice(&bytes);
                }
            }
            Ok(EngineLogEvent::PlayerAction {
                intent: SignedActionIntent {
                    seat_index: payload
                        .get("seat_index")
                        .and_then(|v| v.as_u64())
                        .unwrap_or(0) as usize,
                    wallet: payload
                        .get("wallet")
                        .and_then(|v| v.as_str())
                        .unwrap_or_default()
                        .to_string(),
                    nonce: payload.get("nonce").and_then(|v| v.as_u64()).unwrap_or(0),
                    prev_head,
                    signature: payload
                        .get("signature")
                        .and_then(|v| v.as_str())
                        .unwrap_or_default()
                        .to_string(),
                    action: parse_action(
                        payload
                            .get("action")
                            .and_then(|v| v.as_str())
                            .unwrap_or("Fold"),
                    ),
                },
            })
        }
        "default.registered" => Ok(EngineLogEvent::DefaultPolicyRegistered {
            policy: SignedDefaultPolicy {
                seat_index: payload
                    .get("seat_index")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0) as usize,
                wallet: payload
                    .get("wallet")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default()
                    .to_string(),
                policy: if payload
                    .get("policy")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .contains("CheckCallAny")
                {
                    crate::DefaultAction::CheckCallAny
                } else {
                    crate::DefaultAction::CheckFold
                },
                signature: payload
                    .get("signature")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default()
                    .to_string(),
            },
        }),
        "timeout.default" => Ok(EngineLogEvent::TimeoutDefaultApplied {
            seat_index: payload
                .get("seat_index")
                .and_then(|v| v.as_u64())
                .unwrap_or(0) as usize,
            default: if payload
                .get("default")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .contains("CheckCallAny")
            {
                crate::DefaultAction::CheckCallAny
            } else {
                crate::DefaultAction::CheckFold
            },
            deadline_ms: payload
                .get("deadline_ms")
                .and_then(|v| v.as_u64())
                .unwrap_or(0),
            fired_at_ms: payload
                .get("fired_at_ms")
                .and_then(|v| v.as_u64())
                .unwrap_or(0),
        }),
        "snapshot.written" => Ok(EngineLogEvent::SnapshotWritten {
            round: payload.get("round").and_then(|v| v.as_u64()).unwrap_or(0) as u8,
            phase: crate::Phase::Live,
        }),
        "prediction.sealed" => {
            let ciphertext_hex = payload
                .get("ciphertext")
                .and_then(|v| v.as_str())
                .ok_or_else(|| PersistenceError::Invalid("ciphertext".into()))?;
            let commitment_bytes = payload
                .get("commitment")
                .and_then(|v| v.as_str())
                .and_then(|h| hex::decode(h).ok())
                .unwrap_or_default();
            let mut commitment_arr = [0u8; 32];
            if commitment_bytes.len() == 32 {
                commitment_arr.copy_from_slice(&commitment_bytes);
            }
            let blinding_bytes = payload
                .get("blinding")
                .and_then(|v| v.as_str())
                .and_then(|h| hex::decode(h).ok())
                .unwrap_or_default();
            let mut blinding_arr = [0u8; 32];
            if blinding_bytes.len() == 32 {
                blinding_arr.copy_from_slice(&blinding_bytes);
            }
            Ok(EngineLogEvent::PredictionSealed {
                player_id: payload
                    .get("player_id")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0) as u16,
                target_round: payload
                    .get("target_round")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0),
                ciphertext: hex::decode(ciphertext_hex)
                    .map_err(|e| PersistenceError::Invalid(e.to_string()))?,
                commitment: SignedPredictionCommitment {
                    player_id: payload
                        .get("player_id")
                        .and_then(|v| v.as_u64())
                        .unwrap_or(0) as u16,
                    wallet: payload
                        .get("wallet")
                        .and_then(|v| v.as_str())
                        .unwrap_or_default()
                        .to_string(),
                    seal_seq: payload
                        .get("seal_seq")
                        .and_then(|v| v.as_u64())
                        .unwrap_or(0),
                    commitment: commitment_arr,
                    blinding: blinding_arr,
                    signature: payload
                        .get("commitment_signature")
                        .and_then(|v| v.as_str())
                        .unwrap_or("legacy")
                        .to_string(),
                },
            })
        }
        "match.completed" => Ok(EngineLogEvent::MatchCompleted {
            event_root: payload
                .get("event_root")
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .to_string(),
            timelock_target_round: payload
                .get("timelock_target_round")
                .and_then(|v| v.as_u64())
                .unwrap_or(0),
        }),
        other => Err(PersistenceError::Invalid(format!(
            "unknown event kind: {other}"
        ))),
    }
}

fn parse_action(raw: &str) -> crate::Action {
    if raw.contains("Fold") {
        crate::Action::Fold
    } else if raw.contains("Check") {
        crate::Action::Check
    } else if raw.contains("Call") {
        crate::Action::Call
    } else if raw.contains("AllIn") {
        crate::Action::AllIn
    } else if let Some(rest) = raw.strip_prefix("BetTo(").and_then(|s| s.strip_suffix(')')) {
        crate::Action::BetTo(rest.parse().unwrap_or(0))
    } else if let Some(rest) = raw
        .strip_prefix("RaiseTo(")
        .and_then(|s| s.strip_suffix(')'))
    {
        crate::Action::RaiseTo(rest.parse().unwrap_or(0))
    } else {
        crate::Action::Fold
    }
}

#[cfg(test)]
mod persistence_tests {
    use super::*;
    use crate::service::EngineLogEvent;

    #[test]
    fn parse_persisted_event_roundtrip() {
        let event = EngineLogEvent::PredictionSealed {
            player_id: 2,
            target_round: 42,
            ciphertext: vec![9, 8, 7],
            commitment: SignedPredictionCommitment {
                player_id: 2,
                wallet: "w".into(),
                seal_seq: 2,
                commitment: [1u8; 32],
                blinding: [2u8; 32],
                signature: "sig".into(),
            },
        };
        let payload = event_payload(&event).unwrap();
        let parsed = parse_persisted_event(&payload).unwrap();
        assert_eq!(parsed, event);
    }
}
