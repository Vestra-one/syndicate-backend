/**
 * @syndicate/action-feed — read-only public projection + live-games dashboard
 * (`04 §20`, `05 §14`, `06 §13`, `08 OQ9/OQ20`).
 *
 * The security-critical job is **redaction**: a raw internal event may carry secrets
 * (sealed ciphertexts, queued/pre-signed intents, wallet PII). `projectEvent` is a
 * strict allow-list — it can only ever emit public fields, and it NEVER emits a
 * prediction before the time-lock opens. Default-deny: unknown shapes are dropped.
 */

export type RawEvent =
  | { kind: 'action'; matchId: string; wallet: string; seat: number; action: string; amount: number; feedPrice: number; pot: number; ts: number }
  | { kind: 'fold'; matchId: string; wallet: string; seat: number; ts: number }
  | { kind: 'round'; matchId: string; round: number; ts: number }
  | { kind: 'seal'; matchId: string; wallet: string; ciphertext: string; ts: number } // SECRET
  | { kind: 'intent'; matchId: string; wallet: string; presigned: string; ts: number } // SECRET
  | { kind: 'settlement'; matchId: string; settlementPrice: number; awards: { seat: number; amount: number }[]; ts: number }
  | { kind: 'reveal'; matchId: string; seat: number; prediction: number; ts: number }; // only after time-lock open

export type PublicEvent =
  | { kind: 'action'; matchId: string; seat: number; action: string; amount: number; feedPrice: number; pot: number; ts: number }
  | { kind: 'fold'; matchId: string; seat: number; ts: number }
  | { kind: 'round'; matchId: string; round: number; ts: number }
  | { kind: 'settlement'; matchId: string; settlementPrice: number; awards: { seat: number; amount: number }[]; ts: number }
  | { kind: 'reveal'; matchId: string; seat: number; prediction: number; ts: number };

/**
 * Project a raw event to a public one, or `null` to drop it. Seats are pseudonymous;
 * wallets are never exposed. Predictions are emitted only when `timelockOpen`.
 */
export function projectEvent(e: RawEvent, timelockOpen: boolean): PublicEvent | null {
  switch (e.kind) {
    case 'action':
      return { kind: 'action', matchId: e.matchId, seat: e.seat, action: e.action, amount: e.amount, feedPrice: e.feedPrice, pot: e.pot, ts: e.ts };
    case 'fold':
      return { kind: 'fold', matchId: e.matchId, seat: e.seat, ts: e.ts };
    case 'round':
      return { kind: 'round', matchId: e.matchId, round: e.round, ts: e.ts };
    case 'settlement':
      return { kind: 'settlement', matchId: e.matchId, settlementPrice: e.settlementPrice, awards: e.awards, ts: e.ts };
    case 'reveal':
      return timelockOpen
        ? { kind: 'reveal', matchId: e.matchId, seat: e.seat, prediction: e.prediction, ts: e.ts }
        : null; // never before the time-lock opens
    case 'seal':
    case 'intent':
      return null; // secrets — never public
    default:
      return null; // default-deny unknown shapes
  }
}

/** Defensive CI guard: a serialized public event must contain no forbidden field. */
export function containsSecret(ev: unknown): boolean {
  return /ciphertext|presigned|wallet/i.test(JSON.stringify(ev ?? {}));
}

// ---- Live-games dashboard ----

export interface LiveGame {
  matchId: string;
  spectators: number;
  actionsPerMin: number;
  potSize: number;
  buyIn: number;
  feed: string;
  startedAt: number;
}

/** "Rated" popularity (08 OQ20): spectators weighted, plus live activity. */
export function popularityScore(g: LiveGame): number {
  return g.spectators * 10 + g.actionsPerMin;
}

export function rankLiveGames(games: LiveGame[]): LiveGame[] {
  return [...games].sort((a, b) => popularityScore(b) - popularityScore(a) || a.matchId.localeCompare(b.matchId));
}

export type SortKey = 'gameTime' | 'potSize' | 'buyIn' | 'feed';

export function sortGames(games: LiveGame[], key: SortKey): LiveGame[] {
  const g = [...games];
  switch (key) {
    case 'gameTime':
      return g.sort((a, b) => a.startedAt - b.startedAt);
    case 'potSize':
      return g.sort((a, b) => b.potSize - a.potSize);
    case 'buyIn':
      return g.sort((a, b) => b.buyIn - a.buyIn);
    case 'feed':
      return g.sort((a, b) => a.feed.localeCompare(b.feed));
  }
}
