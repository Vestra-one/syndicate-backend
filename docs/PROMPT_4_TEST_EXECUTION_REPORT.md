# Prompt 4 Backend Validation Report

Date: 2026-06-26

## 1. Test Execution Report

### Environment Details

- Host: macOS development workstation.
- Backend workspace: `/Users/adarshkumar/work/syndicate/backend`.
- Local infrastructure started with Docker Compose:
  - Postgres 16
  - Redis 7
  - NATS JetStream 2.10
  - MinIO
  - Prometheus
  - Grafana
- App stack built and started with Docker Compose:
  - gateway
  - matchmaking
  - action-feed
  - match-engine
  - settlement-worker in demo mode
- Live localnet ports:
  - action-feed: `18080`
  - gateway: `18081`
  - gateway metrics: `19081`
  - matchmaking: `18082`
  - match-engine: `18083`
  - Grafana: `3001`
- Solana CLI: `4.0.2` at `/Users/adarshkumar/.local/share/solana/install/active_release/bin/solana`.
- Devnet program id: `FR4tqVX41CDmUbJEbM7Qx5hxfQnfLmCJspTab7fou3WS`.
- Devnet deploy signature: `2bxNRR1vYYjUgn1ZRmut2h1wn2J74pwRrsZQSyWdojjspJ4WYNCba2wiMpzgwHzAp7QekKSw9WHLRHJw2cWjWkR6`.

### Executed Scenarios

- Full deterministic Rust suite: match-engine, oracle, settlement, store, timelock, worker, shared settlement math.
- Full TypeScript service suite: gateway auth, action-feed read APIs, matchmaking, config, trust-safety, deployment artifact checks.
- Settlement `net` feature tests.
- Anchor program Rust unit tests with Pyth receiver verification.
- Solana SBF build for the on-chain program.
- Solana Devnet deploy and on-chain program-account verification.
- Devnet funded-account balance checks for the first two provided test wallets.
- Devnet lifecycle harness setup under `services/devnet-harness`.
- Devnet SPL chips mint setup, token-account setup, `initialize_protocol`, `create_match`, two `deposit`s, `lock`, `void`, and two `refund`s.
- Localnet Docker infra startup.
- Production Postgres migration against live localnet Postgres.
- Docker app image build and app stack startup.
- Live health checks for action-feed, matchmaking, match-engine, gateway metrics.
- Live read checks for active games and historical games.
- Live observability checks for Prometheus, Grafana, NATS, and MinIO.
- Static checks: `cargo fmt --check`, shell syntax, Docker Compose config render, `git diff --check`.

### Coverage Summary

Covered locally:

- Blinds, check/call/raise/fold/all-in/default timeout in engine and settlement tests.
- Side pots, odd chips, rake, uncalled returns, settlement verification, tamper rejection.
- Oracle exact-after selection and invalid oracle rejection.
- Replay determinism and hash-chain tamper detection.
- Fenced engine runtime, duplicate intent rejection, unsigned intent rejection, replay recovery, 2,000-match load smoke.
- Gateway nonce auth, bad signatures, wallet mismatch, nonce replay, geofence rejection, metrics.
- Action-feed redaction, replay upload, historical-games list, historical action timeline, restart replay restoration.
- Matchmaking deposit gating, duplicate/full table rejection, race ordering, private rooms.
- Trust-safety enforcement, appeals, chip-dump and sybil signals.
- Postgres schema/migration/read-model contract and live migration.

Not executed in this environment:

- Anchor `anchor build` / `anchor test`; `anchor` CLI is not installed.
- `submit_settlement` and `claim` on Devnet using the new Hermes → Pro-compatible Pyth Receiver → Syndicate atomic builder. The code path is implemented; a live run still needs `PYTH_API_KEY` in host secrets and explicit approval to sign/send Devnet transactions.
- Five independent funded Devnet wallets; only the first two provided wallets were confirmed funded.
- Real Pyth Receiver transaction posting on Devnet after this remediation. The harness now fetches Hermes timestamp updates, converts hex updates for the receiver SDK, and refuses to proceed if the full-verification path does not fit one transaction.
- Full browser/frontend-driven lifecycle.
- Full production load test of 50 simultaneous games / 250 players against live app containers.

## 2. Bug Report

### Bug 1

