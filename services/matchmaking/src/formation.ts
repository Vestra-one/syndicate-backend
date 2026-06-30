import { randomBytes, randomUUID } from 'node:crypto';
import type { RedisClient } from '../../gateway/src/redis.ts';
import {
  getTierForFeed,
  getTemplateByHash,
  templateAllowlist,
  buildMatchConfig,
  type TierDefinition,
} from '../../config/src/index.ts';
import { tableTermsForTier } from '../../config/src/table-terms.ts';
import { bucketFor, Table, type MatchmakingStore, type TableSnapshot } from './index.ts';
import {
  deadlineKey,
  depositCacheKey,
  formationKey,
  formationLockKey,
  queueKey,
  roomKey,
  roomsIndexKey,
  walletRoomsKey,
  ROOMS_CHANNEL,
} from './redis-keys.ts';
import { evaluateStartPolicy } from './start-policy.ts';
import { type ChainVerifier } from './chain-verify.ts';
import { NOOP_PERSISTENCE, type MatchPersistence } from './persistence.ts';

/** Default per-wallet active-room cap (anti-spam on player-created rooms). */
export const DEFAULT_WALLET_ROOM_CAP = 3;

/** Fallback fill window when no tier/selection is resolvable (seconds). */
const FALLBACK_FILL_WINDOW_SEC = 120;

/** Queue bucket key that segregates by skill rating AND the chosen buy-in / fill-window, so
 *  only players who picked the same terms merge into one forming match. */
function selectionBucket(rating: number, buyIn: number, fillWindowSec: number): string {
  return `${bucketFor(rating)}:b${buyIn}:f${fillWindowSec}`;
}

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
  onchainMatchId?: string;
  matchPda?: string;
  configHash?: string;
  buyIn?: number;
  /** Creator-selected fill window (seconds), within the tier range. */
  fillWindowSec?: number;
  entryFee?: number;
  seatCount?: number;
  createdAtMs?: number;
}

/**
 * Orchestrator seam. v1 is player-created: matchmaking NEVER creates matches on-chain, so the
 * old `bootstrapFormation` is gone. The only call left is the start trigger (lock → begin_live).
 */
export interface OrchestratorClient {
  triggerStartPolicy(
    matchId: string,
    result: ReturnType<typeof evaluateStartPolicy>,
    ctx: import('./orchestrator-client.ts').StartContext,
  ): Promise<void>;
}

export type CreateRoomResult =
  | {
      ok: true;
      roomCode: string;
      matchId: string;
      onchainMatchId: string;
      matchPda: string;
      fillDeadline: number;
      tableTerms: unknown;
    }
  | { ok: false; reason: string };

export type DepositResult =
  | { ok: true; wallet: string; seat: number; matchPda: string; onchainMatchId?: string }
  | { ok: false; reason: string };

/** Anonymized-but-identifiable seat occupant for the lobby feed (UX-only). */
export interface LobbySeat {
  seatIndex: number;
  wallet: string;
  joinedTs: number;
}

export interface RoomListing {
  roomCode: string;
  matchId: string;
  onchainMatchId?: string;
  feedId: string;
  tierId: string;
  configHash?: string;
  buyIn?: number;
  seated: number;
  seats: LobbySeat[];
  minPlayers: number;
  maxPlayers: number;
  fillDeadline: number;
}

/** Map a table snapshot's seats to the lobby seat shape (UX-only; ordered by seat index). */
function lobbySeats(table: TableSnapshot | undefined): LobbySeat[] {
  return (table?.seats ?? []).map((s, seatIndex) => ({ seatIndex, wallet: s.wallet, joinedTs: s.finalityTs }));
}

/**
 * Validate a creator-selected buy-in / fill-window against the tier's range (off-chain fast
 * fail; the contract re-enforces the operator-governed bounds at create). Returns an error
 * string or `undefined` when valid.
 */
