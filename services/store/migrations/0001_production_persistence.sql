-- Syndicate production persistence schema v1.
--
-- This migration is intentionally Postgres-first. Gameplay writes are append-only
-- events, read models are rebuildable projections, and side effects leave through
-- the transactional outbox written in the same database transaction as the event.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TYPE match_status AS ENUM (
    'created',
    'active',
    'locked',
    'settlement_pending',
    'settled',
    'voided'
);

CREATE TYPE outbox_status AS ENUM (
    'pending',
    'processing',
    'published',
    'dead_letter'
);

CREATE TYPE settlement_attempt_status AS ENUM (
    'pending',
    'submitted',
    'confirmed',
    'voided',
    'retry_scheduled',
    'dead_letter'
);

CREATE TABLE users (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    handle text NOT NULL UNIQUE,
    avatar_uri text,
    house text,
    chamber text,
    public_rank text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CHECK (handle = lower(handle)),
    CHECK (char_length(handle) BETWEEN 3 AND 32)
);

CREATE TABLE wallet_links (
    wallet_address text PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES users(id),
    chain text NOT NULL DEFAULT 'solana',
    verified_at timestamptz NOT NULL DEFAULT now(),
    hidden_from_public boolean NOT NULL DEFAULT true
);

CREATE TABLE profile_stats (
    user_id uuid PRIMARY KEY REFERENCES users(id),
    matches_played bigint NOT NULL DEFAULT 0,
    matches_won bigint NOT NULL DEFAULT 0,
    total_buy_in_chips bigint NOT NULL DEFAULT 0,
    total_payout_chips bigint NOT NULL DEFAULT 0,
    showdown_count bigint NOT NULL DEFAULT 0,
    fold_count bigint NOT NULL DEFAULT 0,
    achievement_count bigint NOT NULL DEFAULT 0,
    last_rebuilt_event_id uuid,
    updated_at timestamptz NOT NULL DEFAULT now(),
    CHECK (matches_played >= matches_won),
    CHECK (matches_played >= 0),
    CHECK (matches_won >= 0)
);

CREATE TABLE trust_safety_signals (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    wallet_address text NOT NULL REFERENCES wallet_links(wallet_address),
    signal_kind text NOT NULL,
    severity text NOT NULL,
    score numeric NOT NULL,
    evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    CHECK (signal_kind IN ('chip_dumping', 'bot_timing', 'sybil_cluster', 'co_seating', 'geofence', 'kyc')),
    CHECK (severity IN ('info', 'flag', 'ban')),
    CHECK (score >= 0),
    CHECK (jsonb_typeof(evidence) = 'object')
);

CREATE INDEX trust_safety_signals_wallet_idx
    ON trust_safety_signals (wallet_address, created_at DESC);

CREATE TABLE enforcement_actions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    wallet_address text NOT NULL REFERENCES wallet_links(wallet_address),
    action_type text NOT NULL,
    status text NOT NULL DEFAULT 'active',
    reason text NOT NULL,
    evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz,
    lifted_at timestamptz,
    CHECK (action_type IN ('seat_deny', 'temporary_ban', 'ban', 'kyc_required', 'geofence_block')),
    CHECK (status IN ('active', 'lifted', 'expired')),
    CHECK (jsonb_typeof(evidence) = 'object')
);

CREATE INDEX enforcement_actions_active_wallet_idx
    ON enforcement_actions (wallet_address, action_type, expires_at)
    WHERE status = 'active';

CREATE TABLE enforcement_appeals (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    action_id uuid NOT NULL REFERENCES enforcement_actions(id),
    wallet_address text NOT NULL REFERENCES wallet_links(wallet_address),
    status text NOT NULL DEFAULT 'open',
    statement text NOT NULL,
    reviewer text,
    resolution text,
    created_at timestamptz NOT NULL DEFAULT now(),
    resolved_at timestamptz,
    CHECK (status IN ('open', 'accepted', 'rejected'))
);

CREATE INDEX enforcement_appeals_wallet_idx
    ON enforcement_appeals (wallet_address, created_at DESC);