Severity: High  
Category: Deployment  
Subsystem: Localnet infrastructure  
Steps to Reproduce: `docker compose -f deploy/docker-compose.localnet.yml up -d`  
Expected Behavior: All infrastructure images resolve and start.  
Actual Behavior: MinIO image `minio/minio:RELEASE.2026-06-13T11-33-47Z` did not exist.  
Impact: Fresh localnet deployment could not start.  
Suggested Fix: Replaced the invalid tag with `minio/minio:latest` for localnet. Pin a tested digest before mainnet deployment.

### Bug 2

Severity: Medium  
Category: Deployment  
Subsystem: Observability  
Steps to Reproduce: Start localnet compose on a host already using port `3000`.  
Expected Behavior: Grafana starts without common dev-port collisions.  
Actual Behavior: Grafana failed because host port `3000` was already in use.  
Impact: Localnet observability did not fully start on common dev machines.  
Suggested Fix: Remapped host Grafana port to `3001` while keeping container port `3000`.

### Bug 3

Severity: High  
Category: Deployment  
Subsystem: Database migration  
Steps to Reproduce: Run `./scripts/db-migrate-local.sh` after starting localnet compose.  
Expected Behavior: Migration applies to the compose-created database.  
Actual Behavior: Script targeted database `syndicate`, but compose creates `syndicate_local`.  
Impact: Day-0 localnet bootstrap failed.  
Suggested Fix: Changed migration default URL to `postgres://syndicate:syndicate@localhost:5432/syndicate_local`.

### Bug 4

Severity: High  
Category: Deployment  
Subsystem: Docker app stack  
Steps to Reproduce: Start app compose with localnet infra.  
Expected Behavior: App containers reach Postgres, Redis, NATS, MinIO, Prometheus, and Grafana.  
Actual Behavior: App containers used `127.0.0.1`, which points to each container itself.  
Impact: Production-like Docker localnet could not operate reliably.  
Suggested Fix: App compose now joins `syndicate-localnet_default` and uses service DNS names.

### Bug 5

Severity: Medium  
Category: Deployment  
Subsystem: Docker app stack  
Steps to Reproduce: Build app images before `.dockerignore`.  
Expected Behavior: Small deterministic Docker build context.  
Actual Behavior: Build context was about 850 MB due local targets/cache.  
Impact: Slow, fragile, noisy builds.  
Suggested Fix: Added `.dockerignore`.

### Bug 6

Severity: High  
Category: Runtime dependency  
Subsystem: action-feed projector  
Steps to Reproduce: Start action-feed container with `DATABASE_URL`.  
Expected Behavior: Projector hydrates from Postgres and starts.  
Actual Behavior: `psql` was missing in the Node runtime image.  
Impact: action-feed container exited immediately.  
Suggested Fix: Installed `postgresql-client` in `deploy/Dockerfile.node-service`.

### Bug 7

Severity: Medium  
Category: Runtime correctness  
Subsystem: action-feed projector  
Steps to Reproduce: Start action-feed against empty outbox.  
Expected Behavior: Empty poll returns no messages.  
Actual Behavior: Projector tried to parse non-row `psql` status output as JSON.  
Impact: Repeated projector errors in logs.  
Suggested Fix: Projector now ignores lines without the field separator before parsing payload JSON.

### Bug 8

Severity: Medium  
Category: Deployment  
Subsystem: App host ports  
Steps to Reproduce: Start app compose on host with common ports already used.  
Expected Behavior: App ports expose the intended services.  
Actual Behavior: Host `8080` returned an existing nginx service.  
Impact: Health checks can target the wrong service.  
Suggested Fix: App host ports moved to high localnet range: `18080`, `18081`, `18082`, `18083`, `19081`.

### Bug 9

Severity: Critical  
Category: Smart contract deployment  
Subsystem: Solana SBF program  
Steps to Reproduce: Run `cargo-build-sbf --manifest-path services/programs/Cargo.toml` before the account-struct fix.  
Expected Behavior: Program builds without Solana verifier frame errors.  
Actual Behavior: The SBF build emitted maximum-frame overflow errors for generated `CreateMatch::try_accounts` and `Deposit::try_accounts` validation frames.  
Impact: The program was not acceptable for Devnet/mainnet execution despite host Rust tests passing.  
Suggested Fix: Boxed the larger Anchor account wrappers in `CreateMatch` and `Deposit`, then reran SBF build; the frame errors are gone.

### Bug 10

