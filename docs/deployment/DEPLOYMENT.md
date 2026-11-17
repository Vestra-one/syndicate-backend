# Syndicate v2 — Deployment Guide

This is the single authoritative deployment document for the v2 backend. It replaces the
removed v1 guides (`01_…`–`04_…`). For the edge/TLS step, see
[08_HOST_NGINX_TLS.md](./08_HOST_NGINX_TLS.md).

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
| game-server | `deploy/Dockerfile.rust` (`BIN=syndicate-game-server`) | 8080 → `127.0.0.1:18080` | `/healthz` | postgres-password, session-signing-key |
| chain-worker | `deploy/Dockerfile.rust` (`BIN=syndicate-chain-worker`) | 8084 → `127.0.0.1:18084` | `/healthz` | postgres-password, operator-keypair.json |
| signed-price-server | `services/signed-price-server/Dockerfile` | 8080 → `127.0.0.1:18088` | `/health` | price-signer.key |
| postgres | postgres:16 | 5432 (not published) | `pg_isready` | postgres-password |
| nginx (opt-in, profile `edge`) | nginx:1.27 | 80/443 | — | TLS certs (certbot volume) |

**No service publishes a public port by default.** The three app services publish to
**loopback only** (`127.0.0.1:180xx`) so a **host reverse proxy** (systemd nginx + certbot,
already present on most VPSes) can terminate TLS and proxy to them — see §8. The bundled
`nginx` container is **opt-in** (`--profile edge`) for a *dedicated* VPS where nothing else
owns 80/443; enabling it alongside a host nginx makes the two fight over those ports.

## 0. One command (blank server → running devnet backend)

```bash
scripts/deploy-remote.sh root@<server-ip>      # from your machine; asks for the password once
```

It copies the working tree to `/opt/satoshi-table` and runs `scripts/server-bootstrap.sh`
there: packages + firewall, Rust + Solana CLI, fresh secrets, program build + deploy,
protocol init, chips mint, `deploy/.env`, house bots, the Docker stack, nginx and TLS.
Every step is skipped when already done, so the same command ships new code later.

- It waits until the operator wallet it prints holds ~7 devnet SOL (it tries the airdrop
  first; otherwise fund it at faucet.solana.com).
- TLS is issued once `api.$DOMAIN` and `price.$DOMAIN` (default `devnet.satoshitable.fun`)
  resolve to the server; until then it tells you which A records to set — re-run after.
- The program keypair (`services/programs/keys/`, not in git) must be present locally.
- Sections 2–8 below describe the same steps by hand.

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
All gitignored. Fund the operator keypair (`solana transfer`, keep ≥ 1 SOL on devnet;
chain-worker alarms below `MIN_SIGNER_SOL`).

> **`chmod 644`, not 600.** The Rust containers run as an unprivileged in-image user whose
> UID differs from the host owner, so a `600` bind-mounted secret is unreadable inside the
> container — chain-worker dies with `Permission denied (os error 13)` and game-server with
> `db connect: ... invalid configuration`. Run:
> ```bash
> chmod 644 deploy/secrets/{postgres-password,operator-keypair.json,price-signer.key,session-signing-key}
> ```

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

This starts postgres, db-migrate, signed-price-server, chain-worker, and game-server —
all publishing to **loopback only**. It does **not** start the `nginx` container. Verify
on the VPS before wiring the edge:

```bash
curl -sf http://127.0.0.1:18080/healthz && echo GAME_OK
curl -sf http://127.0.0.1:18088/health  && echo PRICE_OK
```

## 8. Edge / TLS

Pick **one** of the two patterns. The default (8a) is the right choice on any VPS that
already runs a host nginx for other services — trying to also run the bundled Docker nginx
there is the classic failure (two proxies fighting over 80/443, `nginx -t` errors, port
binds refused). See [08_HOST_NGINX_TLS.md](./08_HOST_NGINX_TLS.md) for the full runbook.

### 8a. Host nginx + certbot (default — coexists with other services)

Containers already listen on `127.0.0.1:18080` (game-server) and `127.0.0.1:18088`
(price). The **host's** systemd nginx terminates TLS and proxies to them. The repo ships
the vhost at [`deploy/nginx/syndicate-v2-host.conf`](../../deploy/nginx/syndicate-v2-host.conf):

