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
import { issueNonce, verifyAuth, isGeoAllowed, type SignatureVerifier, type Session } from './index.ts';

export interface GatewayOptions {
  port?: number;
  verifier: SignatureVerifier;
  blocklist?: string[];
  countryOf?: (req: unknown) => string;
  onMessage?: (wallet: string, data: unknown) => void;
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
  private wss: WebSocketServer;
  private conns = new Set<Conn>();
  private opts: GatewayOptions;
  /** Resolves once the server is listening (then `port` is valid). */
  readonly ready: Promise<void>;

  constructor(opts: GatewayOptions) {
    this.opts = opts;
    this.wss = new WebSocketServer({ port: opts.port ?? 0 });
    this.ready = new Promise((resolve) => this.wss.on('listening', () => resolve()));
    this.wss.on('connection', (ws: WebSocket, req: unknown) => this.onConnection(ws, req));
  }

  get port(): number {
    const addr = this.wss.address();
    return typeof addr === 'object' && addr ? addr.port : 0;
  }

  private now(): number {
    return this.opts.now ? this.opts.now() : Date.now();
  }

  private onConnection(ws: WebSocket, req: unknown): void {
    if (this.opts.blocklist && this.opts.countryOf) {
      const cc = this.opts.countryOf(req);
      if (!isGeoAllowed(cc, this.opts.blocklist)) {
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
    ws.send(JSON.stringify({ type: 'challenge', nonce: n.nonce }));
  }

  private onMessage(conn: Conn, data: unknown): void {
    let msg: { type?: string; wallet?: string; signature?: string };
    try {
      msg = JSON.parse(String(data));
    } catch {
      return;
    }

    if (!conn.session) {
      if (msg.type === 'auth' && conn.nonce && msg.wallet && msg.signature) {
        const nonceObj = { wallet: msg.wallet, nonce: conn.nonce, expiresAt: conn.nonceExp ?? 0 };
        const r = verifyAuth(nonceObj, msg.wallet, msg.signature, this.now(), this.opts.verifier);
        if (r.ok) {
          conn.session = r.session;
          conn.wallet = msg.wallet;
          conn.ws.send(JSON.stringify({ type: 'authenticated', wallet: msg.wallet }));
        } else {
          conn.ws.send(JSON.stringify({ type: 'error', reason: r.reason }));
          conn.ws.close();
        }
      }
      return;
    }
    // Authenticated: relay inbound intent to the engine layer.
    this.opts.onMessage?.(conn.wallet!, msg);
  }

  /** Send a message to every authenticated connection. */
  broadcast(msg: unknown): void {
    const data = JSON.stringify(msg);
    for (const c of this.conns) {
      if (c.session && c.ws.readyState === WebSocket.OPEN) c.ws.send(data);
    }
  }

  close(): Promise<void> {
    return new Promise((resolve) => this.wss.close(() => resolve()));
  }
}
