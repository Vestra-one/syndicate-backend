# 04 — Domain, TLS & Devnet Subdomains (`satoshitable.fun`)

> Run as the `deploy` user on the VPS **after** [03_BACKEND_DEPLOYMENT.md](./03_BACKEND_DEPLOYMENT.md) §10 passes.
> Backend services must already be healthy on localhost ports (`18081`, `18080`, `18085`, …).

This guide wires **[satoshitable.fun](https://satoshitable.fun/)** to the Syndicate backend with:

- **HTTPS** (Let's Encrypt via Caddy)
- **Per-service devnet subdomains** under `*.devnet.satoshitable.fun` (mandatory devnet namespace)
- Marketing UI at **`satoshitable.fun`** (optional devnet SPA at **`devnet.satoshitable.fun`**)

---

## 0. URL map (devnet)

Each public backend service gets its own hostname. The **`devnet.`** label is required for staging — do not point mainnet at these hosts later.

| Hostname | Backend (localhost) | Service |
|----------|---------------------|---------|
| `wss://gateway.devnet.satoshitable.fun` | `127.0.0.1:18081` | gateway (WebSocket) |
| `https://api.devnet.satoshitable.fun` | `127.0.0.1:18080` | action-feed (REST) |
| `https://config.devnet.satoshitable.fun` | `127.0.0.1:18085` | config (REST) |
| `https://satoshitable.fun` | static files | marketing / coming soon |
| `https://devnet.satoshitable.fun` | static files (optional) | devnet game client SPA |

**Not exposed publicly** (localhost / ops only): match-engine, matchmaking, settlement-chain, settlement-worker, Postgres, Redis, Grafana, Prometheus.

Example calls the frontend will make:

```text
wss://gateway.devnet.satoshitable.fun
https://api.devnet.satoshitable.fun/active-games
https://config.devnet.satoshitable.fun/config/table?matchId=…
```

> **Why subdomains?** Clear service boundaries, simple Caddy routing (no path rewriting), and an obvious devnet namespace (`*.devnet.*`) separate from future mainnet hosts like `gateway.satoshitable.fun`.

---

## 1. Prerequisites

- [03_BACKEND_DEPLOYMENT.md](./03_BACKEND_DEPLOYMENT.md) complete — `curl http://127.0.0.1:18081/healthz` returns `200`.
- DNS control for `satoshitable.fun`.
- Hetzner (or host) firewall allows **22, 80, 443** only ([02_VPS_SETUP.md](./02_VPS_SETUP.md) §4.2).
- Backend Docker ports bound to **127.0.0.1** (§3 below).

---

## 2. DNS records

Point devnet service hosts (and apex) at the VPS public IP.

**Option A — wildcard (recommended):** one record covers all devnet subdomains.

| Type | Name | Value | TTL |
|------|------|-------|-----|
| `A` | `@` | `<SERVER_IP>` | 300 |
| `A` | `www` | `<SERVER_IP>` | 300 |
| `A` | `devnet` | `<SERVER_IP>` | 300 |
| `A` | `*.devnet` | `<SERVER_IP>` | 300 |

**Option B — explicit records** (if your DNS provider does not allow wildcards):

| Type | Name | Value |
|------|------|-------|
| `A` | `gateway.devnet` | `<SERVER_IP>` |
| `A` | `api.devnet` | `<SERVER_IP>` |
| `A` | `config.devnet` | `<SERVER_IP>` |
| `A` | `devnet` | `<SERVER_IP>` |
| `A` | `@` | `<SERVER_IP>` |
| `A` | `www` | `<SERVER_IP>` |

Optional IPv6: mirror with `AAAA` records.

Verify propagation from your laptop:

```bash
# EDIT: <SERVER_IP>
dig +short satoshitable.fun A
dig +short gateway.devnet.satoshitable.fun A
dig +short api.devnet.satoshitable.fun A
dig +short config.devnet.satoshitable.fun A
# All should return <SERVER_IP>
```

> **Cloudflare:** use **DNS only** (grey cloud) for `*.devnet` during first certificate issuance, or ensure HTTP-01 on port 80 reaches the VPS. SSL mode: **Full (strict)** after Caddy has certs.

---

## 3. Bind backend ports to localhost only

Guide [02_VPS_SETUP.md](./02_VPS_SETUP.md) §4.2 notes Docker bypasses UFW when ports publish on `0.0.0.0`. Restrict public-facing services to loopback before exposing Caddy.

Edit `deploy/docker-compose.override.yml` (created in guide 03 §5). **Add** a `ports:` block under each public service:

```yaml
services:
  gateway:
    restart: unless-stopped
    ports:
      - "127.0.0.1:18081:8081"
      - "127.0.0.1:19081:9081"
  action-feed:
    restart: unless-stopped
    ports:
      - "127.0.0.1:18080:8080"
  config:
    restart: unless-stopped
    ports:
      - "127.0.0.1:18085:8085"
  # … keep existing restart / cluster-env on other services unchanged
```

Recreate the published services:

```bash
export COMPOSE_APP="docker compose --env-file deploy/secrets/app.env \
  -f deploy/docker-compose.app.yml \
  -f deploy/docker-compose.override.yml"

$COMPOSE_APP up -d --force-recreate gateway action-feed config
```

Confirm they are **not** on `0.0.0.0`:

```bash
ss -tlnp | grep -E '18081|18080|18085'
# Expect 127.0.0.1:18081 etc., not 0.0.0.0
```

---

## 4. Install Caddy

Caddy obtains and renews Let's Encrypt certificates automatically.

```bash
sudo apt-get update
sudo apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
  | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt-get update
sudo apt-get install -y caddy
caddy version
```

---

## 5. Static site roots (optional)

```bash
# Marketing / coming soon
sudo mkdir -p /var/www/satoshitable
sudo chown deploy:deploy /var/www/satoshitable

cat > /var/www/satoshitable/index.html <<'EOF'
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Satoshi's Table — coming soon</title>
  </head>
  <body>
    <h1>Satoshi's Table</h1>
    <p>Devnet client: <a href="https://devnet.satoshitable.fun">devnet.satoshitable.fun</a></p>
  </body>
</html>
EOF

# Devnet SPA (when ready)
sudo mkdir -p /var/www/satoshitable-devnet
sudo chown deploy:deploy /var/www/satoshitable-devnet
```

Deploy the Vite `dist/` build to `/var/www/satoshitable-devnet/` when the game client is ready.

---

## 6. Caddy configuration

Copy the repo example:

```bash
cd /opt/syndicate/backend
sudo cp deploy/caddy/Caddyfile /etc/caddy/Caddyfile
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl enable --now caddy
sudo systemctl reload caddy
```

The example file (`deploy/caddy/Caddyfile`) implements:

| Virtual host | Upstream |
|--------------|----------|
| `satoshitable.fun` | static `/var/www/satoshitable` |
| `devnet.satoshitable.fun` | static `/var/www/satoshitable-devnet` |
| `gateway.devnet.satoshitable.fun` | `127.0.0.1:18081` |
| `api.devnet.satoshitable.fun` | `127.0.0.1:18080` |
| `config.devnet.satoshitable.fun` | `127.0.0.1:18085` |

Caddy requests a separate TLS certificate per hostname (or uses applicable wildcard if configured).

---

## 7. Verify public endpoints

From your **laptop**:

```bash
# TLS
curl -sI https://satoshitable.fun/ | head -n 5
curl -sI https://api.devnet.satoshitable.fun/healthz | head -n 5

# Backend health
curl -s https://api.devnet.satoshitable.fun/healthz
curl -s https://config.devnet.satoshitable.fun/healthz
curl -s http://127.0.0.1:18081/healthz   # gateway — run on VPS, or expose a health route later

# Action-feed discovery
curl -s https://api.devnet.satoshitable.fun/active-games | head -c 200; echo

# Config catalog
curl -s https://config.devnet.satoshitable.fun/config/catalog | head -c 200; echo

# WebSocket (requires wscat: npm i -g wscat)
# wscat -c wss://gateway.devnet.satoshitable.fun
# Expect: {"type":"challenge","nonce":"…"}
```

On the VPS during first cert fetch:

```bash
sudo journalctl -u caddy -f
```

---

## 8. Frontend environment (devnet handoff)

Give the frontend team these values (also in [../frontend/INTEGRATION_GUIDE.md](../frontend/INTEGRATION_GUIDE.md)):

| Key | Devnet value |
|-----|--------------|
| `GATEWAY_WS_URL` | `wss://gateway.devnet.satoshitable.fun` |
| `ACTION_FEED_URL` | `https://api.devnet.satoshitable.fun` |
| `CONFIG_URL` | `https://config.devnet.satoshitable.fun` |
| `SOLANA_CLUSTER` | `devnet` |
| `SOLANA_RPC_URL` | `https://api.devnet.solana.com` (or your provider) |
| `PROGRAM_ID` | from `deploy/secrets/app.env` → `SYNDICATE_PROGRAM_ID` |
| `CHIPS_TOKEN_MINT` | from `deploy/secrets/app.env` |
| `DRAND_API` | `https://api.drand.sh` |
| `DRAND_CHAIN_HASH` | `52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971` |

Example Vite `.env.production`:

```bash
VITE_GATEWAY_WS_URL=wss://gateway.devnet.satoshitable.fun
VITE_ACTION_FEED_URL=https://api.devnet.satoshitable.fun
VITE_CONFIG_URL=https://config.devnet.satoshitable.fun
VITE_SOLANA_CLUSTER=devnet
VITE_SOLANA_RPC_URL=https://api.devnet.solana.com
VITE_PROGRAM_ID=REPLACE_FROM_app.env
VITE_CHIPS_TOKEN_MINT=REPLACE_FROM_app.env
```

> Client code calls `${CONFIG_URL}/config/table?…` and `${ACTION_FEED_URL}/active-games`. Keep base URLs **without trailing slashes**.

### CORS (cross-subdomain)

The game client on `devnet.satoshitable.fun` calls APIs on other subdomains — that is **cross-origin**. If the browser blocks requests, add `Access-Control-Allow-Origin` on gateway, action-feed, and config (allow `https://devnet.satoshitable.fun` and `https://satoshitable.fun`), or serve the SPA from the same host as one aggregated proxy. Track as a frontend-integration follow-up if needed.

---

## 9. Hetzner Cloud Firewall (recheck)

Inbound only:

| Port | Purpose |
|------|---------|
| 22/tcp | SSH |
| 80/tcp | ACME + HTTP→HTTPS redirect |
| 443/tcp | HTTPS / WSS |

Do **not** open `18080`, `18081`, etc.

---

## 10. Day-2 operations

```bash
sudo nano /etc/caddy/Caddyfile
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy

rsync -av ./dist/ deploy@<SERVER_IP>:/var/www/satoshitable-devnet/
systemctl status caddy
```

---

## 11. Future: mainnet on the same domain

Use **different hostnames** — never reuse devnet subdomains for real money.

| Cluster | Gateway | API (action-feed) | Config |
|---------|---------|-------------------|--------|
| **devnet** | `gateway.devnet.satoshitable.fun` | `api.devnet.satoshitable.fun` | `config.devnet.satoshitable.fun` |
| **mainnet** | `gateway.satoshitable.fun` | `api.satoshitable.fun` | `config.satoshitable.fun` |

Mainnet can run on the same VPS (different localhost ports + Compose project) or a separate host.

---

## 12. Troubleshooting

| Symptom | Fix |
|---------|-----|
| `502` on `api.devnet…` | `curl http://127.0.0.1:18080/healthz` on VPS; `$COMPOSE_APP up -d action-feed` |
| WebSocket fails | `dig gateway.devnet.satoshitable.fun`; check `docker logs syndicate-app-gateway-1` |
| `404` on config | Use `https://config.devnet…/config/table` not `/table`; `CONFIG_URL=https://config.devnet.satoshitable.fun` |
| ACME / certificate fails | DNS missing for `*.devnet` or specific host; port 80 blocked; Cloudflare orange-cloud |
| NXDOMAIN | Add `A *.devnet` or individual `A gateway.devnet` records (§2) |
| Backend reachable on `:18081` from internet | Re-run §3 — bind to `127.0.0.1:` |
| Browser CORS errors | Allow devnet SPA origin on API services (§8) or co-locate UI/API |

---

## 13. Done

When §7 passes, devnet services are live on `*.devnet.satoshitable.fun` and the frontend team can wire against §8.

See also [README.md](./README.md) · [03_BACKEND_DEPLOYMENT.md](./03_BACKEND_DEPLOYMENT.md) · [../frontend/INTEGRATION_GUIDE.md](../frontend/INTEGRATION_GUIDE.md)
