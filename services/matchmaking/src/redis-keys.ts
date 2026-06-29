/** Redis key conventions for matchmaking (Phase 0). */

export const REDIS_PREFIX = 'syndicate:matchmaking';

export function tableKey(tableId: string): string {
  return `${REDIS_PREFIX}:table:${tableId}`;
}

export function roomKey(roomCode: string): string {
  return `${REDIS_PREFIX}:room:${roomCode}`;
}

export function formationKey(tier: string, feed: string, token: string, bucket: string): string {
  return `${REDIS_PREFIX}:formation:${tier}:${feed}:${token}:${bucket}`;
}

export function queueKey(matchId: string): string {
  return `${REDIS_PREFIX}:queue:${matchId}`;
}

export function deadlineKey(): string {
  return `${REDIS_PREFIX}:deadlines`;
}

export function depositCacheKey(txSignature: string): string {
  return `syndicate:deposit:pending:${txSignature}`;
}

export function formationLockKey(tier: string, feed: string, token: string, bucket: string): string {
  return `${REDIS_PREFIX}:formation-lock:${tier}:${feed}:${token}:${bucket}`;
}

/** zset of open room codes (score = createdAt ms) backing the `GET /rooms` lobby feed. */
export function roomsIndexKey(): string {
  return `${REDIS_PREFIX}:rooms:index`;
}

/** Per-wallet active-room counter (anti-spam cap on player-created rooms). */
export function walletRoomsKey(wallet: string): string {
  return `${REDIS_PREFIX}:wallet-rooms:${wallet}`;
}

/** Pub/sub channel for lobby mutations; the gateway fans these out as `roomsUpdated`. */
export const ROOMS_CHANNEL = 'rooms';
