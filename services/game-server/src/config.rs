//! Static server config (env), creator-facing bounds/defaults (port of the old
//! `services/config` TS math), the normative `config_hash` canonical JSON, room-code
//! generation, blinds derivation, and drand timelock-target math.

use serde::{Deserialize, Serialize};
use syndicate_chain::{drand_round_publish_ts, DRAND_GENESIS_TIME, DRAND_PERIOD_SEC};

/// Must equal the on-chain `MAX_TIMELOCK_SKEW_SEC`.
pub const MAX_TIMELOCK_SKEW_SEC: u64 = 20;
pub const DEFAULT_SEAL_WINDOW_SEC: u64 = 90;
pub const MIN_SAFE_SEAL_WINDOW_SEC: u64 = DEFAULT_SEAL_WINDOW_SEC;

/// League of Entropy quicknet.
pub const DRAND_CHAIN_HASH_DEFAULT: &str =
    "52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971";
pub const DRAND_SCHEME: &str = "bls-unchained-g1-rfc9380";

/// Supported price feeds: display symbol, signed-price-server symbol, oracle token
/// address (20-byte Ethereum address, hex without 0x).
pub const FEEDS: &[(&str, &str, &str)] = &[
    (
        "BTC/USD",
        "BTCUSD",
        "a7BaE7da3E4950700BE9f107EB186e89a474d180",
    ),
    (
        "ETH/USD",
        "ETHUSD",
        "6Dd0C6a2e058bc3F7D6AaCe23965180BcBbb2635",
    ),
    (
        "SOL/USD",
        "SOLUSD",
        "D31a59c85aE9D8edEFeC411D448f90841571b89c",
    ),
];

pub fn feed_oracle_symbol(feed: &str) -> Option<&'static str> {
    FEEDS
        .iter()
        .find(|(f, _, _)| *f == feed)
        .map(|(_, s, _)| *s)
}

pub fn feed_token_bytes(feed: &str) -> Option<[u8; 20]> {
    let hex_addr = FEEDS
        .iter()
        .find(|(f, _, _)| *f == feed)
        .map(|(_, _, a)| *a)?;
    let bytes = hex::decode(hex_addr).ok()?;
    let mut out = [0u8; 20];
    if bytes.len() != 20 {
        return None;
    }
    out.copy_from_slice(&bytes);
    Some(out)
}

pub const DEFAULT_ORACLE_EXPONENT: i32 = -18;

// ---------------------------------------------------------------------------------
// Environment config
// ---------------------------------------------------------------------------------

#[derive(Clone, Debug)]
pub struct ServerConfig {
    pub port: u16,
    pub database_url: String,
    pub rpc_url: String,
    pub program_id: String,
    /// Primary/default chip mint (first entry of the allowlist) — the FE's default token.
    pub chips_token_mint: String,
    /// Operator allowlist: the only SPL mints accepted as a match's chip token. A match's
    /// mint is enforced against this set at create-tx verification; joiners inherit the
    /// match mint on-chain, so this is the single control point.
    pub chips_token_mints: Vec<String>,
    pub signed_price_server_url: String,
    pub admin_tokens: Vec<String>,
    pub cors_allowed_origins: Vec<String>,
    pub geofence_blocklist: Vec<String>,
    pub drand_api: String,
    pub drand_chain_hash: String,
    pub node_id: String,
}

