//! Job executor: pre-read the match account, build the instruction, sign/simulate/
//! submit/confirm, and drive the job row through its state machine.

use std::str::FromStr;
use std::sync::Arc;

use deadpool_postgres::Pool;
use serde_json::Value;
use solana_sdk::compute_budget::ComputeBudgetInstruction;
use solana_sdk::instruction::Instruction;
use solana_sdk::pubkey::Pubkey;
use solana_sdk::signature::{Keypair, Signature, Signer};
use solana_sdk::transaction::Transaction;
use tracing::{info, warn};

use syndicate_chain::accounts::{
    decode_match, MatchAccountData, STATUS_FILLING, STATUS_LIVE, STATUS_SEALING, STATUS_SETTLED,
    STATUS_VOID,
};
use syndicate_chain::{ix, pda};

use crate::config::WorkerConfig;
use crate::db::{self, ChainJob, JobKind};
use crate::metrics::WorkerMetrics;
use crate::oracle::SignedPriceClient;
use crate::retry;
use crate::rpc::{ChainRpc, SigStatus};
use crate::settlement::{prepare_settlement, SettleDeps, SettleOutcome};
use crate::timelock_open::TimelockOpenClient;

pub struct Executor {
    pub cfg: WorkerConfig,
    pub pool: Pool,
    pub rpc: Arc<dyn ChainRpc>,
    pub keypair: Arc<Keypair>,
    pub metrics: Arc<WorkerMetrics>,
    pub oracle: SignedPriceClient,
    pub timelock: tokio::sync::Mutex<Box<dyn TimelockOpenClient>>,
}

/// What happened to a claimed job (drives the DB mark + metrics).
enum StepResult {
    Confirmed(Option<String>),
    Skipped(String),
    Retry {
        error: String,
        tx_sig: Option<String>,
    },
    Wait {
        delay_ms: u64,
        reason: String,
    },
    DeadLetter {
        error: String,
        audit: Option<Value>,
    },
}

impl Executor {
    pub async fn execute(&self, job: ChainJob) {
        let result = self.run_job(&job).await;
        let mark = match result {
            StepResult::Confirmed(sig) => {
                self.metrics.inc_confirmed(job.kind);
                db::mark_confirmed(&self.pool, job.id, sig.as_deref()).await
            }
            StepResult::Skipped(reason) => {
                self.metrics.inc_skipped(job.kind);
                info!(job_id = %job.id, match_id = %job.match_id, kind = job.kind.as_str(), %reason, "job skipped");
                db::mark_skipped(&self.pool, job.id, &reason).await
            }
            StepResult::Wait { delay_ms, reason } => {
                db::mark_wait(&self.pool, job.id, delay_ms, &reason).await
            }
            StepResult::Retry { error, tx_sig } => {
                let attempt = job.attempt_count as u32 + 1;
                warn!(job_id = %job.id, match_id = %job.match_id, kind = job.kind.as_str(),
                      attempt, %error, "job attempt failed");
                if let Some(max) = retry::max_attempts(job.kind) {
                    if attempt >= max {
                        self.metrics.inc_dead_letter();
                        db::mark_dead_letter(
                            &self.pool,
                            job.id,
                            &format!("attempts exhausted ({attempt}): {error}"),
                            None,
                        )
                        .await
                    } else {
                        self.metrics.inc_retry();
                        db::mark_retry(
                            &self.pool,
                            job.id,
                            retry::retry_delay_ms(job.kind, attempt),
                            &error,
                            tx_sig.as_deref(),
                        )
                        .await
                    }
                } else {
                    self.metrics.inc_retry();
                    db::mark_retry(
                        &self.pool,
                        job.id,
                        retry::retry_delay_ms(job.kind, attempt),
                        &error,
                        tx_sig.as_deref(),
                    )
                    .await
                }
            }
            StepResult::DeadLetter { error, audit } => {
                self.metrics.inc_dead_letter();
                warn!(job_id = %job.id, match_id = %job.match_id, kind = job.kind.as_str(),
                      %error, "job dead-lettered");
                db::mark_dead_letter(&self.pool, job.id, &error, audit.as_ref()).await
            }
        };
        if let Err(e) = mark {
            warn!(job_id = %job.id, "failed to mark job: {e}");
        }
    }

