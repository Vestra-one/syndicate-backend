//! Leaderboard + player profiles (handle, stats). Reads aggregate over the settlement
//! outcomes persisted by `chainjobs.rs::persist_settlement_outcome` (migration 0013);
//! matches without persisted payouts (pre-migration/legacy, or voided) are excluded.

use axum::extract::{Path, Query, State};
use axum::http::HeaderMap;
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::app::AppState;
use crate::auth::session::require_session;
use crate::error::ApiError;
use crate::util::now_ms;

const RESERVED_HANDLES: &[&str] = &[
    "admin",
    "syndicate",
    "house",
    "dealer",
    "mod",
    "moderator",
    "system",
    "the_room",
];

/// Trim + validate a proposed handle. Display case is preserved; uniqueness is
/// case-insensitive (enforced by the DB's `lower(handle)` unique index).
fn validate_handle(raw: &str) -> Result<String, ApiError> {
    let handle = raw.trim().to_string();
    if handle.chars().count() < 3 || handle.chars().count() > 20 {
        return Err(ApiError::bad_request(
            "handle must be 3-20 characters",
        ));
    }
    if !handle.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
        return Err(ApiError::bad_request(
            "handle may only contain letters, digits, and underscores",
        ));
    }
    if !handle.chars().any(|c| c.is_ascii_alphanumeric()) {
        return Err(ApiError::bad_request(
            "handle must contain at least one letter or digit",
        ));
    }
    if RESERVED_HANDLES.contains(&handle.to_lowercase().as_str()) {
        return Err(ApiError::forbidden(
            "reserved_handle",
            "that handle is reserved",
        ));
    }
    Ok(handle)
}

#[derive(Deserialize)]
pub struct LeaderboardQuery {
    #[serde(default = "default_period")]
    pub period: String,
    #[serde(default = "default_limit")]
    pub limit: i64,
}
fn default_period() -> String {
    "all".to_string()
}
fn default_limit() -> i64 {
    50
}

/// `GET /v1/leaderboard?period=day|all&limit=` — net winnings ranking over settled
/// matches with persisted payouts.
pub async fn get_leaderboard(
    State(st): State<AppState>,
    Query(q): Query<LeaderboardQuery>,
) -> Result<Json<Value>, ApiError> {
    let since = match q.period.as_str() {
        "all" => None,
        "day" => Some(chrono::Utc::now() - chrono::Duration::hours(24)),
        _ => return Err(ApiError::bad_request("period must be 'day' or 'all'")),
    };
    let limit = q.limit.clamp(1, 100);
    let client = st.pool.get().await?;
    let rows = client
        .query(
            r#"
            SELECT ms.wallet_address AS wallet, pm.handle,
                   count(*) AS matches,
                   count(*) FILTER (WHERE ms.pot_won_chips > 0) AS wins,
                   sum(ms.payout_chips - ms.buy_in_chips - ms.entry_fee_chips)::bigint AS net_chips,
                   max(ms.pot_won_chips) AS best_pot
            FROM match_seats ms
            JOIN matches m ON m.id = ms.match_id
            LEFT JOIN profile_metadata pm ON pm.wallet_address = ms.wallet_address
            WHERE m.status = 'settled' AND ms.payout_chips IS NOT NULL
              AND ($2::timestamptz IS NULL OR m.settled_at >= $2)
            GROUP BY ms.wallet_address, pm.handle
            ORDER BY net_chips DESC, wins DESC, wallet ASC
            LIMIT $1
            "#,
            &[&limit, &since],
        )
        .await?;
    let leaders: Vec<Value> = rows
        .iter()
        .enumerate()
        .map(|(i, r)| {
            json!({
                "rank": (i + 1) as i64,
                "wallet": r.get::<_, String>("wallet"),
                "handle": r.get::<_, Option<String>>("handle"),
                "matches": r.get::<_, i64>("matches"),
                "wins": r.get::<_, i64>("wins"),
                "net_chips": r.get::<_, Option<i64>>("net_chips").unwrap_or(0),
                "best_pot": r.get::<_, Option<i64>>("best_pot"),
            })
        })
        .collect();
    Ok(Json(json!({
        "v": 1, "server_time_ms": now_ms(),
        "period": q.period,
        "leaders": leaders,
    })))
}

