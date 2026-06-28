//! Tokio HTTP gameplay API for match-engine.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::sync::Mutex;

use crate::coordinator::MatchCoordinator;
use crate::persistence::PostgresMatchStore;
use crate::redis_pub::MatchEventPublisher;
use crate::service::{
    FencedMatchRuntime, MatchConfig, SignedActionIntent, SignedDefaultPolicy,
    SignedPredictionCommitment,
};
use crate::{Action, DefaultAction, Phase};
use syndicate_shared::PlayerId;

#[derive(Clone)]
pub struct EngineServerState {
    coordinator: Arc<Mutex<Option<MatchCoordinator>>>,
    runtimes: Arc<Mutex<HashMap<String, ActiveMatch>>>,
    publisher: MatchEventPublisher,
    node_id: String,
}

struct ActiveMatch {
    runtime: FencedMatchRuntime,
    action_deadline_ms: u64,
}

impl EngineServerState {
    pub async fn from_env() -> Result<Self, String> {
        let database_url = std::env::var("DATABASE_URL").map_err(|_| "DATABASE_URL required")?;
        let node_id = std::env::var("MATCH_ENGINE_NODE_ID").unwrap_or_else(|_| "engine-1".into());
        let store =
            PostgresMatchStore::from_url(&database_url, &node_id).map_err(|e| e.to_string())?;
        let timelock_round = std::env::var("TIMELOCK_TARGET_ROUND")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(1_000_000);
        let use_pg_leases = std::env::var("MATCH_ENGINE_POSTGRES_LEASES")
            .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
            .unwrap_or(true);
        let coordinator = if use_pg_leases {
            MatchCoordinator::with_postgres_leases(store, timelock_round)
        } else {
            MatchCoordinator::new(store, timelock_round)
        };
        Ok(Self {
            coordinator: Arc::new(Mutex::new(Some(coordinator))),
            runtimes: Arc::new(Mutex::new(HashMap::new())),
            publisher: MatchEventPublisher::from_env(),
            node_id,
        })
    }

    pub fn demo() -> Self {
        Self {
            coordinator: Arc::new(Mutex::new(None)),
            runtimes: Arc::new(Mutex::new(HashMap::new())),
            publisher: MatchEventPublisher::disabled(),
            node_id: "demo".into(),
        }
    }

    pub fn runtimes_handle(&self) -> Arc<Mutex<HashMap<String, ActiveMatch>>> {
        Arc::clone(&self.runtimes)
    }

    pub fn publisher(&self) -> MatchEventPublisher {
        self.publisher.clone()
    }
}

#[derive(Debug, Deserialize)]
struct StartBody {
    #[serde(rename = "matchId")]
    match_id: String,
    #[serde(rename = "onchainMatchId")]
    onchain_match_id: Option<u64>,
    players: Option<Vec<PlayerSeat>>,
    button: Option<u8>,
    #[serde(rename = "smallBlind")]
    small_blind: Option<u64>,
    #[serde(rename = "bigBlind")]
    big_blind: Option<u64>,
    #[serde(rename = "roundCount")]
    round_count: Option<u8>,
    #[serde(rename = "actionTimeoutMs")]
    action_timeout_ms: Option<u64>,
}

