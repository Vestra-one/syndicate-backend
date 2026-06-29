# Phase 12 — Operational / mainnet gates (non-code)

**Goal:** the deployment owner's pre-mainnet checklist. No application code; process + infra + governance.

- **Status:** 🟡 gate tracker delivered (`docs/deployment/V1_MAINNET_GATES.md` — each gate has Owner/Status/Evidence/Sign-off columns). Sign-off is the deployment owner's; cannot be completed here (process/governance, and gated on 01–11 green on devnet).
- **Depends on:** 01–11 (code complete + verified)
- **Parallel-safe with:** —
- **Checklist ref:** §9

---

## Context — why this phase exists

Code-complete is necessary but not sufficient for a real-money mainnet launch. These are the
governance/infra gates that must each be owned and signed off before mainnet. They are deliberately
out of the code phases because they're process, not implementation.

## Scope

**In:** the gate list below, each with an owner + sign-off.
**Out:** any code change (if a gate requires code, it's a defect to route back to the owning phase).

## Gates (each needs an owner + sign-off before mainnet)

- [ ] **External security audit** of the program + settlement core (`services/programs`, `services/shared`); independent firm.
- [ ] **Bug bounty** stood up (scope, payouts, disclosure policy).
- [ ] **Key custody:** multisig / hardware custody for production role keys; documented key ceremony; mainnet program-key generation (the `declare_id!` value is devnet-aligned `Gwzr…` — mainnet uses its own deployed key per `Anchor.toml [programs.mainnet]`).
- [ ] **Distinct role keys verified:** `protocol_admin`, `settlement_admin`, `emergency_void_admin`, `pause_admin`, `config_admin`, `fee_admin`, `treasury_admin`, `upgrade_authority`, and `price_signer` are all separate, non-default keys (the program asserts non-default at `initialize_protocol`; verify they're also mutually distinct + custody-separated).
- [ ] **Treasury funding** for sponsored settlement/claim gas.
- [ ] **Kill-switch rehearsal:** stage `set_pauses` (pause_new_matches / pause_settlement) and confirm claims/refunds remain live while paused.
- [ ] **Geofencing** enforced at the edge (gateway/CDN), not just advisory.
- [ ] **Monitoring:** operator-action rate/anomaly alerts; oracle (signed-price-server) + drand beacon health dashboards; settlement dead-letter alerting.
- [ ] **Per-feed `max_buy_in`** set below market-impact size (mitigates the single-update signed-price residual risk — a deliberate accepted trade-off).
- [ ] **Incident runbook:** who can emergency-`void`, under what criteria; on-call rotation.

## Acceptance criteria

- [ ] Every gate above has a named owner and a recorded sign-off.
- [ ] Audit findings (if any) are remediated and re-reviewed.
- [ ] Kill-switch + emergency-void paths rehearsed on staging.

## Verification

- Audit report delivered + findings closed.
- A staging dry-run exercising pause + emergency-void + a full settle + a void.
- Dashboards live and alerting validated with a synthetic incident.

## Risks & gotchas

- Real money + compromised/colluding-operator threat model: the on-chain guarantees (conservation, signed-price authenticity, permissionless void backstops) only hold if role keys are genuinely separated and custody is hardened — a single shared admin key collapses the trust model.
- The signed-price single-update oracle has an accepted residual (one print can be nudged); `max_buy_in` per feed is the mitigation — do not skip it.
