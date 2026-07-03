# Syndicate Backend v2 — Claude Code

## Critical rules
- **TRUST THE CODE, not docs.** Legacy analysis/plan markdown is stale; current-behavior docs are only `docs/deployment/DEPLOYMENT.md` and `docs/frontend/INTEGRATION.md`.
- **Capital safety**: when uncertain, VOID (full refund) rather than proceed on bad state. Never invent a payout.
- Money is integer chips (u64); prices are i128 fixed-point exponent −18. No floats in settlement paths.

---

## Build commands

```bash
# Solana contract — MUST use v1.53 (default v1.48 breaks edition2024 deps).
# Run from services/programs; cargo-build-sbf takes package args AFTER `--`.
cd services/programs
cargo build-sbf --tools-version v1.53 -- -p syndicate-program
cargo check -p syndicate-program          # faster check (contract is excluded from the root workspace)

# Host workspace
cargo check --workspace
cargo test --workspace
cargo clippy -p syndicate-chain -p syndicate-chain-worker -p syndicate-game-server

# litesvm integration tests (standalone workspace; needs the .so built first)
cd services/programs/litesvm-tests && cargo test

# Everything
scripts/test-all.sh
```

---

## Service map (v2 — 3 deployables + libs)

| Path | Kind | Role |
|---|---|---|
| `services/programs` | Rust/Anchor | **Solana contract** — custody, candidate→confirm seating, private-room commitments, on-chain button, settlement, voids. Program id `91BSZ2pEGCk7Scq9bnfTwrHCYGo8CzGBq5mbpKHAR5FK` |
| `services/game-server` | Rust bin | **The API**: REST `/v1/*` + WebSocket `/v1/ws`, lobby/rooms/intents, seat verification (RPC, no indexer), match actors (betting engine in-process), sealing, session-restore, claimables |
| `services/chain-worker` | Rust bin | Claims `chain_jobs` from Postgres, signs/submits lock/begin_live/settle/void/fees, runs the settlement pipeline (drand decrypt, signed price, payouts) |
| `services/signed-price-server` | Go | Signs feed prices (secp256k1/EIP-191); `GET /prices`, `/prices/at`, WS `/ws` |
| `services/chain` | Rust lib | PDAs, instruction builders, account decoders, RPC verify (feature `rpc`), byte-parity-tested against the program |
| `services/match-engine` | Rust lib (`syndicate-match-runtime`) | FencedMatchRuntime: signed-intent betting engine wrapper, hash-chained events, replay |
| `services/engine-core` | Rust lib | Pure poker state machine (streets, blinds, side-pot inputs) |
| `services/shared` | Rust lib | Deterministic `settle()`, intent messages, SHA-256 commitments |
| `services/timelock` | Rust lib | drand tlock (quicknet) encrypt/decrypt + beacon client |
| `services/store` | Rust lib + SQL | Postgres migrations `0001..0010` + fencing append SQL |

Infra: Postgres (source of truth), nginx (TLS/WS). **No NATS, no Redis, no Node services.**

## Key invariants
1. **Conservation (v2)**: `Σ seat_payouts == confirmed_count × buy_in − rake ≤ rake_cap`. Enforced on-chain at settlement.
2. **Seating**: on-chain deposit = seat CANDIDATE (max 32); backend confirms FCFS by `(finalized_slot, tx_sig)` at `lock` (confirmed seat PDAs passed in engine order — position i = engine_seat i). Unconfirmed candidates refund in full the moment the match leaves Filling.
3. **Private rooms**: `sha256(roomcode_uppercased ‖ wallet_pubkey)` commitments recorded on-chain (create + deposit); enforcement is backend confirm-at-lock.
4. **Non-sealers keep playing**: seal-close signed spot price (stored in `price_snapshots`) becomes their prediction (`prediction_source='spot'`). Zero sealers still goes Live.
5. **Button**: derived ON-CHAIN in `begin_live` — `keccak256("syndicate:button:v2" ‖ match ‖ lock_ts ‖ seal data)`; backend re-derives via `syndicate_chain::button_seed`.
6. **Oracle**: company-signed price (secp256k1/EIP-191), `publish_time == scheduled_end_ts` exactly. `ProtocolState.price_signer` is the trusted Ethereum address.
7. **Timelock bound**: seal target round must publish in `(latest_match_end, +20s]` where `latest_match_end = seal_deadline + total_betting + begin_live_window`.
8. **Job queue**: game-server enqueues `chain_jobs` transactionally; chain-worker claims with `FOR UPDATE SKIP LOCKED`; results flow back via `syndicate_chain_job_results` NOTIFY. Permissionless void backstops are pre-scheduled (`not_before`).
9. **Byte parity**: `litesvm-tests/tests/chain_parity.rs` pins `syndicate-chain` encodings to the program — run it after touching either side.

## Deployment
`deploy/docker-compose.yml` (+ `docker-compose.devnet.yml`), `scripts/deploy-program-devnet.sh`, `scripts/deploy-devnet.sh`, `scripts/db-migrate.sh`, `scripts/smoke-test.sh`. Guide: `docs/deployment/DEPLOYMENT.md`. FE guide: `docs/frontend/INTEGRATION.md` (+ regenerated IDL at `docs/frontend/idl/syndicate_program.json`).
