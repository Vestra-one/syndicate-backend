import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { connect, type Socket } from 'node:net';
import { promisify } from 'node:util';
import {
  applyProfileEvent,
  applySequencedEvent,
  projectEvent,
  replayBundle,
  type MatchHistory,
  type ProfileEvent,
  type ProjectionCheckpoint,
  type ProjectionState,
  type PublicEvent,
  type ReplayBundle,
  type SequencedRawEvent,
} from './index.ts';
import { adaptEngineOutboxPayload } from './engine-outbox.ts';
import type { ObjectStore } from './object-store.ts';
import type { ActionFeedReadServer } from './server.ts';

const execFileAsync = promisify(execFile);
const PSQL_FIELD_SEP = '\u001f';

export type ProjectionMessage = (
  | { type: 'match-event'; event: SequencedRawEvent }
  | { type: 'profile-event'; event: ProfileEvent }
) & { outboxId?: string };

export interface ProjectionSource {
  poll(limit: number): Promise<ProjectionMessage[]>;
  ack(messages: ProjectionMessage[]): Promise<void>;
  fail(messages: ProjectionMessage[], error: unknown): Promise<void>;
}

export interface PublicEventPublisher {
  publish(event: PublicEvent): Promise<void>;
}

export interface ProjectionSink {
  persistReplay(history: MatchHistory, bundle: ReplayBundle, objectUri: string): Promise<void>;
  persistCheckpoint(checkpoint: ProjectionCheckpoint): Promise<void>;
}

export interface ProjectionWorkerOptions {
  state: ProjectionState;
  source: ProjectionSource;
  objectStore: ObjectStore;
  server?: ActionFeedReadServer;
  publisher?: PublicEventPublisher;
  sink?: ProjectionSink;
  batchSize?: number;
}

export class ProjectionWorker {
  private state: ProjectionState;
  private source: ProjectionSource;
  private objectStore: ObjectStore;
  private server?: ActionFeedReadServer;
  private publisher?: PublicEventPublisher;
  private sink?: ProjectionSink;
  private batchSize: number;

  constructor(opts: ProjectionWorkerOptions) {
    this.state = opts.state;
    this.source = opts.source;
    this.objectStore = opts.objectStore;
    this.server = opts.server;
    this.publisher = opts.publisher;
    this.sink = opts.sink;
    this.batchSize = opts.batchSize ?? 100;
  }

  async runOnce(): Promise<number> {
    const messages = await this.source.poll(this.batchSize);
    for (const message of messages) {
      try {
        if (message.type === 'profile-event') {
          applyProfileEvent(this.state, message.event);
          await this.source.ack([message]);
          continue;
        }
        if (message.type !== 'match-event' || !message.event?.raw) {
          await this.source.ack([message]);
          continue;
        }

        const projected = projectEvent(message.event.raw, message.event.timelockOpen);
        const existingEvents = this.state.replayEvents.get(message.event.raw.matchId) ?? [];
        const nextEvents = projected ? [...existingEvents, projected] : existingEvents;
        if (projected) await this.publisher?.publish(projected);
        let replayBundleUri: string | undefined;
        if (message.event.raw.kind === 'settlement' && !message.event.raw.voided) {
          const bundle = replayBundle(message.event.raw.matchId, nextEvents);
          const object = await this.objectStore.putJson(`replays/${bundle.matchId}/${bundle.contentHash}.json`, bundle);
          replayBundleUri = object.uri;
        }

        applySequencedEvent(this.state, message.event);
        if (projected) this.server?.broadcastPublicEvent(projected);
        if (replayBundleUri) {
          const history = this.state.matchHistory.get(message.event.raw.matchId);
          if (history) {
            history.replayBundleUri = replayBundleUri;
            await this.sink?.persistReplay(history, replayBundle(message.event.raw.matchId, nextEvents), replayBundleUri);
          }
        }
        await this.sink?.persistCheckpoint(this.state.checkpoint);
        await this.source.ack([message]);
      } catch (err) {
        await this.source.fail([message], err);
        throw err;
      }
    }
    return messages.length;
  }
}

export class PsqlProjectionSink implements ProjectionSink {
  private databaseUrl: string;
  private projectionName: string;

  constructor(databaseUrl: string, projectionName = 'action_feed') {
    this.databaseUrl = databaseUrl;
    this.projectionName = projectionName;
  }

