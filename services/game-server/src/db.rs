//! Game-server-local SQL (v2 tables from migrations 0008/0009/0010) and row mappers.
//! Deliberately NOT added to `services/store` — the store crate stays v1-stable while
//! the chain-worker is built in parallel.

use chrono::{DateTime, Utc};
use tokio_postgres::Row;
use uuid::Uuid;

use crate::error::ApiError;

// ---------------------------------------------------------------------------------
// matches
// ---------------------------------------------------------------------------------

pub const MATCH_COLUMNS: &str = "\
    m.id, m.match_key, m.onchain_match_id, m.status::text AS status, m.visibility, \
    m.creator_wallet, m.room_code, m.room_commitment, m.feed_symbol, m.config_hash, \
    m.buy_in_chips, m.entry_fee_chips, m.rake_bps, m.rake_cap_chips, m.round_count, \
    m.round_durations_sec, m.observation_windows_sec, m.action_timeout_ms, m.time_bank_sec, \
    m.small_blind, m.big_blind, m.min_players, m.max_players, m.seal_window_sec, \
    m.begin_live_window_sec, m.fill_deadline_ts, m.lock_ts, m.seal_deadline_ts, \
    m.live_start_ts, m.scheduled_end_ts, m.button, m.button_seed, m.timelock_target, \
    m.void_kind, m.event_count, m.event_head, m.mint";

pub const INSERT_MATCH_V2_SQL: &str = r#"
INSERT INTO matches (
    match_key, onchain_match_id, status, visibility, creator_wallet, room_code,
    room_commitment, feed_symbol, config_hash, buy_in_chips, entry_fee_chips, rake_bps,
    rake_cap_chips, round_count, round_durations_sec, observation_windows_sec,
    action_timeout_ms, time_bank_sec, small_blind, big_blind, min_players, max_players,
    seal_window_sec, begin_live_window_sec, fill_deadline_ts, timelock_target, mint
) VALUES (
    $1, $2, ('filling'::text)::match_status, $3, $4, $5,
    $6, $7, $8, $9, $10, $11,
    $12, $13, $14, $15,
    $16, $17, $18, $19, $20, $21,
    $22, $23, $24, $25, $26
)
ON CONFLICT (onchain_match_id) DO NOTHING
RETURNING id
"#;

/// Idempotent FCFS promotion: order every live candidacy by `(finalized_slot, tx_sig)`
/// and confirm the first `max_players`, assigning contiguous seat indexes (= engine
/// order at lock). Deterministic across re-runs; only meaningful pre-lock.
pub const FCFS_PROMOTE_SQL: &str = r#"
WITH ordered AS (
    SELECT id, row_number() OVER (ORDER BY finalized_slot ASC, tx_sig ASC) - 1 AS rn
    FROM seat_candidates
    WHERE match_id = $1 AND status IN ('candidate', 'confirmed')
      AND finalized_slot IS NOT NULL
)
UPDATE seat_candidates sc
SET status = CASE WHEN o.rn < $2 THEN 'confirmed' ELSE 'candidate' END,
    seat_index = CASE WHEN o.rn < $2 THEN o.rn ELSE NULL END
FROM ordered o
WHERE sc.id = o.id
"#;

pub const ENQUEUE_CHAIN_JOB_SQL: &str = r#"
INSERT INTO chain_jobs (match_id, kind, idempotency_key, payload, not_before)
VALUES ($1, ($2::text)::chain_job_kind, $3, $4, $5)
ON CONFLICT (idempotency_key) DO NOTHING
RETURNING id
"#;

/// Per-seat settlement outcome, keyed by `(match_id, engine_seat)`. Idempotent — safe to
/// re-run on retry (see chainjobs.rs::persist_settlement_outcome).
pub const UPDATE_SEAT_SETTLEMENT_SQL: &str = r#"
UPDATE match_seats
SET payout_chips = $3, pot_won_chips = $4, prediction_wad = $5::text::numeric
WHERE match_id = $1 AND seat_index = $2
"#;

/// Match-level settlement summary. Idempotent.
pub const UPDATE_MATCH_SETTLEMENT_SQL: &str = r#"
UPDATE matches
SET settlement_price_wad = $2::text::numeric, final_pot_chips = $3, rake_chips = $4,
    settlement_tx_sig = $5