CREATE TABLE match_configs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    config_version integer NOT NULL,
    price_feed_symbol text NOT NULL,
    pyth_feed_id bytea NOT NULL,
    oracle_delay_window_sec integer NOT NULL DEFAULT 5,
    oracle_exponent smallint NOT NULL,
    max_oracle_confidence bigint NOT NULL,
    buy_in_chips bigint NOT NULL,
    entry_fee_chips bigint NOT NULL DEFAULT 0,
    rake_bps integer NOT NULL,
    rake_cap_chips bigint NOT NULL,
    max_players smallint NOT NULL,
    geofence_blocklist text[] NOT NULL DEFAULT ARRAY['IN'],
    allow_duplicate_wallet_per_match boolean NOT NULL DEFAULT false,
    created_by text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (config_version, price_feed_symbol),
    CHECK (octet_length(pyth_feed_id) = 32),
    CHECK (oracle_delay_window_sec BETWEEN 1 AND 60),
    CHECK (buy_in_chips > 0),
    CHECK (entry_fee_chips >= 0),
    CHECK (rake_bps BETWEEN 0 AND 10000),
    CHECK (rake_cap_chips >= 0),
    CHECK (max_players BETWEEN 2 AND 5),
    CHECK (allow_duplicate_wallet_per_match = false)
);

CREATE TABLE matches (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    match_key text NOT NULL UNIQUE,
    onchain_match_id bigint NOT NULL UNIQUE,
    config_id uuid NOT NULL REFERENCES match_configs(id),
    status match_status NOT NULL DEFAULT 'created',
    scheduled_end_ts timestamptz NOT NULL,
    owner_node_id text,
    owner_fencing_token bigint NOT NULL DEFAULT 0,
    owner_lease_expires_at timestamptz,
    event_head bytea NOT NULL DEFAULT decode(repeat('00', 32), 'hex'),
    event_count bigint NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT now(),
    locked_at timestamptz,
    settled_at timestamptz,
    voided_at timestamptz,
    CHECK (octet_length(event_head) = 32),
    CHECK (event_count >= 0)
);

CREATE INDEX matches_owner_lease_idx
    ON matches (owner_node_id, owner_lease_expires_at);

CREATE TABLE match_seats (
    match_id uuid NOT NULL REFERENCES matches(id),
    seat_index smallint NOT NULL,
    user_id uuid REFERENCES users(id),
    wallet_address text NOT NULL,
    deposit_signature text,
    buy_in_chips bigint NOT NULL,
    entry_fee_chips bigint NOT NULL DEFAULT 0,
    joined_at timestamptz NOT NULL DEFAULT now(),
    left_at timestamptz,
    PRIMARY KEY (match_id, seat_index),
    UNIQUE (match_id, wallet_address),
    CHECK (seat_index >= 0),
    CHECK (buy_in_chips > 0),
    CHECK (entry_fee_chips >= 0)
);

CREATE TABLE match_events (
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    match_id uuid NOT NULL REFERENCES matches(id),
    seq bigint NOT NULL,
    event_type text NOT NULL,
    payload jsonb NOT NULL,
    prev_hash bytea NOT NULL,
    hash bytea NOT NULL,
    signer text,
    owner_fencing_token bigint NOT NULL,
    observed_at timestamptz NOT NULL DEFAULT now(),
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (match_id, seq),
    UNIQUE (id),
    UNIQUE (match_id, hash),
    CHECK (seq >= 0),
    CHECK (octet_length(prev_hash) = 32),
    CHECK (octet_length(hash) = 32),
    CHECK (hash <> prev_hash),
    CHECK (jsonb_typeof(payload) = 'object')
);

CREATE INDEX match_events_created_at_idx ON match_events (created_at);
CREATE INDEX match_events_type_idx ON match_events (event_type);

CREATE TABLE outbox_events (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    aggregate_type text NOT NULL,
    aggregate_id uuid NOT NULL,
    event_type text NOT NULL,
    payload jsonb NOT NULL,
    status outbox_status NOT NULL DEFAULT 'pending',
    attempts integer NOT NULL DEFAULT 0,
    available_at timestamptz NOT NULL DEFAULT now(),
    published_at timestamptz,
    last_error text,
    created_at timestamptz NOT NULL DEFAULT now(),
    CHECK (attempts >= 0),
    CHECK (jsonb_typeof(payload) = 'object')
);

CREATE INDEX outbox_pending_idx
    ON outbox_events (available_at, id)
    WHERE status IN ('pending', 'processing');

