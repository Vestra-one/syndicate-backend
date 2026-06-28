//! Reconstruct settlement jobs from persisted match events and oracle inputs.

use std::collections::{BTreeMap, BTreeSet};
use std::time::{SystemTime, UNIX_EPOCH};

use deadpool_postgres::Pool;
use serde::{Deserialize, Serialize};
use syndicate_engine::persistence::parse_persisted_event;
use syndicate_engine::service::{
    EngineLogEvent, EventEnvelope, FencedMatchRuntime, MatchServiceError,
};
use syndicate_settlement::ops::{
    PythFetchRequest, PythResolveClient, PythSettlementContext, SettlementJob, SolanaMatchContext,
};
use syndicate_settlement::{settle_match, SealBinding, SettleParams};
use syndicate_store::{LOAD_MATCH_SEATS_SQL, LOAD_MATCH_SETTLEMENT_CONTEXT_SQL};
use syndicate_timelock::SealRegistry;

use crate::metrics::WorkerMetrics;
use crate::timelock_open::{now_ts, TimelockOpenClient, TimelockOpenRequest, TimelockOpenStatus};

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SettlementRequest {
    pub match_id: String,
    pub event_root: String,
    pub scheduled_end_ts: u64,
    pub pyth_feed_id: String,
    pub oracle_delay_window_sec: u64,
    pub oracle_exponent: i32,
    pub max_oracle_confidence: u64,
    pub rake_bps: u32,
    pub rake_cap: u64,
    #[serde(default)]
    pub timelock_target_round: u64,
}

#[derive(Debug)]
pub enum ReconstructError {
    Parse(String),
    Postgres(String),
    Replay(MatchServiceError),
    Oracle(String),
    TimelockPending { retry_after_ms: u64, reason: String },
    Invalid(String),
}

impl std::fmt::Display for ReconstructError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ReconstructError::Parse(e) => write!(f, "parse: {e}"),
            ReconstructError::Postgres(e) => write!(f, "postgres: {e}"),
            ReconstructError::Replay(e) => write!(f, "replay: {e:?}"),
            ReconstructError::Oracle(e) => write!(f, "oracle: {e}"),
            ReconstructError::TimelockPending { reason, .. } => {
                write!(f, "timelock pending: {reason}")
            }
            ReconstructError::Invalid(e) => write!(f, "invalid: {e}"),
        }
    }
}

impl std::error::Error for ReconstructError {}

pub fn parse_settlement_request(payload: &[u8]) -> Result<SettlementRequest, ReconstructError> {
    serde_json::from_slice(payload).map_err(|e| ReconstructError::Parse(e.to_string()))
}

pub fn idempotency_key(match_id: &str, event_root: &[u8; 32]) -> String {
    format!("{match_id}:root-{}", hex::encode(event_root))
}

