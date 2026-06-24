# Syndicate — Rollout, Compliance & Fair Play (Phase 10)

**Status:** Canonical, v1.0. How v1 reaches mainnet without risking user capital or the brand. Stage gates are **one-directional**: a stage opens only when the prior stage's exit criteria are met, and any ⛔ regression rolls back via the kill switches (`RUNBOOKS.md §3`).

---

## 1. Staged rollout

### Stage 0 — Devnet / internal
- Full system on Solana devnet; `anchor test` green incl. `golden/` parity and every VOID path; CI merge gate enforced.
- **Exit:** all `SECURITY_REVIEW.md §4` ⛔ engineering items green; kill switches rehearsed in staging.

### Stage 1 — External audit + bug bounty
- Independent smart-contract audit + the second review of `services/shared`; bug bounty opened.
- **Exit ⛔:** audit clean or all critical/high findings remediated **and re-reviewed**; no open critical bounty reports.

### Stage 2 — Practice mode (no real capital)
- Public **no-stakes** practice tier (`08 OQ13`): identical rules, zero custody. Validates pacing/retention (`risk P2/P3`), matchmaking fill, and the live-games dashboard at load.
- **Exit:** pacing/retention targets met in playtest; fill rates healthy with **no house bots** (`08 OQ14`); action-feed redaction guard shows zero leaks under load.

### Stage 3 — Low-stakes mainnet (capped)
- Smallest buy-in tier only, low `max_buy_in`, geofenced. Real custody, real oracle/beacon, real settlement.
- **Soak gate ⛔:** sustained period with vault drift = 0, settlement mismatches = 0, VOID rate < SLO, settlement latency within SLO, and capital-safety/concealment/no-privilege assertions verified under real conditions.

### Stage 4 — Scale
- Raise tiers/caps gradually (each increase below market-impact size per feed, `08 OQ2`); add feeds via config; expand regions as compliance clears (§3).
- Each step is a config change behind the same gates; monitor manipulation telemetry as it comes online (deferred from v1, `08 OQ2`).

### Go / No-Go gate (every stage)
GO only if: merge-gate suites green · audit posture satisfied for the stage · vault reconciliation = 0 · oracle + drand at SLO · kill switches verified · on-call staffed. Any ⛔ breach → **No-Go / roll back**.

---

## 2. Release mechanics
- **Program upgrades:** authority is a multisig with a timelock during early stages; publish a path to revoke/decentralize upgrade authority as the program stabilizes. Every upgrade re-runs the full CI gate + a fresh `golden/` parity check.
- **Config changes** (the primary tuning lever, `08 OQ7`): versioned, validated, and bound per match (recorded `config_hash`). A live match never changes parameters mid-flight.
- **Rollback:** kill switches stop new exposure immediately; in-flight matches route to settle-or-VOID; no rollback ever touches settled on-chain funds.

---

## 3. Compliance posture (geofencing now; classification deferred)
- **Decision (`08 OQ18`):** geofencing is enforced at the edge **from launch** — restricted jurisdictions are blocked at connect/auth. Full legal classification (skill-game vs gambling vs derivatives, per jurisdiction) and deeper KYC remain deferred per founder direction ("regulation last step"), with hooks architecturally in place.
- **Operating constraint:** do not market or open real-money tiers in high-risk jurisdictions pre-clearance. Region expansion (Stage 4) is gated on compliance sign-off, not just engineering readiness.
- **Data minimization:** collect the least identity data needed for Sybil resistance (progressive: heuristics at low tiers, stronger proof-of-personhood at higher tiers, `08 OQ15`); no more PII than necessary; the public action feed is pseudonymous.
- **This is not legal advice** — the classification and licensing path must be set with qualified counsel before scaling beyond capped low-stakes.

---

## 4. Fair-play policy (player-facing, `08 OQ16`)
- **Provable fairness:** predictions are time-lock-sealed (no one, including us, can read them early); settlement is deterministic, oracle-based, and independently verifiable from your match record; every bet is on a public, auditable feed.
- **Prohibited:** collusion, chip-dumping, soft-play between confederates, bot/automated play, and multi-accounting (Sybil). 
- **Enforcement:** detection acts **before** settlement — seat denial and account bans with forfeiture of future access. Because funds settle on-chain and are final, **we do not claw back settled payouts**; expectations are set accordingly. Appeals are supported (detectors are explainable).
- **Honest positioning:** Syndicate is a contest of capital discipline and nerve under hidden information — a poker-style game of conviction. We never claim you will out-forecast the market; single matches are high-variance by design, and skill shows over volume.

---

## 5. What v1 explicitly does NOT include (deferred, `08`)
Spectator prediction market (Phase 2 product), detailed cross-match manipulation telemetry, deep progression/seasons beyond baseline leaderboards, and full regulatory classification/KYC beyond geofencing. None of these gate the core game; all sit behind seams already in the architecture.
