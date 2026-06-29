# Syndicate — Security Review & Audit Prep (Phase 10)

**Status:** Canonical, v1.0. The gate between "code complete" and "real money on mainnet." No buy-in above the practice tier ships until the ⛔ items here are closed. Cross-references: `07_RISK_REGISTER.md`, `04_GAME_MECHANICS_CANONICAL.md`, `ARCHITECTURE.md`.

---

## 1. What an external auditor must review (scope, in priority order)

1. ⛔ **On-chain program (`services/programs`)** — custody is here. Vault PDA authority, deposit/lock/settle/claim/void/refund, v1 signed-price + conservation gate, fee accounting, idempotent claim, arithmetic, account constraints/seeds. Full on-chain outcome re-derivation is deferred (`TODO(v1+)`).
2. ⛔ **Deterministic core (`services/shared`)** — the money math used off-chain in v1 (and for future on-chain parity). Side-pot construction, exact-timestamp oracle validation, winner/tie, conservation. Still needs scrutiny + fuzzing even when not linked on-chain in v1.
3. **Settlement builder (`services/settlement`)** — input collection + VOID orchestration; ensure no path releases funds on unverified or degraded inputs.
4. **Pyth updater/receiver path + time-lock** — Pyth update authenticity, feed/timestamp/confidence/exponent guards, beacon trust, binding-before-LIVE.
5. **Edge (`gateway`, `matchmaking`)** — auth/signature handling, deposit-finality gating, geofencing bypass.
6. **Read path (`action-feed`)** — redaction (no secret ever leaves).

---

## 2. Threat model (top adversaries → control → evidence)

| Adversary goal | Primary control | Evidence (test / mechanism) |
|----------------|-----------------|------------------------------|
| Drain the vault | Minimal-trust program; funds release only after signed-price verification + conservation (v1) | `programs::submit_settlement` + audit |
| Submit a forged/inflated settlement | Conservation + signed-price checks; v1 does not re-derive outcomes on-chain (`TODO(v1+)`) | `shared::verify_settlement` tamper tests (off-chain); conservation tests on-chain |
| Read a prediction early | Time-lock encryption, no key holder | `timelock` binding/round-gating tests; `04 §12` |
| Decide a pot on a bad/manipulated price | Signed price at exact `scheduled_end_ts` + confidence/exponent/feed guards → VOID | `shared::oracle` exact-timestamp tests; signed-price-server integration; `04 §11` |
| Steal via tiny bet vs big all-in | Side-pot eligibility caps winnings to matched chips | `shared` golden/property tests; `04 §9` |
| Grief settlement by not revealing | Auto-decrypt at match end (no manual reveal); missing key → VOID | `timelock` missing-key test; `04 §12` |
| Collude / chip-dump / bot / Sybil | Muck-on-fold, server CSPRNG button (v1), deposit gate, T&S telemetry; residual priced | `trust-safety` detectors; `07 S3/S4` |
| Predictable dealer button (v1 residual) | Server CSPRNG via settlement-chain; not match-id-derived; not trustless VRF | `settlement-chain/buttonRandomness.ts`; on-chain seed audit log |
| Win a pot you folded | Folded players excluded from eligibility | `shared` property test ("no folded player paid") |
| Latency exploit | Server-authoritative clock/timers | engine timers; `06 §7` |
| Leak secrets to spectators | `action-feed` allow-list redaction | `action-feed` "no secret leak" tests |
| Beacon/oracle outage stalls funds | Bounded grace → VOID + full refund | `settlement` VOID paths; runbooks |

---

## 3. Invariants the auditor must confirm hold (and that we already test)

- ⛔ **Conservation:** `Σ payouts + Σ returns + fees == Σ deposits`, on every path (incl. VOID). *Tested:* 100k-scenario property test (`shared`), on-chain assert (`programs`).
- ⛔ **Determinism / parity:** off-chain settlement == on-chain recomputation, byte-identical, from `(signed log, sealed predictions, drand key, verified Pyth update metadata, VRF seed, config)`. *Tested:* `golden/` vectors across all three sites; e2e parity test.
- ⛔ **No-privilege / concealment:** no actor (incl. operator) can read a prediction before `timelock_target` or alter an outcome. *Mechanism:* TLE no-key-holder; *Tested:* timelock + redaction tests.
- ⛔ **Capital safety:** every fault has a deterministic refund/VOID; no path releases funds on unverified state. *Tested:* every VOID path in `settlement`/e2e.
- **Config integrity:** a match settles under the exact recorded `config_hash`. *Tested:* `config` bind-hash tests.

---

## 4. Pre-mainnet checklist (⛔ = blocks any real-money tier)

- [ ] ⛔ Independent smart-contract audit (≥1 reputable firm) — **clean or all criticals/highs remediated + re-reviewed**.
- [ ] ⛔ Second, independent review of `services/shared` (the cross-side math) + fuzz/differential run.
- [ ] ⛔ Formal-ish review of conservation + settlement-verification paths.
- [ ] ⛔ `anchor build && anchor test` green incl. `golden/` parity + every VOID/refund instruction path.
- [ ] ⛔ Replay-determinism + 100k conservation suites green in CI as the merge gate.
- [ ] ⛔ Pyth Receiver integration is implemented in source (`PriceUpdateV2` full verification + feed/time/confidence/exponent checks); before real money, complete live Devnet atomic settlement evidence, Anchor runtime tests, transaction fit/compute measurement, and audit evidence (`08 OQ1`).
- [ ] ⛔ Pyth unavailable path rehearsed: no valid update in window leads to a separate emergency-void-admin `void` transaction, followed by player pull-based `refund` transactions; no operator-selected price or median fallback.
- [ ] ⛔ Time-lock (drand `tlock`) beacon trust + grace→VOID validated end-to-end.
- [ ] ⛔ Vault reconciliation invariant (on-chain balance == Σ ledgers) monitored; alerting live.
- [ ] ⛔ Geofencing enforced at the edge; high-risk jurisdictions blocked (`08 OQ18`).
- [ ] Key management: program upgrade authority policy (multisig / timelocked / revoked), relayer/fee-payer keys in a secret manager.
- [ ] Bug bounty live (scope §5) before scaling stakes.
- [ ] Incident runbooks (`RUNBOOKS.md`) rehearsed; kill switches tested in staging.
- [ ] Staging soak on devnet/low-value mainnet: capital-safety, concealment, and no-privilege assertions verified under real custody + real oracle/beacon.

## 5. Bug bounty scope

- **In scope / highest payout:** any path that releases funds without passing on-chain re-verification; conservation break; reading a prediction before time-lock open; settlement non-determinism; vault drain/lock; refund/VOID failures.
- **In scope:** auth/signature bypass, geofence bypass, redaction leaks, collusion automation, oracle/beacon manipulation within stake caps.
- **Out of scope:** social engineering, DoS of non-custody infra, issues requiring a compromised audited dependency, anything in the deferred spectator market (not shipped).

## 6. Standing posture

Capital safety supersedes feature velocity, always. When verification is uncertain, the system **VOIDs (refunds), never guesses**. Any change touching `shared`/`programs`/settlement must keep the merge-gate suites green and add a `golden/` vector for new settlement shapes.
