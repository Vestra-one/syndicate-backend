//! HTTP handlers for match-registry persistence (Phase 05/06).

use std::io::{Read, Write};
use std::net::TcpStream;
use std::sync::Arc;

use chrono::{TimeZone, Utc};
use serde::Deserialize;
use syndicate_store::{
    unix_to_datetime, BeginLiveParams, InsertMatchParams, MatchRegistryStore, RegistryError,
};

use crate::metrics::WorkerMetrics;

#[derive(Clone)]
pub struct RegistryHttpState {
    pub store: MatchRegistryStore,
    pub auth_token: String,
    pub metrics: WorkerMetrics,
}

pub fn spawn_registry_server(host: &str, port: u16, state: RegistryHttpState) {
    let addr = format!("{host}:{port}");
    let state = Arc::new(state);
    std::thread::spawn(move || {
        let rt = tokio::runtime::Runtime::new().expect("registry http runtime");
        let listener = std::net::TcpListener::bind(&addr)
            .unwrap_or_else(|e| panic!("bind registry http {addr}: {e}"));
        println!("settlement-worker http listening on http://{addr}");
        for stream in listener.incoming() {
            if let Ok(stream) = stream {
                let state = Arc::clone(&state);
                rt.block_on(async move {
                    handle_connection(stream, state).await;
                });
            }
        }
    });
}

async fn handle_connection(mut stream: TcpStream, state: Arc<RegistryHttpState>) {
    let mut buf = vec![0u8; 65_536];
    let Ok(n) = stream.read(&mut buf) else {
        return;
    };
    let request = String::from_utf8_lossy(&buf[..n]);
    let (status, content_type, body) = route_request(&request, &state).await;
    let response = format!(
        "HTTP/1.1 {status}\r\ncontent-type: {content_type}\r\ncontent-length: {}\r\ncache-control: no-store\r\n\r\n{body}",
        body.len()
    );
    let _ = stream.write_all(response.as_bytes());
}

