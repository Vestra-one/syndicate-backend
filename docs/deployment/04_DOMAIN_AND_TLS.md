# 04 — Domain, TLS & Backend Subdomains

> **Run as the `deploy` user on the VPS after [03_BACKEND_DEPLOYMENT.md](./03_BACKEND_DEPLOYMENT.md) §10 passes.**

## What this guide does

Installs **Caddy** on the VPS and issues Let's Encrypt certificates for the four backend subdomains under `*.devnet.satoshitable.fun`.

**Does NOT touch `satoshitable.fun`** — the frontend SPA is hosted on Netlify. Caddy only handles backend traffic.

---

## 0. URL map

| Public hostname | VPS port | Service |
|-----------------|----------|---------|
| `wss://gateway.devnet.satoshitable.fun` | `127.0.0.1:18081` | Gateway (WebSocket) |
| `https://api.devnet.satoshitable.fun` | `127.0.0.1:18080` | Action-feed (REST) |
| `https://config.devnet.satoshitable.fun` | `127.0.0.1:18085` | Config (REST) |
| `https://price.devnet.satoshitable.fun` | `127.0.0.1:18088` | Signed-price feed — read-only |
| `https://satoshitable.fun` | — | Frontend SPA → **Netlify** (not this guide) |

**Not exposed publicly** (localhost / ops only): match-engine, matchmaking, settlement-chain, settlement-worker, Postgres, Redis.

> **Signed-price feed is read-only.** Caddy blocks `/internal/*` and `/metrics` with `404` — those failover admin routes are unauthenticated on devnet and must never reach the internet.

---

## 1. Prerequisites

- Guide 03 complete — all backend containers healthy.
- Netlify DNS: `*.devnet A <SERVER_IP>` wildcard already added (done).
- Hetzner Cloud Firewall: inbound ports 22, 80, 443 **only** — verify this before continuing (§2).
- The VPS does **not** need to serve `satoshitable.fun` or `www` — Netlify handles those.

---

## 2. Verify firewall and DNS

### 2a. Hetzner Cloud Firewall

Docker modifies iptables directly and bypasses UFW — the **Hetzner Cloud Firewall is the actual isolation layer**. Verify it in the Hetzner Cloud Console (`Firewall` → your server → `Inbound rules`):

| Port | Protocol | Allowed from |
|------|----------|--------------|
| 22 | TCP | Your IP (or `0.0.0.0/0` if you accept the risk) |
| 80 | TCP | `0.0.0.0/0` (ACME challenge) |
| 443 | TCP | `0.0.0.0/0` (HTTPS/WSS) |

All other ports (18080, 18081, 18085, 18088, 5432, 6379, …) must be **blocked**.

### 2b. DNS propagation

```bash
# EDIT: replace with your VPS public IP
SERVER_IP=1.2.3.4

dig +short gateway.devnet.satoshitable.fun A   # expect $SERVER_IP
dig +short api.devnet.satoshitable.fun A        # expect $SERVER_IP
dig +short config.devnet.satoshitable.fun A     # expect $SERVER_IP
dig +short price.devnet.satoshitable.fun A      # expect $SERVER_IP
```

All four must return your VPS IP before proceeding. Netlify DNS typically propagates in under 5 minutes. If any returns empty, check the wildcard record in Netlify DNS dashboard: `*.devnet` → A → `<SERVER_IP>`.

---

## 3. Install Caddy

```bash
sudo apt-get update
sudo apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl

curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
  | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg

curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
  | sudo tee /etc/apt/sources.list.d/caddy-stable.list

sudo apt-get update
sudo apt-get install -y caddy

caddy version   # confirm installation
```

---

## 4. Deploy Caddyfile

The repo ships the correct Caddyfile for the four backend subdomains. Copy it, validate, and start Caddy:

```bash
cd /opt/syndicate/backend

sudo cp deploy/caddy/Caddyfile /etc/caddy/Caddyfile
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl enable --now caddy
sudo systemctl reload caddy
```

The Caddyfile configures:

| Virtual host | Upstream |
|--------------|----------|
| `gateway.devnet.satoshitable.fun` | `127.0.0.1:18081` |
| `api.devnet.satoshitable.fun` | `127.0.0.1:18080` |
| `config.devnet.satoshitable.fun` | `127.0.0.1:18085` |
| `price.devnet.satoshitable.fun` | `127.0.0.1:18088` (+ `/internal/*` and `/metrics` → 404) |

Caddy requests a Let's Encrypt certificate for each hostname automatically. Watch the first issuance:

```bash
sudo journalctl -u caddy -f
# Look for: certificate obtained successfully
# Ctrl-C when done
```

---

## 5. Verify endpoints

Run these from your **laptop** after certificates are issued (allow ~30 s for first cert):