WHERE id = $1
"#;

#[derive(Clone, Debug)]
pub struct MatchRow {
    pub id: Uuid,
    pub match_key: String,
    pub onchain_match_id: u64,
    pub status: String,
    pub visibility: String,
    pub creator_wallet: Option<String>,
    pub room_code: Option<String>,
    pub room_commitment: Option<Vec<u8>>,
    pub feed_symbol: String,
    pub config_hash: Option<Vec<u8>>,
    pub buy_in: u64,
    pub entry_fee: u64,
    pub rake_bps: u32,
    pub rake_cap: u64,
    pub round_count: u8,
    pub round_durations_sec: Vec<u64>,
    pub observation_windows_sec: Vec<u64>,
    pub action_timeout_ms: u64,
    pub time_bank_sec: u64,
    pub small_blind: u64,
    pub big_blind: u64,
    pub min_players: u8,
    pub max_players: u8,
    pub seal_window_sec: u64,
    pub begin_live_window_sec: u64,
    pub fill_deadline_ts: Option<DateTime<Utc>>,
    pub lock_ts: Option<DateTime<Utc>>,
    pub seal_deadline_ts: Option<DateTime<Utc>>,
    pub live_start_ts: Option<DateTime<Utc>>,
    pub scheduled_end_ts: Option<DateTime<Utc>>,
    pub button: Option<u8>,
    pub button_seed: Option<Vec<u8>>,
    pub timelock_target: Option<u64>,
    pub void_kind: Option<String>,
    pub event_count: u64,
    pub event_head: Vec<u8>,
    /// The match's chip-token mint (base58). Set from the create intent / verifier; may be
    /// null for matches created before the mint column existed.
    pub mint: Option<String>,
}

impl MatchRow {
    pub fn from_row(row: &Row) -> Result<Self, ApiError> {
        Ok(Self {
            id: row.get("id"),
            match_key: row.get("match_key"),
            onchain_match_id: row.get::<_, i64>("onchain_match_id") as u64,
            status: row.get("status"),
            visibility: row.get("visibility"),
            creator_wallet: row.get("creator_wallet"),
            room_code: row.get("room_code"),
            room_commitment: row.get("room_commitment"),
            feed_symbol: row
                .get::<_, Option<String>>("feed_symbol")
                .unwrap_or_default(),
            config_hash: row.get("config_hash"),
            buy_in: row.get::<_, Option<i64>>("buy_in_chips").unwrap_or(0) as u64,
            entry_fee: row.get::<_, i64>("entry_fee_chips") as u64,
            rake_bps: row.get::<_, Option<i32>>("rake_bps").unwrap_or(0) as u32,
            rake_cap: row.get::<_, Option<i64>>("rake_cap_chips").unwrap_or(0) as u64,
            round_count: row.get::<_, Option<i16>>("round_count").unwrap_or(1) as u8,
            round_durations_sec: int4_array_u64(row, "round_durations_sec"),
            observation_windows_sec: int4_array_u64(row, "observation_windows_sec"),
            action_timeout_ms: row
                .get::<_, Option<i32>>("action_timeout_ms")
                .unwrap_or(25_000) as u64,
            time_bank_sec: row.get::<_, Option<i32>>("time_bank_sec").unwrap_or(60) as u64,
            small_blind: row.get::<_, Option<i64>>("small_blind").unwrap_or(1) as u64,
            big_blind: row.get::<_, Option<i64>>("big_blind").unwrap_or(2) as u64,
            min_players: row.get::<_, Option<i16>>("min_players").unwrap_or(2) as u8,
            max_players: row.get::<_, Option<i16>>("max_players").unwrap_or(2) as u8,
            seal_window_sec: row
                .get::<_, Option<i32>>("seal_window_sec")
                .map(|v| v as u64)
                .unwrap_or(crate::config::DEFAULT_SEAL_WINDOW_SEC),
            begin_live_window_sec: row
                .get::<_, Option<i32>>("begin_live_window_sec")
                .unwrap_or(30) as u64,
            fill_deadline_ts: row.get("fill_deadline_ts"),
            lock_ts: row.get("lock_ts"),
            seal_deadline_ts: row.get("seal_deadline_ts"),
            live_start_ts: row.get("live_start_ts"),
            scheduled_end_ts: row.get("scheduled_end_ts"),
            button: row.get::<_, Option<i16>>("button").map(|b| b as u8),
            button_seed: row.get("button_seed"),
            timelock_target: row
                .get::<_, Option<i64>>("timelock_target")
                .map(|t| t as u64),
            void_kind: row.get("void_kind"),
            event_count: row.get::<_, i64>("event_count") as u64,
            event_head: row.get("event_head"),
            mint: row.get("mint"),
        })
    }

