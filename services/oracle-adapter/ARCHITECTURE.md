# Service: `oracle-adapter` — Modular Pull Oracle & Settlement Price

**Stack:** Rust. **Trust role:** the highest-integrity data path — it produces the samples that decide `S`. **Implements:** `04 §11`; `06 §3`; decisions `08 OQ1,OQ2`.

> Provider-agnostic by design: a single "pull a signed price sample now" interface behind which **Switchboard On-Demand** is the locked default, with Pyth and others pluggable via config — **no settlement code changes** on a provider swap.

---

## Responsibilities (owns)
- **Pull-based sampling** of `price_feed_id` at a fixed cadence across the match, and densely across the `settlement_window`; persist every `(timestamp, price, confidence)` to the action log for replay.
- **Finalize `S`** = window **median** with confidence/staleness guards (the median math itself lives in `shared`; this service supplies validated samples and invokes it).
- **Feed-health guards → VOID:** discard stale/low-confidence samples; if valid samples < minimum, signal VOID (`04 §11`).
- **Provider adapter:** uniform interface; Switchboard On-Demand default; optional low-latency **Surge** stream to drive the live chart (same recorded source as settlement to avoid "chart said X but I lost").
- Expose `max_buy_in`/cap inputs context (the v1 anti-manipulation control; detailed telemetry deferred per `08 OQ2`).

## Non-responsibilities
- No median/winner math definition (lives in `shared`; this service calls it with validated samples).
- No custody, no gameplay, no decryption.

## Internal structure (suggested)
```
oracle-adapter/src/
  adapter/        # trait OracleProvider { pull_sample(feed) -> SignedSample }
    switchboard/  # default (On-Demand + optional Surge)
    pyth/         # pluggable alternative
  sample/         # cadence scheduler, persistence to action log
  settle/         # window selection, guard checks, call shared::median_S
  health/         # staleness/confidence monitors, VOID signaling
  main.rs
```

## Interfaces
- **In:** `price_feed_id` + sampling/window/guard params from `config`; match clock from `match-engine`.
- **Out:** recorded samples + finalized `S` to `settlement`/`match-engine`; live price stream to `gateway`/`action-feed`; VOID signal on degradation.

## Invariants & failure modes
- Chart price and settlement `S` derive from **one recorded source** (`06 §3`, risk U2).
- Redundant readers with agreement check; record raw samples for independent recomputation.
- Degraded feed → **VOID + full refund, no fees**; never settle on bad data.

## Dependencies
`shared` (median + price types), `config`, external oracle provider, `programs` (samples are inputs to on-chain verification).

## Testing
- Adapter conformance tests for each provider (same interface, same recorded shape).
- Guard tests: staleness, confidence blowout, < min samples → VOID.
- Determinism: recorded samples replay to the same `S` in `shared` and `programs`.
- Provider-swap test: switching Switchboard↔Pyth changes no settlement output for identical sample sets.

## AI-agent rules
- Add providers behind the `OracleProvider` trait only; never let provider specifics leak into `settlement`/`shared`.
- `S` math stays in `shared`; this service validates + supplies samples.
- Any feed-health ambiguity resolves to VOID, not a guessed price.
- Keep the chart and settlement on the same recorded source.