async fn route_request(request: &str, state: &RegistryHttpState) -> (&'static str, &'static str, String) {
    let method = request
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().next())
        .unwrap_or("GET");
    let path = request
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .unwrap_or("/");
    let body = request.split("\r\n\r\n").nth(1).unwrap_or("").trim();

    if path == "/healthz" && method == "GET" {
        return ("200 OK", "application/json", r#"{"ok":true}"#.into());
    }
    if path == "/metrics" && method == "GET" {
        return (
            "200 OK",
            "text/plain; version=0.0.4",
            state.metrics.render_prometheus(),
        );
    }

    if !authorized(request, &state.auth_token) {
        return ("401 Unauthorized", "application/json", r#"{"error":"unauthorized"}"#.into());
    }

    match (method, path) {
        ("POST", "/internal/matches") => insert_match_handler(state, body).await,
        ("POST", "/internal/matches/seats") => insert_seat_handler(state, body).await,
        ("POST", "/internal/matches/live") => begin_live_handler(state, body).await,
        _ => ("404 Not Found", "application/json", r#"{"error":"not found"}"#.into()),
    }
}

fn authorized(request: &str, expected: &str) -> bool {
    if expected.is_empty() {
        return true;
    }
    request.lines().any(|line| {
        let lower = line.to_ascii_lowercase();
        lower.starts_with("authorization: bearer ") && line[21..].trim() == expected
    })
}

#[derive(Debug, Deserialize)]
struct InsertMatchBody {
    #[serde(rename = "matchKey")]
    match_key: String,
    #[serde(rename = "onchainMatchId")]
    onchain_match_id: String,
    #[serde(rename = "configHash")]
    config_hash: String,
    #[serde(rename = "fillDeadlineMs")]
    fill_deadline_ms: i64,
    #[serde(rename = "priceFeedSymbol")]
    price_feed_symbol: String,
    #[serde(rename = "oracleTokenHex")]
    oracle_token_hex: String,
    #[serde(rename = "oracleExponent", default = "default_oracle_exponent")]
    oracle_exponent: i32,
    #[serde(rename = "maxOracleConfidence", default = "default_max_oracle_confidence")]
    max_oracle_confidence: String,
    #[serde(rename = "buyInChips")]
    buy_in_chips: i64,
    #[serde(rename = "entryFeeChips", default)]
    entry_fee_chips: i64,
    #[serde(rename = "rakeBps")]
    rake_bps: i32,
    #[serde(rename = "rakeCapChips")]
    rake_cap_chips: i64,
    #[serde(rename = "maxPlayers")]
    max_players: i16,
}

fn default_oracle_exponent() -> i32 {
    -18
}

fn default_max_oracle_confidence() -> String {
    "18446744073709551615".into()
}

async fn insert_match_handler(
    state: &RegistryHttpState,
    body: &str,
) -> (&'static str, &'static str, String) {
    let input: InsertMatchBody = match serde_json::from_str(body) {
        Ok(v) => v,
        Err(e) => return ("400 Bad Request", "application/json", format!(r#"{{"error":"{e}"}}"#)),
    };
    let onchain = match input.onchain_match_id.parse::<i64>() {
        Ok(v) => v,
        Err(e) => {
            return (
                "400 Bad Request",
                "application/json",
                format!(r#"{{"error":"invalid onchainMatchId: {e}"}}"#),
            );
        }
    };
    let max_conf = match input.max_oracle_confidence.parse::<i64>() {
        Ok(v) => v,
        Err(e) => {
            return (
                "400 Bad Request",
                "application/json",
                format!(r#"{{"error":"invalid maxOracleConfidence: {e}"}}"#),
            );
        }
    };
    let fill_deadline = Utc
        .timestamp_millis_opt(input.fill_deadline_ms)
        .single()
        .unwrap_or_else(Utc::now);
    let params = InsertMatchParams {
        match_key: input.match_key,
        onchain_match_id: onchain,
        config_hash_hex: input.config_hash,
        fill_deadline,
        price_feed_symbol: input.price_feed_symbol,
        oracle_token_hex: input.oracle_token_hex,
        oracle_exponent: input.oracle_exponent,
        max_oracle_confidence: max_conf,
        buy_in_chips: input.buy_in_chips,
        entry_fee_chips: input.entry_fee_chips,
        rake_bps: input.rake_bps,
        rake_cap_chips: input.rake_cap_chips,
        max_players: input.max_players,
    };
    match state.store.insert_match(params).await {
        Ok(row) => (
            "200 OK",
            "application/json",
            serde_json::json!({
                "ok": true,
                "matchId": row.match_id,
                "matchKey": row.match_key,
                "roomStatus": row.room_status,
            })
            .to_string(),
        ),
        Err(e) => map_registry_error(e),
    }
}

#[derive(Debug, Deserialize)]
struct InsertSeatBody {
    #[serde(rename = "matchKey")]
    match_key: String,
    #[serde(rename = "seatIndex")]
    seat_index: i16,
    wallet: String,
    #[serde(rename = "depositSignature")]
    deposit_signature: String,
    #[serde(rename = "buyInChips")]
    buy_in_chips: i64,
    #[serde(rename = "entryFeeChips", default)]
    entry_fee_chips: i64,
}

async fn insert_seat_handler(
    state: &RegistryHttpState,
    body: &str,
) -> (&'static str, &'static str, String) {
    let input: InsertSeatBody = match serde_json::from_str(body) {
        Ok(v) => v,
        Err(e) => return ("400 Bad Request", "application/json", format!(r#"{{"error":"{e}"}}"#)),
    };
    match state
        .store
        .insert_match_seat(
            &input.match_key,
            input.seat_index,
            &input.wallet,
            &input.deposit_signature,
            input.buy_in_chips,
            input.entry_fee_chips,
        )
        .await
    {
        Ok(row) => (
            "200 OK",
            "application/json",
            serde_json::json!({
                "ok": true,
                "matchId": row.match_id,
                "seatIndex": row.seat_index,
            })
            .to_string(),
        ),
        Err(e) => map_registry_error(e),
    }
}

#[derive(Debug, Deserialize)]
struct BeginLiveBody {
    #[serde(rename = "matchId")]
    match_id: String,
    #[serde(rename = "liveStartTs")]
    live_start_ts: u64,
    #[serde(rename = "scheduledEndTs")]
    scheduled_end_ts: u64,
    #[serde(rename = "lockTs")]
    lock_ts: u64,
    #[serde(rename = "sealDeadlineTs")]
    seal_deadline_ts: u64,
    #[serde(rename = "sealedCount")]
    sealed_count: i16,
    #[serde(rename = "nonsealPenaltyBps", default)]
    nonseal_penalty_bps: i32,
}

async fn begin_live_handler(
    state: &RegistryHttpState,
    body: &str,
) -> (&'static str, &'static str, String) {
    let input: BeginLiveBody = match serde_json::from_str(body) {
        Ok(v) => v,
        Err(e) => return ("400 Bad Request", "application/json", format!(r#"{{"error":"{e}"}}"#)),
    };
    let live_start = match unix_to_datetime(input.live_start_ts) {
        Ok(v) => v,
        Err(e) => return map_registry_error(e),
    };
    let scheduled_end = match unix_to_datetime(input.scheduled_end_ts) {
        Ok(v) => v,
        Err(e) => return map_registry_error(e),
    };
    let lock_ts = match unix_to_datetime(input.lock_ts) {
        Ok(v) => v,
        Err(e) => return map_registry_error(e),
    };
    let seal_deadline = match unix_to_datetime(input.seal_deadline_ts) {
        Ok(v) => v,
        Err(e) => return map_registry_error(e),
    };
    let params = BeginLiveParams {
        match_id: input.match_id,
        live_start,
        scheduled_end,
        lock_ts,
        seal_deadline,
        sealed_count: input.sealed_count,
        nonseal_penalty_bps: input.nonseal_penalty_bps,
    };
    match state.store.update_match_on_begin_live(params).await {
        Ok(id) => (
            "200 OK",
            "application/json",
            serde_json::json!({ "ok": true, "matchId": id }).to_string(),
        ),
        Err(e) => map_registry_error(e),
    }
}

fn map_registry_error(err: RegistryError) -> (&'static str, &'static str, String) {
    match err {
        RegistryError::NotFound(msg) => ("404 Not Found", "application/json", format!(r#"{{"error":"{msg}"}}"#)),
        RegistryError::Invalid(msg) => ("400 Bad Request", "application/json", format!(r#"{{"error":"{msg}"}}"#)),
        other => (
            "500 Internal Server Error",
            "application/json",
            format!(r#"{{"error":"{other}"}}"#),
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn authorized_accepts_bearer_token() {
        let req = "POST /internal/matches HTTP/1.1\r\nAuthorization: Bearer secret-token\r\n\r\n{}";
        assert!(authorized(req, "secret-token"));
        assert!(!authorized(req, "wrong"));
    }

    #[test]
    fn insert_match_body_deserializes_camel_case() {
        let valid = r#"{
            "matchKey":"1",
            "onchainMatchId":"42",
            "configHash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "fillDeadlineMs":1000,
            "priceFeedSymbol":"BTC/USD",
            "oracleTokenHex":"0xa7BaE7da3E4950700BE9f107EB186e89a474d180",
            "buyInChips":1000000,
            "rakeBps":300,
            "rakeCapChips":1000000,
            "maxPlayers":5
        }"#;
        let parsed: InsertMatchBody = serde_json::from_str(valid).expect("parse");
        assert_eq!(parsed.match_key, "1");
        assert_eq!(parsed.onchain_match_id, "42");
        assert_eq!(parsed.oracle_exponent, -18);
    }
}
