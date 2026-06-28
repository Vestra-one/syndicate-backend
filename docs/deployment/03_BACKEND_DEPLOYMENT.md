# 03 — Backend Deployment (from scratch, on the VPS)

> Audience: an operator who can copy/paste and run commands. This guide deploys the
> **entire backend** to the VPS prepared in guide `02`, pointing settlement at the program
> deployed in guide `01`. It uses **Docker Compose**, which builds and runs every service.
> Run every step in order, as the `deploy` user.

## What this deploys (established by reading the code)

Two Compose stacks in `deploy/`:

- **Infra stack** (`deploy/docker-compose.localnet.yml`): Postgres 16, Redis 7, NATS 2.10
  (JetStream), MinIO, Prometheus, Grafana. It creates the shared Docker network
  `syndicate-localnet_default`.
- **App stack** (`deploy/docker-compose.app.yml`): the six backend services —
  `gateway`, `matchmaking`, `action-feed`, `match-engine`, `settlement-chain`,
  `settlement-worker`. It attaches to the infra network.

| Service | Type | In‑container port | Published on host (127.0.0.1) | Health |
| --- | --- | --- | --- | --- |
| gateway | Node | 8081 (+9081 metrics) | 18081, 19081 | `GET /healthz` |
| matchmaking | Node | 8082 | 18082 | `GET /healthz` |
| action-feed | Node | 8080 | 18080 | `GET /healthz` |
| match-engine | Rust | 8083 | 18083 | `GET /healthz` |
| settlement-chain | Node | 8790 | 18790 | `GET /health` |
| settlement-worker | Rust | 8084 | 18084 | `GET /healthz` |

> Notes from the code: `action-feed` stores replays on a **filesystem** volume
> (`ACTION_FEED_OBJECT_STORE_DIR`), so MinIO is started but **not required** by the running
> code. `settlement-worker` runs in **production mode** (set in the app compose) and at
> startup it (a) requires several env vars, (b) reads two secret files, and (c) makes a health
> request to `settlement-chain` — so secrets and the settlement‑chain service must be correct.

---

## 0. Inputs you must have ready

From guide `01` (contract):

```
SYNDICATE_PROGRAM_ID         = <...>
PYTH_RECEIVER_PROGRAM_ID     = <...>
PYTH_WORMHOLE_PROGRAM_ID     = <...>
PYTH_PUSH_ORACLE_PROGRAM_ID  = <...>
settlement-admin-keypair.json  (the file)
```

A devnet RPC URL. The public one works to start: `https://api.devnet.solana.com`. For
production load, use a dedicated provider URL (Helius/Triton/QuickNode devnet).

---

## 1. Restrict inbound traffic at the Hetzner Cloud Firewall

Docker publishes ports by inserting its own iptables rules that **bypass UFW**. The reliable
way to keep backend ports private is the **network‑level Hetzner Cloud Firewall**:

1. In the Hetzner Cloud Console → **Firewalls** → create a firewall and attach it to this
   server.
2. Inbound rules — allow only:
   - TCP **22** (SSH)
   - TCP **80** and **443** (for a future reverse proxy / TLS)
3. Do **not** add inbound rules for ports `18080–18084`, `18790`, `19081`, `5432`, `6379`,
   `4222`, `9000`, `9090`, `3001`. They stay reachable only from the server itself
   (`127.0.0.1`) for diagnostics, and later through your reverse proxy.

> Public exposure of `gateway` (WebSocket) and `action-feed` (read API) should be done later
> through a reverse proxy (nginx/Caddy) terminating TLS on 443. That is out of scope here;
> this guide gets the backend running and healthy.

---

## 2. Clone the repository

```bash
cd /opt/syndicate
# EDIT: replace with the actual repository URL you were given.
git clone <REPO_URL> backend
cd backend
```

All remaining commands run from `/opt/syndicate/backend` (the repo root) unless stated.

---

## 3. Place the secrets

The app compose mounts `deploy/secrets/` into the `settlement-chain` and `settlement-worker`
containers at `/etc/syndicate` (read‑only). The env file expects two files there:
`settlement-chain.token` and `settlement-admin-keypair.json`.

```bash
mkdir -p deploy/secrets
chmod 700 deploy/secrets

# 3.1 A shared auth token: the gateway/worker authenticate to settlement-chain with this.
#     Generate a strong random value:
openssl rand -hex 32 > deploy/secrets/settlement-chain.token

# 3.2 The settlement signer keypair from guide 01.
#     Copy the file you transferred from guide 01 to this exact path:
#     (example using scp from your laptop:
#       scp settlement-admin-keypair.json deploy@<SERVER_IP>:/opt/syndicate/backend/deploy/secrets/ )
ls -l deploy/secrets/settlement-admin-keypair.json   # must exist and be a 64-number JSON array

chmod 600 deploy/secrets/settlement-chain.token deploy/secrets/settlement-admin-keypair.json
```

