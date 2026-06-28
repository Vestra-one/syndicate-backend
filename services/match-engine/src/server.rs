//! Tokio HTTP gameplay API for match-engine.

use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::sync::Mutex;

use crate::coordinator::MatchCoordinator;
use crate::persistence::PostgresMatchStore;
use crate::service::MatchConfig;
use syndicate_shared::PlayerId;

#[derive(Clone)]
pub struct EngineServerState {
    coordinator: Arc<Mutex<Option<MatchCoordinator>>>,
    node_id: String,
}

impl EngineServerState {
    pub async fn from_env() -> Result<Self, String> {
        let database_url = std::env::var("DATABASE_URL").map_err(|_| "DATABASE_URL required")?;
        let node_id = std::env::var("MATCH_ENGINE_NODE_ID").unwrap_or_else(|_| "engine-1".into());
        let store = PostgresMatchStore::from_url(&database_url, &node_id)
            .map_err(|e| e.to_string())?;
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
            node_id,
        })
    }

    pub fn demo() -> Self {
        Self {
            coordinator: Arc::new(Mutex::new(None)),
            node_id: "demo".into(),
        }
    }
}

#[derive(Debug, Deserialize)]
struct StartBody {
    match_id: String,
    onchain_match_id: Option<u64>,
    players: Option<Vec<PlayerSeat>>,
}

#[derive(Debug, Deserialize)]
struct PlayerSeat {
    seat_index: u16,
    stack: u64,
    seal_seq: u64,
}

#[derive(Debug, Deserialize)]
struct SealBody {
    player_id: u16,
    target_round: u64,
    ciphertext: String,
}

#[derive(Debug, Serialize)]
struct StateResponse {
    match_id: String,
    phase: String,
    node_id: String,
}

pub async fn run(state: EngineServerState, addr: &str) -> Result<(), String> {
    let listener = TcpListener::bind(addr)
        .await
        .map_err(|e| format!("bind {addr}: {e}"))?;
    println!("match-engine listening on http://{addr}");
    loop {
        let (mut stream, _) = listener.accept().await.map_err(|e| e.to_string())?;
        let state = state.clone();
        tokio::spawn(async move {
            let mut buf = vec![0u8; 16384];
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

async fn handle(state: &EngineServerState, request: &str) -> (&'static str, String) {
    let (method, path) = parse_request_line(request);
    let body = request.split("\r\n\r\n").nth(1).unwrap_or("").trim();

    if method == "GET" && path == "/healthz" {
        return ("200 OK", r#"{"ok":true}"#.into());
    }
    if method == "GET" && path == "/metrics" {
        return (
            "200 OK",
            "syndicate_match_engine_up 1\n".into(),
        );
    }

    if method == "POST" && path == "/internal/matches/start" {
        return start_match(state, body).await;
    }

    if method == "POST" && path.starts_with("/internal/matches/") && path.ends_with("/seal") {
        let match_id = path.trim_start_matches("/internal/matches/").trim_end_matches("/seal");
        return seal_match(state, match_id, body).await;
    }

    if method == "GET" && path.starts_with("/internal/matches/") && path.ends_with("/state") {
        let match_id = path
            .trim_start_matches("/internal/matches/")
            .trim_end_matches("/state");
        let resp = StateResponse {
            match_id: match_id.to_string(),
            phase: "SEALING".into(),
            node_id: state.node_id.clone(),
        };
        return ("200 OK", serde_json::to_string(&resp).unwrap_or_default());
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
        return (
            "200 OK",
            serde_json::json!({ "ok": true, "demo": true, "matchId": input.match_id }).to_string(),
        );
    };
    let players = input.players.unwrap_or_else(|| {
        vec![
            PlayerSeat { seat_index: 0, stack: 100, seal_seq: 0 },
            PlayerSeat { seat_index: 1, stack: 100, seal_seq: 1 },
        ]
    });
    let config = MatchConfig {
        match_id: input.match_id.clone(),
        onchain_match_id: input.onchain_match_id.unwrap_or(1),
        players: players
            .into_iter()
            .map(|p| (PlayerId(p.seat_index), p.stack, p.seal_seq))
            .collect(),
        button: 0,
        small_blind: 1,
        big_blind: 2,
        round_count: 3,
        action_timeout_ms: 25_000,
        lease_ttl_ms: 60_000,
    };
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    match coordinator
        .start_match(config, &state.node_id, now_ms)
        .await
    {
        Ok(_) => ("200 OK", serde_json::json!({ "ok": true, "matchId": input.match_id }).to_string()),
        Err(e) => ("409 Conflict", format!(r#"{{"error":"{e}"}}"#)),
    }
}

async fn seal_match(_state: &EngineServerState, _match_id: &str, body: &str) -> (&'static str, String) {
    let _input: SealBody = match serde_json::from_str(body) {
        Ok(v) => v,
        Err(e) => return ("400 Bad Request", format!(r#"{{"error":"{e}"}}"#)),
    };
    ("200 OK", r#"{"ok":true}"#.into())
}

fn parse_request_line(request: &str) -> (&str, &str) {
    let line = request.lines().next().unwrap_or("");
    let mut parts = line.split_whitespace();
    let method = parts.next().unwrap_or("GET");
    let path = parts.next().unwrap_or("/");
    (method, path)
}