    async fn run_job(&self, job: &ChainJob) -> StepResult {
        // Crash recovery: a previously-submitted signature settles the job's fate first.
        if let Some(sig_str) = &job.tx_signature {
            if let Ok(sig) = Signature::from_str(sig_str) {
                match self.rpc.signature_status(&sig).await {
                    Ok(SigStatus::Confirmed) => {
                        return StepResult::Confirmed(Some(sig_str.clone()))
                    }
                    Ok(SigStatus::Processed) => {
                        return StepResult::Wait {
                            delay_ms: 2_000,
                            reason: "prior submission still confirming".into(),
                        }
                    }
                    Ok(SigStatus::Failed(_)) | Ok(SigStatus::NotFound) => {} // rebuild below
                    Err(e) => {
                        return StepResult::Retry {
                            error: format!("status check: {e}"),
                            tx_sig: Some(sig_str.clone()),
                        }
                    }
                }
            }
        }

        // Pre-read the match account (idempotence gate).
        let onchain_match_id = match self.onchain_match_id(job).await {
            Ok(v) => v,
            Err(step) => return step,
        };
        let (match_key, _) = pda::match_account(&self.cfg.program_id, onchain_match_id);
        let account = match self.rpc.get_account_data(&match_key).await {
            Ok(Some(data)) => match decode_match(&data) {
                Ok(m) => m,
                Err(e) => {
                    return StepResult::DeadLetter {
                        error: format!("match account decode: {e}"),
                        audit: None,
                    }
                }
            },
            Ok(None) => {
                return StepResult::Retry {
                    error: "match account not found on chain".into(),
                    tx_sig: None,
                }
            }
            Err(e) => {
                return StepResult::Retry {
                    error: e.to_string(),
                    tx_sig: None,
                }
            }
        };

        if let Some(skip) = self.idempotence_gate(job.kind, &account) {
            return skip;
        }

        // Build the instruction (settlement runs its full pipeline).
        let (instruction, oracle_audit) =
            match self.build_instruction(job, &match_key, &account).await {
                Ok(v) => v,
                Err(step) => return step,
            };

        self.sign_submit_confirm(job, instruction, oracle_audit)
            .await
    }

    async fn onchain_match_id(&self, job: &ChainJob) -> Result<u64, StepResult> {
        match db::load_match_row(&self.pool, job.match_id).await {
            Ok(Some(row)) => Ok(row.onchain_match_id),
            Ok(None) => Err(StepResult::DeadLetter {
                error: "match missing from DB".into(),
                audit: None,
            }),
            Err(e) => Err(StepResult::Retry {
                error: e.to_string(),
                tx_sig: None,
            }),
        }
    }

    /// None = proceed; Some(step) = the chain already moved past this job.
    fn idempotence_gate(&self, kind: JobKind, m: &MatchAccountData) -> Option<StepResult> {
        let status = m.status;
        let skip = |reason: &str| Some(StepResult::Skipped(reason.to_string()));
        match kind {
            JobKind::Lock => (status != STATUS_FILLING)
                .then(|| StepResult::Skipped(format!("status {status} != Filling"))),
            JobKind::BeginLive => match status {
                STATUS_SEALING => None,
                STATUS_LIVE | STATUS_SETTLED => skip("already live/settled"),
                _ => skip("match voided or not sealed"),
            },
            JobKind::SubmitSettlement => match status {
                STATUS_LIVE => None,
                STATUS_SETTLED => skip("already settled"),
                STATUS_VOID => skip("match voided"),
                _ => Some(StepResult::Wait {
                    delay_ms: 2_000,
                    reason: format!("status {status} not Live yet"),
                }),
            },
            JobKind::VoidBeforeStart => match status {
                STATUS_FILLING | STATUS_SEALING => None,
                _ => skip("past pre-start voidability"),
            },
            JobKind::VoidLiveAfterDeadline => match status {
                STATUS_LIVE => None,
                _ => skip("not live (settled or already voided)"),
            },
            JobKind::Void => match status {
                STATUS_SETTLED | STATUS_VOID => skip("already terminal"),
                _ => None,
            },
            JobKind::WithdrawFees => {
                if status != STATUS_SETTLED {
                    Some(StepResult::Wait {
                        delay_ms: 5_000,
                        reason: "not settled yet".into(),
                    })
                } else if m.fees_withdrawn {
                    skip("fees already withdrawn")
                } else {
                    None
                }
            }
        }
    }