```bash
# edit the two `server_name` lines for your domain, then:
sudo cp deploy/nginx/syndicate-v2-host.conf /etc/nginx/sites-available/syndicate-v2
sudo ln -s /etc/nginx/sites-available/syndicate-v2 /etc/nginx/sites-enabled/syndicate-v2
sudo nginx -t && sudo systemctl reload nginx

sudo apt-get install -y certbot python3-certbot-nginx
sudo certbot --nginx -d api.$DOMAIN -d price.$DOMAIN \
  --non-interactive --agree-tos -m $TLS_EMAIL
```

certbot injects the `listen 443 ssl` + cert directives and the HTTP→HTTPS redirect into
the vhost, and installs its own renewal timer (`certbot renew --dry-run` to verify).
Keep the bundled `nginx` container **off** — do not pass `--profile edge`.

### 8b. Bundled Docker nginx (dedicated VPS, nothing else on 80/443)

Only when the host has no other web server. Bring the edge container up with its profile:

```bash
docker compose -f deploy/docker-compose.yml -f deploy/docker-compose.devnet.yml \
  --env-file deploy/.env --profile edge up -d
```

First bring-up serves plain :80 (ACME + redirect). Issue certs, then reload:

```bash
docker run --rm -v syndicate_certbot-webroot:/var/www/certbot \
  -v syndicate_letsencrypt:/etc/letsencrypt certbot/certbot certonly \
  --webroot -w /var/www/certbot -d api.$DOMAIN -d price.$DOMAIN \
  --email $TLS_EMAIL --agree-tos --no-eff-email
docker compose -f deploy/docker-compose.yml --profile edge restart nginx
```

Renewal: monthly cron running the same `certonly` + `docker compose ... --profile edge exec nginx nginx -s reload`.

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

### 9a. Local stack — the whole system offline, one command

For development and CI there is a fully local stack that needs **no devnet RPC, no drand,
no exchange feed and no Docker**:

```bash
scripts/localnet/up.sh      # validator (program preloaded) + chips mint + funded wallets
                            # + protocol init + Postgres + mock price server
                            # + game-server + chain-worker
scripts/localnet/e2e.sh     # the full lifecycle + fund-theft suite against it
scripts/localnet/down.sh
```

- State (ledger, logs, pids, keys, the generated `env`) lives in `.localnet/` (git-ignored).
- The program is loaded at its declared id straight from `target/deploy` — no deploy step.
- Prices come from `scripts/localnet/mock-price-server.mjs`: same wire surface and the same
  EIP-191 signing as the Go server (so on-chain `verify_signed_price` runs for real) over a
  synthetic price walk. Its signer is registered as the protocol price signer.
- Timelock runs in **mock** mode (`TIMELOCK_OPEN_MODE=mock`). Never use that with real money.
- Needs: Solana CLI (`solana-test-validator`, `spl-token`), cargo, node ≥ 20, `psql`, and a
  Postgres superuser URL (`PG_SUPER_URL`, default `postgres://postgres@127.0.0.1:5432/postgres`).
- `EXTRA_WALLETS="<pubkey> …" scripts/localnet/up.sh` also funds your own browser wallets.
- The web app runs its browser end-to-end test against this stack
  (`npm run e2e:localnet` in `apps/web`): two real app instances play a hand through
  create → join → seal → bet → settle → claim.

### 9b. House table — a table that is always open

Two bot wallets keep one public table open so a visitor never lands on an empty lobby
(`services/e2e/src/house.rs`, compose profile `bots`).

```bash
FUND=1 scripts/house-bots-setup.sh   # keys → deploy/secrets/house-bot-{1,2}.json, wallets → deploy/.env, funded from the operator
scripts/deploy-devnet.sh             # brings the bots up with the stack
docker compose -f deploy/docker-compose.yml --env-file deploy/.env logs -f house-bots
```

- The lead bot opens a table; the second sits down the moment a person does, which fills
  the table (`HOUSE_HUMAN_SEATS=1`) and locks it at once — the visitor is sealing a call
  within seconds. The next table opens while that hand is played.
- When nobody comes, the bots play one showcase hand at a time against each other
  (`HOUSE_PLAY_WITHOUT_HUMANS=true`), so there is live action to watch. Set it to `false`
  where chips are real: empty tables then void and refund, and the house pays no rake.
- The bots are ordinary wallets with ordinary sessions. They seal before the lock like
  everyone else and never see another seat's call. Their wallets are published in
  `/v1/config.house_bot_wallets` and the UI labels those seats "House bot".
- Bankroll: each bot needs SOL for fees and about three buy-ins of chips (it can be seated
  at a live hand and the next open table at once). The log says which wallet to top up.
- Local: `BOTS=1 scripts/localnet/up.sh`; browser check: `E2E_HOUSE=1 npm run e2e:localnet`.

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
