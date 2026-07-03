//! Postgres match-registry writers (Phase 05). Matchmaking and the orchestrator
//! delegate lifecycle row writes here; capital safety never depends on these rows.

use chrono::{DateTime, Utc};
use deadpool_postgres::{Config, Pool, Runtime};
use tokio_postgres::Row;

use crate::postgres::{
    PersistedMatchRow, PersistedMatchSeat, ATTACH_CONFIG_HASH_BY_FEED_SQL, INSERT_MATCH_CONFIG_SQL,
    INSERT_MATCH_SEAT_SQL, INSERT_MATCH_SQL, SELECT_CONFIG_ID_BY_HASH_SQL,
    UPDATE_MATCH_ON_BEGIN_LIVE_SQL,
};

#[derive(Debug)]
pub enum RegistryError {
    Pool(String),
    Postgres(String),
    Invalid(String),
    NotFound(String),
}

impl std::fmt::Display for RegistryError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            RegistryError::Pool(e) => write!(f, "pool: {e}"),
            RegistryError::Postgres(e) => write!(f, "postgres: {e}"),
            RegistryError::Invalid(e) => write!(f, "invalid: {e}"),
            RegistryError::NotFound(e) => write!(f, "not found: {e}"),
        }
    }
}

impl std::error::Error for RegistryError {}

#[derive(Clone, Debug)]
pub struct MatchRegistryStore {
    pool: Pool,
}

#[derive(Clone, Debug)]
pub struct InsertMatchParams {
    pub match_key: String,
    pub onchain_match_id: i64,
    pub config_hash_hex: String,
    pub fill_deadline: DateTime<Utc>,
    pub price_feed_symbol: String,
    pub oracle_token_hex: String,
    pub oracle_exponent: i32,
    pub max_oracle_confidence: i64,
    pub buy_in_chips: i64,
    pub entry_fee_chips: i64,
    pub rake_bps: i32,
    pub rake_cap_chips: i64,
    pub max_players: i16,
}

#[derive(Clone, Debug)]
pub struct BeginLiveParams {
    pub match_id: String,
    pub live_start: DateTime<Utc>,
    pub scheduled_end: DateTime<Utc>,
    pub lock_ts: DateTime<Utc>,
    pub seal_deadline: DateTime<Utc>,
    pub sealed_count: i16,
    pub nonseal_penalty_bps: i32,
}

impl MatchRegistryStore {
    pub fn from_database_url(database_url: &str) -> Result<Self, RegistryError> {
        let mut cfg = Config::new();
        cfg.url = Some(database_url.to_string());
        let pool = cfg
            .create_pool(Some(Runtime::Tokio1), tokio_postgres::NoTls)
            .map_err(|e| RegistryError::Pool(e.to_string()))?;
        Ok(Self { pool })
    }

    pub fn pool(&self) -> &Pool {
        &self.pool
    }

    pub async fn insert_match(
        &self,
        params: InsertMatchParams,
    ) -> Result<PersistedMatchRow, RegistryError> {
        let config_hash = decode_config_hash(&params.config_hash_hex)?;
        let pyth_feed_id = oracle_token_to_feed_id(&params.oracle_token_hex)?;
        let client = self.pool.get().await.map_err(map_pool)?;
        let config_id = ensure_config_id(&client, &config_hash, &pyth_feed_id, &params).await?;
        let config_uuid = uuid::Uuid::parse_str(&config_id)
            .map_err(|e| RegistryError::Invalid(format!("invalid config_id uuid: {e}")))?;
        let row = client
            .query_one(
                INSERT_MATCH_SQL,
                &[
                    &params.match_key,
                    &params.onchain_match_id,
                    &config_uuid,
                    &params.fill_deadline,
                ],
            )
            .await
            .map_err(|e| map_pg_stmt(e, "INSERT_MATCH"))?;
        row_to_match_row(&row)
    }

