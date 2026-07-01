//! Postgres persistence contract for the production match engine.
//!
//! This module intentionally contains SQL and row shapes, not a database client.
//! The service runtime can execute these statements through `tokio-postgres`,
//! `sqlx`, or another driver without duplicating the transactional invariants.

/// Acquire ownership of a match when the previous lease is absent, expired, or
/// already owned by the same node. A successful acquire increments the fencing
/// token; every later write must present that token.
pub const ACQUIRE_MATCH_LEASE_SQL: &str = r#"
UPDATE matches
SET owner_node_id = $2,
    owner_fencing_token = owner_fencing_token + 1,
    owner_lease_expires_at = $3::timestamptz + ($4::bigint * interval '1 millisecond')
WHERE id = $1
  AND (
      owner_lease_expires_at IS NULL
      OR owner_lease_expires_at <= $3::timestamptz
      OR owner_node_id = $2
  )
RETURNING id, owner_node_id, owner_fencing_token, owner_lease_expires_at, event_count, event_head
"#;

/// Renew an existing lease without changing its fencing token.
pub const RENEW_MATCH_LEASE_SQL: &str = r#"
UPDATE matches
SET owner_lease_expires_at = $4::timestamptz + ($5::bigint * interval '1 millisecond')
WHERE id = $1
  AND owner_node_id = $2
  AND owner_fencing_token = $3
  AND owner_lease_expires_at > $4::timestamptz
RETURNING id, owner_node_id, owner_fencing_token, owner_lease_expires_at, event_count, event_head
"#;

/// Append one event and its outbox message atomically.
///
/// Parameters:
///
/// 1. match_id
/// 2. owner_node_id
/// 3. owner_fencing_token
/// 4. now timestamptz
/// 5. expected_seq
/// 6. expected_prev_hash bytea
/// 7. event_type
/// 8. payload jsonb
/// 9. event_hash bytea
/// 10. signer
///
/// The `FOR UPDATE` row lock and expected `(seq, prev_hash)` checks prevent
/// split-brain and lost updates even if two processes race.
pub const APPEND_MATCH_EVENT_WITH_OUTBOX_SQL: &str = r#"
WITH locked_match AS (
    SELECT id, event_count, event_head
    FROM matches
    WHERE id = $1
      AND owner_node_id = $2
      AND owner_fencing_token = $3
      AND owner_lease_expires_at > $4::timestamptz
    FOR UPDATE
),
inserted_event AS (
    INSERT INTO match_events (
        match_id,
        seq,
        event_type,
        payload,
        prev_hash,
        hash,
        signer,
        owner_fencing_token
    )
    SELECT
        id,
        $5,
        $7,
        $8,
        $6,
        $9,
        $10,
        $3
    FROM locked_match
    WHERE event_count = $5
      AND event_head = $6
    RETURNING id, match_id, seq, hash
),
updated_match AS (
    UPDATE matches m
    SET event_count = inserted_event.seq + 1,
        event_head = inserted_event.hash
    FROM inserted_event
    WHERE m.id = inserted_event.match_id
    RETURNING m.id
),
inserted_outbox AS (
    INSERT INTO outbox_events (
        aggregate_type,
        aggregate_id,
        event_type,
        payload
    )
    SELECT
        'match',
        match_id,
        event_type,
        payload
    FROM match_events
    WHERE id = (SELECT id FROM inserted_event)
    RETURNING id
)
SELECT
    inserted_event.id,
    inserted_event.match_id,
    inserted_event.seq,
    inserted_event.hash,
    inserted_outbox.id AS outbox_id
FROM inserted_event, inserted_outbox
"#;

/// Persist a replay snapshot at a specific event root.
pub const INSERT_MATCH_SNAPSHOT_SQL: &str = r#"
INSERT INTO match_snapshots (
    match_id,
    last_seq,
    event_root,
    owner_fencing_token,
    payload
)
VALUES ($1, $2, $3, $4, $5)
ON CONFLICT (match_id, last_seq) DO NOTHING
RETURNING match_id, last_seq, event_root
"#;

/// Load the latest snapshot for recovery before replaying later events.
pub const LOAD_LATEST_MATCH_SNAPSHOT_SQL: &str = r#"
SELECT match_id, last_seq, event_root, owner_fencing_token, payload
FROM match_snapshots
WHERE match_id = $1
ORDER BY last_seq DESC
LIMIT 1
"#;

/// Load events after a snapshot root, ordered for deterministic replay.
pub const LOAD_MATCH_EVENTS_AFTER_SQL: &str = r#"
SELECT seq, event_type, payload, prev_hash, hash, owner_fencing_token
FROM match_events
WHERE match_id = $1
  AND seq > $2
ORDER BY seq ASC
"#;

