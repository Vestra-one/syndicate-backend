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
  | { kind: 'settlement'; matchId: string; settlementPrice: number; awards: { seat: number; amount: number }[]; ts: number; voided?: boolean }
  | { kind: 'reveal'; matchId: string; seat: number; prediction: number; ts: number }; // only after time-lock open

export type PublicEvent =
  | { kind: 'action'; matchId: string; seat: number; action: string; amount: number; feedPrice: number; pot: number; ts: number }
  | { kind: 'fold'; matchId: string; seat: number; ts: number }
  | { kind: 'round'; matchId: string; round: number; ts: number }
  | { kind: 'settlement'; matchId: string; settlementPrice: number; awards: { seat: number; amount: number }[]; ts: number; voided?: boolean }
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
      return {
        kind: 'settlement',
        matchId: e.matchId,
        settlementPrice: e.settlementPrice,
        awards: e.awards,
        ts: e.ts,
        voided: e.voided,
      };
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

// ---- Rebuildable read models ----

export interface ProjectionCheckpoint {
  projectionName: string;
  lastMatchId?: string;
  lastSeq: number;
  lastEventId?: string;
  updatedAt: number;
}

export interface SequencedRawEvent {
  id: string;
  seq: number;
  raw: RawEvent;
  timelockOpen: boolean;
}

export interface MatchHistory {
  matchId: string;
  status: 'live' | 'settled' | 'voided';
  feed: string;
  buyIn: number;
  startedAt: number;
  lastEventTs: number;
  settlementPrice?: number;
  oracleProof?: unknown;
  replayEventCount: number;
  replayBundleUri?: string;
  summary: {
    finalPot: number;
    awardTotal: number;
    actionCount: number;
    revealCount: number;
  };
}

export interface ReplayBundle {
  matchId: string;
  fromSeq: number;
  toSeq: number;
  events: PublicEvent[];
  contentHash: string;
  oracleProof?: unknown;
}

export type HistoryStatusFilter = MatchHistory['status'] | 'all';

export interface HistoricalGamesOptions {
  status?: HistoryStatusFilter;
  limit?: number;
  cursor?: string;
}

export interface ProfileStats {
  userId: string;
  publicHandle: string;
  matchesPlayed: number;
  matchesWon: number;
  totalBuyIn: number;
  totalPayout: number;
  showdownCount: number;
  foldCount: number;
  achievementCount: number;
  updatedAt: number;
}

export interface ProfileEvent {
  userId: string;
  publicHandle: string;
  matchId: string;
  seat: number;
  buyIn: number;
  payout: number;
  folded: boolean;
  showdown: boolean;
  won: boolean;
  achievements?: number;
  ts: number;
}

export interface LeaderboardEntry {
  userId: string;
  handle: string;
  matchesPlayed: number;
  roi: number;
  totalPayout: number;
  achievements: number;
}

export interface ProjectionState {
  checkpoint: ProjectionCheckpoint;
  liveGames: Map<string, LiveGame>;
  matchHistory: Map<string, MatchHistory>;
  replayEvents: Map<string, PublicEvent[]>;
  profileStats: Map<string, ProfileStats>;
}

export function createProjectionState(projectionName = 'action_feed'): ProjectionState {
  return {
    checkpoint: { projectionName, lastSeq: -1, updatedAt: 0 },
    liveGames: new Map(),
    matchHistory: new Map(),
    replayEvents: new Map(),
    profileStats: new Map(),
  };
}

export function applySequencedEvent(state: ProjectionState, event: SequencedRawEvent): ProjectionState {
  if (event.seq <= state.checkpoint.lastSeq) return state;

  const projected = projectEvent(event.raw, event.timelockOpen);
  if (projected) {
    const events = state.replayEvents.get(projected.matchId) ?? [];
    events.push(projected);
    state.replayEvents.set(projected.matchId, events);
    applyPublicEventToModels(state, projected);
  }

  state.checkpoint = {
    projectionName: state.checkpoint.projectionName,
    lastMatchId: event.raw.matchId,
    lastSeq: event.seq,
    lastEventId: event.id,
    updatedAt: event.raw.ts,
  };
  return state;
}

