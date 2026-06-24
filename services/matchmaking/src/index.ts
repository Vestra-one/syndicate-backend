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
}

export type SeatResult = { ok: true; seatIndex: number } | { ok: false; reason: string };

export class Table {
  readonly seats: { wallet: string; finalityTs: number }[] = [];
  readonly minPlayers: number;
  readonly maxPlayers: number;
  constructor(minPlayers: number, maxPlayers: number) {
    this.minPlayers = minPlayers;
    this.maxPlayers = maxPlayers;
  }

  /** Seat a player only after deposit finality; resolve races by finality order. */
  requestSeat(req: SeatRequest): SeatResult {
    if (!req.depositFinalized) return { ok: false, reason: 'deposit not finalized' };
    if (this.seats.length >= this.maxPlayers) return { ok: false, reason: 'table full' };
    if (this.seats.some((s) => s.wallet === req.wallet)) return { ok: false, reason: 'already seated' };
    this.seats.push({ wallet: req.wallet, finalityTs: req.finalityTs });
    this.seats.sort((a, b) => a.finalityTs - b.finalityTs || a.wallet.localeCompare(b.wallet));
    return { ok: true, seatIndex: this.seats.findIndex((s) => s.wallet === req.wallet) };
  }

  canStart(): boolean {
    return this.seats.length >= this.minPlayers;
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
  constructor(roomId: string, host: string, minPlayers: number, maxPlayers: number) {
    this.roomId = roomId;
    this.host = host;
    this.table = new Table(minPlayers, maxPlayers);
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
