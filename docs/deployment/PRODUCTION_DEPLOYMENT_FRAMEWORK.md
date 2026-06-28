# Syndicate Production Deployment Framework

**Status:** Prompt 3 deployment artifact, v1.0
**Date:** 2026-06-25

This guide defines how a third party should deploy Syndicate once the production architecture in `docs/PRODUCTION_READINESS_REVIEW_PROMPT_3.md` is implemented. The current repository is not yet deployable to real-money production; this document is the target operating framework and the checklist that implementation must satisfy.

Founder deployment decision: launch infrastructure should target **bare-metal/VPS servers on Netcup or Hetzner**, not a managed cloud stack. The first implementation should therefore prefer Docker Compose plus systemd, explicit host hardening, local Postgres/Redis/NATS/MinIO, and simple reproducible scripts. Kubernetes, managed Postgres, managed Redis, and full multi-region DR are future scale upgrades, not launch requirements.

## 1. Environments

### localnet

Purpose:

- Developer validation.
- Deterministic tests.
- Local Solana validator.
- Local Postgres, Redis, NATS, and object storage.

Required services:

- Solana test validator.
- Syndicate program deployed to local validator.
- PostgreSQL.
- Redis.
- NATS JetStream.
- MinIO or local S3-compatible object storage.
- Gateway, match-engine, settlement-chain, settlement-worker, action-feed, projection workers.

Entry point:

```bash
./scripts/deploy-localnet.sh
```

Local infrastructure manifest:

```bash
START_INFRA=1 ./scripts/deploy-localnet.sh
RUN_MIGRATIONS=1 ./scripts/deploy-localnet.sh
```

`deploy/docker-compose.localnet.yml` starts Postgres, Redis, NATS JetStream, MinIO, Prometheus, and Grafana for a local operator rehearsal. The compose stack is a launch-equivalent infrastructure contract, not a mainnet secret store.

### devnet/testnet

Purpose:

- Real Solana devnet or testnet integration. Devnet is the recommended first target because the Solana/Pyth developer path is typically smoother there.
- Pyth integration tests.
- Operator rehearsal.
- Staging frontend.

Required services:

- Postgres running on the local machine or a staging VPS.
- Redis running on the local machine or a staging VPS.
- NATS JetStream running on the local machine or a staging VPS.
- MinIO or filesystem/object storage on the same host for staging artifacts.
- Solana devnet RPC with backup RPC.
- Pyth API key and Hermes/Benchmarks access.
- Settlement-chain internal auth token and scoped settlement/void signer keypair.
- Program deployed with devnet authority multisig.

Entry point:

```bash
./scripts/deploy-devnet.sh
```

The devnet preflight requires `DEPLOYER_MULTISIG_ADDRESS` and refuses to proceed without Pyth/RPC/program configuration. Program deployment or upgrade must still be executed through the configured authority workflow; this script is a guardrail, not a signer.

### mainnet

Purpose:

- Real-money production after audit approval.

Required services:

- Dedicated Netcup/Hetzner VPS or bare-metal host for launch.
- Postgres on host with WAL archiving/backups.
- Redis on host.
- NATS JetStream on host.
- MinIO or filesystem-backed object archive on host, with off-host backup.
- Multiple Solana RPC providers.
- Pyth API key in secret manager.
- Settlement-chain adapter on localhost/private network with `SETTLEMENT_CHAIN_AUTH_TOKEN_FILE`.
- Scoped hot settlement/void signer at `SETTLEMENT_SIGNER_KEYPAIR_PATH`; program authorities remain multisig/timelocked.
- Multisig/timelocked program authority.
- 24/7 alerting once real capital is live.
- Reverse proxy, TLS, firewall, rate limits, and provider-level DDoS protection.

Entry point:

```bash
./scripts/deploy-mainnet.sh
```

The mainnet preflight requires `MAINNET_RELEASE_TAG`, `AUDIT_APPROVAL_ID`, `BUG_BOUNTY_URL`, `DEPLOYER_MULTISIG_ADDRESS`, and `RELEASE_CONFIG_HASH`, and must run from a clean `main` checkout.

