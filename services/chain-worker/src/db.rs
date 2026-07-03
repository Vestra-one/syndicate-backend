//! Local SQL for the chain-jobs queue + settlement context loads.
//!
//! Deliberate choice (documented in `lib.rs`): these statements live here rather than in
//! `services/store` — the queue lifecycle is owned by this daemon. Generic match-event
//! SQL is still reused from `syndicate-store`.

use deadpool_postgres::Pool;
use serde_json::Value;
use tokio_postgres::Row;
use uuid::Uuid;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum JobKind {
    Lock,
    BeginLive,
    SubmitSettlement,
    VoidBeforeStart,
    VoidLiveAfterDeadline,
    Void,
    WithdrawFees,
}

impl JobKind {
    pub const ALL: [JobKind; 7] = [
        JobKind::Lock,
        JobKind::BeginLive,
        JobKind::SubmitSettlement,
        JobKind::VoidBeforeStart,
        JobKind::VoidLiveAfterDeadline,
        JobKind::Void,
        JobKind::WithdrawFees,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            JobKind::Lock => "lock",
            JobKind::BeginLive => "begin_live",
            JobKind::SubmitSettlement => "submit_settlement",
            JobKind::VoidBeforeStart => "void_before_start",
            JobKind::VoidLiveAfterDeadline => "void_live_after_deadline",
            JobKind::Void => "void",
            JobKind::WithdrawFees => "withdraw_fees",
        }
    }

    pub fn parse(raw: &str) -> Option<JobKind> {
        JobKind::ALL.into_iter().find(|k| k.as_str() == raw)
    }

    pub fn index(self) -> usize {
        JobKind::ALL
            .iter()
            .position(|k| *k == self)
            .expect("kind in ALL")
    }
}

#[derive(Clone, Debug)]
pub struct ChainJob {
    pub id: Uuid,
    pub match_id: Uuid,
    pub kind: JobKind,
    pub idempotency_key: String,
    pub payload: Value,
    /// Failure attempts consumed so far (incremented by `mark_retry`, not by claims).
    pub attempt_count: i32,
    pub tx_signature: Option<String>,
}

#[derive(Debug)]
pub struct DbError(pub String);

impl std::fmt::Display for DbError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "db: {}", self.0)
    }
}
impl std::error::Error for DbError {}

fn map<E: std::fmt::Display>(e: E) -> DbError {
    DbError(e.to_string())
}

// ---------------- queue statements ----------------

pub const CLAIM_DUE_CHAIN_JOBS_SQL: &str = r#"
WITH due AS (
    SELECT id
    FROM chain_jobs
    WHERE status IN ('pending', 'retry_scheduled')
      AND COALESCE(next_retry_at, not_before, created_at) <= now()
    ORDER BY COALESCE(next_retry_at, not_before, created_at) ASC, id ASC
    LIMIT $2
    FOR UPDATE SKIP LOCKED
)
UPDATE chain_jobs j
SET status = 'claimed', claimed_by = $1, claimed_at = now(), updated_at = now()
FROM due
WHERE j.id = due.id
RETURNING j.id, j.match_id, j.kind::text AS kind, j.idempotency_key, j.payload,
          j.attempt_count, j.tx_signature
"#;

pub const COUNT_DUE_CHAIN_JOBS_SQL: &str = r#"
SELECT count(*) AS due
FROM chain_jobs
WHERE status IN ('pending', 'retry_scheduled')
  AND COALESCE(next_retry_at, not_before, created_at) <= now()
"#;

pub const MARK_JOB_SUBMITTED_SQL: &str = r#"
UPDATE chain_jobs
SET status = 'submitted', tx_signature = $2, last_blockhash = $3, updated_at = now()
WHERE id = $1
"#;

pub const MARK_JOB_CONFIRMED_SQL: &str = r#"
UPDATE chain_jobs
SET status = 'confirmed', tx_signature = COALESCE($2, tx_signature),
    confirmed_at = now(), updated_at = now()
WHERE id = $1
"#;

/// A real failure: consumes an attempt and backs off.
pub const MARK_JOB_RETRY_SQL: &str = r#"
UPDATE chain_jobs
SET status = 'retry_scheduled',
    attempt_count = attempt_count + 1,
    next_retry_at = now() + ($2::bigint * interval '1 millisecond'),
    last_error = $3,
    tx_signature = COALESCE($4, tx_signature),
    updated_at = now()
