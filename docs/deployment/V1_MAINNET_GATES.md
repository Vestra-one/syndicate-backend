# Syndicate v1 — Mainnet Gates (Phase 12)

Authoritative pre-mainnet gate list for the **v1** architecture (player-created, signed-price
oracle, no indexer, no on-chain action-log). Each gate needs a **named owner** and a recorded
**sign-off** before real-money mainnet. These are process/infra/governance — **no application code**;
if a gate turns out to need code, it's a defect to route back to the owning code phase (01–11).

Source plan: [`docs/plans/v1/phase-12-operational-gates.md`](../plans/v1/phase-12-operational-gates.md).
Companion docs: [`AUDIT_AND_BUG_BOUNTY.md`](AUDIT_AND_BUG_BOUNTY.md) ·
[`SECRETS_AND_KEYS.md`](SECRETS_AND_KEYS.md) · [`LAUNCH_CHECKLIST.md`](LAUNCH_CHECKLIST.md) (older
Phase-8 runtime checklist — still useful for the fleet/rollout rows).

Status legend: ⬜ not started · 🟡 in progress · ✅ signed off · 🔴 blocked.

| # | Gate | Owner | Status | Evidence / link | Sign-off (name + date) |
|---|------|-------|--------|-----------------|------------------------|
| 1 | **External security audit** of `services/programs` + `services/shared` (settlement core) by an independent firm; no open Critical/High. | | ⬜ | | |
| 2 | **Bug bounty** stood up (scope, payouts, disclosure policy). | | ⬜ | AUDIT_AND_BUG_BOUNTY.md | |
| 3 | **Key custody:** multisig / hardware custody for production role keys; documented key ceremony; **mainnet program key generated** (devnet `declare_id!` is `Gwzr…`; mainnet uses its own key per `Anchor.toml [programs.mainnet]`). | | ⬜ | SECRETS_AND_KEYS.md | |
| 4 | **Distinct role keys verified:** `protocol_admin`, `settlement_admin`, `emergency_void_admin`, `pause_admin`, `config_admin`, `fee_admin`, `treasury_admin`, `upgrade_authority`, `price_signer` are all separate, non-default, custody-separated keys. (Program asserts non-default at `initialize_protocol`; verify also mutually distinct.) | | ⬜ | | |
| 5 | **Treasury funding** for sponsored settlement/claim gas. | | ⬜ | | |
| 6 | **Kill-switch rehearsal:** stage `set_pauses` (pause_new_matches / pause_settlement) and confirm **claims/refunds remain live while paused**. | | ⬜ | RUNBOOKS / staging log | |
| 7 | **Geofencing** enforced at the edge (gateway/CDN), not just advisory. | | ⬜ | | |
| 8 | **Monitoring:** operator-action rate/anomaly alerts; **signed-price-server** + drand beacon health dashboards; settlement dead-letter alerting. | | ⬜ | | |
| 9 | **Per-feed `max_buy_in`** set below market-impact size (mitigates the single-update signed-price residual — an accepted trade-off). | | ⬜ | | |
| 10 | **Incident runbook:** who can emergency-`void`, under what criteria; on-call rotation. | | ⬜ | RUNBOOKS | |

## Acceptance (Phase 12)

- [ ] Every gate above has a named owner and a recorded sign-off.
- [ ] Audit findings (if any) remediated and re-reviewed.
- [ ] Kill-switch + emergency-void paths rehearsed on staging.

## Verification

- Audit report delivered + findings closed.
- A staging dry-run exercising **pause + emergency-void + a full settle + a void** (reuse the Phase 11
  devnet harness against staging).
- Dashboards live; alerting validated with a synthetic incident.

## Threat-model reminders (do not skip)

- Real money + compromised/colluding-operator model: on-chain guarantees (conservation, signed-price
  authenticity, permissionless void backstops) **only hold if role keys are genuinely separated and
  custody hardened** — a single shared admin key collapses the trust model (gate #4).
- The signed-price single-update oracle has an accepted residual (one print can be nudged); per-feed
  `max_buy_in` (gate #9) is the mitigation — **do not ship without it**.

## Note on prerequisites

Deployment-ready for v1 = code phases **01–11 complete**. As of this writing the code phases 05–10 are
implemented + verified; Phase 11 is delivered as an env-gated harness awaiting a live devnet run. Phase
12 must not begin sign-off until 01–11 are green on a real devnet soak.
