# Production Hardening & Permanent Remediation

Status: Devnet-ready with explicit mainnet blockers. This document is the launch hardening register for temporary fixes, workarounds, and architectural compromises found during validation.

Pyth reference checked for this pass: https://docs.pyth.network/price-feeds/core/use-real-time-data/pull-integration/solana

## 1. Temporary Fix Audit

| Component | Temporary Fix | Why It Exists | Production Risk |
|---|---|---|---|
| Devnet harness | Settlement arguments previously used a local seat-0-wins shortcut. | It unblocked proving custody/claim wiring before a verified Pyth account was available. | Could hide mismatches between off-chain settlement construction and on-chain verification. Remediated by deterministic pot/winner/conservation logic in the harness. |
| Devnet harness | Legacy manual Pyth price-update-account input. | Previously used before the harness posted Hermes updates itself. | Remediated: the harness now fetches Hermes timestamp updates, posts through the Pro-compatible Pyth Receiver, and atomically calls `submit_settlement` when it fits one full-verification transaction. |
| Program state | Account `SPACE` constants had unexplained padding. | Extra room was left during rapid iteration. | Audit ambiguity and future layout mistakes. Remediated by explicit `reserved` fields initialized on account creation. |
| Settlement worker | Prepared transaction JSON path. | Previously allowed RPC send/confirm hardening before runtime transaction construction existed. | Remediated: prepared JSON mode and env vars are removed. Runtime construction is owned by `settlement-chain`. |
| Settlement attempts | `InMemoryAttemptStore` exists for tests/demo. | Unit testing retry/refund semantics without Postgres. | Remediated: `PostgresAttemptStore` implements the async `SettlementAttemptStore` trait against the existing SQL contract; production worker mode requires `DATABASE_URL` and uses durable storage. `InMemoryAttemptStore` remains test/demo-only. |
| Worker demo | `MockSolanaClient` and `FileStore` demo path. | Local developer proof of async worker loop. | Forbidden on mainnet. Current binary refuses demo mode in `APP_ENV=mainnet`; keep this guard and exclude demo mode from deployment units. |
| Oracle adapter | Legacy sample-window adapter remains. | Charting/simulation support and historical comparison. | Remediated: sampling crate deleted; Pyth bounded exact-after is the only oracle/settlement path. |

## 2. Permanent Remediation Plan

| Temporary Solution | Permanent Architecture | Complexity | Priority |
|---|---|---:|---|
| Manual Pyth account input | Settlement worker fetches Hermes exact-after updates, posts through the Pro-compatible Pyth Receiver, persists the proof tuple, then submits `submit_settlement`. | High | Remediated in harness; worker integration remains Critical |
| Prepared transaction JSON | Node `settlement-chain` adapter builds Pyth Receiver + Syndicate transactions at runtime, simulates, submits, confirms, and returns receipts. | High | Remediated |
| In-memory settlement attempts | Postgres-backed `SettlementAttemptStore` using the existing SQL contract with row locks and idempotency keys. | Medium | Remediated |
| Worker demo persistence | Queue consumer backed by Postgres/NATS outbox, replay checkpoints, and crash-safe resume. | Medium | Remediated: `syndicate-worker` runs outbox relay → JetStream durable consumer → `SettlementOpsWorker` with Postgres due-poller resume. Evidence: `services/worker/tests/queue_integration.rs`, `/metrics` on port 8084. |
| Legacy oracle sampling | Sampling crate removed; Pyth bounded exact-after (`shared::oracle`) is the only oracle/settlement path. | Low | Remediated |
| Local key-file Devnet harness | Keep only as Devnet/test tooling; production deployments use systemd secrets, HSM/multisig runbooks, and no repo-local key material. | Medium | High |

## 3. Technical Debt Register

| Debt | Impact | Risk | Recommended Remediation |
|---|---|---|---|
| Pyth Receiver posting exists first in the Devnet harness, not yet as a daemonized worker. | The executable path is present, but production queue ownership, metrics, and key custody still need worker integration. | Critical | Promote the harness adapter into the settlement worker with explicit SLA, metrics, and key custody. |
| Settlement worker lacks real durable queue execution. | Finished matches may not resume deterministically after process restart. | Critical | Remediated: Postgres `outbox_events` relay, JetStream `SETTLEMENT` stream, durable pull consumer, and `settlement_attempts` due-poller wired in `services/worker`. Live Devnet soak still required. |
| Prepared transaction send path is not a full builder. | Operational fragility and manual artifact risk. | Critical | Remediated by `settlement-chain`; keep Devnet measurements and audit evidence attached before mainnet. |
| External security audit not completed. | Real-money protocol risk remains unknown. | Critical | Freeze scope, run audit, remediate, and re-review before mainnet. |
| Load/chaos rehearsal not completed. | Unknown behavior under RPC degradation, queue backlog, reconnect storms, and Pyth delays. | High | Run Devnet soak and fault injection with dashboards and alert thresholds. |
| Geofence/KYC provider integration is still a hook. | Regulatory and abuse controls are incomplete. | High | Add provider-grade enforcement before real-money access. |
| Harness uses local keypair markdown. | Secret leakage risk if mishandled. | Medium | Keep untracked, rotate Devnet keys regularly, never use for production. |

## 4. Architecture Corrections