  async persistReplay(history: MatchHistory, bundle: ReplayBundle, objectUri: string): Promise<void> {
    const eventRoot = sha256Hex(JSON.stringify(bundle.events));
    const summary = {
      ...history.summary,
      buyIn: history.buyIn,
      startedAt: history.startedAt,
      lastEventTs: history.lastEventTs,
      replayEventCount: history.replayEventCount,
    };
    const settlementPrice = history.settlementPrice === undefined ? 'NULL' : String(history.settlementPrice);
    const sql = `
      BEGIN;
      CREATE TEMP TABLE IF NOT EXISTS _syndicate_projection_match (
        match_id uuid PRIMARY KEY
      ) ON COMMIT DELETE ROWS;
      INSERT INTO _syndicate_projection_match (match_id)
      SELECT id
      FROM matches
      WHERE id::text = ${sqlString(history.matchId)}
         OR match_key = ${sqlString(history.matchId)}
         OR onchain_match_id::text = ${sqlString(history.matchId)}
      LIMIT 1;

      INSERT INTO replay_bundles (
        match_id,
        from_seq,
        to_seq,
        event_root,
        object_uri,
        content_sha256
      )
      VALUES (
        (SELECT match_id FROM _syndicate_projection_match),
        ${nonNegativeInt(bundle.fromSeq, 'fromSeq')},
        ${nonNegativeInt(bundle.toSeq, 'toSeq')},
        decode(${sqlString(eventRoot)}, 'hex'),
        ${sqlString(objectUri)},
        decode(${sqlString(eventRoot)}, 'hex')
      )
      ON CONFLICT (match_id, from_seq, to_seq) DO UPDATE
      SET object_uri = EXCLUDED.object_uri,
          content_sha256 = EXCLUDED.content_sha256,
          exported_at = now();

      INSERT INTO match_history (
        match_id,
        status,
        price_feed_symbol,
        scheduled_end_ts,
        oracle_publish_time,
        settlement_price,
        event_root,
        replay_bundle_uri,
        summary
      )
      VALUES (
        (SELECT match_id FROM _syndicate_projection_match),
        ${sqlString(postgresMatchStatus(history.status))}::match_status,
        ${sqlString(history.feed)},
        to_timestamp(${history.startedAt / 1000.0}),
        to_timestamp(${history.lastEventTs / 1000.0}),
        ${settlementPrice},
        decode(${sqlString(eventRoot)}, 'hex'),
        ${sqlString(objectUri)},
        ${sqlString(JSON.stringify(summary))}::jsonb
      )
      ON CONFLICT (match_id) DO UPDATE
      SET status = EXCLUDED.status,
          oracle_publish_time = EXCLUDED.oracle_publish_time,
          settlement_price = EXCLUDED.settlement_price,
          event_root = EXCLUDED.event_root,
          replay_bundle_uri = EXCLUDED.replay_bundle_uri,
          summary = EXCLUDED.summary,
          projected_at = now();
      COMMIT;
    `;
    await execFileAsync('psql', [this.databaseUrl, '-v', 'ON_ERROR_STOP=1', '-At', '-c', sql]);
  }

  async persistCheckpoint(checkpoint: ProjectionCheckpoint): Promise<void> {
    const lastMatchId = checkpoint.lastMatchId && isUuid(checkpoint.lastMatchId) ? `${sqlString(checkpoint.lastMatchId)}::uuid` : 'NULL';
    const lastEventId = checkpoint.lastEventId && isUuid(checkpoint.lastEventId) ? `${sqlString(checkpoint.lastEventId)}::uuid` : 'NULL';
    await execFileAsync('psql', [
      this.databaseUrl,
      '-v',
      'ON_ERROR_STOP=1',
      '-At',
      '-c',
      `
        INSERT INTO read_model_checkpoints (
          projection_name,
          last_match_id,
          last_seq,
          last_event_id,
          updated_at
        )
        VALUES (
          ${sqlString(this.projectionName)},
          ${lastMatchId},
          ${checkpoint.lastSeq},
          ${lastEventId},
          to_timestamp(${checkpoint.updatedAt / 1000.0})
        )
        ON CONFLICT (projection_name) DO UPDATE
        SET last_match_id = EXCLUDED.last_match_id,
            last_seq = GREATEST(read_model_checkpoints.last_seq, EXCLUDED.last_seq),
            last_event_id = EXCLUDED.last_event_id,
            updated_at = EXCLUDED.updated_at
      `,
    ]);
  }
}

