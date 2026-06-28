-- Profile metadata keyed by wallet (userId = wallet pubkey).

CREATE TABLE IF NOT EXISTS profile_metadata (
    wallet_address text PRIMARY KEY,
    handle text,
    avatar_uri text,
    updated_at timestamptz NOT NULL DEFAULT now()
);
