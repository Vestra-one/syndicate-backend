-- v2 core schema: free-form creator params on matches, private rooms, seat candidacy,
-- create-intent reservations, signed price snapshots, runtime config, sessions.
--
-- NOTE: this file is executed statement-by-statement by psql (no wrapping transaction),
-- which ALTER TYPE ... ADD VALUE requires.

-- v2 lifecycle statuses (legacy values kept for existing rows).
ALTER TYPE match_status ADD VALUE IF NOT EXISTS 'filling';
ALTER TYPE match_status ADD VALUE IF NOT EXISTS 'sealing';
ALTER TYPE match_status ADD VALUE IF NOT EXISTS 'live';

-- Free-form params live on the match row now (no template requirement), and a match row
-- exists from the create-report onward (before lock), so template/end-time are nullable.
ALTER TABLE matches ALTER COLUMN config_id DROP NOT NULL;
ALTER TABLE matches ALTER COLUMN scheduled_end_ts DROP NOT NULL;

ALTER TABLE matches
    ADD COLUMN IF NOT EXISTS visibility text NOT NULL DEFAULT 'public'
        CHECK (visibility IN ('public', 'private')),
    ADD COLUMN IF NOT EXISTS creator_wallet text,
    ADD COLUMN IF NOT EXISTS room_code text,            -- plaintext, server-side only
    ADD COLUMN IF NOT EXISTS room_commitment bytea      -- sha256(code || creator), on-chain copy
        CHECK (room_commitment IS NULL OR octet_length(room_commitment) = 32),
    ADD COLUMN IF NOT EXISTS feed_symbol text,
    ADD COLUMN IF NOT EXISTS config_hash bytea
        CHECK (config_hash IS NULL OR octet_length(config_hash) = 32),
    ADD COLUMN IF NOT EXISTS buy_in_chips bigint,
    ADD COLUMN IF NOT EXISTS entry_fee_chips bigint NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS rake_bps integer,
    ADD COLUMN IF NOT EXISTS rake_cap_chips bigint,
    ADD COLUMN IF NOT EXISTS round_count smallint,
    ADD COLUMN IF NOT EXISTS round_durations_sec integer[],
    ADD COLUMN IF NOT EXISTS observation_windows_sec integer[],
    ADD COLUMN IF NOT EXISTS action_timeout_ms integer,
    ADD COLUMN IF NOT EXISTS time_bank_sec integer,
    ADD COLUMN IF NOT EXISTS small_blind bigint,
    ADD COLUMN IF NOT EXISTS big_blind bigint,
    ADD COLUMN IF NOT EXISTS min_players smallint,
    ADD COLUMN IF NOT EXISTS max_players smallint,
    ADD COLUMN IF NOT EXISTS seal_window_sec integer,
    ADD COLUMN IF NOT EXISTS begin_live_window_sec integer,
    ADD COLUMN IF NOT EXISTS fill_deadline_ts timestamptz,
    ADD COLUMN IF NOT EXISTS lock_ts timestamptz,
    ADD COLUMN IF NOT EXISTS seal_deadline_ts timestamptz,
    ADD COLUMN IF NOT EXISTS live_start_ts timestamptz,
    ADD COLUMN IF NOT EXISTS button smallint,
    ADD COLUMN IF NOT EXISTS button_seed bytea
        CHECK (button_seed IS NULL OR octet_length(button_seed) = 32),
    ADD COLUMN IF NOT EXISTS timelock_target bigint,
    ADD COLUMN IF NOT EXISTS void_kind text
        CHECK (void_kind IS NULL OR void_kind IN ('filling_void', 'emergency'));

-- One active room code at a time (codes are reusable after a room leaves Filling).
CREATE UNIQUE INDEX IF NOT EXISTS matches_active_room_code
    ON matches (room_code)
    WHERE room_code IS NOT NULL AND status = 'filling';

CREATE INDEX IF NOT EXISTS matches_lobby_idx
    ON matches (status, fill_deadline_ts)
    WHERE status = 'filling';

-- Backend-allocated on-chain match ids (PDA seeds).
CREATE SEQUENCE IF NOT EXISTS onchain_match_id_seq START 20000;

