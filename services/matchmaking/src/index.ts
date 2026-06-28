/**
 * @syndicate/matchmaking — forms tables / private rooms, enforces the **deposit-to-enter
 * gate** (no seat without finalized deposit; the anti-spam control), resolves seat races
 * by deposit-finality order, applies rating buckets, and runs fill windows
 * (`05 §2, §4, §5`, `08 OQ13–OQ15`). No house bots ever seed tables (`08 OQ14`).
 */

export interface SeatRequest {
  wallet: string;
  depositFinalized: boolean;
  finalityTs: number;
  now?: number;
}

export type SeatResult = { ok: true; seatIndex: number } | { ok: false; reason: string };

export interface AdmissionDecision {
  allowed: boolean;
  reasons: string[];
}

export interface AdmissionGuard {
  canJoinTable(wallet: string, now?: number): AdmissionDecision;
}

export interface TableOptions {
  admissionGuard?: AdmissionGuard;
  seats?: { wallet: string; finalityTs: number }[];
}

export interface TableSnapshot {
  tableId: string;
  minPlayers: number;
  maxPlayers: number;
  seats: { wallet: string; finalityTs: number; depositSignature?: string }[];
  version?: number;
  mode?: 'private_host' | 'public_formation';
  fillDeadlineMs?: number;
  host?: string;
  tierId?: string;
  feedId?: string;
  token?: string;
  bucket?: string;
  status?: 'open' | 'starting' | 'started' | 'void' | 'cancelled';
}

export interface MatchmakingStore {
  loadTable(tableId: string): Promise<TableSnapshot | undefined>;
  saveTable(snapshot: TableSnapshot): Promise<void>;
  /** Compare-and-swap save; returns false if version conflict. */
  saveTableCas(snapshot: TableSnapshot, expectedVersion: number): Promise<boolean>;
}

export class Table {
  readonly seats: { wallet: string; finalityTs: number }[] = [];
  readonly minPlayers: number;
  readonly maxPlayers: number;
  private readonly admissionGuard?: AdmissionGuard;

  constructor(minPlayers: number, maxPlayers: number, opts: TableOptions = {}) {
    this.minPlayers = minPlayers;
    this.maxPlayers = maxPlayers;
    this.admissionGuard = opts.admissionGuard;
    if (opts.seats) this.seats.push(...opts.seats);
  }

  /** Seat a player only after deposit finality; resolve races by finality order. */
  requestSeat(req: SeatRequest): SeatResult {
    if (!req.depositFinalized) return { ok: false, reason: 'deposit not finalized' };
    const admission = this.admissionGuard?.canJoinTable(req.wallet, req.now ?? req.finalityTs);
    if (admission && !admission.allowed) {
      return { ok: false, reason: `trust-safety enforcement: ${admission.reasons.join('; ')}` };
    }
    if (this.seats.length >= this.maxPlayers) return { ok: false, reason: 'table full' };
    if (this.seats.some((s) => s.wallet === req.wallet)) return { ok: false, reason: 'already seated' };
    this.seats.push({ wallet: req.wallet, finalityTs: req.finalityTs });
    this.seats.sort((a, b) => a.finalityTs - b.finalityTs || a.wallet.localeCompare(b.wallet));
    return { ok: true, seatIndex: this.seats.findIndex((s) => s.wallet === req.wallet) };
  }

  canStart(): boolean {
    return this.seats.length >= this.minPlayers;
  }

  snapshot(tableId: string): TableSnapshot {
    return {
      tableId,
      minPlayers: this.minPlayers,
      maxPlayers: this.maxPlayers,
      seats: this.seats.map((s) => ({ ...s })),
    };
  }

  static fromSnapshot(snapshot: TableSnapshot, opts: TableOptions = {}): Table {
    return new Table(snapshot.minPlayers, snapshot.maxPlayers, { ...opts, seats: snapshot.seats });
  }
}

