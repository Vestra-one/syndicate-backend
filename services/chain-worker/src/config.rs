//! Environment configuration (matches `deploy/docker-compose.yml`'s chain-worker env).

use solana_sdk::pubkey::Pubkey;

#[derive(Clone, Debug)]
pub struct WorkerConfig {
    pub app_env: String,
    pub database_url: String,
    pub rpc_primary: String,
    pub rpc_secondary: Option<String>,
    pub program_id: Pubkey,
    pub chips_token_mint: Option<Pubkey>,
    pub treasury_token_account: Option<Pubkey>,
    pub operator_keypair_path: String,
    pub signed_price_server_url: String,
    pub poll_ms: u64,
    pub confirmation_timeout_ms: u64,
    pub cu_price_micro_lamports: u64,
    pub min_signer_lamports: u64,
    pub drand_api: String,
    pub drand_chain_hash: String,
    pub timelock_grace_sec: u64,
    pub port: u16,
    /// Max jobs claimed per poll cycle.
    pub claim_batch: i64,
}

impl WorkerConfig {
    pub fn from_env() -> Result<Self, String> {
        let database_url = required("DATABASE_URL")?;
        let database_url = match std::env::var("DATABASE_PASSWORD_FILE") {
            Ok(path) if !path.trim().is_empty() => {
                let pass = std::fs::read_to_string(&path)
                    .map_err(|e| format!("read DATABASE_PASSWORD_FILE {path}: {e}"))?;
                inject_password(&database_url, pass.trim())?
            }
            _ => database_url,
        };
        let program_id = required("SYNDICATE_PROGRAM_ID")?
            .parse()
            .map_err(|e| format!("SYNDICATE_PROGRAM_ID: {e}"))?;
        Ok(Self {
            app_env: std::env::var("APP_ENV").unwrap_or_else(|_| "devnet".into()),
            database_url,
            rpc_primary: required("SOLANA_RPC_URL_PRIMARY")?,
            rpc_secondary: optional("SOLANA_RPC_URL_SECONDARY"),
            program_id,
            chips_token_mint: parse_optional_pubkey("CHIPS_TOKEN_MINT")?,
            treasury_token_account: parse_optional_pubkey("TREASURY_TOKEN_ACCOUNT")?,
            operator_keypair_path: required("OPERATOR_KEYPAIR_PATH")?,
            signed_price_server_url: std::env::var("SIGNED_PRICE_SERVER_URL")
                .unwrap_or_else(|_| "http://127.0.0.1:8080".into()),
            poll_ms: env_u64("CHAIN_JOBS_POLL_MS", 1_000),
            confirmation_timeout_ms: env_u64("SETTLEMENT_CONFIRMATION_TIMEOUT_MS", 60_000),
            cu_price_micro_lamports: env_u64("SETTLEMENT_CU_PRICE_MICRO_LAMPORTS", 100_000),
            min_signer_lamports: parse_sol_to_lamports(
                &std::env::var("MIN_SIGNER_SOL").unwrap_or_else(|_| "0.5".into()),
            )?,
            drand_api: std::env::var("DRAND_API").unwrap_or_else(|_| "https://api.drand.sh".into()),
            drand_chain_hash: std::env::var("DRAND_CHAIN_HASH").unwrap_or_else(|_| {
                "52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971".into()
            }),
            timelock_grace_sec: env_u64("TIMELOCK_GRACE_SEC", 300),
            port: env_u64("CHAIN_WORKER_PORT", 8_084) as u16,
            claim_batch: env_u64("CHAIN_JOBS_CLAIM_BATCH", 8) as i64,
        })
    }

    pub fn is_mainnet(&self) -> bool {
        self.app_env == "mainnet" || self.app_env == "mainnet-beta"
    }
}

fn required(name: &str) -> Result<String, String> {
    std::env::var(name)
        .ok()
        .filter(|v| !v.trim().is_empty())
        .ok_or_else(|| format!("missing required environment variable: {name}"))
}

fn optional(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|v| !v.trim().is_empty())
}

