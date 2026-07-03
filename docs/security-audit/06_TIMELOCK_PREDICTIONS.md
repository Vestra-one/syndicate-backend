# 06 — Timelock + Prediction Commit/Reveal Audit

**Scope:** drand timelock encrypt/decrypt + beacon fetch (`services/timelock`), prediction
opening at settlement (`services/worker/src/timelock_open.rs`, `reconstruct.rs`), commitment
binding & winner math (`services/shared`, `services/settlement`), seal submission
(`services/match-engine`). **Threat model:** operator is trusted; attackers are malicious
players / external actors trying to learn or change predictions, commit ambiguously, grief a
void, or rig who-wins.

## Summary

The commit/reveal binding is **mostly sound on paper** — at settlement, each decrypted
prediction is re-hashed with its stored blinding and compared to the committed hash
(`settlement/src/lib.rs:147`), so a player cannot reveal a *different* plaintext than they
committed. Round-gating and "every seat must seal" are enforced. **However**, several real
weaknesses exist. The most serious is that the **drand beacon's BLS signature is never
verified** against the chain public key — `beacon.rs` trusts whatever the HTTP endpoint
returns as the IBE decryption key, so anyone who can MITM/spoof the drand response (or stand
up a rogue mirror via the `DRAND_API` env) can forge or withhold round keys, breaking both
hiding and liveness. Second, the **commitment hash is a homemade non-cryptographic FNV
construction** (`intent.rs:110-141`, misleadingly named `simple_sha256`), not collision- or
preimage-resistant, undermining the entire binding guarantee. Third, the **decrypted
prediction value is never range-checked** and winner distance is computed with an unchecked
`i128` subtraction (`settle.rs:185`), so an attacker-chosen extreme plaintext can panic the
worker (debug) or wrap the distance to manufacture a win (release). Fourth, there is **no
off-chain binding between the recorded timelock ciphertext and the on-chain commitment** —
the engine stores both independently and the worker never checks the ciphertext hashes to the
on-chain `prediction_commitment`.

| # | Severity | Title |
|---|----------|-------|
| 1 | **Critical** | drand round signature (BLS) never verified — forged/withheld beacon breaks hiding & liveness |
| 2 | **High** | Commitment uses non-cryptographic FNV hash (`simple_sha256`) — binding not preimage/collision resistant |
| 3 | **High** | Decrypted prediction not range-checked; `(pred - s)` i128 subtraction overflows → panic/DoS or rigged win |
| 4 | **High** | Ciphertext recorded off-chain is never bound to the on-chain commitment hash |
| 5 | **Medium** | `DRAND_API` / `DRAND_CHAIN_HASH` from env with public default — attacker-influenced endpoint = beacon substitution |
| 6 | **Medium** | `seal_seq` hardcoded to 0 — tie remainder ordering collapses to lowest-id, defeats earliest-seal rule |
| 7 | **Low** | Off-chain seal path has no phase/deadline gate; relies entirely on chain; last-write-wins overwrite in registry |
| 8 | **Low** | Dev-signature bypass (`allow_dev_signature`) gated only by env var; default ciphertext/commitment fallbacks in HTTP handler |
| 9 | **Info** | Verified controls: reveal↔commitment check, round-gating, all-seats-sealed, grace ≥ on-chain void grace, two-sided round bound |

---

## Findings

### 1. (Critical) drand round signature is never verified — forged or withheld beacon breaks hiding and liveness

**Files:** `services/timelock/src/beacon.rs:74-83, 127-149`;
`services/worker/src/timelock_open.rs:196-203`; `services/timelock/src/scheme_drand.rs:46-51`

**Proven.** `HttpBeaconClient::round` fetches `GET {api}/{chain}/public/{round}`, parses
`DrandRound { round, randomness, signature }`, and `to_round_key()` (`beacon.rs:77-83`) maps
the **raw `signature` hex straight into the IBE decryption key** with no check that the
signature is a valid BLS signature for that round under the chain's `public_key`. The chain
`public_key` is loaded into `DrandTlockScheme` (`timelock_open.rs:206-209`) but is used only
as the *encryption* IBE master key — `tlock_age::decrypt` (`scheme_drand.rs:48`) takes
`&key.key` (the round signature) as the decryption key and does the IBE pairing; it does
**not** independently verify the signature is the genuine beacon output for `round`. The
worker also computes `sha256_hex(&round.signature)` purely as a *receipt* (`timelock_open.rs:204`),
never as a verification.