export type FillResult = { action: 'start' } | { action: 'void'; reason: string } | { action: 'wait' };

/** Decide at a fill tick: full → start; deadline with enough → start; deadline without
 * → void+refund; otherwise keep waiting. */
export function evaluateFill(table: Table, full: boolean, deadlineReached: boolean): FillResult {
  if (full) return { action: 'start' };
  if (deadlineReached) {
    return table.canStart() ? { action: 'start' } : { action: 'void', reason: 'not enough players' };
  }
  return { action: 'wait' };
}

export function bucketFor(rating: number): 'bronze' | 'silver' | 'gold' | 'elite' {
  if (rating < 1000) return 'bronze';
  if (rating < 1500) return 'silver';
  if (rating < 2000) return 'gold';
  return 'elite';
}

export type RoomStatus = 'open' | 'started' | 'cancelled' | 'void';

export class Room {
  status: RoomStatus = 'open';
  readonly table: Table;
  readonly roomId: string;
  readonly host: string;
  constructor(roomId: string, host: string, minPlayers: number, maxPlayers: number, opts: TableOptions = {}) {
    this.roomId = roomId;
    this.host = host;
    this.table = new Table(minPlayers, maxPlayers, opts);
  }
  join(req: SeatRequest): SeatResult {
    if (this.status !== 'open') return { ok: false, reason: 'room not open' };
    return this.table.requestSeat(req);
  }
  /** Host may cancel before start → full refunds. */
  hostCancel(by: string): boolean {
    if (by !== this.host || this.status !== 'open') return false;
    this.status = 'cancelled';
    return true;
  }
  /** Host disconnect before start: auto-start if quorum, else void + refunds. */
  hostDisconnect(): void {
    this.status = this.table.canStart() ? 'started' : 'void';
  }
}

export class MemoryMatchmakingStore implements MatchmakingStore {
  private tables = new Map<string, TableSnapshot>();

  async loadTable(tableId: string): Promise<TableSnapshot | undefined> {
    const snapshot = this.tables.get(tableId);
    return snapshot ? JSON.parse(JSON.stringify(snapshot)) as TableSnapshot : undefined;
  }

  async saveTable(snapshot: TableSnapshot): Promise<void> {
    const next = { ...snapshot, version: (snapshot.version ?? 0) + 1 };
    this.tables.set(snapshot.tableId, JSON.parse(JSON.stringify(next)) as TableSnapshot);
  }

  async saveTableCas(snapshot: TableSnapshot, expectedVersion: number): Promise<boolean> {
    const current = this.tables.get(snapshot.tableId);
    const curVersion = current?.version ?? 0;
    if (curVersion !== expectedVersion) return false;
    await this.saveTable({ ...snapshot, version: expectedVersion });
    return true;
  }
}

export class DurableMatchmakingService {
  private store: MatchmakingStore;
  private minPlayers: number;
  private maxPlayers: number;
  private admissionGuard?: AdmissionGuard;

  constructor(opts: {
    store: MatchmakingStore;
    minPlayers: number;
    maxPlayers: number;
    admissionGuard?: AdmissionGuard;
  }) {
    this.store = opts.store;
    this.minPlayers = opts.minPlayers;
    this.maxPlayers = opts.maxPlayers;
    this.admissionGuard = opts.admissionGuard;
  }

  async requestSeat(tableId: string, req: SeatRequest): Promise<SeatResult> {
    const existing = await this.store.loadTable(tableId);
    const table = existing
      ? Table.fromSnapshot(existing, { admissionGuard: this.admissionGuard })
      : new Table(this.minPlayers, this.maxPlayers, { admissionGuard: this.admissionGuard });
    const result = table.requestSeat(req);
    if (result.ok) await this.store.saveTable(table.snapshot(tableId));
    return result;
  }

  async loadTable(tableId: string): Promise<TableSnapshot | undefined> {
    return this.store.loadTable(tableId);
  }
}
