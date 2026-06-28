/** Offsets into Anchor `MatchAccount` (8-byte discriminator prefix). */

export const MATCH_ACCOUNT_PLAYER_COUNT_OFFSET = 235;

export function readMatchPlayerCount(data: Buffer): number {
  if (data.length <= MATCH_ACCOUNT_PLAYER_COUNT_OFFSET) {
    throw new Error('match account data too short for player_count');
  }
  const count = data.readUInt8(MATCH_ACCOUNT_PLAYER_COUNT_OFFSET);
  if (count <= 0) {
    throw new Error('match player_count must be positive before set_button_seed');
  }
  return count;
}