drand's security model is exactly that the round signature *is* a BLS signature you must
verify (`BLS.Verify(public_key, H(round), signature)`); without that check the "signature"
is just attacker-controllable bytes.

**Attacker scenario:**
- *Hiding break / early reveal:* drand signatures for a round are publicly derivable only
  after the round publishes — but if an attacker can MITM the HTTP response (no TLS pinning;
  plain `ureq::get`) or influence `DRAND_API` (see finding 5), they could feed a signature
  that decrypts predictions. More practically, **because nothing ties the round key to the
  real beacon, an attacker who runs/poisons the endpoint can supply *any* round's real
  signature early**, or a crafted key, to open sealed predictions before match end.
- *Liveness/void grief:* feeding a malformed/wrong signature makes `tlock_age::decrypt`
  fail → `DecryptFailed` → the whole match VOIDs (`settle_match` returns
  `VoidReason::TimelockUnavailable`, `settlement/lib.rs:129`). An attacker controlling the
  beacon response can force voids at will.

**Economic impact:** complete loss of prediction secrecy (the core fairness property) and/or
denial of settlement / forced refunds. Critical.

**Fix:** Verify the round signature against the chain public key before using it as a key:
`BLS.Verify(public_key, message=H(round_be), signature)` for the configured scheme
(`bls-unchained-g1-rfc9380` → G1 sigs, message = SHA-256 of the 8-byte big-endian round).
Reject and treat as `KeyUnavailable`/`Pending` (not silently use) if verification fails. Use
a maintained drand client crate that does this, or call the BLS verify path explicitly. Also
pin TLS / require HTTPS and validate the cert chain for the beacon host.

---

### 2. (High) Commitment hash is a homemade non-cryptographic FNV construction

**Files:** `services/shared/src/intent.rs:109-141` (`prediction_commitment_hash` →
`simple_sha256`); used at `settlement/src/lib.rs:147, 203` and `service.rs:910`.

**Proven.** `prediction_commitment_hash(prediction, blinding)` packs `price(16) || blinding(32)`
and calls `simple_sha256`, which despite its name is **FNV-1a-style**: four `u64` lanes each
`xor` then `wrapping_mul` per 8-byte word (`intent.rs:117-141`). This is not SHA-256 and is
neither collision- nor preimage-resistant. The doc comment even admits "Production uses sha2
off-chain" — but the code path actually invoked by `settle_match` is this weak function, and
the on-chain commitment must match it.

**Attacker scenario:** The binding check at `settlement/lib.rs:147-149` is only as strong as
this hash. Because the construction is a small set of multiply/xor lanes with a public,
invertible structure, an attacker may be able to find a second `(prediction', blinding')`
that yields the **same committed hash** — i.e. commit, watch the settlement price, then have
the worker accept a *different* plaintext that still matches the commitment (defeating the
"immutable once committed" guarantee). At minimum the 256-bit output gives no real preimage
resistance margin given the linear-ish mixing.

**Economic impact:** potential ambiguous/malleable commitment → change prediction after the
fact → steal pots. High (gated by the difficulty of actually inverting this specific
construction, which should be analyzed; treat as exploitable until proven otherwise).

**Fix:** Use a real cryptographic hash (SHA-256 via `sha2`, already a dependency in the
worker) for the commitment, with domain separation:
`SHA256(DOMAIN_PREDICTION || price_le16 || blinding32)`. The blinding must be ≥128 bits of
entropy (it is 32 bytes — fine) and the hash must be the *same* function the contract uses.
Rename `simple_sha256` so no caller mistakes it for SHA-256.

---

### 3. (High) Decrypted prediction not range-checked; winner distance subtraction overflows

**File:** `services/shared/src/settle.rs:183-185` (`let dist = (pred - s).unsigned_abs();`);
prediction comes from attacker plaintext via `scheme.decrypt` → `i128::from_le_bytes`
(`scheme_drand.rs:49-50`), no validation anywhere (confirmed: no range/bound check in
`shared` or `settlement`).

