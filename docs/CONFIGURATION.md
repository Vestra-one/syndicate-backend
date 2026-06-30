# Syndicate — Configuration Reference

This is the single authoritative inventory of **every configurable parameter** across the
Syndicate Solana contract and all backend services. For each parameter it lists the name,
type, default, what it controls, and — most importantly — **how to change it**.

> **Source of truth.** Values here were captured directly from the code. The **code remains
> authoritative**; if a value here ever disagrees with the source, the source wins. Most
> other markdown docs in this repo are stale (see `CLAUDE.md`).

> **Correction vs. the service map.** `CLAUDE.md`'s service map lists `gateway` and
> `action-feed` as Rust. In the actual code both are **TypeScript** services, and
> `trust-safety` is a TypeScript **library** (no binary). This document follows the code.

---

## 1. How to change a config — the legend

Every parameter below is tagged with one of these change mechanisms:

| Tag | Meaning | How you change it |
|-----|---------|-------------------|
| **`env`** | Environment variable | Set it in the service's environment. Canonical template: [`docs/deployment/env.example`](deployment/env.example). In container deploys, set it under the service in [`deploy/docker-compose.app.yml`](../deploy/docker-compose.app.yml). |
| **`config-service`** | Match template / tier served by the `config` service | Edit [`services/config/src/index.ts`](../services/config/src/index.ts) and redeploy the config service. Drives per-match behavior. |
| **`config-file`** | A file on disk (TOML / Caddyfile / nginx.conf / docker-compose) | Edit the named file and restart/reload the service. |
| **`per-match`** | `CreateParams` chosen per match at creation time | Supplied by the match creator; **must hash to an entry in the config-service allowlist** (`config_hash`). |
| **`request-body`** | Supplied in an HTTP request body | Sent by the caller (e.g. orchestrator → match-engine `/start`). Falls back to a coded default if omitted. |
| **`code`** | Hardcoded constant | Requires a code change + redeploy of that service. |
| **`program-upgrade`** | On-chain contract constant | Requires rebuilding and redeploying the Solana program (a contract upgrade). |

**Where env vars actually live:** local/bare-metal reads process env (seed from
`docs/deployment/env.example`); container deploys set them per-service in
`deploy/docker-compose.app.yml`; secrets (auth tokens, signer keypairs) are passed as file
paths, not inline values.

### ⚠️ Three-place sync rule (read before changing match economics)
The per-match parameters (`buy_in`, `rake_bps`, `nonseal_penalty_bps`, betting windows,
`oracle_exponent`, etc.) exist in **three** places that must stay in agreement, or on-chain
`config_hash` validation will reject the match:

1. **Contract** `CreateParams` bounds — `services/programs` (the hard limits).
2. **Config service** defaults/templates — `services/config/src/index.ts` (what gets offered).
3. **Settlement-chain encoder** fallback defaults — `services/settlement-chain/src/custody.ts`
   (what gets encoded if a field is omitted).

When you change a match-economics default, change it in all three (or confirm the others
already match). See §3, §6e, and the recipes in §10.

### ⚠️ Legacy / vestigial knobs
v1 settlement uses the **signed-price-server** (company-signed secp256k1/EIP-191 prices),
**not Pyth**. The `PYTH_*` environment variables still exist and must be *set to any
non-empty value to avoid a startup panic*, but they do **not** affect settlement. Do not
tune them expecting a behavior change. They are flagged "legacy" wherever they appear.

---

## 2. Solana Contract — `services/programs`

Source: `services/programs/programs/syndicate_program/src/` (`lib.rs`, `state.rs`,
`signed_price.rs`).

### 2a. Hardcoded protocol constants — tag `program-upgrade`
Changing any of these requires a contract rebuild + redeploy.

| Constant | Value | What it controls |
|----------|-------|------------------|
| `DRAND_GENESIS_TIME` | `1_692_803_367` | drand quicknet genesis unix time; basis for round→publish-time math. |
| `DRAND_PERIOD_SEC` | `3` | drand quicknet beacon period (seconds). |
| `SEAL_VOID_GRACE_SEC` | `60` | Grace after `seal_deadline_ts` before a stuck *Sealing* match can be permissionlessly voided (operator-liveness window). |
| `SETTLE_VOID_GRACE_SEC` | `300` | Grace after `scheduled_end_ts` before a stuck *Live* match can be permissionlessly voided (capital-safety backstop). |
| `MAX_TIMELOCK_SKEW_SEC` | `20` | Max slack after latest match end for a prediction's `timelock_target` round (grief protection; see invariant #5). |
| `DEFAULT_BEGIN_LIVE_WINDOW_SEC` | `5` | Default operator go-live window if a match passes `0`. Operator must call `begin_live` within this many seconds of the seal deadline. |
| `SIGNED_PRICE_EXPONENT` | `-18` | Fixed-point WAD exponent the oracle price must use. Must equal the signed-price-server exponent. |
| `SIGNED_PRICE_CONFIDENCE` | `0` | Required oracle confidence (exact; no variance). |
| `NO_ENGINE_SEAT` | `255` (`u8::MAX`) | Sentinel for non-sealers that get no engine slot at `begin_live`. |

