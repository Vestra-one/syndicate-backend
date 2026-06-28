# Service: `action-feed` — Public Match Feed & Live-Games Dashboard

**Stack:** TypeScript/Node. **Trust role:** read-only projection; **never** a source of truth or a leak vector. **Implements:** `04 §20`; `05 §2,§9,§14`; `06 §13`; decisions `08 OQ9,OQ20`.

> Projects the signed action log into a public, pseudonymous stream and ranks live games for discovery. Isolated read path — it can never contend with or stall gameplay. It is also the seam the deferred spectator market would later build on.

---

## Responsibilities (owns)
- **Public event stream** per match: feed price at each action, bet/raise/call/all-in **amounts**, pot evolution, fold events, round transitions, settlement `S`, pot awards, and predictions **after** they auto-open at match end (`05 §14`).
- **Post-match reveal projection:** surface **all** opened numbers (incl. folded/early-out) for the emotional beat (`08 OQ9`).
- **Live-games dashboard:** rank live games by popularity (a "rated" score from spectator count + activity), **sortable by game time, pot size, buy-in, feed,** etc. (`08 OQ20`).
- Caching + scalable fan-out to large spectator counts.
- Rebuildable read models for active games, historical games, replay bundles,
  profiles, and leaderboards.
- HTTP read APIs for active games, history, replay, profiles, leaderboards, and
  health checks.
- WebSocket public-event broadcast for spectators with match-level subscriptions.
- Replay bundle upload through an object-store abstraction; filesystem/local and
  in-memory implementations are available for day-0/dev wiring.

## Non-responsibilities
- No outcome computation, no custody, no gameplay authority.
- **No wagering** (spectator prediction market is deferred — seam only, `04 §21`).
- Never the players' authoritative channel (that's `gateway`).

## Internal structure (suggested)
```
action-feed/src/
  project/       # action-log → public event projection (redaction rules)
  stream/        # spectator fan-out (separate tier, backpressure-isolated)
  dashboard/     # ranking score + sort/filter API
  projections/   # checkpointed live/history/replay/profile read models
  server/        # HTTP read APIs + WebSocket public event broadcast
  object-store/  # replay bundle uploads (filesystem/local, S3-compatible adapter)
  cache/
  index.ts
```

## Interfaces
- **In:** public event stream from `match-engine`; settlement record from `settlement`; opened predictions at match end.
- **Out:** spectator WS/HTTP stream; dashboard list (ranked/sortable) to clients.

## Invariants & failure modes (integrity guards — non-negotiable)
- **Never expose a sealed prediction before the time-lock opens**, nor queued intents, pre-signed defaults, or PII (risk S9).
- Exposes only information already public at the table → grants no edge to active players or colluders.
- Attribution is **pseudonymous** (wallet/handle).
- **Hard isolation:** separate read path/tier; degradation here never affects `match-engine`/`gateway`.

## Dependencies
`match-engine` (events), `settlement` (results), `config`.

## Testing
- Redaction tests: sealed predictions/intents/PII never appear pre-open (fuzz the projector).
- Isolation/load: spectator fan-out under high count does not affect gameplay latency.
- Dashboard ranking/sort correctness; post-match reveal completeness.
- Projection rebuild tests: checkpoint monotonicity, replay redaction, profile
  stat aggregation, and leaderboard ordering.

## AI-agent rules
- Treat this as an **untrusted-output** surface: default-deny, allow-list only public fields; when unsure whether a field is safe, **don't expose it**.
- Read-only projection only — never write game state or compute outcomes.
- Keep it isolated from the gameplay path; never share a bottleneck with `match-engine`.
