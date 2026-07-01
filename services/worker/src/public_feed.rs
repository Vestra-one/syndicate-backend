//! Publish terminal settlement/void events to the match outbox for action-feed.

use deadpool_postgres::Pool;
use serde_json::json;
use syndicate_settlement::{Outcome, SettlementBundle};
use syndicate_store::INSERT_PUBLIC_MATCH_OUTBOX_SQL;

pub async fn publish_terminal_public_event(
    pool: &Pool,
    match_id: &str,
    outcome: &Outcome,
) -> Result<(), String> {
    let match_uuid = resolve_match_uuid(pool, match_id).await?;
    let (event_type, payload) = match outcome {
        Outcome::Settled(bundle) => (
            "match.public.settled",
            public_settlement_payload(match_id, bundle, false),
        ),
        Outcome::Void(_) => (
            "match.public.voided",
            public_void_payload(match_id),
        ),
    };
    pool.get()
        .await
        .map_err(|e| e.to_string())?
        .execute(
            INSERT_PUBLIC_MATCH_OUTBOX_SQL,
            &[&match_uuid, &event_type, &payload],
        )
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

fn public_settlement_payload(
    match_id: &str,
    bundle: &SettlementBundle,
    voided: bool,
) -> serde_json::Value {
    let settlement_price = bundle.result.settlement_price as i64;
    let awards: Vec<serde_json::Value> = bundle
        .result
        .pot_awards
        .iter()
        .map(|award| {
            json!({
                "seat": award.player.0,
                "amount": award.amount,
            })
        })
        .collect();
    json!({
        "kind": if voided { "match.public.voided" } else { "match.public.settled" },
        "match_id": match_id,
        "settlement_price": settlement_price,
        "awards": awards,
        "voided": voided,
        "ts": chrono::Utc::now().timestamp_millis(),
        "seq": 9_000_000_000_i64,
    })
}

fn public_void_payload(match_id: &str) -> serde_json::Value {
    json!({
        "kind": "match.public.voided",
        "match_id": match_id,
        "settlement_price": 0,
        "awards": [],
        "voided": true,
        "ts": chrono::Utc::now().timestamp_millis(),
        "seq": 9_000_000_000_i64,
    })
}

async fn resolve_match_uuid(pool: &Pool, match_id: &str) -> Result<uuid::Uuid, String> {
    if let Ok(id) = uuid::Uuid::parse_str(match_id) {
        return Ok(id);
    }
    let row = pool
        .get()
        .await
        .map_err(|e| e.to_string())?
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
        .map_err(|e| e.to_string())?;
    row.map(|r| r.get("id"))
        .ok_or_else(|| format!("match not found for public feed publish: {match_id}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn void_payload_marks_terminal_state() {
        let payload = public_void_payload("m1");
        assert_eq!(payload["kind"], "match.public.voided");
        assert_eq!(payload["voided"], true);
    }
}