WHERE id = $1
"#;

/// A time gate (not a failure): reschedules WITHOUT consuming an attempt.
pub const MARK_JOB_WAIT_SQL: &str = r#"
UPDATE chain_jobs
SET status = 'retry_scheduled',
    next_retry_at = now() + ($2::bigint * interval '1 millisecond'),
    last_error = $3,
    updated_at = now()
WHERE id = $1
"#;

pub const MARK_JOB_DEAD_LETTER_SQL: &str = r#"
UPDATE chain_jobs
SET status = 'dead_letter', last_error = $2,
    oracle_audit = COALESCE($3, oracle_audit), updated_at = now()
WHERE id = $1
"#;

pub const MARK_JOB_SKIPPED_SQL: &str = r#"
UPDATE chain_jobs
SET status = 'skipped', last_error = $2, updated_at = now()
WHERE id = $1
"#;

/// Crash-recovery sweep: rows stuck in claimed/submitted longer than the confirmation
/// timeout (worker died mid-flight).
pub const LIST_STALE_JOBS_SQL: &str = r#"
SELECT id, tx_signature
FROM chain_jobs
WHERE status IN ('claimed', 'submitted')
  AND claimed_at < now() - ($1::bigint * interval '1 millisecond')
"#;

pub const RESET_STALE_JOB_SQL: &str = r#"
UPDATE chain_jobs
SET status = 'retry_scheduled', next_retry_at = now(), updated_at = now()
WHERE id = $1 AND status IN ('claimed', 'submitted')
"#;

/// VOID-path enqueue (idempotent — the game-server pre-schedules the same backstop).
pub const ENQUEUE_VOID_LIVE_JOB_SQL: &str = r#"
INSERT INTO chain_jobs (match_id, kind, idempotency_key, payload, status, not_before)
VALUES ($1, 'void_live_after_deadline', $2, '{}'::jsonb, 'pending', to_timestamp($3::double precision))
ON CONFLICT (idempotency_key) DO NOTHING
"#;

// ---------------- match context loads ----------------

pub const LOAD_MATCH_ROW_SQL: &str = r#"
SELECT onchain_match_id,
       feed_symbol,
       timelock_target,
       event_head,
       buy_in_chips,
       rake_bps,
       rake_cap_chips,
       CAST(EXTRACT(EPOCH FROM scheduled_end_ts) AS bigint) AS scheduled_end_sec
FROM matches
WHERE id = $1
"#;

/// Confirmed seats in engine order with sealing material (0008 columns).
pub const LOAD_SETTLE_SEATS_SQL: &str = r#"
SELECT engine_seat, wallet_address, sealed, seal_chain_confirmed,
       seal_ciphertext, seal_commitment, seal_timelock_target, prediction_source
FROM match_seats
WHERE match_id = $1 AND engine_seat IS NOT NULL AND left_at IS NULL
ORDER BY engine_seat ASC
"#;

pub const LOAD_SEAL_CLOSE_SNAPSHOT_SQL: &str = r#"
SELECT price::text AS price_text, exponent, signed_payload
FROM price_snapshots
WHERE match_id = $1 AND kind = 'seal_close'
"#;

/// After begin_live confirms, mirror the on-chain timing/button into the matches row.
pub const UPDATE_MATCH_ON_BEGIN_LIVE_SQL: &str = r#"
UPDATE matches
SET live_start_ts = to_timestamp($2::double precision),
    scheduled_end_ts = to_timestamp($3::double precision),
    button = $4,
    button_seed = $5
WHERE id = $1
"#;

// ---------------- typed helpers ----------------

fn row_to_job(row: &Row) -> Result<ChainJob, DbError> {
    let kind_raw: String = row.get("kind");
    let kind = JobKind::parse(&kind_raw)
        .ok_or_else(|| DbError(format!("unknown chain_job kind: {kind_raw}")))?;
    Ok(ChainJob {
        id: row.get("id"),
        match_id: row.get("match_id"),
        kind,
        idempotency_key: row.get("idempotency_key"),
        payload: row.get("payload"),
        attempt_count: row.get("attempt_count"),
        tx_signature: row.get("tx_signature"),
    })
}

