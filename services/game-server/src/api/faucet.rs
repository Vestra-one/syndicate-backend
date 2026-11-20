//! Test-chips faucet (devnet only). A visitor needs chips for a buy-in and a little SOL for
//! fees before they can sit down; this hands both out from a dedicated, low-value faucet
//! wallet so the first hand is one click away.
//!
//! Enabled only when `FAUCET_KEYPAIR_PATH` is set. Never configure it where chips have value.
//!   FAUCET_KEYPAIR_PATH   keypair of the faucet wallet (holds chips + SOL)
//!   FAUCET_CHIPS          chips per grant, base units (default 100_000_000 = 100 chips)
//!   FAUCET_LAMPORTS       SOL top-up per grant when the wallet is low (default 20_000_000)
//!   FAUCET_COOLDOWN_SEC   per-wallet cooldown (default 3600)

use std::collections::HashMap;
use std::str::FromStr;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use axum::extract::State;
use axum::http::HeaderMap;
use axum::Json;
use serde_json::{json, Value};
use solana_client::nonblocking::rpc_client::RpcClient;
use solana_sdk::instruction::{AccountMeta, Instruction};
use solana_sdk::pubkey::Pubkey;
use solana_sdk::signature::{read_keypair_file, Keypair, Signer};
use solana_sdk::transaction::Transaction;

use crate::app::AppState;
use crate::auth::session::require_session;
use crate::error::ApiError;

const ATA_PROGRAM: Pubkey = solana_sdk::pubkey!("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const TOKEN_PROGRAM: Pubkey = syndicate_chain::ix::TOKEN_PROGRAM_ID;
const SYSTEM_PROGRAM: Pubkey = solana_sdk::pubkey!("11111111111111111111111111111111");

struct Faucet {
    keypair: Keypair,
    chips: u64,
    lamports: u64,
    cooldown: Duration,
    last_grant: Mutex<HashMap<String, Instant>>,
}

fn env_u64(name: &str, default: u64) -> u64 {
    std::env::var(name)
        .ok()
        .and_then(|v| v.trim().parse().ok())
        .unwrap_or(default)
}

fn faucet() -> Option<&'static Faucet> {
    static FAUCET: OnceLock<Option<Faucet>> = OnceLock::new();
    FAUCET
        .get_or_init(|| {
            let path = std::env::var("FAUCET_KEYPAIR_PATH").ok()?;
            if path.trim().is_empty() {
                return None;
            }
            let keypair = match read_keypair_file(path.trim()) {
                Ok(k) => k,
                Err(e) => {
                    tracing::warn!("faucet disabled: cannot read FAUCET_KEYPAIR_PATH: {e}");
                    return None;
                }
            };
            Some(Faucet {
                keypair,
                chips: env_u64("FAUCET_CHIPS", 100_000_000),
                lamports: env_u64("FAUCET_LAMPORTS", 20_000_000),
                cooldown: Duration::from_secs(env_u64("FAUCET_COOLDOWN_SEC", 3600)),
                last_grant: Mutex::new(HashMap::new()),
            })
        })
        .as_ref()
}

/// What `/v1/config` publishes so the client knows whether to offer the button.
pub fn public_info() -> Value {
    match faucet() {
        Some(f) => json!({ "chips": f.chips, "cooldown_sec": f.cooldown.as_secs() }),
        None => Value::Null,
    }
}

fn ata(mint: &Pubkey, owner: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(
        &[owner.as_ref(), TOKEN_PROGRAM.as_ref(), mint.as_ref()],
        &ATA_PROGRAM,
    )
    .0
}

/// `POST /v1/faucet` — send the signed-in wallet test chips (and a little SOL if it is low).
pub async fn post_faucet(
    State(st): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let wallet = require_session(&st, &headers).await?;
    let f = faucet()
        .ok_or_else(|| ApiError::forbidden("faucet_off", "no faucet on this deployment"))?;
    let to = Pubkey::from_str(&wallet).map_err(|_| ApiError::bad_request("bad wallet"))?;
    let mint = Pubkey::from_str(&st.cfg.chips_token_mint)
        .map_err(|_| ApiError::internal("chips mint not configured"))?;

    // Reserve the slot before sending, so a double click cannot draw twice.
    let cooling = {
        let mut seen = f.last_grant.lock().unwrap();
        let left = seen
            .get(&wallet)
            .map(|at| f.cooldown.saturating_sub(at.elapsed()))
            .filter(|left| !left.is_zero());
        if left.is_none() {
            seen.insert(wallet.clone(), Instant::now());
        }
        left
    };
    if let Some(left) = cooling {
        // Chips are on cooldown, but a wallet that cannot pay a network fee cannot play at
        // all: keep the fee money topped up regardless. No chips move here.
        if let Some(lamports) = top_up_fees(f, &st.cfg.rpc_url, &to).await {
            return Ok(Json(json!({ "ok": true, "chips": 0, "lamports": lamports })));
        }
        return Err(ApiError::too_many(format!(
            "chips already sent — try again in {} min",
            left.as_secs() / 60 + 1
        )));
    }

    let result = send(f, &st.cfg.rpc_url, &mint, &to).await;
    if result.is_err() {
        f.last_grant.lock().unwrap().remove(&wallet);
    }
    let (signature, lamports) = result?;
    Ok(Json(json!({
        "ok": true,
        "chips": f.chips,
        "lamports": lamports,
        "signature": signature,
    })))
}

