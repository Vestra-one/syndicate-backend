import { randomBytes, randomUUID } from 'node:crypto';
import type { RedisClient } from '../../gateway/src/redis.ts';
import { getTierForFeed } from '../../config/src/index.ts';
import { bucketFor, Table, type MatchmakingStore, type TableSnapshot } from './index.ts';
import {
  deadlineKey,
  depositCacheKey,
  formationKey,
  formationLockKey,
  queueKey,
  roomKey,
} from './redis-keys.ts';
import { evaluateStartPolicy } from './start-policy.ts';
import {
  createSolanaRpc,
  SolanaDepositVerifier,
  type DepositVerifyResult,
} from './deposit-verify.ts';

export interface FormationRecord {
  matchId: string;
  tierId: string;
  feedId: string;
  token: string;
  bucket: string;
  fillDeadlineMs: number;
  maxPlayers: number;
  minPlayers: number;
  mode: 'public_formation' | 'private_host';
  roomCode?: string;
  host?: string;
}

export interface OrchestratorClient {
  bootstrapFormation(input: FormationRecord): Promise<{ matchId: string; onchainMatchId: number }>;
  triggerStartPolicy(matchId: string, result: ReturnType<typeof evaluateStartPolicy>): Promise<void>;
}

export class MatchmakingRuntime {
  private store: MatchmakingStore;
  private redis?: RedisClient;
  private orchestrator: OrchestratorClient;
  private depositVerifier?: SolanaDepositVerifier;
  private programId: string;
  private rooms = new Map<string, FormationRecord>();

  constructor(opts: {
    store: MatchmakingStore;
    redis?: RedisClient;
    orchestrator: OrchestratorClient;
    rpcUrl?: string;
    programId?: string;
    admissionGuard?: import('./index.ts').AdmissionGuard;
  }) {
    this.store = opts.store;
    this.redis = opts.redis;
    this.orchestrator = opts.orchestrator;
    this.programId = opts.programId ?? 'FR4tqVX41CDmUbJEbM7Qx5hxfQnfLmCJspTab7fou3WS';
    if (opts.rpcUrl) {
      this.depositVerifier = new SolanaDepositVerifier(createSolanaRpc(opts.rpcUrl));
    }
  }

  async createRoom(input: {
    host: string;
    tierId: string;
    feedId: string;
    token: string;
    maxPlayers: number;
  }): Promise<{ roomCode: string; matchId: string; fillDeadline: number; tableTerms: unknown }> {
    const tier = getTierForFeed(input.tierId, input.feedId);
    if (!tier) throw new Error('unknown tier');
    const roomCode = randomBytes(4).toString('hex');
    const matchId = randomUUID();
    const fillDeadlineMs = Date.now() + tier.fillWindowSec * 1000;
    const record: FormationRecord = {
      matchId,
      tierId: input.tierId,
      feedId: input.feedId,
      token: input.token,
      bucket: 'private',
      fillDeadlineMs,
      maxPlayers: input.maxPlayers,
      minPlayers: tier.config.minPlayers,
      mode: 'private_host',
      roomCode,
      host: input.host,
    };
    await this.orchestrator.bootstrapFormation(record);
    const snapshot: TableSnapshot = {
      tableId: matchId,
      minPlayers: tier.config.minPlayers,
      maxPlayers: input.maxPlayers,
      seats: [],
      version: 0,
      mode: 'private_host',
      fillDeadlineMs,
      host: input.host,
      tierId: input.tierId,
      feedId: input.feedId,
      token: input.token,
      status: 'open',
    };
    await this.store.saveTable(snapshot);
    this.rooms.set(roomCode, record);
    if (this.redis) {
      await this.redis.setex(roomKey(roomCode), 86400, JSON.stringify(record));
      await this.redis.zadd(deadlineKey(), fillDeadlineMs, matchId);
    }
    return {
      roomCode,
      matchId,
      fillDeadline: fillDeadlineMs,
      tableTerms: tier.config,
    };
  }

  getRoom(code: string): FormationRecord | undefined {
    return this.rooms.get(code);
  }

  async loadRoom(code: string): Promise<FormationRecord | undefined> {
    if (this.rooms.has(code)) return this.rooms.get(code);
    if (this.redis) {
      const raw = await this.redis.get(roomKey(code));
      if (raw) {
        const rec = JSON.parse(raw) as FormationRecord;
        this.rooms.set(code, rec);
        return rec;
      }
    }
    return undefined;
  }