impl ServerConfig {
    pub fn from_env() -> Result<Self, String> {
        let port = std::env::var("GAME_SERVER_PORT")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(8080);
        let mut database_url =
            std::env::var("DATABASE_URL").map_err(|_| "DATABASE_URL is required".to_string())?;
        if let Ok(path) = std::env::var("DATABASE_PASSWORD_FILE") {
            if let Ok(pw) = std::fs::read_to_string(&path) {
                database_url = inject_db_password(&database_url, pw.trim());
            }
        }
        // Chip-token allowlist. `CHIPS_TOKEN_MINTS` (CSV) is the source of truth; the
        // legacy singular `CHIPS_TOKEN_MINT` is a one-entry fallback. Primary = first.
        let chips_token_mints = resolve_chip_mints(
            &std::env::var("CHIPS_TOKEN_MINTS").unwrap_or_default(),
            &std::env::var("CHIPS_TOKEN_MINT").unwrap_or_default(),
        );
        let chips_token_mint = chips_token_mints.first().cloned().unwrap_or_default();
        Ok(Self {
            port,
            database_url,
            rpc_url: std::env::var("SOLANA_RPC_URL_PRIMARY")
                .unwrap_or_else(|_| "https://api.devnet.solana.com".into()),
            program_id: std::env::var("SYNDICATE_PROGRAM_ID")
                .unwrap_or_else(|_| syndicate_chain::PROGRAM_ID_STR.into()),
            chips_token_mint,
            chips_token_mints,
            signed_price_server_url: std::env::var("SIGNED_PRICE_SERVER_URL")
                .unwrap_or_else(|_| "http://localhost:8090".into()),
            admin_tokens: split_csv(&std::env::var("ADMIN_TOKENS").unwrap_or_default()),
            cors_allowed_origins: split_csv(
                &std::env::var("CORS_ALLOWED_ORIGINS").unwrap_or_else(|_| "*".into()),
            ),
            geofence_blocklist: {
                let v =
                    split_csv(&std::env::var("GEOFENCE_BLOCKLIST").unwrap_or_else(|_| "IN".into()));
                if v.is_empty() {
                    vec!["IN".into()]
                } else {
                    v
                }
            },
            drand_api: std::env::var("DRAND_API").unwrap_or_else(|_| "https://api.drand.sh".into()),
            drand_chain_hash: std::env::var("DRAND_CHAIN_HASH")
                .unwrap_or_else(|_| DRAND_CHAIN_HASH_DEFAULT.into()),
            node_id: format!("game-server-{}", std::process::id()),
        })
    }

    /// Whether `mint` (base58) is an operator-allowed chip token.
    pub fn is_mint_allowed(&self, mint: &str) -> bool {
        self.chips_token_mints.iter().any(|m| m == mint)
    }
}

/// Resolve the chip-token allowlist: prefer the `CHIPS_TOKEN_MINTS` CSV; else fall back to
/// the single `CHIPS_TOKEN_MINT`. De-dupes while preserving order (first = primary).
pub fn resolve_chip_mints(csv: &str, single: &str) -> Vec<String> {
    let mut v = split_csv(csv);
    if v.is_empty() && !single.trim().is_empty() {
        v.push(single.trim().to_string());
    }
    let mut seen = std::collections::HashSet::new();
    v.retain(|m| seen.insert(m.clone()));
    v
}

fn split_csv(raw: &str) -> Vec<String> {
    raw.split(',')
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect()
}

/// `postgres://user@host/db` + password → `postgres://user:pw@host/db`.
pub fn inject_db_password(url: &str, password: &str) -> String {
    if password.is_empty() {
        return url.to_string();
    }
    let Some(scheme_end) = url.find("://") else {
        return url.to_string();
    };
    let Some(at) = url[scheme_end + 3..].find('@').map(|i| i + scheme_end + 3) else {
        return url.to_string();
    };
    if url[scheme_end + 3..at].contains(':') {
        return url.to_string(); // password already present
    }
    format!("{}:{}{}", &url[..at], password, &url[at..])
}

// ---------------------------------------------------------------------------------
// Creator bounds/defaults (runtime_config-overlayable)
// ---------------------------------------------------------------------------------

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(default)]
pub struct Bounds {
    pub buy_in_min: u64,
    pub buy_in_max: u64,
    pub fill_window_min_sec: u64,
    pub fill_window_max_sec: u64,
    pub streets_min: u8,
    pub streets_max: u8,
    pub street_duration_min_sec: u64,
    pub street_duration_max_sec: u64,
    pub observation_min_sec: u64,
    pub observation_max_sec: u64,
    pub players_min: u8,
    pub players_max: u8,
}

impl Default for Bounds {
    fn default() -> Self {
        Self {
            buy_in_min: 1_000_000,
            buy_in_max: 1_000_000_000,
            fill_window_min_sec: 20,
            fill_window_max_sec: 5000,
            streets_min: 1,
            streets_max: 5,
            street_duration_min_sec: 30,
            street_duration_max_sec: 600,
            observation_min_sec: 0,
            observation_max_sec: 600,
            players_min: 2,
            players_max: 5,
        }
    }
}

