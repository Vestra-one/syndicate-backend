# 04 — Domain, TLS & Backend Subdomains

> **Run as the `deploy` user on the VPS after [03_BACKEND_DEPLOYMENT.md](./03_BACKEND_DEPLOYMENT.md) §10 passes.**

## What this guide does

Configures **nginx** (already running on the VPS) as a TLS-terminating reverse proxy for the four backend subdomains under `*.devnet.satoshitable.fun`, with **certbot** for Let's Encrypt certificates.

**Does NOT touch `satoshitable.fun`** — the frontend SPA is hosted on Netlify.

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

> **Signed-price feed is read-only.** nginx blocks `/internal/*` and `/metrics` with `404` — those failover admin routes are unauthenticated on devnet and must never reach the internet.

---

## 1. Prerequisites

- Guide 03 complete — all backend containers healthy.
- Netlify DNS: `*.devnet A <SERVER_IP>` wildcard already added.
- Hetzner Cloud Firewall: inbound 22, 80, 443 only (§2).
- nginx is already running on the VPS (confirmed by `systemctl is-active nginx`).

---

## 2. Verify firewall and DNS

### 2a. Hetzner Cloud Firewall

Docker modifies iptables directly and bypasses UFW — the **Hetzner Cloud Firewall is the actual isolation layer**. In the Hetzner Cloud Console → Firewall → your server → Inbound rules, verify:

| Port | Protocol | Source |
|------|----------|--------|
| 22 | TCP | your IP |
| 80 | TCP | `0.0.0.0/0` |
| 443 | TCP | `0.0.0.0/0` |

All other ports (18080, 18081, 18085, 18088, 5432, 6379, …) must be **absent** (blocked).

### 2b. DNS propagation

```bash
# EDIT: replace with your VPS public IP
SERVER_IP=1.2.3.4

dig +short gateway.devnet.satoshitable.fun A   # expect $SERVER_IP
dig +short api.devnet.satoshitable.fun A        # expect $SERVER_IP
dig +short config.devnet.satoshitable.fun A     # expect $SERVER_IP
dig +short price.devnet.satoshitable.fun A      # expect $SERVER_IP
```

All four must return your VPS IP before proceeding.

---

## 3. Deploy nginx vhost config

The repo ships the nginx config for all four subdomains.

```bash
cd /opt/syndicate/backend

sudo cp deploy/nginx/syndicate-devnet.conf /etc/nginx/sites-available/syndicate-devnet
sudo ln -s /etc/nginx/sites-available/syndicate-devnet /etc/nginx/sites-enabled/syndicate-devnet
sudo nginx -t
sudo systemctl reload nginx
```

Expected output from `nginx -t`: `syntax is ok` and `test is successful`.

---

## 4. Issue TLS certificates with certbot

Install certbot and the nginx plugin, then issue certs for all four subdomains in one command:

```bash
sudo apt-get install -y certbot python3-certbot-nginx

sudo certbot --nginx \
  -d gateway.devnet.satoshitable.fun \
  -d api.devnet.satoshitable.fun \
  -d config.devnet.satoshitable.fun \
  -d price.devnet.satoshitable.fun \
  --non-interactive --agree-tos \
  -m hello@satoshitable.fun
```

certbot will:
1. Issue a Let's Encrypt certificate covering all four domains
2. Automatically edit the nginx config to add SSL directives
3. Add HTTP→HTTPS redirects
4. Set up a cron / systemd timer for automatic renewal

Verify renewal works:

```bash
sudo certbot renew --dry-run
```

---

## 5. Verify endpoints

Run from your **laptop**:

```bash
# Action-feed
curl -sf https://api.devnet.satoshitable.fun/healthz && echo OK

# Config
curl -sf https://config.devnet.satoshitable.fun/healthz && echo OK

# Signed-price feed — health + price sample; admin routes must 404
curl -sf https://price.devnet.satoshitable.fun/health | python3 -m json.tool
curl -sf "https://price.devnet.satoshitable.fun/prices?symbols=BTCUSD" | head -c 200; echo
curl -o /dev/null -w "%{http_code}\n" -s https://price.devnet.satoshitable.fun/metrics            # expect 404
curl -o /dev/null -w "%{http_code}\n" -s https://price.devnet.satoshitable.fun/internal/failover/status  # expect 404

# Gateway WebSocket (requires wscat: npm i -g wscat)
wscat -c wss://gateway.devnet.satoshitable.fun
# Expect: {"type":"challenge","nonce":"…"}  — Ctrl-C to exit
```

Run from the **VPS** for the gateway health check:

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

> **CORS:** `satoshitable.fun` calling `*.devnet.satoshitable.fun` is cross-origin. If the browser blocks requests, add `add_header Access-Control-Allow-Origin "https://satoshitable.fun";` to the relevant nginx server blocks and reload nginx. The signed-price feed already returns `Access-Control-Allow-Origin: *` — do **not** add a CORS header in the price nginx block (duplicate header breaks browsers).

---

## 7. Day-2 operations

```bash
# Edit vhost config
sudo nano /etc/nginx/sites-available/syndicate-devnet
sudo nginx -t && sudo systemctl reload nginx

# Check cert expiry
sudo certbot certificates

# Force renewal (normally automatic)
sudo certbot renew

# Tail nginx logs
sudo tail -f /var/log/nginx/error.log
sudo tail -f /var/log/nginx/access.log
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
| certbot fails: `Connection refused` on port 80 | Hetzner Cloud Firewall missing inbound TCP 80 rule |
| certbot fails: `DNS problem` | DNS not propagated yet — wait and retry |
| `502` on `api.devnet…` | `curl http://127.0.0.1:18080/healthz`; `$COMPOSE_APP up -d action-feed` |
| `502` on `gateway.devnet…` | `curl http://127.0.0.1:18081/healthz`; `$COMPOSE_APP up -d gateway` |
| `502` on `config.devnet…` | `curl http://127.0.0.1:18085/healthz`; `$COMPOSE_APP up -d config` |
| `502` on `price.devnet…` | `curl http://127.0.0.1:18088/health`; `$COMPOSE_APP up -d signed-price-server` |
| `price.devnet…/metrics` returns 200 | `location ~* ^/(internal\|metrics)` block missing — check nginx config and reload |
| WebSocket drops after 60 s | Add `proxy_read_timeout 3600s; proxy_send_timeout 3600s;` to the gateway server block |
| Browser CORS errors from `satoshitable.fun` | Add `add_header Access-Control-Allow-Origin "https://satoshitable.fun";` to the relevant nginx blocks |

---

## Done

When §5 passes, devnet backend services are live on `*.devnet.satoshitable.fun`.

See also: [README.md](./README.md) · [03_BACKEND_DEPLOYMENT.md](./03_BACKEND_DEPLOYMENT.md) · [../frontend/INTEGRATION_GUIDE.md](../frontend/INTEGRATION_GUIDE.md)
