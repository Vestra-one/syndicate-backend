//! Build action-log sync payloads from replayed events and drive settlement-chain.

use deadpool_postgres::Pool;
use serde_json::{json, Value};
use syndicate_engine::service::{
    EngineLogEvent, EngineSnapshot, EventEnvelope, FencedMatchRuntime,
};
use syndicate_settlement::ops::net::SettlementChainHttpClient;
use syndicate_settlement::ops::SettlementJob;

use crate::reconstruct::load_event_envelopes;

pub fn build_sync_payload(
    job: &SettlementJob,
    snapshot: &EngineSnapshot,
    envelopes: &[EventEnvelope],
) -> Value {
    let entries: Vec<Value> = envelopes
        .iter()
        .filter_map(|e| map_event(&e.event))
        .collect();
    let deadline = job
        .pyth_context
        .rules
        .scheduled_end_ts
        .saturating_add(job.pyth_context.rules.oracle_delay_window_sec);
    json!({
        "match": {
            "onchainMatchId": job.chain_context.onchain_match_id.to_string(),
            "seatWallets": job.chain_context.seat_wallets,
        },
        "signingMatchId": snapshot.config.onchain_match_id.to_string(),
        "init": {
            "button": snapshot.config.button,
            "smallBlind": snapshot.config.small_blind,
            "bigBlind": snapshot.config.big_blind,
            "roundCount": snapshot.config.round_count,
            "settleDeadlineTs": deadline,
            "sealSeq": snapshot.engine.seats.iter().map(|s| s.seal_seq).collect::<Vec<_>>(),
        },
        "entries": entries,
        "finalize": {
            "eventRootHex": hex::encode(job.event_root),
        },
    })
}

fn map_event(event: &EngineLogEvent) -> Option<Value> {
    match event {
        EngineLogEvent::PlayerAction { intent } => Some(json!({
            "kind": "player.action",
            "seatIndex": intent.seat_index,
            "wallet": intent.wallet,
            "nonce": intent.nonce,
            "prevHeadHex": hex::encode(intent.prev_head),
            "action": format!("{:?}", intent.action),
            "amount": action_amount(intent.action),
            "signature": intent.signature,
        })),
        EngineLogEvent::DefaultPolicyRegistered { policy } => Some(json!({
            "kind": "default.registered",
            "seatIndex": policy.seat_index,
            "wallet": policy.wallet,
            "policyTag": default_policy_tag(policy.policy),
            "signature": policy.signature,
        })),
        EngineLogEvent::TimeoutDefaultApplied { seat_index, .. } => Some(json!({
            "kind": "timeout.default",
            "seatIndex": seat_index,
        })),
        EngineLogEvent::PredictionSealed { commitment, .. } => Some(json!({
            "kind": "prediction.commitment",
            "seatIndex": commitment.player_id,
            "wallet": commitment.wallet,
            "sealSeq": commitment.seal_seq,
                "commitmentHex": hex::encode(commitment.commitment),
                "blindingHex": hex::encode(commitment.blinding),
                "signature": commitment.signature,
        })),
        _ => None,
    }
}

fn action_amount(action: syndicate_engine::Action) -> u64 {
    use syndicate_engine::Action;
    match action {
        Action::BetTo(v) | Action::RaiseTo(v) => v,
        _ => 0,
    }
}

fn default_policy_tag(policy: syndicate_engine::DefaultAction) -> u8 {
    use syndicate_engine::DefaultAction;
    match policy {
        DefaultAction::CheckFold => 0,
        DefaultAction::CheckCallAny => 1,
    }
}

pub async fn sync_action_log_for_job(
    pool: &Pool,
    chain: &SettlementChainHttpClient,
    job: &SettlementJob,
) -> Result<(), String> {
    let envelopes = load_event_envelopes(pool, &job.match_id)
        .await
        .map_err(|e| e.to_string())?;
    let snapshot = FencedMatchRuntime::replay(&envelopes).map_err(|e| format!("replay: {e:?}"))?;
    let payload = build_sync_payload(job, &snapshot, &envelopes);
    chain
        .sync_action_log(payload)
        .map_err(|e| format!("action-log sync: {e:?}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use syndicate_engine::service::{EngineLogEvent, SignedActionIntent, SignedDefaultPolicy};
    use syndicate_engine::{Action, DefaultAction};

    #[test]
    fn player_action_maps_to_sync_entry() {
        let event = EngineLogEvent::PlayerAction {
            intent: SignedActionIntent {
                seat_index: 0,
                wallet: "11111111111111111111111111111111".into(),
                nonce: 1,
                prev_head: [0u8; 32],
                action: Action::Call,
                signature: "sig-test".into(),
            },
        };
        let mapped = map_event(&event).unwrap();
        assert_eq!(mapped["kind"], "player.action");
    }

    #[test]
    fn default_policy_maps_to_sync_entry() {
        let event = EngineLogEvent::DefaultPolicyRegistered {
            policy: SignedDefaultPolicy {
                seat_index: 0,
                wallet: "11111111111111111111111111111111".into(),
                policy: DefaultAction::CheckFold,
                signature: "sig-default".into(),
            },
        };
        let mapped = map_event(&event).unwrap();
        assert_eq!(mapped["policyTag"], 0);
    }
}