### 2b. ProtocolState (global) — tag `program-upgrade` to add fields; values set via admin instructions
Created once at `initialize_protocol`. Role fields are pubkeys set at init; the operational toggles below are changed at runtime via the named instructions (no upgrade needed).

| Field | Type | How to change | Purpose |
|-------|------|---------------|---------|
| `protocol_admin`, `settlement_admin`, `emergency_void_admin`, `pause_admin`, `config_admin`, `fee_admin`, `treasury_admin`, `upgrade_authority` | `Pubkey` | Set at `initialize_protocol` | Governance / operator roles. |
| `price_signer` | `[u8; 20]` | **`set_price_signer`** (config_admin) | The trusted Ethereum address whose secp256k1 signature authorizes settlement prices. Rotatable. |
| `pause_new_matches` | `bool` (default `false`) | **`set_pauses`** (pause_admin) | Halts creation of new matches. |
| `pause_settlement` | `bool` (default `false`) | **`set_pauses`** (pause_admin) | Halts settlement submission. |

### 2c. CreateParams (per-match) — tag `per-match`
Passed at `create_match` / `create_and_deposit`. These are the per-match economics and
timing. They are bound into `config_hash` and **must match the config-service allowlist**
(see §3 and the three-place sync rule).

| Field | Type | Constraint | Purpose |
|-------|------|-----------|---------|
| `match_id` | `u64` | unique | PDA seed. |
| `buy_in` | `u64` | `> 0` | Fixed stack per seat (chips). Immutable once set. |
| `entry_fee` | `u64` | — | Fee taken on join, per seat. |
| `rake_bps` | `u32` | `<= 10_000` | Pot rake in basis points. |
| `rake_cap` | `u64` | `<= buy_in` | Per-pot rake cap (chips). |
| `nonseal_penalty_bps` | `u32` | `<= 10_000` | Non-sealer penalty (% of buy-in) forfeited to the pot/sealers. |
| `min_players` | `u8` | `>= 2`, `<= max_players` | Minimum seated players to go live. |
| `max_players` | `u8` | `<= 5` | Seat limit (engine caps at 5 seats). |
| `config_hash` | `[u8; 32]` | in allowlist | SHA-256 of the bound config (replay anchor). |
| `price_token` | `[u8; 20]` | `!= 0x00…00` | Ethereum token address the price is signed for. |
| `total_betting_duration_sec` | `u64` | `> 0` | Wall-clock betting span (Σ streets + observation). `scheduled_end_ts = live_start + this`. |
| `seal_window_sec` | `u64` | `> 0` | Sealing window length. `seal_deadline_ts = lock_ts + this`. |
| `begin_live_window_sec` | `u64` | `0`→default 5 | Max delay after seal deadline to call `begin_live`. |
| `fill_deadline_ts` | `u64` | `> now` | After this, an unfilled (Filling) room can be permissionlessly voided. |
| `max_oracle_confidence` | `u64` | — | Max allowed oracle confidence spread. |
| `oracle_exponent` | `i32` | `== -18` | Must equal `SIGNED_PRICE_EXPONENT`. |

> Derived/runtime match state (`dead_money`, `sealed_count`, `engine_seat`, `button`,
> `scheduled_end_ts`, `signed_price_hash`, …) is computed on-chain at `begin_live` /
> `submit_settlement` — it is **not** configuration and cannot be set directly.

---

## 3. Match config defaults & tiers — `services/config` (TypeScript) — tag `config-service`

**This is the primary place a manager changes match behavior.** Port: `CONFIG_PORT`
(code default `8084`), host `CONFIG_HOST` (default `127.0.0.1`). Source:
`services/config/src/index.ts`.

> ⚠️ The code default `8084` collides with the worker health-server default (§5b). In
> container deploys `docker-compose.app.yml` sets `CONFIG_PORT: 8085` (host `18085`), so the
> config service actually runs on **8085** there. Set `CONFIG_PORT` explicitly to avoid the
> collision on bare metal.