pub async fn claim_due_jobs(
    pool: &Pool,
    worker_id: &str,
    batch: i64,
) -> Result<Vec<ChainJob>, DbError> {
    let client = pool.get().await.map_err(map)?;
    let rows = client
        .query(CLAIM_DUE_CHAIN_JOBS_SQL, &[&worker_id, &batch])
        .await
        .map_err(map)?;
    rows.iter().map(row_to_job).collect()
}

pub async fn count_due_jobs(pool: &Pool) -> Result<u64, DbError> {
    let client = pool.get().await.map_err(map)?;
    let row = client
        .query_one(COUNT_DUE_CHAIN_JOBS_SQL, &[])
        .await
        .map_err(map)?;
    Ok(row.get::<_, i64>("due").max(0) as u64)
}

pub async fn mark_submitted(
    pool: &Pool,
    id: Uuid,
    tx_sig: &str,
    blockhash: &str,
) -> Result<(), DbError> {
    let client = pool.get().await.map_err(map)?;
    client
        .execute(MARK_JOB_SUBMITTED_SQL, &[&id, &tx_sig, &blockhash])
        .await
        .map_err(map)?;
    Ok(())
}

pub async fn mark_confirmed(pool: &Pool, id: Uuid, tx_sig: Option<&str>) -> Result<(), DbError> {
    let client = pool.get().await.map_err(map)?;
    client
        .execute(MARK_JOB_CONFIRMED_SQL, &[&id, &tx_sig])
        .await
        .map_err(map)?;
    Ok(())
}

pub async fn mark_retry(
    pool: &Pool,
    id: Uuid,
    delay_ms: u64,
    error: &str,
    tx_sig: Option<&str>,
) -> Result<(), DbError> {
    let client = pool.get().await.map_err(map)?;
    client
        .execute(
            MARK_JOB_RETRY_SQL,
            &[&id, &(delay_ms as i64), &truncate(error), &tx_sig],
        )
        .await
        .map_err(map)?;
    Ok(())
}

pub async fn mark_wait(pool: &Pool, id: Uuid, delay_ms: u64, reason: &str) -> Result<(), DbError> {
    let client = pool.get().await.map_err(map)?;
    client
        .execute(
            MARK_JOB_WAIT_SQL,
            &[&id, &(delay_ms as i64), &truncate(reason)],
        )
        .await
        .map_err(map)?;
    Ok(())
}

pub async fn mark_dead_letter(
    pool: &Pool,
    id: Uuid,
    error: &str,
    oracle_audit: Option<&Value>,
) -> Result<(), DbError> {
    let client = pool.get().await.map_err(map)?;
    client
        .execute(
            MARK_JOB_DEAD_LETTER_SQL,
            &[&id, &truncate(error), &oracle_audit],
        )
        .await
        .map_err(map)?;
    Ok(())
}

pub async fn mark_skipped(pool: &Pool, id: Uuid, reason: &str) -> Result<(), DbError> {
    let client = pool.get().await.map_err(map)?;
    client
        .execute(MARK_JOB_SKIPPED_SQL, &[&id, &truncate(reason)])
        .await
        .map_err(map)?;
    Ok(())
}

pub async fn list_stale_jobs(
    pool: &Pool,
    older_than_ms: u64,
) -> Result<Vec<(Uuid, Option<String>)>, DbError> {
    let client = pool.get().await.map_err(map)?;
    let rows = client
        .query(LIST_STALE_JOBS_SQL, &[&(older_than_ms as i64)])
        .await
        .map_err(map)?;
    Ok(rows
        .iter()
        .map(|r| {
            (
                r.get::<_, Uuid>("id"),
                r.get::<_, Option<String>>("tx_signature"),
            )
        })
        .collect())
}

pub async fn reset_stale_job(pool: &Pool, id: Uuid) -> Result<(), DbError> {
    let client = pool.get().await.map_err(map)?;
    client
        .execute(RESET_STALE_JOB_SQL, &[&id])
        .await
        .map_err(map)?;
    Ok(())
}

pub async fn enqueue_void_live_job(
    pool: &Pool,
    match_id: Uuid,
    idempotency_key: &str,
    not_before_unix: u64,
) -> Result<(), DbError> {
    let client = pool.get().await.map_err(map)?;
    client
        .execute(
            ENQUEUE_VOID_LIVE_JOB_SQL,
            &[&match_id, &idempotency_key, &(not_before_unix as f64)],
        )
        .await
        .map_err(map)?;
    Ok(())
}