## 2. Smart Contract Deployment

### localnet

Steps:

1. Install Rust, Solana CLI, Anchor, Node 22.
2. Start `solana-test-validator`.
3. Build the Anchor program.
4. Deploy to localnet.
5. Initialize `protocol_state`.
6. Configure local roles with disposable keys.
7. Run program tests and golden replay tests.

Required checks:

- Program id in `declare_id!` matches deployed keypair.
- Pyth integration can be mocked locally.
- Deposit, settlement, claim, void, and refund tests pass.

### devnet

Steps:

1. Load devnet deployer from secret manager.
2. Build with locked toolchain.
3. Deploy or upgrade through devnet multisig.
4. Initialize protocol roles.
5. Configure supported Pyth feed ids.
6. Run Pyth timestamp settlement tests against devnet.
7. Run vault reconciliation smoke test.

Required checks:

- No single personal wallet controls production-like authority.
- Settlement fails for wrong feed, wrong timestamp, stale update, high confidence, and wrong exponent.
- Claims remain available even when new matches are paused.

Pyth-specific Devnet evidence required before mainnet preparation:

1. Run `PYTH_API_KEY=<host-secret> ./scripts/devnet-lifecycle-harness.sh` against the deployed Devnet program.
2. Capture the generated Pyth audit receipt from `/tmp/syndicate-devnet-receipts`: selected price, publish time, confidence, exponent, price update account, atomic settlement signature, Receiver/Wormhole/Push ids, Hermes response hash, and binary update hash.
3. Confirm the full-verification Pyth post plus Syndicate `submit_settlement` fits one atomic transaction. If it does not fit, do not ship a fallback silently; measure transaction size/compute and security-review the two-step fallback design.
4. Trigger the no-valid-update path and confirm the backend submits a separate emergency-void-admin `void` transaction, after which players can submit pull-based `refund` transactions.
5. Verify duplicate settlement jobs remain idempotent and do not create a second settlement or alter payouts.

### mainnet

Mainnet real-money tiers are blocked until:

- The founder/top-tier internal audit pass is complete and all P0 findings are resolved.
- Independent smart-contract audit is scheduled before meaningful capital scale.
- Deterministic core review is complete.
- Pyth settlement source path is complete; live Devnet evidence, durable worker/outbox integration, and audit evidence must be complete.
- Kill switches are rehearsed on devnet.
- Rollback and void/refund drills are complete.
- Legal/geofence launch scope is approved.

Pyth source status:

- Implemented source path: Hermes timestamp fetch, earliest-valid selection, Pro-compatible Pyth Receiver post, on-chain `PriceUpdateV2` full verification, settlement arg equality, and Pyth proof audit fields.
- Runtime transaction construction: `settlement-chain` builds Pyth Receiver post plus Syndicate `submit_settlement` at runtime, simulates, sends, confirms, and returns receipt fields. Prepared transaction JSON is not a production path.
- Not yet mainnet-complete: live Devnet run/measurement, Postgres/NATS durable worker execution against `settlement-chain`, metrics/alerts from the real worker, and external audit.
- Mainnet secret rule: rotate any Pyth API key that has appeared in chat/tickets before deployment; production services must read it only from host secrets as `PYTH_API_KEY`.

Steps:

1. Freeze release tag.
2. Build reproducibly.
3. Verify program binary hash.
4. Deploy through multisig and timelock.
5. Initialize protocol roles.
6. Publish program id, config hashes, supported feeds, and audit links.
7. Enable practice or capped low-stakes tier only.

Rollback:

- Do not roll back settled funds.
- Pause new matches.
- Freeze settlement only if settlement integrity is suspect.
- Allow claims/refunds whenever safe.
- Upgrade program only through multisig/timelock after root cause.

## 3. Backend Deployment

### Infrastructure provisioning

Minimum bare-metal/VPS launch topology:

- One primary VPS/bare-metal host on Netcup or Hetzner.
- Ubuntu LTS or Debian stable.
- Docker Engine and Docker Compose.
- systemd units for service lifecycle.
- Nginx or Caddy as reverse proxy.
- PostgreSQL on the host or in a dedicated container volume.
- Redis on the host or in a dedicated container volume.
- NATS JetStream single-node.
- MinIO or filesystem object archive for replay bundles and audit exports.
- Encrypted host backups to a second VPS or object storage provider.
- Prometheus, Grafana, Loki/Promtail, and node exporter.

Recommended launch sizing:

- Primary host: 8 vCPU, 32 GB RAM, NVMe disk, 1 Gbps network.
- Backup/staging host: 4 vCPU, 16 GB RAM, enough disk for Postgres backups and replay archives.
- Separate RPC provider accounts; do not rely on a self-hosted Solana RPC at launch.

Future scale topology:

- Split Postgres, Redis, NATS, object storage, and app services onto separate hosts.
- Add Postgres streaming replica.
- Move analytics to ClickHouse on a separate host.
- Move from Docker Compose to Kubernetes only when service count and deployment frequency justify it.

Production services:

- `gateway`
- `match-engine`
- `settlement-worker`
- `pyth-updater`
- `matchmaking`
- `action-feed`
- `projection-worker`
- `trust-safety-worker`
- `reconciliation-worker`
- `config-api`

Launch artifacts now checked into this repository:

- `docs/deployment/env.example`: environment schema.
- `deploy/docker-compose.localnet.yml`: localnet/staging infrastructure equivalent for Postgres, Redis, NATS, MinIO, Prometheus, and Grafana.
- `deploy/docker-compose.app.yml`: application services for gateway, matchmaking, action-feed, match-engine, and settlement-worker.
- `deploy/Dockerfile.node-service` and `deploy/Dockerfile.rust-worker`: container build contracts.
- `deploy/prometheus/alerts.yml`: custody, settlement, oracle, VOID-rate, and trust-safety alerts.
- `deploy/grafana/dashboards/syndicate-custody.json`: launch custody/integrity dashboard.
- `docs/deployment/systemd/`: systemd service templates for host deployment.
- `docs/deployment/SECRETS_AND_KEYS.md`: bare-metal secret and authority custody runbook.
- `docs/deployment/AUDIT_AND_BUG_BOUNTY.md`: external audit and bounty gate.

### Environment variables

Required examples:

```text
APP_ENV=mainnet
DATABASE_URL=...
REDIS_URL=...
NATS_URL=...
OBJECT_STORE_BUCKET=...
SOLANA_RPC_URL_PRIMARY=...
SOLANA_RPC_URL_SECONDARY=...
PYTH_HERMES_URL=https://pyth.dourolabs.app/hermes
PYTH_API_KEY=...
DRAND_API=https://api.drand.sh
DRAND_CHAIN_HASH=52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971
DRAND_EXPECTED_SCHEME_ID=bls-unchained-g1-rfc9380
TIMELOCK_GRACE_SEC=30
TIMELOCK_HTTP_TIMEOUT_MS=5000
SYNDICATE_PROGRAM_ID=...
PROTOCOL_STATE_PDA=...
DEFAULT_ORACLE_DELAY_WINDOW_SEC=5
DEFAULT_GEOFENCE_BLOCKLIST=IN
LOG_LEVEL=info
OTEL_EXPORTER_OTLP_ENDPOINT=...
```

Day-0 match configs must keep `max_players <= 5`. The Solana settlement verifier currently tracks seats with fixed five-entry arrays, so Postgres/config/on-chain limits are intentionally aligned at five players until that on-chain verifier is refactored and audited.

Secrets policy:

- Never commit `.env` files.
- On bare-metal, store service environment files under `/etc/syndicate/` with owner `root:syndicate` and mode `0640`.
- Use age/sops or Ansible Vault for encrypted-at-rest deployment secrets.
- Relayer keys should be isolated on the deployment host, encrypted at rest, and moved to KMS/HSM-backed custody when capital grows.
- Rotate Pyth API keys and RPC credentials.
- Follow `docs/deployment/SECRETS_AND_KEYS.md` for authority ceremony and incident rotation.

