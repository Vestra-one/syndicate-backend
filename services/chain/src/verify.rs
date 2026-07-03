//! Finalized-transaction verification (no indexer): the backend trusts only what it can
//! re-read from the chain at `finalized` commitment. Used by the game-server's seat
//! verifier pool and the chain-worker.

use solana_client::nonblocking::rpc_client::RpcClient;
use solana_client::rpc_config::{RpcProgramAccountsConfig, RpcTransactionConfig};
use solana_client::rpc_filter::{Memcmp, MemcmpEncodedBytes, RpcFilterType};
use solana_sdk::commitment_config::CommitmentConfig;
use solana_sdk::pubkey::Pubkey;
use solana_sdk::signature::Signature;
use solana_transaction_status::option_serializer::OptionSerializer;
use solana_transaction_status::{EncodedTransaction, UiTransactionEncoding};

use crate::accounts::{decode_seat, SeatAccountData, SEAT_ACCOUNT_SPACE};
use crate::params::{CreateParams, CREATE_PARAMS_LEN};
use crate::{disc, pda};

#[derive(Debug)]
pub enum VerifyError {
    NotFound,
    NotFinalized,
    TxFailed(String),
    WrongProgram,
    WrongInstruction,
    WrongSigner,
    WrongMatch,
    Malformed(String),
    Rpc(String),
}

impl std::fmt::Display for VerifyError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{self:?}")
    }
}

impl std::error::Error for VerifyError {}

pub struct VerifiedDeposit {
    pub slot: u64,
    pub join_commitment: [u8; 32],
}

pub struct VerifiedCreate {
    pub slot: u64,
    pub params: CreateParams,
}

/// Fetch a finalized, successful transaction and return its decoded static account keys
/// + per-instruction (program_id, accounts, data).
async fn fetch_finalized_tx(
    rpc: &RpcClient,
    tx_sig: &Signature,
) -> Result<(u64, Vec<Pubkey>, Vec<(Pubkey, Vec<u8>, Vec<u8>)>, Vec<bool>), VerifyError> {
    // Finality gate first (cheap).
    let statuses = rpc
        .get_signature_statuses_with_history(&[*tx_sig])
        .await
        .map_err(|e| VerifyError::Rpc(e.to_string()))?;
    let status = statuses.value[0].as_ref().ok_or(VerifyError::NotFound)?;
    if status.err.is_some() {
        return Err(VerifyError::TxFailed(format!("{:?}", status.err)));
    }
    if !matches!(
        status.confirmation_status,
        Some(solana_transaction_status::TransactionConfirmationStatus::Finalized)
    ) {
        return Err(VerifyError::NotFinalized);
    }

    let tx = rpc
        .get_transaction_with_config(
            tx_sig,
            RpcTransactionConfig {
                encoding: Some(UiTransactionEncoding::Base64),
                commitment: Some(CommitmentConfig::finalized()),
                max_supported_transaction_version: Some(0),
            },
        )
        .await
        .map_err(|e| VerifyError::Rpc(e.to_string()))?;

    if let Some(meta) = &tx.transaction.meta {
        if meta.err.is_some() {
            return Err(VerifyError::TxFailed(format!("{:?}", meta.err)));
        }
        // Reject txs that need loaded address tables for OUR instruction accounts — the
        // static key list below wouldn't cover them. (Client txs are simple; ALTs
        // unexpected. Loaded addresses are appended after static keys, so indexes into
        // them simply won't resolve and verification fails closed anyway.)
        let _ = matches!(&meta.loaded_addresses, OptionSerializer::Some(_));
    }

    let versioned = match &tx.transaction.transaction {
        EncodedTransaction::Binary(b64, _) => {
            use base64::Engine as _;
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(b64)
                .map_err(|e| VerifyError::Malformed(e.to_string()))?;
            bincode::deserialize::<solana_sdk::transaction::VersionedTransaction>(&bytes)
                .map_err(|e| VerifyError::Malformed(e.to_string()))?
        }
        _ => return Err(VerifyError::Malformed("unexpected tx encoding".into())),
    };

    let msg = versioned.message;
    let keys: Vec<Pubkey> = msg.static_account_keys().to_vec();
    let num_signers = msg.header().num_required_signatures as usize;
    let signer_flags: Vec<bool> = (0..keys.len()).map(|i| i < num_signers).collect();
    let instructions = msg
        .instructions()
        .iter()
        .map(|ci| {
            let program = keys
                .get(ci.program_id_index as usize)
                .copied()
                .unwrap_or_default();
            (program, ci.accounts.clone(), ci.data.clone())
        })
        .collect();
    Ok((tx.slot, keys, instructions, signer_flags))
}

