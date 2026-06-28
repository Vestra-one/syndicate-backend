import { RedisClient } from '../../gateway/src/redis.ts';
import type { MatchmakingStore, TableSnapshot } from './index.ts';
import { tableKey } from './redis-keys.ts';

const TABLE_TTL_SEC = 30 * 24 * 60 * 60;

export class RedisMatchmakingStore implements MatchmakingStore {
  private redis: RedisClient;

  constructor(redis: RedisClient) {
    this.redis = redis;
  }

  async loadTable(tableId: string): Promise<TableSnapshot | undefined> {
    const raw = await this.redis.get(tableKey(tableId));
    return raw === null ? undefined : (JSON.parse(raw) as TableSnapshot);
  }

  async saveTable(snapshot: TableSnapshot): Promise<void> {
    const next = { ...snapshot, version: (snapshot.version ?? 0) + 1 };
    await this.redis.setex(tableKey(snapshot.tableId), TABLE_TTL_SEC, JSON.stringify(next));
  }

  async saveTableCas(snapshot: TableSnapshot, expectedVersion: number): Promise<boolean> {
    const key = tableKey(snapshot.tableId);
    const raw = await this.redis.get(key);
    const current = raw === null ? undefined : (JSON.parse(raw) as TableSnapshot);
    const curVersion = current?.version ?? 0;
    if (curVersion !== expectedVersion) return false;
    const next = { ...snapshot, version: expectedVersion + 1 };
    await this.redis.setex(key, TABLE_TTL_SEC, JSON.stringify(next));
    return true;
  }
}
