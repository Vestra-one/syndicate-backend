//! The Solana RPC boundary as a trait, so the executor state machine is unit-testable
//! with a mock. The real implementation wraps primary + optional secondary
//! `solana-client` nonblocking clients with naive failover (try primary, then secondary).

use async_trait::async_trait;
use solana_client::nonblocking::rpc_client::RpcClient;
use solana_client::rpc_config::{RpcSendTransactionConfig, RpcSimulateTransactionConfig};
use solana_sdk::commitment_config::CommitmentConfig;
use solana_sdk::hash::Hash;
use solana_sdk::pubkey::Pubkey;
use solana_sdk::signature::Signature;
use solana_sdk::transaction::Transaction;
use solana_transaction_status::TransactionConfirmationStatus;
use syndicate_chain::accounts::SeatAccountData;

#[derive(Debug, Clone)]
pub struct RpcError(pub String);

impl std::fmt::Display for RpcError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "rpc: {}", self.0)
    }
}
impl std::error::Error for RpcError {}

#[derive(Debug, Clone, Default)]
pub struct Simulation {
    pub err: Option<String>,
    pub units_consumed: Option<u64>,
    pub logs: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SigStatus {
    /// Unknown to the cluster (dropped or never landed).
    NotFound,
    /// Landed but the transaction errored.
    Failed(String),
    /// Landed, not yet at `confirmed` commitment.
    Processed,
    /// At `confirmed` (or `finalized`) commitment.
    Confirmed,
}

#[async_trait]
pub trait ChainRpc: Send + Sync {
    async fn get_account_data(&self, key: &Pubkey) -> Result<Option<Vec<u8>>, RpcError>;
    async fn latest_blockhash(&self) -> Result<Hash, RpcError>;
    async fn simulate(&self, tx: &Transaction) -> Result<Simulation, RpcError>;
    async fn send(&self, tx: &Transaction) -> Result<Signature, RpcError>;
    /// Always searches transaction history (crash recovery relies on it).
    async fn signature_status(&self, sig: &Signature) -> Result<SigStatus, RpcError>;
    async fn balance(&self, key: &Pubkey) -> Result<u64, RpcError>;
    /// All seat accounts of a match (getProgramAccounts memcmp on match_key).
    async fn seat_accounts(
        &self,
        program_id: &Pubkey,
        match_key: &Pubkey,
    ) -> Result<Vec<(Pubkey, SeatAccountData)>, RpcError>;
}

pub struct FailoverRpc {
    primary: RpcClient,
    secondary: Option<RpcClient>,
}

impl FailoverRpc {
    pub fn new(primary_url: &str, secondary_url: Option<&str>) -> Self {
        Self {
            primary: RpcClient::new_with_commitment(
                primary_url.to_string(),
                CommitmentConfig::confirmed(),
            ),
            secondary: secondary_url.map(|u| {
                RpcClient::new_with_commitment(u.to_string(), CommitmentConfig::confirmed())
            }),
        }
    }

    fn clients(&self) -> impl Iterator<Item = &RpcClient> {
        std::iter::once(&self.primary).chain(self.secondary.as_ref())
    }
}

macro_rules! failover {
    ($self:ident, $client:ident, $body:expr) => {{
        let mut last_err = RpcError("no rpc endpoints".into());
        for $client in $self.clients() {
            match $body {
                Ok(v) => return Ok(v),
                Err(e) => last_err = RpcError(e.to_string()),
            }
        }
        Err(last_err)
    }};
}

#[async_trait]
impl ChainRpc for FailoverRpc {
    async fn get_account_data(&self, key: &Pubkey) -> Result<Option<Vec<u8>>, RpcError> {
        failover!(self, client, {
            client
                .get_account_with_commitment(key, CommitmentConfig::confirmed())
                .await
                .map(|resp| resp.value.map(|a| a.data))
        })
    }

    async fn latest_blockhash(&self) -> Result<Hash, RpcError> {
        failover!(self, client, client.get_latest_blockhash().await)
    }

    async fn simulate(&self, tx: &Transaction) -> Result<Simulation, RpcError> {
        failover!(self, client, {
            client
                .simulate_transaction_with_config(
                    tx,
                    RpcSimulateTransactionConfig {
                        sig_verify: false,
                        replace_recent_blockhash: true,
                        commitment: Some(CommitmentConfig::confirmed()),
                        ..Default::default()
                    },
                )
                .await
                .map(|resp| Simulation {
                    err: resp.value.err.map(|e| format!("{e:?}")),
                    units_consumed: resp.value.units_consumed,
                    logs: resp.value.logs.unwrap_or_default(),
                })
        })
    }

    async fn send(&self, tx: &Transaction) -> Result<Signature, RpcError> {
        // Simulated explicitly before send; skip the duplicate preflight.
        failover!(self, client, {
            client
                .send_transaction_with_config(
                    tx,
                    RpcSendTransactionConfig {
                        skip_preflight: true,
                        ..Default::default()
                    },
                )
                .await
        })
    }

    async fn signature_status(&self, sig: &Signature) -> Result<SigStatus, RpcError> {
        failover!(self, client, {
            client
                .get_signature_statuses_with_history(&[*sig])
                .await
                .map(|resp| match resp.value.into_iter().next().flatten() {
                    None => SigStatus::NotFound,
                    Some(status) => {
                        if let Some(err) = status.err {
                            SigStatus::Failed(format!("{err:?}"))
                        } else if matches!(
                            status.confirmation_status,
                            Some(TransactionConfirmationStatus::Confirmed)
                                | Some(TransactionConfirmationStatus::Finalized)
                        ) {
                            SigStatus::Confirmed
                        } else {
                            SigStatus::Processed
                        }
                    }
                })
        })
    }

    async fn balance(&self, key: &Pubkey) -> Result<u64, RpcError> {
        failover!(self, client, client.get_balance(key).await)
    }

    async fn seat_accounts(
        &self,
        program_id: &Pubkey,
        match_key: &Pubkey,
    ) -> Result<Vec<(Pubkey, SeatAccountData)>, RpcError> {
        failover!(self, client, {
            syndicate_chain::verify::enumerate_seats(client, program_id, match_key)
                .await
                .map_err(|e| RpcError(e.to_string()))
        })
    }
}
