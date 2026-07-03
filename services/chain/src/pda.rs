//! PDA derivations (v2 — no seat-index PDA).

use solana_sdk::pubkey::Pubkey;

pub fn protocol(program_id: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[b"protocol"], program_id)
}

pub fn match_account(program_id: &Pubkey, onchain_match_id: u64) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[b"match", &onchain_match_id.to_le_bytes()], program_id)
}

pub fn vault(program_id: &Pubkey, match_key: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[b"vault", match_key.as_ref()], program_id)
}

pub fn seat(program_id: &Pubkey, match_key: &Pubkey, player: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[b"seat", match_key.as_ref(), player.as_ref()], program_id)
}