> The settlement keypair’s public key MUST be the `settlement_admin` / `emergency_void_admin`
> set during guide `01`, Step 8. If it is not, settlement transactions will be rejected
> on‑chain.

---

## 4. Create the devnet environment overrides

The committed `docs/deployment/env.example` (which the app stack loads) contains **localnet
placeholders** and a hard‑coded local Solana RPC. You will **not** edit that file. Instead you
create two small files that override only the values that must change for devnet.

### 4.1 The interpolation env file

```bash
cat > deploy/secrets/app.env <<EOF
SYNDICATE_PROGRAM_ID=${SYNDICATE_PROGRAM_ID:-REPLACE_ME}
SOLANA_RPC_URL_PRIMARY=https://api.devnet.solana.com
SOLANA_RPC_URL_SECONDARY=
PYTH_HERMES_URL=https://hermes.pyth.network
PYTH_API_KEY=devnet-placeholder
PYTH_RECEIVER_PROGRAM_ID=${PYTH_RECEIVER_PROGRAM_ID:-REPLACE_ME}
PYTH_WORMHOLE_PROGRAM_ID=${PYTH_WORMHOLE_PROGRAM_ID:-REPLACE_ME}
PYTH_PUSH_ORACLE_PROGRAM_ID=${PYTH_PUSH_ORACLE_PROGRAM_ID:-REPLACE_ME}
EOF

# Now open the file and replace any REPLACE_ME with the real values from guide 01:
nano deploy/secrets/app.env   # (or: vi)
```

Notes:
- `PYTH_HERMES_URL=https://hermes.pyth.network` is the public Pyth endpoint; it ignores the
  `Authorization` header, so any non‑empty `PYTH_API_KEY` works. If you were given a keyed
  Hermes provider (e.g. Dourolabs), set its URL and the real key here instead.
- `SOLANA_RPC_URL_SECONDARY` is optional; leave blank unless you have a second RPC.

### 4.2 The Compose override file

This injects the devnet values into the two services that need them and adds a restart policy
so services recover after a crash or reboot.

```bash
cat > deploy/docker-compose.override.yml <<'EOF'
x-devnet-env: &devnet-env
  SYNDICATE_PROGRAM_ID: ${SYNDICATE_PROGRAM_ID}
  SOLANA_RPC_URL_PRIMARY: ${SOLANA_RPC_URL_PRIMARY}
  SOLANA_RPC_URL_SECONDARY: ${SOLANA_RPC_URL_SECONDARY}
  PYTH_HERMES_URL: ${PYTH_HERMES_URL}
  PYTH_API_KEY: ${PYTH_API_KEY}
  PYTH_RECEIVER_PROGRAM_ID: ${PYTH_RECEIVER_PROGRAM_ID}
  PYTH_WORMHOLE_PROGRAM_ID: ${PYTH_WORMHOLE_PROGRAM_ID}
  PYTH_PUSH_ORACLE_PROGRAM_ID: ${PYTH_PUSH_ORACLE_PROGRAM_ID}

services:
  gateway:
    restart: unless-stopped
  matchmaking:
    restart: unless-stopped
  action-feed:
    restart: unless-stopped
  match-engine:
    restart: unless-stopped
  settlement-chain:
    restart: unless-stopped
    environment:
      <<: *devnet-env
  settlement-worker:
    restart: unless-stopped
    environment:
      <<: *devnet-env
EOF
```

> Compose precedence (verified behavior): per‑service `environment:` values in this override
> win over both the base `environment:` block and the `env_file` (`env.example`). That is how
> the localnet RPC and placeholder program ids get replaced for `settlement-chain` and
> `settlement-worker`.

---

## 5. Define the run command

You will always invoke Compose with the same flags. Set a helper alias for this shell:

```bash
export COMPOSE_APP="docker compose --env-file deploy/secrets/app.env -f deploy/docker-compose.app.yml -f deploy/docker-compose.override.yml"
export COMPOSE_INFRA="docker compose -f deploy/docker-compose.localnet.yml"
```

> If you open a new shell later, re‑run these two `export` lines before using `$COMPOSE_APP`
> / `$COMPOSE_INFRA`.

---

## 6. Start the infrastructure stack

```bash
$COMPOSE_INFRA up -d
```

Wait until Postgres, Redis and NATS are **healthy**:

```bash
watch -n 3 'docker ps --format "table {{.Names}}\t{{.Status}}" | grep syndicate-localnet'
# Press Ctrl+C once postgres/redis/nats show "(healthy)". This usually takes ~20-40s.
```

---

## 7. Apply the database migrations

The schema lives in `services/store/migrations/`. Apply both files (the script applies them
in order) against the Postgres published on `localhost:5432`:

```bash
DATABASE_URL="postgres://syndicate:syndicate@localhost:5432/syndicate_local" \
  ./scripts/db-migrate-local.sh
```

You should see no errors. Verify a core table exists:

```bash
PGPASSWORD=syndicate psql -h localhost -U syndicate -d syndicate_local -c '\dt' | head
```