### Buy-in tiers (`TIER_BUY_INS` + fill windows)
| Tier | Buy-in | Fill window |
|------|--------|-------------|
| `tier-low` | `10_000_000` ($10 USDC, 6-decimals) | 90 s |
| `tier-mid` | `50_000_000` ($50) | 120 s |
| `tier-high` | `100_000_000` ($100) | 180 s |
| `tier-practice` | `0` (free; rake/penalty zeroed) | 60 s |

### Default match config (`defaultFeedUsdcTier`)
| Field | Default | Purpose |
|-------|---------|---------|
| `chipsToken` | `"USDC"` | Settlement token. |
| `maxBuyIn` | `5_000_000_000_000` | Upper bound on buy-in. |
| `chipsPerUnit` | `1` | Chips per token unit. |
| `smallBlind` / `bigBlind` | derived: `bigBlind = max(2, buyIn/100)`, `smallBlind = max(1, bigBlind/2)` | Blinds (~100 BB stacks). |
| `ante` | `0` | Ante. |
| `actionTimerSec` | `25` | Per-turn action timer. |
| `timeBankSec` | `60` | Replenishing per-street time bank. |
| `roundCount` | `3` | Number of streets. |
| `roundDurationsSec` | `[220, 160, 120]` | Per-street betting durations. |
| `observationWindowsSec` | `[20, 20, 40]` | Per-street price-observation windows. |
| `sealWindowSec` | `20` (`DEFAULT_SEAL_WINDOW_SEC`) | Sealing window. |
| `beginLiveWindowSec` | `5` (`DEFAULT_BEGIN_LIVE_WINDOW_SEC`) | Go-live window. |
| `nonsealPenaltyBps` | `2500` (`DEFAULT_NONSEAL_PENALTY_BPS`, 25%) | Non-sealer penalty. |
| `rakeBps` | `300` (`DEFAULT_RAKE_BPS`, 3%) | Pot rake. |
| `rakeCap` | `buyIn` | Per-pot rake cap. |
| `entryFee` | `0` (`DEFAULT_ENTRY_FEE`) | Entry fee. |
| `settlementWindowSec` | `60` | Settlement window. |
| `minPlayers` / `maxPlayers` | `2` / `5` | Seat bounds (validator enforces `>=2`, `<=5`). |
| `fillWindowSec` | `120` (overridden per tier) | Room fill window. |
| `allowDuplicateWalletPerMatch` | `false` | One seat per wallet. |
| `timelockTargetOffsetSec` | `600` | **Legacy/unused.** |

### Standalone constants
| Constant | Value | Purpose |
|----------|-------|---------|
| `MIN_START_BB` | `20` | Reject configs with starting stack < 20 BB (too shallow). |
| `DEFAULT_SUPPORTED_FEEDS` | `['BTC/USD','ETH/USD','SOL/USD']` | Supported price feeds. |
| `DEFAULT_GEOFENCE_BLOCKLIST` | `['IN']` | Blocked country ISO codes. |
| `MAX_TIMELOCK_SKEW_SEC` | `20` | **Must equal on-chain `MAX_TIMELOCK_SKEW_SEC`.** |
| `MAX_ORACLE_TOLERANCE_SEC` / `DEFAULT_ORACLE_DELAY_WINDOW_SEC` | `2` / `2` | Oracle timing tolerance. |
| `DRAND_GENESIS_TIME` / `DRAND_PERIOD_SEC` | `1_692_803_367` / `3` | Mirror on-chain drand constants for round math. |
| Feed decimals (`table-terms.ts`) | BTC/ETH/SOL = `8` | Price display decimals. |

> ⚠️ These defaults must agree with the **contract bounds** (§2c) and the
> **settlement-chain encoder defaults** (§6e). See the three-place sync rule.

---

## 4. Settlement core & service — `services/shared`, `services/settlement` — tag `code`

These are fixed settlement *logic*, not operational knobs — changing them requires a code
change and is capital-sensitive.

**`services/shared`** (deterministic core): intent domain tags
(`syndicate/action/v1`, …), action/default tag codes, `EVENT_SCHEMA_VERSION = 1`, the rake
formula `rake = min(rake_bps * amount / 10_000, rake_cap)` (clamped to `amount`), and the
conservation invariant `Σ pot_awards + Σ uncalled_returns + rake == Σ contributions +
dead_money`. Treat as constants.