fn parse_optional_pubkey(name: &str) -> Result<Option<Pubkey>, String> {
    match optional(name) {
        Some(v) => v
            .parse()
            .map(Some)
            .map_err(|e| format!("{name} is not a valid pubkey: {e}")),
        None => Ok(None),
    }
}

fn env_u64(name: &str, fallback: u64) -> u64 {
    std::env::var(name)
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(fallback)
}

/// Insert a password into a `postgres://user@host/...` URL that lacks one. If the URL
/// already carries a password it is left untouched.
pub fn inject_password(url: &str, password: &str) -> Result<String, String> {
    let scheme_end = url
        .find("://")
        .ok_or_else(|| "DATABASE_URL missing scheme".to_string())?
        + 3;
    let rest = &url[scheme_end..];
    let Some(at) = rest.find('@') else {
        return Ok(url.to_string()); // no userinfo — nothing to inject into
    };
    let userinfo = &rest[..at];
    if userinfo.contains(':') {
        return Ok(url.to_string()); // password already present
    }
    let encoded: String = password
        .bytes()
        .flat_map(|b| {
            // percent-encode reserved userinfo bytes
            if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'.' | b'_' | b'~') {
                vec![b as char]
            } else {
                format!("%{b:02X}").chars().collect()
            }
        })
        .collect();
    Ok(format!(
        "{}{}:{}@{}",
        &url[..scheme_end],
        userinfo,
        encoded,
        &rest[at + 1..]
    ))
}

/// Parse a decimal SOL amount ("0.5", "2") into lamports without floating point.
pub fn parse_sol_to_lamports(value: &str) -> Result<u64, String> {
    let v = value.trim();
    let (whole, frac) = match v.split_once('.') {
        Some((w, f)) => (w, f),
        None => (v, ""),
    };
    let whole: u64 = if whole.is_empty() {
        0
    } else {
        whole
            .parse()
            .map_err(|e| format!("MIN_SIGNER_SOL whole part: {e}"))?
    };
    if frac.len() > 9 || frac.chars().any(|c| !c.is_ascii_digit()) {
        return Err("MIN_SIGNER_SOL fraction must be <= 9 decimal digits".into());
    }
    let mut frac_lamports: u64 = 0;
    if !frac.is_empty() {
        let parsed: u64 = frac
            .parse()
            .map_err(|e| format!("MIN_SIGNER_SOL fraction: {e}"))?;
        frac_lamports = parsed * 10u64.pow(9 - frac.len() as u32);
    }
    whole
        .checked_mul(1_000_000_000)
        .and_then(|w| w.checked_add(frac_lamports))
        .ok_or_else(|| "MIN_SIGNER_SOL overflows lamports".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sol_to_lamports_is_integer_math() {
        assert_eq!(parse_sol_to_lamports("0.5").unwrap(), 500_000_000);
        assert_eq!(parse_sol_to_lamports("2").unwrap(), 2_000_000_000);
        assert_eq!(parse_sol_to_lamports("0.000000001").unwrap(), 1);
        assert_eq!(parse_sol_to_lamports("1.25").unwrap(), 1_250_000_000);
        assert!(parse_sol_to_lamports("0.0000000001").is_err());
        assert!(parse_sol_to_lamports("abc").is_err());
    }

    #[test]
    fn password_injection() {
        assert_eq!(
            inject_password("postgres://syndicate@db:5432/syndicate", "s3cr3t").unwrap(),
            "postgres://syndicate:s3cr3t@db:5432/syndicate"
        );
        // Already has a password — untouched.
        assert_eq!(
            inject_password("postgres://u:p@h/db", "x").unwrap(),
            "postgres://u:p@h/db"
        );
        // No userinfo — untouched.
        assert_eq!(
            inject_password("postgres://host/db", "x").unwrap(),
            "postgres://host/db"
        );
        // Reserved characters get percent-encoded.
        assert_eq!(
            inject_password("postgres://u@h/db", "p@ss/w:rd").unwrap(),
            "postgres://u:p%40ss%2Fw%3Ard@h/db"
        );
    }
}