    async fn build_instruction(
        &self,
        job: &ChainJob,
        match_key: &Pubkey,
        account: &MatchAccountData,
    ) -> Result<(Instruction, Option<Value>), StepResult> {
        let program_id = &self.cfg.program_id;
        let authority = self.keypair.pubkey();
        match job.kind {
            JobKind::Lock => {
                let players = payload_players(&job.payload, "confirmed", "wallet")?;
                Ok((ix::lock(program_id, &authority, match_key, &players), None))
            }
            JobKind::BeginLive => {
                let players = match payload_players(&job.payload, "players", "wallet") {
                    Ok(p) if !p.is_empty() => p,
                    _ => {
                        // Fall back to on-chain enumeration, ordered by engine seat.
                        let mut seats = self
                            .rpc
                            .seat_accounts(program_id, match_key)
                            .await
                            .map_err(|e| StepResult::Retry {
                                error: e.to_string(),
                                tx_sig: None,
                            })?;
                        seats.retain(|(_, s)| s.confirmed);
                        seats.sort_by_key(|(_, s)| s.engine_seat);
                        seats.iter().map(|(_, s)| s.player).collect()
                    }
                };
                if players.len() != account.confirmed_count as usize {
                    return Err(StepResult::Retry {
                        error: format!(
                            "have {} confirmed players, chain says {}",
                            players.len(),
                            account.confirmed_count
                        ),
                        tx_sig: None,
                    });
                }
                Ok((
                    ix::begin_live(program_id, &authority, match_key, &players),
                    None,
                ))
            }
            JobKind::SubmitSettlement => {
                let mut timelock = self.timelock.lock().await;
                let mut deps = SettleDeps {
                    pool: &self.pool,
                    oracle: &self.oracle,
                    timelock: timelock.as_mut(),
                    now_unix: crate::now_unix(),
                };
                let outcome = prepare_settlement(
                    &mut deps,
                    job.match_id,
                    account.price_token,
                    account.scheduled_end_ts,
                    account.confirmed_count,
                    &job.idempotency_key,
                )
                .await;
                drop(timelock);
                match outcome {
                    SettleOutcome::Ready {
                        args,
                        confirmed_players,
                        oracle_audit,
                    } => Ok((
                        ix::submit_settlement(
                            program_id,
                            &authority,
                            match_key,
                            &confirmed_players,
                            &args,
                        ),
                        Some(oracle_audit),
                    )),
                    SettleOutcome::Wait { delay_ms, reason } => {
                        Err(StepResult::Wait { delay_ms, reason })
                    }
                    SettleOutcome::Void { reason, audit } => {
                        // Enqueue the permissionless live void (gated on-chain at
                        // scheduled_end + 300s) and dead-letter the settle job.
                        let not_before = account.scheduled_end_ts
                            + crate::timelock_open::ONCHAIN_SETTLE_VOID_GRACE_SEC;
                        let key = crate::idempotency_key(
                            &job.match_id.to_string(),
                            JobKind::VoidLiveAfterDeadline,
                        );
                        if let Err(e) =
                            db::enqueue_void_live_job(&self.pool, job.match_id, &key, not_before)
                                .await
                        {
                            return Err(StepResult::Retry {
                                error: format!("enqueue void after {reason}: {e}"),
                                tx_sig: None,
                            });
                        }
                        Err(StepResult::DeadLetter {
                            error: format!("settlement voided: {reason}"),
                            audit: Some(audit),
                        })
                    }
                    SettleOutcome::Fatal { reason, audit } => Err(StepResult::DeadLetter {
                        error: reason,
                        audit: Some(audit),
                    }),
                }
            }
            JobKind::VoidBeforeStart => Ok((ix::void_before_start(program_id, match_key), None)),
            JobKind::VoidLiveAfterDeadline => {
                // The chain gates this at scheduled_end + 300s; don't burn attempts early.
                let gate =
                    account.scheduled_end_ts + crate::timelock_open::ONCHAIN_SETTLE_VOID_GRACE_SEC;
                let now = crate::now_unix();
                if now < gate {
                    return Err(StepResult::Wait {
                        delay_ms: (gate - now).saturating_mul(1_000).clamp(1_000, 60_000),
                        reason: format!("void gate opens at {gate}"),
                    });
                }
                Ok((ix::void_live_after_deadline(program_id, match_key), None))
            }
            JobKind::Void => Ok((ix::void(program_id, &authority, match_key), None)),
            JobKind::WithdrawFees => {
                let treasury = job
                    .payload
                    .get("treasury_token")
                    .and_then(Value::as_str)
                    .map(Pubkey::from_str)
                    .transpose()
                    .map_err(|e| StepResult::DeadLetter {
                        error: format!("bad treasury_token: {e}"),
                        audit: None,
                    })?
                    .or(self.cfg.treasury_token_account)
                    .ok_or_else(|| StepResult::DeadLetter {
                        error: "no treasury token account configured".into(),
                        audit: None,
                    })?;
                let (vault, _) = pda::vault(&self.cfg.program_id, match_key);
                Ok((
                    ix::withdraw_fees(program_id, &authority, match_key, &vault, &treasury),
                    None,
                ))
            }
        }
    }

