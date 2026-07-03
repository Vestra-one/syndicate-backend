# Syndicate v2 — Deployment Guide

This is the single authoritative deployment document for the v2 backend. It supersedes
`01_CONTRACT_DEPLOYMENT.md` … `04_DOMAIN_AND_TLS.md`.

## 1. Topology

```
                        ┌──────────────────────── VPS ────────────────────────┐
  players/UI ── https ──►  nginx ──► game-server (Rust/axum, :8080)           │
                │       │              │  REST /v1/* + WebSocket /v1/ws       │
                │       │              │  in-process betting engine           │
                │       │              ▼                                      │
                │       │           Postgres 16  ◄── chain-worker (Rust)      │
                │       │              ▲               │ signs lock/begin_live│
                │       │              │               │ /settle/void txs     │
                └─ wss ─┤   signed-price-server (Go, :8080)◄──────────┘       │
                        └──────────────────────────────────────────────────────┘
                                        │                        │
                                Solana devnet/mainnet      drand quicknet
```

| Service | Image source | Port (internal) | Health | Secrets |
|---|---|---|---|---|
| game-server | `deploy/Dockerfile.rust` (`BIN=syndicate-game-server`) | 8080 | `/healthz` | postgres-password, session-signing-key |
| chain-worker | `deploy/Dockerfile.rust` (`BIN=syndicate-chain-worker`) | 8084 | `/healthz` | postgres-password, operator-keypair.json |
| signed-price-server | `services/signed-price-server/Dockerfile` | 8080 | `/health` | price-signer.key |
| postgres | postgres:16 | 5432 | `pg_isready` | postgres-password |
| nginx | nginx:1.27 | 80/443 (published) | — | TLS certs (certbot volume) |

Only nginx publishes host ports (plus loopback debug binds in the devnet overlay).

## 2. Prerequisites

- VPS: **4 vCPU / 8 GB RAM / 160 GB NVMe** (handles 1000 concurrent users with ~5× headroom; 2 vCPU/4 GB is fine for devnet). Ubuntu 22.04+.
- DNS: `api.<domain>` and `price.<domain>` A-records to the VPS.
- Local (deploy) machine: Solana CLI ≥ 2.x, Anchor **0.32.1**, Rust stable, the platform-tools **v1.53** for `cargo build-sbf`.
- Funded devnet wallet for the program deploy + operator.

## 3. VPS bootstrap

```bash
adduser syndicate && usermod -aG sudo,docker syndicate
ufw allow 22/tcp && ufw allow 80/tcp && ufw allow 443/tcp && ufw enable
curl -fsSL https://get.docker.com | sh
git clone <repo> /opt/syndicate && cd /opt/syndicate
```

## 4. Secrets

Follow [deploy/secrets/README.md](../../deploy/secrets/README.md) — four files:
`postgres-password`, `operator-keypair.json`, `price-signer.key`, `session-signing-key`.
All `chmod 600`, all gitignored. Fund the operator keypair (`solana transfer`, keep ≥ 1 SOL
on devnet; chain-worker alarms below `MIN_SIGNER_SOL`).

## 5. Program deploy (fresh v2)

The v2 program id is declared in `services/programs/programs/syndicate_program/src/lib.rs`
and its keypair lives at `services/programs/keys/syndicate_program_v2-keypair.json`
(generate a new one + update `declare_id!`/`Anchor.toml` if you fork).

```bash
# one command: build-sbf → solana program deploy → initialize_protocol +
# set_price_signer + set_match_bounds → IDL emit to docs/frontend/idl/
PRICE_SIGNER_ETH=0x<eth-address-of-price-key> scripts/deploy-program-devnet.sh
```

Record the printed program id in `deploy/.env` (`SYNDICATE_PROGRAM_ID`). The operator
wallet used by the script becomes every protocol role; on mainnet split the roles and put
the upgrade authority behind a multisig.

## 6. Database

Migrations apply automatically via the `db-migrate` one-shot compose service, or manually:

```bash
DATABASE_URL=postgres://syndicate:$(cat deploy/secrets/postgres-password)@127.0.0.1:5432/syndicate \
  scripts/db-migrate.sh
```

Backups: nightly `pg_dump -Fc` to offsite storage; the hash-chained `match_events` table
is the source of truth — verify restores with `SELECT count(*) FROM match_events`.