pub async fn reconstruct_job<C: PythResolveClient, T: TimelockOpenClient>(
    pool: &Pool,
    request: &SettlementRequest,
    oracle: &mut C,
    timelock: &mut T,
    metrics: &WorkerMetrics,
) -> Result<SettlementJob, ReconstructError> {
    let started = now_ms();
    let context = load_context(pool, &request.match_id).await?;
    let seat_wallets = load_seat_wallets(pool, &request.match_id).await?;
    let event_root = parse_root(&request.event_root)?;
    if event_root != context.event_root {
        return Err(ReconstructError::Invalid(format!(
            "event_root mismatch: request={} db={}",
            request.event_root,
            hex::encode(context.event_root)
        )));
    }
    let envelopes = load_event_envelopes(pool, &request.match_id).await?;
    let snapshot = FencedMatchRuntime::replay(&envelopes).map_err(ReconstructError::Replay)?;
    if !snapshot.engine.is_complete() {
        return Err(ReconstructError::Invalid(
            "match replay is not complete".into(),
        ));
    }
    let (registry, target_round, sealed_players, seal_bindings) =
        seal_registry_from_events(&envelopes, request.timelock_target_round)?;
    require_seals_for_all_seats(&snapshot.engine, &sealed_players)?;
    let feed_id = context.pyth_feed_id;
    let pyth_request = PythFetchRequest {
        feed_id,
        scheduled_end_ts: context.scheduled_end_ts,
        oracle_delay_window_sec: context.oracle_delay_window_sec,
        max_confidence: context.max_oracle_confidence,
        expected_exponent: context.oracle_exponent,
    };
    let resolved = match oracle.resolve_pyth(&pyth_request) {
        Ok(Some(resolved)) => Some(resolved),
        Ok(None) => None,
        Err(e) => return Err(ReconstructError::Oracle(format!("{e:?}"))),
    };
    let oracle_price = resolved.as_ref().map(|r| r.price);
    let opened = match timelock.open(&TimelockOpenRequest {
        target_round,
        scheduled_end_ts: context.scheduled_end_ts,
        now_ts: now_ts(),
    }) {
        TimelockOpenStatus::Available(opened) => opened,
        TimelockOpenStatus::Pending {
            retry_after_ms,
            reason,
        } => {
            return Err(ReconstructError::TimelockPending {
                retry_after_ms,
                reason,
            })
        }
        TimelockOpenStatus::UnavailableAfterGrace { reason: _reason } => {
            let outcome = syndicate_settlement::Outcome::Void(
                syndicate_settlement::VoidReason::TimelockUnavailable,
            );
            metrics.observe_reconstruct_latency_ms(now_ms().saturating_sub(started));
            return Ok(SettlementJob {
                match_id: request.match_id.clone(),
                idempotency_key: idempotency_key(&request.match_id, &event_root),
                event_root,
                chain_context: SolanaMatchContext {
                    onchain_match_id: context.onchain_match_id,
                    seat_wallets,
                },
                pyth_context: PythSettlementContext {
                    rules: pyth_request,
                    selected: resolved.map(|r| r.selected),
                },
                outcome,
            });
        }
        TimelockOpenStatus::Invalid { reason } => {
            return Err(ReconstructError::Invalid(format!(
                "timelock open invalid: {reason}"
            )))
        }
    };
    let _timelock_receipt = opened.receipt.clone();
    let params = SettleParams {
        rake_bps: context.rake_bps,
        rake_cap: context.rake_cap,
    };
    let outcome = settle_match(
        &snapshot.engine,
        oracle_price,
        &registry,
        &opened.scheme,
        Some(&opened.round_key),
        &params,
        &seal_bindings,
    );
    metrics.observe_reconstruct_latency_ms(now_ms().saturating_sub(started));
    Ok(SettlementJob {
        match_id: request.match_id.clone(),
        idempotency_key: idempotency_key(&request.match_id, &event_root),
        event_root,
        chain_context: SolanaMatchContext {
            onchain_match_id: context.onchain_match_id,
            seat_wallets,
        },
        pyth_context: PythSettlementContext {
            rules: pyth_request,
            selected: resolved.map(|r| r.selected),
        },
        outcome,
    })
}

pub async fn reconstruct_job_from_attempt<C: PythResolveClient, T: TimelockOpenClient>(
    pool: &Pool,
    match_id: &str,
    event_root: &[u8; 32],
    oracle: &mut C,
    timelock: &mut T,
    metrics: &WorkerMetrics,
) -> Result<SettlementJob, ReconstructError> {
    let context = load_context(pool, match_id).await?;
    reconstruct_job(
        pool,
        &SettlementRequest {
            match_id: match_id.to_string(),
            event_root: hex::encode(event_root),
            scheduled_end_ts: context.scheduled_end_ts,
            pyth_feed_id: hex::encode(context.pyth_feed_id),
            oracle_delay_window_sec: context.oracle_delay_window_sec,
            oracle_exponent: context.oracle_exponent,
            max_oracle_confidence: context.max_oracle_confidence,
            rake_bps: context.rake_bps,
            rake_cap: context.rake_cap,
            timelock_target_round: 0,
        },
        oracle,
        timelock,
        metrics,
    )
    .await
}

struct LoadedContext {
    event_root: [u8; 32],
    onchain_match_id: u64,
    scheduled_end_ts: u64,
    pyth_feed_id: [u8; 32],
    oracle_delay_window_sec: u64,
    oracle_exponent: i32,
    max_oracle_confidence: u64,
    rake_bps: u32,
    rake_cap: u64,
}