  async roomLobby(code: string, wallet?: string): Promise<unknown> {
    const rec = await this.loadRoom(code);
    if (!rec) throw new Error('room not found');
    const table = await this.store.loadTable(rec.matchId);
    const seated = table?.seats.length ?? 0;
    return {
      roomCode: code,
      matchId: rec.matchId,
      seated,
      minPlayers: rec.minPlayers,
      maxPlayers: rec.maxPlayers,
      canHostStart: wallet === rec.host && seated >= rec.minPlayers,
      fillDeadline: rec.fillDeadlineMs,
      isHost: wallet === rec.host,
      phase: 'FILLING',
    };
  }

  async hostStart(code: string, host: string): Promise<{ ok: boolean; reason?: string }> {
    const rec = await this.loadRoom(code);
    if (!rec || rec.host !== host) return { ok: false, reason: 'not host' };
    const table = await this.store.loadTable(rec.matchId);
    const seated = table?.seats.length ?? 0;
    const policy = evaluateStartPolicy({
      mode: 'private_host',
      seated,
      minPlayers: rec.minPlayers,
      maxPlayers: rec.maxPlayers,
      fillDeadlineReached: false,
      hostStartRequested: true,
    });
    if (policy.action !== 'start') return { ok: false, reason: policy.reason ?? 'cannot start' };
    await this.orchestrator.triggerStartPolicy(rec.matchId, policy);
    return { ok: true };
  }

  async joinQueue(input: {
    tierId: string;
    feedId: string;
    token: string;
    wallet: string;
    rating?: number;
  }): Promise<{
    matchId: string;
    fillDeadline: number;
    playersWaiting: number;
    status: 'forming' | 'idle';
    depositRequired: boolean;
  }> {
    const tier = getTierForFeed(input.tierId, input.feedId);
    if (!tier) throw new Error('unknown tier');
    if (tier.practiceMode) {
      const matchId = randomUUID();
      return { matchId, fillDeadline: Date.now() + 60_000, playersWaiting: 1, status: 'forming', depositRequired: false };
    }
    const bucket = bucketFor(input.rating ?? 1000);
    const fKey = formationKey(input.tierId, input.feedId, input.token, bucket);
    let record: FormationRecord | undefined;
    if (this.redis) {
      const raw = await this.redis.get(fKey);
      if (raw) record = JSON.parse(raw) as FormationRecord;
    }
    if (!record) {
      const lock = this.redis
        ? await this.redis.setnx(formationLockKey(input.tierId, input.feedId, input.token, bucket), '1', 30)
        : true;
      if (!lock && this.redis) {
        const raw = await this.redis.get(fKey);
        if (raw) record = JSON.parse(raw) as FormationRecord;
      }
      if (!record) {
        const matchId = randomUUID();
        const fillDeadlineMs = Date.now() + tier.fillWindowSec * 1000;
        record = {
          matchId,
          tierId: input.tierId,
          feedId: input.feedId,
          token: input.token,
          bucket,
          fillDeadlineMs,
          maxPlayers: tier.config.maxPlayers,
          minPlayers: tier.config.minPlayers,
          mode: 'public_formation',
        };
        await this.orchestrator.bootstrapFormation(record);
        const snapshot: TableSnapshot = {
          tableId: matchId,
          minPlayers: tier.config.minPlayers,
          maxPlayers: tier.config.maxPlayers,
          seats: [],
          version: 0,
          mode: 'public_formation',
          fillDeadlineMs,
          tierId: input.tierId,
          feedId: input.feedId,
          token: input.token,
          bucket,
          status: 'open',
        };
        await this.store.saveTable(snapshot);
        if (this.redis) {
          await this.redis.setex(fKey, tier.fillWindowSec + 300, JSON.stringify(record));
          await this.redis.zadd(deadlineKey(), fillDeadlineMs, matchId);
          await this.redis.zadd(queueKey(matchId), Date.now(), input.wallet);
        }
      }
    } else if (this.redis) {
      await this.redis.zadd(queueKey(record.matchId), Date.now(), input.wallet);
    }
    const table = await this.store.loadTable(record.matchId);
    return {
      matchId: record.matchId,
      fillDeadline: record.fillDeadlineMs,
      playersWaiting: table?.seats.length ?? 0,
      status: 'forming',
      depositRequired: true,
    };
  }

