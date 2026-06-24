# Golden vectors — the parity contract

These fixtures are the **off-chain ↔ on-chain determinism contract** (`04_GAME_MECHANICS §18`). Each captures `inputs` and the `expected` settlement result produced by the single deterministic crate, `syndicate-shared`.

The guarantee they enforce: **every implementation that settles a match must produce `expected` from `inputs`, byte-for-byte.** Concretely, all of these must agree —

- the off-chain pipeline (`services/settlement/tests/e2e.rs`),
- the core unit/property tests (`services/shared/tests/core.rs`),
- the on-chain program's litesvm tests (`services/programs`, run in the Solana CI),

because they all call the same `syndicate-shared` logic. If any diverges, the determinism invariant is broken and the change must be rejected (it would mean the chain could disagree with the off-chain builder, which is a foundation-level regression).

## Files

| File | Scenario |
|------|----------|
| `showdown_3handed.json` | 3-handed limped hand to showdown; pot 6; seat 0 closest to `S=100000` → wins 6. |

## How they're used

- **Rust**: the values are asserted inline in `services/settlement/tests/e2e.rs` and `services/shared/tests/core.rs`.
- **Anchor (Solana CI)**: the program's litesvm test loads the same `inputs`, calls `submit_settlement`, and asserts the on-chain result equals `expected` — proving the program re-derives the identical outcome before releasing funds.

Add a new fixture whenever a new settlement shape is introduced (multi-tier side pots, ties, uncalled returns, rake), and wire it into all three test sites.