/// Admin-tunable knobs; defaults here, overlaid from the `runtime_config` table
/// (key `game_server`, JSON object with any subset of these fields).
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(default)]
pub struct Overlay {
    pub bounds: Bounds,
    pub seal_window_sec: u64,
    pub begin_live_window_sec: u64,
    pub action_timeout_ms: u64,
    pub time_bank_sec: u64,
    pub rake_bps: u32,
    pub entry_fee: u64,
    pub geofence_blocklist: Vec<String>,
    pub intent_ttl_sec: u64,
}

impl Default for Overlay {
    fn default() -> Self {
        Self {
            bounds: Bounds::default(),
            seal_window_sec: DEFAULT_SEAL_WINDOW_SEC,
            begin_live_window_sec: 30,
            action_timeout_ms: 25_000,
            time_bank_sec: 60,
            rake_bps: 300,
            entry_fee: 0,
            geofence_blocklist: vec!["IN".into()],
            intent_ttl_sec: 600,
        }
    }
}

pub fn validate_overlay(overlay: &Overlay) -> Result<(), String> {
    if overlay.seal_window_sec < MIN_SAFE_SEAL_WINDOW_SEC {
        return Err(format!(
            "seal_window_sec must be at least {MIN_SAFE_SEAL_WINDOW_SEC}s"
        ));
    }
    Ok(())
}

/// bb = buy_in/100 (min 2), sb = bb/2 (min 1) — mirrors old config `deriveBlinds`.
pub fn derive_blinds(buy_in: u64) -> (u64, u64) {
    let bb = (buy_in / 100).max(2);
    let sb = (bb / 2).max(1);
    (sb, bb)
}

/// v2 default rake cap: 10% of the buy-in.
pub fn default_rake_cap(buy_in: u64) -> u64 {
    buy_in / 10
}

// ---------------------------------------------------------------------------------
// config_hash — normative canonical JSON
// ---------------------------------------------------------------------------------

#[derive(Clone, Debug)]
pub struct CanonicalConfig {
    pub feed_symbol: String,
    pub buy_in: u64,
    pub entry_fee: u64,
    pub rake_bps: u32,
    pub rake_cap: u64,
    pub min_players: u8,
    pub max_players: u8,
    /// `(duration_sec, observation_sec)` per street.
    pub streets: Vec<(u64, u64)>,
    pub seal_window_sec: u64,
    pub begin_live_window_sec: u64,
    pub fill_window_sec: u64,
    pub action_timeout_ms: u64,
    pub time_bank_sec: u64,
    pub small_blind: u64,
    pub big_blind: u64,
    pub visibility: String,
}

/// Canonical JSON: keys sorted lexicographically, no whitespace, integers as JSON
/// numbers. The FE reproduces this byte-for-byte to verify `config_hash`.
pub fn canonical_config_json(c: &CanonicalConfig) -> String {
    let streets: Vec<String> = c
        .streets
        .iter()
        .map(|(d, o)| format!("{{\"duration_sec\":{d},\"observation_sec\":{o}}}"))
        .collect();
    format!(
        "{{\"action_timeout_ms\":{},\"begin_live_window_sec\":{},\"big_blind\":{},\"buy_in\":{},\"entry_fee\":{},\"feed_symbol\":{},\"fill_window_sec\":{},\"max_players\":{},\"min_players\":{},\"rake_bps\":{},\"rake_cap\":{},\"seal_window_sec\":{},\"small_blind\":{},\"streets\":[{}],\"time_bank_sec\":{},\"visibility\":{}}}",
        c.action_timeout_ms,
        c.begin_live_window_sec,
        c.big_blind,
        c.buy_in,
        c.entry_fee,
        serde_json::to_string(&c.feed_symbol).expect("json string"),
        c.fill_window_sec,
        c.max_players,
        c.min_players,
        c.rake_bps,
        c.rake_cap,
        c.seal_window_sec,
        c.small_blind,
        streets.join(","),
        c.time_bank_sec,
        serde_json::to_string(&c.visibility).expect("json string"),
    )
}

