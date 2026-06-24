# Service: `settlement` — Off-Chain Settlement Builder

**Stack:** Rust. **Trust role:** assembles the settlement the chain will independently re-verify. **Implements:** `04 §9,§10,§11,§12,§18`; `06 §5`.

> `settlement` does not *decide* anything the chain trusts — it gathers recorded inputs, computes the result via `shared`, and submits it to `programs`, which recomputes and validates before releasing funds. Its job is correctness + liveness of the settlement step.

---

## Responsibilities (owns)
- At match end, gather the canonical inputs: hash-chained action log (from `match-engine`), sealed predictions + the drand decryption (from `timelock`), oracle samples + finalized `S` (from `oracle-adapter`), VRF seed, and the bound `MatchConfig`.
- Compute `SettlementResult` by calling **`shared`** (pots, side-pots, `S`, winners, ties, fees).
- Assemble and submit the on-chain `settle` instruction to `programs`; handle confirmation, retries, idempotency.
- Drive the **DECRYPT → SETTLED** transition; trigger VOID + refund on any guard failure (oracle degraded, drand key missing past grace, conservation mismatch, replay disagreement).

## Non-responsibilities
- No pot/`S`/winner math of its own (→ `shared`).
- No gameplay sequencing (→ `match-engine`); no oracle sampling (→ `oracle-adapter`); no decryption (→ `timelock`).
- Not the custody authority (→ `programs`); it submits, the chain decides.

## Internal structure (suggested)
```
settlement/src/
  collect/      # fetch + validate inputs (log, samples, sealed+key, vrf, config)
  compute/      # call shared::settle, conservation assert
  submit/       # build settle tx, send to programs, confirm, idempotent retry
  void/         # VOID + refund orchestration on guard failure
  main.rs
```

## Interfaces
- **In:** match-end trigger + input bundle from `match-engine`; samples/`S` from `oracle-adapter`; decrypted predictions from `timelock`.
- **Out:** `settle`/`void` instructions to `programs`; settlement record (for `action-feed` + audit/match history).

## Invariants & failure modes
- Recompute locally and assert conservation **before** submitting; on-chain re-verification is the backstop, not a substitute.
- Idempotent submission — duplicate settles are no-ops (matches `programs`).
- Any guard failure → VOID + full refund (no fees). Never "best-effort" payout. (`04 §17`.)

## Dependencies
`shared`, `oracle-adapter`, `timelock`, `programs`, `config`.

## Testing
- Golden-vector parity with `shared` and `programs` (byte-identical).
- Fault injection: missing drand key (grace → VOID), degraded oracle, partial confirmations, duplicate submits.
- End-to-end with `match-engine` logs across contested / uncontested / multi-all-in matches.

## AI-agent rules
- Outcome math → `shared`. This service orchestrates; it does not compute.
- Treat the on-chain verification in `programs` as the source of truth; if local and chain disagree, **do not release** — escalate/VOID.
- Keep submission idempotent and every fault mapped to a deterministic refund path.
