//! Real Switchboard Crossbar client (`04 §11`, `08 OQ1`).
//!
//! Crossbar is Switchboard's off-chain gateway: it serves current feed values (and the
//! encoded update to post on-chain). This module models its response, parses decimal
//! prices into the integer fixed-point [`crate::Sample`] the deterministic core uses
//! (**float-free** — decimals are parsed by string, never `f64`), and exposes a
//! provider behind the [`CrossbarClient`] trait.
//!
//! The structs/parsers are real and unit-tested offline. The live HTTP fetch
//! ([`HttpCrossbarClient`]) is behind the `net` feature. Note: the *settlement* samples
//! are ultimately the on-chain-verifiable Switchboard updates; this off-chain client
//! drives the live chart and records samples, which the recorded integer values back.

use serde::Deserialize;

use crate::Sample;

/// One feed value from Crossbar.
#[derive(Debug, Clone, Deserialize)]
pub struct CrossbarUpdate {
    pub feed: String,
    /// Decimal price as a string, e.g. "63000.42" (parsed without floating point).
    pub value: String,
    #[serde(default)]
    pub timestamp: u64,
}

/// A Crossbar response carrying one or more feed values.
#[derive(Debug, Clone, Deserialize)]
pub struct CrossbarResponse {
    pub results: Vec<CrossbarUpdate>,
}

#[derive(Debug)]
pub enum CrossbarError {
    Http(String),
    Parse(String),
    BadValue(String),
}

pub fn parse_response(json: &str) -> Result<CrossbarResponse, serde_json::Error> {
    serde_json::from_str(json)
}

/// Parse a decimal string to a fixed-point integer at `decimals` precision, **without
/// floating point**. Extra fractional digits are truncated toward zero (to the feed's
/// precision). Returns `None` on malformed input.
pub fn parse_fixed_point(s: &str, decimals: u32) -> Option<i128> {
    let s = s.trim();
    let (neg, s) = match s.strip_prefix('-') {
        Some(rest) => (true, rest),
        None => (false, s),
    };
    let mut parts = s.splitn(2, '.');
    let int_part = parts.next()?;
    let frac_part = parts.next().unwrap_or("");
    if int_part.is_empty() && frac_part.is_empty() {
        return None;
    }
    if !int_part.chars().all(|c| c.is_ascii_digit()) || !frac_part.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    let scale = 10i128.checked_pow(decimals)?;
    let int_val: i128 = if int_part.is_empty() { 0 } else { int_part.parse().ok()? };
    let mut frac = frac_part.to_string();
    while frac.len() < decimals as usize {
        frac.push('0');
    }
    let frac_val: i128 = if decimals == 0 { 0 } else { frac[..decimals as usize].parse().ok()? };
    let mag = int_val.checked_mul(scale)?.checked_add(frac_val)?;
    Some(if neg { -mag } else { mag })
}

/// Convert a Crossbar update into a recorded [`Sample`] at the feed's fixed-point
/// precision. `sampled_ts` is the engine-clock sampling timestamp.
pub fn update_to_sample(
    u: &CrossbarUpdate,
    decimals: u32,
    confidence: u64,
    sampled_ts: u64,
) -> Result<Sample, CrossbarError> {
    let price = parse_fixed_point(&u.value, decimals)
        .ok_or_else(|| CrossbarError::BadValue(u.value.clone()))?;
    Ok(Sample { ts: sampled_ts, price, confidence, publish_ts: u.timestamp })
}

/// Pull current feed values from Crossbar. Real impl behind `net`; tests inject a
/// recorded-response client.
pub trait CrossbarClient {
    fn fetch(&self, feed: &str) -> Result<CrossbarResponse, CrossbarError>;
}

#[cfg(feature = "net")]
pub struct HttpCrossbarClient {
    pub base: String,
}

#[cfg(feature = "net")]
impl HttpCrossbarClient {
    pub fn new(base: impl Into<String>) -> Self {
        Self { base: base.into() }
    }
    /// Public Switchboard Crossbar endpoint.
    pub fn public() -> Self {
        Self::new("https://crossbar.switchboard.xyz")
    }
}

#[cfg(feature = "net")]
impl CrossbarClient for HttpCrossbarClient {
    fn fetch(&self, feed: &str) -> Result<CrossbarResponse, CrossbarError> {
        let url = format!("{}/simulate/{}", self.base.trim_end_matches('/'), feed);
        let body = ureq::get(&url)
            .call()
            .map_err(|e| CrossbarError::Http(e.to_string()))?
            .into_string()
            .map_err(|e| CrossbarError::Http(e.to_string()))?;
        parse_response(&body).map_err(|e| CrossbarError::Parse(e.to_string()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const JSON: &str = r#"{
        "results": [
            { "feed": "BTC/USD", "value": "63000.42", "timestamp": 1700000000 },
            { "feed": "BTC/USD", "value": "63000.4", "timestamp": 1700000003 },
            { "feed": "BTC/USD", "value": "63001", "timestamp": 1700000006 }
        ]
    }"#;

    #[test]
    fn parses_crossbar_and_converts_to_fixed_point_samples() {
        let resp = parse_response(JSON).unwrap();
        assert_eq!(resp.results.len(), 3);
        let s0 = update_to_sample(&resp.results[0], 2, 5, 0).unwrap();
        let s1 = update_to_sample(&resp.results[1], 2, 5, 1).unwrap();
        let s2 = update_to_sample(&resp.results[2], 2, 5, 2).unwrap();
        assert_eq!(s0.price, 6_300_042); // 63000.42 @ 2dp
        assert_eq!(s1.price, 6_300_040); // 63000.4  → .40
        assert_eq!(s2.price, 6_300_100); // 63001    → .00
        assert_eq!(s0.publish_ts, 1_700_000_000);
        assert_eq!(s0.ts, 0);
    }

    #[test]
    fn fixed_point_edge_cases() {
        assert_eq!(parse_fixed_point("100", 2), Some(10_000));
        assert_eq!(parse_fixed_point("0.5", 2), Some(50));
        assert_eq!(parse_fixed_point("1.005", 2), Some(100)); // truncates to feed precision
        assert_eq!(parse_fixed_point("-12.3", 1), Some(-123));
        assert_eq!(parse_fixed_point("12.34", 0), Some(12));
        assert_eq!(parse_fixed_point("abc", 2), None);
        assert_eq!(parse_fixed_point("", 2), None);
    }
}
