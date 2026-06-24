# Syndicate — Observability & Incident Runbooks (Phase 10)

**Status:** Canonical, v1.0. How we watch the system and what we do when it breaks. Guiding rule from the canon: **degrade to a capital-safe VOID + refund; never settle on uncertain state, never leave a player's funds stuck.**

---

## 1. Observability

### 1.1 Golden signals & SLOs
| Signal | Target (SLO) | Why |
|--------|--------------|-----|
| Action round-trip latency (turn act → ack) | p99 < 250 ms | Turn-timer fairness (`06 §7`) |
| Settlement time (match end → SETTLED on-chain) | p99 < 30 s | Player trust; capital unlocked |
| Oracle sample success rate (in window) | > 99.9% | `S` integrity (`04 §11`) |
| Time-lock key availability at match end | > 99.99% | Decryption liveness (`04 §12`) |
| Vault reconciliation drift | **0, always** | Custody integrity (hard invariant) |
| VOID rate | < 0.5% of matches | Health of oracle/beacon/infra |
| Settlement-verification mismatch | **0** | A single one is a Sev-1 (`04 §18`) |

### 1.2 Required metrics (per match, correlation-id'd)
Match lifecycle transitions; per-turn timer/timeout/auto-action counts; oracle samples + confidence + staleness drops; drand round fetch latency/failures; settlement recompute result + conservation check; on-chain submit/confirm/retry; refund/VOID events with reason; deposit-finality latency; auth failures; geofence blocks; T&S scores/flags/bans; action-feed redaction-guard rejections (should be 0).

### 1.3 Dashboards
- **Custody (Sev-1 board):** vault balance == Σ ledgers per open match; pending claims/refunds; settlement mismatches; VOID reasons.
- **Integrity:** oracle health + confidence distribution; drand beacon health; settlement latency; replay/parity CI status.
- **Gameplay:** concurrent matches, fill rates, timeout/auto-fold rate, median pot ÷ blinds (nit-equilibrium watch, `02 S2`).
- **Trust & safety:** collusion/bot/Sybil flags, ban actions, co-seating anomalies.

### 1.4 Alerting (page vs ticket)
- **Page (Sev-1):** any vault drift ≠ 0; any settlement-verification mismatch; oracle or drand availability below SLO; refund/VOID engine failure; program upgrade-authority use.
- **Ticket (Sev-2/3):** elevated VOID rate, non-reveal/timeout spikes, T&S flag surges, latency SLO breaches.

---

## 2. Sev-1 runbooks

> Common first move for any custody/integrity Sev-1: **engage the kill switch (§3)** to stop new matches at the affected scope, finish or VOID in-flight matches capital-safely, then diagnose. New matches never resume until the invariant is re-verified.

### RB-1 — Oracle degradation / outage (`risk S1`)
**Detect:** sample success rate or confidence guard breaches; affected matches signal `OracleDegraded`.
**Act:** in-flight matches with insufficient valid window samples **auto-VOID + full refund** (already wired). Halt new matches on the affected feed. Verify the adapter and the provider (Switchboard On-Demand) status; fail over to the secondary feed/provider via config if the issue is provider-specific. **Never** hand-pick a settlement price.
**Resume:** only after sample success ≥ SLO for a sustained window.

### RB-2 — Time-lock beacon (drand) unavailable (`risk A8`)
**Detect:** round key not published by `timelock_target` + grace.
**Act:** affected matches **VOID + full refund** after the grace period (wired). Halt new matches (sealing depends on the beacon). Check drand League-of-Entropy health; confirm round mapping.
**Resume:** after beacon health is confirmed; consider a backup beacon set if recurrent.

### RB-3 — Settlement-verification mismatch (`04 §18`)
**Detect:** on-chain recomputation ≠ submitted result, or off-chain ≠ on-chain in CI/runtime. **This must never happen in production.**
**Act:** **do not release funds** (program already refuses). Freeze settlement globally (kill switch). Capture the full input bundle + logs. Treat as a potential `shared`/`programs` divergence or tampering. VOID affected matches (refund). Root-cause before any resume; add a `golden/` regression vector.

### RB-4 — Vault reconciliation drift (`risk A7`)
**Detect:** on-chain vault balance ≠ Σ per-seat ledgers for a match.
**Act:** **Sev-1, custody.** Freeze claims on the affected match. Reconstruct from the signed action log + on-chain state. Do not process further payouts until balanced. If unrecoverable, refund from last verifiable state.

### RB-5 — Authoritative engine crash / desync (`risk A3/A4`)
**Detect:** engine instance down, lease lost, or log replay fails.
**Act:** recover the match by **replaying its hash-chained log** on a fresh single-writer instance (lease/fencing prevents split-brain). If the log can't replay deterministically → VOID from last verifiable state. All-in players are unaffected (no actions pending).

### RB-6 — Mass disconnect / region outage
**Detect:** spike in timeouts/disconnects across many matches.
**Act:** pre-signed defaults + auto-check/fold keep matches progressing; all-in stakes are safe. If an entire region/gateway is down, halt new matchmaking there; in-flight matches continue server-side and settle or VOID normally.

### RB-7 — Suspected collusion/bot ring (`risk S3/S4`)
**Detect:** T&S flags (co-seating, chip-dumping, uniform timing, wallet clusters).
**Act:** deny seating / ban per the fair-play policy (`ROLLOUT.md`); enforcement is **pre-settlement** — no clawback of settled on-chain funds. Tighten matchmaking buckets / proof-of-personhood for the affected cohort.

---

## 3. Kill switches (must be tested in staging before mainnet)

| Switch | Effect | Scope |
|--------|--------|-------|
| `pause_new_matches` | Stop creating/filling matches; in-flight continue | global / per-feed / per-tier |
| `freeze_settlement` | Block `submit_settlement`; in-flight hold then VOID on timeout | global |
| `force_void(match)` | Capital-safe VOID + full refund of a specific match | per-match |
| `disable_feed(feed)` | Remove a price feed from new tables | per-feed |
| `geo_block(country)` | Add a jurisdiction to the geofence at the edge | per-region |

Switches are operator actions, audit-logged, and **cannot** reach into settled on-chain funds — they only stop new exposure and route in-flight matches to refunds.

---

## 4. On-call expectations
- Sev-1 (custody/integrity): immediate page, 24/7, with authority to engage kill switches.
- Every Sev-1 ends with a written post-incident review and, where applicable, a new `golden/` regression vector or test that would have caught it.
