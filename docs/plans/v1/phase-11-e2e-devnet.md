# Phase 11 — End-to-end devnet integration verification

**Goal:** prove the whole lifecycle works on devnet across the live services, not just unit-wise.

- **Status:** ⬜ not started
- **Depends on:** 01–08
- **Parallel-safe with:** —
- **Checklist ref:** §1c (e2e)

---

## Context — why this phase exists

Each phase is unit/integration-tested in isolation. This phase is the integration gate: drive the
full player-created lifecycle through the real services (matchmaking → orchestrator → settlement-chain
→ worker → timelock → signed-price-server) against a devnet deploy, plus at least one void path, and
assert chain/DB/registry agree and the vault settles to zero.

## Scope

**In:** an e2e script/test exercising the happy path + one void path on devnet; cross-state assertions.
**Out:** new feature code (all in earlier phases); mainnet ops (Phase 12).

## Files to touch

- `services/e2e/test/` (extend)
- a short devnet runbook note (e.g. `docs/deployment/` or the e2e README)

## Patterns to reuse

- Existing `services/e2e/test/` harness/structure.
- Phase 03 devnet deploy + `initialize_protocol`.
- The live service endpoints: matchmaking `POST /rooms` / `POST /matches/:id/deposits` / `GET /rooms`; orchestrator `POST /internal/start-policy`; settlement-chain `/internal/solana/*`; worker settlement loop.

## Implementation steps

1. **Happy path:** host `create_and_deposit` → report txhash (`POST /rooms`); 1–2 joiners `deposit` → report; host-start → orchestrator `lock → begin_live(randomness+seats) → engine start`; players seal (`register_prediction_commitment` + ciphertext upload); play to `scheduled_end_ts`; worker fetches signed price + decrypts timelock + `submit_settlement`; players `claim`.
2. **Assertions:** registry (`GET /rooms`) reflects each transition; Postgres `matches`/`match_seats` rows match chain; final vault token balance == 0 after claims + `withdraw_fees`; settled payouts == `shared::settle()` expectation.
3. **Void path:** drive at least one — Filling past `fill_deadline_ts` → permissionless `void_before_start` → all refund; assert vault → 0.
4. **Runbook note:** document the devnet env (RPC, program id, role keys, signed-price-server URL, drand) + how to run the e2e.

## Acceptance criteria

- [ ] Happy path completes on devnet end-to-end; all players claim; vault drains to 0.
- [ ] One void path completes; refunds drain the vault to 0.
- [ ] Registry + Postgres + chain agree at each transition.
- [ ] Runbook note committed.

## Verification

```bash
cd services/e2e && <run the e2e script against devnet>
solana account <vaultPda> --url devnet   # token balance 0 after terminal
```

## Risks & gotchas

- Devnet timing: `begin_live_window_sec` (5s) and the seal/observation windows are short — the e2e must orchestrate promptly or matches void. Consider a template with generous windows for the e2e run.
- signed-price-server + drand must be reachable from the worker; assert their health before the run.
- This phase surfaces integration drift (account ordering, field encodings) that unit tests miss — treat failures here as a signal to fix the owning phase, not to patch around in e2e.
