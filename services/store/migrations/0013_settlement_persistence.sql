-- Settlement outcome persistence (v2).
--
-- Per-seat payouts today live only on-chain (seat PDAs) plus a JSON audit trail on the
-- confirming chain_job (`chain_jobs.oracle_audit`). Neither is queryable for history,
-- leaderboards, or profile stats. This migration adds typed columns that the game-server
-- backfills (read-after-confirm, idempotent — see chainjobs.rs::persist_settlement_outcome)
-- once a `submit_settlement` job confirms.
--
-- IMPORTANT: `pot_won_chips` (not `payout_chips`) is the winner signal. `payout_chips`
-- includes each seat's uncontributed remainder (buy_in − contribution), so a player who
-- folded before betting still gets a payout close to their buy-in back — that is NOT a
-- win. A seat won money from the pot iff `pot_won_chips > 0`.
ALTER TABLE match_seats
    ADD COLUMN IF NOT EXISTS payout_chips bigint,
    ADD COLUMN IF NOT EXISTS pot_won_chips bigint,
    ADD COLUMN IF NOT EXISTS prediction_wad numeric(45,0);

ALTER TABLE matches
    ADD COLUMN IF NOT EXISTS settlement_price_wad numeric(45,0),
    ADD COLUMN IF NOT EXISTS final_pot_chips bigint,
    ADD COLUMN IF NOT EXISTS rake_chips bigint,
    ADD COLUMN IF NOT EXISTS settlement_tx_sig text;

-- Terminal-match history, newest first, with real keyset pagination.
CREATE INDEX IF NOT EXISTS matches_history_idx
    ON matches ((COALESCE(settled_at, voided_at, created_at)) DESC, id DESC)
    WHERE status IN ('settled', 'voided');

-- Leaderboard time-window scans.
CREATE INDEX IF NOT EXISTS matches_settled_at_idx
    ON matches (settled_at DESC)
    WHERE status = 'settled';

-- Leaderboard/profile aggregation entry point.
CREATE INDEX IF NOT EXISTS match_seats_wallet_idx
    ON match_seats (wallet_address);

-- Match-level backfill for already-settled rows, sourced from the confirmed settlement
-- job's audit JSON (settlement price, rake, tx sig — all present in the existing audit
-- format). Per-seat payouts/pot_won are NOT backfilled: the pre-migration audit format
-- didn't carry them, and reconstructing them would require a full event replay. Legacy
-- settled matches simply show a null winner and are excluded from aggregates (queries
-- filter on `payout_chips IS NOT NULL`).
UPDATE matches m
SET settlement_price_wad = NULLIF(cj.oracle_audit->>'settlement_price_wad', '')::numeric,
    rake_chips           = NULLIF(cj.oracle_audit->>'rake_collected', '')::bigint,
    settlement_tx_sig    = cj.tx_signature
FROM chain_jobs cj
WHERE cj.match_id = m.id
  AND cj.kind = 'submit_settlement'
  AND cj.status = 'confirmed'
  AND m.status = 'settled'
  AND m.settlement_price_wad IS NULL;
