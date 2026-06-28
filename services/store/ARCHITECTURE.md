# syndicate-store Architecture

`syndicate-store` owns the persistence contract for gameplay logs, replay
recovery, and read-model projections.

## Production Model

Production persistence is Postgres-first:

- `match_events` is the canonical append-only gameplay log.
- `(match_id, seq)` is the unique event ordering key.
- `prev_hash` and `hash` preserve the same tamper-evident chain used by the
  Rust in-memory and file stores.
- `outbox_events` is written in the same transaction as match events and drives
  NATS/object-store/API side effects.
- `settlement_attempts` is the idempotent retry ledger for Solana settlement
  submissions and VOID/refund fallback.
- `settlement_dead_letters` is the operator inspection queue for unsafe states
  where no funds should be released automatically.
- `vault_reconciliations` and `custody_ledger` preserve the zero-drift custody
  invariant.
- `replay_bundles` records exported object-storage bundles for lifetime gameplay
  log retention.
- `match_snapshots` stores recovery checkpoints so an engine can load the latest
  root and replay only later events.
- `live_games`, `match_history`, and `profile_stats` are rebuildable projections
  tracked by `read_model_checkpoints`.

The SQL source of truth is:

```text
services/store/migrations/0001_production_persistence.sql
```

The migration text is exposed from Rust as `syndicate_store::POSTGRES_SCHEMA_V1`.
The production SQL statements for lease acquire/renew, fenced event append,
outbox insertion, snapshot write, and recovery replay are exposed from
`syndicate_store::postgres`.

## Runtime Writes

The match-engine service must write command results as one database transaction:

1. Lock the match row and validate the active fencing token.
2. Read the current `(event_count, event_head)`.
3. Insert the next `match_events` row with `seq = event_count`.
4. Update `matches.event_count` and `matches.event_head`.
5. Insert an `outbox_events` row for downstream publication.
6. Commit.

No service should publish to NATS, object storage, or WebSocket fan-out before
the transaction commits. Outbox consumers can retry without risking a dual-write
gap.

## Read Models

Projection workers write `live_games`, `match_history`, `profile_stats`, and
`replay_bundles` through idempotent upsert contracts in `syndicate_store::postgres`.
Each worker advances `read_model_checkpoints` only after its projection writes
commit. These tables are caches: they can be truncated and rebuilt from
`match_events`, `settlements`, and replay bundle exports.

## Recovery

A crashed engine on another node recovers by reading `match_events` ordered by
`seq`, verifying the hash chain from the genesis hash or latest snapshot, and
replaying events into the deterministic match core. Read models are disposable:
if they drift or the projection code changes, reset their checkpoint and rebuild
from `match_events` plus settlement/replay bundle rows.

## Development Backends

`InMemoryStore` and `FileStore` remain useful for unit tests, local fixtures, and
single-process experiments. They are not the production persistence backend.