export async function hydrateHistoricalGamesFromPsql(state: ProjectionState, databaseUrl: string): Promise<number> {
  const sql = `
    SELECT
      COALESCE(m.onchain_match_id::text, mh.match_id::text),
      mh.status::text,
      mh.price_feed_symbol,
      floor(extract(epoch from mh.scheduled_end_ts) * 1000)::bigint,
      floor(extract(epoch from mh.projected_at) * 1000)::bigint,
      mh.settlement_price,
      mh.replay_bundle_uri,
      mh.summary::text
    FROM match_history mh
    LEFT JOIN matches m ON m.id = mh.match_id
    WHERE mh.status IN ('settled', 'voided')
    ORDER BY mh.projected_at ASC, mh.match_id ASC
  `;
  const { stdout } = await execFileAsync('psql', [databaseUrl, '-At', '-F', PSQL_FIELD_SEP, '-P', 'null=\\N', '-c', sql]);
  let count = 0;
  for (const line of stdout.split('\n').filter(Boolean)) {
    const [matchId, status, feed, startedAt, projectedAt, settlementPrice, replayBundleUri, summaryRaw] = line.split(PSQL_FIELD_SEP);
    const summary = JSON.parse(summaryRaw || '{}') as Partial<MatchHistory['summary']> & {
      buyIn?: number;
      startedAt?: number;
      lastEventTs?: number;
      replayEventCount?: number;
    };
    const history: MatchHistory = {
      matchId,
      status: status === 'voided' ? 'voided' : 'settled',
      feed,
      buyIn: numberOr(summary.buyIn, 0),
      startedAt: numberOr(summary.startedAt, Number(startedAt)),
      lastEventTs: numberOr(summary.lastEventTs, Number(projectedAt)),
      settlementPrice: settlementPrice === '\\N' ? undefined : Number(settlementPrice),
      replayEventCount: numberOr(summary.replayEventCount, 0),
      replayBundleUri: replayBundleUri === '\\N' ? undefined : replayBundleUri,
      summary: {
        finalPot: numberOr(summary.finalPot, 0),
        awardTotal: numberOr(summary.awardTotal, 0),
        actionCount: numberOr(summary.actionCount, 0),
        revealCount: numberOr(summary.revealCount, 0),
      },
    };
    state.matchHistory.set(matchId, history);
    count += 1;
  }
  return count;
}

export class InMemoryProjectionSource implements ProjectionSource {
  private messages: ProjectionMessage[];
  readonly acked: ProjectionMessage[] = [];
  readonly failed: { message: ProjectionMessage; error: unknown }[] = [];

  constructor(messages: ProjectionMessage[] = []) {
    this.messages = [...messages];
  }

  push(message: ProjectionMessage): void {
    this.messages.push(message);
  }

  async poll(limit: number): Promise<ProjectionMessage[]> {
    return this.messages.splice(0, limit);
  }

  async ack(messages: ProjectionMessage[]): Promise<void> {
    this.acked.push(...messages);
  }

  async fail(messages: ProjectionMessage[], error: unknown): Promise<void> {
    this.failed.push(...messages.map((message) => ({ message, error })));
    this.messages.unshift(...messages);
  }
}

export class NatsTcpPublisher implements PublicEventPublisher {
  private url: URL;
  private subject: string;

  constructor(natsUrl: string, subject = 'syndicate.action_feed.public') {
    this.url = new URL(natsUrl);
    this.subject = subject;
  }

  async publish(event: PublicEvent): Promise<void> {
    const payload = Buffer.from(JSON.stringify(event));
    const socket = await connectTcp(this.url);
    try {
      socket.write('CONNECT {"verbose":false,"pedantic":false}\r\n');
      socket.write(`PUB ${this.subject} ${payload.length}\r\n`);
      socket.write(payload);
      socket.write('\r\n');
    } finally {
      socket.end();
    }
  }
}

export class PsqlOutboxProjectionSource implements ProjectionSource {
  private databaseUrl: string;
  private projectionName: string;
  private visibilityTimeoutMs: number;
  private retryDelayMs: number;
  private maxAttempts: number;

