-- Prediction blinding stored alongside sealed events (payload is canonical).

ALTER TABLE match_events
  ADD COLUMN IF NOT EXISTS prediction_blinding BYTEA;

COMMENT ON COLUMN match_events.prediction_blinding IS '32-byte blinding factor for H(prediction||blinding) commitment binding.';
