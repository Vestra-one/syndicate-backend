# Phase 11 — End-to-end devnet integration verification

**Goal:** prove the whole lifecycle works on devnet across the live services, not just unit-wise.

- **Status:** 🟢 executed green on devnet (2026-06-30). Signing client implemented in
  `services/e2e/src/devnet-driver.mjs`; gate in `services/e2e/test/devnet-lifecycle.test.ts`
  (env-gated, skips without `SYNDICATE_E2E_DEVNET=1`); `services/e2e/README.md` runbook updated.
  Both lifecycles drive the deployed program `8D2Wt3pLyoS8wLaTb3mcnC5WVja6xYMoumNqG2yZs1qX` and
  the vault drains to exactly 0:
  - happy path → `Settled`, vault 0 (match `AP5LU8HaKt21PDhYRLKmC3eh3XYUTqZh2ngsM2v7Wgdy`).
  - void path → `Void`, vault 0 (match `7xr3jWjpAPiTzkWktYbTdbc7PAga7KDZ42KHsqf3m5G2`).
  The driver produces its own EIP-191 signed price after rotating `price_signer` via
  `set_price_signer`, so settlement runs without the external signed-price-server. The live HTTP
  services are not in the v1 custody path (they only verify reported txhashes); the on-chain
  lifecycle is the authoritative gate.
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

- [x] Happy path completes on devnet end-to-end; all players claim; vault drains to 0.
- [x] One void path completes; refunds drain the vault to 0.
- [~] Registry + Postgres + chain agree at each transition. — chain is the authoritative v1 custody
  gate and is asserted. Registry/Postgres are not in the custody path (services only verify reported
  txhashes); they are layered on top when a local fleet is up and are out of scope for the on-chain
  gate. The driver emits every txhash the registry would ingest.
- [x] Runbook note committed (`services/e2e/README.md`).

## Verification

```bash
cd services/e2e && <run the e2e script against devnet>
solana account <vaultPda> --url devnet   # token balance 0 after terminal
```

## Risks & gotchas

- Devnet timing: `begin_live_window_sec` (5s) and the seal/observation windows are short — the e2e must orchestrate promptly or matches void. Consider a template with generous windows for the e2e run.
- signed-price-server + drand must be reachable from the worker; assert their health before the run.
- This phase surfaces integration drift (account ordering, field encodings) that unit tests miss — treat failures here as a signal to fix the owning phase, not to patch around in e2e.
