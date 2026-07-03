# 03 — Backend Deployment (VPS: devnet / testnet / mainnet)

> Run as the `deploy` user on the VPS from [02_VPS_SETUP.md](./02_VPS_SETUP.md).
> Contract must be deployed first ([01_CONTRACT_DEPLOYMENT.md](./01_CONTRACT_DEPLOYMENT.md)).

---

## First-time run (checklist)

Use this once on a **fresh VPS + empty Postgres**. Later deploys are §12 (git pull + rebuild).

| Step | Section | Action |
|------|---------|--------|
| 1 | [§0](#0-inputs-from-guide-01) | Copy program id, PDA, RPC, `price_signer`, chips mint, admin keypair from guide 01 |
| 2 | [§2](#2-clone-repository) | Clone repo to `/opt/syndicate/backend` |
| 3 | [§3](#3-secrets) | Create `deploy/secrets/` — `settlement-chain.token`, `settlement-admin-keypair.json`, `chmod` |
| 4 | [§4](#4-environment-file-deploysecretsappenv) | Write `deploy/secrets/app.env` (cluster, program id, `ECDSA_PRIVATE_KEY`, vestigial `PYTH_*`) |
| 5 | [§5](#5-compose-override) | Write `deploy/docker-compose.override.yml` |
| 6 | [§6](#6-compose-helpers) | Export `COMPOSE_APP` and `COMPOSE_INFRA` |
| 7 | [§7](#7-start-infrastructure) | `$COMPOSE_INFRA up -d` — wait for Postgres healthy on **host port 5433** |
| 8 | [§8](#8-database-migrations) | `./scripts/db-migrate-local.sh` — applies **0001–0007** (see below) |
| 9 | [§9](#9-build-and-start-application) | `$COMPOSE_APP build` then `$COMPOSE_APP up -d` (first Rust build: 10–25 min) |
| 10 | [§10](#10-verify) | Curl all `/healthz` endpoints; confirm worker logs `production runtime ready` |
| 11 | [§11](#11-frontend-urls-after-reverse-proxy) | DNS + Caddy ([04_DOMAIN_AND_TLS.md](./04_DOMAIN_AND_TLS.md)) |
| 12 | *(optional)* | E2E from your laptop — see [§10.1](#101-end-to-end-smoke-test-devnet) |

**Match rows (v1, no indexer).** `POST /rooms` writes Postgres `matches` / `match_seats` via
**settlement-worker** (`POST /internal/matches` on port 8084). Compose already wires:

- `matchmaking` → `MATCH_PERSISTENCE_URL=http://settlement-worker:8084`
- `match-orchestrator` → same URL for `begin_live` updates
- `match-engine` → `MATCH_ENGINE_POSTGRES_LEASES=true` (requires a `matches` row before start)

So the first-time path **must** include migrations **0006** (`fill_deadline_ts`, `room_status`, …)
and **0007** (`match_configs.config_hash`). `./scripts/db-migrate-local.sh` runs them after 0001/0002;
do not skip §8.

**One-liner recap** (after §3–§6 are done):

```bash
cd /opt/syndicate/backend
$COMPOSE_INFRA up -d
DATABASE_URL="postgres://syndicate:syndicate@localhost:5433/syndicate_local" ./scripts/db-migrate-local.sh
$COMPOSE_APP build
$COMPOSE_APP up -d
```

---

## 0. Inputs from guide 01

```
SYNDICATE_PROGRAM_ID    8D2Wt3pLyo… if you reused the declared id
PROTOCOL_STATE_PDA
SOLANA_RPC_URL_PRIMARY
SOLANA_CLUSTER          devnet | testnet | mainnet-beta
PRICE_SIGNER_ADDRESS    20-byte ETH address; MUST equal the signed-price-server signing address
CHIPS_TOKEN_MINT        SPL token mint for buy-ins (e.g. devnet USDC)
BUY_IN_MIN/MAX,         match-creation bounds seeded on-chain (guide 01 §8) — the config service
FILL_WINDOW_MIN/MAX_SEC must use the SAME values (see note below)
settlement-admin-keypair.json
```

> **Match-creation bounds (no discrete tiers).** The match creator picks any buy-in / fill-window
> within `[min, max]`. The contract enforces the bounds seeded at `initialize_protocol`; the config
> service enforces the off-chain pre-check via the constants `BUY_IN_MIN/MAX` and
> `FILL_WINDOW_MIN/MAX_SEC` in `services/config/src/index.ts`. These are **compile-time constants**
> (not env vars) — to change the range you edit `index.ts`, rebuild the `config`/`matchmaking`
> images (`$COMPOSE_APP build config matchmaking`), AND run `set_match_bounds` on-chain (guide 01
> §9.1) with the matching values. A mismatch means the off-chain pre-check and on-chain enforcement
> disagree (a create that passes matchmaking can still fail on-chain with `InvalidConfig`).

> **v1 oracle = signed-price-server.** Settlement reads a company-signed price from
> `services/signed-price-server` (Go), reached by `settlement-chain` at `SIGNED_PRICE_SERVER_URL`.
> The contract verifies it against the on-chain `price_signer` you set in guide 01 §8. There is no
> Pyth in the settlement path. The `PYTH_*` vars below are **vestigial boot requirements** (the
> Rust worker still `panic!`s without `PYTH_API_KEY` + `PYTH_RECEIVER_STACK`); keep them set, but
> they do **not** drive v1 settlement. See `docs/V1_COMPLETION_CHECKLIST.md` (cleanup pending).

---

## 1. What gets deployed

**Infra** (`deploy/docker-compose.localnet.yml`): Postgres 16, Redis 7, NATS JetStream, MinIO, Prometheus, Grafana.

**App** (`deploy/docker-compose.app.yml`) — nine services:


| Service             | Port (host)              | Health     |
| ------------------- | ------------------------ | ---------- |
| gateway             | 18081 (+19081 metrics)   | `/healthz` |
| matchmaking         | 18082                    | `/healthz` |
| action-feed         | 18080                    | `/healthz` |
| match-engine        | 18083                    | `/healthz` |
| match-orchestrator  | 18086                    | `/healthz` |
| config              | 18085                    | `/healthz` |
| settlement-chain    | 18790                    | `/health`  |
| settlement-worker   | 18084                    | `/healthz` |
| signed-price-server | **127.0.0.1:18088** only | `/health`  |


**Oracle (`signed-price-server`, Go):** now a compose service. It joins the shared network so
`settlement-chain` reaches it by internal DNS (`http://signed-price-server:8080`, hardcoded in the
compose file). It is **not** published on the generic host `:8080` (avoids clashing with other
services on the VPS and keeps it off the public internet); only a **loopback** port `127.0.0.1:18088`
is published, for the Caddy reverse proxy (`price.devnet.*`, guide 04). It needs `ECDSA_PRIVATE_KEY`
(§4) whose address equals the on-chain `price_signer`.

Block public access to these ports at the Hetzner Cloud Firewall (SSH + 80/443 only). Services bind on the Docker host; use a reverse proxy later for gateway / action-feed / signed-price feed.

---

## 2. Clone repository

```bash
cd /opt/syndicate
# EDIT: repository URL
git clone <REPO_URL> backend
cd backend
```

---

## 3. Secrets

```bash
mkdir -p deploy/secrets
chmod 700 deploy/secrets

openssl rand -hex 32 > deploy/secrets/settlement-chain.token

# Copy settlement-admin-keypair.json from guide 01:
# scp ~/settlement-admin-keypair.json deploy@<SERVER_IP>:/opt/syndicate/backend/deploy/secrets/

# Docker: settlement-worker runs as non-root `syndicate`. The host directory must be
# traversable (execute bit) and secret files world-readable.
chmod 755 deploy/secrets
chmod 644 deploy/secrets/settlement-chain.token deploy/secrets/settlement-admin-keypair.json
ls -l deploy/secrets/settlement-admin-keypair.json
```

---

## 4. Environment file (`deploy/secrets/app.env`)

Create **one** file for your cluster. Do not edit `docs/deployment/env.example` — Compose loads it as defaults; `app.env` + override win.

### 4.1 Devnet or testnet

```bash
cat > deploy/secrets/app.env <<'EOF'
APP_ENV=devnet
SOLANA_CLUSTER=devnet
SYNDICATE_PROGRAM_ID=6mmD3xZhgJ33RzHgXWeFSdLG8Ygpy2camFWtDmdmKM7d
PROTOCOL_STATE_PDA=GXJvqNTi3HGurTtsYk7G9eE4Qe9p4KjGc8qrtaV6ZsaM
CHIPS_TOKEN_MINT=4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU
SOLANA_RPC_URL_PRIMARY=https://api.devnet.solana.com
SOLANA_RPC_URL_SECONDARY=

# v1 oracle: signed-price-server runs as a compose service; settlement-chain reaches it by
# internal DNS (hardcoded in docker-compose.app.yml). You only set its signing key here.
# ECDSA_PRIVATE_KEY's Ethereum address MUST equal the on-chain price_signer (guide 01 §8/§9).
# NEVER commit a real key here — this is a tracked template. Put the real value only in
# deploy/secrets/app.env (gitignored). Treat any key pasted into a tracked file as compromised.
ECDSA_PRIVATE_KEY=0xf813cd2b4ee5a97379ec6d5319110e7365ca38b9fac2234b3db33f36ac3e155c

# Vestigial Pyth boot requirements — NOT used for v1 settlement, but the Rust worker
# panics at boot without them. Keep set; any non-empty PYTH_API_KEY is fine on devnet.
PYTH_RECEIVER_STACK=legacy
PYTH_HERMES_URL=https://hermes.pyth.network
PYTH_API_KEY=unused-devnet-placeholder
EOF
```

For **testnet**, set `SOLANA_CLUSTER=testnet`, `APP_ENV=testnet`, and
`SOLANA_RPC_URL_PRIMARY=https://api.testnet.solana.com`.

```bash
nano deploy/secrets/app.env   # replace all REPLACE_ME values
```

> The devnet `signed-price-server` config (`services/signed-price-server/config/devnet.toml`,
> mounted by the compose service) has a fixed `[signing].address`. Either set `ECDSA_PRIVATE_KEY` to
> the key for that address, or generate a fresh key, derive its address, and set it on-chain with
> `set_price_signer` (guide 01 §9). A mismatch makes the contract reject settlement
> (`InvalidOracleProof`).

### 4.2 Mainnet-beta

```bash
cat > deploy/secrets/app.env <<'EOF'
APP_ENV=mainnet
SOLANA_CLUSTER=mainnet-beta
SYNDICATE_PROGRAM_ID=GhbHLYTHuSvCVhYM22wyjdoE6Nx5uQDNuBB2Wof4p2bF
PROTOCOL_STATE_PDA=7c6RkHEjeCJC1Z6dG5ttotxYmpiR6PAKSLn8iYf3D3mH
CHIPS_TOKEN_MINT=4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU
SOLANA_RPC_URL_PRIMARY=https://api.devnet.solana.com
SOLANA_RPC_URL_SECONDARY=

# v1 oracle: production signed-price-server signing key (address == on-chain price_signer).
# Mount your production [signing] config over the compose service's config (see §1 / docker-compose).
ECDSA_PRIVATE_KEY=REPLACE_ME

# Vestigial Pyth boot requirements (not used for settlement; worker panics without them).
PYTH_RECEIVER_STACK=legacy
PYTH_HERMES_URL=https://hermes.pyth.network
PYTH_API_KEY=unused-placeholder

DRAND_API=https://api.drand.sh
DRAND_CHAIN_HASH=52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971
DRAND_EXPECTED_SCHEME_ID=bls-unchained-g1-rfc9380
EOF
nano deploy/secrets/app.env
```

Use a **paid RPC** with failover on `SOLANA_RPC_URL_SECONDARY`. For mainnet, mount a production
signed-price-server config (real exchange feed + `[signing].address`) over the compose service's
`/app/config/config.toml`, and keep `ECDSA_PRIVATE_KEY` in host secrets only.

---

## 5. Compose override

```bash
cat > deploy/docker-compose.override.yml <<'EOF'
x-cluster-env: &cluster-env
  APP_ENV: ${APP_ENV}
  SOLANA_CLUSTER: ${SOLANA_CLUSTER}
  SYNDICATE_PROGRAM_ID: ${SYNDICATE_PROGRAM_ID}
  PROTOCOL_STATE_PDA: ${PROTOCOL_STATE_PDA}
  CHIPS_TOKEN_MINT: ${CHIPS_TOKEN_MINT}
  SOLANA_RPC_URL_PRIMARY: ${SOLANA_RPC_URL_PRIMARY}
  SOLANA_RPC_URL_SECONDARY: ${SOLANA_RPC_URL_SECONDARY}
  # NOTE: SIGNED_PRICE_SERVER_URL is hardcoded to the internal service DNS in
  # docker-compose.app.yml (settlement-chain → http://signed-price-server:8080). Do NOT add it
  # here — an empty override would clobber it. Set ECDSA_PRIVATE_KEY in app.env instead.
  # Vestigial Pyth boot requirements (not used for settlement; worker panics without them).
  PYTH_RECEIVER_STACK: ${PYTH_RECEIVER_STACK}
  PYTH_HERMES_URL: ${PYTH_HERMES_URL}
  PYTH_API_KEY: ${PYTH_API_KEY}
  PYTH_RECEIVER_PROGRAM_ID: ${PYTH_RECEIVER_PROGRAM_ID:-}
  PYTH_WORMHOLE_PROGRAM_ID: ${PYTH_WORMHOLE_PROGRAM_ID:-}
  PYTH_PUSH_ORACLE_PROGRAM_ID: ${PYTH_PUSH_ORACLE_PROGRAM_ID:-}

services:
  gateway:
    restart: unless-stopped
  matchmaking:
    restart: unless-stopped
  action-feed:
    restart: unless-stopped
  match-engine:
    restart: unless-stopped
  config:
    restart: unless-stopped
  # Oracle. Only needs the restart policy — it reads ECDSA_PRIVATE_KEY from app.env via the base
  # compose, and does NOT consume the Solana/Pyth cluster-env (do not add <<: *cluster-env here).
  signed-price-server:
    restart: unless-stopped
  match-orchestrator:
    restart: unless-stopped
    environment:
      <<: *cluster-env
  settlement-chain:
    restart: unless-stopped
    environment:
      <<: *cluster-env
  settlement-worker:
    restart: unless-stopped
    environment:
      <<: *cluster-env
      SETTLEMENT_WORKER_MODE: production
EOF
```

---

## 6. Compose helpers

```bash
export COMPOSE_APP="docker compose --env-file deploy/secrets/app.env -f deploy/docker-compose.app.yml -f deploy/docker-compose.override.yml"
export COMPOSE_INFRA="docker compose -f deploy/docker-compose.localnet.yml"
```

Re-run these exports in every new shell.

---

## 7. Start infrastructure

Postgres is published on **host port 5433** (not 5432) so it can run alongside a system Postgres. Other infra host ports are also offset to avoid clashes on a shared VPS:


| Service    | Host port | UI / notes                           |
| ---------- | --------- | ------------------------------------ |
| Postgres   | 5433      | migrations from host                 |
| Redis      | 6380      |                                      |
| NATS       | 4223      | monitor 8223                         |
| MinIO      | 9002      | console 9003                         |
| Prometheus | 9091      | [http://HOST:9091](http://HOST:9091) |
| Grafana    | 3002      | admin / syndicate-localnet           |


App containers use internal names (`postgres:5432`, `redis:6379`, …) and are unaffected.

```bash
$COMPOSE_INFRA down 2>/dev/null || true
$COMPOSE_INFRA up -d
watch -n 3 'docker ps --format "table {{.Names}}\t{{.Status}}" | grep syndicate-localnet'
# Ctrl+C when postgres, redis, nats show (healthy)

# App containers join this network and resolve postgres, redis, nats by service name.
docker network inspect syndicate-localnet_default -f '{{range .Containers}}{{.Name}} {{end}}' | tr ' ' '\n' | grep localnet
```

---

## 8. Database migrations

**First-time:** run `./scripts/db-migrate-local.sh` once on an empty database. It applies:

| Script / step | Migrations | Purpose |
|---------------|------------|---------|
| `db-migrate-local.sh` (first half) | `0001_production_persistence.sql`, `0002_settlement_queue.sql` | Base schema (matches, match_configs, settlement queue) |
| `db-migrate-incremental.sh` (called automatically) | `0003`–`0007` | Signed intents, profile metadata, **match lifecycle columns (0006)**, **config_hash (0007)** |

Migrations **0001** and **0002** are **not idempotent** — the runner stops on first error
(`ON_ERROR_STOP=1`). Incremental **0003–0007** use `IF NOT EXISTS` / `DO` blocks where possible
and are safe to re-run on an existing DB that already has 0001/0002.

The Docker Postgres is on host port **5433** (not 5432). Always pass `-p 5433` when using `psql`
from the host; omitting it hits a different/absent Postgres (`password authentication failed`).

```bash
DATABASE_URL="postgres://syndicate:syndicate@localhost:5433/syndicate_local" \
  ./scripts/db-migrate-local.sh

PGPASSWORD=syndicate psql -h 127.0.0.1 -p 5433 -U syndicate -d syndicate_local -c '\dt' | head

# Confirm lifecycle + config_hash columns exist (required for POST /rooms).
PGPASSWORD=syndicate psql -h 127.0.0.1 -p 5433 -U syndicate -d syndicate_local -c \
  "SELECT column_name FROM information_schema.columns
   WHERE table_name = 'matches' AND column_name IN ('fill_deadline_ts','room_status');"
PGPASSWORD=syndicate psql -h 127.0.0.1 -p 5433 -U syndicate -d syndicate_local -c \
  "SELECT column_name FROM information_schema.columns
   WHERE table_name = 'match_configs' AND column_name = 'config_hash';"
```

**Upgrading an older DB** (already ran 0001/0002 before this guide): run only the incremental
script — do **not** re-apply 0001/0002:

```bash
DATABASE_URL="postgres://syndicate:syndicate@localhost:5433/syndicate_local" \
  ./scripts/db-migrate-incremental.sh
```

> **Re-running 0001 fails with `type "match_status" already exists`?** A previous run partially
> applied the base schema. On a fresh DB (no real data) reset and re-run:
>
> ```bash
> PGPASSWORD=syndicate psql -h 127.0.0.1 -p 5433 -U syndicate -d syndicate_local \
>   -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;"
> DATABASE_URL="postgres://syndicate:syndicate@localhost:5433/syndicate_local" ./scripts/db-migrate-local.sh
> ```
>
> Or wipe the volume entirely: `$COMPOSE_INFRA down -v && $COMPOSE_INFRA up -d` (destroys all infra data).

---

## 9. Build and start application

First build: **10–25 minutes** (Rust compile). Ensure swap is enabled on ≤4 GB RAM hosts (guide 02 §9).

Node services (including `settlement-chain`) build on **Node 24** in Docker — required by the
service lockfiles (npm 11). After `git pull`, rebuild if you previously failed on `npm ci` /
`rpc-websockets` under Node 22.

```bash
$COMPOSE_APP build
$COMPOSE_APP up -d
docker ps --format "table {{.Names}}\t{{.Status}}" | grep syndicate-app

# App must share syndicate-localnet_default with infra (do not pass docker-compose.localnet.yml here).
docker exec syndicate-app-action-feed-1 getent hosts postgres
```

### 9.1 The signed-price-server (oracle)

It is part of `$COMPOSE_APP` (the `signed-price-server` service) — `$COMPOSE_APP build` and
`up -d` above already built and started it. `settlement-chain` reaches it by internal DNS; the only
host binding is the loopback `127.0.0.1:18088` used by Caddy (guide 04). Verify it directly:

```bash
curl -s http://127.0.0.1:18088/health | jq .   # top-level "ok": true once the book is fresh
docker logs $(docker ps -qf name=signed-price-server) 2>&1 | tail -n 10
```

If `ECDSA_PRIVATE_KEY` is unset the container exits at boot (`ECDSA_PRIVATE_KEY environment
variable not set`) — set it in `app.env` (§4) and `$COMPOSE_APP up -d signed-price-server`.

> The mounted `config/devnet.toml` `[signing].address` is the address the contract's `price_signer`
> must equal. If you set a fresh `ECDSA_PRIVATE_KEY`, derive its address and update it on-chain via
> guide 01 §9 (`set_price_signer`). To run a different feed config, change the volume mount on the
> `signed-price-server` service in `deploy/docker-compose.app.yml`.

Confirm `SIGNED_PRICE_SERVER_URL` in `app.env` resolves to this server from inside the app
containers (e.g. `http://host.docker.internal:8080`).

---

## 10. Verify

```bash
echo "gateway:";           curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:18081/healthz
echo "matchmaking:";      curl -s http://127.0.0.1:18082/healthz; echo
echo "action-feed:";      curl -s http://127.0.0.1:18080/healthz; echo
echo "match-engine:";     curl -s http://127.0.0.1:18083/healthz; echo
echo "match-orchestrator:"; curl -s http://127.0.0.1:18086/healthz; echo
echo "settlement-chain:"; curl -s http://127.0.0.1:18790/health | jq .
echo "settlement-worker:"; curl -s http://127.0.0.1:18084/healthz; echo
echo "signed-price-server:"; curl -s http://127.0.0.1:18088/health | jq .
```

`settlement-chain` `/health` must show your `programId`. The `signed-price-server` `/health` must
report top-level `"ok": true` (book fresh) — settlement fails closed (`VOID`) if the signed price
is unavailable at `scheduled_end_ts`.

```bash
docker logs $(docker ps -qf name=settlement-worker) 2>&1 | tail -n 20
# Expect: production runtime ready
# Expect: settlement-worker http listening on http://0.0.0.0:8084
```

### 10.1 End-to-end smoke test (devnet)

After §11 (reverse proxy) or against loopback ports, run the lifecycle script from a machine with
Solana CLI + player keypairs. It exercises create → `POST /rooms` → deposit → seal → `begin_live` →
match-engine start.

```bash
# From repo root on your laptop (not the VPS)
export BASIC_AUTH="dev:yourpassword"          # nginx basic auth for *.devnet.satoshitable.fun
export PLAYER2_KEYPAIR=/path/to/player2.json
export MATCHMAKING_URL=https://matchmaking.devnet.satoshitable.fun
export GATEWAY_URL=wss://gateway.devnet.satoshitable.fun
./scripts/run-e2e-devnet.sh
```

If **Step 2 (`POST /rooms`)** fails with `match persistence failed`:

1. On the VPS: confirm migrations 0006/0007 (§8 verification queries).
2. Rebuild worker: `$COMPOSE_APP build --no-cache settlement-worker && $COMPOSE_APP up -d settlement-worker`.
3. See troubleshooting row for `error serializing parameter 3` (§13).

---

## 11. Frontend URLs (after reverse proxy)

Wire the domain in [04_DOMAIN_AND_TLS.md](./04_DOMAIN_AND_TLS.md). Devnet handoff:


| Key                | Devnet value                             |
| ------------------ | ---------------------------------------- |
| `GATEWAY_WS_URL`   | `wss://gateway.devnet.satoshitable.fun`  |
| `ACTION_FEED_URL`  | `https://api.devnet.satoshitable.fun`    |
| `MATCHMAKING`      | `https://matchmaking.devnet.satoshitable.fun`|
| `CONFIG_URL`       | `https://config.devnet.satoshitable.fun` |
| `PROGRAM_ID`       | from `app.env`                           |
| `CHIPS_TOKEN_MINT` | from `app.env`                           |
| `SOLANA_RPC_URL`   | public RPC or client-side provider       |


Full wire protocol: [../frontend/INTEGRATION_GUIDE.md](../frontend/INTEGRATION_GUIDE.md)

---

## 12. Day-2 operations

```bash
# Logs
docker logs -f $(docker ps -qf name=settlement-chain)

# Update (after git pull — rebuild services whose code changed)
git pull
$COMPOSE_APP build
$COMPOSE_APP up -d

# Schema upgrades only (DB already has 0001/0002; new incremental migrations added)
DATABASE_URL="postgres://syndicate:syndicate@localhost:5433/syndicate_local" \
  ./scripts/db-migrate-incremental.sh

# Stop (data preserved)
$COMPOSE_APP down
$COMPOSE_INFRA down

# DESTRUCTIVE reset
$COMPOSE_APP down && $COMPOSE_INFRA down -v
```

---

## 13. Troubleshooting


| Symptom                                                                | Fix                                                                                                                                                                                                                           |
| ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX` / parameter property               | `git pull` (matchmaking fix); rebuild: `$COMPOSE_APP build matchmaking`                                                                                                                                                       |
| `RpcWebSocketClient extends value undefined` (settlement-chain)        | `git pull` (removed bad `rpc-websockets` override in lockfile); `$COMPOSE_APP build --no-cache settlement-chain`                                                                                                              |
| Worker: `Permission denied` reading `SETTLEMENT_CHAIN_AUTH_TOKEN_FILE` | `chmod 755 deploy/secrets` and `chmod 644 deploy/secrets/settlement-chain.token deploy/secrets/settlement-admin-keypair.json` (§3)                                                                                            |
| `could not translate host name "postgres"`                             | Infra not running or app not on shared network: `$COMPOSE_INFRA up -d`, then `$COMPOSE_APP up -d` **without** `-f deploy/docker-compose.localnet.yml`; verify `docker exec syndicate-app-action-feed-1 getent hosts postgres` |
| `Bind for 0.0.0.0:9091 failed: port is already allocated`              | Infra already running — start app with `$COMPOSE_APP` only, not app+localnet merged                                                                                                                                           |
| Worker restarts: `settlement-chain health check failed`                | Wait for chain startup; `curl 127.0.0.1:18790/health`                                                                                                                                                                         |
| Worker: `missing required environment variable`                        | Fill `deploy/secrets/app.env`; re-export `COMPOSE_APP`                                                                                                                                                                        |
| `settlement relay/poller error: error serializing parameter`           | `git pull` (LIMIT batch size must be `i64`); `$COMPOSE_APP build --no-cache settlement-worker`                                                                                                                                |
| `POST /rooms` → `INSERT_MATCH: error serializing parameter 2` | `git pull` (`config_id` must bind as `uuid::Uuid`, not `&str`, for `matches.config_id uuid`); `$COMPOSE_APP build --no-cache settlement-worker && $COMPOSE_APP up -d settlement-worker` |
| `POST /rooms` → `match persistence failed` / `error serializing parameter 3` (INSERT_MATCH_CONFIG) | On first deploy: run §8 migrations (0006+0007). Then `git pull` (match-registry `oracle_exponent` must bind as `i16` for `match_configs.oracle_exponent smallint`); `$COMPOSE_APP build --no-cache settlement-worker && $COMPOSE_APP up -d settlement-worker`. Confirm matchmaking has `MATCH_PERSISTENCE_URL=http://settlement-worker:8084` (default in compose). |
| `POST /rooms` → `column "fill_deadline_ts" does not exist` (or `config_hash`) | Run `./scripts/db-migrate-incremental.sh` against the VPS Postgres (§8); restart app stack. |
| `match-engine start` → `match not found for protocol match id` | `matches` row missing — `POST /rooms` persistence failed earlier, or `MATCH_PERSISTENCE_URL` unset / worker down. Fix persistence first (§10.1). |
| Wrong programId on `/health`                                           | Fix `SYNDICATE_PROGRAM_ID` in `app.env`; `$COMPOSE_APP up -d`                                                                                                                                                                 |
| Worker panics: `missing PYTH_API_KEY or PYTH_API_KEY_FILE`             | Vestigial boot requirement — set any non-empty `PYTH_API_KEY` and `PYTH_RECEIVER_STACK=legacy` in `app.env` (§4). Not used for v1 settlement.                                                                                 |
| Settlement always `VOID` / `signed price unavailable`                  | signed-price-server down or book stale: `curl 127.0.0.1:18088/health` (`"ok": true`); `docker logs` the `signed-price-server` service. settlement-chain reaches it at the internal DNS `http://signed-price-server:8080` (do not change to `127.0.0.1`). |
| `signed-price-server` container keeps exiting                          | `ECDSA_PRIVATE_KEY` unset/invalid — set it in `app.env` (§4); `$COMPOSE_APP up -d signed-price-server`. |
| Settlement rejected: `InvalidOracleProof`                              | On-chain `price_signer` ≠ the signed-price-server signing address. Re-run guide 01 §9 (`set_price_signer`) with the server's `[signing].address`.                                                                             |
| `create_match` fails `InvalidConfig` for an in-UI buy-in / fill-window | On-chain bounds ≠ config-service constants. Align `BUY_IN_MIN/MAX` + `FILL_WINDOW_MIN/MAX_SEC` (`services/config/src/index.ts`) with the on-chain bounds via guide 01 §9.1 (`set_match_bounds`), then rebuild config/matchmaking. |
| OOM during build                                                       | Add swap (guide 02 §9); rebuild                                                                                                                                                                                               |
| `network syndicate-localnet_default not found`                         | Run `$COMPOSE_INFRA up -d` first                                                                                                                                                                                              |


---

## 14. Done

When §10 passes, the backend is live against your on-chain program. Next: [04_DOMAIN_AND_TLS.md](./04_DOMAIN_AND_TLS.md) (DNS + HTTPS for satoshitable.fun), rotate Grafana password.

See also [README.md](./README.md) · [SECRETS_AND_KEYS.md](./SECRETS_AND_KEYS.md)