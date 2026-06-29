//! Match lifecycle orchestrator HTTP service.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use serde::Deserialize;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StartSeat {
    seat_index: u16,
    stack: u64,
    seal_seq: u64,
    wallet: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StartPolicyRequest {
    match_id: String,
    result: StartPolicyBody,
    #[serde(default)]
    onchain_match_id: Option<String>,
    #[serde(default)]
    players: Vec<StartSeat>,
    #[serde(default)]
    button: Option<u8>,
    #[serde(default)]
    small_blind: Option<u64>,
    #[serde(default)]
    big_blind: Option<u64>,
    #[serde(default)]
    round_count: Option<u8>,
    #[serde(default)]
    action_timeout_ms: Option<u64>,
    /// Per-street betting durations from the bound template (matchmaking sources these from config).
    #[serde(default)]
    round_durations_sec: Option<Vec<u64>>,
    /// Per-street observation windows from the bound template.
    #[serde(default)]
    observation_windows_sec: Option<Vec<u64>>,
    #[serde(default)]
    time_bank_sec: Option<u64>,
}

#[derive(Debug, Deserialize)]
struct StartPolicyBody {
    action: String,
    reason: Option<String>,
    trigger: Option<String>,
}

struct Metrics {
    requests: AtomicU64,
}

struct AppConfig {
    settlement_chain: String,
    match_engine: String,
    auth: String,
    stub_mode: bool,
}

#[tokio::main]
async fn main() {
    let host = std::env::var("ORCHESTRATOR_HOST").unwrap_or_else(|_| "127.0.0.1".into());
    let port = std::env::var("ORCHESTRATOR_PORT").unwrap_or_else(|_| "8086".into());
    let addr = format!("{host}:{port}");
    let cfg = Arc::new(AppConfig {
        settlement_chain: std::env::var("SETTLEMENT_CHAIN_URL")
            .unwrap_or_else(|_| "http://127.0.0.1:8790".into()),
        match_engine: std::env::var("MATCH_ENGINE_URL")
            .unwrap_or_else(|_| "http://127.0.0.1:8083".into()),
        auth: std::env::var("ORCHESTRATOR_AUTH_TOKEN").unwrap_or_default(),
        stub_mode: env_flag("SYNDICATE_ORCHESTRATOR_STUB"),
    });

    let listener = TcpListener::bind(&addr)
        .await
        .unwrap_or_else(|e| panic!("bind orchestrator {addr}: {e}"));
    let metrics = Arc::new(Metrics {
        requests: AtomicU64::new(0),
    });
    println!(
        "orchestrator listening on http://{addr} (stub_mode={})",
        cfg.stub_mode
    );

    loop {
        let (mut stream, _) = listener.accept().await.expect("accept");
        let cfg = Arc::clone(&cfg);
        let metrics = Arc::clone(&metrics);
        tokio::spawn(async move {
            metrics.requests.fetch_add(1, Ordering::Relaxed);
            let mut buf = vec![0u8; 8192];
            let n = stream.read(&mut buf).await.unwrap_or(0);
            if n == 0 {
                return;
            }
            let request = String::from_utf8_lossy(&buf[..n]);
            let (status, body) = handle_request(&request, &cfg).await;
            let response = format!(
                "HTTP/1.1 {status}\r\ncontent-type: application/json\r\ncontent-length: {}\r\ncache-control: no-store\r\n\r\n{body}",
                body.len()
            );
            let _ = stream.write_all(response.as_bytes()).await;
        });
    }
}