-- Create-room reservations: the backend hands the FE everything needed to build the
-- create_and_deposit tx; the reservation expires if the tx never lands.
CREATE TABLE IF NOT EXISTS match_intents (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    onchain_match_id bigint NOT NULL UNIQUE,
    creator_wallet text NOT NULL,
    params jsonb NOT NULL,
    room_code text,
    visibility text NOT NULL CHECK (visibility IN ('public', 'private')),
    expires_at timestamptz NOT NULL,
    consumed_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS match_intents_wallet_idx ON match_intents (creator_wallet, created_at);

-- Seat candidacy: every reported deposit txhash. Verified at finalized commitment, then
-- FCFS-promoted to confirmed (max_players) at lock time.
CREATE TABLE IF NOT EXISTS seat_candidates (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    match_id uuid NOT NULL REFERENCES matches(id),
    wallet text NOT NULL,
    tx_sig text NOT NULL UNIQUE,
    status text NOT NULL DEFAULT 'reported'
        CHECK (status IN ('reported', 'candidate', 'confirmed', 'rejected', 'not_confirmed', 'refunded')),
    reject_reason text,
    finalized_slot bigint,
    seat_index smallint,
    room_code_ok boolean,
    reported_at timestamptz NOT NULL DEFAULT now(),
    verified_at timestamptz
);

-- One live candidacy per wallet per match.
CREATE UNIQUE INDEX IF NOT EXISTS seat_candidates_wallet_active
    ON seat_candidates (match_id, wallet)
    WHERE status IN ('reported', 'candidate', 'confirmed');

CREATE INDEX IF NOT EXISTS seat_candidates_pending_idx
    ON seat_candidates (reported_at)
    WHERE status = 'reported';

CREATE INDEX IF NOT EXISTS seat_candidates_match_idx ON seat_candidates (match_id, status);

-- Signed spot prices captured by the game-server (seal-close snapshots for non-sealers,
-- display anchors). The full signed-price-server payload is retained for audit.
CREATE TABLE IF NOT EXISTS price_snapshots (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    match_id uuid NOT NULL REFERENCES matches(id),
    kind text NOT NULL CHECK (kind IN ('seal_close', 'settlement_ref')),
    feed_symbol text NOT NULL,
    price numeric NOT NULL,
    exponent integer NOT NULL,
    price_ts timestamptz NOT NULL,
    signed_payload jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (match_id, kind)
);

-- Bet-price display stamps: the live feed price at action-accept time. Kept OUTSIDE the
-- hash-chained canonical event bytes (player signatures don't cover them).
ALTER TABLE match_events
    ADD COLUMN IF NOT EXISTS feed_price numeric,
    ADD COLUMN IF NOT EXISTS feed_price_expo integer,
    ADD COLUMN IF NOT EXISTS feed_price_ts timestamptz;

ALTER TABLE match_seats
    ADD COLUMN IF NOT EXISTS sealed boolean NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS engine_seat smallint,
    ADD COLUMN IF NOT EXISTS prediction_source text
        CHECK (prediction_source IS NULL OR prediction_source IN ('sealed', 'spot')),
    ADD COLUMN IF NOT EXISTS seal_ciphertext bytea,
    ADD COLUMN IF NOT EXISTS seal_commitment bytea
        CHECK (seal_commitment IS NULL OR octet_length(seal_commitment) = 32),
    ADD COLUMN IF NOT EXISTS seal_timelock_target bigint,
    ADD COLUMN IF NOT EXISTS seal_chain_confirmed boolean NOT NULL DEFAULT false;

-- Admin-tunable runtime knobs (seal window default, geofence list, bounds overlays…).
CREATE TABLE IF NOT EXISTS runtime_config (
    key text PRIMARY KEY,
    value jsonb NOT NULL,
    updated_by text,
    updated_at timestamptz NOT NULL DEFAULT now()
);

-- Wallet sessions (sha256(token) stored; survives restarts).
CREATE TABLE IF NOT EXISTS sessions (
    token_hash bytea PRIMARY KEY CHECK (octet_length(token_hash) = 32),
    wallet text NOT NULL,
    expires_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS sessions_expiry_idx ON sessions (expires_at);
