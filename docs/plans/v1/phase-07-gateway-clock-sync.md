# Phase 07 — Gateway clock-sync + engine absolute deadlines + room-push

**Goal:** clients get real server time and engine absolute deadlines (not a synthesized 25s); lobby is pushed.

- **Status:** ⬜ not started
- **Depends on:** 06 (registry for room-push)
- **Parallel-safe with:** 09, 10
- **Checklist ref:** §4

---

## Context — why this phase exists

The gateway synthesizes `yourTurn.deadline = Date.now() + 25_000` and serves the lobby pull-only.
For a real-money timed game, clients need server-authoritative time and the engine's actual absolute
deadlines (seal/street/match/turn), plus pushed lobby updates. The match-engine already emits
multi-street deadlines (Phase H done) — wire them through rather than inventing them.

## Scope

**In:** `serverTime` in envelopes; forward engine absolute deadlines; `roomsUpdated`/`lobbyList` push.
**Out:** the engine's deadline computation (already done); the registry source (Phase 06).

## Files to touch

- `services/gateway/src/relay.ts`
- `services/gateway/src/server.ts`

## Patterns to reuse

- Pong handler: `relay.ts:39-41`.
- The synthesized deadline to REMOVE: `relay.ts:178` (`Number(p.deadline ?? Date.now() + 25_000)`), inside `normalizeEnginePayload` `:165-185`.
- Lobby pull handlers (data source today): `relay.ts:114-129` (`fetchLobby` → matchmaking `/rooms/:code`; `fetchQueueStatus` → `/queue/status`).
- Server clock: `server.ts:106-108` (`this.opts.now ? this.opts.now() : Date.now()`).
- Engine state fetch: `relay.ts:59` (`/internal/matches/:id/state`).

## Implementation steps

1. **Clock sync:** include `serverTime: now()` in the `pong` reply (`relay.ts:39-41`) and in outbound envelopes. Use the injected `server.ts:106-108` clock, not raw `Date.now()` scattered around.
2. **Forward engine deadlines:** in `normalizeEnginePayload`, stop synthesizing `Date.now()+25_000`. Pass through the engine-provided absolute deadlines: `sealEndsAt`, `bettingEndsAt`/`streetEndsAt`, `matchEndsAt`, and `yourTurnDeadline` (these derive from `live_start_ts` + template timings the engine already holds). If the engine omits one, surface it as absent — do not fabricate.
3. **Room-push:** add `roomsUpdated`/`lobbyList` messages pushed when the matchmaking registry mutates (Phase 06). Wire via the existing Redis pub/sub the relay already uses for match events; matchmaking publishes a `rooms` channel event on create/deposit/start, gateway fans it out. Keep `fetchLobby` as a pull fallback and action-feed `/active-games` for spectating.

## Acceptance criteria

- [ ] No `Date.now() + 25_000` (or any synthesized deadline) remains in the gateway.
- [ ] `pong` and envelopes carry `serverTime`.
- [ ] Clients receive engine absolute deadlines (`sealEndsAt`/`bettingEndsAt`/`matchEndsAt`/`yourTurnDeadline`) forwarded verbatim.
- [ ] Lobby updates are pushed (`roomsUpdated`) on registry mutation; pull still works.

## Verification

```bash
cd services/gateway && cargo test
grep -rn "25_000\|25000" services/gateway/src/   # expect no synthesized-deadline matches
# relay test: assert an envelope includes serverTime and the forwarded deadline (no fabrication)
```

## Risks & gotchas

- Clients compute countdowns as `deadline - serverTime + localClockOffset`; if the gateway fabricates a deadline the countdown is wrong and a player can be timed out unfairly — only forward real engine values.
- The room-push channel must be idempotent/last-writer-wins on the client (registry events can arrive out of order); include the room version/seat count so the client can discard stale updates.