    pub fn total_betting_duration_sec(&self) -> u64 {
        self.round_durations_sec.iter().sum::<u64>()
            + self.observation_windows_sec.iter().sum::<u64>()
    }

    pub fn projected_scheduled_end_ms(&self) -> Option<u64> {
        self.latest_match_end_sec()
            .and_then(|v| v.checked_mul(1000))
    }

    pub fn latest_match_end_sec(&self) -> Option<u64> {
        let seal_deadline_sec = self.seal_deadline_ts?.timestamp().try_into().ok()?;
        Some(crate::config::latest_match_end_sec(
            seal_deadline_sec,
            self.total_betting_duration_sec(),
            self.begin_live_window_sec,
        ))
    }

    pub fn effective_timelock_target(&self) -> Option<u64> {
        self.timelock_target.or_else(|| {
            Some(crate::config::timelock_target_round(
                self.latest_match_end_sec()?,
            ))
        })
    }

    pub fn is_terminal(&self) -> bool {
        matches!(self.status.as_str(), "settled" | "voided")
    }
}

fn int4_array_u64(row: &Row, col: &str) -> Vec<u64> {
    row.get::<_, Option<Vec<i32>>>(col)
        .unwrap_or_default()
        .into_iter()
        .map(|v| v.max(0) as u64)
        .collect()
}

pub async fn load_match(
    client: &tokio_postgres::Client,
    id: Uuid,
) -> Result<Option<MatchRow>, ApiError> {
    let sql = format!("SELECT {MATCH_COLUMNS} FROM matches m WHERE m.id = $1");
    let row = client.query_opt(&sql, &[&id]).await?;
    row.map(|r| MatchRow::from_row(&r)).transpose()
}

pub async fn load_match_pooled(
    pool: &deadpool_postgres::Pool,
    id: Uuid,
) -> Result<Option<MatchRow>, ApiError> {
    let client = pool.get().await?;
    load_match(&client, id).await
}

// ---------------------------------------------------------------------------------
// seats
// ---------------------------------------------------------------------------------

#[derive(Clone, Debug)]
pub struct SeatRow {
    pub engine_seat: u8,
    pub wallet: String,
    pub buy_in: u64,
    pub sealed: bool,
    pub seal_seq: Option<u16>,
    pub prediction_source: Option<String>,
    pub seal_ciphertext: Option<Vec<u8>>,
    pub seal_commitment: Option<Vec<u8>>,
    pub seal_timelock_target: Option<u64>,
    pub seal_chain_confirmed: bool,
    /// Settlement outcome (NULL pre-settlement or for legacy/backfilled matches — see
    /// migration 0013). `pot_won`, not `payout`, is the winner signal.
    pub payout_chips: Option<u64>,
    pub pot_won_chips: Option<u64>,
    pub prediction_wad: Option<String>,
}

