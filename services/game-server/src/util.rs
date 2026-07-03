//! Small shared helpers.

pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("clock before epoch")
        .as_millis() as u64
}

pub fn now_sec() -> u64 {
    now_ms() / 1000
}

/// ms-epoch of a chrono timestamp.
pub fn ts_ms(t: chrono::DateTime<chrono::Utc>) -> u64 {
    t.timestamp_millis().max(0) as u64
}
