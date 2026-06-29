# Cross-Server Failover Operations

This document covers deployment, load-balancer health checks, and runbook procedures for active/standby price signing across US East and Canada.

## Architecture

- **US East** (`config/config.us-east.toml`): primary signer for BTC/ETH (Coinbase `book_mid`); warm Binance USDC feed; standby for USDC.
- **Canada** (`config/config.canada.toml`): primary signer for USDC (Binance `book_mid`); warm Coinbase BTC/ETH feeds; standby for BTC/ETH.
- Both nodes share the same `ECDSA_PRIVATE_KEY`.
- Exactly one node signs a given symbol at a time (`failover.can_sign` in `/health`).

## Deployment checklist

1. Set `CONFIG_PATH` per region (`config.us-east.toml` / `config.canada.toml`).
2. Set `ECDSA_PRIVATE_KEY` identically on both nodes.
3. Set `FAILOVER_SHARED_SECRET` identically on both nodes (required in production).
4. Set `failover.peer_url` to the other region’s reachable base URL (HTTPS recommended).
5. Ensure NTP/chrony sync (<50ms skew) so signed timestamps stay monotonic across handoff.
6. Point clients at a global entry or implement reconnect when ticks stop (see Client routing).

## Load balancer health checks

Use `GET /health` — **do not** require WebSocket `connections > 0`.

Route new traffic to a node when, for symbols that node should serve:

```json
"failover": {
  "BTCUSD": { "can_sign": true, "state": "active", "role": "primary" }
},
"signing_leader": {
  "BTCUSD": "us-east-1"
}
```

Suggested probe logic:

- Node is **in pool** when `ok == true` OR when `failover.<symbol>.can_sign == true` for any symbol clients need from that pool.
- Prefer routing WS clients to the node where `signing_leader[symbol] == node_id` for subscribed symbols.

Per-symbol pools (recommended for mixed-primary deployments):

| Symbol  | Steady-state leader |
|---------|---------------------|
| BTCUSD  | us-east-1           |
| ETHUSD  | us-east-1           |
| USDCUSD | canada-1            |

During failover, `signing_leader` flips automatically in `/health`.

## Latency tuning

| Setting | Default | Notes |
|---------|---------|-------|
| `max_book_age_ms` | 1500 (regional configs) | Signing stops after this without BBO update |
| `promote_debounce_ms` | 100 | Debounce before delegating to peer |
| `recover_hysteresis_ms` | 500 | Fresh book duration before failback |
| `peer_request_timeout_ms` | 300 | Cross-region promote/demote timeout |
| `lease_ttl_ms` | 1000 | Delegated signing lease duration; the standby auto-stops when it lapses |
| `lease_renew_ms` | 200 | How often the primary renews the standby's lease while delegated |
| `clock_skew_margin_ms` | 500 | Safety margin (must be ≥ `peer_request_timeout_ms`) before a recovering primary resumes without a peer ack |

Total user-visible silence ≈ `max_book_age_ms` + debounce + peer RTT + one emit tick (~45ms).

### Recovery when the peer is unreachable

Delegation is a **time-bounded lease**: the standby may sign only while the lease
is unexpired, and the primary renews it every `lease_renew_ms` while delegated.
If the primary's book recovers but it **cannot reach the peer** (peer down / API
failing), it does not stay stuck — it resumes on its own after
`lease_ttl_ms + clock_skew_margin_ms`, by which point the standby's lease is
guaranteed expired and the standby has stopped. With a reachable peer, recovery
uses the faster demote path instead. A primary that cannot sign is exposed as
`failover_primary_not_signing_seconds{symbol}`; alert when it stays high.

## Internal API

All endpoints require header `X-Failover-Secret` when `FAILOVER_SHARED_SECRET` is set.

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/internal/failover/promote` | Primary asks standby to sign |
| POST | `/internal/failover/demote` | Primary asks standby to stop |
| GET | `/internal/failover/status` | Per-symbol state |

## Runbook

### Normal operation

- US East: `failover.BTCUSD.can_sign=true`, `failover.ETHUSD.can_sign=true`
- Canada: `failover.USDCUSD.can_sign=true`

### Coinbase stall (BTC/ETH)

1. US East transitions to `delegated`; Canada `BTCUSD`/`ETHUSD` `can_sign=true`.
2. Alert if `delegated` > 5s (`failover_handoffs_total`, logs).
3. LB should send new connections to Canada for BTC/ETH.

### Both books stale

- Neither node signs; `failover_both_stale_total` increments.
- Check Coinbase/Binance status; manual reconnect or forced handoff.

### Forced handoff (break-glass)

From bastion with shared secret:

```bash
curl -X POST -H "X-Failover-Secret: $SECRET" -H "Content-Type: application/json" \
  -d '{"symbols":["BTCUSD"],"epoch":99,"source":"ops"}' \
  https://price-canada.internal:8080/internal/failover/promote
```

Increment `epoch` above current value from `/internal/failover/status`.

### Rollback failover

1. Drain one node completely.
2. Set `failover.enabled=false` on the survivor; restart.
3. Re-enable only after both feeds are healthy to avoid dual-sign.

## Client routing

Failover signs on the active node’s local WebSocket hub. Clients on the silent node receive no new ticks until they reconnect to the active signer (or a global LB routes them there).

Recommended: client-side watchdog — if no tick for `2 * emit_interval_ms`, reconnect to the global endpoint or alternate region URL.

## Metrics

Prometheus (`/metrics`):

- `failover_state{symbol,state}`
- `failover_handoffs_total{symbol,direction}`
- `failover_peer_request_duration_seconds`
- `failover_blocked_signs_total{symbol}`
- `failover_both_stale_total{symbol}`
- `failover_primary_not_signing_seconds{symbol}`