pub fn config_hash(c: &CanonicalConfig) -> [u8; 32] {
    syndicate_shared::intent::sha256(canonical_config_json(c).as_bytes())
}

// ---------------------------------------------------------------------------------
// Room codes
// ---------------------------------------------------------------------------------

/// A–Z minus O/I, plus 2–9 (no 0/1) — 32 unambiguous chars.
pub const ROOM_CODE_ALPHABET: &[u8] = b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
pub const ROOM_CODE_LEN: usize = 6;

pub fn generate_room_code() -> String {
    use rand::Rng;
    let mut rng = rand::rngs::OsRng;
    (0..ROOM_CODE_LEN)
        .map(|_| ROOM_CODE_ALPHABET[rng.gen_range(0..ROOM_CODE_ALPHABET.len())] as char)
        .collect()
}

pub fn normalize_room_code(code: &str) -> String {
    code.trim().to_ascii_uppercase()
}

// ---------------------------------------------------------------------------------
// drand timelock target
// ---------------------------------------------------------------------------------

/// First drand round publishing STRICTLY AFTER `latest_match_end_sec`
/// (publish_ts(round) = genesis + round·period, matching the on-chain check).
pub fn timelock_target_round(latest_match_end_sec: u64) -> u64 {
    latest_match_end_sec.saturating_sub(DRAND_GENESIS_TIME) / DRAND_PERIOD_SEC + 1
}

/// On-chain bound: publish ts of the target round ∈ (latest_match_end, +20s].
pub fn timelock_target_valid(target_round: u64, latest_match_end_sec: u64) -> bool {
    match drand_round_publish_ts(target_round) {
        Some(ts) => ts > latest_match_end_sec && ts <= latest_match_end_sec + MAX_TIMELOCK_SKEW_SEC,
        None => false,
    }
}