export function validateSelection(tier: TierDefinition, buyIn: number, fillWindowSec: number): string | undefined {
  if (!Number.isInteger(buyIn) || buyIn < tier.buyInMin || buyIn > tier.buyInMax) {
    return `buyIn must be an integer in [${tier.buyInMin}, ${tier.buyInMax}]`;
  }
  if (!Number.isInteger(fillWindowSec) || fillWindowSec < tier.fillWindowMinSec || fillWindowSec > tier.fillWindowMaxSec) {
    return `fillWindowSec must be an integer in [${tier.fillWindowMinSec}, ${tier.fillWindowMaxSec}]`;
  }
  return undefined;
}

export class MatchmakingRuntime {
  private store: MatchmakingStore;
  private redis?: RedisClient;
  private orchestrator: OrchestratorClient;
  private chainVerifier?: ChainVerifier;
  private persistence: MatchPersistence;
  private walletRoomCap: number;
  private rooms = new Map<string, FormationRecord>();
  // In-memory fallbacks when Redis is absent (tests / single-process dev).
  private seenSigs = new Map<string, unknown>();
  private walletRooms = new Map<string, number>();

  constructor(opts: {
    store: MatchmakingStore;
    redis?: RedisClient;
    orchestrator: OrchestratorClient;
    chainVerifier?: ChainVerifier;
    persistence?: MatchPersistence;
    walletRoomCap?: number;
    admissionGuard?: import('./index.ts').AdmissionGuard;
  }) {
    this.store = opts.store;
    this.redis = opts.redis;
    this.orchestrator = opts.orchestrator;
    this.chainVerifier = opts.chainVerifier;
    this.persistence = opts.persistence ?? NOOP_PERSISTENCE;
    this.walletRoomCap = opts.walletRoomCap ?? DEFAULT_WALLET_ROOM_CAP;
  }