**Proven.** The prediction is the player's own plaintext — they choose any `i128`. At
settlement `winners_of` computes `dist = (pred - s).unsigned_abs()` with a **plain i128
subtraction**. If `pred` is near `i128::MIN` and `s` is positive, `pred - s` overflows
`i128`: in debug builds this **panics** (kills the settlement worker mid-job); in release it
**wraps**, yielding a small bogus `dist` that can make the attacker's absurd prediction
appear "closest" and win the pot.

**Attacker scenario:** A malicious player seals a prediction of `i128::MIN` (or any extreme
value). They lose nothing if it doesn't trigger; if it does, either (a) the worker panics and
the match stalls / griefs settlement, or (b) the wraparound makes them the computed winner of
contested pots regardless of the real price.

**Economic impact:** DoS of settlement and/or theft of contested pots. High.

**Fix:** (1) Validate every decrypted prediction against a sane fixed-point price band
(e.g. `0 < pred <= MAX_REASONABLE_PRICE` consistent with the oracle exponent) and treat
out-of-band predictions as that seat losing / `MissingPrediction`, not as a valid entry.
(2) Compute distance with saturating/checked arithmetic:
`let dist = pred.checked_sub(s).map(|d| d.unsigned_abs()).unwrap_or(u128::MAX);` so an
extreme value sorts as *farthest*, never closest, and never panics.

---

### 4. (High) Recorded ciphertext is never bound to the on-chain commitment

**Files:** `services/match-engine/src/service.rs:604-617, 714-734`;
`services/match-engine/src/server.rs:524-541`; `reconstruct.rs:349-370`.

**Proven.** At seal time, `record_prediction_sealed` stores the `ciphertext` and the
`SignedPredictionCommitment` as **independent fields** of `PredictionSealed`.
`validate_prediction_commitment` only checks: blinding ≠ all-zero, and an ed25519 signature
over `prediction_commitment_message(...)`. It **never checks that `ciphertext` decrypts to,
or is hashed into, the `commitment`.** The on-chain seat stores `prediction_commitment =
hash(ciphertext)` (per CLAUDE.md), but the backend's commitment field is
`hash(prediction || blinding)` — a *different* thing — and nothing ties the stored
`ciphertext` to either. At settlement the worker decrypts the ciphertext, then checks the
*plaintext* against `commitment = hash(plaintext||blinding)` (`settlement/lib.rs:147`). So the
binding chain is: `committed hash ⟷ revealed plaintext`. The **ciphertext is unbound** — it
is merely the transport. Combined with the fact that the on-chain commitment is over the
ciphertext, there is no off-chain check that the recorded ciphertext equals the one the player
committed on-chain.

**Attacker scenario:** Because the engine indexes seals by `player_id` in a `BTreeMap`
(`timelock/lib.rs:81`, last-write-wins) and never cross-checks against the on-chain
`prediction_commitment`, a player (or anyone who can post a seal HTTP call for that match
during sealing) can record a ciphertext that differs from what was committed on-chain. The
worker will happily decrypt whatever ciphertext is in the DB. Whether this lets a player
*change* their prediction depends on the as-yet-unverified link between the backend's
`commitment` field and the on-chain `prediction_commitment` — but as written, the two
commitment notions are inconsistent and the ciphertext is the floating link.

**Economic impact:** prediction substitution / inconsistent on-chain vs off-chain reveal →
unfair wins or unverifiable settlement. High.

**Fix:** Make the off-chain `commitment` be the **hash of the exact ciphertext** that is
committed on-chain (so `on-chain prediction_commitment == hash(ciphertext) == stored
commitment`), and *additionally* bind the plaintext: commit to
`hash(ciphertext)` on-chain and verify at reveal both that `hash(stored_ciphertext) ==
on-chain commitment` **and** that `decrypt(ciphertext)` equals the plaintext whose
`hash(plaintext||blinding)` the player signed. Reject seals whose ciphertext hash doesn't
match the on-chain commitment for that seat.

---

### 5. (Medium) Beacon endpoint and chain hash come from env with a public default

**File:** `services/worker/src/timelock_open.rs:85-100`.

**Proven.** `DrandTimelockConfig::from_env` reads `DRAND_API` (default `https://api.drand.sh`)
and `DRAND_CHAIN_HASH` (hardcoded quicknet default). `from_info` validates the fetched
`/info` hash/scheme against the *configured* values (`timelock_open.rs:124-156`) — good — but
that only catches a mismatch with the configured chain; it does not authenticate the endpoint.
Anyone who can set/override these env vars, or MITM the plain HTTP(S) fetch, points the worker
at a beacon they control whose `/info` is internally consistent.