- On-chain state reserves are explicit fields, not anonymous over-allocation.
- Devnet settlement arguments are now built with deterministic pot/winner/rake/conservation logic instead of a hardcoded winner.
- Pyth settlement remains fail-closed: no verified `PriceUpdateV2` means no settlement submission; the safe path is VOID/refund.
- Pyth unavailable is not an on-chain automatic transition. The backend/operator path must submit a separate emergency-void-admin `void` transaction; player refunds remain pull-based `refund` transactions.
- The durable worker connects Postgres/NATS outbox state to `settlement-chain` with Postgres idempotency, JetStream at-least-once delivery, replay checkpoints (`match_snapshots` + `match_events`), and metrics on `/metrics`.
- Demo worker mode is not a production mode. Mainnet deployment units must run only the durable queue + real Solana/Pyth clients.
- Filesystem and in-memory stores are local/test fixtures. Production source of truth is Postgres plus append-only hash-chained event records.

## 4.1 Pyth Mainnet Prep Tasks

| Task | Required evidence |
|---|---|
| Devnet live Pyth run | Atomic tx signature, Pyth audit receipt, on-chain settled match, successful claim. |
| Transaction fit/compute measurement | Recorded size/compute for full-verification Pyth post + `submit_settlement`; explicit decision if fallback is needed. |
| Oracle unavailable drill | No valid update in window causes admin `void` tx, then player `refund` txs; canonical message recorded. |
| Worker promotion | Settlement worker uses `settlement-chain`, Pro-compatible Receiver ids, Postgres attempts, retries, dead-lettering, and receipt persistence. |
| Metrics and alerts | Fetch latency, in-window miss rate, post failure rate, full-verification failure, void rate, settlement tx confirmation latency. |
| Secret hygiene | `PYTH_API_KEY` rotated after chat exposure and stored only in host secret manager. |
| Audit packet | Pyth docs links, exact feed ids/exponents/confidence thresholds, receipt schema, and all rejection tests attached for auditors. |

## 5. Codebase Hardening Tasks

### Contracts

- Keep Pyth Receiver `PriceUpdateV2` ownership/discriminator validation through Anchor accounts.
- Require full verification, feed id equality, confidence bound, exponent equality, and bounded exact-after publish time.
- Keep settlement admin and emergency void admin separate under multisig/timelock.
- Add Anchor runtime tests for wrong feed, partial verification, stale/future update, wrong seat set, duplicate seat, and claim/refund idempotency.
- Freeze upgrade authority ceremony before mainnet.

### Backend

- Implement Postgres-backed settlement attempt store.
- Keep prepared transaction JSON removed; runtime transaction building must remain in `settlement-chain`.
- Add queue-driven worker resume from event root/idempotency key.
- Keep retry policies bounded with persisted `next_retry_at`.
- Add explicit timeouts for Hermes, Receiver posting, Solana RPC send, and confirmation polling.

### Infrastructure

- Deploy Postgres, Redis, Prometheus, Grafana, and service units from versioned manifests.
- Store secrets outside the repo; no keypair markdown in production.
- Add alerts for settlement lag, Pyth unavailability, vault drift, dead letters, RPC failure rate, and queue backlog.
- Run backup/restore rehearsal for Postgres before mainnet.
- Maintain runbooks for oracle degradation, dead-letter recovery, vault drift, and emergency pause/void.

## 6. Production Readiness Gate

| Subsystem | Ready for Mainnet? | Blocking Issues |
|---|---|---|
| Smart contracts | NO | Needs Anchor runtime tests with real Receiver accounts and external audit. |
| Shared settlement core | YES | Keep frozen except audit-driven fixes. |
| Devnet lifecycle harness | YES for custody/refund and Pyth settlement wiring | Needs live Devnet run/measurement of the new atomic full-verification path before mainnet. |
| Settlement worker | NO | Durable queue wiring is implemented; needs live Devnet E2E soak (enqueue → relay → consume → confirm) and forced-kill recovery drill before mainnet. |
| Action feed/history | YES for devnet | Needs production object-store credentials and soak under load. |
| Gateway/matchmaking | NO for mainnet | Provider-grade geofence/KYC and full Redis/Postgres deployment rehearsal pending. |
| Persistence schema | YES as contract | Needs live migration rehearsal, backup, and restore proof. |
| Observability/deploy | NO | Needs full bare-metal rehearsal with alerts firing and runbooks tested. |

## 7. Final Production Checklist

- No TODO/FIXME/HACK/temp comments in production paths.
- No mock clients in deployment units.
- No in-memory or filesystem authoritative state in production.
- Pyth Receiver posting automated, monitored, and measured on Devnet.
- Solana settlement transactions built from canonical state, simulated, sent, and confirmed by the worker.
- Postgres settlement attempts and event logs replay after forced process kill.
- Vault reconciliation green across Devnet soak.
- Settlement mismatch count is zero across Devnet soak.
- VOID/refund paths tested under Pyth outage, timelock outage, RPC outage, and duplicate submission.
- Upgrade authority transferred to multisig/timelock.
- External audit completed, findings remediated, and fixes re-reviewed.
- Bug bounty or guarded private review window completed.
- Mainnet launch capped by buy-in/feed exposure limits.
- Monitoring, alerting, backup, restore, and runbooks verified on bare metal.
