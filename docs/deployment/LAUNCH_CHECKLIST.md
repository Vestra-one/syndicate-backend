# Production Launch Checklist (Phase 8)

Operational gates before real-money mainnet. Cross-references: [SECURITY_REVIEW.md](../SECURITY_REVIEW.md), [ROLLOUT.md](../ROLLOUT.md), [AUDIT_AND_BUG_BOUNTY.md](deployment/AUDIT_AND_BUG_BOUNTY.md).

## Audit and custody

- [ ] Independent Anchor program audit complete with no open Critical/High findings
- [ ] Bug bounty program live on Immunefi (or equivalent)
- [ ] Operator key ceremony documented and executed ([SECRETS_AND_KEYS.md](deployment/SECRETS_AND_KEYS.md))
- [ ] Multisig / timelock on upgrade authority verified on mainnet

## Runtime verification

- [ ] Full fleet docker-compose green: gateway, matchmaking, match-orchestrator, match-engine, action-feed, settlement-chain, worker
- [ ] Private room: host manual start at min players
- [ ] Public queue: max-fill instant start, deadline start-with-available, below-min dissolve
- [ ] Deposit verify rejects unconfirmed txs
- [ ] Golden replay byte-identical through settlement worker
- [ ] Practice mode path validated (no custody)

## Observability and ops

- [ ] Prometheus alerts wired: deposit-verify latency, fill-window void rate, engine lease contention, gateway relay errors
- [ ] Kill-switch drill completed ([RUNBOOKS.md](../RUNBOOKS.md))
- [ ] drand + Pyth Sev-1 dashboards tested

## Staged rollout

- [ ] Stage 1: devnet soak complete
- [ ] Stage 2: practice mode public (no stakes)
- [ ] Stage 3: lowest buy-in tier, geofenced, capped exposure
- [ ] Go/no-go sign-off recorded
