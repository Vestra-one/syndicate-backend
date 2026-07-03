//! Deposit/create verification pool: polls `seat_candidates(status='reported')`,
//! RPC-verifies each txhash at finalized commitment behind the `ChainVerify` trait
//! (mockable in tests), FCFS-promotes, and pokes the match actor.

use std::sync::Arc;

use async_trait::async_trait;
use solana_client::nonblocking::rpc_client::RpcClient;
use solana_sdk::pubkey::Pubkey;
use solana_sdk::signature::Signature;
use tracing::{info, warn};
use uuid::Uuid;

use syndicate_chain::verify as chain_verify;

use crate::app::AppState;
use crate::db;
use crate::runtime::Cmd;
use crate::util::now_ms;

pub struct VerifiedDeposit {
    pub slot: u64,
    pub join_commitment: [u8; 32],
    /// The chip mint the creator chose (create_and_deposit only). `None` for joiner
    /// deposits — they inherit the match mint on-chain, so there is nothing to re-check.
    pub mint: Option<Pubkey>,
}

/// The RPC boundary, mockable for tests.
#[async_trait]
pub trait ChainVerify: Send + Sync {
    async fn verify_deposit(
        &self,
        tx_sig: &str,
        match_pda: &Pubkey,
        wallet: &Pubkey,
    ) -> Result<VerifiedDeposit, String>;
    async fn verify_create(
        &self,
        tx_sig: &str,
        onchain_match_id: u64,
        wallet: &Pubkey,
    ) -> Result<VerifiedDeposit, String>;
    /// Read a seat account's seal commitment state (for seal cross-checks).
    async fn seat_commitment(
        &self,
        match_pda: &Pubkey,
        wallet: &Pubkey,
    ) -> Result<Option<[u8; 32]>, String>;
}

pub struct RpcVerifier {
    pub rpc: RpcClient,
    pub program_id: Pubkey,
}

#[async_trait]
impl ChainVerify for RpcVerifier {
    async fn verify_deposit(
        &self,
        tx_sig: &str,
        match_pda: &Pubkey,
        wallet: &Pubkey,
    ) -> Result<VerifiedDeposit, String> {
        let sig: Signature = tx_sig.parse().map_err(|e| format!("bad signature: {e}"))?;
        chain_verify::verify_deposit_tx(&self.rpc, &self.program_id, &sig, match_pda, wallet)
            .await
            .map(|v| VerifiedDeposit {
                slot: v.slot,
                join_commitment: v.join_commitment,
                mint: None,
            })
            .map_err(|e| e.to_string())
    }

    async fn verify_create(
        &self,
        tx_sig: &str,
        onchain_match_id: u64,
        wallet: &Pubkey,
    ) -> Result<VerifiedDeposit, String> {
        let sig: Signature = tx_sig.parse().map_err(|e| format!("bad signature: {e}"))?;
        chain_verify::verify_create_tx(&self.rpc, &self.program_id, &sig, onchain_match_id, wallet)
            .await
            .map(|v| VerifiedDeposit {
                slot: v.slot,
                join_commitment: v.params.room_commitment,
                mint: Some(v.mint),
            })
            .map_err(|e| e.to_string())
    }

    async fn seat_commitment(
        &self,
        match_pda: &Pubkey,
        wallet: &Pubkey,
    ) -> Result<Option<[u8; 32]>, String> {
        let (seat, _) = syndicate_chain::pda::seat(&self.program_id, match_pda, wallet);
        let account = self
            .rpc
            .get_account_with_commitment(
                &seat,
                solana_sdk::commitment_config::CommitmentConfig::finalized(),
            )
            .await
            .map_err(|e| e.to_string())?;
        Ok(account.value.and_then(|a| {
            syndicate_chain::accounts::decode_seat(&a.data)
                .ok()
                .filter(|s| s.commitment_set)
                .map(|s| s.prediction_commitment)
        }))
    }
}

/// "Verification is transient" errors keep the candidate `reported` for a retry; hard
/// mismatches reject it. Heuristic: finality/rpc errors are transient.
fn is_transient(err: &str) -> bool {
    err.contains("NotFinalized") || err.contains("NotFound") || err.contains("Rpc")
}

/// The verifier loop: poll reported candidates, verify, promote, poke actors.
pub async fn run(st: AppState) {
    loop {
        if let Err(e) = tick(&st).await {
            warn!("verifier tick: {e}");
        }
        tokio::time::sleep(std::time::Duration::from_millis(1_500)).await;
    }
}