  async queueStatus(tierId: string, feedId: string, token: string, rating = 1000): Promise<unknown> {
    const bucket = bucketFor(rating);
    const fKey = formationKey(tierId, feedId, token, bucket);
    if (!this.redis) return { active: false, playersWaiting: 0, seated: 0, minPlayers: 2, maxPlayers: 5, fillDeadline: null };
    const raw = await this.redis.get(fKey);
    if (!raw) {
      return { active: false, playersWaiting: 0, seated: 0, minPlayers: 2, maxPlayers: 5, fillDeadline: null };
    }
    const rec = JSON.parse(raw) as FormationRecord;
    const table = await this.store.loadTable(rec.matchId);
    const seated = table?.seats.length ?? 0;
    return {
      active: true,
      playersWaiting: seated,
      seated,
      minPlayers: rec.minPlayers,
      maxPlayers: rec.maxPlayers,
      fillDeadline: rec.fillDeadlineMs,
      matchId: rec.matchId,
    };
  }

  async verifyDeposit(input: {
    matchId: string;
    wallet: string;
    txSignature: string;
    seatIndex?: number;
    tierId?: string;
    feedId?: string;
  }): Promise<DepositVerifyResult & { seat?: number }> {
    if (this.redis) {
      const cached = await this.redis.get(depositCacheKey(input.txSignature));
      if (cached) return JSON.parse(cached) as DepositVerifyResult;
    }
    const table = await this.store.loadTable(input.matchId);
    if (!table) return { ok: false, reason: 'unknown match' };
    const tier = getTierForFeed(input.tierId ?? table.tierId ?? 'tier-low', input.feedId ?? table.feedId ?? 'BTC/USD');
    const buyIn = tier?.config.buyIn ?? 0;
    const entryFee = tier?.config.entryFee ?? 0;
    let result: DepositVerifyResult;
    if (!this.depositVerifier || buyIn === 0) {
      result = { ok: true, wallet: input.wallet, seatIndex: input.seatIndex ?? table.seats.length, finalityTs: Date.now(), slot: 0 };
    } else {
      result = await this.depositVerifier.verify({
        matchId: input.matchId,
        wallet: input.wallet,
        txSignature: input.txSignature,
        seatIndex: input.seatIndex,
        expectedBuyIn: buyIn,
        expectedEntryFee: entryFee,
        programId: this.programId,
      });
    }
    if (!result.ok) return result;
    const version = table.version ?? 0;
    const t = Table.fromSnapshot(table);
    const seatResult = t.requestSeat({
      wallet: input.wallet,
      depositFinalized: true,
      finalityTs: result.finalityTs,
    });
    if (!seatResult.ok) return { ok: false, reason: seatResult.reason };
    const next = t.snapshot(input.matchId);
    next.seats[seatResult.seatIndex] = {
      ...next.seats[seatResult.seatIndex],
      depositSignature: input.txSignature,
    };
    next.mode = table.mode;
    next.fillDeadlineMs = table.fillDeadlineMs;
    next.host = table.host;
    next.tierId = table.tierId;
    next.feedId = table.feedId;
    next.token = table.token;
    next.bucket = table.bucket;
    next.status = table.status;
    const saved = await this.store.saveTableCas(next, version);
    if (!saved) return { ok: false, reason: 'seat race lost' };
    if (this.redis) {
      await this.redis.setex(depositCacheKey(input.txSignature), 3600, JSON.stringify({ ...result, seat: seatResult.seatIndex }));
    }
    if (table.mode === 'public_formation') {
      const policy = evaluateStartPolicy({
        mode: 'public_formation',
        seated: next.seats.length,
        minPlayers: next.minPlayers,
        maxPlayers: next.maxPlayers,
        fillDeadlineReached: false,
      });
      if (policy.action === 'start') {
        await this.orchestrator.triggerStartPolicy(input.matchId, policy);
        if (this.redis) await this.redis.zrem(deadlineKey(), input.matchId);
      }
    }
    return { ...result, seat: seatResult.seatIndex };
  }
}