    pub async fn insert_match_seat(
        &self,
        match_id: &str,
        seat_index: i16,
        wallet: &str,
        deposit_signature: &str,
        buy_in_chips: i64,
        entry_fee_chips: i64,
    ) -> Result<PersistedMatchSeat, RegistryError> {
        let client = self.pool.get().await.map_err(map_pool)?;
        let row = client
            .query_opt(
                INSERT_MATCH_SEAT_SQL,
                &[
                    &match_id,
                    &seat_index,
                    &wallet,
                    &deposit_signature,
                    &buy_in_chips,
                    &entry_fee_chips,
                ],
            )
            .await
            .map_err(map_pg)?;
        let Some(row) = row else {
            return Err(RegistryError::NotFound(format!(
                "match not found for seat insert: {match_id}"
            )));
        };
        row_to_match_seat(&row)
    }

    pub async fn update_match_on_begin_live(
        &self,
        params: BeginLiveParams,
    ) -> Result<String, RegistryError> {
        let client = self.pool.get().await.map_err(map_pool)?;
        let row = client
            .query_opt(
                UPDATE_MATCH_ON_BEGIN_LIVE_SQL,
                &[
                    &params.match_id,
                    &params.live_start,
                    &params.scheduled_end,
                    &params.lock_ts,
                    &params.seal_deadline,
                    &params.sealed_count,
                    &params.nonseal_penalty_bps,
                ],
            )
            .await
            .map_err(map_pg)?;
        let Some(row) = row else {
            return Err(RegistryError::NotFound(format!(
                "match not found for begin_live update: {}",
                params.match_id
            )));
        };
        Ok(row.get("id"))
    }
}

fn decode_config_hash(hex_str: &str) -> Result<Vec<u8>, RegistryError> {
    let hex = hex_str.trim().trim_start_matches("0x");
    let bytes =
        hex::decode(hex).map_err(|e| RegistryError::Invalid(format!("config_hash: {e}")))?;
    if bytes.len() != 32 {
        return Err(RegistryError::Invalid(format!(
            "config_hash must be 32 bytes, got {}",
            bytes.len()
        )));
    }
    Ok(bytes)
}

/// Signed-price token (20 bytes) left-padded to 32 bytes for `match_configs.pyth_feed_id`.
fn oracle_token_to_feed_id(token_hex: &str) -> Result<Vec<u8>, RegistryError> {
    let hex = token_hex.trim().trim_start_matches("0x");
    let token =
        hex::decode(hex).map_err(|e| RegistryError::Invalid(format!("oracle_token: {e}")))?;
    if token.len() != 20 {
        return Err(RegistryError::Invalid(format!(
            "oracle_token must be 20 bytes, got {}",
            token.len()
        )));
    }
    let mut out = vec![0u8; 32];
    out[..20].copy_from_slice(&token);
    Ok(out)
}

fn row_to_match_row(row: &Row) -> Result<PersistedMatchRow, RegistryError> {
    Ok(PersistedMatchRow {
        match_id: row.get("id"),
        match_key: row.get("match_key"),
        onchain_match_id: row.get("onchain_match_id"),
        status: row.get("status"),
        room_status: row.get("room_status"),
    })
}

fn row_to_match_seat(row: &Row) -> Result<PersistedMatchSeat, RegistryError> {
    Ok(PersistedMatchSeat {
        match_id: row.get("match_id"),
        seat_index: row.get("seat_index"),
        wallet_address: row.get("wallet_address"),
        deposit_signature: row.get("deposit_signature"),
    })
}

