/**
 * Real WebSocket gateway server (`05 §3, §8`, `06 §4, §10`).
 *
 * Handles the per-connection auth handshake (challenge nonce → client signs → verify),
 * tracks authenticated sessions, broadcasts authoritative state, and relays inbound
 * player intents to an injected handler. It is the only process clients talk to; it
 * never decides game outcomes (that's the engine/settlement). Geofencing is enforced at
 * connect. Built on `ws`; tested over loopback.
 */
import { WebSocketServer, WebSocket } from 'ws';
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { IncomingMessage } from 'node:http';
import { issueNonce, verifyAuth, isGeoAllowed, type SignatureVerifier, type Session } from './index.ts';
import {
  MemoryChallengeStore,
  MemorySessionStore,
  type ChallengeStore,
  type RateLimiter,
  type SessionStore,
} from './state.ts';

export interface GatewayOptions {
  port?: number;
  host?: string;
  verifier: SignatureVerifier;
  blocklist?: string[];
  countryOf?: (req: IncomingMessage) => string;
  onMessage?: (wallet: string, data: unknown) => void | Promise<void>;
  challengeStore?: ChallengeStore;
  sessionStore?: SessionStore;
  rateLimiter?: RateLimiter;
  metricsPort?: number;
  metricsHost?: string;
  now?: () => number;
}

interface Conn {
  ws: WebSocket;
  wallet?: string;
  nonce?: string;
  nonceExp?: number;
  session?: Session;
}

export class GatewayServer {
  private http: Server;
  private metricsHttp?: Server;
  private wss: WebSocketServer;
  private conns = new Set<Conn>();
  private opts: GatewayOptions;
  private challengeStore: ChallengeStore;
  private sessionStore: SessionStore;
  private metrics = {
    connectionsTotal: 0,
    authOkTotal: 0,
    authRejectedTotal: 0,
    geoBlockedTotal: 0,
    rateLimitedTotal: 0,
    relayedMessagesTotal: 0,
  };
  /** Resolves once the server is listening (then `port` is valid). */
  readonly ready: Promise<void>;
  readonly metricsReady?: Promise<void>;

  constructor(opts: GatewayOptions) {
    this.opts = opts;
    this.challengeStore = opts.challengeStore ?? new MemoryChallengeStore();
    this.sessionStore = opts.sessionStore ?? new MemorySessionStore();
    this.http = createServer((req, res) => {
      if (req.url === '/healthz') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      if (req.url === '/metrics') {
        res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4' });
        res.end(this.metricsText());
        return;
      }
      res.writeHead(404);
      res.end();
    });
    this.wss = new WebSocketServer({ noServer: true });
    this.http.on('upgrade', (req, socket, head) => {
      this.wss.handleUpgrade(req, socket, head, (ws) => this.wss.emit('connection', ws, req));
    });
    this.ready = new Promise((resolve) => this.http.listen(opts.port ?? 0, opts.host ?? '127.0.0.1', () => resolve()));
    this.wss.on('connection', (ws: WebSocket, req: IncomingMessage) => void this.onConnection(ws, req));
    if (opts.metricsPort) {
      this.metricsHttp = createServer((_req, res) => {
        res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4' });
        res.end(this.metricsText());
      });
      this.metricsReady = new Promise((resolve) =>
        this.metricsHttp!.listen(opts.metricsPort, opts.metricsHost ?? opts.host ?? '127.0.0.1', () => resolve()),
      );
    }
  }

  get port(): number {
    const addr = this.http.address();
    return typeof addr === 'object' && addr ? addr.port : 0;
  }

  private now(): number {
    return this.opts.now ? this.opts.now() : Date.now();
  }

