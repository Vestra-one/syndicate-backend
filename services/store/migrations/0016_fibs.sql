-- Fibs: points a player earns for playing, winning and quick calls. They set a level and a
-- place on the daily board. Client-reported for now (free play); `player_fibs_daily` keeps
-- one row per wallet per UTC day so "today" is a cheap lookup.
CREATE TABLE IF NOT EXISTS player_fibs (
    wallet      text        PRIMARY KEY,
    fibs        bigint      NOT NULL DEFAULT 0 CHECK (fibs >= 0),
    updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS player_fibs_daily (
    wallet  text   NOT NULL,
    day     date   NOT NULL,
    fibs    bigint NOT NULL DEFAULT 0 CHECK (fibs >= 0),
    PRIMARY KEY (wallet, day)
);
CREATE INDEX IF NOT EXISTS player_fibs_daily_board_idx ON player_fibs_daily (day, fibs DESC);
