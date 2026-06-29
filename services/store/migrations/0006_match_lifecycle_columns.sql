-- Phase 05: match lifecycle columns the backend now writes itself.
--
-- Historically an indexer "created match rows externally". v1 has no indexer, so
-- the backend is the sole writer of match rows: matchmaking on a verified create,
-- the orchestrator on begin_live. These columns project the on-chain lifecycle
-- timing + a lobby room-state machine for the registry/worker.
--
-- Capital safety NEVER depends on these projections (the authoritative seat set
-- for begin_live comes from getProgramAccounts; settlement/void read PDAs).

-- scheduled_end_ts is unknown until begin_live (it is pinned near the seal round
-- on-chain). Make it nullable so a row can be inserted at create-time; a CHECK
-- below guarantees it is populated before the match is Live/Settled so that
-- settlement (LOAD_MATCH_SETTLEMENT_CONTEXT_SQL) never reads a NULL deadline.
ALTER TABLE matches ALTER COLUMN scheduled_end_ts DROP NOT NULL;

ALTER TABLE matches
    ADD COLUMN IF NOT EXISTS live_start_ts       timestamptz,
    ADD COLUMN IF NOT EXISTS lock_ts             timestamptz,
    ADD COLUMN IF NOT EXISTS seal_deadline_ts    timestamptz,
    ADD COLUMN IF NOT EXISTS fill_deadline_ts    timestamptz,
    ADD COLUMN IF NOT EXISTS sealed_count        smallint,
    ADD COLUMN IF NOT EXISTS nonseal_penalty_bps integer,
    ADD COLUMN IF NOT EXISTS void_kind           text,
    ADD COLUMN IF NOT EXISTS room_status         text;

COMMENT ON COLUMN matches.live_start_ts IS 'begin_live wall-clock; engine derives absolute street deadlines from this.';
COMMENT ON COLUMN matches.fill_deadline_ts IS 'Deadline to reach min players before void_before_start (FillingVoid).';
COMMENT ON COLUMN matches.seal_deadline_ts IS 'Sealing-phase seal deadline (seal_deadline_ts on-chain).';
COMMENT ON COLUMN matches.sealed_count IS 'Number of seats that sealed by begin_live; indexes payout arrays (engine_seat).';
COMMENT ON COLUMN matches.nonseal_penalty_bps IS 'Per-seat non-sealer penalty in bps, recorded at begin_live.';
COMMENT ON COLUMN matches.void_kind IS 'Terminal void classification mirroring on-chain VoidKind.';
COMMENT ON COLUMN matches.room_status IS 'Lobby projection state machine (UX-only): Filling/Sealing/Live/Settled/Void.';

-- Lobby projection state machine. UX-only; mirror the on-chain VoidKind names.
ALTER TABLE matches
    ADD CONSTRAINT matches_room_status_check
    CHECK (room_status IS NULL OR room_status IN ('Filling', 'Sealing', 'Live', 'Settled', 'Void'));

ALTER TABLE matches
    ADD CONSTRAINT matches_void_kind_check
    CHECK (void_kind IS NULL OR void_kind IN ('FillingVoid', 'UnderMinSealed', 'Emergency'));

ALTER TABLE matches
    ADD CONSTRAINT matches_sealed_count_nonneg
    CHECK (sealed_count IS NULL OR sealed_count >= 0);

ALTER TABLE matches
    ADD CONSTRAINT matches_nonseal_penalty_bps_range
    CHECK (nonseal_penalty_bps IS NULL OR nonseal_penalty_bps BETWEEN 0 AND 10000);

-- scheduled_end_ts must be set before the room is Live/Settled, so settlement never
-- reads a NULL deadline even though create-time inserts leave it NULL.
ALTER TABLE matches
    ADD CONSTRAINT matches_scheduled_end_set_when_live
    CHECK (
        room_status IS NULL
        OR room_status NOT IN ('Live', 'Settled')
        OR scheduled_end_ts IS NOT NULL
    );

CREATE INDEX IF NOT EXISTS matches_room_status_idx
    ON matches (room_status);
