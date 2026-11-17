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
    if verifying_key.verify(message, &sig).is_ok() {
        return Ok(());
    }
    let wallet_safe_message = bs58::encode(message).into_string();
    verifying_key
        .verify(wallet_safe_message.as_bytes(), &sig)
        .map_err(|_| VerifyError::InvalidSignature)
}

/// Verify a base64 ed25519 signature against a raw 32-byte public key. Like
/// [`verify_ed25519`], accepts a signature over the raw message or over its base58 text.
pub fn verify_ed25519_key(
    pubkey: &[u8; 32],
    message: &[u8],
    signature_b64: &str,
) -> Result<(), VerifyError> {
    verify_ed25519(&bs58::encode(pubkey).into_string(), message, signature_b64)
}

/// Longest life a session key may be granted for.
pub const SESSION_KEY_MAX_TTL_MS: u64 = 24 * 60 * 60 * 1000;

/// The human-readable grant a wallet signs ONCE per match to delegate its gameplay
/// signatures (actions, default policy, seal upload) to an ephemeral browser key, so the
/// player is not prompted on every move. The text is shown verbatim by the wallet, which
/// is why it is prose and not opaque bytes. It delegates nothing on-chain: deposits,
/// seal commitments, claims and refunds remain wallet-signed transactions.
pub fn session_key_grant_message(
    onchain_match_id: u64,
    wallet: &str,
    session_pubkey: &[u8; 32],
    expires_at_ms: u64,
) -> String {
    format!(
        "Satoshi's Table — one-tap play\n\n\
         Let this browser make your moves in this match (bet, check, call, fold, seal) \
         without asking you to sign each one. It cannot move your funds.\n\n\
         match: {onchain_match_id}\n\
         wallet: {wallet}\n\
         session key: {}\n\
         expires: {expires_at_ms}",
        bs58::encode(session_pubkey).into_string()
    )
}

/// Verify the wallet's signature over [`session_key_grant_message`].
pub fn verify_session_key_grant(
    wallet: &str,
    signature_b64: &str,
    onchain_match_id: u64,
    session_pubkey: &[u8; 32],
    expires_at_ms: u64,
) -> Result<(), VerifyError> {
    let msg = session_key_grant_message(onchain_match_id, wallet, session_pubkey, expires_at_ms);
    verify_ed25519(wallet, msg.as_bytes(), signature_b64)
}

#[allow(clippy::too_many_arguments)]
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
    timelock_target: u64,
    commitment: &[u8; 32],
) -> Result<(), VerifyError> {
    let pk = decode_wallet_pubkey(wallet)?;
    let msg = intent::prediction_commitment_message(
        match_id,
        onchain_match_id,
        seat_index,
        &pk,
        timelock_target,
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

    #[test]
    fn action_intent_accepts_wallet_safe_base58_text_signature() {
        let (wallet, sk) = test_wallet();
        let pk = decode_wallet_pubkey(&wallet).unwrap();
        let head = [3u8; 32];
        let msg =
            intent::action_intent_message(1, 42, 0, &pk, 7, &head, intent::ACTION_TAG_RAISE_TO, 40);
        let wallet_safe_msg = bs58::encode(&msg).into_string();
        let sig_b64 = base64::Engine::encode(
            &base64::engine::general_purpose::STANDARD,
            sk.sign(wallet_safe_msg.as_bytes()).to_bytes(),
        );

        verify_action_intent(
            &wallet,
            &sig_b64,
            1,
            42,
            0,
            7,
            &head,
            intent::ACTION_TAG_RAISE_TO,
            40,
        )
        .unwrap();
    }

    #[test]
    fn default_policy_accepts_wallet_safe_base58_text_signature() {
        let (wallet, sk) = test_wallet();
        let pk = decode_wallet_pubkey(&wallet).unwrap();
        let msg = intent::default_policy_message(1, 42, 0, &pk, intent::DEFAULT_TAG_CHECK_FOLD);
        let wallet_safe_msg = bs58::encode(&msg).into_string();
        let sig_b64 = base64::Engine::encode(
            &base64::engine::general_purpose::STANDARD,
            sk.sign(wallet_safe_msg.as_bytes()).to_bytes(),
        );

        verify_default_policy(&wallet, &sig_b64, 1, 42, 0, intent::DEFAULT_TAG_CHECK_FOLD).unwrap();
    }

    #[test]
    fn session_key_grant_round_trips_and_binds_every_field() {
        let (wallet, sk) = test_wallet();
        let session = SigningKey::from_bytes(&[9u8; 32]);
        let session_pk = session.verifying_key().to_bytes();
        let msg = session_key_grant_message(42, &wallet, &session_pk, 1_000);
        // Byte-exact vector shared with the web client (apps/web/src/lib/sessionKey.test.ts).
        assert_eq!(
            msg,
            format!(
                "Satoshi's Table — one-tap play\n\nLet this browser make your moves in this match (bet, check, call, fold, seal) without asking you to sign each one. It cannot move your funds.\n\nmatch: 42\nwallet: {wallet}\nsession key: {}\nexpires: 1000",
                bs58::encode(session_pk).into_string()
            )
        );
        let sig = base64::Engine::encode(
            &base64::engine::general_purpose::STANDARD,
            sk.sign(msg.as_bytes()).to_bytes(),
        );
        verify_session_key_grant(&wallet, &sig, 42, &session_pk, 1_000).unwrap();
        // Any changed field invalidates the grant.
        assert!(verify_session_key_grant(&wallet, &sig, 43, &session_pk, 1_000).is_err());
        assert!(verify_session_key_grant(&wallet, &sig, 42, &session_pk, 1_001).is_err());
        assert!(verify_session_key_grant(&wallet, &sig, 42, &[1u8; 32], 1_000).is_err());
        // The session key can sign for itself via the raw-key verifier.
        let intent_sig = base64::Engine::encode(
            &base64::engine::general_purpose::STANDARD,
            session.sign(b"intent").to_bytes(),
        );
        verify_ed25519_key(&session_pk, b"intent", &intent_sig).unwrap();
        assert!(verify_ed25519_key(&session_pk, b"other", &intent_sig).is_err());
    }

    #[test]
    fn unrelated_wallet_safe_text_signature_is_rejected() {
        let (wallet, sk) = test_wallet();
        let pk = decode_wallet_pubkey(&wallet).unwrap();
        let head = [0u8; 32];
        let msg =
            intent::action_intent_message(1, 42, 0, &pk, 1, &head, intent::ACTION_TAG_CALL, 0);
        let sig_b64 = base64::Engine::encode(
            &base64::engine::general_purpose::STANDARD,
            sk.sign(bs58::encode(b"not this intent").into_string().as_bytes())
                .to_bytes(),
        );

        assert!(verify_ed25519(&wallet, &msg, &sig_b64).is_err());
    }
}
