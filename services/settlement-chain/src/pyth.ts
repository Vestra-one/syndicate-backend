import { createHash } from 'node:crypto';
import { HermesClient } from '@pythnetwork/hermes-client';
import { DEFAULT_PYTH_HERMES_URL } from './pythStack.ts';

export { DEFAULT_PYTH_HERMES_URL, PYTH_HERMES_CORE_URL, PYTH_HERMES_UPGRADED_URL } from './pythStack.ts';
export const PYTH_UNAVAILABLE_MESSAGE = 'Pyth Oracle price for settlement is unavailable.';

const I64_MIN = -(2n ** 63n);
const I64_MAX = 2n ** 63n - 1n;

export type PythRules = {
  feedIdHex: string;
  scheduledEndTs: number | string | bigint;
  oracleDelayWindowSec: number | string | bigint;
  maxConfidence: number | string | bigint;
  expectedExponent: number;
};

export type PythCandidate = {
  feedIdHex: string;
  price: bigint;
  confidence: bigint;
  exponent: number;
  publishTime: number;
  requestedTimestamp: number;
  binaryDataHex: string[];
  priceUpdateData: string[];
  hermesResponseHash: string;
  binaryUpdateHash: string;
  hermesUrl: string;
};

export function normalizeFeedIdHex(value: unknown): string {
  if (typeof value !== 'string') throw new Error('feed id must be a string');
  const hex = value.trim().toLowerCase().replace(/^0x/, '');
  if (!/^[0-9a-f]{64}$/.test(hex)) throw new Error('feed id must be 32-byte hex');
  return `0x${hex}`;
}

export function buildHermesTimestampUrl(baseUrl: string, publishTime: number, feedIdHex: string): string {
  const base = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  const url = new URL(`./v2/updates/price/${publishTime}`, base);
  url.searchParams.append('ids[]', normalizeFeedIdHex(feedIdHex));
  url.searchParams.set('encoding', 'hex');
  url.searchParams.set('parsed', 'true');
  return url.toString();
}

export function createHermesClient({
  hermesUrl = DEFAULT_PYTH_HERMES_URL,
  apiKey,
  timeoutMs = 5_000,
  httpRetries = 3,
}: {
  hermesUrl?: string;
  apiKey: string;
  timeoutMs?: number;
  httpRetries?: number;
}): HermesClient {
  if (!apiKey) throw new Error('PYTH_API_KEY is required for Pyth settlement');
  return new HermesClient(hermesUrl, {
    accessToken: apiKey,
    timeout: timeoutMs,
    httpRetries,
  });
}

export async function fetchEarliestValidPythUpdate({
  hermesUrl = DEFAULT_PYTH_HERMES_URL,
  apiKey,
  rules,
  timeoutMs = 5_000,
  fetchImpl,
}: {
  hermesUrl?: string;
  apiKey: string;
  rules: PythRules;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}): Promise<PythCandidate | null> {
  if (!apiKey) throw new Error('PYTH_API_KEY is required for Pyth settlement');
  const normalized = normalizeRules(rules);
  const candidates: PythCandidate[] = [];
  if (fetchImpl) {
    for (let ts = normalized.scheduledEndTs; ts <= normalized.windowEndTs; ts += 1) {
      const url = buildHermesTimestampUrl(hermesUrl, ts, normalized.feedIdHex);
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetchImpl(url, {
          signal: controller.signal,
          headers: { Authorization: `Bearer ${apiKey}` },
        });
        if (!response.ok) throw new Error(`Hermes HTTP ${response.status}`);
        const json = await response.json();
        candidates.push(...extractHermesCandidates(json, ts, hermesUrl));
      } finally {
        clearTimeout(timeout);
      }
    }
    return selectEarliestValidPythUpdate(candidates, normalized);
  }
  const client = createHermesClient({ hermesUrl, apiKey, timeoutMs });
  for (let ts = normalized.scheduledEndTs; ts <= normalized.windowEndTs; ts += 1) {
    const response = await client.getPriceUpdatesAtTimestamp(
      ts,
      [normalized.feedIdHex],
      { encoding: 'hex', parsed: true },
    );
    candidates.push(...extractHermesCandidates(response, ts, hermesUrl));
  }
  return selectEarliestValidPythUpdate(candidates, normalized);
}

