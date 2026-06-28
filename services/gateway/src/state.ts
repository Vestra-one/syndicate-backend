import { RedisClient } from './redis.ts';
import type { Session } from './index.ts';

export interface ChallengeStore {
  put(nonce: string, expiresAt: number): Promise<void>;
  take(nonce: string): Promise<number | undefined>;
}

export interface SessionStore {
  put(session: Session): Promise<void>;
  get(wallet: string): Promise<Session | undefined>;
}

export interface RateLimiter {
  allow(key: string, now: number): Promise<boolean>;
}

export class MemoryChallengeStore implements ChallengeStore {
  private values = new Map<string, number>();

  async put(nonce: string, expiresAt: number): Promise<void> {
    this.values.set(nonce, expiresAt);
  }

  async take(nonce: string): Promise<number | undefined> {
    const exp = this.values.get(nonce);
    this.values.delete(nonce);
    return exp;
  }
}

export class MemorySessionStore implements SessionStore {
  private values = new Map<string, Session>();

  async put(session: Session): Promise<void> {
    this.values.set(session.wallet, session);
  }

  async get(wallet: string): Promise<Session | undefined> {
    return this.values.get(wallet);
  }
}

export class MemoryRateLimiter implements RateLimiter {
  private buckets = new Map<string, { resetAt: number; count: number }>();
  private limit: number;
  private windowMs: number;

  constructor(limit: number, windowMs: number) {
    this.limit = limit;
    this.windowMs = windowMs;
  }

  async allow(key: string, now: number): Promise<boolean> {
    const current = this.buckets.get(key);
    if (!current || current.resetAt <= now) {
      this.buckets.set(key, { resetAt: now + this.windowMs, count: 1 });
      return true;
    }
    current.count += 1;
    return current.count <= this.limit;
  }
}

export class RedisChallengeStore implements ChallengeStore {
  private redis: RedisClient;
  private prefix: string;

  constructor(redis: RedisClient, prefix = 'syndicate:gateway:challenge') {
    this.redis = redis;
    this.prefix = prefix;
  }

  async put(nonce: string, expiresAt: number): Promise<void> {
    const ttlSec = Math.max(1, Math.ceil((expiresAt - Date.now()) / 1000));
    await this.redis.setex(`${this.prefix}:${nonce}`, ttlSec, String(expiresAt));
  }

  async take(nonce: string): Promise<number | undefined> {
    const key = `${this.prefix}:${nonce}`;
    const raw = await this.redis.get(key);
    await this.redis.del(key);
    return raw === null ? undefined : Number.parseInt(raw, 10);
  }
}

export class RedisSessionStore implements SessionStore {
  private redis: RedisClient;
  private prefix: string;

  constructor(redis: RedisClient, prefix = 'syndicate:gateway:session') {
    this.redis = redis;
    this.prefix = prefix;
  }

  async put(session: Session): Promise<void> {
    const ttlSec = Math.max(1, Math.ceil((session.expiresAt - Date.now()) / 1000));
    await this.redis.setex(`${this.prefix}:${session.wallet}`, ttlSec, JSON.stringify(session));
  }

  async get(wallet: string): Promise<Session | undefined> {
    const raw = await this.redis.get(`${this.prefix}:${wallet}`);
    return raw === null ? undefined : (JSON.parse(raw) as Session);
  }
}

export class RedisRateLimiter implements RateLimiter {
  private redis: RedisClient;
  private limit: number;
  private windowSec: number;
  private prefix: string;

  constructor(
    redis: RedisClient,
    limit: number,
    windowSec: number,
    prefix = 'syndicate:gateway:rate',
  ) {
    this.redis = redis;
    this.limit = limit;
    this.windowSec = windowSec;
    this.prefix = prefix;
  }

  async allow(key: string): Promise<boolean> {
    const redisKey = `${this.prefix}:${key}`;
    const count = await this.redis.incr(redisKey);
    if (count === 1) await this.redis.expire(redisKey, this.windowSec);
    return count <= this.limit;
  }
}
