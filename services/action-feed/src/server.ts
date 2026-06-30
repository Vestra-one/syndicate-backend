import { createHash, randomUUID } from 'node:crypto';
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import {
  type HistoryStatusFilter,
  type LeaderboardEntry,
  type MatchHistory,
  type ProfileStats,
  type ProjectionState,
  type PublicEvent,
  type ReplayBundle,
  createProjectionState,
  historyCursor,
  leaderboard,
  listHistoricalGames,
  matchActionHistory,
  rankLiveGames,
  replayBundle,
} from './index.ts';
import { MemoryObjectStore, type ObjectStore } from './object-store.ts';
import { getProfileMetadata, toPublicProfile, upsertProfileMetadata } from './profiles.ts';
import {
  applyLobbyUpdate,
  listForming,
  type FormingGame,
  type FormingGamesState,
  type RoomsChannelPayload,
} from './lobby.ts';

export interface ActionFeedReadServerOptions {
  port?: number;
  host?: string;
  state?: ProjectionState;
  objectStore?: ObjectStore;
  /** Optional clock injection for deadline filtering of forming games (tests). */
  now?: () => number;
}

export class ActionFeedReadServer {
  readonly state: ProjectionState;
  readonly objectStore: ObjectStore;
  readonly ready: Promise<void>;
  /** Pre-LIVE (FILLING) matches, fed by the ROOMS_CHANNEL bridge (lobby.ts). */
  readonly formingGames: FormingGamesState = new Map();

  private now: () => number;
  private server = createHttpServer((req, res) => void this.route(req, res));
  private wsClients = new Map<Socket, { matchId?: string }>();
  private metrics = {
    httpRequestsTotal: 0,
    wsBroadcastsTotal: 0,
    replayUploadsTotal: 0,
    lobbyBroadcastsTotal: 0,
  };

  constructor(opts: ActionFeedReadServerOptions = {}) {
    this.state = opts.state ?? createProjectionState('action_feed_api');
    this.objectStore = opts.objectStore ?? new MemoryObjectStore();
    this.now = opts.now ?? (() => Date.now());
    this.server.on('upgrade', (req, socket) => this.upgrade(req, socket));
    this.ready = new Promise((resolve, reject) => {
      const onError = (err: Error) => reject(err);
      this.server.once('error', onError);
      this.server.listen(opts.port ?? 0, opts.host ?? '127.0.0.1', () => {
        this.server.off('error', onError);
        resolve();
      });
    });
  }

  get port(): number {
    const address = this.server.address();
    return typeof address === 'object' && address ? address.port : 0;
  }

  async close(): Promise<void> {
    for (const socket of this.wsClients.keys()) socket.destroy();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  broadcastPublicEvent(event: PublicEvent): void {
    const frame = websocketTextFrame(JSON.stringify({ type: 'event', event }));
    this.metrics.wsBroadcastsTotal += 1;
    for (const [socket, sub] of this.wsClients) {
      if (!sub.matchId || sub.matchId === event.matchId) socket.write(frame);
    }
  }

  /**
   * Resolve a wallet to its public handle for lobby display. In-memory only (profile metadata
   * map + projection stats), with a truncated-wallet fallback mirroring `toPublicProfile`. MUST
   * stay a cheap lookup — it runs per seat on every lobby mutation.
   */
  private resolveHandle(wallet: string): string {
    const meta = getProfileMetadata(wallet);
    if (meta?.handle) return meta.handle;
    const stats = this.state.profileStats.get(wallet);
    if (stats?.publicHandle) return stats.publicHandle;
    return wallet.slice(0, 8);
  }

  /**
   * Apply a ROOMS_CHANNEL lobby mutation and broadcast it to observers. Called by the Redis
   * bridge (main.ts). The lobby roster intentionally carries wallet + handle (see lobby.ts) and
   * is broadcast as `{ type: 'lobby' }`, distinct from redacted `{ type: 'event' }` gameplay.
   */
  applyRoomsPayload(payload: RoomsChannelPayload): void {
    const result = applyLobbyUpdate(this.formingGames, payload, (w) => this.resolveHandle(w));
    if (!result) return; // stale / malformed
    this.broadcastLobby(result.game, result.evicted);
  }

  private broadcastLobby(game: FormingGame, evicted: boolean): void {
    const frame = websocketTextFrame(JSON.stringify({ type: 'lobby', phase: evicted ? 'STARTED' : 'FILLING', game }));
    this.metrics.lobbyBroadcastsTotal += 1;
    for (const [socket, sub] of this.wsClients) {
      if (!sub.matchId || sub.matchId === game.matchId) socket.write(frame);
    }
  }

  private async route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    this.metrics.httpRequestsTotal += 1;
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname === '/healthz') return json(res, 200, { ok: true });
    if (url.pathname === '/metrics') return text(res, 200, this.metricsText());