export function extractHermesCandidates(response: any, requestedTimestamp: number, hermesUrl = DEFAULT_PYTH_HERMES_URL): PythCandidate[] {
  const parsed = Array.isArray(response?.parsed) ? response.parsed : [];
  const binaryHex = normalizeBinaryData(response?.binary?.data ?? []);
  const hermesResponseHash = sha256Hex(stableJson(response));
  const binaryUpdateHash = hashBinaryUpdatesHex(binaryHex);
  return parsed.map((item: any) => {
    const price = item?.price ?? {};
    return {
      feedIdHex: normalizeFeedIdHex(item?.id ?? ''),
      price: parseBigIntField(price.price, 'price'),
      confidence: parseBigIntField(price.conf, 'confidence'),
      exponent: parseIntegerField(price.expo, 'exponent'),
      publishTime: parseIntegerField(price.publish_time, 'publish_time'),
      requestedTimestamp,
      binaryDataHex: binaryHex,
      priceUpdateData: binaryHex.map(hexToBase64),
      hermesResponseHash,
      binaryUpdateHash,
      hermesUrl,
    };
  });
}

export function selectEarliestValidPythUpdate(candidates: PythCandidate[], rulesInput: PythRules & { windowEndTs?: number }): PythCandidate | null {
  const rules = normalizeRules(rulesInput);
  let selected: PythCandidate | null = null;
  for (const candidate of candidates) {
    if (!isValidCandidate(candidate, rules)) continue;
    if (
      selected === null
      || candidate.publishTime < selected.publishTime
      || (candidate.publishTime === selected.publishTime && candidate.requestedTimestamp < selected.requestedTimestamp)
    ) {
      selected = candidate;
    }
  }
  return selected;
}

export function redactSecrets(value: unknown, secrets: string[]): string {
  let out = typeof value === 'string' ? value : JSON.stringify(value);
  for (const secret of secrets.filter(Boolean)) out = out.split(secret).join('[REDACTED]');
  out = out.replace(/\[(?:\s*\d{1,3}\s*,){63}\s*\d{1,3}\s*\]/g, '[REDACTED_KEYPAIR]');
  return out;
}

function normalizeRules(input: PythRules & { windowEndTs?: number }) {
  const scheduled = BigInt(input.scheduledEndTs);
  const windowEnd = input.windowEndTs === undefined
    ? scheduled + BigInt(input.oracleDelayWindowSec)
    : BigInt(input.windowEndTs);
  if (windowEnd < scheduled) throw new Error('oracle window end precedes scheduled end');
  if (scheduled > BigInt(Number.MAX_SAFE_INTEGER) || windowEnd > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error('Pyth timestamp window exceeds safe JavaScript integer range');
  }
  return {
    feedIdHex: normalizeFeedIdHex(input.feedIdHex),
    scheduledEndTs: Number(scheduled),
    windowEndTs: Number(windowEnd),
    maxConfidence: BigInt(input.maxConfidence),
    expectedExponent: Number(input.expectedExponent),
  };
}

function isValidCandidate(candidate: PythCandidate, rules: ReturnType<typeof normalizeRules>): boolean {
  if (candidate.feedIdHex !== rules.feedIdHex) return false;
  if (candidate.publishTime < rules.scheduledEndTs || candidate.publishTime > rules.windowEndTs) return false;
  if (candidate.exponent !== rules.expectedExponent) return false;
  if (candidate.confidence > rules.maxConfidence) return false;
  if (candidate.price < I64_MIN || candidate.price > I64_MAX) return false;
  if (candidate.binaryDataHex.length === 0 || candidate.priceUpdateData.length === 0) return false;
  return true;
}

function parseBigIntField(value: unknown, name: string): bigint {
  if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'bigint') {
    throw new Error(`Pyth ${name} must be numeric`);
  }
  return BigInt(value);
}

function parseIntegerField(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw new Error(`Pyth ${name} must be a safe integer`);
  return value;
}

function normalizeBinaryData(items: unknown): string[] {
  if (!Array.isArray(items)) throw new Error('Hermes binary.data must be an array');
  return items.map((item) => {
    if (typeof item !== 'string') throw new Error('Hermes binary update must be a string');
    const hex = item.trim().toLowerCase().replace(/^0x/, '');
    if (!/^[0-9a-f]*$/.test(hex) || hex.length % 2 !== 0) throw new Error('Hermes binary update must be even-length hex');
    return hex;
  });
}

function hexToBase64(hex: string): string {
  return Buffer.from(hex, 'hex').toString('base64');
}

function hashBinaryUpdatesHex(hexItems: string[]): string {
  const hash = createHash('sha256');
  for (const hex of hexItems) {
    const bytes = Buffer.from(hex, 'hex');
    const len = Buffer.alloc(4);
    len.writeUInt32BE(bytes.length, 0);
    hash.update(len);
    hash.update(bytes);
  }
  return hash.digest('hex');
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function stableJson(value: any): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
}
