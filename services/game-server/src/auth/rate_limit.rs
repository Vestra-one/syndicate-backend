//! In-process token buckets (single-instance design — no Redis).
//! Per-IP: room intents 5/min, auth 10/min. Per-wallet: actions burst 10 per 5 s.
//! Active-room cap (20/wallet) is enforced with a SQL count at join time.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Instant;

use crate::error::ApiError;

pub const ACTIVE_ROOM_CAP: i64 = 20;

struct Bucket {
    tokens: f64,
    last: Instant,
}

struct BucketMap {
    inner: Mutex<HashMap<String, Bucket>>,
    capacity: f64,
    refill_per_sec: f64,
}

impl BucketMap {
    fn new(capacity: f64, refill_per_sec: f64) -> Self {
        Self {
            inner: Mutex::new(HashMap::new()),
            capacity,
            refill_per_sec,
        }
    }

    fn try_take(&self, key: &str) -> bool {
        let mut map = self.inner.lock().expect("bucket lock");
        if map.len() > 100_000 {
            let cap = self.capacity;
            map.retain(|_, b| b.tokens < cap); // drop full (idle) buckets
        }
        let bucket = map.entry(key.to_string()).or_insert(Bucket {
            tokens: self.capacity,
            last: Instant::now(),
        });
        let elapsed = bucket.last.elapsed().as_secs_f64();
        bucket.tokens = (bucket.tokens + elapsed * self.refill_per_sec).min(self.capacity);
        bucket.last = Instant::now();
        if bucket.tokens >= 1.0 {
            bucket.tokens -= 1.0;
            true
        } else {
            false
        }
    }
}

pub struct RateLimits {
    ip_intents: BucketMap,
    ip_auth: BucketMap,
    wallet_actions: BucketMap,
}

impl Default for RateLimits {
    fn default() -> Self {
        Self::new()
    }
}

impl RateLimits {
    pub fn new() -> Self {
        Self {
            ip_intents: BucketMap::new(5.0, 5.0 / 60.0),
            ip_auth: BucketMap::new(10.0, 10.0 / 60.0),
            wallet_actions: BucketMap::new(10.0, 10.0 / 5.0),
        }
    }

    pub fn check_intents(&self, ip: &str) -> Result<(), ApiError> {
        if self.ip_intents.try_take(ip) {
            Ok(())
        } else {
            Err(ApiError::too_many("too many room intents; slow down"))
        }
    }

    pub fn check_auth(&self, ip: &str) -> Result<(), ApiError> {
        if self.ip_auth.try_take(ip) {
            Ok(())
        } else {
            Err(ApiError::too_many("too many auth attempts; slow down"))
        }
    }

    pub fn check_actions(&self, wallet: &str) -> Result<(), ApiError> {
        if self.wallet_actions.try_take(wallet) {
            Ok(())
        } else {
            Err(ApiError::too_many("too many actions; slow down"))
        }
    }
}

/// Active-room cap: live candidacies/seats for a wallet must stay under the cap.
pub async fn check_active_room_cap(
    pool: &deadpool_postgres::Pool,
    wallet: &str,
) -> Result<(), ApiError> {
    let client = pool.get().await?;
    let row = client
        .query_one(
            r#"
            SELECT count(*) AS n FROM seat_candidates sc
            JOIN matches m ON m.id = sc.match_id
            WHERE sc.wallet = $1
              AND sc.status IN ('reported', 'candidate', 'confirmed')
              AND m.status::text NOT IN ('settled', 'voided')
            "#,
            &[&wallet],
        )
        .await?;
    let n: i64 = row.get("n");
    if n >= ACTIVE_ROOM_CAP {
        return Err(ApiError::too_many(format!(
            "active-room cap reached ({ACTIVE_ROOM_CAP})"
        )));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn buckets_deplete_and_block() {
        let limits = RateLimits::new();
        for _ in 0..5 {
            limits.check_intents("1.2.3.4").unwrap();
        }
        assert!(limits.check_intents("1.2.3.4").is_err());
        // Other keys unaffected.
        limits.check_intents("5.6.7.8").unwrap();
    }

    #[test]
    fn wallet_actions_burst_10() {
        let limits = RateLimits::new();
        for _ in 0..10 {
            limits.check_actions("w").unwrap();
        }
        assert!(limits.check_actions("w").is_err());
    }
}
