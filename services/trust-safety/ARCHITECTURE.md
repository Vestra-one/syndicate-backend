# Service: `trust-safety` — Anti-Sybil / Anti-Bot / Anti-Collusion

**Stack:** TypeScript/Node (analytics; Python/ML optional later). **Trust role:** standing detection + enforcement signals. **Implements:** `06 §9`; risks `S3,S4`; decisions `08 OQ15,OQ16`.

> A continuously running service, not a feature. Small tables + anonymous wallets make collusion impossible to *eliminate* — the goal is to detect, deter, and enforce, and to price the residual risk.

---

## Responsibilities (owns)
- **Collusion telemetry:** correlated wallets, chip-dumping patterns, timing signatures, repeated co-seating, squeeze patterns.
- **Bot detection:** action-timing fingerprints, superhuman consistency, automation signals.
- **Sybil analysis:** wallet-cluster graphs feeding `matchmaking`'s progressive PoP (`08 OQ15`).
- **Enforcement signals & policy:** published fair-play policy; bans + forfeiture of future access for proven collusion; **no retroactive clawback** of settled on-chain funds (`08 OQ16`).
- Investigation tooling / case management: explainable signals, active enforcement records, appeal records, and lift/reject outcomes.
- **Compliance hooks:** geofence blocks and KYC-required pre-seat actions.

## Non-responsibilities
- No custody and **no clawback of settled funds** (on-chain finality stands; expectations set in policy).
- Does not seat players (it *advises* `matchmaking`); does not run gameplay.

## Internal structure (suggested)
```
trust-safety/src/
  ingest/        # consume match events + outcomes
  detect/        # collusion / bot / sybil detectors
  graph/         # wallet-cluster analysis
  enforce/       # ban list, seat-deny signals, case tooling
  index.ts
```

## Interfaces
- **In:** match events/outcomes from `match-engine`/`settlement`; seating + identity signals from `matchmaking`.
- **Out:** risk scores + ban/seat-deny signals to `matchmaking`/`gateway`; investigator dashboards.
- **Persistence:** `trust_safety_signals`, `enforcement_actions`, and `enforcement_appeals` in Postgres; these are private operational records and never action-feed output.

## Invariants & failure modes
- Detection is **advisory + enforced pre-settlement** (seat denial, bans) — never a post-hoc seizure of settled capital.
- False-positive sensitivity is tunable via `config`; err toward investigation, not silent punishment.
- A wallet with any active `seat_deny`, `temporary_ban`, `ban`, `kyc_required`, or `geofence_block` action must be denied new seating until the action expires or an appeal lifts it.
- Residual small-table collusion is acknowledged and monitored (risk S3), not assumed solved.

## Dependencies
`match-engine`, `matchmaking`, `settlement`, `config`.

## Testing
- Detector precision/recall on labeled/simulated collusion & bot datasets.
- Graph clustering correctness; ban propagation to seating/auth.
- Policy-boundary tests: no path performs on-chain clawback of settled funds.

## AI-agent rules
- Enforcement happens **before** settlement (deny/ban), never via reversing settled on-chain payouts.
- Thresholds live in `config`; detectors stay explainable/auditable for appeals.
- Consume signals into `matchmaking`/`gateway`; don't embed enforcement logic in those edge services.