/// `latest_match_end = seal_deadline + total_betting_duration + begin_live_window`.
pub fn latest_match_end_sec(
    seal_deadline_sec: u64,
    total_betting_duration_sec: u64,
    begin_live_window_sec: u64,
) -> u64 {
    seal_deadline_sec + total_betting_duration_sec + begin_live_window_sec
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> CanonicalConfig {
        CanonicalConfig {
            feed_symbol: "BTC/USD".into(),
            buy_in: 10_000_000,
            entry_fee: 0,
            rake_bps: 300,
            rake_cap: 1_000_000,
            min_players: 2,
            max_players: 2,
            streets: vec![(60, 10), (60, 20)],
            seal_window_sec: 20,
            begin_live_window_sec: 30,
            fill_window_sec: 120,
            action_timeout_ms: 25_000,
            time_bank_sec: 60,
            small_blind: 50_000,
            big_blind: 100_000,
            visibility: "public".into(),
        }
    }

    /// Fixed interop vector — FE must reproduce both the string and the hash.
    #[test]
    fn config_hash_fixed_vector() {
        let c = sample();
        let expected = concat!(
            "{\"action_timeout_ms\":25000,\"begin_live_window_sec\":30,\"big_blind\":100000,",
            "\"buy_in\":10000000,\"entry_fee\":0,\"feed_symbol\":\"BTC/USD\",\"fill_window_sec\":120,",
            "\"max_players\":2,\"min_players\":2,\"rake_bps\":300,\"rake_cap\":1000000,",
            "\"seal_window_sec\":20,\"small_blind\":50000,",
            "\"streets\":[{\"duration_sec\":60,\"observation_sec\":10},{\"duration_sec\":60,\"observation_sec\":20}],",
            "\"time_bank_sec\":60,\"visibility\":\"public\"}"
        );
        assert_eq!(canonical_config_json(&c), expected);
        assert_eq!(
            hex::encode(config_hash(&c)),
            "0bcc934547cbc24f694f6eb91c9744ac90efa6acc71639d5a007d3ab4b4b6192"
        );
    }

    #[test]
    fn canonical_json_keys_are_sorted_and_compact() {
        let s = canonical_config_json(&sample());
        assert!(!s.contains(' '));
        let keys = [
            "action_timeout_ms",
            "begin_live_window_sec",
            "big_blind",
            "buy_in",
            "entry_fee",
            "feed_symbol",
            "fill_window_sec",
            "max_players",
            "min_players",
            "rake_bps",
            "rake_cap",
            "seal_window_sec",
            "small_blind",
            "streets",
            "time_bank_sec",
            "visibility",
        ];
        let mut last = 0usize;
        for k in keys {
            let pos = s
                .find(&format!("\"{k}\":"))
                .unwrap_or_else(|| panic!("missing key {k}"));
            assert!(pos >= last, "key {k} out of order");
            last = pos;
        }
    }

    #[test]
    fn room_code_alphabet_excludes_ambiguous_chars() {
        for c in ['0', 'O', '1', 'I'] {
            assert!(
                !ROOM_CODE_ALPHABET.contains(&(c as u8)),
                "alphabet must exclude {c}"
            );
        }
        assert_eq!(ROOM_CODE_ALPHABET.len(), 32);
        for _ in 0..64 {
            let code = generate_room_code();
            assert_eq!(code.len(), ROOM_CODE_LEN);
            assert!(code.bytes().all(|b| ROOM_CODE_ALPHABET.contains(&b)));
            assert_eq!(
                code,
                normalize_room_code(&format!(" {} ", code.to_lowercase()))
            );
        }
    }

    #[test]
    fn chip_mint_allowlist_resolution() {
        // CSV is source of truth, trims + de-dupes, preserves order.
        assert_eq!(
            resolve_chip_mints(" MintA, MintB ,MintA", "ignored"),
            vec!["MintA".to_string(), "MintB".to_string()]
        );
        // Falls back to the single legacy var when the CSV is empty.
        assert_eq!(resolve_chip_mints("", " MintZ "), vec!["MintZ".to_string()]);
        // Nothing configured → empty (create will 500 rather than accept any token).
        assert!(resolve_chip_mints("", "").is_empty());

        let cfg_allows = |mints: Vec<&str>, probe: &str| {
            ServerConfig {
                port: 0,
                database_url: String::new(),
                rpc_url: String::new(),
                program_id: String::new(),
                chips_token_mint: mints.first().map(|s| s.to_string()).unwrap_or_default(),
                chips_token_mints: mints.iter().map(|s| s.to_string()).collect(),
                signed_price_server_url: String::new(),
                admin_tokens: vec![],
                cors_allowed_origins: vec![],
                geofence_blocklist: vec![],
                drand_api: String::new(),
                drand_chain_hash: String::new(),
                node_id: String::new(),
            }
            .is_mint_allowed(probe)
        };
        assert!(cfg_allows(vec!["MintA", "MintB"], "MintB"));
        assert!(!cfg_allows(vec!["MintA", "MintB"], "MintC"));
        assert!(!cfg_allows(vec![], "MintA"));
    }

    #[test]
    fn blinds_derivation_matches_config_service() {
        assert_eq!(derive_blinds(10_000_000), (50_000, 100_000));
        assert_eq!(derive_blinds(1_000_000), (5_000, 10_000));
        // Floors: tiny buy-ins clamp to (1, 2).
        assert_eq!(derive_blinds(1), (1, 2));
        assert_eq!(derive_blinds(250), (1, 2));
    }

    #[test]
    fn overlay_rejects_short_seal_window() {
        let mut overlay = Overlay::default();
        overlay.seal_window_sec = MIN_SAFE_SEAL_WINDOW_SEC - 1;
        assert!(validate_overlay(&overlay).is_err());

        overlay.seal_window_sec = MIN_SAFE_SEAL_WINDOW_SEC;
        assert!(validate_overlay(&overlay).is_ok());
    }

    #[test]
    fn timelock_target_publishes_strictly_after_end_within_skew() {
        for end in [
            DRAND_GENESIS_TIME + 1000,
            DRAND_GENESIS_TIME + 1001,
            DRAND_GENESIS_TIME + 1002,
        ] {
            let r = timelock_target_round(end);
            let ts = drand_round_publish_ts(r).unwrap();
            assert!(ts > end, "must publish strictly after latest_match_end");
            assert!(ts <= end + MAX_TIMELOCK_SKEW_SEC);
            assert!(timelock_target_valid(r, end));
            assert!(!timelock_target_valid(r.saturating_sub(1), end));
        }
        let _ = DRAND_PERIOD_SEC;
    }
}
