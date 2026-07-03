//! Signed settlement price client — port of `services/settlement-chain/src/main.ts`
//! `resolvePyth` / `validateSignedPriceResponse` to Rust.
//!
//! `GET {base}/prices/at?symbol=<SYM>&timestamp=<unix_sec>` →
//! `{"price": {"token": "0x…20B", "priceInWad": "…", "timestampMs": …, "v": …, "r": "0x…32B", "s": "0x…32B"}}`
//! (fields also accepted at the top level and with snake_case aliases, mirroring the TS
//! `field(..)` helper).
//!
//! Validation (all must hold or the payload is rejected):
//! - `symbol` (when present) equals the requested symbol (case-insensitive),
//! - `floor(timestampMs / 1000) == scheduled_end_ts` EXACTLY,
//! - `priceInWad > 0` and fits `i128` (settlement math domain),
//! - `token` equals the match's on-chain `price_token` (20 bytes).

use serde_json::Value;
use sha2::{Digest, Sha256};

use syndicate_chain::settle_args::SignedPriceDto;

#[derive(Debug)]
pub enum OracleError {
    /// 404 or transport failure — retry with backoff until the settle grace, then VOID.
    Unavailable(String),
    /// Response present but failed validation — same retry-until-grace treatment (the
    /// server may re-sign correctly on a later poll).
    Invalid(String),
}

impl std::fmt::Display for OracleError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            OracleError::Unavailable(e) => write!(f, "signed price unavailable: {e}"),
            OracleError::Invalid(e) => write!(f, "signed price invalid: {e}"),
        }
    }
}
impl std::error::Error for OracleError {}

#[derive(Clone, Debug)]
pub struct ValidatedSignedPrice {
    pub dto: SignedPriceDto,
    /// Price in wad as `i128` (exp −18) — the settlement-domain scalar.
    pub price_wad: i128,
    /// `floor(timestamp_ms / 1000)` — equals `scheduled_end_ts` by construction.
    pub publish_time_sec: u64,
    /// sha256 of the raw signed-price JSON (audit trail).
    pub payload_sha256_hex: String,
    pub source_url: String,
}

#[derive(Clone, Debug)]
pub struct SignedPriceClient {
    pub base_url: String,
    pub timeout_ms: u64,
}

impl SignedPriceClient {
    pub fn new(base_url: impl Into<String>) -> Self {
        Self {
            base_url: base_url.into(),
            timeout_ms: 5_000,
        }
    }

    pub fn price_at_url(&self, symbol: &str, timestamp_sec: u64) -> String {
        format!(
            "{}/prices/at?symbol={}&timestamp={}",
            self.base_url.trim_end_matches('/'),
            symbol,
            timestamp_sec
        )
    }

    /// Blocking fetch (call from `spawn_blocking`).
    pub fn fetch_price_at(
        &self,
        symbol: &str,
        timestamp_sec: u64,
        expected_token: &[u8; 20],
    ) -> Result<ValidatedSignedPrice, OracleError> {
        let url = self.price_at_url(symbol, timestamp_sec);
        let response = ureq::get(&url)
            .timeout(std::time::Duration::from_millis(self.timeout_ms))
            .call();
        let body: Value = match response {
            Ok(resp) => resp
                .into_json()
                .map_err(|e| OracleError::Invalid(format!("bad json: {e}")))?,
            Err(ureq::Error::Status(404, _)) => {
                return Err(OracleError::Unavailable("404 no signed price".into()))
            }
            Err(ureq::Error::Status(code, _)) => {
                return Err(OracleError::Unavailable(format!("http {code}")))
            }
            Err(e) => return Err(OracleError::Unavailable(e.to_string())),
        };
        let mut validated =
            validate_signed_price_json(&body, symbol, timestamp_sec, expected_token)?;
        validated.source_url = url;
        Ok(validated)
    }

    /// Blocking `/health` probe.
    pub fn health(&self) -> bool {
        let url = format!("{}/health", self.base_url.trim_end_matches('/'));
        ureq::get(&url)
            .timeout(std::time::Duration::from_millis(2_000))
            .call()
            .map(|r| r.status() == 200)
            .unwrap_or(false)
    }
}

