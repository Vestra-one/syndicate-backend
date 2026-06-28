import { pathToFileURL } from 'node:url';
import { createProjectionState } from './index.ts';
import { FilesystemObjectStore, MemoryObjectStore } from './object-store.ts';
import { hydrateHistoricalGamesFromPsql, NatsTcpPublisher, ProjectionWorker, PsqlOutboxProjectionSource, PsqlProjectionSink } from './projector.ts';
import { ActionFeedReadServer } from './server.ts';

export async function startActionFeedFromEnv(): Promise<ActionFeedReadServer> {
  const port = parsePort(process.env.ACTION_FEED_PORT ?? process.env.PORT ?? '8080');
  const host = process.env.ACTION_FEED_HOST ?? '127.0.0.1';
  const objectStore = process.env.ACTION_FEED_OBJECT_STORE_DIR
    ? new FilesystemObjectStore(process.env.ACTION_FEED_OBJECT_STORE_DIR)
    : new MemoryObjectStore();
  const state = createProjectionState('action_feed');
  if (process.env.DATABASE_URL) {
    const restored = await hydrateHistoricalGamesFromPsql(state, process.env.DATABASE_URL);
    console.log(`action-feed restored ${restored} historical matches from postgres`);
  }

  const server = new ActionFeedReadServer({ port, host, objectStore, state });
  await server.ready;
  console.log(`action-feed read API listening on http://${host}:${server.port}`);

  if (process.env.DATABASE_URL) {
    const worker = new ProjectionWorker({
      state,
      objectStore,
      server,
      source: new PsqlOutboxProjectionSource(process.env.DATABASE_URL),
      publisher: process.env.NATS_URL ? new NatsTcpPublisher(process.env.NATS_URL) : undefined,
      sink: new PsqlProjectionSink(process.env.DATABASE_URL),
    });
    const intervalMs = parsePositiveInt(process.env.ACTION_FEED_PROJECTOR_INTERVAL_MS ?? '1000');
    const tick = async () => {
      try {
        await worker.runOnce();
      } catch (err) {
        console.error('action-feed projector failed', err);
      }
    };
    setInterval(() => void tick(), intervalMs);
    await tick();
  }

  return server;
}

function parsePort(raw: string): number {
  return parsePositiveInt(raw, 'ACTION_FEED_PORT/PORT');
}

function parsePositiveInt(raw: string, label = 'positive integer'): number {
  const port = Number.parseInt(raw, 10);
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
    throw new Error(`invalid ${label}: ${raw}`);
  }
  return port;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const server = await startActionFeedFromEnv();
  const shutdown = async () => {
    await server.close();
    process.exit(0);
  };
  process.once('SIGINT', () => void shutdown());
  process.once('SIGTERM', () => void shutdown());
}
