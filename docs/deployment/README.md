# Syndicate v2 — deployment docs

The v2 backend deploys as **3 containers + Postgres** (game-server, chain-worker,
signed-price-server), fronted by a reverse proxy. Start here:

| Guide | What it covers |
|---|---|
| [DEPLOYMENT.md](./DEPLOYMENT.md) | **The authoritative runbook** — topology, prerequisites, VPS bootstrap, secrets, program deploy, DB migrate, app bring-up, validation, ops runbook, capacity/mainnet deltas. |
| [08_HOST_NGINX_TLS.md](./08_HOST_NGINX_TLS.md) | The edge/TLS step in detail: host systemd nginx + certbot proxying to the loopback-published containers (the default when the VPS already runs nginx for other services). |
| [../../deploy/secrets/README.md](../../deploy/secrets/README.md) | The four secret files, how to generate them, permissions (`chmod 644`), and rotation. |
| [../frontend/INTEGRATION.md](../frontend/INTEGRATION.md) | Frontend integration — REST + WS reference, auth, sealing, betting, reconnect, claims. Hand this to the FE team along with `idl/syndicate_program.json`. |

Config template: [`deploy/.env.example`](../../deploy/.env.example). Compose files:
`deploy/docker-compose.yml` (+ `deploy/docker-compose.devnet.yml` overlay). The current
on-chain facts (program id, chips mint, treasury) live in [DEPLOYMENT.md](./DEPLOYMENT.md)
and `deploy/.env`.

> The v1 guides (`01_…`–`04_…`, Caddy, the `gateway|api|config|matchmaking` subdomain model,
> NATS/Redis/Pyth) were removed in the v2 pass. **Trust the code, not old docs** — see the
> repo-root `CLAUDE.md`.
