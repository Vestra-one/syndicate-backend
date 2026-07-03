//! In-process signed-price cache. HTTP-polls the signed-price-server `GET /prices`
//! roughly every second — the simplest correct path for per-action display stamps.
//! (The server also exposes a `/ws` stream; switching this poller to that WS
//! subscription is a drop-in latency upgrade, the read side is unchanged.)

use std::collections::HashMap;
use std::sync::RwLock;
use std::time::{Duration, Instant};

use serde_json::Value;

/// One signed feed tick, as served by the Go signed-price-server.
#[derive(Clone, Debug)]
pub struct PriceTick {
    /// e.g. "BTCUSD".
    pub symbol: String,
    /// Decimal string (display precision).
    pub price: String,
    /// WAD-scaled integer string (18 decimals) — expo −18.
    pub price_in_wad: String,
    /// Unix ms of the signed payload.
    pub timestamp_ms: u64,
    /// Full signed payload (token, v/r/s, …) for audit storage.
    pub raw: Value,
    /// Local receive time, for staleness checks.
    pub received: Instant,
}

pub const PRICE_EXPO: i32 = -18;
const STALE_AFTER: Duration = Duration::from_secs(10);

pub struct PriceCache {
    base_url: String,
    client: reqwest::Client,
    latest: RwLock<HashMap<String, PriceTick>>,
}

impl PriceCache {
    pub fn new(base_url: impl Into<String>) -> Self {
        Self {
            base_url: base_url.into(),
            client: reqwest::Client::builder()
                .timeout(Duration::from_secs(5))
                .build()
                .expect("reqwest client"),
            latest: RwLock::new(HashMap::new()),
        }
    }

    /// Latest non-stale tick for a feed symbol ("BTCUSD").
    pub fn latest(&self, symbol: &str) -> Option<PriceTick> {
        let map = self.latest.read().ok()?;
        let tick = map.get(symbol)?;
        if tick.received.elapsed() > STALE_AFTER {
            return None;
        }
        Some(tick.clone())
    }

    pub fn is_fresh(&self) -> bool {
        self.latest
            .read()
            .map(|m| m.values().any(|t| t.received.elapsed() <= STALE_AFTER))
            .unwrap_or(false)
    }

    /// Background poll loop (spawn once).
    pub async fn run(self: std::sync::Arc<Self>) {
        loop {
            if let Err(e) = self.poll_once().await {
                tracing::debug!(error = %e, "price poll failed");
            }
            tokio::time::sleep(Duration::from_millis(1000)).await;
        }
    }

    async fn poll_once(&self) -> Result<(), String> {
        let url = format!("{}/prices", self.base_url);
        let body: Value = self
            .client
            .get(&url)
            .send()
            .await
            .map_err(|e| e.to_string())?
            .json()
            .await
            .map_err(|e| e.to_string())?;
        let Some(prices) = body.get("prices").and_then(|p| p.as_array()) else {
            return Err("missing prices array".into());
        };
        let mut map = self
            .latest
            .write()
            .map_err(|_| "lock poisoned".to_string())?;
        for p in prices {
            if let Some(tick) = parse_tick(p) {
                map.insert(tick.symbol.clone(), tick);
            }
        }
        Ok(())
    }

    /// Exact-second signed price (seal-close snapshots): `GET /prices/at`.
    /// Returns the full signed payload.
    pub async fn price_at(&self, symbol: &str, timestamp_sec: u64) -> Result<PriceTick, String> {
        let url = format!(
            "{}/prices/at?symbol={}&timestamp={}",
            self.base_url, symbol, timestamp_sec
        );
        let resp = self
            .client
            .get(&url)
            .send()
            .await
            .map_err(|e| e.to_string())?;
        if !resp.status().is_success() {
            return Err(format!(
                "price_at {symbol}@{timestamp_sec}: {}",
                resp.status()
            ));
        }
        let body: Value = resp.json().await.map_err(|e| e.to_string())?;
        let price = body.get("price").ok_or("missing price object")?;
        parse_tick(price).ok_or_else(|| "malformed price payload".to_string())
    }
}

fn parse_tick(p: &Value) -> Option<PriceTick> {
    let symbol = p.get("symbol")?.as_str()?.to_string();
    let price = p.get("price")?.as_str()?.to_string();
    let price_in_wad = p
        .get("price_in_wad")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string();
    let timestamp_ms = p.get("timestamp")?.as_i64()?.max(0) as u64;
    Some(PriceTick {
        symbol,
        price,
        price_in_wad,
        timestamp_ms,
        raw: p.clone(),
        received: Instant::now(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parses_signed_price_payload() {
        let p = json!({
            "token": "0xa7BaE7da3E4950700BE9f107EB186e89a474d180",
            "symbol": "BTCUSD",
            "price": "97000.5",
            "price_in_wad": "97000500000000000000000",
            "quantity": "1",
            "timestamp": 1_715_000_000_123i64,
            "trade_id": 1,
            "exchange": "test",
            "v": 27, "r": "0x00", "s": "0x00"
        });
        let tick = parse_tick(&p).unwrap();
        assert_eq!(tick.symbol, "BTCUSD");
        assert_eq!(tick.price, "97000.5");
        assert_eq!(tick.timestamp_ms, 1_715_000_000_123);
        assert_eq!(tick.price_in_wad, "97000500000000000000000");
    }
}
