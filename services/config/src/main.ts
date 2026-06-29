import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { pathToFileURL } from 'node:url';
import { buildConfigCatalog, getTierForFeed, buildTemplates, getTemplateByHash } from './index.ts';
import { tableTermsForTier } from './table-terms.ts';

const DEFAULT_TIMELOCK_TARGET_ROUND = 1_000_000;

export function startConfigServer(host = '127.0.0.1', port = 8084): Promise<{ close: () => Promise<void> }> {
  const server = createServer((req, res) => void route(req, res));
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      console.log(`config listening on http://${host}:${port}`);
      resolve({
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}

async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  if (url.pathname === '/healthz') return json(res, 200, { ok: true });
  if (url.pathname === '/config/catalog') return json(res, 200, buildConfigCatalog());
  // Published, hashed game templates: the indexer allowlist (config_hash set) and the
  // client's create-tx params source (plan_v2 §C/§H).
  if (url.pathname === '/config/templates') {
    const templates = buildTemplates();
    return json(res, 200, {
      templates,
      allowlist: templates.map((t) => t.configHash),
    });
  }
  if (url.pathname.startsWith('/config/template/')) {
    const hash = decodeURIComponent(url.pathname.slice('/config/template/'.length));
    const template = getTemplateByHash(hash);
    if (!template) return json(res, 404, { error: 'unknown config_hash' });
    return json(res, 200, { template });
  }
  if (url.pathname === '/config/table') {
    const matchId = url.searchParams.get('matchId') ?? '';
    const tierId = url.searchParams.get('tierId') ?? 'tier-low';
    const feedId = url.searchParams.get('feedId') ?? 'BTC/USD';
    const onchainMatchId = url.searchParams.get('onchainMatchId') ?? undefined;
    const matchPda = url.searchParams.get('matchPda') ?? undefined;
    const terms = tableTermsForTier(matchId || tierId, tierId, feedId, {
      onchainMatchId,
      matchPda,
      timelockTargetRound: parseTimelock(url.searchParams.get('timelockTargetRound')),
    });
    if (!terms) return json(res, 404, { error: 'unknown tier/feed' });
    return json(res, 200, { terms });
  }
  if (url.pathname.startsWith('/config/tier/')) {
    const tierId = decodeURIComponent(url.pathname.slice('/config/tier/'.length));
    const feedId = url.searchParams.get('feedId') ?? 'BTC/USD';
    const tier = getTierForFeed(tierId, feedId);
    if (!tier) return json(res, 404, { error: 'unknown tier' });
    return json(res, 200, { tier });
  }
  return json(res, 404, { error: 'not found' });
}

function parseTimelock(raw: string | null): number {
  if (!raw) return DEFAULT_TIMELOCK_TARGET_ROUND;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_TIMELOCK_TARGET_ROUND;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
  res.end(payload);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const host = process.env.CONFIG_HOST ?? '127.0.0.1';
  const port = Number.parseInt(process.env.CONFIG_PORT ?? '8084', 10);
  await startConfigServer(host, port);
}
