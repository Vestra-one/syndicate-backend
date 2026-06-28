import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { pathToFileURL } from 'node:url';
import { bindConfig, buildConfigCatalog, getTierForFeed } from './index.ts';

export async function startConfigFromEnv(): Promise<{ close(): Promise<void>; port: number }> {
  const port = parsePort(process.env.CONFIG_PORT ?? process.env.PORT ?? '8085');
  const host = process.env.CONFIG_HOST ?? '127.0.0.1';

  const server = createServer((req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (req.method === 'GET' && url.pathname === '/healthz') return json(res, 200, { ok: true });
      if (req.method === 'GET' && url.pathname === '/metrics') {
        res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4' });
        res.end('syndicate_config_up 1\n');
        return;
      }
      if (req.method === 'GET' && url.pathname === '/config/catalog') {
        return json(res, 200, buildConfigCatalog());
      }
      const tierMatch = url.pathname.match(/^\/config\/tiers\/([^/]+)$/);
      if (req.method === 'GET' && tierMatch) {
        const tierId = decodeURIComponent(tierMatch[1]);
        const feedId = url.searchParams.get('feed') ?? 'BTC/USD';
        const tier = getTierForFeed(tierId, feedId);
        if (!tier) {
          res.writeHead(404);
          res.end();
          return;
        }
        const bound = bindConfig(tier.config);
        return json(res, 200, { tier: { ...tier, config: bound.config, configHash: bound.hash } });
      }
      res.writeHead(404);
      res.end();
    } catch (err) {
      json(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve());
  });
  console.log(`config listening on http://${host}:${port}`);
  return {
    port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function parsePort(raw: string): number {
  const n = Number.parseInt(raw, 10);
  if (!Number.isInteger(n) || n <= 0 || n > 65_535) throw new Error(`invalid port: ${raw}`);
  return n;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const server = await startConfigFromEnv();
  const shutdown = async () => {
    await server.close();
    process.exit(0);
  };
  process.once('SIGINT', () => void shutdown());
  process.once('SIGTERM', () => void shutdown());
}