/// Create or fetch an idempotent settlement attempt.
pub const UPSERT_SETTLEMENT_ATTEMPT_SQL: &str = r#"
INSERT INTO settlement_attempts (
    match_id,
    idempotency_key,
    attempt_kind,
    event_root,
    oracle_audit,
    status,
    next_retry_at
)
VALUES ($1::uuid, $2, $3, $4, $5, 'pending', CASE WHEN $6 IS NULL THEN NULL ELSE to_timestamp($6::double precision / 1000.0) END)
ON CONFLICT (idempotency_key) DO UPDATE
SET updated_at = now(),
    oracle_audit = COALESCE(settlement_attempts.oracle_audit, EXCLUDED.oracle_audit)
RETURNING id, match_id::text, idempotency_key, status::text, attempt_count, tx_signature,
          event_root, last_error, oracle_audit,
          CAST(EXTRACT(EPOCH FROM next_retry_at) * 1000 AS bigint) AS next_retry_at_ms
"#;

/// Row-lock an existing attempt before upsert (no-op when the row does not exist yet).
pub const LOCK_SETTLEMENT_ATTEMPT_SQL: &str = r#"
SELECT id FROM settlement_attempts WHERE idempotency_key = $1 FOR UPDATE
"#;

/// Load one settlement attempt by idempotency key.
pub const LOAD_SETTLEMENT_ATTEMPT_SQL: &str = r#"
SELECT match_id::text, idempotency_key, status::text, attempt_count, tx_signature, event_root,
       last_error, oracle_audit,
       CAST(EXTRACT(EPOCH FROM next_retry_at) * 1000 AS bigint) AS next_retry_at_ms
FROM settlement_attempts
WHERE idempotency_key = $1
"#;

/// Mark an attempt as submitted after Solana accepted the transaction.
pub const MARK_SETTLEMENT_SUBMITTED_SQL: &str = r#"
UPDATE settlement_attempts
SET status = 'submitted',
    attempt_count = attempt_count + 1,
    tx_signature = $2,
    last_error = NULL,
    next_retry_at = NULL,
    updated_at = now()
WHERE idempotency_key = $1
RETURNING match_id::text, idempotency_key, status::text, attempt_count, tx_signature, event_root,
          last_error, oracle_audit,
          CAST(EXTRACT(EPOCH FROM next_retry_at) * 1000 AS bigint) AS next_retry_at_ms
"#;

/// Mark a transaction confirmed. The unique idempotency key prevents double-pay.
pub const MARK_SETTLEMENT_CONFIRMED_SQL: &str = r#"
UPDATE settlement_attempts
SET status = 'confirmed',
    confirmed_at = to_timestamp($2::double precision / 1000.0),
    next_retry_at = NULL,
    last_error = NULL,
    updated_at = now()
WHERE idempotency_key = $1
  AND status IN ('submitted', 'retry_scheduled', 'pending')
RETURNING match_id::text, idempotency_key, status::text, attempt_count, tx_signature, event_root,
          last_error,
          CAST(EXTRACT(EPOCH FROM next_retry_at) * 1000 AS bigint) AS next_retry_at_ms
"#;

/// Schedule retry without creating a second logical settlement.
pub const MARK_SETTLEMENT_RETRY_SQL: &str = r#"
UPDATE settlement_attempts
SET status = 'retry_scheduled',
    attempt_count = attempt_count + 1,
    last_error = $2,
    next_retry_at = to_timestamp($3::double precision / 1000.0),
    updated_at = now()
WHERE idempotency_key = $1
RETURNING match_id::text, idempotency_key, status::text, attempt_count, tx_signature, event_root,
          last_error,
          CAST(EXTRACT(EPOCH FROM next_retry_at) * 1000 AS bigint) AS next_retry_at_ms
"#;

/// Mark the failed settlement path as admin-voided. Player refunds are pull-based.
pub const MARK_SETTLEMENT_VOIDED_SQL: &str = r#"
UPDATE settlement_attempts
SET status = 'voided',
    tx_signature = $2,
    last_error = $3,
    next_retry_at = NULL,
    updated_at = now()
WHERE idempotency_key = $1
RETURNING match_id::text, idempotency_key, status::text, attempt_count, tx_signature, event_root,
          last_error,
          CAST(EXTRACT(EPOCH FROM next_retry_at) * 1000 AS bigint) AS next_retry_at_ms
"#;

/// Mark an attempt dead-lettered. Caller inserts the audit row separately.
pub const MARK_SETTLEMENT_DEAD_LETTER_SQL: &str = r#"
UPDATE settlement_attempts
SET status = 'dead_letter',
    last_error = $2,
    next_retry_at = NULL,
    updated_at = now()
WHERE idempotency_key = $1
RETURNING match_id::text, idempotency_key, status::text, attempt_count, tx_signature, event_root,
          last_error,
          CAST(EXTRACT(EPOCH FROM next_retry_at) * 1000 AS bigint) AS next_retry_at_ms
"#;

/// Persist a dead-letter audit row for operator inspection.
pub const INSERT_SETTLEMENT_DEAD_LETTER_SQL: &str = r#"
INSERT INTO settlement_dead_letters (
    attempt_id,
    match_id,
    idempotency_key,
    reason,
    payload
)
SELECT id, match_id, idempotency_key, $2, $3::jsonb
FROM settlement_attempts
WHERE idempotency_key = $1
RETURNING id
"#;

