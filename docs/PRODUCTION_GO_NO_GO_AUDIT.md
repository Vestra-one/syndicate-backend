# Syndicate Production Go/No-Go Audit

**Status:** DEVNET REHEARSAL PASSED; MAINNET GO REQUIRES RELEASE CEREMONY, SECRET ROTATION, AND FINAL RISK SIGN-OFF.
**Date:** 2026-06-27
**Scope:** Backend services, settlement worker, settlement-chain adapter, Pyth/drand paths, persistence contracts, deployment scripts, and local test gates after mainnet-preparation hardening.

## Executive Verdict

The project-owned blockers from the previous audit have been remediated in source:

- The Rust settlement worker now runs the durable production path: Postgres attempt store, outbox relay, JetStream durable consumer, due-attempt poller, settlement-chain HTTP adapter, Pyth resolve, drand timelock open, and crash-safe retry semantics.
- `settlement-chain` owns runtime Pyth Receiver posting, PDA derivation, Anchor `SettleArgs` encoding, simulation, submission, confirmation, and void transactions.
- Prepared transaction JSON mode and `/internal/pyth/post-update` are removed from the production path.
- Crash recovery confirms an existing submitted signature before any resend.
- Shutdown no longer acknowledges fetched-but-unprocessed settlement messages.
- DB/config/on-chain day-0 player limits are aligned at five seats.
- `scripts/test-all.sh` is fixed for dependency-installed worktrees and now avoids dependency test files under `node_modules`.
- Deployment preflights require the runtime settlement token, signer keypair path, Pyth Receiver IDs, and mainnet drand settings.

The end-to-end Devnet rehearsal completed successfully after upgrading the Devnet program to the current pro-compatible Pyth Receiver build. Mainnet deployment is eligible only after the production release ceremony is recorded, the exposed test Hermes key is rotated, and the residual upstream dependency advisories are accepted or remediated by upstream releases.

## Current Gate Status

| Area | Status | Evidence | Mainnet Requirement |
|---|---|---|---|
| Local all-tests gate | GO | `./scripts/test-all.sh` passes with installed service dependencies: 81 Node tests, Rust workspace tests, zero skips. | Keep as mandatory preflight. |
| On-chain SBF build | GO | `cargo-build-sbf --manifest-path services/programs/Cargo.toml` succeeds. | Anchor CLI/path must be available in deployment shell if using Anchor commands. |
| Settlement worker production path | GO | Durable Postgres/NATS worker path and retry/void/idempotency tests pass; Devnet void/refund and settlement/claim lifecycle completed. | Run from production secrets and release config only. |
| Settlement-chain adapter | GO | Lockfile added; tests execute with real Solana/Pyth deps and zero skips; Devnet Pyth settlement used Receiver post plus Syndicate settlement. | Keep adapter bound internally and token protected. |
| Pyth oracle path | GO | Bounded exact-after resolve, proof persistence fields, selected-vs-bundle checks, and on-chain full-verification receiver checks exist; live Hermes/Pyth Receiver Devnet path completed. | Rotate Hermes API key before mainnet. |
| Timelock path | GO FOR DEVNET | Mainnet worker uses drand-backed opener; mock is local/test only. | Record real drand-open settlement reconstruction in rehearsal or staging. |
| Persistence and recovery | GO FOR DEVNET | Postgres schema, settlement attempts, dead letters, retry scheduling, and outbox contracts pass tests. | Run migrations and worker against live Devnet/staging Postgres. |
| Deployment scripts | GO FOR DEVNET | Compose config validates; deploy scripts require settlement/Pyth/drand runtime inputs. | Mainnet must run from clean `main` with release config hash and multisig authority workflow. |
| Test-key file | NOT A MAINNET FINDING | `devnet_testing_keys.md` is explicitly Devnet-only harness input. | Never use for production authority or settlement signer roles. |
| Upstream npm advisories | TRACKED RISK | `npm audit --prefix services/settlement-chain --omit=dev` reports Solana/Pyth stack advisories; latest `@solana/web3.js` and Pyth receiver have no patched replacement available. | Accept as upstream dependency risk with monitoring, or migrate adapter dependencies when patched alternatives exist. |

## Verified Commands

```bash
./scripts/test-all.sh
npm --prefix services/settlement-chain test
npm audit --prefix services/gateway --omit=dev --json
npm audit --prefix services/settlement-chain --omit=dev --json
docker compose -f deploy/docker-compose.localnet.yml config
docker compose -f deploy/docker-compose.app.yml config
/Users/adarshkumar/.local/share/solana/install/active_release/bin/cargo-build-sbf --manifest-path services/programs/Cargo.toml
/Users/adarshkumar/.local/share/solana/install/active_release/bin/solana account FR4tqVX41CDmUbJEbM7Qx5hxfQnfLmCJspTab7fou3WS --url https://api.devnet.solana.com
PYTH_API_KEY=<host-secret> SYNDICATE_DEVNET_REQUIRE_PYTH_SETTLEMENT=true ./scripts/devnet-lifecycle-harness.sh
```