  /**
   * Host create report. The host already submitted `create_and_deposit` on-chain and reports the
   * txhash; the backend verifies it (settlement-chain, Phase 02) before registering the room.
   * Matchmaking creates nothing on-chain. The match/seat rows + registry are UX-only — capital
   * safety reads chain, never this registry.
   */
  async createRoom(input: {
    createTxSig: string;
    matchPda: string;
    onchainMatchId: string;
    configHash: string;
    wallet: string;
    seatIndex?: number;
    maxPlayers?: number;
  }): Promise<CreateRoomResult> {
    // Idempotency: a re-reported create txhash is a no-op (reuses the pending-deposit key).
    const prior = await this.lookupReportedSig(input.createTxSig);
    if (prior && (prior as CreateRoomResult).ok) return prior as CreateRoomResult;

    // Allowlist gate (also enforced on-chain inside verifyCreate; checked here to fail fast).
    if (!templateAllowlist().has(input.configHash)) {
      return { ok: false, reason: 'config_hash is not allowlisted' };
    }
    const template = getTemplateByHash(input.configHash);
    if (!template) return { ok: false, reason: 'unknown template for config_hash' };
    const tier = getTierForFeed(template.tierId, template.feed);
    if (!tier) return { ok: false, reason: 'unknown tier' };

    // Per-wallet cap (anti-spam). Counted only for genuinely new rooms; never blocks capital.
    if ((await this.walletRoomCount(input.wallet)) >= this.walletRoomCap) {
      return { ok: false, reason: 'per-wallet active room cap reached' };
    }

    // Authoritative on-chain verification (no indexer): finalized tx + seat == buy_in + Filling.
    if (!this.chainVerifier) return { ok: false, reason: 'chain verifier not configured' };
    const verified = await this.chainVerifier.verifyCreate({
      txSig: input.createTxSig,
      onchainMatchId: input.onchainMatchId,
      wallet: input.wallet,
      seatIndex: input.seatIndex,
    });
    if (!verified.ok) return { ok: false, reason: verified.reason };

    const matchId = input.matchPda;
    const roomCode = randomBytes(4).toString('hex');
    const now = Date.now();
    // Buy-in and fill deadline are creator-selected per match and ALREADY on-chain — read the
    // authoritative values from the verified `MatchAccount`, not from the (ranged) tier.
    const buyIn = Number(verified.buyIn);
    const onchainMatch = verified.match as { fillDeadlineTs?: string | number } | undefined;
    const fillDeadlineMs = onchainMatch?.fillDeadlineTs !== undefined
      ? Number(onchainMatch.fillDeadlineTs) * 1000
      : now + tier.fillWindowMinSec * 1000;
    // Reconstruct an in-range fill window for UX/terms display (the on-chain deadline is the
    // authoritative timing; this derived window only drives engine blinds + table-terms display).
    const fillWindowSec = Math.min(
      tier.fillWindowMaxSec,
      Math.max(tier.fillWindowMinSec, Math.round((fillDeadlineMs - now) / 1000)),
    );
    const entryFee = tier.config.entryFee;
    const seatIndex = verified.seatIndex;

    const record: FormationRecord = {
      matchId,
      tierId: template.tierId,
      feedId: template.feed,
      token: tier.config.chipsToken,
      bucket: 'private',
      fillDeadlineMs,
      maxPlayers: input.maxPlayers ?? tier.config.maxPlayers,
      minPlayers: tier.config.minPlayers,
      mode: 'private_host',
      roomCode,
      host: input.wallet,
      onchainMatchId: input.onchainMatchId,
      matchPda: input.matchPda,
      configHash: input.configHash,
      buyIn,
      fillWindowSec,
      entryFee,
      seatCount: 1,
      createdAtMs: now,
    };

    // Persist canonical match + creator seat (Phase 05). Best-effort: registry is UX-only.
    await this.persistence.insertMatch({
      matchKey: matchId,
      onchainMatchId: input.onchainMatchId,
      configHash: input.configHash,
      fillDeadlineMs,
    });
    await this.persistence.insertMatchSeat({
      matchKey: matchId,
      seatIndex,
      wallet: input.wallet,
      depositSignature: input.createTxSig,
      buyInChips: buyIn,
      entryFeeChips: entryFee,
    });

    const snapshot: TableSnapshot = {
      tableId: matchId,
      minPlayers: record.minPlayers,
      maxPlayers: record.maxPlayers,
      seats: [{ wallet: input.wallet, finalityTs: now, depositSignature: input.createTxSig }],
      version: 0,
      mode: 'private_host',
      fillDeadlineMs,
      host: input.wallet,
      tierId: record.tierId,
      feedId: record.feedId,
      token: record.token,
      buyIn,
      fillWindowSec,
      status: 'open',
    };
    await this.store.saveTable(snapshot);

    await this.registerRoom(record);
    await this.bumpWalletRooms(input.wallet, 1);

    const result: CreateRoomResult = {
      ok: true,
      roomCode,
      matchId,
      onchainMatchId: input.onchainMatchId,
      matchPda: input.matchPda,
      fillDeadline: fillDeadlineMs,
      tableTerms:
        tableTermsForTier(matchId, record.tierId, record.feedId, {
          onchainMatchId: record.onchainMatchId,
          matchPda: record.matchPda,
          buyIn,
          fillWindowSec,
        }) ?? tier.config,
    };
    await this.markReportedSig(input.createTxSig, result);
    return result;
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
    const seated = table?.seats.length ?? rec.seatCount ?? 0;
    return {
      roomCode: code,
      matchId: rec.matchId,
      onchainMatchId: rec.onchainMatchId,
      matchPda: rec.matchPda,
      seated,
      seats: lobbySeats(table),
      minPlayers: rec.minPlayers,
      maxPlayers: rec.maxPlayers,
      canHostStart: wallet === rec.host && seated >= rec.minPlayers,
      fillDeadline: rec.fillDeadlineMs,
      isHost: wallet === rec.host,
      phase: 'FILLING',
    };
  }