> If `db-migrate-local.sh` is not executable: `chmod +x scripts/*.sh` then re‑run.

---

## 8. Build and start the application stack

This compiles the Rust services and installs Node dependencies inside Docker, then starts all
six services. The **first** build can take 10–25 minutes depending on the server.

```bash
$COMPOSE_APP build
$COMPOSE_APP up -d
```

Watch them come up:

```bash
docker ps --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}" | grep syndicate-app
```

> `settlement-worker` will keep restarting until `settlement-chain` answers its health check
> and all its required env/secrets are valid — this is expected for the first few seconds.

---

## 9. Verify the deployment

Run the health checks (all should print an HTTP 200 / `{"ok":true}`):

```bash
echo "gateway:";          curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:18081/healthz
echo "matchmaking:";      curl -s http://127.0.0.1:18082/healthz; echo
echo "action-feed:";      curl -s http://127.0.0.1:18080/healthz; echo
echo "match-engine:";     curl -s http://127.0.0.1:18083/healthz; echo
echo "settlement-chain:"; curl -s http://127.0.0.1:18790/health;  echo
echo "settlement-worker:";curl -s http://127.0.0.1:18084/healthz; echo
```

The `settlement-chain` health response echoes the program ids it loaded — confirm
`programId` equals your `SYNDICATE_PROGRAM_ID` and the three Pyth ids are correct.

Check the worker actually entered production mode (not demo) and passed preflight:

```bash
docker logs $(docker ps -qf name=settlement-worker) 2>&1 | tail -n 20
# Expect: "settlement worker production runtime ready (outbox relay + JetStream consumer + due-poller)"
```

### 9.1 Observability (optional)

- Prometheus UI (from the server, e.g. via SSH tunnel): `http://127.0.0.1:9090`
- Grafana UI: `http://127.0.0.1:3001` (default login `admin` / `syndicate-localnet` — change
  it). Dashboards are auto‑provisioned from `deploy/grafana/`.

To reach these from your laptop without opening firewall ports, tunnel over SSH:

```bash
# Run on your laptop. EDIT <SERVER_IP>.
ssh -L 9090:127.0.0.1:9090 -L 3001:127.0.0.1:3001 deploy@<SERVER_IP>
# Then browse http://localhost:9090 and http://localhost:3001
```

---

## 10. Day‑2 operations

```bash
# Re-export COMPOSE_APP / COMPOSE_INFRA (Step 5) in any new shell first.

# Logs (follow) for one service:
docker logs -f $(docker ps -qf name=settlement-chain)

# Restart one service:
$COMPOSE_APP restart gateway

# Stop / start everything:
$COMPOSE_APP down            # stops app only
$COMPOSE_INFRA down          # stops infra (data persists in named volumes)

# Update to a new code version:
git pull
$COMPOSE_APP build
$COMPOSE_APP up -d

# Full teardown INCLUDING data (DESTRUCTIVE — wipes Postgres/Redis/NATS/replays):
$COMPOSE_APP down
$COMPOSE_INFRA down -v
```

> Data lives in Docker named volumes (`postgres-data`, `redis-data`, `nats-data`,
> `minio-data`, `grafana-data`, `prometheus-data`, and `action-feed-replays`). They survive
> `down` and reboots; only `down -v` deletes them.

---

## 11. Troubleshooting

| Symptom | Cause / Fix |
| --- | --- |
| `settlement-worker` restarts forever; logs show `settlement-chain health check failed` | `settlement-chain` is not healthy yet, or `SETTLEMENT_CHAIN_URL` wrong. Check `curl 127.0.0.1:18790/health`. |
| Worker log: `missing required environment variable: ...` | A var in `deploy/secrets/app.env` is empty or you forgot to re‑run the Step 5 `export` lines. Re‑export and `$COMPOSE_APP up -d`. |
| Worker log: `points to an empty secret file` | `deploy/secrets/settlement-chain.token` is empty, or `settlement-admin-keypair.json` missing. Re‑do Step 3. |
| `settlement-chain` health shows wrong `programId`/Pyth ids | `app.env` values not applied. Confirm you pass `--env-file deploy/secrets/app.env` and both `-f` files (Step 5), then `up -d`. |
| Rust build killed / OOM during Step 8 | Server out of memory. Add swap (guide `02`, Step 9) and rebuild. |
| `network syndicate-localnet_default not found` | The infra stack is not up. Run Step 6 first. |
| Migrations fail: `connection refused` | Postgres not healthy yet. Wait for `(healthy)` in Step 6, then re‑run Step 7. |
| `action-feed` logs `restored 0 historical matches` | Normal on a fresh database. |

---

## 12. Deployment complete

When Step 9 shows all services healthy and the worker prints its production‑ready line, the
backend is live on devnet against your deployed program. Next steps (outside this guide):
put `gateway` and `action-feed` behind a TLS reverse proxy on 443, rotate the Grafana
password, and point the frontend at the gateway WebSocket URL.
