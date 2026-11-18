//! Fibs — the points behind levels and the daily board. Earned for playing a hand, winning
//! one, and quick calls. Reported by the client for now (free play, nothing of value rides
//! on them); each report is capped and rate-limited so the board cannot be flooded.

use axum::extract::{Query, State};
use axum::http::HeaderMap;
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::app::AppState;
use crate::auth::session::require_session;
use crate::error::ApiError;

/// The most one report can add (a won hand is 70; a five-streak quick call is 50).
const MAX_PER_REPORT: i64 = 100;
/// The most a wallet can earn in a UTC day.
const MAX_PER_DAY: i64 = 20_000;

#[derive(Deserialize)]
pub struct EarnBody {
    amount: i64,
}

/// `POST /v1/fibs` — add Fibs to the signed-in wallet. Returns its totals.
pub async fn post_fibs(
    State(st): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<EarnBody>,
) -> Result<Json<Value>, ApiError> {
    let wallet = require_session(&st, &headers).await?;
    st.limits.check_actions(&wallet)?;
    if !(1..=MAX_PER_REPORT).contains(&body.amount) {
        return Err(ApiError::bad_request("amount out of range"));
    }
    let client = st.pool.get().await?;
    let today = client
        .query_one(
            r#"
            INSERT INTO player_fibs_daily (wallet, day, fibs)
            VALUES ($1, (now() AT TIME ZONE 'utc')::date, $2)
            ON CONFLICT (wallet, day)
            DO UPDATE SET fibs = LEAST(player_fibs_daily.fibs + $2, $3)
            RETURNING fibs
            "#,
            &[&wallet, &body.amount, &MAX_PER_DAY],
        )
        .await?
        .get::<_, i64>(0);
    let total = client
        .query_one(
            r#"
            INSERT INTO player_fibs (wallet, fibs) VALUES ($1, $2)
            ON CONFLICT (wallet)
            DO UPDATE SET fibs = player_fibs.fibs + $2, updated_at = now()
            RETURNING fibs
            "#,
            &[&wallet, &body.amount],
        )
        .await?
        .get::<_, i64>(0);
    Ok(Json(json!({ "fibs": total, "today": today })))
}

#[derive(Deserialize)]
pub struct BoardQuery {
    #[serde(default)]
    wallet: Option<String>,
}

/// `GET /v1/fibs/board[?wallet=…]` — today's top twenty, plus that wallet's own place.
pub async fn get_board(
    State(st): State<AppState>,
    Query(q): Query<BoardQuery>,
) -> Result<Json<Value>, ApiError> {
    let client = st.pool.get().await?;
    let rows = client
        .query(
            r#"
            SELECT d.wallet, pm.handle, d.fibs
            FROM player_fibs_daily d
            LEFT JOIN profile_metadata pm ON pm.wallet_address = d.wallet
            WHERE d.day = (now() AT TIME ZONE 'utc')::date
            ORDER BY d.fibs DESC, d.wallet ASC
            LIMIT 20
            "#,
            &[],
        )
        .await?;
    let leaders: Vec<Value> = rows
        .iter()
        .enumerate()
        .map(|(i, r)| {
            let wallet: String = r.get("wallet");
            json!({
                "rank": i + 1,
                "bot": st.cfg.house_bot_wallets.contains(&wallet),
                "wallet": wallet,
                "handle": r.get::<_, Option<String>>("handle"),
                "fibs": r.get::<_, i64>("fibs"),
            })
        })
        .collect();
    let you = match q.wallet {
        Some(w) => client
            .query_opt(
                r#"
                SELECT d.fibs,
                       (SELECT count(*) + 1 FROM player_fibs_daily o
                         WHERE o.day = d.day AND o.fibs > d.fibs) AS rank,
                       COALESCE((SELECT fibs FROM player_fibs t WHERE t.wallet = d.wallet), 0) AS total
                FROM player_fibs_daily d
                WHERE d.wallet = $1 AND d.day = (now() AT TIME ZONE 'utc')::date
                "#,
                &[&w],
            )
            .await?
            .map(|r| {
                json!({
                    "today": r.get::<_, i64>("fibs"),
                    "rank": r.get::<_, i64>("rank"),
                    "fibs": r.get::<_, i64>("total"),
                })
            }),
        None => None,
    };
    Ok(Json(json!({ "leaders": leaders, "you": you })))
}
