//! Production settlement operations seam.
//!
//! This module owns liveness mechanics around the pure settlement bundle:
//! signed-price resolution (`PythResolveClient`, despite the legacy name, proxies
//! the signed-price-server), Solana transaction build/send/confirm, idempotent
//! attempts, retry/refund fallback, dead-letter inspection, and vault
//! reconciliation. Concrete network clients plug in behind these traits.

use std::collections::{HashMap, VecDeque};

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use syndicate_shared::{FeedId, VerifiedOraclePrice};
// Only the signed-price resolve path (behind `net`) validates raw oracle updates.
#[cfg(feature = "net")]
use syndicate_shared::{first_valid_oracle_update, OraclePriceUpdate, OracleValidation};

use crate::{Outcome, SettlementBundle, SubmitError, SubmitReceipt, VoidReason};

#[cfg(feature = "pg")]
pub mod pg_store;

#[cfg(feature = "nats")]
pub mod nats;

#[cfg(feature = "pg")]
pub use pg_store::PostgresAttemptStore;

#[cfg(feature = "nats")]
pub use nats::{
    BusError, SettlementBus, SettlementBusConfig, SETTLEMENT_CONSUMER, SETTLEMENT_STREAM,
};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PythFetchRequest {
    pub symbol: String,
    pub feed_id: FeedId,
    pub scheduled_end_ts: u64,
    pub max_confidence: u64,
    pub expected_exponent: i32,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PythSelectedProof {
    pub feed_id_hex: String,
    pub price: String,
    pub confidence: String,
    pub exponent: i32,
    pub publish_time: u64,
    pub requested_timestamp: u64,
    pub binary_data_hex: Vec<String>,
    pub price_update_data: Vec<String>,
    pub hermes_response_hash: String,
    pub binary_update_hash: String,
    #[serde(default)]
    pub hermes_url: Option<String>,
}

impl PythSelectedProof {
    pub fn verified_price(&self) -> Result<VerifiedOraclePrice, PythError> {
        Ok(VerifiedOraclePrice {
            feed_id: parse_feed_id_hex(&self.feed_id_hex)
                .map_err(|e| PythError::InvalidUpdate(format!("bad selected feed id: {e}")))?,
            price: self
                .price
                .parse()
                .map_err(|e| PythError::InvalidUpdate(format!("bad selected price: {e}")))?,
            publish_time: self.publish_time,
            confidence: self
                .confidence
                .parse()
                .map_err(|e| PythError::InvalidUpdate(format!("bad selected confidence: {e}")))?,
            exponent: self.exponent,
        })
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PythResolvedPrice {
    pub price: VerifiedOraclePrice,
    pub selected: PythSelectedProof,
    pub signed_price: SignedPricePayload,
    pub source_url: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SignedPricePayload {
    pub token: String,
    pub symbol: String,
    #[serde(alias = "priceInWad")]
    pub price_in_wad: String,
    pub timestamp: u64,
    pub v: u8,
    pub r: String,
    pub s: String,
    #[serde(default)]
    #[serde(alias = "signedAt")]
    pub signed_at: Option<u64>,
}

pub trait PythResolveClient {
    fn resolve_pyth(
        &mut self,
        request: &PythFetchRequest,
    ) -> Result<Option<PythResolvedPrice>, PythError>;
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PythError {
    Unavailable(String),
    InvalidUpdate(String),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SolanaTransactionPlan {
    pub idempotency_key: String,
    pub instruction: SolanaInstructionKind,
    pub payload_hash: [u8; 32],
    pub payload: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SolanaInstructionKind {
    SubmitSettlement,
    VoidMatch { reason: VoidReason },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ConfirmationStatus {
    Confirmed,
    Pending,
}

pub trait SolanaSettlementClient {
    fn build_submit_settlement(
        &mut self,
        job: &SettlementJob,
        bundle: &SettlementBundle,
    ) -> Result<SolanaTransactionPlan, SubmitError>;

    fn build_void_match(
        &mut self,
        job: &SettlementJob,
        reason: VoidReason,
    ) -> Result<SolanaTransactionPlan, SubmitError>;

    fn send_transaction(
        &mut self,
        plan: &SolanaTransactionPlan,
    ) -> Result<SubmitReceipt, SubmitError>;

    fn confirm_transaction(
        &mut self,
        receipt: &SubmitReceipt,
        min_confirmations: u8,
    ) -> Result<ConfirmationStatus, SubmitError>;
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SettlementJob {
    pub match_id: String,
    pub idempotency_key: String,
    pub event_root: [u8; 32],
    pub chain_context: SolanaMatchContext,
    pub pyth_context: PythSettlementContext,
    pub outcome: Outcome,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SolanaMatchContext {
    pub onchain_match_id: u64,
    pub seat_wallets: Vec<String>,
    pub buy_in_chips: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PythSettlementContext {
    pub rules: PythFetchRequest,
    pub selected: Option<PythSelectedProof>,
    pub signed_price: Option<SignedPricePayload>,
    pub signed_price_source_url: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AttemptStatus {
    Pending,
    Submitted,
    Confirmed,
    Voided,
    RetryScheduled,
    DeadLetter,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AttemptRecord {
    pub match_id: String,
    pub idempotency_key: String,
    pub event_root: [u8; 32],
    pub status: AttemptStatus,
    pub attempt_count: u32,
    pub tx_sig: Option<String>,
    pub next_retry_at_ms: Option<u64>,
    pub last_error: Option<String>,
    pub oracle_audit: Option<serde_json::Value>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DeadLetter {
    pub match_id: String,
    pub idempotency_key: String,
    pub reason: String,
    pub payload: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RetryPolicy {
    pub max_submit_attempts: u32,
    pub base_delay_ms: u64,
    pub max_delay_ms: u64,
    pub min_confirmations: u8,
}

impl RetryPolicy {
    pub fn recommended() -> Self {
        Self {
            max_submit_attempts: 5,
            base_delay_ms: 1_000,
            max_delay_ms: 30_000,
            min_confirmations: 1,
        }
    }

    pub fn next_delay_ms(&self, attempt_count: u32) -> u64 {
        let exponent = attempt_count.saturating_sub(1).min(16);
        let multiplier = 1u64.checked_shl(exponent).unwrap_or(u64::MAX);
        self.base_delay_ms
            .saturating_mul(multiplier)
            .min(self.max_delay_ms)
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum AttemptStoreError {
    Backend(String),
    NotFound,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum OpsError {
    Submit(SubmitError),
    Store(AttemptStoreError),
}

impl From<SubmitError> for OpsError {
    fn from(value: SubmitError) -> Self {
        OpsError::Submit(value)
    }
}

impl From<AttemptStoreError> for OpsError {
    fn from(value: AttemptStoreError) -> Self {
        OpsError::Store(value)
    }
}

#[async_trait]
pub trait SettlementAttemptStore {
    async fn begin_attempt(
        &mut self,
        job: &SettlementJob,
        now_ms: u64,
    ) -> Result<AttemptRecord, AttemptStoreError>;
    async fn mark_submitted(
        &mut self,
        idempotency_key: &str,
        tx_sig: String,
    ) -> Result<AttemptRecord, AttemptStoreError>;
    async fn mark_confirmed(
        &mut self,
        idempotency_key: &str,
    ) -> Result<AttemptRecord, AttemptStoreError>;
    async fn mark_voided(
        &mut self,
        idempotency_key: &str,
        tx_sig: String,
        reason: String,
    ) -> Result<AttemptRecord, AttemptStoreError>;
    async fn mark_retry(
        &mut self,
        idempotency_key: &str,
        error: String,
        next_retry_at_ms: u64,
    ) -> Result<AttemptRecord, AttemptStoreError>;
    async fn dead_letter(
        &mut self,
        job: &SettlementJob,
        reason: String,
        payload: String,
    ) -> Result<AttemptRecord, AttemptStoreError>;
    async fn get(&self, idempotency_key: &str) -> Result<Option<AttemptRecord>, AttemptStoreError>;
}

#[derive(Default)]
pub struct InMemoryAttemptStore {
    records: HashMap<String, AttemptRecord>,
    pub dead_letters: Vec<DeadLetter>,
}

impl InMemoryAttemptStore {
    pub fn new() -> Self {
        Self::default()
    }
}

#[async_trait]
impl SettlementAttemptStore for InMemoryAttemptStore {
    async fn begin_attempt(
        &mut self,
        job: &SettlementJob,
        _now_ms: u64,
    ) -> Result<AttemptRecord, AttemptStoreError> {
        Ok(self
            .records
            .entry(job.idempotency_key.clone())
            .or_insert_with(|| AttemptRecord {
                match_id: job.match_id.clone(),
                idempotency_key: job.idempotency_key.clone(),
                event_root: job.event_root,
                status: AttemptStatus::Pending,
                attempt_count: 0,
                tx_sig: None,
                next_retry_at_ms: None,
                last_error: None,
                oracle_audit: oracle_audit_for_job(job),
            })
            .clone())
    }

    async fn mark_submitted(
        &mut self,
        idempotency_key: &str,
        tx_sig: String,
    ) -> Result<AttemptRecord, AttemptStoreError> {
        let record = self
            .records
            .get_mut(idempotency_key)
            .ok_or(AttemptStoreError::NotFound)?;
        record.status = AttemptStatus::Submitted;
        record.attempt_count += 1;
        record.tx_sig = Some(tx_sig);
        record.next_retry_at_ms = None;
        record.last_error = None;
        Ok(record.clone())
    }

    async fn mark_confirmed(
        &mut self,
        idempotency_key: &str,
    ) -> Result<AttemptRecord, AttemptStoreError> {
        let record = self
            .records
            .get_mut(idempotency_key)
            .ok_or(AttemptStoreError::NotFound)?;
        record.status = AttemptStatus::Confirmed;
        record.next_retry_at_ms = None;
        record.last_error = None;
        Ok(record.clone())
    }

    async fn mark_voided(
        &mut self,
        idempotency_key: &str,
        tx_sig: String,
        reason: String,
    ) -> Result<AttemptRecord, AttemptStoreError> {
        let record = self
            .records
            .get_mut(idempotency_key)
            .ok_or(AttemptStoreError::NotFound)?;
        record.status = AttemptStatus::Voided;
        record.tx_sig = Some(tx_sig);
        record.next_retry_at_ms = None;
        record.last_error = Some(reason);
        Ok(record.clone())
    }

    async fn mark_retry(
        &mut self,
        idempotency_key: &str,
        error: String,
        next_retry_at_ms: u64,
    ) -> Result<AttemptRecord, AttemptStoreError> {
        let record = self
            .records
            .get_mut(idempotency_key)
            .ok_or(AttemptStoreError::NotFound)?;
        record.status = AttemptStatus::RetryScheduled;
        record.next_retry_at_ms = Some(next_retry_at_ms);
        record.last_error = Some(error);
        Ok(record.clone())
    }

    async fn dead_letter(
        &mut self,
        job: &SettlementJob,
        reason: String,
        payload: String,
    ) -> Result<AttemptRecord, AttemptStoreError> {
        let record = self
            .records
            .entry(job.idempotency_key.clone())
            .or_insert_with(|| AttemptRecord {
                match_id: job.match_id.clone(),
                idempotency_key: job.idempotency_key.clone(),
                event_root: job.event_root,
                status: AttemptStatus::Pending,
                attempt_count: 0,
                tx_sig: None,
                next_retry_at_ms: None,
                last_error: None,
                oracle_audit: oracle_audit_for_job(job),
            });
        record.status = AttemptStatus::DeadLetter;
        record.last_error = Some(reason.clone());
        record.next_retry_at_ms = None;
        self.dead_letters.push(DeadLetter {
            match_id: job.match_id.clone(),
            idempotency_key: job.idempotency_key.clone(),
            reason,
            payload,
        });
        Ok(record.clone())
    }

    async fn get(&self, idempotency_key: &str) -> Result<Option<AttemptRecord>, AttemptStoreError> {
        Ok(self.records.get(idempotency_key).cloned())
    }
}

fn oracle_audit_for_job(job: &SettlementJob) -> Option<serde_json::Value> {
    let signed_price = job.pyth_context.signed_price.as_ref()?;
    let payload = serde_json::json!({
        "token": signed_price.token,
        "symbol": signed_price.symbol,
        "price_in_wad": signed_price.price_in_wad,
        "timestamp": signed_price.timestamp,
        "v": signed_price.v,
        "r": signed_price.r,
        "s": signed_price.s,
        "signed_at": signed_price.signed_at,
    });
    let hash = syndicate_store::chain(&[0u8; 32], payload.to_string().as_bytes());
    Some(serde_json::json!({
        "kind": "signed_price",
        "source_url": job.pyth_context.signed_price_source_url,
        "symbol": signed_price.symbol,
        "timestamp_sec": signed_price.timestamp / 1_000,
        "signed_payload_timestamp_ms": signed_price.timestamp,
        "signed_payload_hash": hex::encode(hash),
        "payload": payload,
    }))
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SettlementProcessResult {
    Final(AttemptRecord),
    RetryScheduled(AttemptRecord),
    DeadLetter(AttemptRecord),
}

pub struct SettlementOpsWorker<C, S> {
    pub chain: C,
    pub store: S,
    pub retry_policy: RetryPolicy,
}

impl<C, S> SettlementOpsWorker<C, S>
where
    C: SolanaSettlementClient,
    S: SettlementAttemptStore,
{
    pub async fn process(
        &mut self,
        job: &SettlementJob,
        now_ms: u64,
    ) -> Result<SettlementProcessResult, OpsError> {
        let existing = self.store.begin_attempt(job, now_ms).await?;
        if matches!(
            existing.status,
            AttemptStatus::Confirmed | AttemptStatus::Voided | AttemptStatus::DeadLetter
        ) {
            return Ok(match existing.status {
                AttemptStatus::DeadLetter => SettlementProcessResult::DeadLetter(existing),
                _ => SettlementProcessResult::Final(existing),
            });
        }
        if matches!(
            existing.status,
            AttemptStatus::Submitted | AttemptStatus::RetryScheduled
        ) && existing.tx_sig.is_some()
        {
            return self.confirm_existing_or_retry(job, existing, now_ms).await;
        }

        match &job.outcome {
            Outcome::Void(reason) => self.submit_void(job, *reason).await,
            Outcome::Settled(bundle) => {
                if !bundle.verify() {
                    let record = self
                        .store
                        .dead_letter(
                            job,
                            "settlement bundle failed self-verification".into(),
                            format!("{bundle:?}"),
                        )
                        .await?;
                    return Ok(SettlementProcessResult::DeadLetter(record));
                }
                self.submit_settlement_or_retry(job, bundle, now_ms).await
            }
        }
    }

    async fn submit_settlement_or_retry(
        &mut self,
        job: &SettlementJob,
        bundle: &SettlementBundle,
        now_ms: u64,
    ) -> Result<SettlementProcessResult, OpsError> {
        let plan = match self.chain.build_submit_settlement(job, bundle) {
            Ok(plan) => plan,
            Err(e) => return Ok(self.retry_or_refund(job, now_ms, format!("{e:?}")).await?),
        };
        let receipt = match self.chain.send_transaction(&plan) {
            Ok(receipt) => receipt,
            Err(e) => return Ok(self.retry_or_refund(job, now_ms, format!("{e:?}")).await?),
        };
        self.store
            .mark_submitted(&job.idempotency_key, receipt.tx_sig.clone())
            .await?;
        match self
            .chain
            .confirm_transaction(&receipt, self.retry_policy.min_confirmations)
        {
            Ok(ConfirmationStatus::Confirmed) => {
                let record = self.store.mark_confirmed(&job.idempotency_key).await?;
                Ok(SettlementProcessResult::Final(record))
            }
            Ok(ConfirmationStatus::Pending) => Ok(self
                .retry_or_refund(job, now_ms, "confirmation pending".into())
                .await?),
            Err(e) => Ok(self.retry_or_refund(job, now_ms, format!("{e:?}")).await?),
        }
    }

    async fn confirm_existing_or_retry(
        &mut self,
        job: &SettlementJob,
        existing: AttemptRecord,
        now_ms: u64,
    ) -> Result<SettlementProcessResult, OpsError> {
        let Some(tx_sig) = existing.tx_sig.clone() else {
            return Ok(self
                .retry_or_refund(job, now_ms, "submitted attempt missing tx signature".into())
                .await?);
        };
        let receipt = SubmitReceipt { tx_sig };
        match self
            .chain
            .confirm_transaction(&receipt, self.retry_policy.min_confirmations)
        {
            Ok(ConfirmationStatus::Confirmed) => match &job.outcome {
                Outcome::Settled(_) => {
                    let record = self.store.mark_confirmed(&job.idempotency_key).await?;
                    Ok(SettlementProcessResult::Final(record))
                }
                Outcome::Void(reason) => {
                    let record = self
                        .store
                        .mark_voided(&job.idempotency_key, receipt.tx_sig, format!("{reason:?}"))
                        .await?;
                    Ok(SettlementProcessResult::Final(record))
                }
            },
            Ok(ConfirmationStatus::Pending) => {
                self.retry_existing_confirmation(
                    job,
                    now_ms,
                    "existing transaction confirmation pending".into(),
                )
                .await
            }
            Err(e) => {
                self.retry_existing_confirmation(job, now_ms, format!("{e:?}"))
                    .await
            }
        }
    }

    async fn retry_existing_confirmation(
        &mut self,
        job: &SettlementJob,
        now_ms: u64,
        error: String,
    ) -> Result<SettlementProcessResult, OpsError> {
        let attempts = self
            .store
            .get(&job.idempotency_key)
            .await?
            .map(|r| r.attempt_count)
            .unwrap_or(0);
        let delay = self.retry_policy.next_delay_ms(attempts.saturating_add(1));
        let record = self
            .store
            .mark_retry(&job.idempotency_key, error, now_ms.saturating_add(delay))
            .await?;
        Ok(SettlementProcessResult::RetryScheduled(record))
    }

    async fn submit_void(
        &mut self,
        job: &SettlementJob,
        reason: VoidReason,
    ) -> Result<SettlementProcessResult, OpsError> {
        let plan = self.chain.build_void_match(job, reason)?;
        let receipt = self.chain.send_transaction(&plan)?;
        self.store
            .mark_submitted(&job.idempotency_key, receipt.tx_sig.clone())
            .await?;
        let record = self
            .store
            .mark_voided(&job.idempotency_key, receipt.tx_sig, format!("{reason:?}"))
            .await?;
        Ok(SettlementProcessResult::Final(record))
    }

    async fn retry_or_refund(
        &mut self,
        job: &SettlementJob,
        now_ms: u64,
        error: String,
    ) -> Result<SettlementProcessResult, OpsError> {
        let attempts = self
            .store
            .get(&job.idempotency_key)
            .await?
            .map(|r| r.attempt_count)
            .unwrap_or(0);
        if attempts < self.retry_policy.max_submit_attempts {
            let delay = self.retry_policy.next_delay_ms(attempts.saturating_add(1));
            let record = self
                .store
                .mark_retry(&job.idempotency_key, error, now_ms.saturating_add(delay))
                .await?;
            return Ok(SettlementProcessResult::RetryScheduled(record));
        }

        match self
            .chain
            .build_void_match(job, VoidReason::OracleDegraded)
            .and_then(|plan| self.chain.send_transaction(&plan))
        {
            Ok(receipt) => {
                let record = self
                    .store
                    .mark_voided(
                        &job.idempotency_key,
                        receipt.tx_sig,
                        format!("settlement retry budget exhausted: {error}"),
                    )
                    .await?;
                Ok(SettlementProcessResult::Final(record))
            }
            Err(e) => {
                let record = self
                    .store
                    .dead_letter(
                        job,
                        format!("settlement and refund submission failed: {e:?}"),
                        error,
                    )
                    .await?;
                Ok(SettlementProcessResult::DeadLetter(record))
            }
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ReconciliationStatus {
    Green,
    Drift,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct VaultReconciliationInput {
    pub match_id: String,
    pub expected_player_liability: u64,
    pub expected_fee_liability: u64,
    pub actual_vault_balance: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct VaultReconciliationReport {
    pub match_id: String,
    pub expected_total_liability: u64,
    pub actual_vault_balance: u64,
    pub drift_chips: i128,
    pub status: ReconciliationStatus,
}

pub fn reconcile_vault(input: &VaultReconciliationInput) -> VaultReconciliationReport {
    let expected = input
        .expected_player_liability
        .saturating_add(input.expected_fee_liability);
    let drift = input.actual_vault_balance as i128 - expected as i128;
    VaultReconciliationReport {
        match_id: input.match_id.clone(),
        expected_total_liability: expected,
        actual_vault_balance: input.actual_vault_balance,
        drift_chips: drift,
        status: if drift == 0 {
            ReconciliationStatus::Green
        } else {
            ReconciliationStatus::Drift
        },
    }
}

#[derive(Default)]
pub struct MockSolanaClient {
    pub send_failures: VecDeque<SubmitError>,
    pub confirmations: VecDeque<ConfirmationStatus>,
    pub send_count: u64,
    pub confirm_count: u64,
    sent_by_key: HashMap<String, SubmitReceipt>,
    n: u64,
}

impl MockSolanaClient {
    pub fn new() -> Self {
        Self::default()
    }

    fn next_sig(&mut self, key: &str) -> SubmitReceipt {
        if let Some(receipt) = self.sent_by_key.get(key) {
            return receipt.clone();
        }
        self.n += 1;
        let receipt = SubmitReceipt {
            tx_sig: format!("mock-solana-{key}-{}", self.n),
        };
        self.sent_by_key.insert(key.to_string(), receipt.clone());
        receipt
    }
}

impl SolanaSettlementClient for MockSolanaClient {
    fn build_submit_settlement(
        &mut self,
        job: &SettlementJob,
        bundle: &SettlementBundle,
    ) -> Result<SolanaTransactionPlan, SubmitError> {
        if !bundle.verify() {
            return Err(SubmitError::SelfVerifyFailed);
        }
        Ok(SolanaTransactionPlan {
            idempotency_key: job.idempotency_key.clone(),
            instruction: SolanaInstructionKind::SubmitSettlement,
            payload_hash: settlement_payload_hash(bundle),
            payload: None,
        })
    }

    fn build_void_match(
        &mut self,
        job: &SettlementJob,
        reason: VoidReason,
    ) -> Result<SolanaTransactionPlan, SubmitError> {
        Ok(SolanaTransactionPlan {
            idempotency_key: job.idempotency_key.clone(),
            instruction: SolanaInstructionKind::VoidMatch { reason },
            payload_hash: [0u8; 32],
            payload: None,
        })
    }

    fn send_transaction(
        &mut self,
        plan: &SolanaTransactionPlan,
    ) -> Result<SubmitReceipt, SubmitError> {
        self.send_count += 1;
        if let Some(err) = self.send_failures.pop_front() {
            return Err(err);
        }
        Ok(self.next_sig(&plan.idempotency_key))
    }

    fn confirm_transaction(
        &mut self,
        _receipt: &SubmitReceipt,
        _min_confirmations: u8,
    ) -> Result<ConfirmationStatus, SubmitError> {
        self.confirm_count += 1;
        Ok(self
            .confirmations
            .pop_front()
            .unwrap_or(ConfirmationStatus::Confirmed))
    }
}

fn settlement_payload_hash(bundle: &SettlementBundle) -> [u8; 32] {
    let mut out = [0u8; 32];
    let bytes = format!(
        "{}|{}|{:?}|{:?}|{}",
        bundle.oracle_price.price,
        bundle.oracle_price.publish_time,
        bundle.result.pot_awards,
        bundle.result.uncalled_returns,
        bundle.result.rake_collected
    );
    let digest = syndicate_store::chain(&[0u8; 32], bytes.as_bytes());
    out.copy_from_slice(&digest);
    out
}

pub fn feed_id_hex(feed_id: &FeedId) -> String {
    let mut out = String::with_capacity(64);
    for b in feed_id {
        out.push_str(&format!("{b:02x}"));
    }
    out
}

fn parse_feed_id_hex(input: &str) -> Result<FeedId, String> {
    let hex = input.strip_prefix("0x").unwrap_or(input);
    if hex.len() != 64 {
        return Err("expected 32-byte hex".into());
    }
    let mut out = [0u8; 32];
    for i in 0..32 {
        out[i] = u8::from_str_radix(&hex[i * 2..i * 2 + 2], 16).map_err(|e| e.to_string())?;
    }
    Ok(out)
}

#[cfg(feature = "net")]
pub mod net {
    use super::*;
    use serde::{Deserialize, Serialize};

    #[derive(Clone, Debug)]
    pub struct SettlementChainHttpClient {
        pub base_url: String,
        pub auth_token: String,
        pub timeout_ms: u64,
    }

    impl SettlementChainHttpClient {
        pub fn new(
            base_url: impl Into<String>,
            auth_token: impl Into<String>,
            timeout_ms: u64,
        ) -> Self {
            Self {
                base_url: base_url.into().trim_end_matches('/').to_string(),
                auth_token: auth_token.into(),
                timeout_ms,
            }
        }

        fn endpoint(&self, path: &str) -> String {
            format!("{}/{}", self.base_url, path.trim_start_matches('/'))
        }

        fn post_json<T: Serialize, R: for<'de> Deserialize<'de>>(
            &self,
            path: &str,
            body: &T,
        ) -> Result<R, SubmitError> {
            ureq::post(&self.endpoint(path))
                .timeout(std::time::Duration::from_millis(self.timeout_ms))
                .set("Authorization", &format!("Bearer {}", self.auth_token))
                .send_json(
                    serde_json::to_value(body)
                        .map_err(|e| SubmitError::Rpc(format!("adapter request invalid: {e}")))?,
                )
                .map_err(|e| SubmitError::Rpc(format!("settlement-chain {path} failed: {e}")))?
                .into_json()
                .map_err(|e| SubmitError::Rpc(format!("settlement-chain {path} JSON invalid: {e}")))
        }

    }

    impl PythResolveClient for SettlementChainHttpClient {
        fn resolve_pyth(
            &mut self,
            request: &PythFetchRequest,
        ) -> Result<Option<PythResolvedPrice>, PythError> {
            let body = AdapterPythRules::from_request(request);
            let response: AdapterResolveResponse = self
                .post_json("/internal/pyth/resolve", &body)
                .map_err(|e| PythError::Unavailable(format!("{e:?}")))?;
            if !response.available {
                return Ok(None);
            }
            let signed_price = response.signed_price.ok_or_else(|| {
                PythError::InvalidUpdate("resolve response missing signed_price".into())
            })?;
            let price_wire = response
                .price
                .ok_or_else(|| PythError::InvalidUpdate("resolve response missing price".into()))?;
            let update = OraclePriceUpdate {
                feed_id: parse_feed_id_hex(&price_wire.feed_id)
                    .map_err(|e| PythError::InvalidUpdate(format!("bad feed id: {e}")))?,
                price: price_wire
                    .price
                    .parse()
                    .map_err(|e| PythError::InvalidUpdate(format!("bad price integer: {e}")))?,
                publish_time: price_wire.publish_time,
                confidence: price_wire.confidence,
                exponent: price_wire.exponent,
            };
            let price = VerifiedOraclePrice {
                feed_id: update.feed_id,
                price: update.price,
                publish_time: update.publish_time,
                confidence: update.confidence,
                exponent: update.exponent,
            };
            let update = OraclePriceUpdate {
                feed_id: price.feed_id,
                price: price.price,
                publish_time: price.publish_time,
                confidence: price.confidence,
                exponent: price.exponent,
            };
            let rules = OracleValidation {
                expected_feed_id: request.feed_id,
                scheduled_end_ts: request.scheduled_end_ts,
                max_confidence: request.max_confidence,
                expected_exponent: request.expected_exponent,
            };
            first_valid_oracle_update(&[update], &rules)
                .map_err(|e| PythError::InvalidUpdate(format!("{e:?}")))?;
            let selected = response.selected.unwrap_or_else(|| PythSelectedProof {
                feed_id_hex: feed_id_hex(&price.feed_id),
                price: price.price.to_string(),
                confidence: price.confidence.to_string(),
                exponent: price.exponent,
                publish_time: price.publish_time,
                requested_timestamp: request.scheduled_end_ts,
                binary_data_hex: Vec::new(),
                price_update_data: Vec::new(),
                hermes_response_hash: String::new(),
                binary_update_hash: String::new(),
                hermes_url: None,
            });
            Ok(Some(PythResolvedPrice {
                price,
                selected,
                signed_price,
                source_url: response.source_url,
            }))
        }
    }

    impl SolanaSettlementClient for SettlementChainHttpClient {
        fn build_submit_settlement(
            &mut self,
            job: &SettlementJob,
            bundle: &SettlementBundle,
        ) -> Result<SolanaTransactionPlan, SubmitError> {
            if !bundle.verify() {
                return Err(SubmitError::SelfVerifyFailed);
            }
            let signed_price = job.pyth_context.signed_price.clone().ok_or_else(|| {
                SubmitError::Rpc("missing signed price payload for settlement".into())
            })?;
            let payload_hash = settlement_payload_hash(bundle);
            let payload = AdapterSubmitRequest {
                idempotency_key: job.idempotency_key.clone(),
                match_id: job.match_id.clone(),
                payload_hash: hex_32(payload_hash),
                match_context: AdapterMatchContext::from_job(job, true),
                signed_price,
                bundle: SettlementBundleWire::from_bundle(bundle, job.chain_context.buy_in_chips),
            };
            Ok(SolanaTransactionPlan {
                idempotency_key: job.idempotency_key.clone(),
                instruction: SolanaInstructionKind::SubmitSettlement,
                payload_hash,
                payload: Some(
                    serde_json::to_string(&payload)
                        .map_err(|e| SubmitError::Rpc(format!("adapter payload invalid: {e}")))?,
                ),
            })
        }

        fn build_void_match(
            &mut self,
            job: &SettlementJob,
            reason: VoidReason,
        ) -> Result<SolanaTransactionPlan, SubmitError> {
            let payload = AdapterVoidRequest {
                idempotency_key: job.idempotency_key.clone(),
                match_id: job.match_id.clone(),
                reason: format!("{reason:?}"),
                match_context: AdapterMatchContext::from_job(job, false),
            };
            Ok(SolanaTransactionPlan {
                idempotency_key: job.idempotency_key.clone(),
                instruction: SolanaInstructionKind::VoidMatch { reason },
                payload_hash: [0u8; 32],
                payload: Some(
                    serde_json::to_string(&payload)
                        .map_err(|e| SubmitError::Rpc(format!("adapter payload invalid: {e}")))?,
                ),
            })
        }

        fn send_transaction(
            &mut self,
            plan: &SolanaTransactionPlan,
        ) -> Result<SubmitReceipt, SubmitError> {
            let payload = plan
                .payload
                .as_ref()
                .ok_or_else(|| SubmitError::Rpc("missing settlement-chain payload".into()))?;
            let endpoint = match plan.instruction {
                SolanaInstructionKind::SubmitSettlement => "/internal/solana/submit-settlement",
                SolanaInstructionKind::VoidMatch { .. } => "/internal/solana/void-match",
            };
            let response: AdapterSubmitResponse = self.post_json(
                endpoint,
                &serde_json::from_str::<serde_json::Value>(payload)
                    .map_err(|e| SubmitError::Rpc(format!("adapter payload JSON invalid: {e}")))?,
            )?;
            Ok(SubmitReceipt {
                tx_sig: response.tx_sig,
            })
        }

        fn confirm_transaction(
            &mut self,
            _receipt: &SubmitReceipt,
            _min_confirmations: u8,
        ) -> Result<ConfirmationStatus, SubmitError> {
            // The settlement-chain submit endpoints simulate, send, confirm, and
            // only then return a receipt. A receipt here is already confirmed.
            Ok(ConfirmationStatus::Confirmed)
        }
    }

    #[derive(Clone, Debug, Serialize)]
    #[serde(rename_all = "camelCase")]
    struct AdapterSubmitRequest {
        idempotency_key: String,
        match_id: String,
        payload_hash: String,
        #[serde(rename = "match")]
        match_context: AdapterMatchContext,
        signed_price: SignedPricePayload,
        bundle: SettlementBundleWire,
    }

    #[derive(Clone, Debug, Serialize)]
    #[serde(rename_all = "camelCase")]
    struct AdapterVoidRequest {
        idempotency_key: String,
        match_id: String,
        reason: String,
        #[serde(rename = "match")]
        match_context: AdapterMatchContext,
    }

    #[derive(Clone, Debug, Serialize)]
    #[serde(rename_all = "camelCase")]
    struct AdapterMatchContext {
        onchain_match_id: String,
        #[serde(skip_serializing_if = "Vec::is_empty")]
        seat_wallets: Vec<String>,
        buy_in_chips: u64,
    }

    impl AdapterMatchContext {
        fn from_job(job: &SettlementJob, include_seats: bool) -> Self {
            Self {
                onchain_match_id: job.chain_context.onchain_match_id.to_string(),
                seat_wallets: if include_seats {
                    job.chain_context.seat_wallets.clone()
                } else {
                    Vec::new()
                },
                buy_in_chips: job.chain_context.buy_in_chips,
            }
        }
    }

    #[derive(Clone, Debug, Serialize)]
    #[serde(rename_all = "camelCase")]
    struct AdapterPythRules {
        symbol: String,
        feed_id_hex: String,
        scheduled_end_ts: u64,
        max_confidence: String,
        expected_exponent: i32,
    }

    impl AdapterPythRules {
        fn from_request(request: &PythFetchRequest) -> Self {
            Self {
                symbol: request.symbol.clone(),
                feed_id_hex: feed_id_hex(&request.feed_id),
                scheduled_end_ts: request.scheduled_end_ts,
                max_confidence: request.max_confidence.to_string(),
                expected_exponent: request.expected_exponent,
            }
        }
    }

    #[derive(Clone, Debug, Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct AdapterResolveResponse {
        available: bool,
        selected: Option<PythSelectedProof>,
        price: Option<OracleUpdateWire>,
        #[serde(alias = "signed_price")]
        signed_price: Option<SignedPricePayload>,
        #[serde(alias = "source_url")]
        source_url: Option<String>,
        #[allow(dead_code)]
        reason: Option<String>,
    }

    #[derive(Clone, Debug, Deserialize)]
    struct AdapterSubmitResponse {
        tx_sig: String,
    }

    #[derive(Clone, Debug, Serialize)]
    struct SettlementBundleWire {
        #[serde(skip_serializing_if = "Vec::is_empty")]
        players: Vec<PlayerWire>,
        revealed: Vec<RevealedWire>,
        oracle_price: OracleUpdateWire,
        rake_bps: u32,
        rake_cap: u64,
        result: SettleResultWire,
        payouts: Vec<SeatPayoutWire>,
    }

    #[derive(Clone, Debug, Serialize)]
    struct SeatPayoutWire {
        engine_seat: u8,
        amount: u64,
    }

    fn compute_seat_payouts(bundle: &SettlementBundle, buy_in: u64) -> Vec<SeatPayoutWire> {
        bundle
            .players
            .iter()
            .map(|player| {
                let won: u64 = bundle
                    .result
                    .pot_awards
                    .iter()
                    .filter(|a| a.player == player.id)
                    .map(|a| a.amount)
                    .sum::<u64>()
                    + bundle
                        .result
                        .uncalled_returns
                        .iter()
                        .filter(|(p, _)| *p == player.id)
                        .map(|(_, amount)| *amount)
                        .sum::<u64>();
                let leftover = buy_in.saturating_sub(player.contribution);
                SeatPayoutWire {
                    engine_seat: player.id.0 as u8,
                    amount: leftover.saturating_add(won),
                }
            })
            .collect()
    }

    #[derive(Clone, Debug, Serialize)]
    struct RevealedWire {
        seat_index: u16,
        prediction: String,
        blinding_hex: String,
    }

    impl SettlementBundleWire {
        fn from_bundle(bundle: &SettlementBundle, buy_in: u64) -> Self {
            Self {
                players: bundle
                    .players
                    .iter()
                    .map(|p| PlayerWire {
                        seat_index: p.id.0,
                        contribution: p.contribution,
                        folded: p.folded,
                        prediction: p.prediction.map(|v| v.to_string()),
                        seal_seq: p.seal_seq,
                    })
                    .collect(),
                revealed: bundle
                    .revealed
                    .iter()
                    .map(|r| RevealedWire {
                        seat_index: r.seat_index,
                        prediction: r.prediction.to_string(),
                        blinding_hex: r.blinding.iter().map(|b| format!("{b:02x}")).collect(),
                    })
                    .collect(),
                oracle_price: OracleUpdateWire {
                    feed_id: feed_id_hex(&bundle.oracle_price.feed_id),
                    price: bundle.oracle_price.price.to_string(),
                    publish_time: bundle.oracle_price.publish_time,
                    confidence: bundle.oracle_price.confidence,
                    exponent: bundle.oracle_price.exponent,
                },
                rake_bps: bundle.rake_bps,
                rake_cap: bundle.rake_cap,
                result: SettleResultWire {
                    settlement_price: bundle.result.settlement_price.to_string(),
                    oracle_publish_time: bundle.result.oracle_publish_time,
                    pot_awards: bundle
                        .result
                        .pot_awards
                        .iter()
                        .map(|a| AwardWire {
                            seat_index: a.player.0,
                            amount: a.amount,
                        })
                        .collect(),
                    uncalled_returns: bundle
                        .result
                        .uncalled_returns
                        .iter()
                        .map(|(player, amount)| AwardWire {
                            seat_index: player.0,
                            amount: *amount,
                        })
                        .collect(),
                    rake_collected: bundle.result.rake_collected,
                },
                payouts: compute_seat_payouts(bundle, buy_in),
            }
        }
    }

    #[derive(Clone, Debug, Serialize)]
    struct PlayerWire {
        seat_index: u16,
        contribution: u64,
        folded: bool,
        prediction: Option<String>,
        seal_seq: u64,
    }

    #[derive(Clone, Debug, Serialize)]
    struct SettleResultWire {
        settlement_price: String,
        oracle_publish_time: u64,
        pot_awards: Vec<AwardWire>,
        uncalled_returns: Vec<AwardWire>,
        rake_collected: u64,
    }

    #[derive(Clone, Debug, Serialize)]
    struct AwardWire {
        seat_index: u16,
        amount: u64,
    }

    fn hex_32(bytes: [u8; 32]) -> String {
        let mut out = String::with_capacity(64);
        for b in bytes {
            out.push_str(&format!("{b:02x}"));
        }
        out
    }

    #[derive(Clone, Debug, Serialize, Deserialize)]
    struct OracleUpdateWire {
        feed_id: String,
        price: String,
        publish_time: u64,
        confidence: u64,
        exponent: i32,
    }

    #[cfg(test)]
    mod net_tests {
        use super::*;

        #[test]
        fn settlement_chain_client_builds_runtime_void_payload() {
            let mut client =
                SettlementChainHttpClient::new("http://127.0.0.1:8790", "internal-token", 1_000);
            let job = SettlementJob {
                match_id: "match-1".into(),
                idempotency_key: "match-1:root-1".into(),
                event_root: [3u8; 32],
                chain_context: SolanaMatchContext {
                    onchain_match_id: 42,
                    seat_wallets: vec!["wallet-a".into(), "wallet-b".into()],
                    buy_in_chips: 100,
                },
                pyth_context: PythSettlementContext {
                    rules: PythFetchRequest {
                        symbol: "BTCUSD".into(),
                        feed_id: [7u8; 32],
                        scheduled_end_ts: 1_000,
                        max_confidence: 50,
                        expected_exponent: -8,
                    },
                    selected: None,
                    signed_price: None,
                    signed_price_source_url: None,
                },
                outcome: Outcome::Void(VoidReason::OracleDegraded),
            };
            let plan = client
                .build_void_match(&job, VoidReason::OracleDegraded)
                .unwrap();
            assert!(matches!(
                plan.instruction,
                SolanaInstructionKind::VoidMatch {
                    reason: VoidReason::OracleDegraded
                }
            ));
            let payload = plan.payload.unwrap();
            assert!(payload.contains("\"idempotencyKey\":\"match-1:root-1\""));
            assert!(payload.contains("\"onchainMatchId\":\"42\""));
            assert!(payload.contains("\"reason\":\"OracleDegraded\""));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{settle_match, SettleParams};
    use syndicate_engine::{Action, Engine};
    use syndicate_shared::{PlayerId, VerifiedOraclePrice};
    use syndicate_timelock::{MockScheme, RoundKey, SealRegistry, TimelockScheme};

    fn bundle() -> SettlementBundle {
        let mut engine = Engine::new(
            vec![
                (PlayerId(0), 100, 0),
                (PlayerId(1), 100, 1),
                (PlayerId(2), 100, 2),
            ],
            0,
            1,
            2,
            3,
        );
        engine.apply(0, Action::Call).unwrap();
        engine.apply(1, Action::Call).unwrap();
        engine.apply(2, Action::Check).unwrap();
        for _ in 0..2 {
            engine.apply(1, Action::Check).unwrap();
            engine.apply(2, Action::Check).unwrap();
            engine.apply(0, Action::Check).unwrap();
        }

        let scheme = MockScheme;
        let mut reg = SealRegistry::new(42);
        reg.seal(PlayerId(0), scheme.encrypt(100_010, 42)).unwrap();
        reg.seal(PlayerId(1), scheme.encrypt(99_000, 42)).unwrap();
        reg.seal(PlayerId(2), scheme.encrypt(100_500, 42)).unwrap();
        reg.lock();
        let key = RoundKey {
            round: 42,
            key: vec![1],
        };
        let oracle_price = VerifiedOraclePrice {
            feed_id: [7u8; 32],
            price: 100_000,
            publish_time: 1_000,
            confidence: 10,
            exponent: -8,
        };
        use crate::seal_binding_for;
        use std::collections::BTreeMap;
        let mut bindings = BTreeMap::new();
        for (id, pred) in [(0u16, 100_010i128), (1, 99_000), (2, 100_500)] {
            let blinding = [(id + 1) as u8; 32];
            bindings.insert(
                syndicate_shared::PlayerId(id),
                seal_binding_for(pred, blinding),
            );
        }
        match settle_match(
            &engine,
            Some(oracle_price),
            &reg,
            &scheme,
            Some(&key),
            &SettleParams {
                rake_bps: 0,
                rake_cap: 0,
                dead_money: 0,
            },
            &bindings,
        ) {
            Outcome::Settled(bundle) => bundle,
            Outcome::Void(reason) => panic!("expected settled, got {reason:?}"),
        }
    }

    fn job(outcome: Outcome) -> SettlementJob {
        SettlementJob {
            match_id: "match-1".into(),
            idempotency_key: "match-1:root-1".into(),
            event_root: [3u8; 32],
            chain_context: SolanaMatchContext {
                onchain_match_id: 42,
                seat_wallets: vec!["wallet-a".into(), "wallet-b".into(), "wallet-c".into()],
                buy_in_chips: 100,
            },
            pyth_context: PythSettlementContext {
                rules: PythFetchRequest {
                    symbol: "BTCUSD".into(),
                    feed_id: [7u8; 32],
                    scheduled_end_ts: 1_000,
                    max_confidence: 50,
                    expected_exponent: -8,
                },
                selected: Some(PythSelectedProof {
                    feed_id_hex: feed_id_hex(&[7u8; 32]),
                    price: "100000".into(),
                    confidence: "10".into(),
                    exponent: -8,
                    publish_time: 1_000,
                    requested_timestamp: 1_000,
                    binary_data_hex: vec!["00".into()],
                    price_update_data: vec!["AA==".into()],
                    hermes_response_hash: "11".repeat(32),
                    binary_update_hash: "22".repeat(32),
                    hermes_url: None,
                }),
                signed_price: Some(SignedPricePayload {
                    token: "0xa7BaE7da3E4950700BE9f107EB186e89a474d180".into(),
                    symbol: "BTCUSD".into(),
                    price_in_wad: "100000".into(),
                    timestamp: 1_000_000,
                    v: 27,
                    r: format!("0x{}", "11".repeat(32)),
                    s: format!("0x{}", "22".repeat(32)),
                    signed_at: Some(1_000_001),
                }),
                signed_price_source_url: Some(
                    "http://127.0.0.1:8080/prices/at?symbol=BTCUSD&timestamp=1000".into(),
                ),
            },
            outcome,
        }
    }

    #[tokio::test]
    async fn settlement_submission_is_idempotent_after_confirmation() {
        let bundle = bundle();
        let mut worker = SettlementOpsWorker {
            chain: MockSolanaClient::new(),
            store: InMemoryAttemptStore::new(),
            retry_policy: RetryPolicy::recommended(),
        };
        let job = job(Outcome::Settled(bundle));
        let first = worker.process(&job, 10).await.unwrap();
        let second = worker.process(&job, 20).await.unwrap();
        assert!(matches!(first, SettlementProcessResult::Final(_)));
        assert!(matches!(second, SettlementProcessResult::Final(_)));
        let record = worker
            .store
            .get(&job.idempotency_key)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(record.status, AttemptStatus::Confirmed);
        assert_eq!(record.attempt_count, 1);
    }

    #[cfg(feature = "net")]
    #[test]
    fn settlement_chain_submit_payload_contains_protocol_context() {
        let bundle = bundle();
        let job = job(Outcome::Settled(bundle.clone()));
        let mut client = crate::ops::net::SettlementChainHttpClient::new(
            "http://127.0.0.1:8790",
            "token",
            1_000,
        );
        let plan = client.build_submit_settlement(&job, &bundle).unwrap();
        let payload = plan.payload.unwrap();
        assert!(payload.contains("\"idempotencyKey\":\"match-1:root-1\""));
        assert!(payload.contains("\"matchId\":\"match-1\""));
        assert!(payload.contains("\"onchainMatchId\":\"42\""));
        assert!(payload.contains("\"seatWallets\":[\"wallet-a\",\"wallet-b\",\"wallet-c\"]"));
        assert!(payload.contains("\"signedPrice\""));
        assert!(payload.contains("\"symbol\":\"BTCUSD\""));
        assert!(payload.contains("\"bundle\""));
        assert!(payload.contains("\"payouts\""));
    }

    #[tokio::test]
    async fn transient_submit_failure_schedules_retry() {
        let bundle = bundle();
        let mut chain = MockSolanaClient::new();
        chain
            .send_failures
            .push_back(SubmitError::Rpc("rpc down".into()));
        let mut worker = SettlementOpsWorker {
            chain,
            store: InMemoryAttemptStore::new(),
            retry_policy: RetryPolicy {
                max_submit_attempts: 5,
                base_delay_ms: 100,
                max_delay_ms: 1_000,
                min_confirmations: 1,
            },
        };
        let job = job(Outcome::Settled(bundle));
        let result = worker.process(&job, 10).await.unwrap();
        match result {
            SettlementProcessResult::RetryScheduled(record) => {
                assert_eq!(record.status, AttemptStatus::RetryScheduled);
                assert_eq!(record.next_retry_at_ms, Some(110));
            }
            other => panic!("expected retry, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn submitted_settlement_confirmation_does_not_resend() {
        let bundle = bundle();
        let job = job(Outcome::Settled(bundle));
        let mut store = InMemoryAttemptStore::new();
        store.begin_attempt(&job, 0).await.unwrap();
        store
            .mark_submitted(&job.idempotency_key, "already-submitted".into())
            .await
            .unwrap();
        let mut worker = SettlementOpsWorker {
            chain: MockSolanaClient::new(),
            store,
            retry_policy: RetryPolicy::recommended(),
        };
        let result = worker.process(&job, 10).await.unwrap();
        assert!(matches!(result, SettlementProcessResult::Final(_)));
        assert_eq!(worker.chain.confirm_count, 1);
        assert_eq!(worker.chain.send_count, 0);
        let record = worker
            .store
            .get(&job.idempotency_key)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(record.status, AttemptStatus::Confirmed);
    }

    #[tokio::test]
    async fn retry_scheduled_with_signature_confirms_without_resend() {
        let bundle = bundle();
        let job = job(Outcome::Settled(bundle));
        let mut store = InMemoryAttemptStore::new();
        store.begin_attempt(&job, 0).await.unwrap();
        store
            .mark_submitted(&job.idempotency_key, "already-submitted".into())
            .await
            .unwrap();
        store
            .mark_retry(&job.idempotency_key, "pending".into(), 0)
            .await
            .unwrap();
        let mut worker = SettlementOpsWorker {
            chain: MockSolanaClient::new(),
            store,
            retry_policy: RetryPolicy::recommended(),
        };
        let result = worker.process(&job, 10).await.unwrap();
        assert!(matches!(result, SettlementProcessResult::Final(_)));
        assert_eq!(worker.chain.confirm_count, 1);
        assert_eq!(worker.chain.send_count, 0);
    }

    #[tokio::test]
    async fn submitted_pending_confirmation_retries_without_resend() {
        let bundle = bundle();
        let job = job(Outcome::Settled(bundle));
        let mut store = InMemoryAttemptStore::new();
        store.begin_attempt(&job, 0).await.unwrap();
        store
            .mark_submitted(&job.idempotency_key, "already-submitted".into())
            .await
            .unwrap();
        let mut chain = MockSolanaClient::new();
        chain.confirmations.push_back(ConfirmationStatus::Pending);
        let mut worker = SettlementOpsWorker {
            chain,
            store,
            retry_policy: RetryPolicy {
                max_submit_attempts: 0,
                ..RetryPolicy::recommended()
            },
        };
        let result = worker.process(&job, 10).await.unwrap();
        assert!(matches!(result, SettlementProcessResult::RetryScheduled(_)));
        assert_eq!(worker.chain.confirm_count, 1);
        assert_eq!(worker.chain.send_count, 0);
    }

    #[tokio::test]
    async fn submitted_void_confirmation_marks_voided() {
        let job = job(Outcome::Void(VoidReason::TimelockUnavailable));
        let mut store = InMemoryAttemptStore::new();
        store.begin_attempt(&job, 0).await.unwrap();
        store
            .mark_submitted(&job.idempotency_key, "already-voided".into())
            .await
            .unwrap();
        let mut worker = SettlementOpsWorker {
            chain: MockSolanaClient::new(),
            store,
            retry_policy: RetryPolicy::recommended(),
        };
        let result = worker.process(&job, 10).await.unwrap();
        assert!(matches!(result, SettlementProcessResult::Final(_)));
        assert_eq!(worker.chain.confirm_count, 1);
        assert_eq!(worker.chain.send_count, 0);
        let record = worker
            .store
            .get(&job.idempotency_key)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(record.status, AttemptStatus::Voided);
        assert_eq!(record.last_error, Some("TimelockUnavailable".into()));
    }

    #[tokio::test]
    async fn retry_budget_exhaustion_voids_match() {
        let bundle = bundle();
        let mut chain = MockSolanaClient::new();
        chain
            .send_failures
            .push_back(SubmitError::Rpc("rpc down".into()));
        let mut worker = SettlementOpsWorker {
            chain,
            store: InMemoryAttemptStore::new(),
            retry_policy: RetryPolicy {
                max_submit_attempts: 0,
                base_delay_ms: 100,
                max_delay_ms: 1_000,
                min_confirmations: 1,
            },
        };
        let job = job(Outcome::Settled(bundle));
        let result = worker.process(&job, 10).await.unwrap();
        match result {
            SettlementProcessResult::Final(record) => {
                assert_eq!(record.status, AttemptStatus::Voided);
                assert!(record
                    .last_error
                    .unwrap()
                    .contains("retry budget exhausted"));
            }
            other => panic!("expected refund fallback, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn void_outcome_submits_admin_void_path() {
        let mut worker = SettlementOpsWorker {
            chain: MockSolanaClient::new(),
            store: InMemoryAttemptStore::new(),
            retry_policy: RetryPolicy::recommended(),
        };
        let job = job(Outcome::Void(VoidReason::OracleDegraded));
        let result = worker.process(&job, 10).await.unwrap();
        match result {
            SettlementProcessResult::Final(record) => {
                assert_eq!(record.status, AttemptStatus::Voided);
                assert!(record.tx_sig.is_some());
            }
            other => panic!("expected refund final, got {other:?}"),
        }
    }

    #[test]
    fn vault_reconciliation_flags_drift() {
        let green = reconcile_vault(&VaultReconciliationInput {
            match_id: "m".into(),
            expected_player_liability: 90,
            expected_fee_liability: 10,
            actual_vault_balance: 100,
        });
        assert_eq!(green.status, ReconciliationStatus::Green);
        assert_eq!(green.drift_chips, 0);

        let drift = reconcile_vault(&VaultReconciliationInput {
            match_id: "m".into(),
            expected_player_liability: 90,
            expected_fee_liability: 10,
            actual_vault_balance: 99,
        });
        assert_eq!(drift.status, ReconciliationStatus::Drift);
        assert_eq!(drift.drift_chips, -1);
    }
}