/// Persist the custody invariant result. `drift_chips` must be zero in green state.
pub const INSERT_VAULT_RECONCILIATION_SQL: &str = r#"
INSERT INTO vault_reconciliations (
    match_id,
    expected_player_liability_chips,
    expected_fee_liability_chips,
    actual_vault_balance_chips,
    drift_chips,
    status
)
VALUES ($1, $2, $3, $4, $5, $6)
RETURNING id, match_id, drift_chips, status, checked_at
"#;

/// Upsert a projected active-game row. Projections are disposable and rebuildable.
pub const UPSERT_LIVE_GAME_SQL: &str = r#"
INSERT INTO live_games (
    match_id,
    status,
    price_feed_symbol,
    scheduled_end_ts,
    player_count,
    pot_chips,
    current_turn_seat,
    last_event_seq,
    public_state
)
VALUES ($1, $2, $3, $4::timestamptz, $5, $6, $7, $8, $9)
ON CONFLICT (match_id) DO UPDATE
SET status = EXCLUDED.status,
    price_feed_symbol = EXCLUDED.price_feed_symbol,
    scheduled_end_ts = EXCLUDED.scheduled_end_ts,
    player_count = EXCLUDED.player_count,
    pot_chips = EXCLUDED.pot_chips,
    current_turn_seat = EXCLUDED.current_turn_seat,
    last_event_seq = EXCLUDED.last_event_seq,
    public_state = EXCLUDED.public_state,
    projected_at = now()
RETURNING match_id, last_event_seq, projected_at
"#;

/// Upsert post-match history summary. Rebuilding can overwrite projections.
pub const UPSERT_MATCH_HISTORY_SQL: &str = r#"
INSERT INTO match_history (
    match_id,
    status,
    price_feed_symbol,
    scheduled_end_ts,
    oracle_publish_time,
    settlement_price,
    event_root,
    replay_bundle_uri,
    summary
)
VALUES ($1, $2, $3, $4::timestamptz, $5::timestamptz, $6, $7, $8, $9)
ON CONFLICT (match_id) DO UPDATE
SET status = EXCLUDED.status,
    oracle_publish_time = EXCLUDED.oracle_publish_time,
    settlement_price = EXCLUDED.settlement_price,
    event_root = EXCLUDED.event_root,
    replay_bundle_uri = EXCLUDED.replay_bundle_uri,
    summary = EXCLUDED.summary,
    projected_at = now()
RETURNING match_id, status, projected_at
"#;

/// Page terminal match history for archive screens. `$1` is optional:
/// NULL = settled/voided only, `all` = include live, otherwise exact status.
/// Cursor is the `(projected_at, match_id)` tuple from the previous page tail.
pub const LIST_MATCH_HISTORY_SQL: &str = r#"
SELECT
    match_id,
    status,
    price_feed_symbol,
    scheduled_end_ts,
    oracle_publish_time,
    settlement_price,
    event_root,
    replay_bundle_uri,
    summary,
    projected_at
FROM match_history
WHERE CASE
        WHEN $1::text IS NULL THEN status IN ('settled', 'voided')
        WHEN $1::text = 'all' THEN true
        ELSE status::text = $1::text
    END
  AND (
        ($2::timestamptz IS NULL AND $3::uuid IS NULL)
        OR (projected_at, match_id) < ($2::timestamptz, $3::uuid)
  )
ORDER BY projected_at DESC, match_id ASC
LIMIT $4
"#;

/// Load one match summary for the historical-game detail page.
pub const LOAD_MATCH_HISTORY_SQL: &str = r#"
SELECT
    match_id,
    status,
    price_feed_symbol,
    scheduled_end_ts,
    oracle_publish_time,
    settlement_price,
    event_root,
    replay_bundle_uri,
    summary,
    projected_at
FROM match_history
WHERE match_id = $1
"#;

/// Persist an exported replay bundle pointer.
pub const INSERT_REPLAY_BUNDLE_SQL: &str = r#"
INSERT INTO replay_bundles (
    match_id,
    from_seq,
    to_seq,
    event_root,
    object_uri,
    content_sha256
)
VALUES ($1, $2, $3, $4, $5, $6)
ON CONFLICT (match_id, from_seq, to_seq) DO UPDATE
SET object_uri = EXCLUDED.object_uri,
    content_sha256 = EXCLUDED.content_sha256,
    exported_at = now()
RETURNING id, match_id, object_uri, content_sha256
"#;

/// Load the newest exported replay bundle pointer for a historical-game timeline.
pub const LOAD_LATEST_REPLAY_BUNDLE_SQL: &str = r#"
SELECT id, match_id, from_seq, to_seq, event_root, object_uri, content_sha256, exported_at
FROM replay_bundles
WHERE match_id = $1
ORDER BY to_seq DESC, exported_at DESC
LIMIT 1
"#;

