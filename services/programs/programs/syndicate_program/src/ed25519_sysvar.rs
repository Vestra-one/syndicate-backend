//! Verify Ed25519 native-program instructions via the Instructions sysvar.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::pubkey;
use anchor_lang::solana_program::sysvar::instructions::{
    load_instruction_at_checked, ID as INSTRUCTIONS_SYSVAR_ID,
};

use crate::error::SyndicateError;

const ED25519_PROGRAM_ID: Pubkey = pubkey!("Ed25519SigVerify111111111111111111111111111");

const ED25519_HEADER_LEN: usize = 2;
const ED25519_SIG_LEN: usize = 64;
const ED25519_PUBKEY_LEN: usize = 32;

/// Confirms instruction `ed25519_ix_index` is an Ed25519 verify for `expected_pubkey`
/// over `expected_message`. The native program already performed the crypto check.
pub fn verify_ed25519_instruction(
    instructions_sysvar: &AccountInfo,
    ed25519_ix_index: u8,
    expected_pubkey: &Pubkey,
    expected_message: &[u8],
) -> Result<()> {
    let ix = load_instruction_at_checked(ed25519_ix_index as usize, instructions_sysvar)
        .map_err(|_| error!(SyndicateError::InvalidSignature))?;
    require_keys_eq!(
        ix.program_id,
        ED25519_PROGRAM_ID,
        SyndicateError::InvalidSignature
    );
    require!(
        !ix.accounts.is_empty(),
        SyndicateError::InvalidSignature
    );
    require_keys_eq!(
        ix.accounts[0].pubkey,
        INSTRUCTIONS_SYSVAR_ID,
        SyndicateError::InvalidSignature
    );

    let data = ix.data.as_slice();
    require!(data.len() >= 16, SyndicateError::InvalidSignature);
    let num_sigs = data[0];
    require!(num_sigs == 1, SyndicateError::InvalidSignature);

    let sig_offset = u16::from_le_bytes([data[2], data[3]]) as usize;
    let pubkey_offset = u16::from_le_bytes([data[6], data[7]]) as usize;
    let msg_offset = u16::from_le_bytes([data[10], data[11]]) as usize;
    let msg_size = u16::from_le_bytes([data[12], data[13]]) as usize;

    require!(
        data.len() >= msg_offset + msg_size,
        SyndicateError::InvalidSignature
    );
    require!(
        data.len() >= pubkey_offset + ED25519_PUBKEY_LEN,
        SyndicateError::InvalidSignature
    );
    require!(
        data.len() >= sig_offset + ED25519_SIG_LEN,
        SyndicateError::InvalidSignature
    );

    let pubkey = Pubkey::new_from_array(
        data[pubkey_offset..pubkey_offset + ED25519_PUBKEY_LEN]
            .try_into()
            .map_err(|_| error!(SyndicateError::InvalidSignature))?,
    );
    require_keys_eq!(pubkey, *expected_pubkey, SyndicateError::InvalidSignature);

    let message = &data[msg_offset..msg_offset + msg_size];
    require!(message == expected_message, SyndicateError::InvalidSignature);
    let _ = sig_offset;
    let _ = ED25519_HEADER_LEN;
    Ok(())
}
