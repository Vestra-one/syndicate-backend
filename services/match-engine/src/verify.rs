//! ed25519 signature verification for player intents (Solana wallet = ed25519 pubkey).

use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use syndicate_shared::intent;

#[derive(Debug)]
pub enum VerifyError {
    InvalidWallet,
    InvalidSignature,
    BadEncoding,
}

pub fn decode_wallet_pubkey(wallet: &str) -> Result<[u8; 32], VerifyError> {
    let bytes = bs58::decode(wallet)
        .into_vec()
        .map_err(|_| VerifyError::InvalidWallet)?;
    if bytes.len() != 32 {
        return Err(VerifyError::InvalidWallet);
    }
    let mut out = [0u8; 32];
    out.copy_from_slice(&bytes);
    Ok(out)
}

pub fn verify_ed25519(
    wallet: &str,
    message: &[u8],
    signature_b64: &str,
) -> Result<(), VerifyError> {
    let pk_bytes = decode_wallet_pubkey(wallet)?;
    let verifying_key =
        VerifyingKey::from_bytes(&pk_bytes).map_err(|_| VerifyError::InvalidWallet)?;
    let sig_bytes = base64::Engine::decode(
        &base64::engine::general_purpose::STANDARD,
        signature_b64.trim(),
    )
    .map_err(|_| VerifyError::BadEncoding)?;
    let sig = Signature::from_slice(&sig_bytes).map_err(|_| VerifyError::InvalidSignature)?;
    verifying_key
        .verify(message, &sig)
        .map_err(|_| VerifyError::InvalidSignature)
}

pub fn verify_action_intent(
    wallet: &str,
    signature_b64: &str,
    match_id: u64,
    onchain_match_id: u64,
    seat_index: u16,
    nonce: u64,
    prev_head: &[u8; 32],
    action_tag: u8,
    amount: u64,
) -> Result<(), VerifyError> {
    let pk = decode_wallet_pubkey(wallet)?;
    let msg = intent::action_intent_message(
        match_id,
        onchain_match_id,
        seat_index,
        &pk,
        nonce,
        prev_head,
        action_tag,
        amount,
    );
    verify_ed25519(wallet, &msg, signature_b64)
}

pub fn verify_default_policy(
    wallet: &str,
    signature_b64: &str,
    match_id: u64,
    onchain_match_id: u64,
    seat_index: u16,
    policy_tag: u8,
) -> Result<(), VerifyError> {
    let pk = decode_wallet_pubkey(wallet)?;
    let msg =
        intent::default_policy_message(match_id, onchain_match_id, seat_index, &pk, policy_tag);
    verify_ed25519(wallet, &msg, signature_b64)
}

pub fn verify_prediction_commitment(
    wallet: &str,
    signature_b64: &str,
    match_id: u64,
    onchain_match_id: u64,
    seat_index: u16,
    seal_seq: u64,
    commitment: &[u8; 32],
) -> Result<(), VerifyError> {
    let pk = decode_wallet_pubkey(wallet)?;
    let msg = intent::prediction_commitment_message(
        match_id,
        onchain_match_id,
        seat_index,
        &pk,
        seal_seq,
        commitment,
    );
    verify_ed25519(wallet, &msg, signature_b64)
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};

    fn test_wallet() -> (String, SigningKey) {
        let sk = SigningKey::from_bytes(&[7u8; 32]);
        let vk = sk.verifying_key();
        let wallet = bs58::encode(vk.as_bytes()).into_string();
        (wallet, sk)
    }

    #[test]
    fn roundtrip_action_intent() {
        let (wallet, sk) = test_wallet();
        let pk = decode_wallet_pubkey(&wallet).unwrap();
        let head = [0u8; 32];
        let msg =
            intent::action_intent_message(1, 42, 0, &pk, 1, &head, intent::ACTION_TAG_CALL, 0);
        let sig = bs58::encode(sk.sign(&msg).to_bytes()).into_string();
        // use base64 for production path
        let sig_b64 = base64::Engine::encode(
            &base64::engine::general_purpose::STANDARD,
            sk.sign(&msg).to_bytes(),
        );
        verify_action_intent(
            &wallet,
            &sig_b64,
            1,
            42,
            0,
            1,
            &head,
            intent::ACTION_TAG_CALL,
            0,
        )
        .unwrap();
        let _ = sig;
    }
}
