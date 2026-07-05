# Game-server bug report + patch handoff

Date: 2026-07-05 · Found while debugging live-table play on devnet (`api.devnet.satoshitable.fun`).
Patch file: `backend-fixes.patch` (same directory), based on `syndicate-backend` commit `82895e9`.
All three fixes are in `services/game-server`; `cargo check -p syndicate-game-server` passes.

## Critical: every player action is rejected — "prev_head mismatch"

**No `PlayerAction` event exists in any devnet match journal.** Every bet any player has
ever sent was rejected, then the 25s timeout auto-folded them. Matches observed:
`08be5837`, `bdb221af`, `dbdb75f9` — in each one the small blind was timeout-folded
without their action ever landing, and the journals contain only `timeout.default`.

Cause (chicken-and-egg):

1. `validate_intent` (match-engine `service.rs`) requires the signed intent's `prev_head`
   to equal the engine's **live** chain head.
2. At live start the engine appends genesis/blind events → the head moves.
3. But `match_view` (`view.rs`) serves `"head": row.event_head` / `"last_seq": row.event_count`
   — the **stale in-memory DB row copy** (observed serving `last_seq: 0` while the journal
   held seq 1+). The snapshot is the only place a client can learn the head before acting,
   because the `action` frame (which carries `head_hex`) is only broadcast after a
   *successful* action.
4. So the first act of every match signs a stale head → `InvalidIntent("prev_head mismatch")`
   → error frame → dead table.

**Fix (view.rs):** serve `rt.head()` / `rt.events().len()` when the runtime is active,
falling back to the row fields otherwise.

**Deeper detail (why clients can't self-recover):** `append_event` numbers events from
`events.len()`, so the genesis `MatchStarted` event is **seq 0** — and both the WS backfill
and `GET /matches/{id}/events` filter `WHERE seq > since` with a floor of 0, so **seq 0 is
unfetchable by any client**. Its hash (which folds in the server-side `fencing_token`, so
it can't be recomputed client-side) is exactly the head the first act must sign. Until the
view fix deploys, the only client-side escape is `register_default_policy` — the one signed
intent with no `prev_head` check — which mints journal event seq 1; the frontend now does
this at live start as a temporary bootstrap. Consider also: start event seq at 1, or accept
`since=-1`, so genesis is observable.

## High: `your_turn` is unrecoverable — refresh/reconnect = guaranteed timeout fold

`your_turn` is broadcast exactly once when a turn opens. The snapshot carries `to_act` but
not `to_call` / `min_raise_to` / `deadline_ms`, so a client that refreshes or drops its
socket mid-turn can never recover the turn and is silently timeout-folded. With real funds
at stake this is a design-level problem, not a UX nit.

**Fix (runtime.rs):** factor a shared `turn_view()` (same fields, same TRUE deadline as the
broadcast) and inject it as `"turn"` into the `Cmd::Snapshot` reply. Because the REST
`GET /v1/matches/{id}` handler routes through the same `Cmd::Snapshot` path, one injection
point fixes both the WS snapshot and the REST detail.

## Medium: re-subscribe double-delivers frames

`Conn::spawn_forwarder` does `self.subs.insert(key, task)` — replacing the map entry but
never aborting the previous forwarder task, so a client that re-subscribes to the same
channel receives every frame twice (and leaks a task per re-subscribe).

**Fix (ws.rs):** abort the replaced task.

## Not patched — needs backend-team decisions

1. **Street transitions are silent.** When a street closes on the timer with nobody acting,
   no frame is broadcast (no `event`, no `action`) — verified by a subscriber connected
   across a street boundary. Clients can only discover street changes by polling REST.
   Live `timeout.default` events are journal-only too (they arrive on backfill but are not
   broadcast when they happen). Suggest broadcasting an `action`-style frame (or at least
   the `event`) from `on_live_tick` after `force_resolve_street` / `apply_timeout_default`.
2. **`round` in the view freezes** at the last *betting* street (e.g. served `round: 1`
   while the match's own street schedule was in street 2). If `round` is meant to track the
   schedule clock, it should be derived from it; if it means "betting street", document that.
3. **`your_turn` broadcasts to all match subscribers**, including unauthenticated
   spectators — leaks `to_call`/`min_raise_to` and relies on clients to filter by seat.
   Consider targeting it to the acting seat's connection(s).
4. **`seat_update`/`lobby_delta` spam at lock:** ~400 duplicate frames in ~4s observed for
   match `bdb221af` (one pair every ~23 ms).
5. **Seal window too short in practice:** with a ~17–20s window and two wallet prompts
   (on-chain commitment + intent signature), players consistently fail to seal — every
   devnet match settled with both players defaulted to `spot`.
6. **Settlement `voided emergency`:** match `bdb221af` went `settlement_pending` →
   ~5 minutes later `voided { kind: "emergency" }`. Worth checking the chain-worker logs
   for why that settlement failed.

## How to reproduce the critical bug (pre-patch)

1. Two wallets join a table; let it go live.
2. First-to-act signs a bet. The client's `prev_head` comes from the snapshot (`row.event_head`).
3. Server replies `error { code: "bad_action", msg: 'InvalidIntent("prev_head mismatch")' }`.
4. 25s later: `timeout.default` fold.

The frontend now works around 1 (tracks head from backfilled event hashes + re-subscribes at
live start) and 2 (reconstructs the turn from REST with an estimated deadline), but both
workarounds are strictly worse than the server fixes and should be considered temporary.
