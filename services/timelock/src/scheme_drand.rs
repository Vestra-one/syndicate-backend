//! Real drand **`tlock`** time-lock encryption — the production [`TimelockScheme`].
//!
//! This is the actual IBE (identity-based encryption) over BLS12-381 used by drand's
//! timelock scheme (`04 §12`, `08 OQ3`), via the `tlock_age` crate. A prediction is
//! encrypted toward a future drand round; that round's published BLS **signature** (the
//! [`RoundKey`], fetched by [`crate::beacon`]) is the decryption key. No key holder
//! exists until the beacon publishes the round — exactly the no-privilege guarantee.
//!
//! Behind the `tlock` feature (pulls the BLS crypto). The live round-trip test (below,
//! gated on `tlock` + `net`) exercises this against the real drand beacon.

use crate::{RoundKey, TimelockScheme};
use syndicate_shared::Price;

/// Encrypts/decrypts predictions against a specific drand chain.
pub struct DrandTlockScheme {
    chain_hash: Vec<u8>,
    public_key: Vec<u8>,
}

impl DrandTlockScheme {
    /// `chain_hash` and `public_key` come from the beacon's `/info` (hex-decoded).
    pub fn new(chain_hash: Vec<u8>, public_key: Vec<u8>) -> Self {
        Self { chain_hash, public_key }
    }
}

impl TimelockScheme for DrandTlockScheme {
    fn encrypt(&self, price: Price, target_round: u64) -> Vec<u8> {
        let plaintext = price.to_le_bytes(); // 16 bytes, fixed-point
        let mut ct = Vec::new();
        tlock_age::encrypt(&mut ct, &plaintext[..], &self.chain_hash, &self.public_key, target_round)
            .expect("tlock encryption with valid chain params must not fail");
        ct
    }

    fn decrypt(&self, ciphertext: &[u8], key: &RoundKey) -> Option<Price> {
        let mut pt = Vec::new();
        tlock_age::decrypt(&mut pt, ciphertext, &self.chain_hash, &key.key).ok()?;
        let arr: [u8; 16] = pt.try_into().ok()?;
        Some(i128::from_le_bytes(arr))
    }
}

#[cfg(all(test, feature = "net"))]
mod live_tests {
    use super::*;
    use crate::beacon::{hex_to_bytes, BeaconClient, HttpBeaconClient};

    /// Real end-to-end against the live drand quicknet beacon: encrypt a sealed
    /// prediction toward a round, fetch that round's real BLS signature, and decrypt.
    /// Proves the production cipher works with genuine drand data (`04 §12`).
    #[test]
    fn live_drand_quicknet_round_trip() {
        let client = HttpBeaconClient::mainnet_quicknet();
        let info = client.info().expect("fetch drand /info");

        // Encrypt toward a recent PAST round so its signature is already published.
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs();
        let target = crate::beacon::round_at(info.genesis_time, info.period, now).saturating_sub(5).max(1);
        let round = client.round(target).expect("fetch round signature");

        let scheme = DrandTlockScheme::new(
            hex_to_bytes(&info.hash).expect("chain hash hex"),
            hex_to_bytes(&info.public_key).expect("public key hex"),
        );

        let secret: Price = 10_754_273; // a sealed prediction (fixed-point)
        let ciphertext = scheme.encrypt(secret, round.round);
        let key = round.to_round_key().expect("round key");
        let recovered = scheme.decrypt(&ciphertext, &key).expect("decrypt with real drand signature");

        assert_eq!(recovered, secret);
    }
}