async fn load_context(pool: &Pool, match_id: &str) -> Result<LoadedContext, ReconstructError> {
    let client = pool
        .get()
        .await
        .map_err(|e| ReconstructError::Postgres(e.to_string()))?;
    let row = client
        .query_one(LOAD_MATCH_SETTLEMENT_CONTEXT_SQL, &[&match_id])
        .await
        .map_err(|e| ReconstructError::Postgres(e.to_string()))?;
    let feed: Vec<u8> = row.get("pyth_feed_id");
    let head: Vec<u8> = row.get("event_head");
    if feed.len() != 32 || head.len() != 32 {
        return Err(ReconstructError::Invalid(
            "invalid feed or event head length".into(),
        ));
    }
    let mut pyth_feed_id = [0u8; 32];
    let mut event_root = [0u8; 32];
    pyth_feed_id.copy_from_slice(&feed);
    event_root.copy_from_slice(&head);
    let onchain_match_id = row.get::<_, i64>("onchain_match_id");
    if onchain_match_id < 0 {
        return Err(ReconstructError::Invalid(
            "negative onchain_match_id".into(),
        ));
    }
    Ok(LoadedContext {
        event_root,
        onchain_match_id: onchain_match_id as u64,
        scheduled_end_ts: row.get::<_, i64>("scheduled_end_ts_sec") as u64,
        pyth_feed_id,
        oracle_delay_window_sec: row.get::<_, i32>("oracle_delay_window_sec") as u64,
        oracle_exponent: row.get("oracle_exponent"),
        max_oracle_confidence: row.get::<_, i64>("max_oracle_confidence") as u64,
        rake_bps: row.get::<_, i32>("rake_bps") as u32,
        rake_cap: row.get::<_, i64>("rake_cap_chips") as u64,
    })
}

async fn load_seat_wallets(pool: &Pool, match_id: &str) -> Result<Vec<String>, ReconstructError> {
    let client = pool
        .get()
        .await
        .map_err(|e| ReconstructError::Postgres(e.to_string()))?;
    let rows = client
        .query(LOAD_MATCH_SEATS_SQL, &[&match_id])
        .await
        .map_err(|e| ReconstructError::Postgres(e.to_string()))?;
    if rows.is_empty() {
        return Err(ReconstructError::Invalid(
            "match has no active seats".into(),
        ));
    }
    Ok(rows.iter().map(|row| row.get("wallet_address")).collect())
}

pub async fn load_event_envelopes(
    pool: &Pool,
    match_id: &str,
) -> Result<Vec<EventEnvelope>, ReconstructError> {
    let client = pool
        .get()
        .await
        .map_err(|e| ReconstructError::Postgres(e.to_string()))?;
    let rows = client
        .query(syndicate_store::LOAD_ALL_MATCH_EVENTS_SQL, &[&match_id])
        .await
        .map_err(|e| ReconstructError::Postgres(e.to_string()))?;
    rows.iter()
        .map(|row| {
            let prev: Vec<u8> = row.get("prev_hash");
            let hash: Vec<u8> = row.get("hash");
            if prev.len() != 32 || hash.len() != 32 {
                return Err(ReconstructError::Invalid("invalid event hash".into()));
            }
            let mut prev_hash = [0u8; 32];
            let mut event_hash = [0u8; 32];
            prev_hash.copy_from_slice(&prev);
            event_hash.copy_from_slice(&hash);
            let payload: serde_json::Value = row.get("payload");
            let event = parse_persisted_event(&payload)
                .map_err(|e| ReconstructError::Parse(e.to_string()))?;
            Ok(EventEnvelope {
                seq: row.get::<_, i64>("seq") as u64,
                owner_fencing_token: row.get::<_, i64>("owner_fencing_token") as u64,
                prev_hash,
                hash: event_hash,
                event,
            })
        })
        .collect()
}