/// `GET /v1/profiles/{wallet}` — handle + lifetime stats. Unknown/never-played wallets
/// still return a zeroed stats block.
pub async fn get_profile(
    State(st): State<AppState>,
    Path(wallet): Path<String>,
) -> Result<Json<Value>, ApiError> {
    if wallet == "me" {
        return Err(ApiError::bad_request(
            "use PUT /v1/profiles/me with a session to update your own profile",
        ));
    }
    let client = st.pool.get().await?;
    let profile = client
        .query_opt(
            "SELECT handle, avatar_uri, avatar_seed FROM profile_metadata WHERE wallet_address = $1",
            &[&wallet],
        )
        .await?;
    let stats = client
        .query_one(
            r#"
            SELECT count(*) AS matches,
                   count(*) FILTER (WHERE ms.pot_won_chips > 0) AS wins,
                   COALESCE(sum(ms.payout_chips - ms.buy_in_chips - ms.entry_fee_chips), 0)::bigint AS net_chips,
                   max(ms.pot_won_chips) AS best_pot
            FROM match_seats ms
            JOIN matches m ON m.id = ms.match_id
            WHERE ms.wallet_address = $1 AND m.status = 'settled' AND ms.payout_chips IS NOT NULL
            "#,
            &[&wallet],
        )
        .await?;
    Ok(Json(json!({
        "v": 1, "server_time_ms": now_ms(),
        "wallet": wallet,
        "handle": profile.as_ref().and_then(|r| r.get::<_, Option<String>>("handle")),
        "avatar_uri": profile.as_ref().and_then(|r| r.get::<_, Option<String>>("avatar_uri")),
        "avatar_seed": profile.as_ref().and_then(|r| r.get::<_, Option<String>>("avatar_seed")),
        "stats": {
            "tables_played": stats.get::<_, i64>("matches"),
            "pots_won": stats.get::<_, i64>("wins"),
            "net_chips": stats.get::<_, i64>("net_chips"),
            "best_pot": stats.get::<_, Option<i64>>("best_pot"),
        },
    })))
}

#[derive(Deserialize)]
pub struct ProfileBody {
    pub handle: String,
    #[serde(default)]
    pub avatar_seed: Option<String>,
}

/// `PUT /v1/profiles/me` — set your own handle (+ optional avatar seed). Session-authed.
pub async fn put_profile_me(
    State(st): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<ProfileBody>,
) -> Result<Json<Value>, ApiError> {
    let wallet = require_session(&st, &headers).await?;
    st.limits.check_profile_updates(&wallet)?;
    let handle = validate_handle(&body.handle)?;

    let client = st.pool.get().await?;
    let result = client
        .execute(
            r#"
            INSERT INTO profile_metadata (wallet_address, handle, avatar_seed, updated_at)
            VALUES ($1, $2, $3, now())
            ON CONFLICT (wallet_address)
            DO UPDATE SET handle = EXCLUDED.handle,
                          avatar_seed = COALESCE(EXCLUDED.avatar_seed, profile_metadata.avatar_seed),
                          updated_at = now()
            "#,
            &[&wallet, &handle, &body.avatar_seed],
        )
        .await;
    if let Err(e) = result {
        if is_unique_violation(&e) {
            return Err(ApiError::conflict("handle_taken", "that handle is already in use"));
        }
        return Err(e.into());
    }
    Ok(Json(json!({
        "v": 1, "server_time_ms": now_ms(),
        "wallet": wallet,
        "handle": handle,
        "avatar_seed": body.avatar_seed,
    })))
}

fn is_unique_violation(e: &tokio_postgres::Error) -> bool {
    e.code() == Some(&tokio_postgres::error::SqlState::UNIQUE_VIOLATION)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_reasonable_handles() {
        assert_eq!(validate_handle("syn_ace").unwrap(), "syn_ace");
        assert_eq!(validate_handle("  Night_Auditor  ").unwrap(), "Night_Auditor");
    }

    #[test]
    fn rejects_out_of_range_length() {
        assert!(validate_handle("ab").is_err());
        assert!(validate_handle(&"a".repeat(21)).is_err());
    }

    #[test]
    fn rejects_bad_charset() {
        assert!(validate_handle("bad handle").is_err());
        assert!(validate_handle("bad-handle").is_err());
        assert!(validate_handle("bad!handle").is_err());
    }

    #[test]
    fn rejects_all_underscores() {
        assert!(validate_handle("____").is_err());
    }

    #[test]
    fn rejects_reserved_case_insensitively() {
        assert!(validate_handle("Admin").is_err());
        assert!(validate_handle("SYNDICATE").is_err());
    }

    #[test]
    fn preserves_display_case() {
        assert_eq!(validate_handle("QuietWhale").unwrap(), "QuietWhale");
    }
}
