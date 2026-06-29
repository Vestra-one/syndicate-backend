# store — Postgres Persistence

Rust query layer + SQL migrations.

## Key files
- `migrations/0001_production_persistence.sql` — canonical schema
- `src/postgres.rs` — SQL query strings, `LOAD_MATCH_SETTLEMENT_CONTEXT_SQL`
- `src/lib.rs` — store traits + types

## Schema notes (matches table)
Includes `dead_money_chips bigint NOT NULL DEFAULT 0` (added in v2 — feeds into settlement conservation).
The `LOAD_MATCH_SETTLEMENT_CONTEXT_SQL` query selects `m.dead_money_chips`.

## Patterns
- All chip amounts are stored as `bigint` (i64 in Rust, maps to `Chips = i64`).
- Match state is normalized: `matches`, `seats`, `actions` tables.