#[derive(Debug, Deserialize, Clone)]
struct PlayerSeat {
    #[serde(rename = "seatIndex")]
    seat_index: u16,
    stack: u64,
    #[serde(rename = "sealSeq")]
    seal_seq: u64,
    wallet: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ActionBody {
    wallet: String,
    action: Option<serde_json::Value>,
    default: Option<String>,
    signature: String,
    #[serde(rename = "seatIndex")]
    seat_index: Option<u16>,
    nonce: Option<u64>,
    #[serde(rename = "prevHeadHex")]
    prev_head_hex: Option<String>,
}

#[derive(Debug, Deserialize)]
struct SealBody {
    wallet: Option<String>,
    #[serde(rename = "playerId")]
    player_id: Option<u16>,
    #[serde(rename = "targetRound")]
    target_round: Option<u64>,
    ciphertext: String,
    #[serde(rename = "commitmentHex")]
    commitment_hex: Option<String>,
    #[serde(rename = "blindingHex")]
    blinding_hex: Option<String>,
    signature: Option<String>,
}

#[derive(Debug, Serialize)]
struct StateResponse {
    #[serde(rename = "matchId")]
    match_id: String,
    phase: String,
    round: u8,
    pot: u64,
    #[serde(rename = "toActSeat")]
    to_act_seat: Option<usize>,
    #[serde(rename = "nodeId")]
    node_id: String,
}

pub async fn run(state: EngineServerState, addr: &str) -> Result<(), String> {
    let listener = TcpListener::bind(addr)
        .await
        .map_err(|e| format!("bind {addr}: {e}"))?;
    println!("match-engine listening on http://{addr}");

    let timer_state = state.clone();
    tokio::spawn(async move {
        timeout_loop(timer_state).await;
    });

    loop {
        let (mut stream, _) = listener.accept().await.map_err(|e| e.to_string())?;
        let state = state.clone();
        tokio::spawn(async move {
            let mut buf = vec![0u8; 65536];
            let n = stream.read(&mut buf).await.unwrap_or(0);
            if n == 0 {
                return;
            }
            let request = String::from_utf8_lossy(&buf[..n]);
            let (status, body) = handle(&state, &request).await;
            let response = format!(
                "HTTP/1.1 {status}\r\ncontent-type: application/json\r\ncontent-length: {}\r\ncache-control: no-store\r\n\r\n{body}",
                body.len()
            );
            let _ = stream.write_all(response.as_bytes()).await;
        });
    }
}

async fn timeout_loop(state: EngineServerState) {
    let interval_ms = std::env::var("MATCH_ENGINE_TIMEOUT_POLL_MS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(500);
    loop {
        tokio::time::sleep(tokio::time::Duration::from_millis(interval_ms)).await;
        let now = now_ms();
        let mut guard = state.runtimes.lock().await;
        let ids: Vec<String> = guard.keys().cloned().collect();
        for match_id in ids {
            let Some(active) = guard.get_mut(&match_id) else {
                continue;
            };
            if active.runtime.engine().phase == Phase::Settlement
                || active.runtime.engine().is_complete()
            {
                continue;
            }
            let Some(to_act) = active.runtime.engine().to_act else {
                continue;
            };
            if now < active.action_deadline_ms {
                continue;
            }
            let default = active
                .runtime
                .registered_defaults()
                .get(&to_act)
                .map(|p| p.policy)
                .unwrap_or(DefaultAction::CheckFold);
            let deadline = active.action_deadline_ms;
            let mut coord = state.coordinator.lock().await;
            let Some(coordinator) = coord.as_mut() else {
                continue;
            };
            if coordinator
                .apply_timeout(&mut active.runtime, now, to_act, default, deadline)
                .await
                .is_ok()
            {
                active.action_deadline_ms =
                    now.saturating_add(active.runtime.config().action_timeout_ms);
                let payload = state_payload(&state, &match_id, &active.runtime);
                drop(coord);
                state.publisher.publish(&match_id, &payload).await;
            }
        }
    }
}

async fn handle(state: &EngineServerState, request: &str) -> (&'static str, String) {
    let (method, path) = parse_request_line(request);
    let body = request.split("\r\n\r\n").nth(1).unwrap_or("").trim();

    if method == "GET" && path == "/healthz" {
        return ("200 OK", r#"{"ok":true}"#.into());
    }
    if method == "GET" && path == "/metrics" {
        return ("200 OK", "syndicate_match_engine_up 1\n".into());
    }

    if method == "POST" && path == "/internal/matches/start" {
        return start_match(state, body).await;
    }

    if method == "POST" && path.starts_with("/internal/matches/") && path.ends_with("/actions") {
        let match_id = path
            .trim_start_matches("/internal/matches/")
            .trim_end_matches("/actions");
        return apply_action(state, match_id, body).await;
    }

    if method == "POST" && path.starts_with("/internal/matches/") && path.ends_with("/seal") {
        let match_id = path
            .trim_start_matches("/internal/matches/")
            .trim_end_matches("/seal");
        return seal_match(state, match_id, body).await;
    }

    if method == "GET" && path.starts_with("/internal/matches/") && path.ends_with("/state") {
        let match_id = path
            .trim_start_matches("/internal/matches/")
            .trim_end_matches("/state");
        return get_state(state, match_id).await;
    }

    ("404 Not Found", r#"{"error":"not found"}"#.into())
}

async fn start_match(state: &EngineServerState, body: &str) -> (&'static str, String) {
    let input: StartBody = match serde_json::from_str(body) {
        Ok(v) => v,
        Err(e) => return ("400 Bad Request", format!(r#"{{"error":"{e}"}}"#)),
    };
    let mut guard = state.coordinator.lock().await;
    let Some(coordinator) = guard.as_mut() else {
        let mut runtimes = state.runtimes.lock().await;
        let players = input.players.clone().unwrap_or_default();
        let config = demo_config(&input, &players);
        let runtime = FencedMatchRuntime::start(
            config,
            crate::service::MatchLease {
                match_id: input.match_id.clone(),
                owner_id: state.node_id.clone(),
                fencing_token: 1,
                expires_at_ms: now_ms() + 60_000,
            },
        );
        runtimes.insert(
            input.match_id.clone(),
            ActiveMatch {
                runtime,
                action_deadline_ms: now_ms() + 25_000,
            },
        );
        return (
            "200 OK",
            serde_json::json!({ "ok": true, "demo": true, "matchId": input.match_id }).to_string(),
        );
    };

    let players_input = input.players.clone().unwrap_or_default();
    if players_input.len() < 2 {
        return (
            "400 Bad Request",
            r#"{"error":"at least 2 players required"}"#.into(),
        );
    }
    let config = build_config(&input, &players_input);
    let now = now_ms();
    match coordinator
        .start_match(config.clone(), &state.node_id, now)
        .await
    {
        Ok(runtime) => {
            let timeout = config.action_timeout_ms;
            state.runtimes.lock().await.insert(
                input.match_id.clone(),
                ActiveMatch {
                    runtime,
                    action_deadline_ms: now.saturating_add(timeout),
                },
            );
            let payload = serde_json::json!({
                "type": "matchState",
                "state": {
                    "matchId": input.match_id,
                    "phase": "LIVE",
                    "round": 1,
                }
            });
            state.publisher.publish(&input.match_id, &payload).await;
            (
                "200 OK",
                serde_json::json!({ "ok": true, "matchId": input.match_id }).to_string(),
            )
        }
        Err(e) => ("409 Conflict", format!(r#"{{"error":"{e}"}}"#)),
    }
}

async fn apply_action(
    state: &EngineServerState,
    match_id: &str,
    body: &str,
) -> (&'static str, String) {
    let input: ActionBody = match serde_json::from_str(body) {
        Ok(v) => v,
        Err(e) => return ("400 Bad Request", format!(r#"{{"error":"{e}"}}"#)),
    };
    let mut runtimes = state.runtimes.lock().await;
    let Some(active) = runtimes.get_mut(match_id) else {
        return ("404 Not Found", r#"{"error":"match not running"}"#.into());
    };

    if let Some(default_str) = input.default {
        let policy = match default_str.as_str() {
            "check_fold" | "checkFold" => DefaultAction::CheckFold,
            "check_call_any" | "checkCallAny" => DefaultAction::CheckCallAny,
            _ => return ("400 Bad Request", r#"{"error":"unknown default"}"#.into()),
        };
        let seat_index = input.seat_index.unwrap_or(0) as usize;
        let signed = SignedDefaultPolicy {
            seat_index,
            wallet: input.wallet.clone(),
            policy,
            signature: input.signature.clone(),
        };
        let now = now_ms();
        if active
            .runtime
            .register_default_policy(
                &crate::service::InMemoryLeaseCoordinator::new(),
                now,
                signed,
            )
            .is_err()
        {
            return (
                "409 Conflict",
                r#"{"error":"default registration failed"}"#.into(),
            );
        }
        return ("200 OK", r#"{"ok":true}"#.into());
    }

    let action = match parse_action(input.action.as_ref()) {
        Ok(a) => a,
        Err(e) => return ("400 Bad Request", format!(r#"{{"error":"{e}"}}"#)),
    };
    let seat_index = input.seat_index.unwrap_or(0) as usize;
    let prev_head =
        parse_head_hex(input.prev_head_hex.as_deref()).unwrap_or_else(|| active.runtime.head());
    let intent = SignedActionIntent {
        seat_index,
        wallet: input.wallet,
        nonce: input.nonce.unwrap_or(1),
        prev_head,
        signature: input.signature,
        action,
    };

    let now = now_ms();
    let mut coord = state.coordinator.lock().await;
    if let Some(coordinator) = coord.as_mut() {
        match coordinator
            .apply_action(&mut active.runtime, now, intent)
            .await
        {
            Ok(_) => {
                active.action_deadline_ms =
                    now.saturating_add(active.runtime.config().action_timeout_ms);
                let payload = state_payload(state, match_id, &active.runtime);
                let to_act = active.runtime.engine().to_act;
                drop(coord);
                drop(runtimes);
                state.publisher.publish(match_id, &payload).await;
                if let Some(seat) = to_act {
                    state
                        .publisher
                        .publish(
                            match_id,
                            &serde_json::json!({
                                "type": "yourTurn",
                                "matchId": match_id,
                                "seatIndex": seat,
                            }),
                        )
                        .await;
                }
                return ("200 OK", r#"{"ok":true}"#.into());
            }
            Err(e) => return ("409 Conflict", format!(r#"{{"error":"{e}"}}"#)),
        }
    }

    match active.runtime.apply_signed_action(
        &crate::service::InMemoryLeaseCoordinator::new(),
        now,
        intent,
    ) {
        Ok(_) => {
            active.action_deadline_ms =
                now.saturating_add(active.runtime.config().action_timeout_ms);
            let payload = state_payload(state, match_id, &active.runtime);
            drop(runtimes);
            state.publisher.publish(match_id, &payload).await;
            ("200 OK", r#"{"ok":true}"#.into())
        }
        Err(e) => ("409 Conflict", format!(r#"{{"error":"{e:?}"}}"#)),
    }
}

async fn seal_match(
    state: &EngineServerState,
    match_id: &str,
    body: &str,
) -> (&'static str, String) {
    let input: SealBody = match serde_json::from_str(body) {
        Ok(v) => v,
        Err(e) => return ("400 Bad Request", format!(r#"{{"error":"{e}"}}"#)),
    };
    let ciphertext = base64::Engine::decode(
        &base64::engine::general_purpose::STANDARD,
        input.ciphertext.trim(),
    )
    .unwrap_or_default();
    let player_id = PlayerId(input.player_id.unwrap_or(0));
    let commitment_hex = input.commitment_hex.unwrap_or_else(|| "00".repeat(64));
    let blinding_hex = input.blinding_hex.unwrap_or_else(|| "00".repeat(64));
    let commitment = hex_to_32(&commitment_hex).unwrap_or([0u8; 32]);
    let blinding = hex_to_32(&blinding_hex).unwrap_or([0u8; 32]);
    let signed = SignedPredictionCommitment {
        player_id: player_id.0,
        wallet: input.wallet.unwrap_or_default(),
        seal_seq: 0,
        commitment,
        blinding,
        signature: input.signature.unwrap_or_else(|| "sig-dev".into()),
    };
    let mut runtimes = state.runtimes.lock().await;
    let Some(active) = runtimes.get_mut(match_id) else {
        return ("404 Not Found", r#"{"error":"match not running"}"#.into());
    };
    let mut coord = state.coordinator.lock().await;
    if let Some(coordinator) = coord.as_mut() {
        if coordinator
            .seal_prediction(
                &mut active.runtime,
                player_id,
                input.target_round.unwrap_or(1_000_000),
                ciphertext,
                signed,
            )
            .await
            .is_ok()
        {
            state
                .publisher
                .publish(
                    match_id,
                    &serde_json::json!({
                        "type": "matchState",
                        "state": { "matchId": match_id, "phase": "SEALING" }
                    }),
                )
                .await;
            return ("200 OK", r#"{"ok":true}"#.into());
        }
    }
    ("200 OK", r#"{"ok":true}"#.into())
}

async fn get_state(state: &EngineServerState, match_id: &str) -> (&'static str, String) {
    let runtimes = state.runtimes.lock().await;
    let Some(active) = runtimes.get(match_id) else {
        let resp = StateResponse {
            match_id: match_id.to_string(),
            phase: "UNKNOWN".into(),
            round: 0,
            pot: 0,
            to_act_seat: None,
            node_id: state.node_id.clone(),
        };
        return ("200 OK", serde_json::to_string(&resp).unwrap_or_default());
    };
    let engine = active.runtime.engine();
    let resp = StateResponse {
        match_id: match_id.to_string(),
        phase: format!("{:?}", engine.phase).to_uppercase(),
        round: engine.round,
        pot: engine_pot(engine),
        to_act_seat: engine.to_act,
        node_id: state.node_id.clone(),
    };
    ("200 OK", serde_json::to_string(&resp).unwrap_or_default())
}

fn build_config(input: &StartBody, players: &[PlayerSeat]) -> MatchConfig {
    MatchConfig {
        match_id: input.match_id.clone(),
        onchain_match_id: input.onchain_match_id.unwrap_or(1),
        players: players
            .iter()
            .map(|p| (PlayerId(p.seat_index), p.stack, p.seal_seq))
            .collect(),
        button: input.button.unwrap_or(0) as usize,
        small_blind: input.small_blind.unwrap_or(1),
        big_blind: input.big_blind.unwrap_or(2),
        round_count: input.round_count.unwrap_or(3),
        action_timeout_ms: input.action_timeout_ms.unwrap_or(25_000),
        lease_ttl_ms: 60_000,
    }
}

fn demo_config(input: &StartBody, players: &[PlayerSeat]) -> MatchConfig {
    if players.is_empty() {
        return MatchConfig {
            match_id: input.match_id.clone(),
            onchain_match_id: input.onchain_match_id.unwrap_or(1),
            players: vec![(PlayerId(0), 100, 0), (PlayerId(1), 100, 1)],
            button: 0,
            small_blind: 1,
            big_blind: 2,
            round_count: 3,
            action_timeout_ms: 25_000,
            lease_ttl_ms: 60_000,
        };
    }
    build_config(input, players)
}

fn state_payload(
    state: &EngineServerState,
    match_id: &str,
    runtime: &FencedMatchRuntime,
) -> serde_json::Value {
    let engine = runtime.engine();
    serde_json::json!({
        "type": "matchState",
        "state": {
            "matchId": match_id,
            "phase": format!("{:?}", engine.phase).to_uppercase(),
            "round": engine.round,
            "pot": engine_pot(engine),
            "toActSeat": engine.to_act,
            "nodeId": state.node_id,
        }
    })
}

fn engine_pot(engine: &syndicate_engine_core::Engine) -> u64 {
    engine.seats.iter().map(|s| s.total_contribution).sum()
}

fn parse_action(v: Option<&serde_json::Value>) -> Result<Action, &'static str> {
    let v = v.ok_or("action required")?;
    let t = v
        .get("type")
        .and_then(|x| x.as_str())
        .ok_or("action.type required")?;
    Ok(match t {
        "fold" => Action::Fold,
        "check" => Action::Check,
        "call" => Action::Call,
        "betTo" => Action::BetTo(v.get("amount").and_then(|a| a.as_u64()).unwrap_or(0)),
        "raiseTo" => Action::RaiseTo(v.get("amount").and_then(|a| a.as_u64()).unwrap_or(0)),
        "allIn" => Action::AllIn,
        _ => return Err("unknown action type"),
    })
}

fn parse_head_hex(hex: Option<&str>) -> Option<[u8; 32]> {
    let h = hex?;
    let bytes = hex::decode(h.trim_start_matches("0x")).ok()?;
    if bytes.len() != 32 {
        return None;
    }
    let mut out = [0u8; 32];
    out.copy_from_slice(&bytes);
    Some(out)
}

fn hex_to_32(s: &str) -> Option<[u8; 32]> {
    let bytes = hex::decode(s.trim_start_matches("0x")).ok()?;
    if bytes.len() != 32 {
        return None;
    }
    let mut out = [0u8; 32];
    out.copy_from_slice(&bytes);
    Some(out)
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn parse_request_line(request: &str) -> (&str, &str) {
    let line = request.lines().next().unwrap_or("");
    let mut parts = line.split_whitespace();
    let method = parts.next().unwrap_or("GET");
    let path = parts.next().unwrap_or("/");
    (method, path)
}
