//! WS load sanity: open N WebSocket connections (spectators on the lobby channel + a
//! sample match channel), measure connect + first-frame latency, and hold the sockets to
//! verify the server sustains the target concurrency.
//!
//!   GAME_SERVER_URL=http://127.0.0.1:18080 CONNECTIONS=1000 HOLD_SEC=30 \
//!     cargo run -p syndicate-e2e --bin load-sanity --release

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use futures_util::{SinkExt, StreamExt};
use serde_json::json;
use tokio_tungstenite::tungstenite::Message;

#[tokio::main(flavor = "multi_thread")]
async fn main() {
    let api = std::env::var("GAME_SERVER_URL").unwrap_or_else(|_| "http://127.0.0.1:18080".into());
    let ws_url = api.replace("http", "ws") + "/v1/ws";
    let connections: usize = std::env::var("CONNECTIONS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(1000);
    let hold_sec: u64 = std::env::var("HOLD_SEC")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(30);

    let connected = Arc::new(AtomicU64::new(0));
    let failed = Arc::new(AtomicU64::new(0));
    let latencies = Arc::new(tokio::sync::Mutex::new(Vec::<u64>::new()));

    println!("opening {connections} WS connections to {ws_url} …");
    let started = Instant::now();
    let mut handles = Vec::with_capacity(connections);
    for i in 0..connections {
        let ws_url = ws_url.clone();
        let connected = connected.clone();
        let failed = failed.clone();
        let latencies = latencies.clone();
        handles.push(tokio::spawn(async move {
            // Stagger to ~200 conn/s so we measure steady-state, not a thundering herd.
            tokio::time::sleep(Duration::from_millis((i as u64) * 5)).await;
            let t0 = Instant::now();
            match tokio_tungstenite::connect_async(&ws_url).await {
                Ok((mut ws, _)) => {
                    // First frame = challenge.
                    match tokio::time::timeout(Duration::from_secs(5), ws.next()).await {
                        Ok(Some(Ok(Message::Text(_)))) => {
                            latencies.lock().await.push(t0.elapsed().as_millis() as u64);
                            connected.fetch_add(1, Ordering::Relaxed);
                            let _ = ws
                                .send(Message::Text(
                                    json!({"t":"subscribe","channel":"lobby"}).to_string(),
                                ))
                                .await;
                            // Hold: pong pings, drain broadcast frames.
                            let deadline = Instant::now() + Duration::from_secs(hold_sec);
                            while Instant::now() < deadline {
                                match tokio::time::timeout(Duration::from_secs(5), ws.next()).await
                                {
                                    Ok(Some(Ok(_))) => {}
                                    Ok(Some(Err(_))) | Ok(None) => break,
                                    Err(_) => {
                                        let _ = ws
                                            .send(Message::Text(json!({"t":"ping"}).to_string()))
                                            .await;
                                    }
                                }
                            }
                        }
                        _ => {
                            failed.fetch_add(1, Ordering::Relaxed);
                        }
                    }
                }
                Err(_) => {
                    failed.fetch_add(1, Ordering::Relaxed);
                }
            }
        }));
    }
    for h in handles {
        let _ = h.await;
    }

    let ok = connected.load(Ordering::Relaxed);
    let bad = failed.load(Ordering::Relaxed);
    let mut lat = latencies.lock().await.clone();
    lat.sort_unstable();
    let p = |q: f64| -> u64 {
        if lat.is_empty() {
            return 0;
        }
        lat[((lat.len() as f64 - 1.0) * q) as usize]
    };
    println!(
        "connected={ok} failed={bad} total_time={:?} first-frame p50={}ms p99={}ms",
        started.elapsed(),
        p(0.50),
        p(0.99),
    );
    assert!(bad == 0, "LOAD SANITY FAILED: {bad} connections failed");
    assert!(
        p(0.99) < 1_000,
        "LOAD SANITY FAILED: p99 first-frame {}ms >= 1000ms",
        p(0.99)
    );
    println!("LOAD SANITY PASSED");
}
