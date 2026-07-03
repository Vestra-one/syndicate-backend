-- game-server extras (additive): chain-confirmed seal ordering. `seal_seq` is the
-- settlement tie-break input (plan_v2 B3: sealers by chain-confirmed seal order,
-- non-sealers sealed_count + engine_seat); `sealed_at` records submission time.
ALTER TABLE match_seats
    ADD COLUMN IF NOT EXISTS seal_seq smallint,
    ADD COLUMN IF NOT EXISTS sealed_at timestamptz;
