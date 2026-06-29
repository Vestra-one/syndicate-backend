# Phase 06 — Matchmaking registry from RPC-verified txhashes

**Goal:** player-created rooms; the backend registry is fed by verified create/deposit txhashes; no operator-create.

- **Status:** ⬜ not started
- **Depends on:** 02 (RPC verify), 05 (match-row persistence)
- **Parallel-safe with:** 09, 10
- **Checklist ref:** §3

---

## Context — why this phase exists

v1 is player-created: matchmaking no longer creates matches on-chain. Instead a host creates the
match (`create_and_deposit`) and **reports the txhash**; joiners deposit and report theirs. The
backend verifies each via RPC (Phase 02) and maintains its own open-rooms registry. Much of the
scaffold already exists (`POST /rooms`, `POST /matches/:id/deposits`, `SolanaDepositVerifier`,
Redis keys) — this phase removes the operator-create path, wires verification + persistence, and
fixes a known bug.

## Scope

**In:** remove bootstrap/create flows; verified create/deposit endpoints; `GET /rooms` from registry;
per-wallet cap; fix the `record` bug.
**Out:** the verifier internals (Phase 02), schema/writer (Phase 05), gateway push (Phase 07).

## Files to touch

- `services/matchmaking/src/formation.ts`
- `services/matchmaking/src/main.ts`
- `services/matchmaking/src/orchestrator-client.ts`
- `services/matchmaking/src/deposit-verify.ts`
- `services/matchmaking/src/deadline-worker.ts`

## Patterns to reuse

- Routes: `main.ts:36-126` (already has `POST /rooms`, `GET /rooms/:roomCode`, `POST /matches/:matchId/deposits`, `POST /rooms/:roomCode/start`).
- Existing verifier: `deposit-verify.ts` `SolanaDepositVerifier:34-91` + `createSolanaRpc:94-125` — reuse/extend; align with settlement-chain Phase 02 (`verifyDepositTx`/`verifyCreateTx`).
- Redis keys/conventions: `redis-keys.ts` (room/formation/queue/deadlines/pending-deposit keys).
- Deadline worker (auto-start/auto-void): `deadline-worker.ts:36-103`.
- Store writers from Phase 05 (`insert_match`, `insert_match_seat`, ...).
- Orchestrator trigger to keep: `orchestrator-client.ts` `triggerStartPolicy:86-106`.

## Implementation steps

1. **Remove operator-create:** delete `bootstrapFormation` calls (`formation.ts:96,264`) and the `createRoom`/`joinQueue` on-chain-create flows + `orchestrator-client.ts` `bootstrapFormation:57-85`. Matchmaking never creates matches.
2. **`POST /rooms` (host create report):** accept `{ createTxSig, matchPda, onchainMatchId, configHash, wallet, seatIndex }`; verify via `verifyCreateTx` (Phase 02); on success write the match row (Phase 05 `insert_match` + creator `insert_match_seat`) and a registry entry (Redis room key + `deadlines` zset for `fill_deadline_ts`).
3. **Deposit report (`POST /matches/:matchId/deposits`):** accept `{ depositTxSig, wallet, seatIndex }`; verify via `verifyDepositTx`; on success `insert_match_seat` + bump registry seat count.
4. **`GET /rooms?feed=&template=&buyIn=`:** serve from the registry (Redis/Postgres), filtered + ranked (bury new/single-occupant rooms).
5. **Per-wallet cap:** before accepting a create, reject if the wallet already has ≥N active-unfilled rooms (Redis counter keyed by wallet). Apply at create and optionally join.
6. **Fix the bug** at `formation.ts:~395`: `const loaded = await this.loadRoom(record.matchId)` references an undefined `record` — bind it to the in-scope formation record (this is the start-policy trigger seam; ensure it reads the verified room).
7. **Allowlist:** reject create/join whose `configHash ∉ templateAllowlist()`.
8. Keep `deadline-worker` and `triggerStartPolicy` → orchestrator; re-point them at the registry (no bootstrap).

## Acceptance criteria

- [ ] No `bootstrapFormation`/operator-create path remains; matchmaking creates no on-chain matches.
- [ ] Create/deposit are accepted only with an RPC-verified `finalized` txhash; non-allowlisted `config_hash` rejected.
- [ ] `GET /rooms` serves the registry; per-wallet active-room cap enforced.
- [ ] `formation.ts:~395` `record` bug fixed (no undefined reference).
- [ ] Verified create writes a `matches` row (Phase 05); verified deposit writes a `match_seats` row.

## Verification

```bash
cd services/matchmaking && npm test
grep -rn "bootstrapFormation" src/   # expect no matches
# integration: report a real devnet create+deposit sig → row written + room listed
```

## Risks & gotchas

- The registry is **UX-only**: never let a missing/stale registry block a capital path — `begin_live` seats come from chain (Phase 02), settlement/void read PDAs. A room the backend never heard about can still be refunded on-chain permissionlessly.
- Keep matchmaking's verifier and settlement-chain's verifier consistent (share the predicate).
- Idempotency: a re-reported txhash must be a no-op (use the existing `syndicate:deposit:pending:{sig}` key).