### CI/CD

Required pipeline:

1. Format and lint.
2. Rust workspace tests.
3. TypeScript tests.
4. Anchor/LiteSVM tests.
5. Database migration dry run.
6. Container build and scan.
7. SBOM generation.
8. Deploy to localnet, then devnet/testnet staging.
9. Smoke tests.
10. Manual approval for mainnet.

Repository artifact validation is part of the TypeScript test sweep through
`services/deployment/test/deployment-artifacts.test.ts`.

Migration dry run:

```bash
DATABASE_URL=postgres://syndicate:syndicate@localhost:5432/syndicate ./scripts/db-migrate-local.sh
```

The current production persistence migration lives at
`services/store/migrations/0001_production_persistence.sql`.

### Observability deployment

Localnet Prometheus and Grafana are provisioned by `deploy/docker-compose.localnet.yml`.

Required page alerts:

- `VaultReconciliationDrift`.
- `SettlementVerificationMismatch`.
- `OracleExactAfterAvailabilityLow`.

Required ticket alerts:

- `SettlementLatencyHigh`.
- `VoidRateHigh`.
- `TrustSafetyFlagSurge`.

Alert runbook targets live in `docs/RUNBOOKS.md`. New production metrics must preserve the metric names referenced in `deploy/prometheus/alerts.yml` or the alert rules must be updated in the same release.

### Audit and bounty gate

Mainnet real-money deployment remains blocked until the audit gate in
`docs/deployment/AUDIT_AND_BUG_BOUNTY.md` is satisfied. The mainnet script enforces
an `AUDIT_APPROVAL_ID` and `BUG_BOUNTY_URL` so the release cannot silently bypass
the review and disclosure process.

### Rollback

Backend rollback is allowed only for off-chain services. It must preserve event schema compatibility.

Rules:

- Never delete or rewrite match events.
- Never mutate settlement bundles after submission.
- If rollback affects command handling, pause new matches first.
- In-flight matches settle under the config and code path recorded at creation, or VOID if replay compatibility is broken.

## 4. Frontend Deployment

Build process:

```bash
npm ci
npm run build
npm run test
```

Environment config:

```text
NEXT_PUBLIC_APP_ENV=mainnet
NEXT_PUBLIC_GATEWAY_WS_URL=wss://ws.example.com
NEXT_PUBLIC_API_URL=https://api.example.com
NEXT_PUBLIC_SOLANA_CLUSTER=mainnet-beta
NEXT_PUBLIC_SYNDICATE_PROGRAM_ID=...
NEXT_PUBLIC_SUPPORTED_FEEDS=BTC/USD,SOL/USD,ETH/USD
```

Release workflow:

1. Build from immutable git tag.
2. Upload static assets to CDN.
3. Deploy API-compatible frontend.
4. Smoke test auth, active games, replay page, profile page, and claim flow.
5. Gradual traffic rollout.
6. Monitor client errors and settlement support tickets.

## 5. DNS, TLS, Reverse Proxies, CDN, and WAF

Suggested domains:

- `app.syndicate.example` for frontend.
- `api.syndicate.example` for HTTP APIs.
- `ws.syndicate.example` for WebSocket gateway.
- `status.syndicate.example` for public status.

Required controls:

- TLS 1.2+ everywhere.
- HSTS on app and API domains.
- Caddy or Nginx terminates TLS on the VPS.
- WAF/CDN is recommended once public traffic begins; provider-level DDoS protection is required from launch.
- Rate limits by IP, wallet, device, and session.
- CDN for static assets is optional at launch and recommended before marketing pushes.
- WebSocket idle timeout tuned above match reconnect expectations.

## 6. Monitoring, Logging, and Alerting

Metrics:

- Match lifecycle transitions.
- Command ack latency.
- WebSocket connection count.
- Engine lease conflicts.
- Event append failures.
- Settlement attempts and confirmations.
- Pyth fetch latency and miss rate.
- Pyth wrong-timestamp/high-confidence/stale rejection counts.
- Vault drift.
- Claim/refund success and failure.
- VOID rate by reason.
- Profile/read API latency.
- Trust-safety flags and enforcement.

