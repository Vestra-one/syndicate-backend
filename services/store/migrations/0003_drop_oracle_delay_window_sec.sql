-- Remove obsolete oracle delay window; signed prices now use exact scheduled_end_ts.
ALTER TABLE match_configs DROP COLUMN IF EXISTS oracle_delay_window_sec;