## 7. App bring-up

```bash
cp deploy/.env.example deploy/.env   # fill in program id, mint, domain, RPC, admin tokens
docker compose -f deploy/docker-compose.yml -f deploy/docker-compose.devnet.yml \
  --env-file deploy/.env up -d --build
```

## 8. TLS

First bring-up serves plain :80 (ACME + redirect). Issue certs, then reload:

```bash
docker compose -f deploy/docker-compose.yml exec nginx sh -c 'mkdir -p /var/www/certbot'
docker run --rm -v syndicate_certbot-webroot:/var/www/certbot \
  -v syndicate_letsencrypt:/etc/letsencrypt certbot/certbot certonly \
  --webroot -w /var/www/certbot -d api.$DOMAIN -d price.$DOMAIN \
  --email $TLS_EMAIL --agree-tos --no-eff-email
docker compose -f deploy/docker-compose.yml restart nginx
```

Renewal: monthly cron running the same `certonly` + `nginx -s reload`.

## 9. Validate

```bash
GAME_SERVER_URL=http://127.0.0.1:18080 CHAIN_WORKER_URL=http://127.0.0.1:18084 \
PRICE_URL=http://127.0.0.1:18088 \
DATABASE_URL=postgres://syndicate:$(cat deploy/secrets/postgres-password)@127.0.0.1:5432/syndicate \
OPERATOR_PUBKEY=$(solana-keygen pubkey deploy/secrets/operator-keypair.json) \
  scripts/smoke-test.sh

# full game lifecycle against an already-deployed + funded stack
scripts/run-e2e-devnet.sh

# OR — one reproducible command that also creates + funds 3 players + 1 attacker, verifies
# the program/protocol, brings the stack up, and runs every scenario incl. the fund-theft
# suite (public + theft, private room-code enforcement, under-min void, unconfirmed refund):
SOLANA_RPC_URL=<keyed-devnet-rpc> scripts/e2e-local-devnet.sh          # add RUN_LOAD=1 for the 1000-conn WS check
```

> **Devnet RPC**: the public endpoint `api.devnet.solana.com` is frequently IP-blocked
> (connection reset). Use a keyed provider (Helius/QuickNode/Alchemy/Triton) for both the
> stack (`SOLANA_RPC_URL_PRIMARY` in `deploy/.env`) and the e2e script. The e2e worker runs
> with `TIMELOCK_OPEN_MODE=mock` (set in `docker-compose.devnet.yml`) so settlement decrypts
> a deterministic seal without waiting on a live drand round; unset it for real tlock.

## 10. Operations runbook

- **Logs**: `docker compose logs -f game-server chain-worker` (JSON; filter by `match_id`).
- **Metrics**: `/metrics` on both Rust services; `--profile observability` adds
  prometheus + grafana (dashboards in `deploy/grafana/`).
- **Dead-letter triage**: `SELECT id, match_id, kind, last_error, oracle_audit FROM chain_jobs
  WHERE status = 'dead_letter';` — a dead-lettered `submit_settlement` means the match will
  hit the permissionless 300s void backstop (players get full refunds); investigate before
  requeueing (`UPDATE chain_jobs SET status='pending', next_retry_at=now() WHERE id=...`).
- **Signer top-up**: watch the `chain_worker_signer_lamports` gauge; top up with
  `solana transfer <operator> 1 --url devnet`.
- **Key rotation**: see `deploy/secrets/README.md`.
- **Upgrade**: `git pull && docker compose ... up -d --build` — migrations run first via
  `db-migrate`; game-server recovers live matches from the event log on restart.
- **Rollback**: redeploy the previous git tag; migrations are additive-only, so old code
  runs against a newer schema.

## 11. Capacity & mainnet deltas

- 1000 concurrent users ≈ 200 tables ≈ ~200 event-appends/s worst case + ~2k WS messages/s
  fan-out — single game-server instance uses well under one core; Postgres on NVMe is the
  ceiling, far above this load.
- Mainnet: paid RPC (Helius/Triton) in `SOLANA_RPC_URL_PRIMARY` (+ a second provider as
  `SECONDARY`), multisig upgrade authority, split protocol roles across keys, remove the
  devnet overlay, real treasury token account.