pub async fn load_seats(
    client: &tokio_postgres::Client,
    match_id: Uuid,
) -> Result<Vec<SeatRow>, ApiError> {
    let rows = client
        .query(
            r#"
            SELECT seat_index, wallet_address, buy_in_chips, sealed, seal_seq,
                   prediction_source, seal_ciphertext, seal_commitment,
                   seal_timelock_target, seal_chain_confirmed,
                   payout_chips, pot_won_chips, prediction_wad::text AS prediction_wad
            FROM match_seats
            WHERE match_id = $1
            ORDER BY seat_index ASC
            "#,
            &[&match_id],
        )
        .await?;
    Ok(rows
        .iter()
        .map(|r| SeatRow {
            engine_seat: r.get::<_, i16>("seat_index") as u8,
            wallet: r.get("wallet_address"),
            buy_in: r.get::<_, i64>("buy_in_chips") as u64,
            sealed: r.get("sealed"),
            seal_seq: r.get::<_, Option<i16>>("seal_seq").map(|v| v as u16),
            prediction_source: r.get("prediction_source"),
            seal_ciphertext: r.get("seal_ciphertext"),
            seal_commitment: r.get("seal_commitment"),
            seal_timelock_target: r
                .get::<_, Option<i64>>("seal_timelock_target")
                .map(|v| v as u64),
            seal_chain_confirmed: r.get("seal_chain_confirmed"),
            payout_chips: r.get::<_, Option<i64>>("payout_chips").map(|v| v as u64),
            pot_won_chips: r.get::<_, Option<i64>>("pot_won_chips").map(|v| v as u64),
            prediction_wad: r.get("prediction_wad"),
        })
        .collect())
}

/// Batch wallet → handle lookup (only wallets with a set handle are returned).
pub async fn handles_for_wallets(
    client: &tokio_postgres::Client,
    wallets: &[String],
) -> Result<std::collections::HashMap<String, String>, ApiError> {
    if wallets.is_empty() {
        return Ok(std::collections::HashMap::new());
    }
    let rows = client
        .query(
            r#"SELECT wallet_address, handle FROM profile_metadata
               WHERE handle IS NOT NULL AND wallet_address = ANY($1)"#,
            &[&wallets],
        )
        .await?;
    Ok(rows
        .iter()
        .map(|r| (r.get("wallet_address"), r.get("handle")))
        .collect())
}

// ---------------------------------------------------------------------------------
// FCFS ordering (pure mirror of FCFS_PROMOTE_SQL for unit tests + lock payloads)
// ---------------------------------------------------------------------------------

/// Order candidates by `(finalized_slot, tx_sig)` and take the first `max_players` —
/// the exact ordering `FCFS_PROMOTE_SQL` applies in Postgres.
pub fn fcfs_order<T: Clone>(candidates: &[(u64, String, T)], max_players: usize) -> Vec<T> {
    let mut sorted: Vec<_> = candidates.to_vec();
    sorted.sort_by(|a, b| a.0.cmp(&b.0).then_with(|| a.1.cmp(&b.1)));
    sorted
        .into_iter()
        .take(max_players)
        .map(|(_, _, t)| t)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fcfs_orders_by_slot_then_txsig() {
        let cands = vec![
            (200u64, "sigB".to_string(), "late-slot"),
            (100, "sigZ".to_string(), "early-slot-z"),
            (100, "sigA".to_string(), "early-slot-a"),
            (150, "sigC".to_string(), "mid"),
        ];
        let picked = fcfs_order(&cands, 3);
        assert_eq!(picked, vec!["early-slot-a", "early-slot-z", "mid"]);
        // Deterministic + idempotent: re-running yields the same set/order.
        assert_eq!(fcfs_order(&cands, 3), picked);
        // Cap respected.
        assert_eq!(fcfs_order(&cands, 2), vec!["early-slot-a", "early-slot-z"]);
    }

    #[test]
    fn fcfs_promotion_sql_orders_and_caps() {
        assert!(FCFS_PROMOTE_SQL.contains("ORDER BY finalized_slot ASC, tx_sig ASC"));
        assert!(FCFS_PROMOTE_SQL.contains("o.rn < $2"));
        assert!(FCFS_PROMOTE_SQL.contains("finalized_slot IS NOT NULL"));
    }
}

/// The unexpired session key `wallet` granted for `match_id`, if any (see
/// `syndicate_engine::verify::session_key_grant_message`).
pub async fn load_session_key(
    pool: &deadpool_postgres::Pool,
    match_id: uuid::Uuid,
    wallet: &str,
) -> Option<[u8; 32]> {
    let client = pool.get().await.ok()?;
    let row = client
        .query_opt(
            "SELECT session_pubkey FROM match_session_keys
             WHERE match_id = $1 AND wallet = $2 AND expires_at > now()",
            &[&match_id, &wallet],
        )
        .await
        .ok()??;
    row.get::<_, Vec<u8>>("session_pubkey").try_into().ok()
}
