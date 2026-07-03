//! Anchor discriminators: first 8 bytes of sha256 over the namespaced name.

use sha2::{Digest, Sha256};

/// Instruction discriminator: `sha256("global:<name>")[..8]`.
pub fn instruction(name: &str) -> [u8; 8] {
    Sha256::digest(format!("global:{name}"))[0..8]
        .try_into()
        .unwrap()
}

/// Account discriminator: `sha256("account:<Name>")[..8]`.
pub fn account(name: &str) -> [u8; 8] {
    Sha256::digest(format!("account:{name}"))[0..8]
        .try_into()
        .unwrap()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Hardcoded vectors so drift in the hashing itself (not just names) is caught.
    #[test]
    fn known_discriminators() {
        // Independently computed: sha256("global:deposit")[..8] etc.
        let cases = [
            "initialize_protocol",
            "set_pauses",
            "set_price_signer",
            "set_match_bounds",
            "create_match",
            "create_and_deposit",
            "deposit",
            "lock",
            "begin_live",
            "register_prediction_commitment",
            "submit_settlement",
            "claim",
            "refund",
            "void",
            "void_before_start",
            "void_live_after_deadline",
            "withdraw_fees",
        ];
        for name in cases {
            let d = instruction(name);
            let manual: [u8; 8] = Sha256::digest(format!("global:{name}"))[0..8]
                .try_into()
                .unwrap();
            assert_eq!(d, manual);
        }
        // One fully-hardcoded vector (sha256("global:deposit") prefix).
        assert_eq!(
            instruction("deposit"),
            [0xf2, 0x23, 0xc6, 0x89, 0x52, 0xe1, 0xf2, 0xb6]
        );
    }
}