Severity: Critical  
Category: Smart contract deployment  
Subsystem: Solana program identity  
Steps to Reproduce: Compare `declare_id!` with `target/deploy/syndicate_program-keypair.json`.  
Expected Behavior: The declared Anchor program id matches the deploy keypair.  
Actual Behavior: Source still declared Anchor's placeholder program id.  
Impact: A deployed program would reject runtime instructions with a program-id mismatch.  
Suggested Fix: Updated `declare_id!` and `Anchor.toml` localnet/devnet entries to `FR4tqVX41CDmUbJEbM7Qx5hxfQnfLmCJspTab7fou3WS`.

## 3. Architecture Findings

- Devnet deployment is now executable with the Solana CLI absolute path; Anchor CLI is still not discoverable in this shell.
- The on-chain program is deployed on Devnet and owned by the upgradeable loader, with upgrade authority set to the first provided funded test wallet.
- Docker localnet now runs, but the settlement worker is still demo/one-shot in the app compose; production queue execution must be wired for real deployments.
- Rust Docker builds still depend on live crates.io unless a vendor/cache strategy is added.
- The app compose is suitable for localnet rehearsal after fixes, while bare-metal production should use systemd/env templates and external managed or hardened infra.
- On-chain lifecycle coverage now has a real Devnet harness for custody through VOID/refund; Pyth-backed settlement/claim and adversarial custody cases remain open.
- The Devnet lifecycle harness now covers custody through VOID/refund with real SPL token transfers and program instructions. Settlement/claim coverage is wired but still blocked on supplying or posting a fully verified Pyth Receiver price update account.
- Full 50-game / 250-player live load against containers still needs a dedicated load harness. Current automated coverage includes a 2,000-match engine smoke and service-level concurrency tests, but not an integrated live traffic benchmark.

## 4. Production Readiness Assessment

Not Ready for mainnet launch.

Justification:

- Local deterministic, service, deployment, persistence, and observability checks pass.
- Production-like local Docker infra and app stack now start and expose health/metrics/read endpoints.
- The on-chain program now builds to SBF without stack-frame errors and is deployed on Devnet.
- The Devnet harness now proves funded-wallet token setup, deposits, lock, void, and refunds with real on-chain transactions.
- However, prompt success criteria still require a live Devnet run of Pyth-backed `submit_settlement` and `claim`; the harness can execute that path with `PYTH_API_KEY` from host secrets.
- External audit, multisig/authority ceremony, and a real integrated load test remain mandatory before mainnet.

Ready for next step:

- Run and measure the new atomic Pyth Receiver posting plus `submit_settlement` path on Devnet.
- Promote the working harness Pyth adapter into the production settlement worker: durable Postgres attempts, runtime transaction building, retries/dead-lettering, receipt persistence, and worker metrics.
- Rehearse Pyth unavailable behavior: backend submits emergency-void-admin `void`; players submit pull-based `refund`; the canonical unavailable message appears in history/replay.
- Fund or top up all five player wallets, expand the harness beyond two players, run settlement/claim and adversarial custody flows, then wire the same path into frontend integration testing.

## 5. Recommendations

| Priority | Issue | Recommendation |
|---|---|---|
| P0 | Pyth-backed settlement/claim not executed live after remediation | Run `PYTH_API_KEY=<host-secret> ./scripts/devnet-lifecycle-harness.sh`, confirm the atomic transaction, and archive the generated Pyth audit receipt. |
| P0 | Pyth path still harness-first | Move Hermes fetch, earliest-valid selection, Pro-compatible Receiver post, and `submit_settlement` building into the durable settlement worker before mainnet. |
| P0 | Pyth unavailable transaction semantics need rehearsal | Verify no-update window produces a distinct admin `void` transaction and player `refund` transactions, not an implicit contract-side auto-void. |
| P0 | Adversarial custody rehearsal incomplete | Extend the harness with unauthorized settlement, double-claim, wrong-account, and cross-game isolation tests on Devnet. |
| P0 | No external audit signoff | Keep mainnet blocked until independent Solana/security audit is complete. |
| P1 | Settlement worker app compose is demo mode | Wire durable settlement queue mode before any non-demo deployment. |
| P1 | Integrated load test missing | Add a live container load harness for 50 games / 250 players with latency metrics. |
| P1 | Docker Rust builds need network | Add cargo vendor/cache strategy for reproducible CI/builds. |
| P2 | Localnet MinIO uses `latest` | Pin a tested MinIO digest for release branches. |

## Verification Evidence

