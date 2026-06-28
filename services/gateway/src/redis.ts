import { createConnection, type Socket } from 'node:net';

type RedisValue = string | number | null | string[];

export class RedisClient {
  private readonly url: URL;

  constructor(redisUrl: string) {
    this.url = new URL(redisUrl);
  }

  async get(key: string): Promise<string | null> {
    return this.command(['GET', key]);
  }

  async setex(key: string, ttlSec: number, value: string): Promise<void> {
    await this.command(['SETEX', key, String(ttlSec), value]);
  }

  async del(key: string): Promise<void> {
    await this.command(['DEL', key]);
  }

  async incr(key: string): Promise<number> {
    const value = await this.command(['INCR', key]);
    if (typeof value !== 'number') throw new Error(`unexpected Redis INCR reply for ${key}`);
    return value;
  }

  async expire(key: string, ttlSec: number): Promise<void> {
    await this.command(['EXPIRE', key, String(ttlSec)]);
  }

  async setnx(key: string, value: string, ttlSec?: number): Promise<boolean> {
    const reply = await this.command(['SET', key, value, 'NX', ...(ttlSec ? ['EX', String(ttlSec)] : [])]);
    return reply === 'OK';
  }

  async zadd(key: string, score: number, member: string): Promise<void> {
    await this.command(['ZADD', key, String(score), member]);
  }

  async zrem(key: string, member: string): Promise<void> {
    await this.command(['ZREM', key, member]);
  }

  async zrangebyscore(key: string, min: number, max: number): Promise<string[]> {
    const reply = await this.command(['ZRANGEBYSCORE', key, String(min), String(max)]);
    if (Array.isArray(reply)) return reply;
    if (typeof reply === 'string') return [reply];
    return [];
  }

  private async command(args: string[]): Promise<RedisValue> {
    const socket = await this.connect();
    try {
      socket.write(encodeCommand(args));
      const chunks: Buffer[] = [];
      return await new Promise<RedisValue>((resolve, reject) => {
        socket.on('data', (chunk) => {
          chunks.push(chunk);
          try {
            resolve(parseReply(Buffer.concat(chunks)));
            socket.end();
          } catch (err) {
            if (!(err instanceof IncompleteReply)) reject(err);
          }
        });
        socket.on('error', reject);
        socket.on('end', () => reject(new Error('Redis connection closed before reply')));
      });
    } finally {
      socket.destroy();
    }
  }

  private connect(): Promise<Socket> {
    const port = Number.parseInt(this.url.port || '6379', 10);
    const host = this.url.hostname || '127.0.0.1';
    const password = decodeURIComponent(this.url.password);
    return new Promise((resolve, reject) => {
      const socket = createConnection({ host, port }, async () => {
        try {
          if (password) await writeAuth(socket, password);
          resolve(socket);
        } catch (err) {
          reject(err);
        }
      });
      socket.once('error', reject);
    });
  }
}

function writeAuth(socket: Socket, password: string): Promise<void> {
  socket.write(encodeCommand(['AUTH', password]));
  const chunks: Buffer[] = [];
  return new Promise((resolve, reject) => {
    const onData = (chunk: Buffer) => {
      chunks.push(chunk);
      try {
        parseReply(Buffer.concat(chunks));
        socket.off('data', onData);
        resolve();
      } catch (err) {
        if (!(err instanceof IncompleteReply)) reject(err);
      }
    };
    socket.on('data', onData);
    socket.once('error', reject);
  });
}

function encodeCommand(args: string[]): string {
  return `*${args.length}\r\n${args.map((arg) => `$${Buffer.byteLength(arg)}\r\n${arg}\r\n`).join('')}`;
}

class IncompleteReply extends Error {}

function parseReply(buf: Buffer): RedisValue {
  if (buf.length < 1) throw new IncompleteReply();
  const type = String.fromCharCode(buf[0]);
  const crlf = buf.indexOf('\r\n');
  if (crlf === -1) throw new IncompleteReply();
  const head = buf.subarray(1, crlf).toString('utf8');
  if (type === '+') return head;
  if (type === ':') return Number.parseInt(head, 10);
  if (type === '-') throw new Error(`Redis error: ${head}`);
  if (type === '$') {
    const len = Number.parseInt(head, 10);
    if (len === -1) return null;
    const start = crlf + 2;
    const end = start + len;
    if (buf.length < end + 2) throw new IncompleteReply();
    return buf.subarray(start, end).toString('utf8');
  }
  if (type === '*') {
    const count = Number.parseInt(head, 10);
    if (count === -1) return null;
    const items: string[] = [];
    let offset = crlf + 2;
    for (let i = 0; i < count; i++) {
      const elem = parseReply(buf.subarray(offset));
      if (typeof elem === 'string') items.push(elem);
      offset = advanceReply(buf, offset);
    }
    return items;
  }
  throw new Error(`unsupported Redis reply: ${type}`);
}

function advanceReply(buf: Buffer, offset: number): number {
  const type = String.fromCharCode(buf[offset]);
  const crlf = buf.indexOf('\r\n', offset);
  if (type === '$') {
    const len = Number.parseInt(buf.subarray(offset + 1, crlf).toString('utf8'), 10);
    return crlf + 2 + len + 2;
  }
  return crlf + 2;
}