/// Upsert aggregated public profile stats.
pub const UPSERT_PROFILE_STATS_SQL: &str = r#"
INSERT INTO profile_stats (
    user_id,
    matches_played,
    matches_won,
    total_buy_in_chips,
    total_payout_chips,
    showdown_count,
    fold_count,
    achievement_count,
    last_rebuilt_event_id
)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
ON CONFLICT (user_id) DO UPDATE
SET matches_played = EXCLUDED.matches_played,
    matches_won = EXCLUDED.matches_won,
    total_buy_in_chips = EXCLUDED.total_buy_in_chips,
    total_payout_chips = EXCLUDED.total_payout_chips,
    showdown_count = EXCLUDED.showdown_count,
    fold_count = EXCLUDED.fold_count,
    achievement_count = EXCLUDED.achievement_count,
    last_rebuilt_event_id = EXCLUDED.last_rebuilt_event_id,
    updated_at = now()
RETURNING user_id, matches_played, matches_won, updated_at
"#;

/// Advance a projection checkpoint after its writes commit.
pub const ADVANCE_READ_MODEL_CHECKPOINT_SQL: &str = r#"
INSERT INTO read_model_checkpoints (
    projection_name,
    last_match_id,
    last_seq,
    last_event_id,
    updated_at
)
VALUES ($1, $2, $3, $4, now())
ON CONFLICT (projection_name) DO UPDATE
SET last_match_id = EXCLUDED.last_match_id,
    last_seq = GREATEST(read_model_checkpoints.last_seq, EXCLUDED.last_seq),
    last_event_id = EXCLUDED.last_event_id,
    updated_at = now()
RETURNING projection_name, last_seq, updated_at
"#;

/// Enqueue a settlement request into the transactional outbox.
pub const ENQUEUE_SETTLEMENT_REQUEST_SQL: &str = r#"
INSERT INTO outbox_events (
    aggregate_type,
    aggregate_id,
    event_type,
    payload
)
VALUES ('settlement', $1::uuid, 'settlement.requested', $2::jsonb)
RETURNING id::text, aggregate_id::text, event_type, payload::text
"#;

/// Claim settlement outbox rows for relay to JetStream.
pub const CLAIM_SETTLEMENT_OUTBOX_SQL: &str = r#"
WITH claimed AS (
    SELECT id
    FROM outbox_events
    WHERE aggregate_type = 'settlement'
      AND status IN ('pending', 'processing')
      AND available_at <= $1::timestamptz
    ORDER BY created_at, id
    LIMIT $2
    FOR UPDATE SKIP LOCKED
)
UPDATE outbox_events o
SET status = 'processing',
    attempts = attempts + 1,
    available_at = $1::timestamptz + ($3::bigint * interval '1 millisecond')
FROM claimed
WHERE o.id = claimed.id
RETURNING o.id::text, o.aggregate_id::text, o.event_type, o.payload::text, o.attempts
"#;

/// Mark a settlement outbox row published after JetStream ack.
pub const MARK_OUTBOX_PUBLISHED_SQL: &str = r#"
UPDATE outbox_events
SET status = 'published',
    published_at = $2::timestamptz,
    last_error = NULL
WHERE id = $1::uuid
  AND status = 'processing'
RETURNING id::text
"#;

/// Requeue a failed settlement outbox row for relay retry.
pub const MARK_OUTBOX_RETRY_SQL: &str = r#"
UPDATE outbox_events
SET status = 'pending',
    available_at = $2::timestamptz + ($3::bigint * interval '1 millisecond'),
    last_error = $4
WHERE id = $1::uuid
  AND status = 'processing'
RETURNING id::text, attempts
"#;

/// Dead-letter a settlement outbox row after relay retry budget is exhausted.
pub const MARK_OUTBOX_DEAD_LETTER_SQL: &str = r#"
UPDATE outbox_events
SET status = 'dead_letter',
    last_error = $2
WHERE id = $1::uuid
  AND status = 'processing'
RETURNING id::text
"#;

/// List settlement attempts due for retry or stuck in submitted state.
pub const LIST_DUE_SETTLEMENT_ATTEMPTS_SQL: &str = r#"
SELECT match_id::text,
       idempotency_key,
       event_root,
       status::text,
       attempt_count,
       CAST(EXTRACT(EPOCH FROM next_retry_at) * 1000 AS bigint) AS next_retry_at_ms
FROM settlement_attempts
WHERE (
        status IN ('pending', 'retry_scheduled')
        AND (next_retry_at IS NULL OR next_retry_at <= $1::timestamptz)
    )
   OR (
        status = 'submitted'
        AND updated_at <= $1::timestamptz - ($2::bigint * interval '1 millisecond')
    )
ORDER BY updated_at ASC
LIMIT $3
"#;

/// Load all match events ordered for deterministic full replay.
pub const LOAD_ALL_MATCH_EVENTS_SQL: &str = r#"
SELECT seq, event_type, payload, prev_hash, hash, owner_fencing_token
FROM match_events
WHERE match_id = (
    SELECT id
    FROM matches
    WHERE id::text = $1 OR match_key = $1 OR onchain_match_id::text = $1
    LIMIT 1
)
ORDER BY seq ASC
"#;