- `./scripts/test-all.sh`: passed.
- `cargo test --manifest-path services/programs/Cargo.toml`: passed with existing Anchor macro `unexpected_cfgs` warnings.
- `cargo-build-sbf --manifest-path services/programs/Cargo.toml`: passed; no remaining frame-overflow errors.
- `solana program deploy ... --url devnet`: passed.
- Devnet program id: `FR4tqVX41CDmUbJEbM7Qx5hxfQnfLmCJspTab7fou3WS`.
- Devnet deploy signature: `2bxNRR1vYYjUgn1ZRmut2h1wn2J74pwRrsZQSyWdojjspJ4WYNCba2wiMpzgwHzAp7QekKSw9WHLRHJw2cWjWkR6`.
- `solana program show`: verified owner `BPFLoaderUpgradeab1e11111111111111111111111`, program data `F6EkfiDhetwsiqw7FCZSHDkj3iHX8QVxVzFucNcmsrwB`, data length `459064`.
- Devnet balances verified:
  - First test wallet: `5 SOL` before deploy, `1.80027904 SOL` after deploy.
  - Second test wallet: `5 SOL`.
- `node services/devnet-harness/src/lifecycle.mjs`: passed through void/refund lifecycle.
  - chips mint: `9FPjJqcsu9A9gpoxXvdwq6waRE8wsk3XrTk86iCPMc2U`
  - protocol: `CUcPK8LVqjqZvL9CaDWeZPr6uDXQBTUrRjGSZwYNiF5z`
  - match id: `1782484047`
  - match account: `AsbJtP5BSVNtfGQ9FVg3iJwWiaJBohupksq64XZNCfaz`
  - create mint tx: `3ALWJFuPgK8R1LhM23JED7jsP1ScUjX1tGJuFfZyUr29T7gmU37hcM1ABGL1uTUmsrfjxHn3UT9bu8nJq1A49KZt`
  - initialize protocol tx: `5oz9JYEvy5wQs73Jb7y4d9uY4gTbZL1JUsiSt8X51tA6ZpUXzCVpeeTBgsqkrjV8RF8BKfjrDFPRHVUCojLFYDZ4`
  - create match tx: `43sygPZu38a8EVmyEYnW1Qb6KzpxDDUbdvyTokoiSftQBxjqXpqQqpBKnzJBDgBeKRwbdQ5aqx9ddfQcozN5bLe6`
  - deposits: `3u2w72nqE5kSrqEntLZ8GjoeDRJzhRSWVEFp1MRgR4h4geGkfaYSwmpe8ibYk4ZqTL26AU8QJP2CMW6mVgpXiH75`, `2RNqwbgCF4DUUypjtaM47ZJztd8w7vUWL78djNvH9yLBRNvuCE1AE6z5YTBX2UeSoApU6a1LKZo8L4B2rfiyCq7J`
  - lock tx: `3S75Xts22Z8FNRGZPF17kj57gXSV8wMyw8UHLCm7kM4uiFz4PCEGz4aryTbDbufsNCzGb6DY3dSw6hqSWpF24nKP`
  - void tx: `3bMsgZttxoKeGchJi6YHGiAwBidA7bSrRwB3LceGvJP3ruQUYPcsdvzNMy1VPzaC4GzY9zPxTREFwf63QPEzxxcJ`
  - refunds: `sP546YMtCTANWhc1tAh58VN14wg2qEcH4fpCTd3ViGH2eZBsf9vW8G3i7ugcJsGexFeeFYmBRipEW6K8uorLHLw`, `4V5vUsm3KXTio9Xb5cX2CRWW54RLHP3aZioUoe7JkbZRZzxWpgwCS1ENoPtFhtb1W4JtabGXvVhZEDrZibPGCztA`
- `docker compose -f deploy/docker-compose.localnet.yml up -d`: passed after fixes.
- `./scripts/db-migrate-local.sh`: passed after default database fix.
- `docker compose -f deploy/docker-compose.app.yml up -d --build --force-recreate`: passed after fixes.
- Live app checks passed:
  - `GET /healthz` on action-feed, matchmaking, match-engine.
  - `GET /metrics` on gateway.
  - `GET /matches/history` on action-feed.
- Live infra checks passed:
  - Prometheus ready.
  - Grafana health ok.
  - NATS health ok.
  - MinIO live health ok.
- `cargo fmt --check`: passed.
- `bash -n scripts/*.sh`: passed.
- `git diff --check`: passed.