CREATE TABLE pyth_price_proofs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    match_id uuid NOT NULL REFERENCES matches(id),
    feed_id bytea NOT NULL,
    publish_time timestamptz NOT NULL,
    price bigint NOT NULL,
    confidence bigint NOT NULL,
    exponent smallint NOT NULL,
    vaa_digest bytea,
    price_update_account text,
    receiver_program_id text NOT NULL,
    wormhole_program_id text NOT NULL,
    push_oracle_program_id text NOT NULL,
    hermes_response_hash bytea NOT NULL,
    binary_update_hash bytea NOT NULL,
    atomic_settlement_tx_signature text,
    raw_proof_uri text,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (match_id, feed_id, publish_time),
    CHECK (octet_length(feed_id) = 32),
    CHECK (vaa_digest IS NULL OR octet_length(vaa_digest) = 32),
    CHECK (octet_length(hermes_response_hash) = 32),
    CHECK (octet_length(binary_update_hash) = 32),
    CHECK (confidence >= 0)
);

CREATE TABLE settlements (
    match_id uuid PRIMARY KEY REFERENCES matches(id),
    status match_status NOT NULL,
    settled_event_seq bigint,
    event_root bytea NOT NULL,
    config_hash bytea NOT NULL,
    price_proof_id uuid REFERENCES pyth_price_proofs(id),
    settlement_price bigint,
    oracle_publish_time timestamptz,
    rake_chips bigint NOT NULL DEFAULT 0,
    bundle_uri text,
    submitted_tx_signature text,
    void_tx_signature text,
    settled_at timestamptz NOT NULL DEFAULT now(),
    CHECK (status IN ('settled', 'voided')),
    CHECK (octet_length(event_root) = 32),
    CHECK (octet_length(config_hash) = 32),
    CHECK (rake_chips >= 0)
);

CREATE TABLE settlement_attempts (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    match_id uuid NOT NULL REFERENCES matches(id),
    idempotency_key text NOT NULL UNIQUE,
    attempt_kind text NOT NULL DEFAULT 'settle',
    status settlement_attempt_status NOT NULL DEFAULT 'pending',
    attempt_count integer NOT NULL DEFAULT 0,
    event_root bytea NOT NULL,
    tx_signature text,
    last_error text,
    next_retry_at timestamptz,
    confirmed_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CHECK (attempt_kind IN ('settle', 'void')),
    CHECK (attempt_count >= 0),
    CHECK (octet_length(event_root) = 32)
);

CREATE INDEX settlement_attempts_due_idx
    ON settlement_attempts (next_retry_at, id)
    WHERE status IN ('pending', 'retry_scheduled');

CREATE INDEX settlement_attempts_match_idx
    ON settlement_attempts (match_id, created_at DESC);

CREATE TABLE settlement_dead_letters (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    attempt_id uuid REFERENCES settlement_attempts(id),
    match_id uuid NOT NULL REFERENCES matches(id),
    idempotency_key text NOT NULL,
    reason text NOT NULL,
    payload jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    CHECK (jsonb_typeof(payload) = 'object')
);

CREATE TABLE settlement_payouts (
    match_id uuid NOT NULL REFERENCES settlements(match_id),
    seat_index smallint NOT NULL,
    wallet_address text NOT NULL,
    payout_chips bigint NOT NULL,
    claimed_at timestamptz,
    claim_signature text,
    PRIMARY KEY (match_id, seat_index),
    CHECK (seat_index >= 0),
    CHECK (payout_chips >= 0)
);

CREATE TABLE custody_ledger (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    match_id uuid NOT NULL REFERENCES matches(id),
    ledger_type text NOT NULL,
    wallet_address text,
    amount_chips bigint NOT NULL,
    reference text,
    created_at timestamptz NOT NULL DEFAULT now(),
    CHECK (ledger_type IN ('deposit', 'payout', 'refund', 'fee_accrual', 'fee_sweep')),
    CHECK (amount_chips >= 0)
);

CREATE INDEX custody_ledger_match_idx
    ON custody_ledger (match_id, created_at);

