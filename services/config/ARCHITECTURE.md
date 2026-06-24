# Service: `config` — Versioned Game Parameters

**Stack:** Schema-first — TS/Node service + generated **Rust + TS clients**. **Trust role:** the single home of every tunable number; bound per match and recorded for replay. **Implements:** `04 §2`; `06 §12`; the founder mandate "PMF via config, not code" (`08 OQ7`).

> Every game number lives here, never in code: round count/durations, blinds, antes, action timer + replenishing bank, settlement window, sample cadence/guards, fees (entry + rake), caps (`max_buy_in`), feed, token, player counts, timelock target + grace, geofence list, T&S thresholds.

---

## Responsibilities (owns)
- **Parameter schema** (typed, validated) + **versioned config sets** (e.g., per tier/feed/experiment).
- **Bind-at-match-creation:** the exact config a match runs under is snapshotted, hashed, and **recorded in the match log for replay** (so historical matches reproduce exactly).
- **Validation/guardrails:** reject unsafe combinations (e.g., stack depth too low for blinds, window below min samples).
- **Distribution:** typed clients for Rust services (`match-engine`, `settlement`, `oracle-adapter`, `timelock`, `programs` constants) and TS services (`gateway`, `matchmaking`, `action-feed`, `trust-safety`).

## Non-responsibilities
- No gameplay, custody, or outcome logic — it only supplies validated parameters.
- Does not change a **live** match's parameters (config is immutable for a match once bound — `04 §2`).

## Internal structure (suggested)
```
config/
  schema/        # parameter schema (source of truth) + validation rules
  sets/          # versioned config sets (tiers, feeds, experiments)
  service/       # TS API: fetch/bind/version
  clients/       # generated Rust + TS typed clients
  ARCHITECTURE.md
```

## Interfaces
- **Out:** validated, versioned config to all services; the per-match snapshot + hash to `match-engine`/`settlement` (replay input).
- **In:** authored config changes (reviewed, validated) from operators.

## Invariants & failure modes
- A match's parameters are **fixed for its duration** and recorded for replay; live mutation is forbidden.
- Invalid/unsafe config is rejected at author time, not discovered at match time.
- The config hash is part of the deterministic settlement inputs (`04 §18`).

## Dependencies
- None outbound at runtime (services depend on it). On-chain-relevant constants (fees, caps) are mirrored to `programs` deterministically.

## Testing
- Schema validation + guardrail rejection tests.
- Replay: a recorded config hash reproduces identical settlement.
- Client parity: Rust and TS clients deserialize the same set identically.

## AI-agent rules
- **Adding any game number? It goes here** (schema + validation + default), then is consumed via the typed client — never hard-coded in a service.
- Never mutate a bound match's config; introduce a new version instead.
- Keep the config hash in the replay inputs whenever you add a parameter that affects outcomes.