  /**
   * Lobby feed served entirely from the registry. Filters by feed/template/buyIn and ranks so
   * fuller, closer-to-start rooms surface first; new/single-occupant rooms are buried.
   */
  async listRooms(filter: { feed?: string; template?: string; buyIn?: number } = {}): Promise<RoomListing[]> {
    const records = await this.allOpenRecords();
    const now = Date.now();
    const listings: RoomListing[] = [];
    for (const rec of records) {
      if (!rec.roomCode) continue;
      if (rec.fillDeadlineMs <= now) continue;
      if (filter.feed && rec.feedId !== filter.feed) continue;
      if (filter.template && rec.configHash !== filter.template) continue;
      if (filter.buyIn !== undefined && rec.buyIn !== filter.buyIn) continue;
      const table = await this.store.loadTable(rec.matchId);
      const seated = table?.seats.length ?? rec.seatCount ?? 0;
      if (seated >= rec.maxPlayers) continue; // full rooms are not joinable
      listings.push({
        roomCode: rec.roomCode,
        matchId: rec.matchId,
        onchainMatchId: rec.onchainMatchId,
        feedId: rec.feedId,
        tierId: rec.tierId,
        configHash: rec.configHash,
        buyIn: rec.buyIn,
        seated,
        seats: lobbySeats(table),
        minPlayers: rec.minPlayers,
        maxPlayers: rec.maxPlayers,
        fillDeadline: rec.fillDeadlineMs,
      });
    }
    // Rank: more-seated first (bury single-occupant), then soonest fill deadline.
    listings.sort((a, b) => b.seated - a.seated || a.fillDeadline - b.fillDeadline);
    return listings;
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
    if (!table) return { ok: false, reason: 'table not found' };
    await this.triggerStart(rec, table, policy);
    return { ok: true };
  }

  private async triggerStart(
    rec: FormationRecord,
    table: NonNullable<Awaited<ReturnType<MatchmakingStore['loadTable']>>>,
    policy: ReturnType<typeof evaluateStartPolicy>,
  ) {
    const tier = getTierForFeed(rec.tierId, rec.feedId);
    if (!tier) throw new Error('unknown tier');
    // Stack and blinds follow the match's CHOSEN buy-in (the ranged tier config is only a
    // representative at the minimum), so build the concrete config from the recorded selection.
    const buyIn = rec.buyIn ?? tier.buyInMin;
    const fillWindowSec = rec.fillWindowSec ?? tier.fillWindowMinSec;
    const config = buildMatchConfig(rec.feedId, buyIn, fillWindowSec);
    const stack = config.buyIn * config.chipsPerUnit;
    const ctx: import('./orchestrator-client.ts').StartContext = {
      onchainMatchId: rec.onchainMatchId ?? String(rec.matchId),
      matchPda: rec.matchPda,
      tierId: rec.tierId,
      feedId: rec.feedId,
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
    };
    await this.orchestrator.triggerStartPolicy(rec.matchId, policy, ctx);
    await this.publishRoomsUpdate(rec, 'started');
  }

