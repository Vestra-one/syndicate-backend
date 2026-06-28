/**
 * Redis pub/sub fan-in for match-engine → gateway relay.
 * Channel: `match:{matchId}` — JSON payloads from match-engine.
 */

import { createConnection, type Socket } from 'node:net';

export type MatchChannelHandler = (matchId: string, payload: unknown) => void;

export class MatchSubscriber {
  private socket?: Socket;
  private buffer = Buffer.alloc(0);
  private readonly handlers = new Set<MatchChannelHandler>();
  private subscribed = new Set<string>();
  private readonly url: URL;

  constructor(redisUrl: string) {
    this.url = new URL(redisUrl);
  }

  onMessage(handler: MatchChannelHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  async ensureSubscribed(matchId: string): Promise<void> {
    const channel = `match:${matchId}`;
    if (this.subscribed.has(channel)) return;
    await this.connect();
    this.subscribed.add(channel);
    this.write(['SUBSCRIBE', channel]);
  }

  close(): void {
    this.socket?.destroy();
    this.reset();
  }

  private async connect(): Promise<void> {
    if (this.socket && !this.socket.destroyed) return;
    const port = Number.parseInt(this.url.port || '6379', 10);
    const host = this.url.hostname || '127.0.0.1';
    const password = decodeURIComponent(this.url.password);
    this.socket = await new Promise((resolve, reject) => {
      const socket = createConnection({ host, port }, () => resolve(socket));
      socket.once('error', reject);
    });
    this.buffer = Buffer.alloc(0);
    this.socket.on('data', (chunk) => this.onData(chunk));
    this.socket.on('error', () => this.reset());
    this.socket.on('close', () => this.reset());
    if (password) {
      this.write(['AUTH', password]);
      await this.readReply();
    }
  }

  private reset(): void {
    this.socket = undefined;
    this.subscribed.clear();
  }

  private write(args: string[]): void {
    const frame = `*${args.length}\r\n${args.map((a) => `$${Buffer.byteLength(a)}\r\n${a}\r\n`).join('')}`;
    this.socket?.write(frame);
  }

  private onData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (true) {
      try {
        const { value, offset } = parseReplyAt(this.buffer, 0);
        this.buffer = this.buffer.subarray(offset);
        if (Array.isArray(value) && value.length >= 3 && value[0] === 'message') {
          const channel = String(value[1]);
          const body = String(value[2]);
          const matchId = channel.startsWith('match:') ? channel.slice('match:'.length) : channel;
          try {
            const payload = JSON.parse(body) as unknown;
            for (const h of this.handlers) h(matchId, payload);
          } catch {
            // ignore malformed payloads
          }
        }
      } catch (err) {
        if (err instanceof IncompleteReply) break;
        throw err;
      }
    }
  }

  private readReply(): Promise<RedisValue> {
    return new Promise((resolve, reject) => {
      const tryParse = () => {
        try {
          const { value, offset } = parseReplyAt(this.buffer, 0);
          this.buffer = this.buffer.subarray(offset);
          resolve(value);
        } catch (err) {
          if (err instanceof IncompleteReply) {
            this.socket?.once('data', tryParse);
            return;
          }
          reject(err);
        }
      };
      tryParse();
    });
  }
}

type RedisValue = string | number | null | RedisValue[];

class IncompleteReply extends Error {}

function parseReplyAt(buf: Buffer, start: number): { value: RedisValue; offset: number } {
  if (buf.length <= start) throw new IncompleteReply();
  const type = String.fromCharCode(buf[start]);
  const crlf = buf.indexOf('\r\n', start);
  if (crlf === -1) throw new IncompleteReply();
  const head = buf.subarray(start + 1, crlf).toString('utf8');
  if (type === '+') return { value: head, offset: crlf + 2 };
  if (type === ':') return { value: Number.parseInt(head, 10), offset: crlf + 2 };
  if (type === '-') throw new Error(`Redis error: ${head}`);
  if (type === '$') {
    const len = Number.parseInt(head, 10);
    if (len === -1) return { value: null, offset: crlf + 2 };
    const bodyStart = crlf + 2;
    const bodyEnd = bodyStart + len;
    if (buf.length < bodyEnd + 2) throw new IncompleteReply();
    return { value: buf.subarray(bodyStart, bodyEnd).toString('utf8'), offset: bodyEnd + 2 };
  }
  if (type === '*') {
    const count = Number.parseInt(head, 10);
    if (count === -1) return { value: null, offset: crlf + 2 };
    const items: RedisValue[] = [];
    let offset = crlf + 2;
    for (let i = 0; i < count; i += 1) {
      const next = parseReplyAt(buf, offset);
      items.push(next.value);
      offset = next.offset;
    }
    return { value: items, offset };
  }
  throw new Error(`unsupported Redis reply: ${type}`);
}
