# Service: `matchmaking` — Queues, Rooms & Seating

**Stack:** TypeScript/Node. **Trust role:** forms tables and gates seats; capital finality is on-chain. **Implements:** `05 §2,§4,§5`; `06 §9`; decisions `08 OQ13,OQ14,OQ15`.

> Forms public matches and private rooms, enforces the **deposit-to-enter** anti-spam gate, applies rating buckets and Sybil resistance, and assigns seats. Tables fill **manually** (scheduled/organic) — **no house bots**, ever.

---

## Responsibilities (owns)
- **Public matchmaking:** tier + feed + token selection → queue → form/assign a table from `config`.
- **Private rooms:** create (feed+token+tier), Room ID, invite-only join, host cancel, host-disconnect rules.
- **Deposit-to-enter gate:** a seat is offered only after `programs` reports **deposit finality** (anti-spam / anti-Sybil flood) (`05 §4`).
- **Rating buckets** so casual players aren't farmed; **progressive Sybil resistance** and active trust-safety admission enforcement (`08 OQ15`).
- Fill windows, min-2 start, seat-reservation race resolution by deposit-finality order; refund-on-not-filled trigger to `programs`.
- Launch surface: USDC, 3 buy-in tiers, **no-stakes practice mode** (`08 OQ13`).

## Non-responsibilities
- No vault movement (→ `programs`); it *waits on* finality.
- No gameplay (→ `match-engine`); no enforcement actions (it consumes `trust-safety` signals).
- No live-dashboard rendering (→ `action-feed`).

## Internal structure (suggested)
```
matchmaking/src/
  public/        # queue, bucketing, table formation
  rooms/         # private room lifecycle, host controls
  seating/       # deposit-finality gate, race resolution, fill windows
  sybil/         # heuristics, PoP hooks (progressive)
  index.ts
```

## Interfaces
- **In:** auth/session from `gateway`; deposit-finality events from `programs`; risk signals from `trust-safety`; tiers/feeds/limits from `config`.
- **Out:** formed-table + bound `MatchConfig` to `match-engine`; refund triggers to `programs`; seat/lobby state to `gateway`.

## Invariants & failure modes
- **No seat without finalized deposit.** No exceptions, both modes.
- A wallet under active trust-safety enforcement must not be seated in public tables or private rooms.
- **No bots** seeded as players (integrity > cold-start) (`08 OQ14`).
- Not-filled by deadline → VOID + full refund; host cancel before LIVE → full refunds.

## Dependencies
`programs`, `config`, `trust-safety`, `gateway`.

## Testing
- Seat-race correctness under concurrent deposits; finality-gated seating.
- Active enforcement denies public and private-room seating.
- Fill-window / min-2 / cancel / host-disconnect flows → correct refunds.
- Bucketing + Sybil heuristics; practice-mode isolation (no real capital).

## AI-agent rules
- Eligibility = finalized deposit; never seat optimistically.
- Never add automated/bot players to fill tables.
- All tiers/limits/rooms params come from `config`; enforcement logic stays in `trust-safety` (consume its signals here).