**`services/settlement`** — `RetryPolicy` defaults (in-Rust): `max_submit_attempts = 5`,
`base_delay_ms = 1_000`, `max_delay_ms = 30_000`, `min_confirmations = 1`.

> In production the **worker** (§5b) drives submission/confirmation behavior via its own
> `SETTLEMENT_*` env vars; those env values are what you tune operationally.

---

## 5. Rust services (env-driven binaries)

### 5a. match-engine — port `8083` — tags `env`, `request-body`
Source: `services/match-engine/src/`.

| Env var | Default | Purpose |
|---------|---------|---------|
| `MATCH_ENGINE_HOST` | `127.0.0.1` | Bind host. |
| `MATCH_ENGINE_PORT` | `8083` | Listen port. |
| `DATABASE_URL` | *required* | Postgres connection. |
| `MATCH_ENGINE_NODE_ID` | `engine-1` | Node id for distributed leasing. |
| `TIMELOCK_TARGET_ROUND` | `1_000_000` | Default drand timelock round for sealing. |
| `MATCH_ENGINE_POSTGRES_LEASES` | `true` | Use Postgres (vs in-memory) for lease coordination. |
| `MATCH_ENGINE_TIMEOUT_POLL_MS` | `500` | Action-timeout / street-deadline polling interval. |
| `REDIS_URL` | *(unset → disabled)* | Redis pub/sub for `match:{id}` events. |
| `SYNDICATE_ALLOW_DEV_SIGNATURES` | `false` | **Unsafe.** Allow dev signatures (local only). |

**Per-match `request-body` fields** (POST `/internal/matches/start`), with coded fallbacks
when omitted: `roundDurationsSec` (fallback 180/street), `observationWindowsSec` (20/street),
`actionTimeoutMs` (25_000), `timeBankSec` (60), `roundCount` (3), `smallBlind`/`bigBlind`
(1/2); `lease_ttl_ms` is hardcoded `60_000`. To change real behavior, set these upstream in
the config service / orchestrator, not in the fallbacks.

### 5b. worker (settlement worker) — port `8084` — tag `env`
Source: `services/worker/src/`.

| Env var | Default | Purpose |
|---------|---------|---------|
| `APP_ENV` | `localnet` | Environment; selects production vs demo mode. |
| `SETTLEMENT_WORKER_MODE` | auto (`production` if mainnet) | Override worker mode. |
| `SETTLEMENT_WORKER_HOST` / `SETTLEMENT_WORKER_PORT` | `0.0.0.0` / `8084` | Health server. |
| `DATABASE_URL`, `NATS_URL`, `SETTLEMENT_CHAIN_URL` | *required* | Backing services. |
| `SETTLEMENT_CHAIN_AUTH_TOKEN_FILE` | *required* | Path to settlement-chain auth token. |
| `SETTLEMENT_SIGNER_KEYPAIR_PATH` | *required* | Path to Solana signer keypair JSON. |
| `SOLANA_RPC_URL_PRIMARY` | *required* | Primary RPC. |
| `SOLANA_RPC_TIMEOUT_MS` | `5_000` | RPC call timeout. |
| `SYNDICATE_PROGRAM_ID` | *required* | On-chain program id. |
| **Outbox relay:** `SETTLEMENT_RELAY_POLL_MS` / `_BATCH_SIZE` / `_VISIBILITY_MS` / `_RETRY_MS` / `_MAX_ATTEMPTS` | `1_000` / `16` / `60_000` / `5_000` / `10` | Relay loop tuning. |
| **Due poller:** `SETTLEMENT_POLLER_INTERVAL_MS` / `_BATCH_SIZE`; `SETTLEMENT_CONFIRMATION_TIMEOUT_MS` | `5_000` / `16` / `60_000` | Poller + confirmation timeout. |
| **NATS/JetStream:** `SETTLEMENT_STREAM_NAME` / `SETTLEMENT_CONSUMER_NAME` / `SETTLEMENT_ACK_WAIT_MS` / `SETTLEMENT_MAX_DELIVER` | `SETTLEMENT` / `settlement-worker` / `60_000` / `10` | Stream config. |
| **drand:** `DRAND_API` / `DRAND_CHAIN_HASH` / `DRAND_EXPECTED_SCHEME_ID` / `TIMELOCK_GRACE_SEC` / `TIMELOCK_HTTP_TIMEOUT_MS` | `https://api.drand.sh` / quicknet hash / `bls-unchained-g1-rfc9380` / `300` / `5_000` | Timelock decryption. `TIMELOCK_GRACE_SEC` is clamped `>=` on-chain `SETTLE_VOID_GRACE_SEC` (300). |
| **Legacy Pyth:** `PYTH_API_KEY[_FILE]`, `PYTH_HERMES_URL`, `PYTH_RECEIVER_STACK` (or `SYNDICATE_PYTH_RECEIVER_STACK`), `PYTH_RECEIVER_PROGRAM_ID`, `PYTH_WORMHOLE_PROGRAM_ID`, `PYTH_PUSH_ORACLE_PROGRAM_ID` | — | **Vestigial.** Must be set to avoid panic; unused for settlement. |