    if (req.method === 'PUT' && url.pathname === '/profiles/me') {
      const body = await readJsonBody(req);
      const wallet = String(body.wallet ?? '');
      if (!wallet) return json(res, 400, { error: 'wallet required' });
      const meta = upsertProfileMetadata(wallet, {
        handle: body.handle === undefined ? undefined : String(body.handle),
        avatarUri: body.avatarUri === undefined ? undefined : String(body.avatarUri),
      });
      const stats = this.state.profileStats.get(wallet);
      return json(res, 200, { profile: toPublicProfile(wallet, stats, meta) });
    }

    if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' });
    if (url.pathname === '/metrics') return text(res, 200, this.metricsText());
    if (url.pathname === '/active-games') return json(res, 200, { games: rankLiveGames([...this.state.liveGames.values()]) });
    if (url.pathname === '/upcoming-games') return json(res, 200, { games: listForming(this.formingGames, this.now()) });
    if (url.pathname === '/matches/history') {
      const status = parseHistoryStatus(url.searchParams.get('status'));
      if (status === null) return json(res, 400, { error: 'invalid status filter' });
      const limit = parseLimit(url.searchParams.get('limit'));
      const page = listHistoricalGames(this.state.matchHistory.values(), {
        status,
        limit: limit + 1,
        cursor: url.searchParams.get('cursor') ?? undefined,
      });
      const matches = page.slice(0, limit);
      const nextCursor = page.length > limit && matches.length > 0 ? historyCursor(matches[matches.length - 1]) : undefined;
      return json(res, 200, { matches, nextCursor });
    }
    if (url.pathname === '/leaderboard') {
      const entries: LeaderboardEntry[] = leaderboard(this.state.profileStats.values());
      return json(res, 200, { entries });
    }

    const historyMatch = url.pathname.match(/^\/matches\/([^/]+)\/history$/);
    if (historyMatch) {
      const history: MatchHistory | undefined = this.state.matchHistory.get(decodeURIComponent(historyMatch[1]));
      return history
        ? json(res, 200, { match: history, oracleProof: history.oracleProof ?? null })
        : json(res, 404, { error: 'match not found' });
    }

    const actionsMatch = url.pathname.match(/^\/matches\/([^/]+)\/actions$/);
    if (actionsMatch) {
      const matchId = decodeURIComponent(actionsMatch[1]);
      const events = await this.replayEventsForMatch(matchId);
      return events ? json(res, 200, { matchId, events: matchActionHistory(events) }) : json(res, 404, { error: 'match actions not found' });
    }

    const replayMatch = url.pathname.match(/^\/matches\/([^/]+)\/replay$/);
    if (replayMatch) {
      const matchId = decodeURIComponent(replayMatch[1]);
      const events = await this.replayEventsForMatch(matchId);
      if (!events) return json(res, 404, { error: 'replay not found' });
      const bundle = replayBundle(matchId, events);
      const object = await this.objectStore.putJson(`replays/${matchId}/${bundle.contentHash}.json`, bundle);
      this.metrics.replayUploadsTotal += 1;
      return json(res, 200, { bundle: { ...bundle, objectUri: object.uri }, oracleProof: bundle.oracleProof ?? null });
    }