    async fn sign_submit_confirm(
        &self,
        job: &ChainJob,
        instruction: Instruction,
        oracle_audit: Option<Value>,
    ) -> StepResult {
        // Simulate for the CU limit + early rejection.
        let payer = self.keypair.pubkey();
        let probe = Transaction::new_unsigned(solana_sdk::message::Message::new(
            std::slice::from_ref(&instruction),
            Some(&payer),
        ));
        let simulation = match self.rpc.simulate(&probe).await {
            Ok(s) => s,
            Err(e) => {
                return StepResult::Retry {
                    error: format!("simulate: {e}"),
                    tx_sig: None,
                }
            }
        };
        if let Some(err) = simulation.err {
            return StepResult::Retry {
                error: format!("simulation failed: {err} logs={:?}", simulation.logs.last()),
                tx_sig: None,
            };
        }
        let cu_limit = simulation
            .units_consumed
            .map(|u| ((u as f64 * 1.2) as u32).max(20_000))
            .unwrap_or(200_000);

        let instructions = vec![
            ComputeBudgetInstruction::set_compute_unit_price(self.cfg.cu_price_micro_lamports),
            ComputeBudgetInstruction::set_compute_unit_limit(cu_limit),
            instruction,
        ];

        let blockhash = match self.rpc.latest_blockhash().await {
            Ok(h) => h,
            Err(e) => {
                return StepResult::Retry {
                    error: format!("blockhash: {e}"),
                    tx_sig: None,
                }
            }
        };
        let tx = Transaction::new_signed_with_payer(
            &instructions,
            Some(&payer),
            &[self.keypair.as_ref()],
            blockhash,
        );
        let started = crate::now_ms();
        let sig = match self.rpc.send(&tx).await {
            Ok(s) => s,
            Err(e) => {
                return StepResult::Retry {
                    error: format!("send: {e}"),
                    tx_sig: None,
                }
            }
        };
        if let Err(e) =
            db::mark_submitted(&self.pool, job.id, &sig.to_string(), &blockhash.to_string()).await
        {
            warn!(job_id = %job.id, "mark_submitted failed: {e}");
        }
        // Attach the audit now, before confirmation — a crash between here and the confirm
        // loop below hits the `run_job` crash-recovery early-return (top of this file),
        // which never revisits `build_instruction`/oracle_audit. Attaching at submit time
        // means the audit (and therefore settlement persistence, see chainjobs.rs) is
        // durable even if this process dies mid-confirm. Deterministic per idempotency
        // key, so re-attaching on a later attempt is a safe no-op overwrite.
        if let Some(audit) = &oracle_audit {
            let _ = self.attach_oracle_audit(job.id, audit).await;
        }
        info!(job_id = %job.id, match_id = %job.match_id, kind = job.kind.as_str(),
              tx_sig = %sig, "submitted");

        // Confirm loop.
        let deadline = crate::now_ms() + self.cfg.confirmation_timeout_ms;
        loop {
            tokio::time::sleep(std::time::Duration::from_millis(1_500)).await;
            match self.rpc.signature_status(&sig).await {
                Ok(SigStatus::Confirmed) => {
                    self.metrics
                        .observe_submit_confirm_ms(crate::now_ms() - started);
                    if job.kind == JobKind::BeginLive {
                        self.mirror_begin_live(job, &sig).await;
                    }
                    return StepResult::Confirmed(Some(sig.to_string()));
                }
                Ok(SigStatus::Failed(err)) => {
                    return StepResult::Retry {
                        error: format!("tx failed on chain: {err}"),
                        tx_sig: Some(sig.to_string()),
                    }
                }
                Ok(_) if crate::now_ms() > deadline => {
                    return StepResult::Retry {
                        error: "confirmation timeout".into(),
                        tx_sig: Some(sig.to_string()),
                    }
                }
                Ok(_) => continue,
                Err(e) if crate::now_ms() > deadline => {
                    return StepResult::Retry {
                        error: format!("confirmation timeout: {e}"),
                        tx_sig: Some(sig.to_string()),
                    }
                }
                Err(_) => continue,
            }
        }
    }