```bash
# Action-feed
curl -sf https://api.devnet.satoshitable.fun/healthz && echo OK

# Config
curl -sf https://config.devnet.satoshitable.fun/healthz && echo OK

# Signed-price feed — health + price sample; admin routes must 404
curl -sf https://price.devnet.satoshitable.fun/health | python3 -m json.tool
curl -sf "https://price.devnet.satoshitable.fun/prices?symbols=BTCUSD" | head -c 200; echo
curl -o /dev/null -w "%{http_code}\n" -s https://price.devnet.satoshitable.fun/metrics            # 404
curl -o /dev/null -w "%{http_code}\n" -s https://price.devnet.satoshitable.fun/internal/failover/status  # 404

# Gateway WebSocket (requires wscat: npm i -g wscat)
wscat -c wss://gateway.devnet.satoshitable.fun
# Expect: {"type":"challenge","nonce":"…"}  — Ctrl-C to exit
```

Run from the **VPS** for the gateway (no external route for gateway healthz):

```bash
curl -sf http://127.0.0.1:18081/healthz && echo OK
```

---

## 6. Frontend environment (handoff)

The frontend SPA on `satoshitable.fun` calls the backend subdomains — those are **cross-origin** requests. Add these env vars to the frontend Vite build:

```bash
VITE_GATEWAY_WS_URL=wss://gateway.devnet.satoshitable.fun
VITE_ACTION_FEED_URL=https://api.devnet.satoshitable.fun
VITE_CONFIG_URL=https://config.devnet.satoshitable.fun
VITE_PRICE_FEED_URL=https://price.devnet.satoshitable.fun
VITE_PRICE_FEED_WS_URL=wss://price.devnet.satoshitable.fun/ws
VITE_SOLANA_CLUSTER=devnet
VITE_SOLANA_RPC_URL=https://api.devnet.solana.com
VITE_PROGRAM_ID=        # copy from deploy/secrets/app.env → SYNDICATE_PROGRAM_ID
VITE_CHIPS_TOKEN_MINT=  # copy from deploy/secrets/app.env
```

Also in [../frontend/INTEGRATION_GUIDE.md](../frontend/INTEGRATION_GUIDE.md).

> **CORS:** `satoshitable.fun` calling `*.devnet.satoshitable.fun` is cross-origin. If the browser blocks requests, add `Access-Control-Allow-Origin: https://satoshitable.fun` on gateway, action-feed, and config. The signed-price feed already returns `Access-Control-Allow-Origin: *` — do **not** add a CORS header in the `price.devnet` Caddy block (duplicate `ACAO: *` breaks the browser).

---

## 7. Day-2 operations

```bash
# Edit and reload Caddy config
sudo nano /etc/caddy/Caddyfile
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy

# Check Caddy status / cert renewal
systemctl status caddy
sudo journalctl -u caddy --since "1 hour ago"
```

---

## 8. Future: mainnet on the same domain

Use **different hostnames** — never reuse devnet subdomains for real money.

| Cluster | Gateway | API | Config | Price feed |
|---------|---------|-----|--------|------------|
| **devnet** | `gateway.devnet.satoshitable.fun` | `api.devnet.satoshitable.fun` | `config.devnet.satoshitable.fun` | `price.devnet.satoshitable.fun` |
| **mainnet** | `gateway.satoshitable.fun` | `api.satoshitable.fun` | `config.satoshitable.fun` | `price.satoshitable.fun` |

---

## 9. Troubleshooting

| Symptom | Fix |
|---------|-----|
| `dig` returns empty for `*.devnet` | Check Netlify DNS dashboard: `*.devnet` A record → VPS IP |
| ACME / cert fails (`journalctl -u caddy`) | Port 80 blocked on Hetzner Cloud Firewall; add inbound TCP 80 |
| `502` on `api.devnet…` | `curl http://127.0.0.1:18080/healthz`; `$COMPOSE_APP up -d action-feed` |
| `502` on `gateway.devnet…` | `curl http://127.0.0.1:18081/healthz`; `$COMPOSE_APP up -d gateway` |
| `502` on `config.devnet…` | `curl http://127.0.0.1:18085/healthz`; `$COMPOSE_APP up -d config` |
| `502` on `price.devnet…` | `curl http://127.0.0.1:18088/health`; `$COMPOSE_APP up -d signed-price-server` |
| `price.devnet…/metrics` returns 200 | `@ops` block missing — restore `respond @ops 404` in Caddyfile and `systemctl reload caddy` |
| Backend ports reachable from internet | Hetzner Cloud Firewall not configured — block all except 22/80/443 (§2a) |
| Browser CORS errors from `satoshitable.fun` | Add `Access-Control-Allow-Origin: https://satoshitable.fun` on gateway/action-feed/config |
| Websocket drops after 30 s | Caddy default idle timeout; add `transport http { read_timeout 0 }` under the gateway block if needed |

---

## Done

When §5 passes, devnet backend services are live on `*.devnet.satoshitable.fun`.

See also: [README.md](./README.md) · [03_BACKEND_DEPLOYMENT.md](./03_BACKEND_DEPLOYMENT.md) · [../frontend/INTEGRATION_GUIDE.md](../frontend/INTEGRATION_GUIDE.md)
