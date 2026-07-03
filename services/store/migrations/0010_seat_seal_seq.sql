-- Seal arrival order (off-chain tiebreak input for settlement; sealers get 0..n by
-- arrival, non-sealers sealed_count + seat_index).
ALTER TABLE match_seats ADD COLUMN IF NOT EXISTS seal_seq smallint;
