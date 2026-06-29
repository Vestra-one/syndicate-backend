# Phase 01 — settlement-chain lifecycle instruction builders + routes

**Goal:** every on-chain lifecycle instruction is buildable + submittable from the TypeScript client; dead button-seed code removed.

- **Status:** ✅ done & verified
- **Depends on:** — (contract is final)
- **Parallel-safe with:** 02, 05, 09, 10
- **Checklist ref:** [V1_COMPLETION_CHECKLIST.md](../V1_COMPLETION_CHECKLIST.md) §1a

---

## Context — why this phase exists

`services/settlement-chain` builds the Solana instructions the orchestrator/worker submit. Today it
can build `create_match`, `lock`, `claim`/`refund`, `withdraw_fees`, `submit_settlement` — but
**`begin_live` is broken** (missing `button_randomness[32]` + seat `remaining_accounts`) and five
lifecycle builders are missing entirely (`deposit`, `create_and_deposit`,
`register_prediction_commitment`, `void_before_start`, `void_live_after_deadline`). It also still
carries the dead `set_button_seed` builder/route and a stale hardcoded account offset. Until this is
fixed the match lifecycle cannot be driven from the backend.

## Scope

**In:** instruction builders, their Borsh arg encoders, `/internal/solana/*` routes, unit tests, and
removal of dead button-seed code.
**Out:** RPC reads/verification + seat enumeration (Phase 02), the actual devnet deploy (Phase 03),
orchestrator wiring (Phase 04).

## Files to touch

- `services/settlement-chain/src/custody.ts` — builders + encoders + submit fns
- `services/settlement-chain/src/main.ts` — `/internal/solana/*` route dispatch
- `services/settlement-chain/src/matchAccount.ts` — delete the stale offset + dead reader
- `services/settlement-chain/test/custody.test.ts` — byte-length + discriminator tests

## Patterns to reuse (copy these idioms)

- Builder shape (keys/AccountMeta order, programId, `data = discriminator || params`): `custody.ts:192-213` (create), `:215-230` (lock, no-arg), `:377-400` (claim/refund, dynamic discriminator).
- PDA derivation: `deriveMatchPdas` `custody.ts:184-190` — seeds `['protocol']`, `['match', u64(id)]`, `['vault', match]`. Seat PDA seeds: `['seat', match, player]`; seat-index: `['seat-index', match, u16(seat_index)]`.
- Borsh encoders `u8/u32/u64/i32` `custody.ts:594-622`; `encodeCreateParams` `:148-182` (138-byte layout).
- Submit idiom `submitCreateMatch` `custody.ts:410-431`; tx send/confirm `sendSignedLegacyTx` `:561-585` (`'confirmed'` commitment, simulate-then-send); `connectionFor` `:402-404`; signer `operatorSigner` `:406-408`.
- Route dispatch: `main.ts:113-150`.
- Discriminator helper: `anchorDiscriminator('global:<ix_name>')` `actionLog.ts:7-9`.
- Test idioms: byte-length `custody.test.ts:17-53`; discriminator `:55-79`.

## Implementation steps

Account-meta order MUST mirror the on-chain context structs in
`services/programs/programs/syndicate_program/src/lib.rs`. Cite each as you build:

1. **`buildDepositInstruction(programId, player, pdas, seatIndexAccount, playerToken, seat_index:u16)`** — context `Deposit` (`lib.rs:1102-1127`): keys `[player(signer,w), protocol, match(w), seat(w), seat_index(w), player_token(w), vault(w), token_program, system_program]`; data `disc('global:deposit') || u16(seat_index)`.
2. **`buildCreateAndDepositInstruction(..., params, seat_index:u16)`** — context `CreateAndDeposit` (`lib.rs:1133-1167`): keys `[authority(signer,w), protocol, mint, match(w), vault(w), seat(w), seat_index(w), player_token(w), token_program, system_program, rent]`; data `disc('global:create_and_deposit') || encodeCreateParams(...) || u16(seat_index)`. (`player_token.mint == mint`.)
3. **`buildRegisterPredictionCommitmentInstruction(programId, player, pdas, {commitment:[u8;32], timelock_target:bigint})`** — context `RegisterPredictionCommitment` (`lib.rs:1244-1260`): keys `[player(signer), match(w), seat(w)]`; data `disc('global:register_prediction_commitment') || commitment(32) || u64(timelock_target)`.
4. **Fix `buildBeginLiveInstruction`** — context `AdminMatch` (`lib.rs:1169-1176`) + seats as `remaining_accounts`: keys `[authority(signer), protocol, match(w), ...seatPDAs(w)]`; data `disc('global:begin_live') || button_randomness(32)`. Accept `seatPdas: PublicKey[]` and `buttonRandomness: Buffer(32)` params.
5. **`buildVoidBeforeStartInstruction(programId, pdas)`** — context `PermissionlessVoidPreStart` (`lib.rs:1179-1183`): keys `[match(w)]`; data `disc('global:void_before_start')`.
6. **`buildVoidLiveAfterDeadlineInstruction(programId, pdas)`** — context `PermissionlessVoidLive` (`lib.rs:1186-1190`): keys `[match(w)]`; data `disc('global:void_live_after_deadline')`.
7. **Submit wrappers** for each (mirror `submitCreateMatch`): build → `new Transaction().add(ix)` → `sendSignedLegacyTx`. For `begin_live`, source seat PDAs from the caller (Phase 02 enumeration) — accept them as input here.
8. **Routes** in `main.ts`: add `/internal/solana/deposit`, `/create-and-deposit`, `/register-commitment`, `/void-before-start`, `/void-live-after-deadline`; update `/begin-live` to accept `buttonRandomness` + `seatWallets`/`seatPdas`.
9. **Delete dead code:** `buildSetButtonSeedInstruction`, `submitSetButtonSeed`, `SetButtonSeedInput`, the `/internal/solana/set-button-seed` route, and in `matchAccount.ts` remove `readMatchPlayerCount` + `MATCH_ACCOUNT_PLAYER_COUNT_OFFSET = 235` (offset stale post-reorder; only the dead path used it).
10. **Tests:** add byte-length asserts for each new arg encoder (deposit=u16; create_and_deposit=138+2; register=40) and discriminator asserts for every new builder; assert `begin_live` data length == 8+32 and includes seats in keys.

## Acceptance criteria

- [ ] Builders exist for deposit, create_and_deposit, register_prediction_commitment, void_before_start, void_live_after_deadline.
- [ ] `buildBeginLiveInstruction` appends `button_randomness[32]` and includes seat PDAs as writable remaining_accounts.
- [ ] No `set_button_seed` / `MATCH_ACCOUNT_PLAYER_COUNT_OFFSET` symbols remain anywhere in the package.
- [ ] Every builder's account order matches the cited `lib.rs` context struct.
- [ ] New unit tests pass.

## Verification

```bash
cd services/settlement-chain && npm test
grep -rn "set_button_seed\|setButtonSeed\|MATCH_ACCOUNT_PLAYER_COUNT_OFFSET" src/   # expect no matches
```

## Risks & gotchas

- **Account ordering is the #1 drift risk** — Anchor matches by position; a wrong order yields opaque `ConstraintSeeds`/`AccountNotInitialized` errors. Cite and re-check each context struct.
- `create_and_deposit` constrains `player_token.mint == mint.key()` (not `match_account.mint`, which is zeroed pre-handler) — pass the real mint.
- `begin_live` requires `remaining_accounts.len() == player_count` on-chain; the seat list must be the full set (Phase 02 enumerates it). This builder just needs to accept and place them.