  async joinQueue(input: {
    tierId: string;
    feedId: string;
    token: string;
    wallet: string;
    rating?: number;
    /** Creator-selected buy-in / fill-window (within the tier range). Default to tier minimums. */
    buyIn?: number;
    fillWindowSec?: number;
  }): Promise<{
    matchId: string;
    onchainMatchId?: string;
    matchPda?: string;
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
    const buyIn = input.buyIn ?? tier.buyInMin;
    const fillWindowSec = input.fillWindowSec ?? tier.fillWindowMinSec;
    const selErr = validateSelection(tier, buyIn, fillWindowSec);
    if (selErr) throw new Error(selErr);
    // Segregate queues by buy-in/fill-window so only players who chose the same terms merge.
    const bucket = selectionBucket(input.rating ?? 1000, buyIn, fillWindowSec);
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
        const fillDeadlineMs = Date.now() + fillWindowSec * 1000;
        // No on-chain create here: matchmaking never creates matches. The on-chain match is
        // established when the first player reports a verified create_and_deposit txhash.
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
          buyIn,
          fillWindowSec,
        };
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
          buyIn,
          fillWindowSec,
          status: 'open',
        };
        await this.store.saveTable(snapshot);
        if (this.redis) {
          await this.redis.setex(fKey, fillWindowSec + 300, JSON.stringify(record));
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
      onchainMatchId: record.onchainMatchId,
      matchPda: record.matchPda,
      fillDeadline: record.fillDeadlineMs,
      playersWaiting: table?.seats.length ?? 0,
      status: 'forming',
      depositRequired: true,
    };
  }

  async queueStatus(
    tierId: string,
    feedId: string,
    token: string,
    rating = 1000,
    buyIn?: number,
    fillWindowSec?: number,
  ): Promise<unknown> {
    const tier = getTierForFeed(tierId, feedId);
    const bIn = buyIn ?? tier?.buyInMin ?? 0;
    const fWin = fillWindowSec ?? tier?.fillWindowMinSec ?? FALLBACK_FILL_WINDOW_SEC;
    const bucket = selectionBucket(rating, bIn, fWin);
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
      onchainMatchId: rec.onchainMatchId,
      matchPda: rec.matchPda,
    };
  }

  /**
   * Joiner deposit report. The joiner submitted `deposit` on-chain and reports the txhash; the
   * backend verifies it on-chain (settlement-chain), seats the player, persists the seat row, and
   * bumps the registry seat count.
   */
  async verifyDeposit(input: {
    matchId: string;
    wallet: string;
    txSignature: string;
    seatIndex?: number;
    tierId?: string;
    feedId?: string;
  }): Promise<DepositResult> {
    // Idempotency: a re-reported deposit txhash is a no-op.
    const prior = await this.lookupReportedSig(input.txSignature);
    if (prior && (prior as DepositResult).ok) return prior as DepositResult;

    const table = await this.store.loadTable(input.matchId);
    if (!table) return { ok: false, reason: 'unknown match' };
    const rec = await this.loadRoom(input.matchId);
    const onchainMatchId = rec?.onchainMatchId;
    if (!onchainMatchId) return { ok: false, reason: 'match has no on-chain id (create not reported)' };

    if (!this.chainVerifier) return { ok: false, reason: 'chain verifier not configured' };
    const verified = await this.chainVerifier.verifyDeposit({
      txSig: input.txSignature,
      onchainMatchId,
      wallet: input.wallet,
      seatIndex: input.seatIndex,
    });
    if (!verified.ok) return { ok: false, reason: verified.reason };

    const version = table.version ?? 0;
    const t = Table.fromSnapshot(table);
    const seatResult = t.requestSeat({
      wallet: input.wallet,
      depositFinalized: true,
      finalityTs: Date.now(),
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

    // Persist seat row (Phase 05). Use the on-chain-verified seat index for array correctness.
    if (rec) {
      const tier = getTierForFeed(rec.tierId, rec.feedId);
      await this.persistence.insertMatchSeat({
        matchKey: rec.matchId,
        seatIndex: verified.seatIndex,
        wallet: input.wallet,
        depositSignature: input.txSignature,
        buyInChips: rec.buyIn ?? tier?.config.buyIn ?? 0,
        entryFeeChips: rec.entryFee ?? tier?.config.entryFee ?? 0,
      });
      rec.seatCount = next.seats.length;
      await this.registerRoom(rec); // refresh seat count in the registry
    }

    if (table.mode === 'public_formation') {
      const policy = evaluateStartPolicy({
        mode: 'public_formation',
        seated: next.seats.length,
        minPlayers: next.minPlayers,
        maxPlayers: next.maxPlayers,
        fillDeadlineReached: false,
      });
      if (policy.action === 'start' && rec) {
        // Bug fix (was `record`, undefined here): start from the in-scope, verified room record.
        await this.triggerStart(rec, next, policy);
        if (this.redis) await this.redis.zrem(deadlineKey(), input.matchId);
      }
    }

    const result: DepositResult = {
      ok: true,
      wallet: input.wallet,
      seat: seatResult.seatIndex,
      matchPda: rec?.matchPda ?? input.matchId,
      onchainMatchId,
    };
    await this.markReportedSig(input.txSignature, result);
    return result;
  }

  async matchTerms(matchId: string): Promise<unknown> {
    const table = await this.store.loadTable(matchId);
    if (!table?.tierId || !table.feedId) return undefined;
    const rec = await this.loadRoom(matchId);
    return tableTermsForTier(matchId, table.tierId, table.feedId, {
      onchainMatchId: rec?.onchainMatchId,
      matchPda: rec?.matchPda,
    });
  }

  // ---------------- registry helpers ----------------

  /** Store a room under its code (and matchId alias) + index it for the lobby feed. */
  private async registerRoom(rec: FormationRecord): Promise<void> {
    if (rec.roomCode) this.rooms.set(rec.roomCode, rec);
    this.rooms.set(rec.matchId, rec);
    if (this.redis) {
      const ttl = Math.max(60, Math.ceil((rec.fillDeadlineMs - Date.now()) / 1000) + 300);
      const payload = JSON.stringify(rec);
      if (rec.roomCode) {
        await this.redis.setex(roomKey(rec.roomCode), ttl, payload);
        await this.redis.zadd(roomsIndexKey(), rec.createdAtMs ?? Date.now(), rec.roomCode);
        await this.redis.zadd(deadlineKey(), rec.fillDeadlineMs, rec.matchId);
      }
      await this.redis.setex(roomKey(rec.matchId), ttl, payload); // matchId alias for deposit lookups
      await this.publishRoomsUpdate(rec, 'upsert');
    }
  }

  /**
   * Publish a lobby mutation so the gateway can push `roomsUpdated` to lobby subscribers. The
   * `version` lets the client discard out-of-order updates (last-writer-wins). UX-only; a missed
   * publish just means clients fall back to the `GET /rooms` pull.
   */
  private async publishRoomsUpdate(rec: FormationRecord, kind: 'upsert' | 'started'): Promise<void> {
    if (!this.redis) return;
    try {
      // One extra table load per lobby mutation; seat arrays are bounded by maxPlayers (2–5).
      const table = await this.store.loadTable(rec.matchId);
      const seats = lobbySeats(table);
      await this.redis.publish(
        ROOMS_CHANNEL,
        JSON.stringify({
          kind,
          roomCode: rec.roomCode,
          matchId: rec.matchId,
          feedId: rec.feedId,
          tierId: rec.tierId,
          configHash: rec.configHash,
          buyIn: rec.buyIn,
          seated: rec.seatCount ?? 0,
          seats,
          maxPlayers: rec.maxPlayers,
          fillDeadline: rec.fillDeadlineMs,
          version: (rec.createdAtMs ?? 0) + (rec.seatCount ?? 0),
        }),
      );
    } catch {
      // best-effort; pull fallback covers a dropped publish
    }
  }

  private async allOpenRecords(): Promise<FormationRecord[]> {
    if (!this.redis) {
      // De-dupe the in-memory map (rooms are stored under both code and matchId alias).
      const byCode = new Map<string, FormationRecord>();
      for (const rec of this.rooms.values()) if (rec.roomCode) byCode.set(rec.roomCode, rec);
      return [...byCode.values()];
    }
    const codes = await this.redis.zrangebyscore(roomsIndexKey(), 0, Number.MAX_SAFE_INTEGER);
    const out: FormationRecord[] = [];
    for (const code of codes) {
      const rec = await this.loadRoom(code);
      if (rec) out.push(rec);
    }
    return out;
  }

  private async lookupReportedSig(sig: string): Promise<unknown | null> {
    if (this.redis) {
      const c = await this.redis.get(depositCacheKey(sig));
      return c ? JSON.parse(c) : null;
    }
    return this.seenSigs.get(sig) ?? null;
  }

  private async markReportedSig(sig: string, payload: unknown): Promise<void> {
    if (this.redis) await this.redis.setex(depositCacheKey(sig), 3600, JSON.stringify(payload));
    else this.seenSigs.set(sig, payload);
  }

  private async walletRoomCount(wallet: string): Promise<number> {
    if (this.redis) {
      const v = await this.redis.get(walletRoomsKey(wallet));
      return v ? Number(v) : 0;
    }
    return this.walletRooms.get(wallet) ?? 0;
  }

  private async bumpWalletRooms(wallet: string, delta: number): Promise<void> {
    if (this.redis) {
      // Minimal Redis client has no DECR; the cap is a soft anti-spam gate, so increment + a
      // 24h TTL is sufficient (stale counters self-expire).
      if (delta > 0) {
        await this.redis.incr(walletRoomsKey(wallet));
        await this.redis.expire(walletRoomsKey(wallet), 86_400);
      }
    } else {
      this.walletRooms.set(wallet, Math.max(0, (this.walletRooms.get(wallet) ?? 0) + delta));
    }
  }
}
