//! # syndicate-timelock — time-lock encryption core
//!
//! Prediction sealing with **no key holder** and **automatic** decryption at match end
//! (`04_GAME_MECHANICS §12`). The locked scheme is drand `tlock` (League of Entropy):
//! a thin feature-gated impl of [`TimelockScheme`]. Here we keep the pure, testable
//! core: the **seal registry** that records ciphertexts *before LIVE* (binding — late
//! seals are rejected), and `decrypt_all` at match end, with a missing key surfaced as
//! VOID (`grace → refund`). A `MockScheme` proves binding + round-gating offline.

use std::collections::BTreeMap;

use syndicate_shared::{PlayerId, Price};

/// Real drand beacon client (fetch the round signature that unlocks predictions).
pub mod beacon;
pub use beacon::{round_at, BeaconClient, BeaconError, DrandInfo, DrandRound};

/// Real drand `tlock` IBE time-lock cipher (production [`TimelockScheme`]).
#[cfg(feature = "tlock")]
pub mod scheme_drand;
#[cfg(feature = "tlock")]
pub use scheme_drand::DrandTlockScheme;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TlError {
    /// A seal arrived after the registry was locked at LIVE — rejected (binding).
    SealAfterLock,
    /// The drand round key is not yet available — caller waits the grace period, then
    /// VOIDs + refunds (`04 §12`, risk A8).
    KeyUnavailable,
    /// A recorded ciphertext failed to decrypt/verify under the published key.
    DecryptFailed,
}

/// The round key published by the beacon at `target_round`. Opaque bytes; the scheme
/// interprets it. (For drand: the round signature.)
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RoundKey {
    pub round: u64,
    pub key: Vec<u8>,
}

/// Time-lock scheme: encrypt a price to a future round, decrypt once the round key is
/// public. Must be IND-CPA (ciphertext leaks nothing about a low-entropy price) and
/// have no escrowed key. Real impl: drand `tlock`.
pub trait TimelockScheme {
    /// Encrypt a fixed-point price toward `target_round`. (Used client-side; included
    /// here so sims/tests can produce valid ciphertexts.)
    fn encrypt(&self, price: Price, target_round: u64) -> Vec<u8>;
    /// Decrypt a ciphertext given the published round key. `None` if it doesn't verify.
    fn decrypt(&self, ciphertext: &[u8], key: &RoundKey) -> Option<Price>;
}

/// Records each player's sealed prediction and enforces pre-LIVE binding.
#[derive(Clone, Debug)]
pub struct SealRegistry {
    target_round: u64,
    locked: bool,
    sealed: BTreeMap<u16, Vec<u8>>,
}

impl SealRegistry {
    pub fn new(target_round: u64) -> Self {
        Self {
            target_round,
            locked: false,
            sealed: BTreeMap::new(),
        }
    }

    pub fn target_round(&self) -> u64 {
        self.target_round
    }

    /// Record a player's ciphertext. Allowed only before LIVE (`lock`), so no
    /// prediction can be added or changed after betting begins (`04 §12` binding).
    pub fn seal(&mut self, player: PlayerId, ciphertext: Vec<u8>) -> Result<(), TlError> {
        if self.locked {
            return Err(TlError::SealAfterLock);
        }
        self.sealed.insert(player.0, ciphertext);
        Ok(())
    }

    /// Freeze the registry at LIVE — no further seals accepted.
    pub fn lock(&mut self) {
        self.locked = true;
    }

    pub fn is_locked(&self) -> bool {
        self.locked
    }

    pub fn sealed_count(&self) -> usize {
        self.sealed.len()
    }

    /// Decrypt **all** sealed predictions at match end using the published round key.
    /// Errors if the key is unavailable (VOID/grace) or its round mismatches the target.
    pub fn decrypt_all<S: TimelockScheme>(
        &self,
        scheme: &S,
        key: Option<&RoundKey>,
    ) -> Result<BTreeMap<PlayerId, Price>, TlError> {
        let key = key.ok_or(TlError::KeyUnavailable)?;
        if key.round != self.target_round {
            return Err(TlError::KeyUnavailable);
        }
        let mut out = BTreeMap::new();
        for (id, ct) in &self.sealed {
            let p = scheme.decrypt(ct, key).ok_or(TlError::DecryptFailed)?;
            out.insert(PlayerId(*id), p);
        }
        Ok(out)
    }
}

/// Deterministic mock scheme for tests: a ciphertext is `[round_le(8) | price_le(16)]`;
/// decryption succeeds only when the key's round matches the embedded round. This
/// captures the two properties that matter for the core: round-gating and binding. It
/// is NOT secure and is test-only (the real scheme is drand `tlock`).
pub struct MockScheme;

impl TimelockScheme for MockScheme {
    fn encrypt(&self, price: Price, target_round: u64) -> Vec<u8> {
        let mut v = target_round.to_le_bytes().to_vec();
        v.extend_from_slice(&price.to_le_bytes());
        v
    }

    fn decrypt(&self, ciphertext: &[u8], key: &RoundKey) -> Option<Price> {
        if ciphertext.len() != 24 {
            return None;
        }
        let round = u64::from_le_bytes(ciphertext[0..8].try_into().ok()?);
        if round != key.round {
            return None; // key for the wrong round can't open it
        }
        let price = i128::from_le_bytes(ciphertext[8..24].try_into().ok()?);
        Some(price)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pid(n: u16) -> PlayerId {
        PlayerId(n)
    }

    #[test]
    fn seal_before_lock_then_decrypt_round_trips() {
        let scheme = MockScheme;
        let mut reg = SealRegistry::new(42);
        reg.seal(pid(0), scheme.encrypt(105_000, 42)).unwrap();
        reg.seal(pid(1), scheme.encrypt(104_800, 42)).unwrap();
        reg.lock();
        let key = RoundKey {
            round: 42,
            key: vec![0xAB],
        };
        let out = reg.decrypt_all(&scheme, Some(&key)).unwrap();
        assert_eq!(out.get(&pid(0)), Some(&105_000));
        assert_eq!(out.get(&pid(1)), Some(&104_800));
    }

    #[test]
    fn seal_after_lock_is_rejected_binding() {
        let scheme = MockScheme;
        let mut reg = SealRegistry::new(7);
        reg.lock();
        assert_eq!(
            reg.seal(pid(0), scheme.encrypt(1, 7)),
            Err(TlError::SealAfterLock)
        );
    }

    #[test]
    fn missing_key_voids() {
        let scheme = MockScheme;
        let mut reg = SealRegistry::new(7);
        reg.seal(pid(0), scheme.encrypt(1, 7)).unwrap();
        reg.lock();
        assert_eq!(reg.decrypt_all(&scheme, None), Err(TlError::KeyUnavailable));
    }

    #[test]
    fn wrong_round_key_cannot_open() {
        let scheme = MockScheme;
        let mut reg = SealRegistry::new(7);
        reg.seal(pid(0), scheme.encrypt(123, 7)).unwrap();
        reg.lock();
        let wrong = RoundKey {
            round: 8,
            key: vec![],
        };
        assert_eq!(
            reg.decrypt_all(&scheme, Some(&wrong)),
            Err(TlError::KeyUnavailable)
        );
    }
}
