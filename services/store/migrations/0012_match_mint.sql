-- Per-match chip-token mint (v2).
--
-- The contract is token-agnostic: the match creator supplies an arbitrary SPL Mint at
-- create_and_deposit and joiners inherit it on-chain (player_token.mint == match.mint).
-- The backend restricts the usable set to an operator-configured allowlist
-- (CHIPS_TOKEN_MINTS) and records which allowed mint each match uses, so joiners know
-- which token to deposit. Nullable: backfilled by the seat verifier when a create tx is
-- confirmed; also written up-front from the create intent.
ALTER TABLE matches ADD COLUMN IF NOT EXISTS mint text;
