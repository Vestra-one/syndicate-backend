# Service: `timelock` — Time-Lock Encryption (Seal & Auto-Decrypt)

**Stack:** Rust. **Trust role:** guarantees no prediction is readable before match end, with **no key holder**. **Implements:** `04 §0(invariant 2),§12`; `06 §2`; decision `08 OQ3`.

> Locked scheme: **drand `tlock`** (League of Entropy) to a beacon round at `timelock_target` (match end). Sealing produces an IND-CPA ciphertext that the operator/backend cannot decrypt; the decryption key is published by drand at the target round, opening **all** predictions automatically. This eliminates the entire non-reveal/disconnect-at-showdown failure class.

---

## Responsibilities (owns)
- **Seal verification at SEALING:** accept each player's `tlock` ciphertext (sealed to `timelock_target`), record it (and its submission proof) **before LIVE**; broadcast ciphertext hash so all players see everyone sealed.
- **Key retrieval at match end:** fetch the drand round signature/key for `timelock_target`.
- **Deterministic decryption** of all sealed predictions; **binding check** that each plaintext matches the pre-LIVE ciphertext.
- **Beacon-liveness handling:** if the key is unavailable past the **~60s grace** (configurable), signal VOID + full refund.
- Provide decrypted predictions (and verification artifacts) to `settlement`/`programs`.

## Non-responsibilities
- No winner/pot math (→ `shared`); no custody; no gameplay; no oracle sampling.
- Does **not** hold any decryption key — none exists until drand publishes it (this is the core guarantee).

## Internal structure (suggested)
```
timelock/src/
  scheme/         # tlock encrypt-verify, round mapping for timelock_target
  beacon/         # drand client (fetch round key), health/liveness
  seal/           # record + hash + broadcast ciphertexts (pre-LIVE binding)
  decrypt/        # decrypt all + binding verification at match end
  main.rs
```

## Interfaces
- **In:** sealed ciphertexts (via `gateway`/client at SEALING); `timelock_target` + grace from `config`; match-end trigger from `match-engine`.
- **Out:** seal receipts (hash) to players; decrypted predictions + binding proofs to `settlement`/`programs`; VOID signal on key-unavailability.

## Invariants & failure modes
- **Concealment:** nothing decryptable before `timelock_target` — not by the operator, not by anyone (`04 §0`).
- **Binding:** ciphertexts are fixed before LIVE; post-LIVE submissions are rejected.
- **All open at end:** every sealed prediction (incl. folded/early-out) becomes decryptable — by design, fueling the post-match reveal (`08 OQ9`).
- Key unavailable past grace → VOID + full refund, no fees (`04 §12`, risk A8).

## Dependencies
external drand beacon, `config`, `shared` (types), consumed by `settlement`/`programs`.

## Testing
- Encrypt→(round key)→decrypt round-trip; binding rejects altered/late ciphertexts.
- IND-CPA expectation: ciphertext leaks nothing about a low-entropy price (no early recovery).
- Beacon-failure simulation: missing/late key → grace → VOID.
- Determinism: decrypted set + binding proofs replay identically in `programs`.

## AI-agent rules
- Never introduce a key escrow or any path that lets the backend decrypt early — that breaks the product's core guarantee.
- Keep the scheme behind an interface (drand `tlock` default) so it is swappable, but default and grace come from `config`.
- Key-availability ambiguity → VOID, never a stalled or guessed settlement.