    const profileMatch = url.pathname.match(/^\/profiles\/([^/]+)$/);
    if (profileMatch) {
      const wallet = decodeURIComponent(profileMatch[1]);
      const stats: ProfileStats | undefined = this.state.profileStats.get(wallet);
      const meta = getProfileMetadata(wallet);
      if (!stats && !meta) return json(res, 404, { error: 'profile not found' });
      return json(res, 200, { profile: toPublicProfile(wallet, stats, meta) });
    }

    return json(res, 404, { error: 'not found' });
  }

  private metricsText(): string {
    return [
      `syndicate_action_feed_http_requests_total ${this.metrics.httpRequestsTotal}`,
      `syndicate_action_feed_ws_clients ${this.wsClients.size}`,
      `syndicate_action_feed_ws_broadcasts_total ${this.metrics.wsBroadcastsTotal}`,
      `syndicate_action_feed_lobby_broadcasts_total ${this.metrics.lobbyBroadcastsTotal}`,
      `syndicate_action_feed_replay_uploads_total ${this.metrics.replayUploadsTotal}`,
      `syndicate_action_feed_live_games ${this.state.liveGames.size}`,
      `syndicate_action_feed_forming_games ${this.formingGames.size}`,
      '',
    ].join('\n');
  }

  private async replayEventsForMatch(matchId: string): Promise<PublicEvent[] | undefined> {
    const existing = this.state.replayEvents.get(matchId);
    if (existing) return existing;
    const history = this.state.matchHistory.get(matchId);
    if (!history?.replayBundleUri) return undefined;
    try {
      const bundle = await this.objectStore.getJsonByUri<ReplayBundle & { objectUri?: string }>(history.replayBundleUri);
      const events = matchActionHistory(bundle.events ?? []);
      this.state.replayEvents.set(matchId, events);
      return events;
    } catch {
      return undefined;
    }
  }

  private upgrade(req: IncomingMessage, socket: Socket): void {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname !== '/ws') {
      socket.destroy();
      return;
    }
    const key = req.headers['sec-websocket-key'];
    if (typeof key !== 'string') {
      socket.destroy();
      return;
    }
    const accept = createHash('sha1')
      .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest('base64');
    socket.write([
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${accept}`,
      '',
      '',
    ].join('\r\n'));
    this.wsClients.set(socket, { matchId: url.searchParams.get('matchId') ?? undefined });
    socket.on('close', () => this.wsClients.delete(socket));
    socket.on('error', () => this.wsClients.delete(socket));
  }
}

function parseHistoryStatus(value: string | null): HistoryStatusFilter | undefined | null {
  if (!value) return undefined;
  if (value === 'live' || value === 'settled' || value === 'voided' || value === 'all') return value;
  return null;
}

function parseLimit(value: string | null): number {
  if (!value) return 50;
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return 50;
  return Math.min(100, Math.max(1, n));
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Record<string, unknown>;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  });
  res.end(payload);
}

function text(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, {
    'content-type': 'text/plain; version=0.0.4',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

function websocketTextFrame(text: string): Buffer {
  const payload = Buffer.from(text);
  if (payload.length < 126) return Buffer.concat([Buffer.from([0x81, payload.length]), payload]);
  if (payload.length <= 0xffff) {
    const head = Buffer.alloc(4);
    head[0] = 0x81;
    head[1] = 126;
    head.writeUInt16BE(payload.length, 2);
    return Buffer.concat([head, payload]);
  }
  const head = Buffer.alloc(10);
  head[0] = 0x81;
  head[1] = 127;
  head.writeBigUInt64BE(BigInt(payload.length), 2);
  return Buffer.concat([head, payload]);
}

export function makeWebSocketKey(): string {
  return Buffer.from(randomUUID()).toString('base64').slice(0, 24);
}
