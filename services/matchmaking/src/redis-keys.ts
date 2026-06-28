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
