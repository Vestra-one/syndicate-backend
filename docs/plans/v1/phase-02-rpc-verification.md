# Phase 02 — settlement-chain RPC verification + seat-PDA enumeration

**Goal:** verify a client-reported create/deposit txhash at `finalized`, and enumerate seat PDAs from chain.

- **Status:** ✅ done & verified
- **Depends on:** — (devnet not required for unit tests; integration needs Phase 03)
- **Parallel-safe with:** 01, 05, 09, 10
- **Checklist ref:** §1a, §2 (the no-indexer model's core)

---

## Context — why this phase exists

There is no indexer. The backend learns about on-chain state from **client-reported txhashes that it
verifies via RPC**, and the authoritative seat set for `begin_live` is read from chain with
`getProgramAccounts`. This phase provides those two primitives plus correct `MatchAccount`/`SeatAccount`
deserializers (today only single-field offset hacks exist, and one offset is stale).

## Scope

**In:** `verifyDepositTx`, `enumerateSeatPdas`, full account deserializers, unit tests with fixture bytes.
**Out:** instruction building (Phase 01); the matchmaking endpoints that call these (Phase 06).

## Files to touch

- new `services/settlement-chain/src/verify.ts` (or extend `custody.ts`)
- `services/settlement-chain/src/matchAccount.ts` — proper deserializers replacing offset hacks
- `services/settlement-chain/test/verify.test.ts` (new)

## Patterns to reuse

- `getAccountInfo` read: `custody.ts:304-309`; status-byte read `:541-547`; seat-field read `:487-495`.
- `Connection` ctor + commitment: `connectionFor` `custody.ts:402-404` (use `'finalized'` here, not `'confirmed'`).
- **Mirror matchmaking's existing verifier** so the two agree: `services/matchmaking/src/deposit-verify.ts` `SolanaDepositVerifier:34-91` + `createSolanaRpc:94-125`. Prefer sharing the validation predicate (export it) over duplicating.
- Allowlist source: `config` package `templateAllowlist()` / `getTemplateByHash()` (`services/config/src/index.ts`).
- Field layout for deserializers: `services/programs/programs/syndicate_program/src/state.rs` (`MatchAccount` `:70-149`, `SeatAccount` `:192-225`). Anchor prepends an 8-byte discriminator.

## Implementation steps

1. **Deserializers** (`matchAccount.ts`): write `decodeMatchAccount(data: Buffer)` and `decodeSeatAccount(data: Buffer)` that parse fields in `state.rs` order from offset 8. Expose at least: match → `{ status, config_hash, price_token, player_count, sealed_count, fill_deadline_ts, ... }`; seat → `{ match_key, player, seat_index, deposit, entry_fee_paid, commitment_set, engine_seat }`. Remove the magic-number offset readers.
2. **`verifyDepositTx({ sig, expectedMatchPda, expectedPlayer, expectedSeatIndex })`**: `getTransaction(sig, { commitment:'finalized', maxSupportedTransactionVersion:0 })`; assert `meta.err == null` and the program id is in the tx; then `getAccountInfo(seatPda,'finalized')` + `getAccountInfo(matchPda,'finalized')`, `decode*`, and assert: seat `player == expectedPlayer`, `seat_index == expectedSeatIndex`, `deposit == match.buy_in`; match `status == Filling`; `config_hash ∈ templateAllowlist()`. Return a typed result `{ ok, matchPda, player, seatIndex, buyIn }` or a structured rejection.
3. **`verifyCreateTx({ sig, expectedMatchPda })`**: same shape, asserting the match PDA now exists, `status == Filling`, `config_hash` allowlisted, and the creator seat (if `create_and_deposit`) is present.
4. **`enumerateSeatPdas(matchPda): Promise<{ pubkey, seatIndex, player }[]>`**: `getProgramAccounts(programId, { commitment:'finalized', filters:[{ dataSize: SEAT_ACCOUNT_SIZE }, { memcmp:{ offset:8, bytes: matchPda.toBase58() } }] })`; decode each; sort by `seat_index`. This is the authoritative set for `begin_live`.
5. **Tests**: fixture `MatchAccount`/`SeatAccount` byte buffers (build with the Phase 01 encoders or hand-pack per `state.rs`); assert decoders read correct fields; assert `verifyDepositTx` rejects unfinalized/failed/wrong-seat/non-allowlisted (mock the RPC client).

## Acceptance criteria

- [ ] `decodeMatchAccount`/`decodeSeatAccount` parse all needed fields against `state.rs` (no magic offsets left).
- [ ] `verifyDepositTx`/`verifyCreateTx` read at `'finalized'` and reject: tx error, missing/short account, wrong player/seat_index, `status != Filling`, non-allowlisted `config_hash`.
- [ ] `enumerateSeatPdas` returns exactly the existing seats, sorted by `seat_index`.
- [ ] Validation logic shared with (or consistent with) matchmaking's `SolanaDepositVerifier`.

## Verification

```bash
cd services/settlement-chain && npm test
# integration (after Phase 03 devnet deploy): verify a real deposit sig + enumerate its match's seats
```

## Risks & gotchas

- Use `'finalized'` for seating decisions (re-org safety) — the on-chain rule is "seat only on finalized deposit."
- `getProgramAccounts` `dataSize` must equal `SeatAccount::SPACE` (`state.rs:230-249`); if it drifts, the memcmp filter silently returns nothing. Compute it, don't hardcode blindly.
- Two verifiers (here + matchmaking) MUST agree on the predicate — export one and import it, or this becomes a divergence bug.