/// Pure validation + DTO construction (unit-tested without a server).
pub fn validate_signed_price_json(
    body: &Value,
    expected_symbol: &str,
    expected_ts_sec: u64,
    expected_token: &[u8; 20],
) -> Result<ValidatedSignedPrice, OracleError> {
    let price_obj = body.get("price").filter(|v| v.is_object()).unwrap_or(body);
    if !price_obj.is_object() {
        return Err(OracleError::Invalid("signed price is not an object".into()));
    }

    if let Some(symbol) = field(price_obj, "symbol", "symbol").and_then(Value::as_str) {
        if !symbol.eq_ignore_ascii_case(expected_symbol) {
            return Err(OracleError::Invalid(format!(
                "symbol mismatch: expected {expected_symbol}, got {symbol}"
            )));
        }
    }

    let timestamp_ms = parse_u64(
        field(price_obj, "timestampMs", "timestamp_ms")
            .or_else(|| field(price_obj, "timestamp", "timestamp")),
        "timestampMs",
    )?;
    if timestamp_ms / 1_000 != expected_ts_sec {
        return Err(OracleError::Invalid(format!(
            "timestamp mismatch: floor({timestamp_ms}/1000) != {expected_ts_sec}"
        )));
    }

    let price_wad = parse_wad(
        field(price_obj, "priceInWad", "price_in_wad")
            .ok_or_else(|| OracleError::Invalid("missing priceInWad".into()))?,
    )?;
    if price_wad <= 0 {
        return Err(OracleError::Invalid("price must be positive".into()));
    }

    let token = fixed_hex::<20>(field(price_obj, "token", "token"), "token")?;
    if &token != expected_token {
        return Err(OracleError::Invalid(
            "signed price token does not match the match's price_token".into(),
        ));
    }

    let v = parse_u64(field(price_obj, "v", "v"), "v")?;
    if !matches!(v, 0 | 1 | 27 | 28) {
        return Err(OracleError::Invalid(format!("invalid recovery id v={v}")));
    }
    let r = fixed_hex::<32>(field(price_obj, "r", "r"), "r")?;
    let s = fixed_hex::<32>(field(price_obj, "s", "s"), "s")?;

    // Big-endian uint256 wad for the on-chain wire format.
    let mut price_in_wad = [0u8; 32];
    price_in_wad[16..].copy_from_slice(&(price_wad as u128).to_be_bytes());

    let raw = serde_json::to_vec(price_obj).unwrap_or_default();
    Ok(ValidatedSignedPrice {
        dto: SignedPriceDto {
            token,
            price_in_wad,
            timestamp_ms,
            v: v as u8,
            r,
            s,
        },
        price_wad,
        publish_time_sec: timestamp_ms / 1_000,
        payload_sha256_hex: hex::encode(Sha256::digest(&raw)),
        source_url: String::new(),
    })
}

/// camelCase-first field lookup with snake_case fallback (mirrors the TS helper).
fn field<'a>(obj: &'a Value, camel: &str, snake: &str) -> Option<&'a Value> {
    obj.get(camel).or_else(|| obj.get(snake))
}

fn parse_u64(value: Option<&Value>, name: &str) -> Result<u64, OracleError> {
    let value = value.ok_or_else(|| OracleError::Invalid(format!("missing {name}")))?;
    match value {
        Value::Number(n) => n
            .as_u64()
            .ok_or_else(|| OracleError::Invalid(format!("{name} must be a u64"))),
        Value::String(s) => s
            .trim()
            .parse()
            .map_err(|_| OracleError::Invalid(format!("{name} must be a u64"))),
        _ => Err(OracleError::Invalid(format!("{name} must be a u64"))),
    }
}

/// Parse a wad price: decimal string, `0x` hex string, or JSON integer. Must fit i128.
fn parse_wad(value: &Value) -> Result<i128, OracleError> {
    let text = match value {
        Value::String(s) => s.trim().to_string(),
        Value::Number(n) => n.to_string(),
        _ => {
            return Err(OracleError::Invalid(
                "priceInWad must be a string or number".into(),
            ))
        }
    };
    let parsed = if let Some(hex_part) = text.strip_prefix("0x").or_else(|| text.strip_prefix("0X"))
    {
        i128::from_str_radix(hex_part, 16)
    } else {
        text.parse::<i128>()
    };
    parsed.map_err(|_| OracleError::Invalid(format!("priceInWad does not fit i128: {text}")))
}