### 5c. match-orchestrator — port `8086` — tag `env`
Source: `services/match-orchestrator/src/main.rs`.

| Env var | Default | Purpose |
|---------|---------|---------|
| `ORCHESTRATOR_HOST` / `ORCHESTRATOR_PORT` | `127.0.0.1` / `8086` | Bind host/port. |
| `SETTLEMENT_CHAIN_URL` | `http://127.0.0.1:8790` | Settlement-chain URL. |
| `MATCH_ENGINE_URL` | `http://127.0.0.1:8083` | Match-engine URL. |
| `ORCHESTRATOR_AUTH_TOKEN` | `""` | Bearer token (optional). |
| `SYNDICATE_ORCHESTRATOR_STUB` | *(unset)* | Stub mode (`1`/`true`/`yes`/`on`) for local dev. |

Coded defaults if a start request omits them: small/big blind `1`/`2`, round count `3`,
action timeout `25_000` ms.

---

## 6. TypeScript services

### 6a. gateway (WebSocket player gateway) — port `8081` — tag `env`
Source: `services/gateway/src/`.

| Env var | Default | Purpose |
|---------|---------|---------|
| `GATEWAY_PORT` / `PORT` | `8081` | Listen port. |
| `GATEWAY_HOST` | `127.0.0.1` | Bind host. |
| `DEFAULT_GEOFENCE_BLOCKLIST` | `IN` | Comma-separated blocked country codes. |
| `REDIS_URL` | *(unset → disabled)* | Redis for challenge/session/rate-limit stores. |
| `GATEWAY_RATE_LIMIT_WINDOW_SEC` | `60` | Rate-limit window. |
| `GATEWAY_RATE_LIMIT_MAX` | `120` | Max requests per window. |
| `MATCH_ENGINE_URL` / `MATCHMAKING_URL` / `ACTION_FEED_URL` / `CONFIG_URL` | `:8083` / `:8082` / `:8080` / `:8084` | Downstream service URLs. |
| `ORCHESTRATOR_AUTH_TOKEN` | *(unset)* | Bearer token for downstream auth. |
| `GATEWAY_METRICS_PORT` / `GATEWAY_METRICS_HOST` | *(unset)* / =`GATEWAY_HOST` | Optional metrics server. |

`code` constants: auth nonce TTL `120` s, session TTL `3600` s (1 h).

### 6b. matchmaking — port `8082` — tag `env`
Source: `services/matchmaking/src/`.

| Env var | Default | Purpose |
|---------|---------|---------|
| `MATCHMAKING_PORT` / `PORT` | `8082` | Listen port. |
| `MATCHMAKING_HOST` | `127.0.0.1` | Bind host. |
| `REDIS_URL` | *(unset)* | Redis store (optional). |
| `ORCHESTRATOR_URL` / `ORCHESTRATOR_AUTH_TOKEN` | `http://127.0.0.1:8086` / *(unset)* | Orchestrator. |
| `SYNDICATE_ORCHESTRATOR_STUB` | `0` | Stub mode for local dev. |
| `SETTLEMENT_CHAIN_URL` / `SETTLEMENT_CHAIN_AUTH_TOKEN` | `http://127.0.0.1:8085` / *(unset)* | Settlement-chain. ⚠️ Code default port `8085` is stale (settlement-chain listens on **8790**, §6d). Deploys override `SETTLEMENT_CHAIN_URL` to `http://settlement-chain:8790`; set it explicitly on bare metal. |
| `MATCH_PERSISTENCE_URL` / `MATCH_PERSISTENCE_AUTH_TOKEN` | *(unset)* | HTTP persistence endpoint. |
| `WALLET_ROOM_CAP` | `3` (`DEFAULT_WALLET_ROOM_CAP`) | Max active rooms per wallet (anti-spam). |

`code` constants: `TABLE_TTL_SEC` `2_592_000` (30 d) Redis snapshot TTL; rating buckets
bronze `<1000`, silver `1000–1499`, gold `1500–1999`, elite `2000+`.