**Attacker scenario:** Combined with finding 1 (no signature verification), a substituted
beacon yields attacker-chosen round keys → early decryption or forced void. Even alone, a
substituted-but-consistent chain produces round keys that don't match what players encrypted
to → universal `DecryptFailed` → void grief.

**Economic impact:** loss of secrecy or denial of settlement. Medium (requires env/MITM
control; operator is trusted, but env injection / supply-chain / misconfig are in scope for
external actors).

**Fix:** Pin the chain hash and **public key** as compile-time constants (not just env), and
verify round signatures (finding 1). Require TLS with cert validation. Log/alert on any
`/info` that differs from the pinned values.

---

### 6. (Medium) `seal_seq` is hardcoded to 0 — earliest-seal tie ordering is defeated

**Files:** `services/match-engine/src/server.rs:537` (`seal_seq: 0`);
`services/shared/src/settle.rs:214-216` (tie remainder sorts by `(seal_seq, id.0)`).

**Proven.** The award-split tie-breaker (`award_split`, `settle.rs:213-217`) gives the
indivisible remainder to the **earliest-sealed** winner (`p.seal_seq` then `p.id.0`). But the
HTTP seal handler always sets `seal_seq: 0` (`server.rs:537`), and `validate_prediction_commitment`
explicitly does *not* sign `seal_seq` (by design per `intent.rs:64-66`). With every
`seal_seq == 0`, the tie-break collapses to **lowest player id always wins the remainder**,
not earliest seal.

**Attacker scenario:** In a tie for closest prediction, the remainder is deterministically
awarded to the lowest seat index rather than whoever genuinely sealed first. The intended
fairness property ("earliest sealer gets the odd chip", `04 §13`) is silently broken; a
low-id seat gains a small systematic edge in every tie.

**Economic impact:** small per-tie unfairness; systematic. Medium-low.

**Fix:** Populate `seal_seq` from the actual on-chain arrival order (the contract assigns it
by arrival, per `intent.rs`), carry it through `PredictionSealed`/`SealBinding` into
`PlayerState.seal_seq`, and make settlement use the real value. If `seal_seq` truly cannot be
trusted off-chain, the contract value must be the source of truth fed into settlement.

---

### 7. (Low) Off-chain seal path has no phase/deadline gate; registry overwrite is last-write-wins

**Files:** `services/match-engine/src/service.rs:604-618` (no `phase`/`seal_deadline`
check in `record_prediction_sealed`); `services/timelock/src/lib.rs:77-83`
(`seal` → `BTreeMap::insert`, last write wins, only blocked after `lock()`).

**Proven/Suspected.** `record_prediction_sealed` appends a `PredictionSealed` event with no
check that the match is in a sealing phase or before a seal deadline — it relies entirely on
the on-chain contract (`status==Sealing && now<=seal_deadline_ts`) for binding. The in-memory
`SealRegistry::seal` overwrites a prior ciphertext for the same player until `lock()`
(`reconstruct.rs:413` locks only at reconstruct). The worker also has no per-player duplicate
guard in the engine record path (the reconstruct path does reject duplicates at
`reconstruct.rs:404`, but only when rebuilding from events — the *latest* event per player is
what matters since the registry insert is keyed by player).

