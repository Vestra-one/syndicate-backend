-- chain_jobs: the game-server → chain-worker transactional job queue. The game-server
-- enqueues in the SAME transaction as the causing state change; the chain-worker claims
-- with FOR UPDATE SKIP LOCKED (LISTEN wake-up + interval poll). Replaces NATS.

CREATE TYPE chain_job_kind AS ENUM (
    'lock',
    'begin_live',
    'submit_settlement',
    'void_before_start',
    'void_live_after_deadline',
    'void',
    'withdraw_fees'
);

CREATE TYPE chain_job_status AS ENUM (
    'pending',
    'claimed',
    'submitted',
    'confirmed',
    'retry_scheduled',
    'dead_letter',
    'skipped'
);

CREATE TABLE chain_jobs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    match_id uuid NOT NULL REFERENCES matches(id),
    kind chain_job_kind NOT NULL,
    idempotency_key text NOT NULL UNIQUE,   -- '<match_id>:<kind>' (+ ':root-<hex>' for settlement)
    payload jsonb NOT NULL DEFAULT '{}',    -- kind-specific: confirmed wallets for lock, treasury for fees…
    status chain_job_status NOT NULL DEFAULT 'pending',
    attempt_count integer NOT NULL DEFAULT 0,
    not_before timestamptz,                 -- scheduling: settle at scheduled_end, void backstops
    next_retry_at timestamptz,
    claimed_by text,
    claimed_at timestamptz,
    tx_signature text,
    last_blockhash text,
    last_error text,
    oracle_audit jsonb,                     -- signed-price hash + drand receipt (settlement only)
    confirmed_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX chain_jobs_due_idx
    ON chain_jobs (COALESCE(next_retry_at, not_before, created_at), id)
    WHERE status IN ('pending', 'retry_scheduled');

CREATE INDEX chain_jobs_stale_idx
    ON chain_jobs (claimed_at)
    WHERE status IN ('claimed', 'submitted');

CREATE INDEX chain_jobs_match_idx ON chain_jobs (match_id, kind);

-- Wake the chain-worker on insert (poll remains the correctness path).
CREATE OR REPLACE FUNCTION notify_chain_job()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    PERFORM pg_notify('syndicate_chain_jobs', NEW.id::text);
    RETURN NEW;
END;
$$;

CREATE TRIGGER chain_jobs_notify
    AFTER INSERT ON chain_jobs
    FOR EACH ROW EXECUTE FUNCTION notify_chain_job();

-- Notify the game-server when a job reaches a terminal state (result handshake).
CREATE OR REPLACE FUNCTION notify_chain_job_result()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.status IN ('confirmed', 'dead_letter', 'skipped')
       AND NEW.status IS DISTINCT FROM OLD.status THEN
        PERFORM pg_notify('syndicate_chain_job_results', NEW.id::text);
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER chain_jobs_result_notify
    AFTER UPDATE ON chain_jobs
    FOR EACH ROW EXECUTE FUNCTION notify_chain_job_result();