### 6c. action-feed — port `8080` — tag `env`
Source: `services/action-feed/src/`.

| Env var | Default | Purpose |
|---------|---------|---------|
| `ACTION_FEED_PORT` / `PORT` | `8080` | Listen port. |
| `ACTION_FEED_HOST` | `127.0.0.1` | Bind host. |
| `ACTION_FEED_OBJECT_STORE_DIR` | *(unset → memory)* | Filesystem object store dir. |
| `DATABASE_URL` | *(unset → no hydration)* | Postgres for historical hydration. |
| `REDIS_URL` | *(unset)* | Redis lobby bridge. |
| `NATS_URL` | *(unset)* | NATS pub/sub. |
| `ACTION_FEED_PROJECTOR_INTERVAL_MS` | `1_000` | Projector polling interval. |

### 6d. settlement-chain — port `8790` — tag `env`
Source: `services/settlement-chain/src/main.ts`.

| Env var | Default | Purpose |
|---------|---------|---------|
| `SETTLEMENT_CHAIN_HOST` / `SETTLEMENT_CHAIN_PORT` | `127.0.0.1` / `8790` | Bind host/port. |
| `SETTLEMENT_CHAIN_AUTH_TOKEN_FILE` | *required* | Path to auth token file. |
| `SETTLEMENT_SIGNER_KEYPAIR_PATH` | *required* | Path to Solana signer keypair JSON (64 bytes). |
| `SOLANA_RPC_URL_PRIMARY` | *required* | Primary RPC. |
| `SOLANA_RPC_URL_SECONDARY` | *(unset)* | Secondary RPC for verification. |
| `SYNDICATE_PROGRAM_ID` | *required* | On-chain program id. |
| `CHIPS_TOKEN_MINT` | `''` | SPL token mint for chips. |
| `SIGNED_PRICE_SERVER_URL` | `http://127.0.0.1:8080` | Oracle (signed-price-server). |
| `SETTLEMENT_CONFIRMATION_TIMEOUT_MS` | `60_000` | Tx confirmation timeout. |
| `SETTLEMENT_COMPUTE_UNIT_PRICE_MICRO_LAMPORTS` | `100_000` | Priority fee (1M micro-lamports = 1 SOL/CU). |
| `SIGNED_PRICE_HTTP_TIMEOUT_MS` | `5_000` | HTTP timeout to price server. |
| `TREASURY_TOKEN_ACCOUNT` | *(request body or env)* | Treasury token account for fee withdrawal. |

### 6e. settlement-chain CreateParams encoder defaults — tag `code`
Source: `services/settlement-chain/src/custody.ts`. These fallbacks are used by the
Borsh encoder when a field is omitted; they **must match** §2c bounds and §3 defaults.

| Field | Default | | Field | Default |
|-------|---------|-|-------|---------|
| `buyIn` | `10_000_000` | | `totalBettingDurationSec` | `600` |
| `entryFee` | `0` | | `sealWindowSec` | `20` |
| `rakeBps` | `300` | | `beginLiveWindowSec` | `5` |
| `rakeCap` | `buyIn` | | `fillDeadlineTs` | `now + 300` |
| `nonsealPenaltyBps` | `2500` | | `maxOracleConfidence` | `2^64 − 1` |
| `minPlayers` | `2` | | `oracleExponent` | `-18` |

`DEFAULT_PRICE_FEEDS` (symbol → signed-price token address; default feed `BTC/USD`):
- `BTC/USD` → `0xa7BaE7da3E4950700BE9f107EB186e89a474d180`
- `ETH/USD` → `0x6Dd0C6a2e058bc3F7D6AaCe23965180BcBbb2635`
- `SOL/USD` → `0xD31a59c85aE9D8edEFeC411D448f90841571b89c`

### 6f. trust-safety (library, no binary) — tag `code`
Source: `services/trust-safety/src/index.ts`. `DEFAULT_THRESHOLDS` + detection constants:

| Threshold | Value | Purpose |
|-----------|-------|---------|
| `chipDumpFlag` / `chipDumpBan` | `0.6` / `0.8` | Chip-dumping score → flag / ban. |
| `sybilFlag` / `sybilBan` | `2` / `3` | Sybil cluster size → flag / ban. |
| bot-timing CV | `< 0.05` | Coefficient-of-variation below this flags a bot. |
| co-seating min shared matches | `3` | Min shared matches to flag a co-seating pair. |
| seat-denial expiry | `86_400_000` ms (24 h) | Temporary ban duration. |

