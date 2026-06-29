# shared — Deterministic Settlement Core

Pure Rust crate. No I/O, no clock, no oracle fetching. Everything else depends on this.

## Key files
- `src/lib.rs` — public exports: `settle()`, `SettleInput`, `SettleResult`, oracle types
- `src/settle.rs` — `settle()` entrypoint + conservation check
- (oracle validation, pot construction, winner math are internal modules)

## Core types
- `SettleInput { contributions, dead_money, config, verified_price, sealed_predictions }`
- `dead_money: Chips` — non-sealer penalty pool, added to main pot at settlement
- `VerifiedOraclePrice` — feed_id, price (i128), publish_time, confidence, exponent
- `OracleValidation` — expected_feed_id, scheduled_end_ts, max_confidence, expected_exponent

## Key invariant
Conservation: `Σ pots == Σ contributions + dead_money` (hard assert; caller VOIDs on failure).

## v1 note
`verify_settlement` (action-log replay binding) still exists in shared but is NOT called
from the contract in v1. It will be re-enabled in v1+. The `settle()` function itself
(pot math + winner selection) IS still the canonical source of truth for the worker.
