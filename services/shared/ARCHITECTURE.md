# Service: `shared` — Deterministic Core & Domain Types

**Stack:** Rust crate (pure, `no_std`-friendly where possible; optional WASM build for TS consumers). **Trust role:** the single source of truth for all outcome math. **Implements:** `04 §1,§9,§11,§13,§18`.

> This crate is the most important code in the system. The exact same compiled logic runs in `settlement` (off-chain) and `programs` (on-chain) so results are **byte-identical**. There must be **exactly one** implementation of pot construction, `S`, winner selection, and tie-breaks — here.

---

## Responsibilities (owns)
- **Domain types:** `Chips` (integer), fixed-point `Price` (per-feed precision), `MatchConfig`, `Contribution`, `Action`, `EventLog` (hash-chained), `OracleSample`, `SealedPrediction`, `SettlementResult`.
- **Pure money math:** integer-only arithmetic; no floats, ever.
- **Pot construction & side-pots** (`04 §9` algorithm): contribution-tier layering, uncalled-bet returns, dead-money handling, conservation check.
- **Settlement price `S`:** window-median over oracle samples with confidence/staleness guards (`04 §11`).
- **Winner determination & ties:** smallest `|p_i − S|` per eligible pot; equal split; odd-chip → earliest seal timestamp → lowest seat index (`04 §13`).
- **Replay function:** `settle(log, sealed+key, samples, vrf_seed, config) → SettlementResult` — the canonical pure function (`04 §18`).

## Non-responsibilities
- No I/O, no network, no clock, no randomness *generation* (VRF seed is an input), no oracle fetching, no decryption (takes already-decrypted predictions + verifies binding). Purity is what makes it verifiable.

## Internal structure (suggested)
```
shared/src/
  types/         # Chips, Price, ids, config
  log/           # hash-chained event log + intent verification
  pots/          # side-pot construction (the §9 algorithm)
  settle/        # S median + winner selection + ties + top-level settle()
  replay/        # pure replay entrypoint
  lib.rs
tests/           # property + golden-vector tests
```

## Key invariants (enforced + tested here)
- **Conservation:** `Σ pots + Σ uncalled_returns == Σ contributions` (asserted; failure is a hard error → caller VOIDs).
- **Determinism:** identical inputs → identical bytes out; no map/iteration-order nondeterminism; stable sorting with explicit tiebreaks.
- **No float, no panic on adversarial input** (return typed errors).

## Worked reference (must stay green)
The `04 §9` example — contributions D=20(folded), B=60, A=100, C=100 → pots **80 / 120 / 80**, total 280 — is a golden test. Uncalled-bet return and multi-tier all-in cases are golden tests too.

## Dependencies
- None outbound. Everything else depends on **it**.

## Testing (merge-blocking)
- **Property:** random contribution/fold vectors always conserve; uncalled returns correct; pots never pay an ineligible player.
- **Golden vectors:** shared fixtures consumed by `settlement` and `programs` to prove three-way byte-identity.
- **Differential:** if a WASM/TS mirror is ever introduced, it must diff-test against this crate (preferred: compile this crate to WASM rather than re-implement).

## AI-agent rules
- **All outcome logic lives here.** If `settlement`, `match-engine`, or `programs` needs pot/`S`/winner/tie logic, add or call a function here — never re-implement downstream.
- Keep it **pure**: inputs in, result out. No clocks, no I/O, no globals.
- Any change requires updated property + golden tests and must keep determinism across the `settlement`/`programs` consumers.
- Never introduce floating point or locale/iteration-order dependence.
