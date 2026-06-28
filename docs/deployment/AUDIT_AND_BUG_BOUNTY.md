# Syndicate Audit And Bug Bounty Gate

**Status:** Phase 8 launch gate.

The internal audit pass is not a substitute for independent review once real money is exposed. Mainnet should launch only with low caps until the checks below are complete.

## Audit Scope

Minimum external audit scope:

- `services/programs`: Anchor accounts, PDAs, role controls, pause/void/settle/claim/refund flows.
- `services/shared`: deterministic settlement math, pot splitting, verified oracle input model.
- `services/settlement`: idempotent job state, retry/dead-letter/refund path, Pyth exact-after transport.
- `services/match-engine`: fenced single-writer command path, replay determinism, timeout defaults.
- `services/store`: Postgres append-only log, outbox, lease/fencing SQL contracts.
- `services/action-feed`: redaction allow-list, replay bundle determinism, outbox projector retry behavior.
- `services/trust-safety` and `services/matchmaking`: pre-seat enforcement, false-positive appeal path, no post-settlement clawback path.

## Mainnet Audit Blockers

Mainnet real-money launch is blocked by any unresolved finding in these classes:

- Unauthorized vault withdrawal or claim.
- Incorrect settlement winner, tie split, fee, refund, or odd-chip handling.
- Backend-controlled forged settlement price accepted on-chain.
- Wrong Pyth feed, publish time, exponent, or confidence accepted.
- Double settlement or double claim.
- Match event mutation or replay divergence after persistence.
- Funds stuck without claim/refund/void path.
- Trust-safety path that can claw back settled funds.

## Pre-Audit Evidence Package

Prepare:

- Release commit and program binary hash.
- Architecture review: `docs/PRODUCTION_READINESS_REVIEW_PROMPT_3.md`.
- Deployment framework: `docs/deployment/PRODUCTION_DEPLOYMENT_FRAMEWORK.md`.
- Runbooks: `docs/RUNBOOKS.md`.
- Migration: `services/store/migrations/0001_production_persistence.sql`.
- Golden vectors: `golden/`.
- Test commands and outputs from `scripts/test-all.sh`.
- Localnet/devnet deployment logs.

## Bug Bounty

Recommended staged bounty:

| Stage | Scope | Max bounty |
|---|---|---:|
| Private pre-mainnet | Smart contract, settlement, replay, custody | USD 25,000 |
| Capped mainnet | Same plus deployment and key management | USD 100,000 |
| Scaled mainnet | Full protocol, frontend, infra, economic exploits | USD 250,000+ |

Critical examples:

- Steal or permanently freeze user funds.
- Settle using a forged or wrong oracle price.
- Claim another user's payout.
- Cause deterministic replay to disagree with on-chain settlement.
- Bypass active trust-safety/geofence enforcement to enter real-money tables.

Non-goals for bounty triage:

- Social engineering.
- DDoS without a protocol-specific exploit.
- Issues requiring leaked private keys without a leak vector.
- Low-severity UI bugs without capital or integrity impact.