---

## 7. Go service — signed-price-server — port `8080` — tag `config-file`

Source: `services/signed-price-server/config/`. Loaded from a TOML file at `CONFIG_PATH`
(default `config/config.toml`; a `devnet.toml` is provided). Env overrides: `LISTEN_ADDR`,
`LOG_LEVEL`. Signing key via `ECDSA_PRIVATE_KEY` (env). Defaults from `types.go`:

| Section | Key | Default | Purpose |
|---------|-----|---------|---------|
| server | `listen_addr` | `0.0.0.0:8080` | Bind address. |
| server | `read_timeout` / `write_timeout` | `15s` / `15s` | HTTP timeouts. |
| server | `max_connections` | `12000` | Connection cap. |
| server | `read_buffer_size` / `write_buffer_size` | `1024` / `1024` | Socket buffers. |
| server | `shutdown_timeout` | `30s` | Graceful shutdown. |
| signing | `num_workers` | `0` (auto = `NumCPU × 2`) | Signing worker pool size. |
| signing | `trade_queue_size` / `signed_queue_size` | `100000` / `100000` | Pipeline queues. |
| store | `history_capacity` | `100000` | In-memory price history. |
| store | `sqlite_path` | *required* | SQLite persistence path. |
| ws hub | `client_queue_size` / `client_send_buffer_size` | `200000` / `256` | WebSocket fan-out. |
| ws hub | `ping_interval` / `write_timeout` | `30s` / `10s` | WS keepalive. |
| book-mid | `emit_interval_ms` | `45` | BBO heartbeat interval. |
| book-mid | `max_book_age_ms` | `1500` | Max book age before pausing emits. |
| book-mid | `stale_watchdog_interval_ms` / `stale_threshold_ms` / `stale_reconnect_cooldown_ms` | `1000` / `5000` / `30000` | Staleness watchdog + forced reconnect. |
| provider | `provider_timeout` | `100ms` | Upstream provider timeout. |
| logging | `level` / `format` | `info` / `json` | Logging. |
| metrics | `path` | `/metrics` | Metrics endpoint. |
| failover | `enabled` | `false` | Active/standby coordination. |
| failover | `node_id` / `peer_node_id` / `peer_url` | *required if enabled* | Peer identity/endpoint. |
| failover | `shared_secret_env` | `FAILOVER_SHARED_SECRET` | Env var holding the auth secret. |
| failover | `promote_debounce_ms` / `recover_hysteresis_ms` / `peer_request_timeout_ms` / `lease_ttl_ms` / `lease_renew_ms` / `clock_skew_margin_ms` | `100` / `500` / `300` / `1000` / `200` / `500` | Lease & promote/recover timing. |

Configured feed → token-address map (`devnet.toml`, Coinbase provider, `book_mid` mode):
SOL/USD, BTC/USD, ETH/USD → the same addresses as §6e.

---

## 8. Rust libraries — store & timelock — tag `code`

These are libraries (no binary, no env vars of their own); callers inject connections/config.

**`services/store`** — Postgres persistence. No env vars (the caller supplies the DB pool,
e.g. via `DATABASE_URL` in the host service). `GENESIS` chain-root hash = 32 zero bytes;
SQL statements are fixed (lease/outbox/settlement-context queries).

**`services/timelock`** — drand tlock encryption core. Cargo feature flags `net` (live drand
HTTP client) and `tlock` (real BLS12-381 IBE cipher). Default drand base URL
`https://api.drand.sh`, quicknet chain hash
`52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971`, HTTP timeout `5000` ms.
Tunable in code via `HttpBeaconClient::with_timeout_ms(...)` and `SealRegistry::new(round)`.

---

## 9. Deployment & infrastructure config — tag `config-file`

### 9a. `deploy/docker-compose.app.yml`
Service → port mapping (internal → host) and app-wide env defaults.

| Service | Internal | Host |
|---------|----------|------|
| action-feed | 8080 | 18080 |
| gateway | 8081 | 18081 |
| matchmaking | 8082 | 18082 |
| match-engine | 8083 | 18083 |
| settlement-worker | 8084 | 18084 |
| config | 8085 | 18085 |
| match-orchestrator | 8086 | 18086 |
| signed-price-server | 8080 | 127.0.0.1:18088 (internal only) |
| settlement-chain | 8790 | 18790 |