async fn ensure_config_id(
    client: &deadpool_postgres::Object,
    config_hash: &Vec<u8>,
    pyth_feed_id: &Vec<u8>,
    params: &InsertMatchParams,
) -> Result<String, RegistryError> {
    const CONFIG_VERSION: i32 = 1;

    if let Some(row) = client
        .query_opt(SELECT_CONFIG_ID_BY_HASH_SQL, &[&config_hash.as_slice()])
        .await
        .map_err(|e| map_pg_stmt(e, "SELECT_CONFIG_ID_BY_HASH"))?
    {
        return Ok(row.get(0));
    }

    let oracle_exponent: i16 = params.oracle_exponent.try_into().map_err(|_| {
        RegistryError::Invalid(format!(
            "oracle_exponent out of range for smallint: {}",
            params.oracle_exponent
        ))
    })?;

    let insert_params: &[&(dyn tokio_postgres::types::ToSql + Sync)] = &[
        &CONFIG_VERSION,
        &params.price_feed_symbol,
        &pyth_feed_id.as_slice(),
        &oracle_exponent,
        &params.max_oracle_confidence,
        &params.buy_in_chips,
        &params.entry_fee_chips,
        &params.rake_bps,
        &params.rake_cap_chips,
        &params.max_players,
        &"matchmaking",
        &config_hash.as_slice(),
    ];

    match client
        .query_one(INSERT_MATCH_CONFIG_SQL, insert_params)
        .await
    {
        Ok(row) => Ok(row.get(0)),
        Err(err) if is_unique_violation(&err) => {
            if let Some(row) = client
                .query_opt(
                    ATTACH_CONFIG_HASH_BY_FEED_SQL,
                    &[
                        &config_hash.as_slice(),
                        &params.price_feed_symbol,
                        &CONFIG_VERSION,
                    ],
                )
                .await
                .map_err(|e| map_pg_stmt(e, "ATTACH_CONFIG_HASH_BY_FEED"))?
            {
                return Ok(row.get(0));
            }
            if let Some(row) = client
                .query_opt(SELECT_CONFIG_ID_BY_HASH_SQL, &[&config_hash.as_slice()])
                .await
                .map_err(|e| map_pg_stmt(e, "SELECT_CONFIG_ID_BY_HASH"))?
            {
                return Ok(row.get(0));
            }
            Err(map_pg_stmt(err, "INSERT_MATCH_CONFIG"))
        }
        Err(err) => Err(map_pg_stmt(err, "INSERT_MATCH_CONFIG")),
    }
}

fn is_unique_violation(err: &tokio_postgres::Error) -> bool {
    err.code()
        .map(|code| code == &tokio_postgres::error::SqlState::UNIQUE_VIOLATION)
        .unwrap_or(false)
}

fn map_pool(err: deadpool_postgres::PoolError) -> RegistryError {
    RegistryError::Pool(err.to_string())
}

fn map_pg(err: tokio_postgres::Error) -> RegistryError {
    if let Some(db) = err.as_db_error() {
        let mut msg = db.message().to_string();
        if let Some(constraint) = db.constraint() {
            msg.push_str(&format!(" (constraint: {constraint})"));
        }
        if let Some(detail) = db.detail() {
            msg.push_str(&format!(" — {detail}"));
        }
        if let Some(hint) = db.hint() {
            msg.push_str(&format!(" [hint: {hint}]"));
        }
        return RegistryError::Postgres(msg);
    }
    RegistryError::Postgres(err.to_string())
}

fn map_pg_stmt(err: tokio_postgres::Error, stmt: &str) -> RegistryError {
    match map_pg(err) {
        RegistryError::Postgres(msg) => RegistryError::Postgres(format!("{stmt}: {msg}")),
        other => other,
    }
}

pub fn unix_to_datetime(secs: u64) -> Result<DateTime<Utc>, RegistryError> {
    DateTime::from_timestamp(secs as i64, 0)
        .ok_or_else(|| RegistryError::Invalid(format!("invalid unix timestamp: {secs}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn oracle_token_pads_to_32_bytes() {
        let id = oracle_token_to_feed_id("0xa7BaE7da3E4950700BE9f107EB186e89a474d180").unwrap();
        assert_eq!(id.len(), 32);
        assert_eq!(
            &id[..20],
            &hex::decode("a7bae7da3e4950700be9f107eb186e89a474d180").unwrap()
        );
        assert!(id[20..].iter().all(|&b| b == 0));
    }

    #[test]
    fn config_hash_must_be_32_bytes() {
        assert!(decode_config_hash(&"aa".repeat(32)).is_ok());
        assert!(decode_config_hash(&"aa".repeat(31)).is_err());
    }
}
