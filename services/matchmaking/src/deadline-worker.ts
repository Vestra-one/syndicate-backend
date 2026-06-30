import type { RedisClient } from '../../gateway/src/redis.ts';
import { getTierForFeed, buildMatchConfig } from '../../config/src/index.ts';
import type { MatchmakingStore } from './index.ts';
import { deadlineKey, formationKey } from './redis-keys.ts';
import { evaluateStartPolicy } from './start-policy.ts';
import type { FormationRecord, OrchestratorClient } from './formation.ts';
import { hashMatchId } from './orchestrator-client.ts';

export class DeadlineWorker {
  private timer?: ReturnType<typeof setInterval>;
  private running = false;
  private redis: RedisClient;
  private store: MatchmakingStore;
  private orchestrator: OrchestratorClient;

  constructor(
    redis: RedisClient,
    store: MatchmakingStore,
    orchestrator: OrchestratorClient,
  ) {
    this.redis = redis;
    this.store = store;
    this.orchestrator = orchestrator;
  }

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

  private async handleDeadline(matchId: string, _now: number): Promise<void> {
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
    if (policy.action === 'start' && table.tierId && table.feedId) {
      const tier = getTierForFeed(table.tierId, table.feedId);
      if (tier) {
        // Blinds/stack follow the match's chosen buy-in (the tier is a range); fall back to the
        // tier minimum if the snapshot predates buy-in tracking.
        const config = buildMatchConfig(
          table.feedId,
          table.buyIn ?? tier.buyInMin,
          table.fillWindowSec ?? tier.fillWindowMinSec,
        );
        const stack = config.buyIn * config.chipsPerUnit;
        await this.orchestrator.triggerStartPolicy(matchId, policy, {
          onchainMatchId: hashMatchId(matchId).toString(),
          tierId: table.tierId,
          feedId: table.feedId,
          players: table.seats.map((s, seatIndex) => ({
            seatIndex,
            stack,
            sealSeq: seatIndex,
            wallet: s.wallet,
          })),
          smallBlind: config.smallBlind,
          bigBlind: config.bigBlind,
          roundCount: config.roundCount,
          actionTimeoutMs: config.actionTimerSec * 1000,
        });
      }
    } else {
      await this.orchestrator.triggerStartPolicy(matchId, policy, {
        onchainMatchId: hashMatchId(matchId).toString(),
        tierId: table.tierId ?? 'tier-standard',
        feedId: table.feedId ?? 'BTC/USD',
        players: [],
        smallBlind: 1,
        bigBlind: 2,
        roundCount: 3,
        actionTimeoutMs: 25_000,
      });
    }
    await this.redis.zrem(deadlineKey(), matchId);
    if (policy.action === 'void' && table.mode === 'public_formation' && table.tierId && table.feedId && table.token && table.bucket) {
      await this.redis.del(formationKey(table.tierId, table.feedId, table.token, table.bucket));
    }
  }
}