/// Load settlement context for a match (config + event head).
pub const LOAD_MATCH_SETTLEMENT_CONTEXT_SQL: &str = r#"
SELECT m.id::text,
       m.onchain_match_id,
       m.event_head,
       m.event_count,
       EXTRACT(EPOCH FROM m.scheduled_end_ts)::bigint AS scheduled_end_ts_sec,
       m.dead_money_chips,
       c.price_feed_symbol,
       c.pyth_feed_id,
       c.buy_in_chips,
       c.oracle_exponent,
       c.max_oracle_confidence,
       c.rake_bps,
       c.rake_cap_chips
FROM matches m
JOIN match_configs c ON c.id = m.config_id
WHERE m.id = (
    SELECT id
    FROM matches
    WHERE id::text = $1 OR match_key = $1 OR onchain_match_id::text = $1
    LIMIT 1
)
"#;

/// Load settled match seats in on-chain seat-index order.
pub const LOAD_MATCH_SEATS_SQL: &str = r#"
SELECT seat_index, wallet_address
FROM match_seats
WHERE match_id = (
    SELECT id
    FROM matches
    WHERE id::text = $1 OR match_key = $1 OR onchain_match_id::text = $1
    LIMIT 1
)
  AND left_at IS NULL
ORDER BY seat_index ASC
"#;

// ---------------- Match lifecycle writers (Phase 05) ----------------
//
// With no indexer, the backend writes match rows itself: matchmaking on a verified
// create, the orchestrator on begin_live. These mirror the lifecycle columns added
// in migration `0006_match_lifecycle_columns.sql`. The registry these feed is
// UX-only — capital safety reads PDAs, never these rows.

/// Insert a match row on a verified create (host `create_and_deposit`).
///
/// Parameters:
/// 1. match_key text
/// 2. onchain_match_id bigint
/// 3. config_id uuid
/// 4. fill_deadline_ts timestamptz
///
/// `scheduled_end_ts` stays NULL until begin_live (the seal round pins it on-chain);
/// `room_status` starts at `Filling`. `ON CONFLICT (match_key) DO NOTHING` makes a
/// re-reported create txhash a no-op (idempotency).
pub const INSERT_MATCH_SQL: &str = r#"
INSERT INTO matches (
    match_key,
    onchain_match_id,
    config_id,
    status,
    fill_deadline_ts,
    room_status
)
VALUES ($1, $2, $3::uuid, 'created', $4::timestamptz, 'Filling')
ON CONFLICT (match_key) DO NOTHING
RETURNING id::text, match_key, onchain_match_id, status::text, room_status
"#;

/// Insert a seat row on a verified deposit (host or joiner).
///
/// Parameters:
/// 1. match_id text (internal uuid, match_key, or onchain_match_id)
/// 2. seat_index smallint
/// 3. wallet_address text
/// 4. deposit_signature text
/// 5. buy_in_chips bigint
/// 6. entry_fee_chips bigint
///
/// `ON CONFLICT (match_id, seat_index) DO NOTHING` makes a re-reported deposit
/// txhash a no-op (idempotency); the unique `(match_id, wallet_address)` also
/// rejects the same wallet taking two seats.
pub const INSERT_MATCH_SEAT_SQL: &str = r#"
WITH target_match AS (
    SELECT id
    FROM matches
    WHERE id::text = $1 OR match_key = $1 OR onchain_match_id::text = $1
    LIMIT 1
)
INSERT INTO match_seats (
    match_id,
    seat_index,
    wallet_address,
    deposit_signature,
    buy_in_chips,
    entry_fee_chips
)
SELECT id, $2, $3, $4, $5, $6
FROM target_match
ON CONFLICT (match_id, seat_index) DO NOTHING
RETURNING match_id::text, seat_index, wallet_address, deposit_signature
"#;

/// Transition a match to Live at begin_live: pin the timing the seal round fixed,
/// record the sealed cohort, and advance the room/status projections.
///
/// Parameters:
/// 1. match_id text (internal uuid, match_key, or onchain_match_id)
/// 2. live_start_ts timestamptz
/// 3. scheduled_end_ts timestamptz
/// 4. lock_ts timestamptz
/// 5. seal_deadline_ts timestamptz
/// 6. sealed_count smallint
/// 7. nonseal_penalty_bps integer
pub const UPDATE_MATCH_ON_BEGIN_LIVE_SQL: &str = r#"
UPDATE matches
SET live_start_ts = $2::timestamptz,
    scheduled_end_ts = $3::timestamptz,
    lock_ts = $4::timestamptz,
    seal_deadline_ts = $5::timestamptz,
    sealed_count = $6,
    nonseal_penalty_bps = $7,
    locked_at = COALESCE(locked_at, $4::timestamptz),
    status = 'active',
    room_status = 'Live'
WHERE id::text = $1
   OR match_key = $1
   OR onchain_match_id::text = $1
RETURNING id::text, status::text, room_status, scheduled_end_ts
"#;

