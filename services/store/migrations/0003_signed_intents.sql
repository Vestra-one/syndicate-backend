-- Signed intent metadata (payload lives in match_events JSON; this documents columns for indexing).

ALTER TABLE match_events
  ADD COLUMN IF NOT EXISTS intent_prev_head BYTEA,
  ADD COLUMN IF NOT EXISTS intent_wallet TEXT,
  ADD COLUMN IF NOT EXISTS intent_nonce BIGINT;

CREATE INDEX IF NOT EXISTS match_events_intent_wallet_idx
  ON match_events (intent_wallet)
  WHERE intent_wallet IS NOT NULL;

COMMENT ON COLUMN match_events.intent_prev_head IS '32-byte hash-chain head the player signed over (player.action events).';
COMMENT ON COLUMN match_events.intent_wallet IS 'base58 seat wallet for signed intents.';
COMMENT ON COLUMN match_events.intent_nonce IS 'monotonic per-seat action nonce.';
