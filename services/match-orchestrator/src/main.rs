//! Match lifecycle orchestrator HTTP service.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FormationBootstrap {
    match_id: String,
    tier_id: String,
    feed_id: String,
    token: String,
    max_players: u16,
    min_players: u16,
    mode: String,
    #[serde(default)]
    practice_mode: bool,
    #[serde(default)]
    buy_in: Option<u64>,
    #[serde(default)]
    entry_fee: Option<u64>,
    #[serde(default)]
    rake_bps: Option<u32>,
    #[serde(default)]
    rake_cap: Option<u64>,
    #[serde(default)]
    config_hash_hex: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct BootstrapResponse {
    match_id: String,
    onchain_match_id: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StartPolicyRequest {
    match_id: String,
    result: StartPolicyBody,
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
    let body = request
        .split("\r\n\r\n")
        .nth(1)
        .unwrap_or("")
        .trim();

    if path == "/healthz" {
        return ("200 OK", r#"{"ok":true}"#.into());
    }

    if path == "/internal/formations/bootstrap" {
        let input: FormationBootstrap = match serde_json::from_str(body) {
            Ok(v) => v,
            Err(e) => return ("400 Bad Request", format!(r#"{{"error":"{e}"}}"#)),
        };
        let onchain_match_id = hash_match_id(&input.match_id);
        if !input.practice_mode {
            let create_body = serde_json::json!({
                "matchId": input.match_id,
                "onchainMatchId": onchain_match_id,
                "maxPlayers": input.max_players,
                "minPlayers": input.min_players,
                "tierId": input.tier_id,
                "feedId": input.feed_id,
                "buyIn": input.buy_in,
                "entryFee": input.entry_fee,
                "rakeBps": input.rake_bps,
                "rakeCap": input.rake_cap,
                "configHashHex": input.config_hash_hex,
            });
            if let Err(resp) = require_downstream(
                cfg,
                post_json(&cfg.settlement_chain, "/internal/solana/create-match", &cfg.auth, create_body).await,
                "create-match",
            )
            .await
            {
                return resp;
            }
        }
        let resp = BootstrapResponse {
            match_id: input.match_id,
            onchain_match_id,
        };
        return ("200 OK", serde_json::to_string(&resp).unwrap_or_default());
    }

    if path == "/internal/start-policy" {
        let input: StartPolicyRequest = match serde_json::from_str(body) {
            Ok(v) => v,
            Err(e) => return ("400 Bad Request", format!(r#"{{"error":"{e}"}}"#)),
        };
        let onchain_match_id = hash_match_id(&input.match_id);
        if input.result.action == "start" {
            let lock_body = serde_json::json!({
                "matchId": input.match_id,
                "onchainMatchId": onchain_match_id,
            });
            if let Err(resp) = require_downstream(
                cfg,
                post_json(&cfg.settlement_chain, "/internal/solana/lock-match", &cfg.auth, lock_body).await,
                "lock-match",
            )
            .await
            {
                return resp;
            }
            let start_body = serde_json::json!({ "matchId": input.match_id });
            if let Err(resp) = require_downstream(
                cfg,
                post_json(&cfg.match_engine, "/internal/matches/start", &cfg.auth, start_body).await,
                "match-engine start",
            )
            .await
            {
                return resp;
            }
        } else if input.result.action == "void" {
            let void_body = serde_json::json!({
                "matchId": input.match_id,
                "match": { "onchainMatchId": onchain_match_id, "seatWallets": [] },
            });
            if let Err(resp) = require_downstream(
                cfg,
                post_json(&cfg.settlement_chain, "/internal/solana/void-match", &cfg.auth, void_body).await,
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
}