#[derive(Clone, Debug)]
pub struct MatchRow {
    pub onchain_match_id: u64,
    pub feed_symbol: Option<String>,
    pub timelock_target: Option<u64>,
    pub event_head: [u8; 32],
    pub scheduled_end_sec: Option<u64>,
    pub buy_in_chips: Option<u64>,
    pub rake_bps: Option<u32>,
    pub rake_cap_chips: Option<u64>,
}

pub async fn load_match_row(pool: &Pool, match_id: Uuid) -> Result<Option<MatchRow>, DbError> {
    let client = pool.get().await.map_err(map)?;
    let Some(row) = client
        .query_opt(LOAD_MATCH_ROW_SQL, &[&match_id])
        .await
        .map_err(map)?
    else {
        return Ok(None);
    };
    let onchain: i64 = row.get("onchain_match_id");
    if onchain < 0 {
        return Err(DbError("negative onchain_match_id".into()));
    }
    let head: Vec<u8> = row.get("event_head");
    if head.len() != 32 {
        return Err(DbError("event_head must be 32 bytes".into()));
    }
    let mut event_head = [0u8; 32];
    event_head.copy_from_slice(&head);
    Ok(Some(MatchRow {
        onchain_match_id: onchain as u64,
        feed_symbol: row.get("feed_symbol"),
        timelock_target: row
            .get::<_, Option<i64>>("timelock_target")
            .filter(|v| *v > 0)
            .map(|v| v as u64),
        event_head,
        scheduled_end_sec: row
            .get::<_, Option<i64>>("scheduled_end_sec")
            .filter(|v| *v > 0)
            .map(|v| v as u64),
        buy_in_chips: row
            .get::<_, Option<i64>>("buy_in_chips")
            .filter(|v| *v > 0)
            .map(|v| v as u64),
        rake_bps: row
            .get::<_, Option<i32>>("rake_bps")
            .filter(|v| *v >= 0)
            .map(|v| v as u32),
        rake_cap_chips: row
            .get::<_, Option<i64>>("rake_cap_chips")
            .filter(|v| *v >= 0)
            .map(|v| v as u64),
    }))
}

#[derive(Clone, Debug)]
pub struct SeatRow {
    pub engine_seat: u8,
    pub wallet: String,
    pub sealed: bool,
    pub seal_chain_confirmed: bool,
    pub seal_ciphertext: Option<Vec<u8>>,
    pub seal_commitment: Option<[u8; 32]>,
    pub seal_timelock_target: Option<u64>,
}

impl SeatRow {
    /// A seat counts as sealed only when the backend recorded the seal AND confirmed the
    /// on-chain commitment at finalized. Anything less is treated as non-sealed (the
    /// capital-safe direction — the seat still settles with the spot price).
    pub fn is_sealed(&self) -> bool {
        self.sealed
            && self.seal_chain_confirmed
            && self.seal_ciphertext.is_some()
            && self.seal_commitment.is_some()
            && self.seal_timelock_target.is_some()
    }
}

pub async fn load_settle_seats(pool: &Pool, match_id: Uuid) -> Result<Vec<SeatRow>, DbError> {
    let client = pool.get().await.map_err(map)?;
    let rows = client
        .query(LOAD_SETTLE_SEATS_SQL, &[&match_id])
        .await
        .map_err(map)?;
    rows.iter()
        .map(|row| {
            let engine_seat: i16 = row.get("engine_seat");
            if !(0..=255).contains(&engine_seat) {
                return Err(DbError(format!("engine_seat out of range: {engine_seat}")));
            }
            let commitment: Option<Vec<u8>> = row.get("seal_commitment");
            let commitment = match commitment {
                Some(c) if c.len() == 32 => {
                    let mut arr = [0u8; 32];
                    arr.copy_from_slice(&c);
                    Some(arr)
                }
                Some(_) => return Err(DbError("seal_commitment must be 32 bytes".into())),
                None => None,
            };
            Ok(SeatRow {
                engine_seat: engine_seat as u8,
                wallet: row.get("wallet_address"),
                sealed: row.get("sealed"),
                seal_chain_confirmed: row.get("seal_chain_confirmed"),
                seal_ciphertext: row.get("seal_ciphertext"),
                seal_commitment: commitment,
                seal_timelock_target: row
                    .get::<_, Option<i64>>("seal_timelock_target")
                    .filter(|v| *v > 0)
                    .map(|v| v as u64),
            })
        })
        .collect()
}

