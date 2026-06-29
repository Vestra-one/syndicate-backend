# Phase 05 — Match-row persistence (store migration + writer)

**Goal:** the backend persists the match lifecycle to Postgres (no indexer to do it).

- **Status:** ✅ done & verified
- **Depends on:** —
- **Parallel-safe with:** 01, 02, 09, 10
- **Checklist ref:** §6

---

## Context — why this phase exists

The store has a read path (`LOAD_MATCH_SETTLEMENT_CONTEXT_SQL`) and an event-append path, but **no
match-row INSERT/UPSERT** — historically the indexer "created match rows externally." With the
indexer gone, the backend must write match rows itself: matchmaking on a verified create, the
orchestrator on `begin_live`. This phase adds the columns the registry/worker need plus the writer SQL.

## Scope

**In:** a new migration adding lifecycle columns; INSERT/UPSERT + begin_live UPDATE SQL + Rust fns.
**Out:** calling these from matchmaking/orchestrator (Phases 06/04).

## Files to touch

- new `services/store/migrations/0006_match_lifecycle_columns.sql`
- `services/store/src/postgres.rs` (+ new SQL consts + Rust fns)

## Patterns to reuse

- Migration naming `NNNN_description.sql`; existing files `0001..0005` in `services/store/migrations/`.
- `matches` table CREATE: `0001_production_persistence.sql:151-174` (existing cols incl. `dead_money_chips`, `scheduled_end_ts`, `status match_status`, lease + event-chain cols).
- `match_seats` CREATE: `:179-194`.
- Read query to keep working: `LOAD_MATCH_SETTLEMENT_CONTEXT_SQL` `postgres.rs:551-568`.
- Write idiom (CTE + outbox): `APPEND_MATCH_EVENT_WITH_OUTBOX_SQL` `postgres.rs:52-118`.

## Implementation steps

1. **Migration `0006`** — `ALTER TABLE matches ADD COLUMN`: `live_start_ts timestamptz`, `lock_ts timestamptz`, `seal_deadline_ts timestamptz`, `fill_deadline_ts timestamptz`, `sealed_count smallint`, `nonseal_penalty_bps integer`, `void_kind text`, `room_status text` (lobby projection: Filling/Sealing/Live/Settled/Void). Use nullable (set through lifecycle). Add CHECKs mirroring existing style where sensible (`sealed_count >= 0`).
2. **`INSERT_MATCH_SQL`** (on verified create): insert `matches` row from `(match_key, onchain_match_id, config_id, status, fill_deadline_ts, room_status='Filling', scheduled_end_ts placeholder)` — `scheduled_end_ts` is unknown until begin_live; either make it nullable in this migration or seed a sentinel and overwrite at begin_live (prefer making it nullable + a CHECK that it's set before Live).
3. **`INSERT_MATCH_SEAT_SQL`** (on verified deposit): insert `match_seats` row `(match_id, seat_index, wallet_address, deposit_signature, buy_in_chips, entry_fee_chips)`.
4. **`UPDATE_MATCH_ON_BEGIN_LIVE_SQL`**: set `live_start_ts`, `scheduled_end_ts`, `lock_ts`, `seal_deadline_ts`, `sealed_count`, `room_status='Live'`, `status` accordingly.
5. **Rust fns** in `postgres.rs` mirroring the existing query-fn style (params typed, errors mapped) — `insert_match`, `insert_match_seat`, `mark_match_live`, plus a `mark_match_terminal(void_kind|settled)`.
6. Confirm `LOAD_MATCH_SETTLEMENT_CONTEXT_SQL` still resolves (it doesn't read the new cols, but `scheduled_end_ts` nullability must not break it — it's set by begin_live before settlement).

## Acceptance criteria

- [ ] Migration `0006` applies cleanly on a fresh DB.
- [ ] A match row can be inserted (create), seats added (deposit), transitioned (begin_live), and marked terminal.
- [ ] Worker's `LOAD_MATCH_SETTLEMENT_CONTEXT_SQL` still returns a row for a Live match.
- [ ] Store crate tests pass.

## Verification

```bash
cd services/store && cargo test
# apply migrations against a scratch Postgres and assert the columns exist + writer fns round-trip
```

## Risks & gotchas

- If `matches.scheduled_end_ts` is currently `NOT NULL`, inserting at create-time (before begin_live) requires making it nullable or seeding a value — choose nullable + a "set before Live" CHECK to avoid a fake timestamp leaking into settlement.
- Keep the existing lease/event-chain columns and their defaults untouched — the worker relies on them.
