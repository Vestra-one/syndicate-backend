-- Settlement queue indexes for outbox relay and stuck-submitted recovery.

CREATE INDEX IF NOT EXISTS outbox_settlement_pending_idx
    ON outbox_events (available_at, id)
    WHERE aggregate_type = 'settlement' AND status IN ('pending', 'processing');

CREATE INDEX IF NOT EXISTS settlement_attempts_submitted_stale_idx
    ON settlement_attempts (updated_at, id)
    WHERE status = 'submitted';
