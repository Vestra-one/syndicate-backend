# Phase 08 — Client / protocol integration

**Goal:** the frontend protocol + reference client match v1 (signed-price, player-created, explicit seal, txhash reporting).

- **Status:** ✅ done & verified (protocol.ts has no Pyth types; `SignedPriceView` mirrors `SignedPriceDto`; reference client drives create→deposit→seal→claim w/ txhash reporting + clock-synced countdowns; guide updated. Type-checked via `node --experimental-strip-types` since `tsc` isn't installed here.)
- **Depends on:** 01 (builders), 07 (envelope shape)
- **Parallel-safe with:** 09, 10
- **Checklist ref:** §5

---

## Context — why this phase exists

`docs/frontend/protocol.ts` still models a **Pyth** oracle adapter (`oracleAdapter:'pyth'`,
`PythOracleProofView`) — v1 uses a signed price. The reference client must also drive the
player-created flow: build+sign `create_and_deposit`/`deposit`, **report the txhash** to the backend,
do the explicit seal during Sealing (tlock-encrypt + `register_prediction_commitment`, one wallet
popup, no session key), and render clock-synced countdowns from the gateway's server time.

## Scope

**In:** protocol type updates; reference client flow; integration guide.
**Out:** the on-chain builders (Phase 01); gateway envelopes (Phase 07); verification endpoints (Phase 06).

## Files to touch

- `docs/frontend/protocol.ts`
- `docs/frontend/example-client.ts`
- `docs/frontend/INTEGRATION_GUIDE.md`

## Patterns to reuse

- Phase 01 builders (`create_and_deposit`, `deposit`, `register_prediction_commitment`).
- Signed-price shape: `SignedPriceDto { token[20], price_in_wad[32], timestamp_ms u64, v u8, r[32], s[32] }` from `services/programs/programs/syndicate_program/src/settle_args.rs`.
- Phase 07 envelope fields (`serverTime`, `sealEndsAt`, `bettingEndsAt`, `matchEndsAt`, `yourTurnDeadline`).
- Timelock client: `services/timelock` (drand quicknet, genesis `1692803367`, period `3`); the worker decrypts via `DrandTimelockOpenClient`.

## Implementation steps

1. **Protocol types:** replace the Pyth oracle view (`protocol.ts:72` `oracleAdapter:'pyth'`, `:175-192` `PythOracleProofView`, `:229`, `:256`) with a `SignedPriceView` mirroring `SignedPriceDto`. Remove Pyth-specific fields (`atomic`/`two_step` post modes etc.).
2. **Create/join:** client builds+signs `create_and_deposit` (host) / `deposit` (joiner) from `GET /config/templates` params, submits, then **reports the txhash** to matchmaking (`POST /rooms` or `POST /matches/:id/deposits`).
3. **Seal flow (Sealing phase):** client picks its prediction, tlock-encrypts it to `timelock_target` (drand), uploads the ciphertext to the timelock store, and signs `register_prediction_commitment({commitment: hash(ciphertext), timelock_target})` — one wallet popup, no session key/delegate.
4. **Countdowns:** subscribe to the gateway; compute remaining time as `deadline - serverTime + localOffset` using the forwarded absolute deadlines (Phase 07).
5. **End-to-end seal check:** confirm the ciphertext the client uploads is exactly what the worker's timelock decrypt reads at settlement (same store, same key derivation). Document the store contract in the guide.
6. Update `INTEGRATION_GUIDE.md` for the new flow + the txhash-reporting contract.

## Acceptance criteria

- [ ] `protocol.ts` has no Pyth types; a `SignedPriceView` matches `SignedPriceDto`.
- [ ] Reference client drives create→deposit→seal→(live)→claim and reports txhashes.
- [ ] Seal uses an explicit per-player signature (no session key); ciphertext store round-trips to the worker decrypt.
- [ ] Countdowns use server time + forwarded absolute deadlines.
- [ ] `INTEGRATION_GUIDE.md` updated.

## Verification

```bash
cd services/settlement-chain && npx tsc --noEmit docs/frontend/protocol.ts   # or the project's type-check
grep -rn "pyth\|Pyth" docs/frontend/protocol.ts   # expect no matches
# manual happy-path against devnet is Phase 11
```

## Risks & gotchas

- The seal commitment recorded on-chain is `hash(ciphertext)`; the worker binding-checks the decrypted prediction against it — the client's hash function MUST match the contract's (`prediction_commitment` semantics). Verify against `services/programs` + `services/timelock`.
- `timelock_target` must satisfy the on-chain two-sided bound `(latest_match_end, latest_match_end + 20s]` — compute it via config `timelockTargetRound`, never a placeholder.