/// Mark a match terminal — settled or voided. For a settle, pass
/// `('Settled', 'settled', NULL)`; for a void, `('Void', 'voided', <VoidKind>)`.
/// The matching `*_at` timestamp is stamped from the chosen `match_status`.
///
/// Parameters:
/// 1. match_id text (internal uuid, match_key, or onchain_match_id)
/// 2. room_status text ('Settled' | 'Void')
/// 3. status match_status ('settled' | 'voided')
/// 4. void_kind text (NULL when settled; 'FillingVoid'|'UnderMinSealed'|'Emergency' when voided)
pub const MARK_MATCH_TERMINAL_SQL: &str = r#"
UPDATE matches
SET room_status = $2,
    status = $3::match_status,
    void_kind = $4,
    settled_at = CASE WHEN $3::match_status = 'settled' THEN now() ELSE settled_at END,
    voided_at  = CASE WHEN $3::match_status = 'voided'  THEN now() ELSE voided_at END
WHERE id::text = $1
   OR match_key = $1
   OR onchain_match_id::text = $1
RETURNING id::text, status::text, room_status, void_kind
"#;

/// Persist one explainable trust-safety signal.
pub const INSERT_TRUST_SAFETY_SIGNAL_SQL: &str = r#"
INSERT INTO trust_safety_signals (
    wallet_address,
    signal_kind,
    severity,
    score,
    evidence,
    created_at
)
VALUES ($1, $2, $3, $4, $5, $6::timestamptz)
RETURNING id, wallet_address, signal_kind, severity, score, created_at
"#;

/// Create an active pre-seat enforcement action.
pub const INSERT_ENFORCEMENT_ACTION_SQL: &str = r#"
INSERT INTO enforcement_actions (
    wallet_address,
    action_type,
    status,
    reason,
    evidence,
    created_at,
    expires_at
)
VALUES ($1, $2, 'active', $3, $4, $5::timestamptz, $6::timestamptz)
RETURNING id, wallet_address, action_type, status, reason, expires_at
"#;

/// Check whether a wallet is blocked from seating right now.
pub const ACTIVE_ENFORCEMENT_FOR_WALLET_SQL: &str = r#"
SELECT id, wallet_address, action_type, reason, expires_at
FROM enforcement_actions
WHERE wallet_address = $1
  AND status = 'active'
  AND (expires_at IS NULL OR expires_at > $2::timestamptz)
  AND action_type IN ('seat_deny', 'temporary_ban', 'ban', 'kyc_required', 'geofence_block')
ORDER BY created_at DESC
"#;

/// Submit an appeal against a pre-seat enforcement action.
pub const INSERT_ENFORCEMENT_APPEAL_SQL: &str = r#"
INSERT INTO enforcement_appeals (
    action_id,
    wallet_address,
    statement
)
VALUES ($1, $2, $3)
RETURNING id, action_id, wallet_address, status, created_at
"#;

/// Resolve an appeal; accepted appeals lift the enforcement action.
pub const RESOLVE_ENFORCEMENT_APPEAL_SQL: &str = r#"
WITH updated_appeal AS (
    UPDATE enforcement_appeals
    SET status = $2,
        reviewer = $3,
        resolution = $4,
        resolved_at = $5::timestamptz
    WHERE id = $1
      AND status = 'open'
    RETURNING id, action_id, status
),
lifted_action AS (
    UPDATE enforcement_actions
    SET status = 'lifted',
        lifted_at = $5::timestamptz
    WHERE id = (SELECT action_id FROM updated_appeal)
      AND (SELECT status FROM updated_appeal) = 'accepted'
    RETURNING id
)
SELECT updated_appeal.id, updated_appeal.action_id, updated_appeal.status
FROM updated_appeal
"#;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PersistedLeaseHead {
    pub match_id: String,
    pub owner_node_id: String,
    pub fencing_token: u64,
    pub lease_expires_at_ms: u64,
    pub event_count: u64,
    pub event_head: [u8; 32],
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PersistedAppend {
    pub event_id: String,
    pub match_id: String,
    pub seq: u64,
    pub hash: [u8; 32],
    pub outbox_id: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PersistedSettlementAttempt {
    pub attempt_id: String,
    pub match_id: String,
    pub idempotency_key: String,
    pub status: String,
    pub attempt_count: u32,
    pub tx_signature: Option<String>,
}

/// Row shape returned by [`INSERT_MATCH_SQL`] (verified create).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PersistedMatchRow {
    pub match_id: String,
    pub match_key: String,
    pub onchain_match_id: i64,
    pub status: String,
    pub room_status: String,
}

