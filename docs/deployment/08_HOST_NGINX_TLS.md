# 08 — Host nginx + TLS (v2)

> The v2 edge runbook. Run as the deploy user on the VPS **after** [DEPLOYMENT.md](./DEPLOYMENT.md) §7
> passes (app containers healthy on loopback). It replaces the removed v1 domain/TLS guide —
> v2 collapses the old four subdomains into **one API + the price feed**.

## Why host nginx (not the bundled container)

The VPS already runs a **host systemd nginx** that owns 80/443 for other services. v2 ships
a Docker `nginx` service too, but it is **opt-in** (compose profile `edge`) precisely so it
stays off here — two proxies bound to 80/443 is the failure you hit following the old flow.

The v2 app containers publish to **loopback only**:

| Public hostname | VPS loopback port | Service |
|---|---|---|
| `https://api.<domain>` | `127.0.0.1:18080` | game-server — REST `/v1/*` **and** WebSocket `/v1/ws` |
| `https://price.<domain>` | `127.0.0.1:18088` | signed-price-server — **read-only** public feed |

The host nginx terminates TLS and reverse-proxies to those. Everything else (chain-worker
`127.0.0.1:18084`, Postgres) stays on loopback and is never exposed.

> **Read-only price feed.** The vhost returns `404` for `/internal/*` and `/metrics` — those
> failover/admin routes are unauthenticated and must never reach the internet.

## 1. Prerequisites

- DEPLOYMENT.md §7 done — `curl -sf http://127.0.0.1:18080/healthz` and
  `http://127.0.0.1:18088/health` both return on the VPS.
- The bundled edge container is **not** running: `docker ps` shows no `syndicate-nginx-1`,
  and nothing publishes 80/443. (If it is: `docker compose ... --profile edge down` / never
  pass `--profile edge`.)
- DNS: `api.<domain>` and `price.<domain>` A-records → VPS IP (the `*.devnet` Netlify
  wildcard covers `api.devnet…`/`price.devnet…`). Confirm with `dig +short api.<domain> A`.
- Firewall: **Hetzner Cloud Firewall** inbound 22/80/443 only. Docker writes iptables
  directly and bypasses `ufw`, so the cloud firewall is the real gate — `ufw allow 18080`
  does nothing, and that is intended: the app ports must stay private.

## 2. Install the vhost

The repo ships [`deploy/nginx/syndicate-v2-host.conf`](../../deploy/nginx/syndicate-v2-host.conf)
(`api.` → `127.0.0.1:18080` incl. `/v1/ws` upgrade; `price.` → `127.0.0.1:18088`, read-only,
`/internal|/metrics` → 404).

```bash
cd /opt/syndicate/backend
# EDIT the two `server_name` lines for your domain (defaults: api./price.devnet.satoshitable.fun)
sudo cp deploy/nginx/syndicate-v2-host.conf /etc/nginx/sites-available/syndicate-v2
sudo ln -s /etc/nginx/sites-available/syndicate-v2 /etc/nginx/sites-enabled/syndicate-v2
sudo nginx -t && sudo systemctl reload nginx
```

`nginx -t` must print `syntax is ok` / `test is successful`. The vhost defines only
`listen 80` — certbot adds the 443 block in the next step, so it is valid before any cert exists.

## 3. Issue TLS certificates

```bash
sudo apt-get install -y certbot python3-certbot-nginx
sudo certbot --nginx \
  -d api.devnet.satoshitable.fun \
  -d price.devnet.satoshitable.fun \
  --non-interactive --agree-tos -m hello@satoshitable.fun
```

certbot issues one cert covering both names, rewrites the vhost with the `listen 443 ssl`
+ cert directives and an HTTP→HTTPS redirect, and installs a renewal timer.
Verify: `sudo certbot renew --dry-run`.

## 4. Verify (from your laptop)

```bash
curl -sf https://api.devnet.satoshitable.fun/healthz && echo API_OK
curl -sf https://api.devnet.satoshitable.fun/v1/config | python3 -m json.tool | head
curl -sf https://price.devnet.satoshitable.fun/health && echo PRICE_OK

# admin/metrics routes on the price feed must be blocked
curl -o /dev/null -w "%{http_code}\n" -s https://price.devnet.satoshitable.fun/metrics   # expect 404

# WebSocket (npm i -g wscat)
wscat -c wss://api.devnet.satoshitable.fun/v1/ws
# expect a challenge frame — Ctrl-C to exit
```

## 5. CORS for the SPA

`satoshitable.fun` calling `api.<domain>` is cross-origin. The game-server sets CORS from
`CORS_ALLOWED_ORIGINS` in `deploy/.env` — add the SPA origin there and
`docker compose ... up -d game-server`. Do **not** also add an `Access-Control-Allow-Origin`
header in nginx (duplicate header breaks browsers). The price feed already sends `*`.

## 6. Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `nginx -t`: `host not found in upstream game-server` | You installed the **container** template (`syndicate.conf.template`, which uses Docker DNS names) onto the host. Use `syndicate-v2-host.conf` — it proxies to `127.0.0.1:18080/18088`. |
| `bind() to 0.0.0.0:80 failed (address already in use)` | The bundled edge container is running. `docker compose ... --profile edge down`; never pass `--profile edge` on this VPS. |
| `curl http://<public-ip>:8080` refused | Expected. App ports are loopback-only and the Hetzner firewall blocks everything but 22/80/443. Reach the app via `https://api.<domain>` (§4) or `127.0.0.1:18080` on the VPS. |
| certbot: `Connection refused` on port 80 | Hetzner Cloud Firewall missing inbound TCP 80, or DNS not pointing at the VPS yet. |
| `502` on `api.<domain>` | `curl http://127.0.0.1:18080/healthz` on the VPS; `docker compose ... up -d game-server`. |
| `502` on `price.<domain>` | `curl http://127.0.0.1:18088/health`; `docker compose ... up -d signed-price-server`. |
| `price.<domain>/metrics` returns 200 | `location ~* ^/(internal\|metrics)` block missing — reinstall the vhost and reload. |
| WebSocket drops after 60s | The `/v1/ws` block already sets `proxy_read_timeout 3600s` — confirm you copied the shipped vhost, not a hand-written one. |
| container secret `Permission denied (os error 13)` | Secret files must be readable by the container's unprivileged user: `chmod 644 deploy/secrets/{postgres-password,price-signer.key,session-signing-key,operator-keypair.json}`. |

## Done

When §4 passes, the v2 backend is live on `https://api.<domain>` (REST + WS) and
`https://price.<domain>` (read-only feed), fronted by the host nginx alongside your other
services.

See also: [DEPLOYMENT.md](./DEPLOYMENT.md) · [../frontend/INTEGRATION.md](../frontend/INTEGRATION.md)
