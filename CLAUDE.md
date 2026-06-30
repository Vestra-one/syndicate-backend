# Syndicate Backend — Claude Code

## Critical rules
- **TRUST THE CODE, not docs.** Most markdown docs (ARCHITECTURE.md, plan files) are stale. The code is the source of truth.
- **Docs location**: legacy analysis/plan files live in `docs/archive/`. Don't cite them for current behavior.
- **Capital safety**: when uncertain, VOID rather than proceed on bad state.

---

## Build commands

```bash
# Solana contract — MUST use v1.53 (default v1.48 breaks edition2024 deps).
# Run from services/programs; cargo-build-sbf takes package args AFTER `--` (bare `-p` errors).
cd services/programs
cargo build-sbf --tools-version v1.53 -- -p syndicate-program
cargo check -p syndicate-program          # faster check (also from services/programs — contract is excluded from the root workspace)

# Rust workspace (excludes contract — different toolchain)
cargo check --workspace

# litesvm integration tests (standalone workspace)
cd services/programs/litesvm-tests && cargo test

# TypeScript services
cd services/<name> && npm test
```

---

## Service map

| Service | Lang | Role |
|---------|------|------|
| `services/programs` | Rust/Anchor | **Solana contract** — custody, settlement, lifecycle |
| `services/shared` | Rust | Deterministic settlement core (`settle()`), oracle types |
| `services/settlement` | Rust | Settlement orchestration — calls shared.settle(), drives chain |
| `services/settlement-chain` | TypeScript | Solana instruction builders + SettleArgs encoding |
| `services/config` | TypeScript | Match templates, `config_hash` allowlist |
| `services/match-engine` | Rust | Multi-street betting engine (HTTP) |
| `services/store` | SQL/Rust | Postgres queries + migrations (`0001_production_persistence.sql`) |
| `services/worker` | Rust | Settlement worker — loads DB context, triggers settlement |
| `services/matchmaking` | TypeScript | Match creation, seat registry |
| `services/gateway` | Rust | WebSocket player gateway |
| `services/timelock` | Rust | drand timelock decryption |
| `services/action-feed` | Rust | Real-time action broadcast (NATS) |
| `services/trust-safety` | Rust | Anti-abuse / rate limiting |
| `services/signed-price-server` | Go | Signs settlement prices (secp256k1 / EIP-191) |

---

## Key invariants (not obvious from code structure)

1. **Conservation**: `Σ seat_payouts = sealed_count × buy_in + dead_money - rake`. Enforced on-chain at settlement.

2. **Oracle (v1)**: Company-signed price from `signed-price-server` — secp256k1/EIP-191, NOT Pyth. `ProtocolState.price_signer` is the trusted Ethereum address (20 bytes). See `services/programs/.../signed_price.rs`.

3. **Action-log (v1)**: On-chain action-log replay is **removed** for v1 (CU optimization). Backend is trusted for per-seat payouts. `TODO(v1+)` in `lib.rs` header to restore `verify_settlement`.

4. **engine_seat**: Contiguous `0..sealed_count` assigned at `begin_live` in seat_index order. Non-sealers get `NO_ENGINE_SEAT = u8::MAX`. All settlement/payout arrays are indexed by `engine_seat`, not `seat_index`.

5. **Timelock target bound**: Two-sided — must publish in `(latest_match_end, latest_match_end + 20s]`. `latest_match_end = seal_deadline + total_betting + begin_live_window`. Prevents grief-void via far-future round.

6. **Config hash**: `config_hash` in `CreateParams` must match an entry in `config`'s allowlist. Prevents spam without requiring operator-gated creates.

7. **`begin_live_window_sec`**: Operator must call `begin_live` within this window after `seal_deadline_ts` (default 5s). Keeps `scheduled_end_ts` pinned near the seal round.

---

## Contract state (v1 — all tasks complete)

`services/programs/programs/syndicate_program/src/`

- `lib.rs` — all instructions + context structs
- `state.rs` — `MatchAccount`, `SeatAccount`, `SeatIndexAccount`, `ProtocolState`
- `settle_args.rs` — `SettleArgs` (signed_price + rake + payouts), `SeatPayout`
- `signed_price.rs` — secp256k1 recovery, EIP-191 hash, `verify_signed_price`
- `action_handlers.rs` — `register_prediction_commitment_handler` (seal during Sealing)
- `error.rs` — all `SyndicateError` variants

Tasks done: T1 `void_live_after_deadline`, T2 timelock bounds, T3 backend button randomness, T4 `create_and_deposit`, T5 removed action-log verify, T6 replaced Pyth with signed-price.

---

## Remaining backend work (non-contract)

See `docs/V1_COMPLETION_CHECKLIST.md` for the authoritative remaining-work list. Highlights:
- `settlement-chain`: missing lifecycle builders (`deposit`, `create_and_deposit`, `begin_live` with randomness+seats, `register_prediction_commitment`, both void paths) + RPC verify/enumerate helpers
- **No indexer** (locked v1 decision): backend verifies client-reported deposit/create txhashes via RPC at `finalized` and owns its registry; `begin_live` seat set comes from `getProgramAccounts(memcmp match_key)`, not a subscription
- matchmaking → registry from verified txhashes; gateway clock-sync + room push; orchestrator drop `set-button-seed`
- IDL is stale (still has action-log) — regenerate + fresh devnet deploy