fn seal_registry_from_events(
    envelopes: &[EventEnvelope],
    fallback_round: u64,
) -> Result<(SealRegistry, u64, BTreeSet<u16>, BTreeMap<syndicate_shared::PlayerId, SealBinding>), ReconstructError> {
    let mut completed_round = if fallback_round == 0 {
        None
    } else {
        Some(fallback_round)
    };
    let mut sealed = Vec::new();
    let mut seal_bindings = BTreeMap::new();
    for envelope in envelopes {
        if let EngineLogEvent::PredictionSealed {
            player_id,
            target_round: round,
            ciphertext,
            commitment,
        } = &envelope.event
        {
            if *round == 0 {
                return Err(ReconstructError::Invalid(
                    "sealed prediction has zero target round".into(),
                ));
            }
            sealed.push((*player_id, *round, ciphertext.clone()));
            seal_bindings.insert(
                syndicate_shared::PlayerId(*player_id),
                SealBinding {
                    commitment: commitment.commitment,
                    blinding: commitment.blinding,
                },
            );
        }
        if let EngineLogEvent::MatchCompleted {
            timelock_target_round,
            ..
        } = &envelope.event
        {
            if *timelock_target_round == 0 {
                return Err(ReconstructError::Invalid(
                    "match completed with zero timelock target round".into(),
                ));
            }
            if let Some(existing) = completed_round {
                if existing != *timelock_target_round {
                    return Err(ReconstructError::Invalid(format!(
                        "timelock target round mismatch: {existing} != {timelock_target_round}"
                    )));
                }
            }
            completed_round = Some(*timelock_target_round);
        }
    }
    let Some(target_round) = completed_round else {
        return Err(ReconstructError::Invalid(
            "missing timelock target round".into(),
        ));
    };
    let mut registry = SealRegistry::new(target_round);
    let mut sealed_players = BTreeSet::new();
    for (player_id, round, ciphertext) in sealed {
        if round != target_round {
            return Err(ReconstructError::Invalid(format!(
                "sealed prediction target round {round} does not match completed round {target_round}"
            )));
        }
        if !sealed_players.insert(player_id) {
            return Err(ReconstructError::Invalid(format!(
                "duplicate sealed prediction for player {player_id}"
            )));
        }
        registry
            .seal(syndicate_shared::PlayerId(player_id), ciphertext)
            .map_err(|e| ReconstructError::Invalid(format!("seal registry: {e:?}")))?;
    }
    registry.lock();
    Ok((registry, target_round, sealed_players, seal_bindings))
}

fn require_seals_for_all_seats(
    engine: &syndicate_engine::Engine,
    sealed_players: &BTreeSet<u16>,
) -> Result<(), ReconstructError> {
    for seat in &engine.seats {
        if !sealed_players.contains(&seat.id.0) {
            return Err(ReconstructError::Invalid(format!(
                "missing sealed prediction for player {}",
                seat.id.0
            )));
        }
    }
    if sealed_players.len() != engine.seats.len() {
        return Err(ReconstructError::Invalid(
            "sealed prediction count does not match seats".into(),
        ));
    }
    Ok(())
}

fn parse_root(raw: &str) -> Result<[u8; 32], ReconstructError> {
    let bytes = hex::decode(raw.trim()).map_err(|e| ReconstructError::Parse(e.to_string()))?;
    if bytes.len() != 32 {
        return Err(ReconstructError::Invalid(format!(
            "event_root must be 32 bytes, got {}",
            bytes.len()
        )));
    }
    let mut out = [0u8; 32];
    out.copy_from_slice(&bytes);
    Ok(out)
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock")
        .as_millis() as u64
}

#[cfg(test)]
mod tests {
    use super::*;
    use syndicate_engine::service::EngineLogEvent;
    use syndicate_engine::Engine;
    use syndicate_shared::PlayerId;

    #[test]
    fn idempotency_key_is_stable() {
        let root = [7u8; 32];
        assert_eq!(
            idempotency_key("abc", &root),
            format!("abc:root-{}", hex::encode(root))
        );
    }

    #[test]
    fn sealed_round_must_match_completed_round() {
        let envelopes = vec![
            envelope(
                1,
                EngineLogEvent::PredictionSealed {
                    player_id: 0,
                    target_round: 41,
                    ciphertext: vec![1],
                    commitment: syndicate_engine::service::SignedPredictionCommitment {
                        player_id: 0,
                        wallet: "w".into(),
                        seal_seq: 0,
                        commitment: [0u8; 32],
                        blinding: [3u8; 32],
                        signature: "sig".into(),
                    },
                },
            ),
            envelope(
                2,
                EngineLogEvent::MatchCompleted {
                    event_root: "root".into(),
                    timelock_target_round: 42,
                },
            ),
        ];
        let err = seal_registry_from_events(&envelopes, 0).unwrap_err();
        assert!(err.to_string().contains("does not match completed round"));
    }

    #[test]
    fn every_seat_must_have_a_sealed_prediction() {
        let engine = Engine::new(
            vec![(PlayerId(0), 100, 0), (PlayerId(1), 100, 1)],
            0,
            1,
            2,
            3,
        );
        let mut sealed = BTreeSet::new();
        sealed.insert(0);
        let err = require_seals_for_all_seats(&engine, &sealed).unwrap_err();
        assert!(err.to_string().contains("missing sealed prediction"));
    }

    fn envelope(seq: u64, event: EngineLogEvent) -> EventEnvelope {
        EventEnvelope {
            seq,
            owner_fencing_token: 1,
            prev_hash: [0u8; 32],
            hash: [seq as u8; 32],
            event,
        }
    }
}