Logs:

- JSON structured logs.
- `match_id`, `user_id`, `wallet_hash`, `trace_id`, and `event_seq` fields where applicable.
- No plaintext secrets.
- No sealed prediction plaintext before settlement.

Alerts:

- Page: vault drift, settlement mismatch, Pyth proof failure spike, claims failing, database unavailable, engine split-brain, unauthorized role action.
- Ticket: elevated latency, elevated VOID rate, projection lag, high auth failures, WAF/rate-limit spikes.

## 7. Backup and Recovery

Postgres:

- Launch: nightly logical dumps plus WAL archiving if available.
- Store encrypted backups off-host.
- Weekly restore test during active development.
- Full PITR and tight RPO/RTO are deferred until protocol growth, but restore drills are not optional.

Object storage:

- Lifetime retention for gameplay logs, replay bundles, and settlement bundles.
- Off-host encrypted copy required for real-money launch.
- Cross-region replication is deferred until protocol growth.

Redis:

- Treat as volatile. Durable state must be reconstructable from Postgres/event log.

NATS/Redpanda:

- Retention long enough for projection recovery.
- Postgres event log remains the canonical recovery source.

Recovery order:

1. Pause new matches.
2. Restore Postgres.
3. Rebuild projections.
4. Reconcile open vaults.
5. Resume settlement only after reconciliation is green.
6. Resume new matches last.

## 8. Operational Runbooks

### Pyth update unavailable

1. Pause new matches for affected feed if miss rate breaches SLO.
2. Existing bounded exact-after matches without a valid Pyth update in the configured window VOID/refund.
3. Check Pyth status, API credentials, RPC, and updater service.
4. Resume only after sustained healthy fetch/post behavior.

### Settlement mismatch

1. Freeze settlement globally.
2. Claims already written remain claimable unless vault drift exists.
3. Capture settlement bundle, Pyth proof, event root, and transaction logs.
4. Void affected unsettled matches if verification cannot be repaired.
5. Add regression test before unfreezing.

### Vault drift

1. Freeze affected match claims.
2. Pause new matches globally if drift cause is unknown.
3. Reconstruct from on-chain vault, seats, settlement PDA, and custody ledger.
4. Resume only when ledger equals chain.

### Engine split-brain

1. Pause new commands for affected match.
2. Identify highest fenced event sequence.
3. Replay from canonical event log.
4. VOID if deterministic replay is impossible.

### Database outage

1. Gate new commands at gateway.
2. Keep claims/refunds chain-direct where possible.
3. Fail over Postgres.
4. Rebuild projections and reconcile before accepting new matches.

## 9. Clean-Room Deploy Acceptance

A third-party deployer must be able to:

1. Deploy localnet from scripts.
2. Run all tests.
3. Deploy devnet/testnet from the local system against Solana devnet/testnet.
4. Create a match.
5. Deposit two users.
6. Seal predictions.
7. Play actions.
8. Settle with Pyth proof.
9. Claim payout.
10. Rebuild replay page from event log.
11. Trigger and recover from a bounded exact-after oracle-window miss with message: "Pyth Oracle price for settlement is unavailable."
12. Restore Postgres backup in staging from the VPS backup procedure.

Until all twelve pass, the ecosystem is not production deployable.

Pyth acceptance detail for step 8:

- Settlement proof must be generated from Hermes timestamp data, not an operator-entered price.
- The selected `publish_time` must be the earliest valid Pyth update in the configured exact-after window.
- The Syndicate transaction must consume a Pyth Receiver `PriceUpdateV2` account with full verification.
- The audit record must persist the selected price, publish time, confidence, exponent, price update account, atomic settlement signature, Pro-compatible Receiver/Wormhole/Push ids, Hermes response hash, and binary update hash.

Pyth acceptance detail for step 11:

- Missing Pyth data does not settle.
- The backend/operator path submits a separate emergency-void-admin `void` transaction.
- Players then recover funds through pull-based `refund` transactions.