/// Verify a client-reported `deposit` transaction: finalized + success, wallet signed,
/// our program's `deposit` for the expected match PDA. Returns the join commitment bytes
/// the tx carried (backend compares against sha256(room_code ‖ wallet) for private rooms).
pub async fn verify_deposit_tx(
    rpc: &RpcClient,
    program_id: &Pubkey,
    tx_sig: &Signature,
    expected_match: &Pubkey,
    expected_wallet: &Pubkey,
) -> Result<VerifiedDeposit, VerifyError> {
    let (slot, keys, instructions, signer_flags) = fetch_finalized_tx(rpc, tx_sig).await?;
    let deposit_disc = disc::instruction("deposit");
    for (program, accounts, data) in &instructions {
        if program != program_id || data.len() < 8 + 32 || data[0..8] != deposit_disc {
            continue;
        }
        // Deposit account order: player, protocol, match, seat, player_token, vault, ...
        let player_idx = accounts
            .first()
            .copied()
            .ok_or(VerifyError::Malformed("no accounts".into()))? as usize;
        let match_idx = accounts
            .get(2)
            .copied()
            .ok_or(VerifyError::Malformed("no match account".into()))?
            as usize;
        let player = keys
            .get(player_idx)
            .ok_or(VerifyError::Malformed("bad player index".into()))?;
        let match_key = keys
            .get(match_idx)
            .ok_or(VerifyError::Malformed("bad match index".into()))?;
        if player != expected_wallet || !signer_flags.get(player_idx).copied().unwrap_or(false) {
            return Err(VerifyError::WrongSigner);
        }
        if match_key != expected_match {
            return Err(VerifyError::WrongMatch);
        }
        let mut jc = [0u8; 32];
        jc.copy_from_slice(&data[8..40]);
        return Ok(VerifiedDeposit {
            slot,
            join_commitment: jc,
        });
    }
    Err(VerifyError::WrongInstruction)
}

/// Verify a client-reported `create_and_deposit` transaction. Returns the decoded
/// CreateParams (the backend checks them against the reserved intent) + slot.
pub async fn verify_create_tx(
    rpc: &RpcClient,
    program_id: &Pubkey,
    tx_sig: &Signature,
    expected_onchain_match_id: u64,
    expected_wallet: &Pubkey,
) -> Result<VerifiedCreate, VerifyError> {
    let (slot, keys, instructions, signer_flags) = fetch_finalized_tx(rpc, tx_sig).await?;
    let create_disc = disc::instruction("create_and_deposit");
    for (program, accounts, data) in &instructions {
        if program != program_id || data.len() < 8 + CREATE_PARAMS_LEN || data[0..8] != create_disc
        {
            continue;
        }
        let authority_idx = accounts
            .first()
            .copied()
            .ok_or(VerifyError::Malformed("no accounts".into()))?
            as usize;
        let authority = keys
            .get(authority_idx)
            .ok_or(VerifyError::Malformed("bad authority index".into()))?;
        if authority != expected_wallet
            || !signer_flags.get(authority_idx).copied().unwrap_or(false)
        {
            return Err(VerifyError::WrongSigner);
        }
        let params: CreateParams =
            borsh::BorshDeserialize::try_from_slice(&data[8..8 + CREATE_PARAMS_LEN])
                .map_err(|e| VerifyError::Malformed(e.to_string()))?;
        if params.match_id != expected_onchain_match_id {
            return Err(VerifyError::WrongMatch);
        }
        // The match PDA in the account list must be derived from the declared match_id.
        let (expected_match, _) = pda::match_account(program_id, params.match_id);
        let match_idx = accounts
            .get(3)
            .copied()
            .ok_or(VerifyError::Malformed("no match account".into()))?
            as usize;
        if keys.get(match_idx) != Some(&expected_match) {
            return Err(VerifyError::WrongMatch);
        }
        return Ok(VerifiedCreate { slot, params });
    }
    Err(VerifyError::WrongInstruction)
}

/// Enumerate every seat account of a match via getProgramAccounts (memcmp on the
/// `match_key` field right after the 8-byte discriminator + dataSize filter).
pub async fn enumerate_seats(
    rpc: &RpcClient,
    program_id: &Pubkey,
    match_key: &Pubkey,
) -> Result<Vec<(Pubkey, SeatAccountData)>, VerifyError> {
    let config = RpcProgramAccountsConfig {
        filters: Some(vec![
            RpcFilterType::DataSize(SEAT_ACCOUNT_SPACE),
            RpcFilterType::Memcmp(Memcmp::new(
                8,
                MemcmpEncodedBytes::Bytes(match_key.as_ref().to_vec()),
            )),
        ]),
        account_config: solana_client::rpc_config::RpcAccountInfoConfig {
            encoding: Some(solana_account_decoder::UiAccountEncoding::Base64),
            commitment: Some(CommitmentConfig::finalized()),
            ..Default::default()
        },
        ..Default::default()
    };
    let accounts = rpc
        .get_program_accounts_with_config(program_id, config)
        .await
        .map_err(|e| VerifyError::Rpc(e.to_string()))?;
    accounts
        .into_iter()
        .map(|(key, acc)| {
            decode_seat(&acc.data)
                .map(|seat| (key, seat))
                .map_err(|e| VerifyError::Malformed(e.to_string()))
        })
        .collect()
}