**Attacker scenario:** If any actor can call the engine seal HTTP endpoint for a match during
the (off-chain) sealing window more than once, the last ciphertext recorded for that player
wins — a prediction change that the off-chain layer permits, caught only if the on-chain
commitment binding (finding 4) is correctly enforced (it currently isn't fully). Defense
depends entirely on the chain.

**Economic impact:** prediction mutability if chain binding is weak. Low-Medium given chain is
the backstop, but the off-chain layer should defend in depth.

**Fix:** Gate `record_prediction_sealed` on engine phase == Sealing and reject a second seal
for a player that differs from the first (or require it to match the on-chain commitment).
Don't rely solely on the chain for the binding invariant.

---

### 8. (Low) Dev-signature bypass and permissive HTTP defaults

**Files:** `services/match-engine/src/service.rs:896-907` (`allow_dev_signature`);
`services/match-engine/src/server.rs:528-540` (`unwrap_or_default` ciphertext, default
all-zero commitment/blinding, `"sig-dev"` default signature).

**Proven.** `allow_dev_signature` returns true in `#[cfg(test)]` for any `sig-`-prefixed
signature, and in production when `SYNDICATE_ALLOW_DEV_SIGNATURES=1`/`true` **and** signature
starts with `sig-`. The HTTP seal handler defaults: ciphertext → empty bytes
(`unwrap_or_default`, `server.rs:528`), commitment/blinding → all-zero (`server.rs:530-533`),
signature → `"sig-dev"` (`server.rs:540`). Note `validate_prediction_commitment` rejects
all-zero blinding (`service.rs:718`), which blocks the *fully* defaulted case — good — but an
attacker who supplies a non-zero blinding and a `sig-`-prefixed signature in a dev-enabled
deployment bypasses signature verification entirely.

**Attacker scenario:** Any deployment that leaves `SYNDICATE_ALLOW_DEV_SIGNATURES` on (or a
test build shipped to a live env) lets an attacker seal predictions for any seat without a
valid wallet signature → forge/overwrite others' commitments.

**Economic impact:** total compromise of seal authenticity in a misconfigured env. Low
(requires misconfig; operator trusted) but high blast radius — flag prominently.

**Fix:** Make the dev bypass impossible in release builds (`#[cfg(debug_assertions)]` only),
fail closed in the HTTP handler (reject missing ciphertext/commitment/signature rather than
defaulting), and never default a signature to `"sig-dev"`.

---

### 9. (Info) Verified controls

These are correct and worth preserving:

- **Reveal ↔ commitment binding (plaintext):** `settle_match` re-hashes each decrypted
  prediction with its stored blinding and VOIDs on mismatch (`settlement/lib.rs:144-150`).
  A player cannot reveal a different *plaintext* than committed (subject to the hash being
  cryptographic — finding 2).
- **Round-gating:** `SealRegistry::decrypt_all` rejects a key whose round ≠ target
  (`timelock/lib.rs:106-108`); `open` rejects a beacon round ≠ requested (`timelock_open.rs:188`).
- **Target round consistency:** reconstruct rejects zero target rounds, mismatched
  per-seal vs completed round, and duplicate seals (`reconstruct.rs:357-411`).
- **All seats must seal:** `require_seals_for_all_seats` VOIDs if any seat lacks a sealed
  prediction (`reconstruct.rs:417-435`) — a single missing prediction voids (refund) rather
  than silently dropping a player. (Note: this means one player sealing garbage that fails to
  decrypt voids the *whole* match — a grief vector, but capital-safe; acceptable per the
  "VOID on bad state" rule, though worth a per-player drop policy in v1+.)
- **Grace ≥ on-chain void grace:** `grace_sec` is clamped up to `ONCHAIN_SETTLE_VOID_GRACE_SEC`
  so the off-chain void can't beat the chain's permissionless void (`timelock_open.rs:95-96`).
- **`/info` shape validation:** non-zero period/genesis, hash & scheme match configured
  values, valid hex key (`timelock_open.rs:124-156`).
- **Pending vs UnavailableAfterGrace:** a not-yet-published round returns `Pending` (retry)
  before grace and only voids after, avoiding premature voids (`timelock_open.rs:174-186`).

---

## Suspected (needs follow-up, not proven here)

- **Finding 2 exploitability:** whether `simple_sha256` is *practically* invertible/collidable
  for the 48-byte `price||blinding` input needs a dedicated cryptanalysis. Treat as exploitable
  until disproven; the fix (use SHA-256) is cheap regardless.
- **Finding 4 link to chain:** confirm exactly what the on-chain `prediction_commitment` is
  (`hash(ciphertext)`) vs the backend `commitment` (`hash(plaintext||blinding)`) and where, if
  anywhere, the worker reconciles them. As read, they are inconsistent notions and the
  ciphertext is unbound off-chain.
- **drand quicknet round derivability:** quicknet is *unchained* (each round's signature is
  independent), so the two-sided on-chain round bound is what prevents picking an
  already-published round; verify that bound is actually enforced against the *real* current
  drand round at create time, not just relative to match timing.