fn fixed_hex<const N: usize>(value: Option<&Value>, name: &str) -> Result<[u8; N], OracleError> {
    let raw = value
        .and_then(Value::as_str)
        .ok_or_else(|| OracleError::Invalid(format!("missing {name}")))?;
    let raw = raw.strip_prefix("0x").unwrap_or(raw);
    let bytes =
        hex::decode(raw).map_err(|_| OracleError::Invalid(format!("{name} must be hex")))?;
    if bytes.len() != N {
        return Err(OracleError::Invalid(format!("{name} must be {N} bytes")));
    }
    let mut out = [0u8; N];
    out.copy_from_slice(&bytes);
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const TOKEN_HEX: &str = "a7bae7da3e4950700be9f107eb186e89a474d180";

    fn token() -> [u8; 20] {
        let mut t = [0u8; 20];
        t.copy_from_slice(&hex::decode(TOKEN_HEX).unwrap());
        t
    }

    fn good_body(ts_ms: u64) -> Value {
        json!({
            "price": {
                "token": format!("0x{TOKEN_HEX}"),
                "symbol": "BTCUSD",
                "priceInWad": "65000000000000000000000",
                "timestampMs": ts_ms,
                "v": 27,
                "r": format!("0x{}", "11".repeat(32)),
                "s": format!("0x{}", "22".repeat(32)),
            }
        })
    }

    #[test]
    fn accepts_valid_payload_and_builds_dto() {
        let v = validate_signed_price_json(
            &good_body(1_700_000_000_123),
            "BTCUSD",
            1_700_000_000,
            &token(),
        )
        .unwrap();
        assert_eq!(v.price_wad, 65_000_000_000_000_000_000_000i128);
        assert_eq!(v.publish_time_sec, 1_700_000_000);
        assert_eq!(v.dto.timestamp_ms, 1_700_000_000_123);
        assert_eq!(v.dto.v, 27);
        assert_eq!(v.dto.token, token());
        // BE uint256: upper 16 bytes zero, lower 16 = u128 BE.
        assert_eq!(&v.dto.price_in_wad[..16], &[0u8; 16]);
        assert_eq!(
            u128::from_be_bytes(v.dto.price_in_wad[16..].try_into().unwrap()),
            65_000_000_000_000_000_000_000u128
        );
    }

    #[test]
    fn rejects_timestamp_symbol_token_and_nonpositive_price() {
        let t = token();
        // Off-by-one second.
        assert!(validate_signed_price_json(
            &good_body(1_700_000_001_000),
            "BTCUSD",
            1_700_000_000,
            &t
        )
        .is_err());
        // Wrong symbol.
        assert!(validate_signed_price_json(
            &good_body(1_700_000_000_000),
            "ETHUSD",
            1_700_000_000,
            &t
        )
        .is_err());
        // Wrong token.
        let other = [9u8; 20];
        assert!(validate_signed_price_json(
            &good_body(1_700_000_000_000),
            "BTCUSD",
            1_700_000_000,
            &other
        )
        .is_err());
        // Zero price.
        let mut body = good_body(1_700_000_000_000);
        body["price"]["priceInWad"] = json!("0");
        assert!(validate_signed_price_json(&body, "BTCUSD", 1_700_000_000, &t).is_err());
        // Bad recovery id.
        let mut body = good_body(1_700_000_000_000);
        body["price"]["v"] = json!(5);
        assert!(validate_signed_price_json(&body, "BTCUSD", 1_700_000_000, &t).is_err());
    }

    #[test]
    fn accepts_snake_case_and_flat_payloads() {
        let flat = json!({
            "token": format!("0x{TOKEN_HEX}"),
            "price_in_wad": "1000",
            "timestamp_ms": 5_000u64,
            "v": 0,
            "r": format!("0x{}", "11".repeat(32)),
            "s": format!("0x{}", "22".repeat(32)),
        });
        let v = validate_signed_price_json(&flat, "BTCUSD", 5, &token()).unwrap();
        assert_eq!(v.price_wad, 1_000);
        assert_eq!(v.dto.v, 0);
    }

    #[test]
    fn url_shape_matches_price_server_api() {
        let c = SignedPriceClient::new("http://p:8080/");
        assert_eq!(
            c.price_at_url("BTCUSD", 1_700_000_000),
            "http://p:8080/prices/at?symbol=BTCUSD&timestamp=1700000000"
        );
    }
}
