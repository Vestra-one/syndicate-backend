-- Session keys: a wallet's signed, per-match grant letting an ephemeral browser key sign
-- its gameplay intents (actions, default policy, seal upload) so the player is not
-- prompted on every move. Kept beside the event journal as the audit record of who
-- authorized the key that signed a journaled action. Grants move no funds.
CREATE TABLE IF NOT EXISTS match_session_keys (
    match_id        uuid        NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
    wallet          text        NOT NULL,
    session_pubkey  bytea       NOT NULL CHECK (octet_length(session_pubkey) = 32),
    expires_at      timestamptz NOT NULL,
    grant_signature text        NOT NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (match_id, wallet)
);
