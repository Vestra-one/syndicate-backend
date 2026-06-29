# match-engine — Betting Engine (Rust, HTTP)

Manages live match state: action ordering, street timing, timeouts.

## Key files
- `src/service.rs` — `MatchService`, `MatchConfig` (with `round_durations_sec`, `observation_windows_sec`, `time_bank_sec`)
- `src/server.rs` — HTTP handlers, `StartBody`, `ActiveMatch`
- `src/lib.rs` — types, `EngineAction`, `EngineResult`
- `src/persistence.rs` — match-state persistence

## Key methods on MatchConfig
- `total_betting_duration_sec()` — Σ street durations + observations
- `betting_open(live_start_ms, now_ms)` — is betting currently open?
- `current_street_close_ms(live_start_ms)` — when does current street close?
- `force_resolve_street(leases, now_ms)` — timeout handling

## StartBody fields
`roundDurationsSec`, `observationWindowsSec`, `timeBankSec`, `liveStartTs`

## Notes
- Multi-street: configurable rounds. Players who can't act in time "check" by default.
- Engine is NOT trusted for outcomes — it only orders actions. Settlement re-derives outcomes via `shared::settle()`.
- `engine_seat` indices (0..sealed_count) match the contract's contiguous assignment.
