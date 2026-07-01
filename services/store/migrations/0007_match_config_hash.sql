-- Phase 05 follow-up: bind match_configs rows to on-chain config_hash for idempotent upsert.

ALTER TABLE match_configs
    ADD COLUMN IF NOT EXISTS config_hash bytea;

DO $$
BEGIN
    ALTER TABLE match_configs
        ADD CONSTRAINT match_configs_config_hash_unique UNIQUE (config_hash);
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

COMMENT ON COLUMN match_configs.config_hash IS
    'Rules-only config hash (32 bytes); matches on-chain CreateParams.config_hash.';