/// `POST /v1/faucet/fees` — fee money only, no chips and no cooldown: called by the app
/// before a table is dealt or joined, so a test player is never stopped by an empty fee
/// wallet. A wallet that already has enough gets nothing.
pub async fn post_fees(
    State(st): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let wallet = require_session(&st, &headers).await?;
    let f = faucet()
        .ok_or_else(|| ApiError::forbidden("faucet_off", "no faucet on this deployment"))?;
    let to = Pubkey::from_str(&wallet).map_err(|_| ApiError::bad_request("bad wallet"))?;
    let lamports = top_up_fees(f, &st.cfg.rpc_url, &to).await.unwrap_or(0);
    Ok(Json(json!({ "ok": true, "lamports": lamports })))
}

/// Fee money only: bring a wallet that has run low back up to twice the grant. Returns the
/// lamports sent, or None when the wallet has enough (or the transfer failed).
async fn top_up_fees(f: &Faucet, rpc_url: &str, to: &Pubkey) -> Option<u64> {
    let rpc = RpcClient::new_with_commitment(
        rpc_url.to_string(),
        solana_sdk::commitment_config::CommitmentConfig::confirmed(),
    );
    let balance = rpc.get_balance(to).await.ok()?;
    if balance >= f.lamports {
        return None;
    }
    let lamports = (f.lamports * 2).saturating_sub(balance);
    let from = f.keypair.pubkey();
    let ix = solana_sdk::system_instruction::transfer(&from, to, lamports);
    let blockhash = rpc.get_latest_blockhash().await.ok()?;
    let tx = Transaction::new_signed_with_payer(&[ix], Some(&from), &[&f.keypair], blockhash);
    rpc.send_and_confirm_transaction(&tx).await.ok()?;
    Some(lamports)
}

async fn send(
    f: &Faucet,
    rpc_url: &str,
    mint: &Pubkey,
    to: &Pubkey,
) -> Result<(String, u64), ApiError> {
    // `confirmed` lands in a second or two; the default (finalized) would outlast the client.
    let rpc = RpcClient::new_with_commitment(
        rpc_url.to_string(),
        solana_sdk::commitment_config::CommitmentConfig::confirmed(),
    );
    let from = f.keypair.pubkey();
    let to_ata = ata(mint, to);

    let mut ixs = vec![
        // Create the visitor's chip account if it does not exist yet (idempotent).
        Instruction {
            program_id: ATA_PROGRAM,
            accounts: vec![
                AccountMeta::new(from, true),
                AccountMeta::new(to_ata, false),
                AccountMeta::new_readonly(*to, false),
                AccountMeta::new_readonly(*mint, false),
                AccountMeta::new_readonly(SYSTEM_PROGRAM, false),
                AccountMeta::new_readonly(TOKEN_PROGRAM, false),
            ],
            data: vec![1],
        },
        // SPL Token `Transfer`.
        Instruction {
            program_id: TOKEN_PROGRAM,
            accounts: vec![
                AccountMeta::new(ata(mint, &from), false),
                AccountMeta::new(to_ata, false),
                AccountMeta::new_readonly(from, true),
            ],
            data: [vec![3u8], f.chips.to_le_bytes().to_vec()].concat(),
        },
    ];
    // Fees: top the wallet up only when it could not pay for a few transactions itself.
    let balance = rpc.get_balance(to).await.unwrap_or(0);
    let lamports = if balance < f.lamports { (f.lamports * 2).saturating_sub(balance) } else { 0 };
    if lamports > 0 {
        ixs.push(solana_sdk::system_instruction::transfer(
            &from, to, lamports,
        ));
    }

    let blockhash = rpc
        .get_latest_blockhash()
        .await
        .map_err(|e| ApiError::internal(format!("faucet rpc: {e}")))?;
    let tx = Transaction::new_signed_with_payer(&ixs, Some(&from), &[&f.keypair], blockhash);
    let signature = rpc
        .send_and_confirm_transaction(&tx)
        .await
        .map_err(|e| ApiError::internal(format!("faucet transfer failed: {e}")))?;
    Ok((signature.to_string(), lamports))
}