  constructor(
    databaseUrl: string,
    projectionName = 'action_feed',
    visibilityTimeoutMs = 60_000,
    retryDelayMs = 5_000,
    maxAttempts = 10,
  ) {
    this.databaseUrl = databaseUrl;
    this.projectionName = projectionName;
    this.visibilityTimeoutMs = visibilityTimeoutMs;
    this.retryDelayMs = retryDelayMs;
    this.maxAttempts = maxAttempts;
  }

  async poll(limit: number): Promise<ProjectionMessage[]> {
    const safeLimit = positiveInt(limit, 'limit');
    const safeVisibility = positiveInt(this.visibilityTimeoutMs, 'visibilityTimeoutMs');
    const sql = `
      WITH claimed AS (
        SELECT id
        FROM outbox_events
        WHERE status IN ('pending', 'processing') AND available_at <= now()
          AND aggregate_type = 'match'
        ORDER BY created_at, id
        LIMIT ${safeLimit}
        FOR UPDATE SKIP LOCKED
      )
      UPDATE outbox_events o
      SET status = 'processing',
          attempts = attempts + 1,
          available_at = now() + (${safeVisibility}::bigint * interval '1 millisecond')
      FROM claimed
      WHERE o.id = claimed.id
      RETURNING o.id::text, o.payload::text
    `;
    const { stdout } = await execFileAsync('psql', [this.databaseUrl, '-At', '-F', '\t', '-c', sql]);
    return stdout
      .split('\n')
      .filter(Boolean)
      .flatMap((line) => {
        const split = line.indexOf('\t');
        if (split === -1) return [];
        const outboxId = line.slice(0, split);
        const payload = line.slice(split + 1);
        const parsed = JSON.parse(payload) as unknown;
        const message = adaptEngineOutboxPayload(parsed, outboxId);
        if (!message) return [];
        return { ...message, outboxId };
      });
  }

  async ack(messages: ProjectionMessage[]): Promise<void> {
    const ids = messages.flatMap((message) => (message.outboxId && isUuid(message.outboxId) ? [message.outboxId] : []));
    if (ids.length === 0) return;
    const quoted = quoteUuidList(ids);
    await execFileAsync('psql', [
      this.databaseUrl,
      '-At',
      '-c',
      `
        UPDATE outbox_events
        SET status = 'published',
            published_at = now(),
            last_error = NULL
        WHERE id IN (${quoted})
          AND status = 'processing'
      `,
    ]);
  }

  async fail(messages: ProjectionMessage[], error: unknown): Promise<void> {
    const ids = messages.flatMap((message) => (message.outboxId && isUuid(message.outboxId) ? [message.outboxId] : []));
    if (ids.length === 0) return;
    const quoted = quoteUuidList(ids);
    const safeRetryDelay = positiveInt(this.retryDelayMs, 'retryDelayMs');
    const safeMaxAttempts = positiveInt(this.maxAttempts, 'maxAttempts');
    const lastError = sqlString(String(error instanceof Error ? error.message : error).slice(0, 1_000));
    await execFileAsync('psql', [
      this.databaseUrl,
      '-At',
      '-c',
      `
        UPDATE outbox_events
        SET status = CASE WHEN attempts >= ${safeMaxAttempts} THEN 'dead_letter' ELSE 'pending' END,
            available_at = CASE WHEN attempts >= ${safeMaxAttempts}
              THEN available_at
              ELSE now() + (${safeRetryDelay}::bigint * interval '1 millisecond')
            END,
            last_error = ${lastError}
        WHERE id IN (${quoted})
          AND status = 'processing'
      `,
    ]);
  }
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function quoteUuidList(ids: string[]): string {
  return ids.map((id) => `'${id}'`).join(',');
}

function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function postgresMatchStatus(status: MatchHistory['status']): string {
  return status === 'live' ? 'active' : status;
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function nonNegativeInt(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 0) throw new Error(`invalid ${label}: ${value}`);
  return value;
}

function positiveInt(value: number, label: string): number {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`invalid ${label}: ${value}`);
  return value;
}

async function connectTcp(url: URL): Promise<Socket> {
  const port = Number.parseInt(url.port || '4222', 10);
  return await new Promise((resolve, reject) => {
    const socket = connect(port, url.hostname || '127.0.0.1');
    socket.once('connect', () => resolve(socket));
    socket.once('error', reject);
  });
}
