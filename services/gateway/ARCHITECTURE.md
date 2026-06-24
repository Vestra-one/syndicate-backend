# Service: `gateway` — Edge, WebSocket Fan-out & Wallet Auth

**Stack:** TypeScript/Node. **Trust role:** transport + identity at the edge; **never** an outcome authority. **Implements:** `05 §3,§8`; `06 §4,§9,§10`.

> The only service clients talk to directly. It authenticates wallets, enforces geofencing, relays signed intents to `match-engine`, and fans out authoritative state/public events back. It holds optimistic views but the engine is the sole arbiter.

---

## Responsibilities (owns)
- **Wallet auth:** nonce → client signs → verify signature → session; the wallet is match identity (`05 §3`).
- **Geofencing:** block connections from restricted jurisdictions at connect/auth (`08 OQ18`).
- **WebSocket transport:** low, consistent latency; fan-out of authoritative state to the 2–5 players; relay of signed player intents to `match-engine`.
- **Optimistic UI support** with server-authoritative reconciliation (server clock wins).
- Rate-limiting, connection/presence, reconnection plumbing.

## Non-responsibilities
- **No betting legality, timers, or outcomes** (→ `match-engine`/`shared`).
- No custody, no oracle, no decryption.
- Does not broadcast the public spectator feed (that read path is `action-feed`); gateway serves the *players'* authoritative channel.

## Internal structure (suggested)
```
gateway/src/
  auth/         # nonce, signature verify, sessions
  geo/          # geofencing at connect
  ws/           # socket lifecycle, presence, reconnection
  relay/        # intent forwarding to match-engine, state fan-out
  ratelimit/
  index.ts
```

## Interfaces
- **In:** client WS (auth, signed intents, pre-signed default config); authoritative state/events from `match-engine`.
- **Out:** signed intents to `match-engine`; reconciled state to clients; auth/session context to `matchmaking`.

## Invariants & failure modes
- Timing fairness is governed by the **server clock** in `match-engine`, never the client (anti latency-exploit, risk S7).
- Never forward an unsigned or post-deadline intent; never expose another player's sealed prediction.
- Disconnect = inaction downstream (engine applies pre-signed default / safe auto-action); gateway just plumbs reconnect.

## Dependencies
`match-engine`, `matchmaking`, `config` (geofence list, limits).

## Testing
- Auth/signature + session expiry; geofence allow/block.
- Latency/jitter simulation: fairness unaffected (server-clock authority).
- Reconnection mid-match restores state; no double-intent on retry.

## AI-agent rules
- Edge only: never compute or cache an outcome, never trust client timing.
- Any new client message maps to a **signed** engine intent or a read; validate before relay.
- Keep player channel (here) separate from the public feed (`action-feed`); never leak sealed data.
