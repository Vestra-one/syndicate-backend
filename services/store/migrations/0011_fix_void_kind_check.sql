-- Fix the void_kind CHECK constraint for v2.
--
-- 0006 created `matches_void_kind_check` with the v1 PascalCase set
-- ('FillingVoid','UnderMinSealed','Emergency'). 0008 tried to redefine it via
-- `ADD COLUMN IF NOT EXISTS void_kind text CHECK (...)`, but the column already existed,
-- so the ADD COLUMN (and its inline CHECK) was skipped — leaving the v1 constraint active.
-- The v2 code mirrors the on-chain VoidKind as snake_case ('filling_void','emergency'),
-- which the stale constraint rejects, so every void's chain-sync UPDATE failed and matches
-- never transitioned to 'voided'. Drop the old constraint and install the v2 one.

ALTER TABLE matches DROP CONSTRAINT IF EXISTS matches_void_kind_check;
ALTER TABLE matches
    ADD CONSTRAINT matches_void_kind_check
    CHECK (void_kind IS NULL OR void_kind IN ('filling_void', 'emergency'));
