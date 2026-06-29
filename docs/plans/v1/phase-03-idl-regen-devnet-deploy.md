# Phase 03 — IDL regen + devnet deploy + create smoke

**Goal:** the committed IDL matches the finalized program, and the new layout is live on devnet.

- **Status:** ⬜ not started
- **Depends on:** 01 (for the create smoke)
- **Parallel-safe with:** 02, 05, 09, 10
- **Checklist ref:** §1c

---

## Context — why this phase exists

The committed IDL (`services/programs/target/idl/syndicate_program.json`) is **stale** — it still
lists `append_player_action`/`append_timeout_action`/`action_log` and lacks `create_and_deposit`,
`void_before_start`, `void_live_after_deadline`. Any client/tool generating from the IDL is wrong.
The new program layout also needs to be deployed (greenfield — no migration). NOTE: the old
"`declare_id!` mismatch" blocker is **resolved** — `Gwzr…` is consistent across keypair, harness, and
`lib.rs`; do not regenerate the program key.

## Scope

**In:** `cargo build-sbf`, commit fresh IDL, devnet deploy, a minimal `create_and_deposit` smoke.
**Out:** full lifecycle e2e (Phase 11), funds-exit matrix (Phase 09).

## Files to touch

- `services/programs/target/idl/syndicate_program.json` (regenerated artifact — commit it)
- `services/programs/Anchor.toml` (verify cluster/program id)
- `scripts/` — add/confirm a devnet deploy + smoke script

## Patterns to reuse

- Build toolchain: `cargo build-sbf --tools-version v1.53` (MUST be v1.53 — default v1.48/Rust 1.84 breaks edition2024 deps; see CLAUDE.md "SBF build blocker").
- Program id `GwzrCtondvENmbBkZCatGyXu1ST1ozVjwYS9Z9raqDmo` (already in `Anchor.toml` devnet/localnet/mainnet + `lib.rs:33` + litesvm harness).
- Phase 01 `buildCreateAndDepositInstruction` + `submit` wrapper for the smoke.

## Implementation steps

1. From `services/programs`: `cargo build-sbf --tools-version v1.53` (produces `target/deploy/syndicate_program.so` + regenerates `target/idl/syndicate_program.json`).
2. Diff the regenerated IDL's instruction list — confirm it now has `create_and_deposit`, `void_before_start`, `void_live_after_deadline`, `set_price_signer`; and does NOT have `append_player_action`/`append_timeout_action`/`init_action_log`/`set_button_seed`. Commit the fresh IDL.
3. Deploy to devnet with the existing deploy keypair: `solana program deploy target/deploy/syndicate_program.so --program-id target/deploy/syndicate_program-keypair.json --url devnet` (or the project's deploy script). Greenfield — no state migration.
4. `initialize_protocol` on devnet with the role keys + `price_signer` (the signed-price-server's Ethereum address). Confirm distinct role keys (full enforcement is Phase 12).
5. **Smoke:** run Phase 01's `create_and_deposit` against devnet; confirm the match PDA + creator seat exist (use Phase 02 `verifyCreateTx`).

## Acceptance criteria

- [ ] `.so` builds cleanly with `--tools-version v1.53`.
- [ ] Committed IDL contains the current instruction set and none of the removed ones.
- [ ] Program deployed + `initialize_protocol` succeeded on devnet.
- [ ] `create_and_deposit` smoke creates a verifiable match + seat on devnet.

## Verification

```bash
cd services/programs && cargo build-sbf --tools-version v1.53
python3 -c "import json;print([i['name'] for i in json.load(open('target/idl/syndicate_program.json'))['instructions']])"
# expect create_and_deposit/void_before_start/void_live_after_deadline present; no *action_log*/set_button_seed
solana account <matchPda> --url devnet   # after smoke
```

## Risks & gotchas

- Wrong toolchain ⇒ build fails on edition2024; always pass `--tools-version v1.53`.
- Devnet rent/airdrop: ensure the deploy payer is funded.
- Do NOT generate a new program keypair — ids are already aligned; a new key would re-introduce a mismatch and orphan the harness.