CREATE TABLE vault_reconciliations (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    match_id uuid NOT NULL REFERENCES matches(id),
    expected_player_liability_chips bigint NOT NULL,
    expected_fee_liability_chips bigint NOT NULL,
    actual_vault_balance_chips bigint NOT NULL,
    drift_chips bigint NOT NULL,
    status text NOT NULL,
    checked_at timestamptz NOT NULL DEFAULT now(),
    CHECK (expected_player_liability_chips >= 0),
    CHECK (expected_fee_liability_chips >= 0),
    CHECK (actual_vault_balance_chips >= 0),
    CHECK (status IN ('green', 'drift'))
);

CREATE INDEX vault_reconciliations_match_idx
    ON vault_reconciliations (match_id, checked_at DESC);

CREATE TABLE replay_bundles (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    match_id uuid NOT NULL REFERENCES matches(id),
    from_seq bigint NOT NULL DEFAULT 0,
    to_seq bigint NOT NULL,
    event_root bytea NOT NULL,
    object_uri text NOT NULL,
    content_sha256 bytea NOT NULL,
    exported_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (match_id, from_seq, to_seq),
    CHECK (from_seq >= 0),
    CHECK (to_seq >= from_seq),
    CHECK (octet_length(event_root) = 32),
    CHECK (octet_length(content_sha256) = 32)
);

CREATE TABLE match_snapshots (
    match_id uuid NOT NULL REFERENCES matches(id),
    last_seq bigint NOT NULL,
    event_root bytea NOT NULL,
    owner_fencing_token bigint NOT NULL,
    payload jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (match_id, last_seq),
    CHECK (last_seq >= 0),
    CHECK (octet_length(event_root) = 32),
    CHECK (jsonb_typeof(payload) = 'object')
);

CREATE INDEX match_snapshots_latest_idx
    ON match_snapshots (match_id, last_seq DESC);

CREATE TABLE read_model_checkpoints (
    projection_name text PRIMARY KEY,
    last_match_id uuid,
    last_seq bigint NOT NULL DEFAULT -1,
    last_event_id uuid,
    updated_at timestamptz NOT NULL DEFAULT now(),
    CHECK (last_seq >= -1)
);

CREATE TABLE live_games (
    match_id uuid PRIMARY KEY REFERENCES matches(id),
    status match_status NOT NULL,
    price_feed_symbol text NOT NULL,
    scheduled_end_ts timestamptz NOT NULL,
    player_count integer NOT NULL DEFAULT 0,
    pot_chips bigint NOT NULL DEFAULT 0,
    current_turn_seat smallint,
    last_event_seq bigint NOT NULL DEFAULT -1,
    public_state jsonb NOT NULL DEFAULT '{}'::jsonb,
    projected_at timestamptz NOT NULL DEFAULT now(),
    CHECK (player_count >= 0),
    CHECK (pot_chips >= 0),
    CHECK (last_event_seq >= -1),
    CHECK (jsonb_typeof(public_state) = 'object')
);

CREATE TABLE match_history (
    match_id uuid PRIMARY KEY REFERENCES matches(id),
    status match_status NOT NULL,
    price_feed_symbol text NOT NULL,
    scheduled_end_ts timestamptz NOT NULL,
    oracle_publish_time timestamptz,
    settlement_price bigint,
    event_root bytea NOT NULL,
    replay_bundle_uri text,
    summary jsonb NOT NULL DEFAULT '{}'::jsonb,
    projected_at timestamptz NOT NULL DEFAULT now(),
    CHECK (octet_length(event_root) = 32),
    CHECK (jsonb_typeof(summary) = 'object')
);

CREATE OR REPLACE FUNCTION reject_match_event_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION 'match_events is append-only';
END;
$$;

CREATE TRIGGER prevent_match_event_update
    BEFORE UPDATE ON match_events
    FOR EACH ROW EXECUTE FUNCTION reject_match_event_mutation();

CREATE TRIGGER prevent_match_event_delete
    BEFORE DELETE ON match_events
    FOR EACH ROW EXECUTE FUNCTION reject_match_event_mutation();

CREATE OR REPLACE FUNCTION notify_outbox_event()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    PERFORM pg_notify('syndicate_outbox', NEW.id::text);
    RETURN NEW;
END;
$$;

CREATE TRIGGER notify_outbox_insert
    AFTER INSERT ON outbox_events
    FOR EACH ROW EXECUTE FUNCTION notify_outbox_event();

INSERT INTO read_model_checkpoints (projection_name)
VALUES
    ('live_games'),
    ('match_history'),
    ('profile_stats')
ON CONFLICT DO NOTHING;
