-- Player handles (v2), reusing the dormant wallet->handle/avatar table from 0005.
ALTER TABLE profile_metadata
    ADD COLUMN IF NOT EXISTS avatar_seed text;

-- Case-insensitive global handle uniqueness (partial: many wallets have no handle yet).
CREATE UNIQUE INDEX IF NOT EXISTS profile_metadata_handle_lower_uniq
    ON profile_metadata (lower(handle))
    WHERE handle IS NOT NULL;
