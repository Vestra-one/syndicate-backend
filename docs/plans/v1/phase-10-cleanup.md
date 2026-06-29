# Phase 10 — Cleanup (dead code, constants, stale docs)

**Goal:** remove dead/misleading code and reconcile constants before audit. Correctness-neutral.

- **Status:** ⬜ not started
- **Depends on:** — (independent)
- **Parallel-safe with:** everything (coordinate with 01/04 which also delete button-seed/Pyth bits)
- **Checklist ref:** §8

---

## Context — why this phase exists

The worker/settlement carry dead Pyth scaffolding from before the signed-price switch, the timelock
grace constant disagrees with the on-chain grace, and several canon docs describe a different game
(Switchboard/median-60s/session-keys). None affect correctness, but they mislead future readers and
an auditor. Clean them.

## Scope

**In:** delete dead Pyth scaffolding; reconcile the timelock grace; prune/rename stale settlement-chain
Pyth files; deprecate stale canon docs.
**Out:** any behavioral change to the live signed-price path (`PythResolveClient` STAYS — it's the
signed-price adapter despite the name).

## Files to touch

- `services/settlement/src/ops.rs`
- `services/worker/src/timelock_open.rs`
- `services/settlement-chain/src/{pyth.ts,pythStack.ts,buttonRandomness.ts,auditLog.ts}`
- stale canon docs `04_/05_/06_/08_*` (root)

## Patterns to reuse / facts

- Live oracle path the worker actually uses: `PythResolveClient` (signed-price) — `services/settlement/src/ops.rs` `resolve_pyth` + `/internal/pyth/resolve` route (proxies signed-price-server). **Keep this.**
- Dead scaffolding to remove: `PythUpdateClient`, `fetch_and_post_first_valid_pyth_update`, `HermesHttpPythClient`, `MockPythClient` (all in `ops.rs`).
- Grace constants on-chain: `SEAL_VOID_GRACE_SEC=60`, `SETTLE_VOID_GRACE_SEC=300` (`lib.rs`). Worker hardcodes ~30s in `timelock_open.rs`.
- `set_button_seed` client code is removed in Phase 01; `buttonRandomness.ts`/`auditLog.ts` may still be needed by `begin_live` randomness generation — check before deleting.

## Implementation steps

1. **Remove dead Pyth scaffolding** in `ops.rs`: delete `PythUpdateClient` trait, `fetch_and_post_first_valid_pyth_update`, `HermesHttpPythClient`, `MockPythClient` and any now-unused imports. Keep `PythResolveClient`/`SignedPricePayload`/`PythResolvedPrice` (the live signed-price path).
2. **Reconcile timelock grace:** make `timelock_open.rs`'s grace derive from config (or a shared constant) so the off-chain VOID never races the on-chain permissionless void; align with `SEAL_VOID_GRACE_SEC`/`SETTLE_VOID_GRACE_SEC`.
3. **settlement-chain Pyth files:** if the signed-price-server fully replaces them, delete `pyth.ts`/`pythStack.ts` + their tests; otherwise leave the `/internal/pyth/resolve` proxy and remove only the unused Hermes bits. Keep `buttonRandomness.ts`/`auditLog.ts` only if `begin_live` (Phase 01/04) still uses them; else remove.
4. **Optional rename:** `resolve_pyth`/`/internal/pyth/resolve`/`PythResolveClient` → `signed_price` equivalents to stop misleading readers (mechanical rename; update callers in worker + orchestrator + settlement-chain together).
5. **Docs:** add a deprecation banner to `04_/05_/06_/08_*` pointing to `docs/V1_COMPLETION_CHECKLIST.md` + code as authoritative, or move them under `docs/archive/`.

## Acceptance criteria

- [ ] No `PythUpdateClient`/`HermesHttpPythClient`/`MockPythClient`/`fetch_and_post_first_valid_pyth_update` remain.
- [ ] Timelock grace is sourced consistently (no ad-hoc 30s that races the on-chain grace).
- [ ] Dead settlement-chain Pyth/button files removed or justified.
- [ ] Stale canon docs deprecated/moved.
- [ ] `cargo check --workspace` + per-service `npm test` green.

## Verification

```bash
cargo check --workspace
grep -rn "PythUpdateClient\|HermesHttpPythClient\|fetch_and_post_first_valid_pyth_update" services/   # expect none
cd services/settlement-chain && npm test
```

## Risks & gotchas

- **Do not** remove `PythResolveClient` / the signed-price path — despite the name it is the live v1 oracle adapter. Removing it breaks settlement.
- Renames are wide; do the rename atomically across worker + settlement + settlement-chain + orchestrator or builds break.
