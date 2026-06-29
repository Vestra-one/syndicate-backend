# 03 — Backend Deployment (VPS: devnet / testnet / mainnet)

> Run as the `deploy` user on the VPS from [02_VPS_SETUP.md](./02_VPS_SETUP.md).
> Contract must be deployed first ([01_CONTRACT_DEPLOYMENT.md](./01_CONTRACT_DEPLOYMENT.md)).

---

## 0. Inputs from guide 01

```
SYNDICATE_PROGRAM_ID
PROTOCOL_STATE_PDA
SOLANA_RPC_URL_PRIMARY
SOLANA_CLUSTER          devnet | testnet | mainnet-beta
PYTH_RECEIVER_STACK     legacy (devnet/testnet) | upgraded (mainnet)
PYTH_API_KEY
CHIPS_TOKEN_MINT        SPL token mint for buy-ins (e.g. devnet USDC)
settlement-admin-keypair.json
```

---

## 1. What gets deployed

**Infra** (`deploy/docker-compose.localnet.yml`): Postgres 16, Redis 7, NATS JetStream, MinIO, Prometheus, Grafana.

**App** (`deploy/docker-compose.app.yml`):


| Service            | Port (host)            | Health     |
| ------------------ | ---------------------- | ---------- |
| gateway            | 18081 (+19081 metrics) | `/healthz` |
| matchmaking        | 18082                  | `/healthz` |
| action-feed        | 18080                  | `/healthz` |
| match-engine       | 18083                  | `/healthz` |
| match-orchestrator | 18086                  | `/healthz` |
| config             | 18085                  | `/healthz` |
| settlement-chain   | 18790                  | `/health`  |
| settlement-worker  | 18084                  | `/healthz` |


Block public access to these ports at the Hetzner Cloud Firewall (SSH + 80/443 only). Services bind on the Docker host; use a reverse proxy later for gateway/action-feed.

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
SYNDICATE_PROGRAM_ID=REPLACE_ME
PROTOCOL_STATE_PDA=REPLACE_ME
CHIPS_TOKEN_MINT=REPLACE_ME
SOLANA_RPC_URL_PRIMARY=https://api.devnet.solana.com
SOLANA_RPC_URL_SECONDARY=
PYTH_RECEIVER_STACK=legacy
PYTH_HERMES_URL=https://hermes.pyth.network
PYTH_API_KEY=REPLACE_ME
EOF
```

For **testnet**, set `SOLANA_CLUSTER=testnet`, `APP_ENV=testnet`, and
`SOLANA_RPC_URL_PRIMARY=https://api.testnet.solana.com`.

```bash
nano deploy/secrets/app.env   # replace all REPLACE_ME values
```

> With `PYTH_RECEIVER_STACK=legacy`, settlement-chain resolves Pyth receiver/wormhole/push ids
> from `services/settlement-chain/pyth-stack.json`. You do **not** need to set the three
> `PYTH_*_PROGRAM_ID` vars unless overriding.

### 4.2 Mainnet-beta

```bash
cat > deploy/secrets/app.env <<'EOF'
APP_ENV=mainnet
SOLANA_CLUSTER=mainnet-beta
SYNDICATE_PROGRAM_ID=REPLACE_ME
PROTOCOL_STATE_PDA=REPLACE_ME
CHIPS_TOKEN_MINT=REPLACE_ME
SOLANA_RPC_URL_PRIMARY=REPLACE_ME
SOLANA_RPC_URL_SECONDARY=REPLACE_ME
PYTH_RECEIVER_STACK=upgraded
PYTH_HERMES_URL=https://pyth.dourolabs.app/hermes
PYTH_API_KEY=REPLACE_ME
DRAND_API=https://api.drand.sh
DRAND_CHAIN_HASH=52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971
DRAND_EXPECTED_SCHEME_ID=bls-unchained-g1-rfc9380
EOF
nano deploy/secrets/app.env
```

Use a **paid RPC** with failover on `SOLANA_RPC_URL_SECONDARY`. Rotate `PYTH_API_KEY` via host secrets only.

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

```bash
DATABASE_URL="postgres://syndicate:syndicate@localhost:5433/syndicate_local" \
  ./scripts/db-migrate-local.sh

PGPASSWORD=syndicate psql -h localhost -U syndicate -d syndicate_local -c '\dt' | head
```

---

## 9. Build and start application

First build: **10–25 minutes** (Rust compile). Ensure swap is enabled on ≤4 GB RAM hosts (guide 02 §9).

Node services (including `settlement-chain`) build on **Node 24** in Docker — required by `@pythnetwork/hermes-client` and a lockfile generated with npm 11. After `git pull`, rebuild if you previously failed on `npm ci` / `rpc-websockets` under Node 22.

```bash
$COMPOSE_APP build
$COMPOSE_APP up -d
docker ps --format "table {{.Names}}\t{{.Status}}" | grep syndicate-app

# App must share syndicate-localnet_default with infra (do not pass docker-compose.localnet.yml here).
docker exec syndicate-app-action-feed-1 getent hosts postgres
```

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
```

`settlement-chain` `/health` must show your `programId`, `pythStack`, `hermesUrl`, and receiver ids.

```bash
docker logs $(docker ps -qf name=settlement-worker) 2>&1 | tail -n 20
# Expect: production runtime ready
```

---

## 11. Frontend URLs (after reverse proxy)

Wire the domain in [04_DOMAIN_AND_TLS.md](./04_DOMAIN_AND_TLS.md). Devnet handoff:


| Key                | Devnet value                             |
| ------------------ | ---------------------------------------- |
| `GATEWAY_WS_URL`   | `wss://gateway.devnet.satoshitable.fun`  |
| `ACTION_FEED_URL`  | `https://api.devnet.satoshitable.fun`    |
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

# Update
git pull
$COMPOSE_APP build
$COMPOSE_APP up -d

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
| Wrong programId on `/health`                                           | Fix `SYNDICATE_PROGRAM_ID` in `app.env`; `$COMPOSE_APP up -d`                                                                                                                                                                 |
| Pyth settlement fails on devnet                                        | Keep `PYTH_RECEIVER_STACK=legacy`; do **not** use `upgraded` on devnet                                                                                                                                                        |
| OOM during build                                                       | Add swap (guide 02 §9); rebuild                                                                                                                                                                                               |
| `network syndicate-localnet_default not found`                         | Run `$COMPOSE_INFRA up -d` first                                                                                                                                                                                              |


---

## 14. Done

When §10 passes, the backend is live against your on-chain program. Next: [04_DOMAIN_AND_TLS.md](./04_DOMAIN_AND_TLS.md) (DNS + HTTPS for satoshitable.fun), rotate Grafana password.

See also [README.md](./README.md) · [SECRETS_AND_KEYS.md](./SECRETS_AND_KEYS.md)