App-wide env defaults set here: `DATABASE_URL` (`postgres://syndicate:syndicate@postgres:5432/syndicate_local`),
`REDIS_URL` (`redis://redis:6379/0`), `NATS_URL` (`nats://nats:4222`),
`OBJECT_STORE_ENDPOINT` (`http://minio:9000`), `PROMETHEUS_URL`, `GRAFANA_URL`,
`SOLANA_RPC_URL_PRIMARY` (`http://host.docker.internal:8899`),
`SETTLEMENT_CHAIN_URL` (`http://settlement-chain:8790`), plus the full settlement-worker
env block (mirrors §5b).

### 9b. Reverse proxy — Caddy & nginx
`deploy/caddy/Caddyfile` and `deploy/nginx/syndicate-devnet.conf` route 4 public domains:

| Domain | Backend | Auth |
|--------|---------|------|
| `gateway.devnet.satoshitable.fun` | 127.0.0.1:18081 | Basic auth |
| `api.devnet.satoshitable.fun` | 127.0.0.1:18080 | Basic auth |
| `config.devnet.satoshitable.fun` | 127.0.0.1:18085 | Basic auth |
| `price.devnet.satoshitable.fun` | 127.0.0.1:18088 | None (public read) |

Basic-auth credentials: `DEVNET_AUTH_USER`, `DEVNET_AUTH_PASS_HASH` (bcrypt). CORS origins:
any-port `localhost` + production `satoshitable.fun`.

### 9c. `docs/deployment/env.example`
The canonical environment-variable template — start here when standing up a new
deployment. Notable blocks: core (`APP_ENV`, `SOLANA_CLUSTER`, `LOG_LEVEL`, DB/Redis/NATS,
`SYNDICATE_PROGRAM_ID`, `CHIPS_TOKEN_MINT`, `PROTOCOL_STATE_PDA`), signed-price
(`ECDSA_PRIVATE_KEY`), the **legacy Pyth** block (set to avoid panic; unused), the drand
block, the settlement-worker block, orchestrator, and monitoring (`OTEL_*`, Prometheus,
Grafana).

---

## 10. Common change recipes (manager quick index)

| I want to… | Change | Notes |
|------------|--------|-------|
| Change the rake | `DEFAULT_RAKE_BPS` in `services/config/src/index.ts` | Three-place sync: also per-match `rake_bps` allowlist + settlement-chain encoder default (§6e). Bound: `<= 10_000`. |
| Change betting time / streets | `roundDurationsSec` / `observationWindowsSec` / `roundCount` in `services/config` | Tier fill windows live in `DEFAULT_FILL_WINDOWS`. |
| Change buy-in tiers | `TIER_BUY_INS` in `services/config` | 6-decimal USDC units. |
| Change the non-sealer penalty | `DEFAULT_NONSEAL_PENALTY_BPS` in `services/config` | Three-place sync (§6e). |
| Add a price feed | `DEFAULT_SUPPORTED_FEEDS` (config) **+** signed-price-server TOML **+** `DEFAULT_PRICE_FEEDS` (settlement-chain) | 3-place sync; all need the secp256k1 token address. |
| Rotate the oracle signer | On-chain `set_price_signer` (config_admin) **+** signed-price-server `ECDSA_PRIVATE_KEY` | Address and key must correspond. |
| Pause new matches / settlement | On-chain `set_pauses` (pause_admin) | Toggles `pause_new_matches` / `pause_settlement`. |
| Change a service port | Service `*_PORT` env **+** docker-compose mapping **+** reverse-proxy backend | Keep all three consistent. |
| Tune settlement retries / confirmation | Worker `SETTLEMENT_RELAY_*` / `SETTLEMENT_POLLER_*` / `SETTLEMENT_CONFIRMATION_TIMEOUT_MS` env | §5b. |
| Change rate limiting | `GATEWAY_RATE_LIMIT_WINDOW_SEC` / `GATEWAY_RATE_LIMIT_MAX` env | §6a. |
| Change anti-abuse thresholds | `DEFAULT_THRESHOLDS` in `services/trust-safety` | `code` change + redeploy. |
| Change priority fee | `SETTLEMENT_COMPUTE_UNIT_PRICE_MICRO_LAMPORTS` env (settlement-chain) | §6d. |
| Change geofence blocklist | `DEFAULT_GEOFENCE_BLOCKLIST` (config) and/or gateway env | ISO country codes. |
| Adjust a void grace window | `SEAL_VOID_GRACE_SEC` / `SETTLE_VOID_GRACE_SEC` in contract | `program-upgrade`. Worker `TIMELOCK_GRACE_SEC` is clamped `>=` the on-chain settle grace. |