## Residual Risks To Track

1. **Settlement-chain upstream advisories:** current Solana/Pyth JS packages report npm advisories with no fixed published versions. The adapter is localhost/internal-token protected, but it still parses externally sourced Pyth/RPC data. Monitor upstream releases and upgrade immediately when a patched supported stack exists.
2. **Anchor CLI availability:** this shell has Solana `cargo-build-sbf` and builds the program, but `anchor` is not on `PATH`. Devnet/mainnet deployment scripts that call `anchor build` require the deployment shell to expose Anchor.
3. **Public Devnet RPC reliability:** the rehearsal required bounded retries because the public endpoint returned 429s. Mainnet rehearsal/deploy should use a paid primary RPC plus secondary read verification.

## Devnet Rehearsal Evidence

- Devnet program upgraded to the current SBF at slot `472336750`; program id `FR4tqVX41CDmUbJEbM7Qx5hxfQnfLmCJspTab7fou3WS`, authority `EFHmTqPZThphFdvSW2kM7ntdc1EPogafsaq6wfe9DiQv`.
- Void/refund lifecycle completed for match `1782568253`: lock `4trKHpN5zDCNTDVXPfyYhEJVqpAS3E4S5Vu2CWkj18NbBDmexEGXKot9PkKHNvYun6cvki54pakrd2WYnJfHrYj2`, void `3ENPuzXNdvBo5P1XYhimuYPHeZNhETpUzi8qnqW9t7pQMzqyxxfPUv88U38xtWKeq748HENzF4VwvTqzU6EfETEf`, refunds `368LT46vGJxacRvy1qF3vAr6rdpFNzHaMFArChRaNi8gr1MecUCxCxNwTCfJdg6gtV8oDfGXy6HLewdSQiHDEGnr` and `3rqdtLPgshPnXZFji3sMw1CBwvvhzsT3B7b3pcwN6todXKkwXTRhdvytRy6B2AYoT8DZTDkkuuDFufUKw4ncYyhv`.
- Pyth settlement lifecycle completed for match `1782568254`: lock `52JkF9oRaSUuruBniNmy895TGQFwhHeUnanp33UYq5nqKoLcVHj5VKURTMiNkKwKpUDrs8bfz1HRDxKLbfTmLv1b`, Pyth post `5bwCnBvtxoisfdPJQwNYBxyx1daQVJcjWFtgttNAJWGYa73Cv9tRm7Yi5D4uuWiW2wZsPbnyx6mHSiiAMceevPeJ`, settlement `3KipHUxiBUZ1UyHsHTsPwu64qsEviat7BgMKTKAMCn19yP2hyoHwri2go1x9ZxAKAdQPi22Xv35xX8kZ4C71sQ5G`, claims `5XEsv2b3Mces3KTnWNRWWcHLk3y2vu8qr46kirXduN5eVHSNxRZZerLGQe62TcNxfSU7cyedW7tAAwt4v2jARvFU` and `66FPMEvrX9pAqcsNyQMPEwd3eqWMTee34XPg3bhW8YVr98rZMCbfnpr3qyZPGR6i3ptdbM5ius56BtW3ZTTfS5Qt`.
- Pyth receipt archived at `/tmp/syndicate-devnet-receipts/1782568254-devnet_1782568269_0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43.json`; selected publish time `1782568269`, exponent `-8`, Receiver `rec2HHDDnjLfj4kE7VyEtFA1HPGQLK33259532cRyHp`, Wormhole `HDw2E7P8X1SkCyjvoGsfBGAVUutKcj874bXjHrpVYrVL`, Push Oracle `pyt2F414BA6dPttK6RddPZUdHfapoBN24GL5wbrPCou`.

## Devnet Rehearsal Checklist

1. Confirm Devnet program account and authority setup.
2. Run migrations on Devnet/staging Postgres.
3. Start local or VPS services with production worker mode and locked settlement-chain dependencies.
4. Run `PYTH_API_KEY=<host-secret> SYNDICATE_DEVNET_REQUIRE_PYTH_SETTLEMENT=true ./scripts/devnet-lifecycle-harness.sh`.
5. Verify lifecycle receipts: initialize/reuse protocol, create match, deposit, lock, Pyth resolve/post, submit settlement, claim.
6. Run the no-update path and verify separate admin `void` plus player `refund`.
7. Archive Pyth selected price, publish time, confidence, exponent, price update account, transaction signatures, receiver/wormhole/push ids, Hermes response hash, and binary update hash.

## Mainnet Gate

Mainnet deployment is not authorized by this document alone. It becomes eligible only after:

- Devnet rehearsal receipts are retained in the release package.
- Release config hash, program id, and authority/multisig ceremony are recorded.
- Pyth API key rotated and stored only as host secret.
- Settlement signer is scoped, funded, monitored, and distinct from upgrade/admin authorities.
- Upstream Solana/Pyth npm advisories are either resolved by upgrade or explicitly accepted with monitoring and rollback criteria.
