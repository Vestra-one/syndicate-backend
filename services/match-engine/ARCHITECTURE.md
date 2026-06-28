# Service: `match-engine` — Authoritative Game Engine

**Stack:** Rust (tokio). **Trust role:** authoritative for **ordering** gameplay; **not** trusted for outcomes. **Implements:** `04 §3,§5,§6,§7,§8,§15,§16,§17`; `06 §4,§6,§7`.

> One engine instance owns one match (single-writer, leased). It sequences actions, runs timers, posts blinds, tracks contributions, and emits a hash-chained signed log — the canonical input that `settlement`/`programs` later replay. It computes **no** payouts.

---

## Responsibilities (owns)
- The match **state machine** (`CREATED→FILLING→SEALING→LIVE(rounds)→SETTLEMENT_WINDOW→DECRYPT→SETTLED|VOID`).
- **Betting legality & turn order** (fold/check/call/bet/raise/all-in, min-raise, re-open rules, heads-up order) per `04 §7`.
- **Blinds/antes posted once**; button from VRF seed; round timing model (betting window → observation window) for the **configured** round count/durations.
- **Action timers + replenishing time bank**; **pre-signed default actions** (check/fold, check/call-any) executed on timeout — recorded as player-signed intents (`04 §8`).
- **Contribution tracking** per player across streets (the inputs `shared` later layers into side-pots).
- **Signed, hash-chained event log** (player intents + marked engine-authored events); snapshots for recovery.
- Disconnect/reconnect handling; all-in players never auto-folded.
- Detecting end conditions (uncontested win, all-in run-out) and handing off to settlement.

## Non-responsibilities
- **No pot/`S`/winner math** (→ `shared` via `settlement`).
- No custody (→ `programs`), no oracle price selection (→ settlement worker / Pyth path), no seal/decrypt (→ `timelock`), no socket transport (→ `gateway`).

## Internal structure (suggested)
```
match-engine/src/
  service.rs     # fenced runtime: leases, intent append, snapshots, replay
  sm/            # state machine + transitions
  betting/       # legality, turn order, min-raise, reopen, heads-up
  timers/        # action_timer + replenishing time_bank + pre-signed defaults
  log/           # append/verify signed intents (uses shared::log)
  lifecycle/     # rounds, blinds, end-condition detection, handoff
  lease/         # single-writer lease/fencing
  main.rs
```

## Interfaces
- **In:** validated player intents (via `gateway`); table+config at creation (from `matchmaking`/`config`); drand key availability (from `timelock`) at match end.
- **Out:** authoritative state + public events (to `gateway` and `action-feed`); the input bundle (log, contributions, seal refs, vrf seed, config) to `settlement` at match end.

## Invariants & failure modes
- **Single-writer per match** (lease/fencing) — no split-brain (`06 §4`).
- Server clock governs timers (no client-trusted timing → no latency exploit).
- Auto-resolution: **auto-check if nothing owed, auto-fold only when facing a bet** — never fold a free check.
- Unrecoverable desync / lease loss / log corruption → VOID from last verifiable state.
- Engine never reads a sealed prediction (it only holds ciphertext refs).

## Dependencies
`shared` (types, log, legality helpers), `timelock`, `config`.

## Testing
- State-machine exhaustiveness: every transition + every degenerate state in `04 §17`.
- Betting-legality property tests (min-raise, reopen, heads-up, sub-blind all-in).
- Timer/disconnect/pre-signed-default simulations; reconnect re-sync.
- Golden logs feed the `shared`/`settlement`/`programs` replay tests.
- Split-brain tests prove stale fencing tokens cannot append after lease handoff.
- Load smoke covers 2,000 fenced match runtimes without requiring deployment.

## AI-agent rules
- This service **orders**, it does not **decide outcomes** — never compute a pot or winner here.
- All game numbers come from `config`; never hard-code rounds/durations/timers.
- Every new event type: signed-or-marked-engine-authored, appended to the hash-chain, and replay-safe.
- Preserve single-writer and server-authoritative timing; both are anti-cheat foundations.
