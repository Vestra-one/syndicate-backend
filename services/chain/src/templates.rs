//! Language-neutral instruction descriptors for the frontend: JSON-friendly account
//! lists + base58 data, so the FE can assemble transactions without re-deriving PDAs or
//! Borsh layouts. (The FE may equally build from the IDL; these are a convenience.)

use serde::Serialize;
use solana_sdk::instruction::Instruction;

#[derive(Serialize, Clone, Debug)]
pub struct AccountMetaJson {
    pub pubkey: String,
    pub is_signer: bool,
    pub is_writable: bool,
}

#[derive(Serialize, Clone, Debug)]
pub struct InstructionJson {
    pub program_id: String,
    pub accounts: Vec<AccountMetaJson>,
    /// Base58-encoded instruction data (discriminator + Borsh args).
    pub data_b58: String,
}

impl From<&Instruction> for InstructionJson {
    fn from(ix: &Instruction) -> Self {
        InstructionJson {
            program_id: ix.program_id.to_string(),
            accounts: ix
                .accounts
                .iter()
                .map(|a| AccountMetaJson {
                    pubkey: a.pubkey.to_string(),
                    is_signer: a.is_signer,
                    is_writable: a.is_writable,
                })
                .collect(),
            data_b58: bs58::encode(&ix.data).into_string(),
        }
    }
}
