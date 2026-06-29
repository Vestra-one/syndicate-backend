# Phase 09 — litesvm funds-exit × state matrix

**Goal:** prove the vault drains to exactly zero on every terminal path (the pre-audit capital-safety gate).

- **Status:** 🔴 blocked — code complete & host-compiled, but cannot RUN/verify: the
  Solana SBF toolchain is not installed on this machine, so `target/deploy/syndicate_program.so`
  cannot be produced and the harness's `add_program_from_file` fails at load. Concretely:
  `cargo build-sbf` → `error: no such command: build-sbf`; no `solana`/`anchor`/`avm`/
  `cargo-build-sbf` anywhere on PATH or in `~/.local/share/solana`; no `.so` on disk.
  All helpers, the two previously-`#[ignore]` tests (un-ignored + fleshed out), the full
  funds-exit matrix (`funds_exit_matrix.rs`), golden-parity-through-`.so`, and the
  auto-check fairness assertion are written and compile cleanly on the host target
  (`cargo test --no-run` green). To unblock: install platform-tools v1.53, run
  `cargo build-sbf --tools-version v1.53 -p syndicate-program`, then `cargo test`.
- **Depends on:** — (contract final; independent of TS work)
- **Parallel-safe with:** everything
- **Checklist ref:** §7

---

## Context — why this phase exists

The litesvm harness drives the current instruction signatures and `declare_id!` is aligned, but the
two lifecycle tests are `#[ignore]` (pending the `.so`) and there is **no exhaustive funds-exit
matrix**. Before any audit we must mechanically prove that for every reachable terminal state the
vault balance ends at exactly zero under the generalized conservation invariant.

## Scope

**In:** missing harness helpers, build the `.so`, un-ignore tests, the exhaustive matrix, golden parity through the `.so`.
**Out:** devnet e2e (Phase 11).

## Files to touch

- `services/programs/litesvm-tests/tests/common/mod.rs` (add helpers)
- `services/programs/litesvm-tests/tests/full_lifecycle.rs` (un-ignore + extend)
- new `services/programs/litesvm-tests/tests/funds_exit_matrix.rs`

## Patterns to reuse

- Harness: `mod.rs:124-327` (`MatchHarness::new` → init → create → deposit → lock); `program_so_path` `:35-37`; `ix_data(disc, args)` `:49-53`; PDA helpers `:55-76`; `send(svm, payer, ixs, signers)` `:107-122`.
- Existing helpers: `init_protocol`, `create_match`, `deposit_all`, `lock_match`.
- The two `#[ignore]` tests: `full_lifecycle.rs:7-20`.
- Golden parity reference: `tests/golden_parity.rs` (loads `golden/showdown_3handed.json`, checks conservation).

## Implementation steps

1. **Add harness helpers** mirroring `ix_data`+`send`: `register_prediction_commitment(player, target_round, commitment)`, `begin_live(button_randomness, seat_pdas)` (passes seats as remaining_accounts), `submit_settlement(signed_price_dto, rake, payouts)`, `claim(player)`, `refund(player)`, `void()`, `void_before_start()`, `void_live_after_deadline()`. For signed-price, build a `SignedPriceDto` with a test signer recoverable to the configured `price_signer` (or set `price_signer` to a known test key in `init_protocol`).
2. `cargo build-sbf --tools-version v1.53` so the `.so` exists at `target/deploy/syndicate_program.so`.
3. **Un-ignore** `sealing_to_live_lifecycle` + `withdraw_fees_after_settlement` and flesh them out.
4. **`funds_exit_matrix.rs`** — one test per row, each asserting the vault token balance == 0 after all claims/refunds/fee-withdrawals:
   - Filling never reaches min by `fill_deadline_ts` → `void_before_start` → full refund all.
   - Sealing `< min` sealed by deadline → `begin_live` → UnderMinSealed VOID → sealers `buy_in+fee+penalty-share` (remainder to earliest seal), non-sealers `deposit-penalty` (fee forfeited → `withdraw_fees`).
   - Stuck Sealing past grace → `void_before_start` (FillingVoid) → full refund.
   - Live → `submit_settlement` → `claim` for sealers (incl. **leftover-stack** payout) + non-sealer `claim` (`deposit-penalty`); `withdraw_fees` drains rake+fees.
   - Live, settlement never lands → `void_live_after_deadline` (Emergency) → full refund all.
   - Settled → double-`claim` is rejected (idempotency).
   - Emergency `void` during Live → full refund all, penalties waived.
5. **Golden parity through `.so`:** settle a known scenario on-chain and assert per-seat payouts == `shared::settle()` reference (extend `golden_parity.rs`).
6. **Multi-street fairness:** assert auto-check is granted ONLY when `to_call == 0` (no free pot eligibility) — drive via the engine/settlement inputs feeding `submit_settlement`.

## Acceptance criteria

- [ ] All new helpers exist; the two previously-ignored tests run and pass.
- [ ] Every matrix row ends with vault balance exactly 0.
- [ ] Golden parity holds through the program `.so`, not just the shared core.
- [ ] Auto-check-only-when-`to_call==0` asserted.

## Verification

```bash
cd services/programs && cargo build-sbf --tools-version v1.53
cd services/programs/litesvm-tests && cargo test                 # all green, none ignored
```

## Risks & gotchas

- The signed-price verification needs a signature recoverable to `ProtocolState.price_signer`; either seed `price_signer` with a test secp256k1 key whose private half the test holds, or stub at the `verify_signed_price` boundary — prefer a real signature for fidelity.
- Conservation includes `dead_money` and `forfeited_fees`; the matrix must `withdraw_fees` where applicable to reach exactly zero (rake + forfeited entry fees live in the vault until withdrawn).
- `begin_live` needs `remaining_accounts.len() == player_count`; build the seat list from the harness's known seats.