    async fn attach_oracle_audit(
        &self,
        job_id: uuid::Uuid,
        audit: &Value,
    ) -> Result<(), db::DbError> {
        let client = self
            .pool
            .get()
            .await
            .map_err(|e| db::DbError(e.to_string()))?;
        client
            .execute(
                "UPDATE chain_jobs SET oracle_audit = $2, updated_at = now() WHERE id = $1",
                &[&job_id, &audit],
            )
            .await
            .map_err(|e| db::DbError(e.to_string()))?;
        Ok(())
    }

    /// After begin_live confirms, mirror on-chain timing/button into the matches row so
    /// the game-server actor can schedule streets without an RPC read.
    async fn mirror_begin_live(&self, job: &ChainJob, _sig: &Signature) {
        let Ok(Some(row)) = db::load_match_row(&self.pool, job.match_id).await else {
            return;
        };
        let (match_key, _) = pda::match_account(&self.cfg.program_id, row.onchain_match_id);
        if let Ok(Some(data)) = self.rpc.get_account_data(&match_key).await {
            if let Ok(m) = decode_match(&data) {
                if let Err(e) = db::update_match_on_begin_live(
                    &self.pool,
                    job.match_id,
                    m.live_start_ts,
                    m.scheduled_end_ts,
                    m.button,
                    &m.button_seed,
                )
                .await
                {
                    warn!(job_id = %job.id, "mirror begin_live: {e}");
                }
            }
        }
    }
}

/// Parse `{"<field>": [{"<key>": "<pubkey>"}...]}` or `{"<field>": ["<pubkey>"...]}`
/// preserving order (engine order).
fn payload_players(payload: &Value, field: &str, key: &str) -> Result<Vec<Pubkey>, StepResult> {
    let Some(list) = payload.get(field).and_then(Value::as_array) else {
        return Ok(Vec::new());
    };
    list.iter()
        .map(|entry| {
            let raw = entry
                .as_str()
                .or_else(|| entry.get(key).and_then(Value::as_str))
                .ok_or_else(|| StepResult::DeadLetter {
                    error: format!("payload {field} entry missing {key}"),
                    audit: None,
                })?;
            Pubkey::from_str(raw).map_err(|e| StepResult::DeadLetter {
                error: format!("payload pubkey: {e}"),
                audit: None,
            })
        })
        .collect()
}