#[derive(Clone, Debug)]
pub struct SealCloseSnapshot {
    pub price_text: String,
    pub exponent: i32,
    pub signed_payload: Value,
}

pub async fn load_seal_close_snapshot(
    pool: &Pool,
    match_id: Uuid,
) -> Result<Option<SealCloseSnapshot>, DbError> {
    let client = pool.get().await.map_err(map)?;
    let row = client
        .query_opt(LOAD_SEAL_CLOSE_SNAPSHOT_SQL, &[&match_id])
        .await
        .map_err(map)?;
    Ok(row.map(|row| SealCloseSnapshot {
        price_text: row.get("price_text"),
        exponent: row.get("exponent"),
        signed_payload: row.get("signed_payload"),
    }))
}

pub async fn update_match_on_begin_live(
    pool: &Pool,
    match_id: Uuid,
    live_start_ts: u64,
    scheduled_end_ts: u64,
    button: u8,
    button_seed: &[u8; 32],
) -> Result<(), DbError> {
    let client = pool.get().await.map_err(map)?;
    client
        .execute(
            UPDATE_MATCH_ON_BEGIN_LIVE_SQL,
            &[
                &match_id,
                &(live_start_ts as f64),
                &(scheduled_end_ts as f64),
                &(button as i16),
                &button_seed.as_slice(),
            ],
        )
        .await
        .map_err(map)?;
    Ok(())
}

/// Load the full ordered event log (reuses the store's canonical statement).
pub async fn load_match_events(
    pool: &Pool,
    match_id: Uuid,
) -> Result<Vec<syndicate_engine::service::EventEnvelope>, DbError> {
    use syndicate_engine::persistence::parse_persisted_event;
    let client = pool.get().await.map_err(map)?;
    let rows = client
        .query(
            syndicate_store::LOAD_ALL_MATCH_EVENTS_SQL,
            &[&match_id.to_string()],
        )
        .await
        .map_err(map)?;
    rows.iter()
        .map(|row| {
            let prev: Vec<u8> = row.get("prev_hash");
            let hash: Vec<u8> = row.get("hash");
            if prev.len() != 32 || hash.len() != 32 {
                return Err(DbError("event hash must be 32 bytes".into()));
            }
            let mut prev_hash = [0u8; 32];
            let mut event_hash = [0u8; 32];
            prev_hash.copy_from_slice(&prev);
            event_hash.copy_from_slice(&hash);
            let payload: Value = row.get("payload");
            let event = parse_persisted_event(&payload).map_err(map)?;
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

fn truncate(s: &str) -> String {
    const MAX: usize = 4_000;
    if s.len() <= MAX {
        s.to_string()
    } else {
        format!(
            "{}…",
            &s[..s
                .char_indices()
                .take_while(|(i, _)| *i < MAX)
                .last()
                .map(|(i, c)| i + c.len_utf8())
                .unwrap_or(0)]
        )
    }
}

pub fn connect_pool(database_url: &str) -> Result<Pool, DbError> {
    let mut cfg = deadpool_postgres::Config::new();
    cfg.url = Some(database_url.to_string());
    cfg.create_pool(
        Some(deadpool_postgres::Runtime::Tokio1),
        tokio_postgres::NoTls,
    )
    .map_err(map)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kind_round_trips() {
        for kind in JobKind::ALL {
            assert_eq!(JobKind::parse(kind.as_str()), Some(kind));
        }
        assert_eq!(JobKind::parse("nope"), None);
    }

    #[test]
    fn claim_sql_shape() {
        assert!(CLAIM_DUE_CHAIN_JOBS_SQL.contains("FOR UPDATE SKIP LOCKED"));
        assert!(
            CLAIM_DUE_CHAIN_JOBS_SQL.contains("COALESCE(next_retry_at, not_before, created_at)")
        );
        assert!(MARK_JOB_RETRY_SQL.contains("attempt_count = attempt_count + 1"));
        assert!(!MARK_JOB_WAIT_SQL.contains("attempt_count"));
        assert!(ENQUEUE_VOID_LIVE_JOB_SQL.contains("ON CONFLICT (idempotency_key) DO NOTHING"));
    }

    #[test]
    fn truncate_is_utf8_safe() {
        let long = "é".repeat(5_000);
        let t = truncate(&long);
        assert!(t.len() <= 4_004);
        assert!(t.ends_with('…'));
    }
}