async fn tick(st: &AppState) -> Result<(), crate::error::ApiError> {
    let client = st.pool.get().await?;
    // Age gate: give the tx a moment to finalize before the first RPC roundtrip.
    let rows = client
        .query(
            r#"
            SELECT sc.id, sc.match_id, sc.wallet, sc.tx_sig, sc.reported_at,
                   m.onchain_match_id, m.visibility, m.room_code, m.buy_in_chips,
                   m.creator_wallet, m.status::text AS match_status, m.max_players, m.mint
            FROM seat_candidates sc
            JOIN matches m ON m.id = sc.match_id
            WHERE sc.status = 'reported'
            ORDER BY sc.reported_at ASC
            LIMIT 16
            "#,
            &[],
        )
        .await?;
    drop(client);

    for row in rows {
        let candidate_id: Uuid = row.get("id");
        let match_id: Uuid = row.get("match_id");
        let wallet_str: String = row.get("wallet");
        let tx_sig: String = row.get("tx_sig");
        let onchain: i64 = row.get("onchain_match_id");
        let visibility: String = row.get("visibility");
        let room_code: Option<String> = row.get("room_code");
        let creator: Option<String> = row.get("creator_wallet");
        let match_status: String = row.get("match_status");
        let max_players: i16 = row.get::<_, Option<i16>>("max_players").unwrap_or(5);
        let match_mint: Option<String> = row.get("mint");

        let Ok(wallet) = wallet_str.parse::<Pubkey>() else {
            reject(st, candidate_id, "bad wallet").await;
            continue;
        };
        let (match_pda, _) = syndicate_chain::pda::match_account(&st.program_id, onchain as u64);

        let is_creator = creator.as_deref() == Some(wallet_str.as_str());
        let verified = if is_creator {
            st.verify
                .verify_create(&tx_sig, onchain as u64, &wallet)
                .await
        } else {
            st.verify.verify_deposit(&tx_sig, &match_pda, &wallet).await
        };

        match verified {
            Ok(v) => {
                // Chip-token allowlist. The mint is chosen at create_and_deposit; joiners
                // inherit it on-chain (player_token.mint == match.mint), so enforcing it on
                // the creator's tx is sufficient. Reject a match whose token is not allowed,
                // or whose on-chain mint disagrees with the mint the intent advertised.
                if is_creator {
                    let Some(mint) = v.mint else {
                        reject(st, candidate_id, "create tx missing chip mint").await;
                        continue;
                    };
                    let mint_str = mint.to_string();
                    if !st.cfg.is_mint_allowed(&mint_str) {
                        reject(st, candidate_id, &format!("chip token not allowed: {mint_str}"))
                            .await;
                        continue;
                    }
                    if let Some(intended) = &match_mint {
                        if intended != &mint_str {
                            reject(
                                st,
                                candidate_id,
                                &format!("chip mint mismatch: intent {intended}, tx {mint_str}"),
                            )
                            .await;
                            continue;
                        }
                    } else if let Ok(client) = st.pool.get().await {
                        // Backfill the match mint if the intent didn't set it.
                        let _ = client
                            .execute(
                                "UPDATE matches SET mint = $2 WHERE id = $1 AND mint IS NULL",
                                &[&match_id, &mint_str],
                            )
                            .await;
                    }
                }
                // Private rooms: the tx's commitment must equal sha256(code ‖ wallet).
                let room_ok = if visibility == "private" {
                    match &room_code {
                        Some(code) => {
                            v.join_commitment == syndicate_chain::room_commitment(code, &wallet)
                        }
                        None => false,
                    }
                } else {
                    v.join_commitment == [0u8; 32]
                };
                if !room_ok {
                    reject(st, candidate_id, "room commitment mismatch").await;
                    continue;
                }
                let client = match st.pool.get().await {
                    Ok(c) => c,
                    Err(_) => continue,
                };
                let _ = client
                    .execute(
                        r#"UPDATE seat_candidates
                           SET status = 'candidate', finalized_slot = $2, room_code_ok = $3,
                               verified_at = now()
                           WHERE id = $1"#,
                        &[&candidate_id, &(v.slot as i64), &room_ok],
                    )
                    .await;
                // FCFS-promote (idempotent) while still filling, then poke the actor.
                if match_status == "filling" {
                    let _ = client
                        .execute(db::FCFS_PROMOTE_SQL, &[&match_id, &(max_players as i64)])
                        .await;
                }
                drop(client);
                info!(%match_id, wallet = %wallet_str, slot = v.slot, "candidate verified");
                let _ = st.registry.send(&match_id, Cmd::CandidatesChanged).await;
            }
            Err(e) if is_transient(&e) => {
                // Leave `reported`; the age-ordered poll retries. Give up after 10 min.
                let reported: chrono::DateTime<chrono::Utc> = row.get("reported_at");
                if now_ms().saturating_sub(crate::util::ts_ms(reported)) > 600_000 {
                    reject(st, candidate_id, &format!("verification timeout: {e}")).await;
                }
            }
            Err(e) => reject(st, candidate_id, &e).await,
        }
    }
    Ok(())
}

async fn reject(st: &AppState, candidate_id: Uuid, reason: &str) {
    if let Ok(client) = st.pool.get().await {
        let _ = client
            .execute(
                "UPDATE seat_candidates SET status = 'rejected', reject_reason = $2, verified_at = now() WHERE id = $1",
                &[&candidate_id, &reason],
            )
            .await;
    }
}

/// Build the production verifier.
pub fn rpc_verifier(rpc_url: &str, program_id: Pubkey) -> Arc<dyn ChainVerify> {
    Arc::new(RpcVerifier {
        rpc: RpcClient::new(rpc_url.to_string()),
        program_id,
    })
}