export function applyProfileEvent(state: ProjectionState, event: ProfileEvent): ProjectionState {
  const current = state.profileStats.get(event.userId) ?? {
    userId: event.userId,
    publicHandle: event.publicHandle,
    matchesPlayed: 0,
    matchesWon: 0,
    totalBuyIn: 0,
    totalPayout: 0,
    showdownCount: 0,
    foldCount: 0,
    achievementCount: 0,
    updatedAt: event.ts,
  };
  current.publicHandle = event.publicHandle;
  current.matchesPlayed += 1;
  current.matchesWon += event.won ? 1 : 0;
  current.totalBuyIn += event.buyIn;
  current.totalPayout += event.payout;
  current.showdownCount += event.showdown ? 1 : 0;
  current.foldCount += event.folded ? 1 : 0;
  current.achievementCount += event.achievements ?? 0;
  current.updatedAt = event.ts;
  state.profileStats.set(event.userId, current);
  return state;
}

export function leaderboard(stats: Iterable<ProfileStats>): LeaderboardEntry[] {
  return [...stats].map((s) => ({
    userId: s.userId,
    handle: s.publicHandle,
    matchesPlayed: s.matchesPlayed,
    roi: s.totalBuyIn === 0 ? 0 : (s.totalPayout - s.totalBuyIn) / s.totalBuyIn,
    totalPayout: s.totalPayout,
    achievements: s.achievementCount,
  })).sort((a, b) => b.roi - a.roi || b.totalPayout - a.totalPayout || a.handle.localeCompare(b.handle));
}

export function replayBundle(matchId: string, events: PublicEvent[]): ReplayBundle {
  const sorted = matchActionHistory(events);
  return {
    matchId,
    fromSeq: 0,
    toSeq: Math.max(0, sorted.length - 1),
    events: sorted,
    contentHash: stableHash(JSON.stringify(sorted)),
  };
}

export function listHistoricalGames(histories: Iterable<MatchHistory>, opts: HistoricalGamesOptions = {}): MatchHistory[] {
  const sorted = [...histories]
    .filter((h) => {
      if (opts.status === 'all') return true;
      if (opts.status) return h.status === opts.status;
      return h.status !== 'live';
    })
    .sort((a, b) => b.lastEventTs - a.lastEventTs || a.matchId.localeCompare(b.matchId));
  const start = opts.cursor ? sorted.findIndex((h) => historyCursor(h) === opts.cursor) + 1 : 0;
  const limit = Math.max(1, opts.limit ?? sorted.length);
  return sorted.slice(Math.max(0, start), Math.max(0, start) + limit);
}

export function historyCursor(history: MatchHistory): string {
  return `${history.lastEventTs}:${encodeURIComponent(history.matchId)}`;
}

export function matchActionHistory(events: PublicEvent[]): PublicEvent[] {
  return [...events].sort((a, b) => a.ts - b.ts || eventKindOrder(a.kind) - eventKindOrder(b.kind));
}

function eventKindOrder(kind: PublicEvent['kind']): number {
  switch (kind) {
    case 'round':
      return 0;
    case 'action':
      return 1;
    case 'fold':
      return 2;
    case 'settlement':
      return 3;
    case 'reveal':
      return 4;
  }
}

function applyPublicEventToModels(state: ProjectionState, event: PublicEvent): void {
  const existingHistory = state.matchHistory.get(event.matchId);
  const history: MatchHistory = existingHistory ?? {
    matchId: event.matchId,
    status: 'live',
    feed: 'unknown',
    buyIn: 0,
    startedAt: event.ts,
    lastEventTs: event.ts,
    replayEventCount: 0,
    summary: { finalPot: 0, awardTotal: 0, actionCount: 0, revealCount: 0 },
  };
  history.lastEventTs = Math.max(history.lastEventTs, event.ts);
  history.replayEventCount += 1;

  if (event.kind === 'action') {
    history.summary.finalPot = event.pot;
    history.summary.actionCount += 1;
    const live = state.liveGames.get(event.matchId) ?? {
      matchId: event.matchId,
      spectators: 0,
      actionsPerMin: 0,
      potSize: 0,
      buyIn: history.buyIn,
      feed: history.feed,
      startedAt: history.startedAt,
    };
    live.potSize = event.pot;
    live.actionsPerMin += 1;
    state.liveGames.set(event.matchId, live);
  }
  if (event.kind === 'settlement') {
    history.status = event.voided ? 'voided' : 'settled';
    history.settlementPrice = event.settlementPrice;
    history.summary.awardTotal = event.awards.reduce((n, a) => n + a.amount, 0);
    state.liveGames.delete(event.matchId);
  }
  if (event.kind === 'reveal') history.summary.revealCount += 1;
  state.matchHistory.set(event.matchId, history);
}

function stableHash(value: string): string {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}