  private async onConnection(ws: WebSocket, req: IncomingMessage): Promise<void> {
    this.metrics.connectionsTotal += 1;
    const remote = req.socket.remoteAddress ?? 'unknown';
    if (this.opts.rateLimiter && !(await this.opts.rateLimiter.allow(remote, this.now()))) {
      this.metrics.rateLimitedTotal += 1;
      ws.send(JSON.stringify({ type: 'error', reason: 'rate-limited' }));
      ws.close();
      return;
    }
    if (this.opts.blocklist && this.opts.countryOf) {
      const cc = this.opts.countryOf(req);
      if (!isGeoAllowed(cc, this.opts.blocklist)) {
        this.metrics.geoBlockedTotal += 1;
        ws.send(JSON.stringify({ type: 'error', reason: 'geo-blocked' }));
        ws.close();
        return;
      }
    }
    const conn: Conn = { ws };
    this.conns.add(conn);
    ws.on('close', () => this.conns.delete(conn));
    ws.on('message', (data: unknown) => this.onMessage(conn, data));

    const n = issueNonce('', this.now(), () => randomUUID());
    conn.nonce = n.nonce;
    conn.nonceExp = n.expiresAt;
    await this.challengeStore.put(n.nonce, n.expiresAt);
    ws.send(JSON.stringify({ type: 'challenge', nonce: n.nonce }));
  }

  private async onMessage(conn: Conn, data: unknown): Promise<void> {
    let msg: { type?: string; wallet?: string; signature?: string };
    try {
      msg = JSON.parse(String(data));
    } catch {
      return;
    }

    if (!conn.session) {
      if (msg.type === 'auth' && conn.nonce && msg.wallet && msg.signature) {
        const expiresAt = await this.challengeStore.take(conn.nonce);
        if (!expiresAt) {
          this.metrics.authRejectedTotal += 1;
          conn.ws.send(JSON.stringify({ type: 'error', reason: 'nonce expired' }));
          conn.ws.close();
          return;
        }
        const nonceObj = { wallet: msg.wallet, nonce: conn.nonce, expiresAt };
        const r = verifyAuth(nonceObj, msg.wallet, msg.signature, this.now(), this.opts.verifier);
        if (r.ok) {
          conn.session = r.session;
          conn.wallet = msg.wallet;
          await this.sessionStore.put(r.session);
          this.metrics.authOkTotal += 1;
          conn.ws.send(JSON.stringify({ type: 'authenticated', wallet: msg.wallet }));
        } else {
          this.metrics.authRejectedTotal += 1;
          conn.ws.send(JSON.stringify({ type: 'error', reason: r.reason }));
          conn.ws.close();
        }
      }
      return;
    }
    // Authenticated: relay inbound intent to the engine layer.
    if (conn.session && !sessionStillValid(conn.session, this.now())) {
      conn.ws.send(JSON.stringify({ type: 'error', reason: 'session expired' }));
      conn.ws.close();
      return;
    }
    this.metrics.relayedMessagesTotal += 1;
    await this.opts.onMessage?.(conn.wallet!, msg);
  }

  /** Send a message to every authenticated connection. */
  broadcast(msg: unknown): void {
    const data = JSON.stringify(msg);
    for (const c of this.conns) {
      if (c.session && c.ws.readyState === WebSocket.OPEN) c.ws.send(data);
    }
  }

  /** Send a message to connections authenticated as `wallet`. */
  sendToWallet(wallet: string, msg: unknown): void {
    const data = JSON.stringify(msg);
    for (const c of this.conns) {
      if (c.wallet === wallet && c.session && c.ws.readyState === WebSocket.OPEN) {
        c.ws.send(data);
      }
    }
  }

  close(): Promise<void> {
    for (const c of this.conns) c.ws.close();
    return new Promise((resolve) => {
      this.wss.close(() => {
        this.http.close(() => {
          if (this.metricsHttp) this.metricsHttp.close(() => resolve());
          else resolve();
        });
      });
    });
  }

  private metricsText(): string {
    const active = [...this.conns].filter((c) => c.ws.readyState === WebSocket.OPEN).length;
    return [
      `syndicate_gateway_connections_total ${this.metrics.connectionsTotal}`,
      `syndicate_gateway_connections_active ${active}`,
      `syndicate_gateway_auth_ok_total ${this.metrics.authOkTotal}`,
      `syndicate_gateway_auth_rejected_total ${this.metrics.authRejectedTotal}`,
      `syndicate_gateway_geo_blocked_total ${this.metrics.geoBlockedTotal}`,
      `syndicate_gateway_rate_limited_total ${this.metrics.rateLimitedTotal}`,
      `syndicate_gateway_relayed_messages_total ${this.metrics.relayedMessagesTotal}`,
      '',
    ].join('\n');
  }
}

function sessionStillValid(s: Session, now: number): boolean {
  return now <= s.expiresAt;
}
