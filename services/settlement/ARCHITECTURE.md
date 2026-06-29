# Service: `settlement` — Off-Chain Settlement Builder

**Stack:** Rust. **Trust role:** assembles settlement inputs and submits backend-computed payouts. **v1:** the chain verifies signed price + conservation only; outcome correctness is a backend liability until on-chain replay is restored (`TODO(v1+)`). **Implements:** `04 §9–§12,§18`; `06 §5`.

> `settlement` gathers canonical inputs, computes outcomes via `shared` off-chain, and submits `submit_settlement` with per-seat payouts. In v1 the program enforces capital safety (signed price at exact `scheduled_end_ts` + conservation), not full outcome re-derivation.

---

## Responsibilities (owns)
- At match end, gather inputs: match-engine replay state, sealed predictions + drand decryption (from `timelock`), signed price at exact `scheduled_end_ts` (from `signed-price-server`), and bound `MatchConfig`.
- Compute `SettlementResult` via **`shared`** (pots, winners, rake) and per-seat payout amounts.
- Submit `submit_settlement` through `settlement-chain` (no on-chain action-log sync in v1).
- Drive the **DECRYPT → SETTLED** transition; trigger VOID + refund on any guard failure (oracle degraded, drand key missing past grace, conservation mismatch, replay disagreement).

## Non-responsibilities
- No pot/winner math or oracle validation rules of its own (→ `shared`).
- No gameplay sequencing (→ `match-engine`); no Pyth fetching/posting (→ Pyth updater); no decryption (→ `timelock`).
- Not the custody authority (→ `programs`); it submits, the chain decides.

## Internal structure (suggested)
```
settlement/src/
  collect/      # fetch + validate inputs (log, verified oracle price, sealed+key, vrf, config)
  compute/      # call shared::settle, conservation assert
  ops/          # Pyth/Solana clients, attempts, retry/dead-letter, reconciliation
  submit/       # build settle tx, send to programs, confirm, idempotent retry
  void/         # VOID + refund orchestration on guard failure
  main.rs
```

## Interfaces
- **In:** match-end trigger + input bundle from `match-engine`; verified Pyth oracle price from the updater/program path; decrypted predictions from `timelock`.
- **Out:** `settle`/`void` instructions to `programs`; settlement record (for `action-feed` + audit/match history).

## Invariants & failure modes
- Recompute locally and assert conservation **before** submitting; on-chain conservation is the capital-safety backstop in v1.
- Idempotent submission — duplicate settles are no-ops (matches `programs`).
- Any guard failure → VOID + full refund (no fees). Never "best-effort" payout. (`04 §17`.)

## Dependencies
`shared`, `timelock`, `programs`, `config`.

## Testing
- Golden-vector parity with `shared` and `programs` (byte-identical).
- Fault injection: missing drand key (grace → VOID), degraded oracle, partial confirmations, duplicate submits.
- End-to-end with `match-engine` logs across contested / uncontested / multi-all-in matches.
- Settlement ops tests cover Pyth first-valid update posting, idempotent confirmation,
  retry scheduling, retry-budget refund fallback, VOID refund path, and vault drift.

## AI-agent rules
- Outcome math → `shared`. This service orchestrates; it does not compute.
- Treat on-chain signed-price + conservation checks as the release gate; if local math disagrees with what you intend to submit, **do not submit** — escalate/VOID.
- Keep submission idempotent and every fault mapped to a deterministic refund path.
- Dead-letter only unsafe/operator-required states; never use dead-letter to release funds.