async fn handle_request(request: &str, cfg: &AppConfig) -> (&'static str, String) {
    let path = request
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .unwrap_or("/");
    let body = request.split("\r\n\r\n").nth(1).unwrap_or("").trim();

    if path == "/healthz" {
        return ("200 OK", r#"{"ok":true}"#.into());
    }

    if path == "/internal/start-policy" {
        let input: StartPolicyRequest = match serde_json::from_str(body) {
            Ok(v) => v,
            Err(e) => return ("400 Bad Request", format!(r#"{{"error":"{e}"}}"#)),
        };
        let onchain_match_id = input
            .onchain_match_id
            .as_deref()
            .and_then(|s| s.parse::<u64>().ok())
            .unwrap_or_else(|| hash_match_id(&input.match_id));
        if input.result.action == "start" {
            let lock_body = serde_json::json!({
                "matchId": input.match_id,
                "onchainMatchId": onchain_match_id.to_string(),
            });
            if let Err(resp) = require_downstream(
                cfg,
                post_json(
                    &cfg.settlement_chain,
                    "/internal/solana/lock-match",
                    &cfg.auth,
                    lock_body,
                )
                .await,
                "lock-match",
            )
            .await
            {
                return resp;
            }
            // begin_live: settlement-chain generates the backend-native button_randomness, enumerates
            // the authoritative seat set from chain (getProgramAccounts), derives the button on-chain,
            // and returns it plus the stamped live_start_ts / scheduled_end_ts. No set_button_seed step.
            let live_body = serde_json::json!({
                "matchId": input.match_id,
                "onchainMatchId": onchain_match_id.to_string(),
            });
            let live_resp = match post_json(
                &cfg.settlement_chain,
                "/internal/solana/begin-live",
                &cfg.auth,
                live_body,
            )
            .await
            {
                Ok(resp) if (200..300).contains(&resp.status) => resp,
                Ok(resp) if cfg.stub_mode => {
                    eprintln!("orchestrator stub: begin-live returned HTTP {}", resp.status);
                    PostResult {
                        status: 200,
                        body: String::new(),
                    }
                }
                Ok(resp) => {
                    return (
                        "502 Bad Gateway",
                        format!(
                            r#"{{"error":"begin-live failed with HTTP {}","detail":{}}}"#,
                            resp.status,
                            serde_json::to_string(&resp.body).unwrap_or_else(|_| "\"\"".into())
                        ),
                    );
                }
                Err(err) if cfg.stub_mode => {
                    eprintln!("orchestrator stub: begin-live transport error: {err}");
                    PostResult {
                        status: 200,
                        body: String::new(),
                    }
                }
                Err(err) => {
                    return (
                        "503 Service Unavailable",
                        format!(r#"{{"error":"begin-live unavailable","detail":"{err}"}}"#),
                    );
                }
            };
            let (button, live_start_ts, scheduled_end_ts) =
                parse_begin_live_response(&live_resp.body, input.button);

            // engine start — forward the on-chain button + template wall-clock timing so every client
            // renders identical street deadlines anchored on live_start_ts.
            let mut start_body = serde_json::json!({
                "matchId": input.match_id,
                "onchainMatchId": onchain_match_id,
                "button": button,
                "smallBlind": input.small_blind.unwrap_or(1),
                "bigBlind": input.big_blind.unwrap_or(2),
                "roundCount": input.round_count.unwrap_or(3),
                "actionTimeoutMs": input.action_timeout_ms.unwrap_or(25_000),
                "players": input.players.iter().map(|p| serde_json::json!({
                    "seatIndex": p.seat_index,
                    "stack": p.stack,
                    "sealSeq": p.seal_seq,
                    "wallet": p.wallet,
                })).collect::<Vec<_>>(),
            });
            if let Some(r) = &input.round_durations_sec {
                start_body["roundDurationsSec"] = serde_json::json!(r);
            }
            if let Some(o) = &input.observation_windows_sec {
                start_body["observationWindowsSec"] = serde_json::json!(o);
            }
            if let Some(t) = input.time_bank_sec {
                start_body["timeBankSec"] = serde_json::json!(t);
            }
            if let Some(ls) = live_start_ts {
                start_body["liveStartTs"] = serde_json::json!(ls);
            }
            if let Err(resp) = require_downstream(
                cfg,
                post_json(
                    &cfg.match_engine,
                    "/internal/matches/start",
                    &cfg.auth,
                    start_body,
                )
                .await,
                "match-engine start",
            )
            .await
            {
                return resp;
            }
            return (
                "200 OK",
                serde_json::json!({
                    "ok": true,
                    "button": button,
                    "liveStartTs": live_start_ts,
                    "scheduledEndTs": scheduled_end_ts,
                })
                .to_string(),
            );
        } else if input.result.action == "void" {
            let void_body = serde_json::json!({
                "matchId": input.match_id,
                "match": { "onchainMatchId": onchain_match_id, "seatWallets": [] },
            });
            if let Err(resp) = require_downstream(
                cfg,
                post_json(
                    &cfg.settlement_chain,
                    "/internal/solana/void-match",
                    &cfg.auth,
                    void_body,
                )
                .await,
                "void-match",
            )
            .await
            {
                return resp;
            }
        }
        return ("200 OK", r#"{"ok":true}"#.into());
    }

    ("404 Not Found", r#"{"error":"not found"}"#.into())
}

/// Deterministic u64 seed shared with settlement-chain `hashMatchId`.
pub fn hash_match_id(match_id: &str) -> u64 {
    let mut hash: u64 = 0;
    for b in match_id.bytes() {
        hash = hash.wrapping_mul(31).wrapping_add(u64::from(b));
    }
    hash
}

/// Parse the begin-live response into `(button, live_start_ts, scheduled_end_ts)`. The button is
/// the on-chain-derived dealer seat; timing fields arrive as numeric strings (or null in stub mode).
fn parse_begin_live_response(body: &str, fallback: Option<u8>) -> (u8, Option<u64>, Option<u64>) {
    if !body.is_empty() {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(body) {
            let button = v.get("button").and_then(|x| x.as_u64()).map(|b| b as u8);
            let live = v.get("liveStartTs").and_then(json_u64);
            let end = v.get("scheduledEndTs").and_then(json_u64);
            return (button.or(fallback).unwrap_or(0), live, end);
        }
    }
    (fallback.unwrap_or(0), None, None)
}

/// Accept a u64 from either a JSON number or a numeric string (settlement-chain stringifies u64s).
fn json_u64(v: &serde_json::Value) -> Option<u64> {
    v.as_u64().or_else(|| v.as_str().and_then(|s| s.parse().ok()))
}

struct PostResult {
    status: u16,
    body: String,
}

async fn post_json(
    base: &str,
    path: &str,
    auth: &str,
    body: serde_json::Value,
) -> Result<PostResult, reqwest::Error> {
    let client = reqwest::Client::new();
    let mut req = client.post(format!("{base}{path}")).json(&body);
    if !auth.is_empty() {
        req = req.bearer_auth(auth);
    }
    let res = req.send().await?;
    let status = res.status().as_u16();
    let body = res.text().await.unwrap_or_default();
    Ok(PostResult { status, body })
}

async fn require_downstream(
    cfg: &AppConfig,
    result: Result<PostResult, reqwest::Error>,
    step: &str,
) -> Result<(), (&'static str, String)> {
    match result {
        Ok(resp) if (200..300).contains(&resp.status) => Ok(()),
        Ok(resp) if cfg.stub_mode => {
            eprintln!("orchestrator stub: {step} returned HTTP {}", resp.status);
            Ok(())
        }
        Ok(resp) => Err((
            "502 Bad Gateway",
            format!(
                r#"{{"error":"{step} failed with HTTP {}","detail":{}}}"#,
                resp.status,
                serde_json::to_string(&resp.body).unwrap_or_else(|_| "\"\"".into())
            ),
        )),
        Err(err) if cfg.stub_mode => {
            eprintln!("orchestrator stub: {step} transport error: {err}");
            Ok(())
        }
        Err(err) => Err((
            "503 Service Unavailable",
            format!(r#"{{"error":"{step} unavailable","detail":"{err}"}}"#),
        )),
    }
}

fn env_flag(name: &str) -> bool {
    std::env::var(name)
        .map(|v| matches!(v.as_str(), "1" | "true" | "yes" | "on"))
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn onchain_id_deterministic() {
        assert_eq!(hash_match_id("abc"), hash_match_id("abc"));
        assert_ne!(hash_match_id("abc"), hash_match_id("def"));
    }

    #[test]
    fn parse_begin_live_response_extracts_button_and_timing() {
        let body = r#"{"ok":true,"button":2,"liveStartTs":"1782744656","scheduledEndTs":"1782745256"}"#;
        let (button, live, end) = parse_begin_live_response(body, None);
        assert_eq!(button, 2);
        assert_eq!(live, Some(1_782_744_656));
        assert_eq!(end, Some(1_782_745_256));
        // empty body (stub mode) falls back to the provided button, no timing.
        assert_eq!(parse_begin_live_response("", Some(1)), (1, None, None));
    }
}
