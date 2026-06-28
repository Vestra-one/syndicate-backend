import type { RedisClient } from '../../gateway/src/redis.ts';
import type { MatchmakingStore } from './index.ts';
import { deadlineKey, formationKey } from './redis-keys.ts';
import { evaluateStartPolicy } from './start-policy.ts';
import type { FormationRecord, OrchestratorClient } from './formation.ts';

export class DeadlineWorker {
  private timer?: ReturnType<typeof setInterval>;
  private running = false;

  constructor(
    private redis: RedisClient,
    private store: MatchmakingStore,
    private orchestrator: OrchestratorClient,
  ) {}

  start(intervalMs = 5_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const now = Date.now();
      const due = await this.redis.zrangebyscore(deadlineKey(), 0, now);
      for (const matchId of due) {
        await this.handleDeadline(matchId, now);
      }
    } finally {
      this.running = false;
    }
  }

  private async handleDeadline(matchId: string, now: number): Promise<void> {
    const table = await this.store.loadTable(matchId);
    if (!table || table.status !== 'open') {
      await this.redis.zrem(deadlineKey(), matchId);
      return;
    }
    const seated = table.seats.length;
    const mode = table.mode ?? 'public_formation';
    const policy = evaluateStartPolicy({
      mode,
      seated,
      minPlayers: table.minPlayers,
      maxPlayers: table.maxPlayers,
      fillDeadlineReached: true,
      hostStartRequested: false,
    });
    if (policy.action === 'wait') return;
    await this.orchestrator.triggerStartPolicy(matchId, policy);
    await this.redis.zrem(deadlineKey(), matchId);
    if (policy.action === 'void' && table.mode === 'public_formation' && table.tierId && table.feedId && table.token && table.bucket) {
      await this.redis.del(formationKey(table.tierId, table.feedId, table.token, table.bucket));
    }
  }
}