/// Row shape returned by [`INSERT_MATCH_SEAT_SQL`] (verified deposit).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PersistedMatchSeat {
    pub match_id: String,
    pub seat_index: i16,
    pub wallet_address: String,
    pub deposit_signature: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lease_sql_uses_expiry_and_fencing_token() {
        assert!(ACQUIRE_MATCH_LEASE_SQL.contains("owner_fencing_token = owner_fencing_token + 1"));
        assert!(ACQUIRE_MATCH_LEASE_SQL.contains("owner_lease_expires_at"));
        assert!(RENEW_MATCH_LEASE_SQL.contains("owner_fencing_token = $3"));
        assert!(RENEW_MATCH_LEASE_SQL.contains("owner_lease_expires_at > $4::timestamptz"));
    }

    #[test]
    fn append_sql_is_single_transaction_shape() {
        assert!(APPEND_MATCH_EVENT_WITH_OUTBOX_SQL.contains("FOR UPDATE"));
        assert!(APPEND_MATCH_EVENT_WITH_OUTBOX_SQL.contains("owner_fencing_token = $3"));
        assert!(
            APPEND_MATCH_EVENT_WITH_OUTBOX_SQL.contains("owner_lease_expires_at > $4::timestamptz")
        );
        assert!(APPEND_MATCH_EVENT_WITH_OUTBOX_SQL.contains("event_count = $5"));
        assert!(APPEND_MATCH_EVENT_WITH_OUTBOX_SQL.contains("event_head = $6"));
        assert!(APPEND_MATCH_EVENT_WITH_OUTBOX_SQL.contains("INSERT INTO outbox_events"));
    }

    #[test]
    fn snapshot_sql_loads_latest_then_replays_after() {
        assert!(INSERT_MATCH_SNAPSHOT_SQL.contains("INSERT INTO match_snapshots"));
        assert!(LOAD_LATEST_MATCH_SNAPSHOT_SQL.contains("ORDER BY last_seq DESC"));
        assert!(LOAD_MATCH_EVENTS_AFTER_SQL.contains("seq > $2"));
        assert!(LOAD_MATCH_EVENTS_AFTER_SQL.contains("ORDER BY seq ASC"));
    }

    #[test]
    fn settlement_attempt_sql_is_idempotent_and_operable() {
        assert!(UPSERT_SETTLEMENT_ATTEMPT_SQL.contains("ON CONFLICT (idempotency_key)"));
        assert!(UPSERT_SETTLEMENT_ATTEMPT_SQL.contains("attempt_kind"));
        assert!(MARK_SETTLEMENT_SUBMITTED_SQL.contains("attempt_count = attempt_count + 1"));
        assert!(MARK_SETTLEMENT_CONFIRMED_SQL.contains("status = 'confirmed'"));
        assert!(MARK_SETTLEMENT_RETRY_SQL.contains("status = 'retry_scheduled'"));
        assert!(MARK_SETTLEMENT_VOIDED_SQL.contains("status = 'voided'"));
        assert!(MARK_SETTLEMENT_DEAD_LETTER_SQL.contains("status = 'dead_letter'"));
        assert!(INSERT_SETTLEMENT_DEAD_LETTER_SQL.contains("INSERT INTO settlement_dead_letters"));
        assert!(LOAD_SETTLEMENT_ATTEMPT_SQL.contains("status::text"));
        assert!(LOCK_SETTLEMENT_ATTEMPT_SQL.contains("FOR UPDATE"));
    }

    #[test]
    fn reconciliation_sql_persists_drift() {
        assert!(INSERT_VAULT_RECONCILIATION_SQL.contains("INSERT INTO vault_reconciliations"));
        assert!(INSERT_VAULT_RECONCILIATION_SQL.contains("drift_chips"));
        assert!(INSERT_VAULT_RECONCILIATION_SQL.contains("status"));
    }

    #[test]
    fn read_model_sql_is_checkpointed_and_rebuildable() {
        assert!(UPSERT_LIVE_GAME_SQL.contains("ON CONFLICT (match_id) DO UPDATE"));
        assert!(UPSERT_MATCH_HISTORY_SQL.contains("ON CONFLICT (match_id) DO UPDATE"));
        assert!(LIST_MATCH_HISTORY_SQL.contains("status IN ('settled', 'voided')"));
        assert!(LIST_MATCH_HISTORY_SQL.contains("ORDER BY projected_at DESC, match_id ASC"));
        assert!(LIST_MATCH_HISTORY_SQL.contains("(projected_at, match_id) <"));
        assert!(LOAD_MATCH_HISTORY_SQL.contains("WHERE match_id = $1"));
        assert!(INSERT_REPLAY_BUNDLE_SQL.contains("ON CONFLICT (match_id, from_seq, to_seq)"));
        assert!(LOAD_LATEST_REPLAY_BUNDLE_SQL.contains("ORDER BY to_seq DESC, exported_at DESC"));
        assert!(UPSERT_PROFILE_STATS_SQL.contains("ON CONFLICT (user_id) DO UPDATE"));
        assert!(
            ADVANCE_READ_MODEL_CHECKPOINT_SQL.contains("GREATEST(read_model_checkpoints.last_seq")
        );
    }

    #[test]
    fn settlement_queue_sql_supports_outbox_relay_and_due_poller() {
        assert!(ENQUEUE_SETTLEMENT_REQUEST_SQL.contains("aggregate_type"));
        assert!(ENQUEUE_SETTLEMENT_REQUEST_SQL.contains("'settlement'"));
        assert!(ENQUEUE_SETTLEMENT_REQUEST_SQL.contains("settlement.requested"));
        assert!(CLAIM_SETTLEMENT_OUTBOX_SQL.contains("FOR UPDATE SKIP LOCKED"));
        assert!(CLAIM_SETTLEMENT_OUTBOX_SQL.contains("aggregate_type = 'settlement'"));
        assert!(MARK_OUTBOX_PUBLISHED_SQL.contains("status = 'published'"));
        assert!(MARK_OUTBOX_RETRY_SQL.contains("status = 'pending'"));
        assert!(MARK_OUTBOX_DEAD_LETTER_SQL.contains("status = 'dead_letter'"));
        assert!(LIST_DUE_SETTLEMENT_ATTEMPTS_SQL.contains("status = 'submitted'"));
        assert!(LIST_DUE_SETTLEMENT_ATTEMPTS_SQL.contains("retry_scheduled"));
        assert!(LOAD_ALL_MATCH_EVENTS_SQL.contains("ORDER BY seq ASC"));
    }

    #[test]
    fn match_lifecycle_writers_are_idempotent_and_advance_room_state() {
        // Create: idempotent on re-reported txhash, starts in Filling, leaves
        // scheduled_end_ts unset (begin_live pins it).
        assert!(INSERT_MATCH_SQL.contains("INSERT INTO matches"));
        assert!(INSERT_MATCH_SQL.contains("ON CONFLICT (match_key) DO NOTHING"));
        assert!(INSERT_MATCH_SQL.contains("'Filling'"));
        assert!(!INSERT_MATCH_SQL.contains("scheduled_end_ts"));

        // Deposit: idempotent on re-reported txhash.
        assert!(INSERT_MATCH_SEAT_SQL.contains("INSERT INTO match_seats"));
        assert!(INSERT_MATCH_SEAT_SQL.contains("ON CONFLICT (match_id, seat_index) DO NOTHING"));

        // begin_live: pins timing, records sealed cohort, advances to Live.
        assert!(UPDATE_MATCH_ON_BEGIN_LIVE_SQL.contains("scheduled_end_ts = $3::timestamptz"));
        assert!(UPDATE_MATCH_ON_BEGIN_LIVE_SQL.contains("sealed_count = $6"));
        assert!(UPDATE_MATCH_ON_BEGIN_LIVE_SQL.contains("room_status = 'Live'"));

        // Terminal: settle vs void share one statement, stamping the right *_at.
        assert!(MARK_MATCH_TERMINAL_SQL.contains("status = $3::match_status"));
        assert!(MARK_MATCH_TERMINAL_SQL.contains("void_kind = $4"));
        assert!(MARK_MATCH_TERMINAL_SQL.contains("WHEN $3::match_status = 'settled'"));
        assert!(MARK_MATCH_TERMINAL_SQL.contains("WHEN $3::match_status = 'voided'"));
    }

    #[test]
    fn migration_0006_makes_scheduled_end_nullable_and_guards_live() {
        const MIGRATION_0006: &str =
            include_str!("../migrations/0006_match_lifecycle_columns.sql");
        assert!(MIGRATION_0006.contains("ALTER COLUMN scheduled_end_ts DROP NOT NULL"));
        assert!(MIGRATION_0006.contains("room_status"));
        assert!(MIGRATION_0006.contains("matches_scheduled_end_set_when_live"));
        assert!(MIGRATION_0006
            .contains("CHECK (room_status IS NULL OR room_status IN ('Filling', 'Sealing', 'Live', 'Settled', 'Void'))"));
        assert!(MIGRATION_0006
            .contains("void_kind IS NULL OR void_kind IN ('FillingVoid', 'UnderMinSealed', 'Emergency')"));
    }

    #[test]
    fn settlement_context_read_still_resolves_after_lifecycle_columns() {
        // Phase 05 must not disturb the worker read path.
        assert!(LOAD_MATCH_SETTLEMENT_CONTEXT_SQL.contains("m.scheduled_end_ts"));
        assert!(LOAD_MATCH_SETTLEMENT_CONTEXT_SQL.contains("m.dead_money_chips"));
    }

    #[test]
    fn trust_safety_sql_supports_active_enforcement_and_appeals() {
        assert!(INSERT_TRUST_SAFETY_SIGNAL_SQL.contains("INSERT INTO trust_safety_signals"));
        assert!(INSERT_ENFORCEMENT_ACTION_SQL.contains("INSERT INTO enforcement_actions"));
        assert!(ACTIVE_ENFORCEMENT_FOR_WALLET_SQL.contains("status = 'active'"));
        assert!(ACTIVE_ENFORCEMENT_FOR_WALLET_SQL.contains("expires_at IS NULL OR expires_at >"));
        assert!(ACTIVE_ENFORCEMENT_FOR_WALLET_SQL.contains("action_type IN ('seat_deny', 'temporary_ban', 'ban', 'kyc_required', 'geofence_block')"));
        assert!(INSERT_ENFORCEMENT_APPEAL_SQL.contains("INSERT INTO enforcement_appeals"));
        assert!(RESOLVE_ENFORCEMENT_APPEAL_SQL.contains("status = 'lifted'"));
    }
}
