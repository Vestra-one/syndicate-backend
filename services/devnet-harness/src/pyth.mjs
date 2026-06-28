import { createHash } from 'node:crypto';
import { HermesClient } from '@pythnetwork/hermes-client';

export const PYTH_UNAVAILABLE_MESSAGE = 'Pyth Oracle price for settlement is unavailable.';
export const DEFAULT_PYTH_HERMES_URL = 'https://pyth.dourolabs.app/hermes';
export const DEFAULT_PRICE_FEEDS = Object.freeze({
  BTC_USD: '0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43',
  ETH_USD: '0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace',
  SOL_USD: '0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d',
});

const I64_MIN = -(2n ** 63n);
const I64_MAX = 2n ** 63n - 1n;

export function normalizeFeedIdHex(value) {
  if (typeof value !== 'string') throw new Error('feed id must be a string');
  const hex = value.trim().toLowerCase().replace(/^0x/, '');
  if (!/^[0-9a-f]{64}$/.test(hex)) {
    throw new Error('feed id must be 32-byte hex');
  }
  return `0x${hex}`;
}

export function feedIdToBuffer(feedIdHex) {
  return Buffer.from(normalizeFeedIdHex(feedIdHex).slice(2), 'hex');
}

export function buildHermesTimestampUrl(baseUrl, publishTime, feedIdHex, options = {}) {
  const encoding = options.encoding ?? 'hex';
  const parsed = options.parsed ?? true;
  const base = String(baseUrl).endsWith('/') ? String(baseUrl) : `${baseUrl}/`;
  const url = new URL(`./v2/updates/price/${Number(publishTime)}`, base);
  url.searchParams.append('ids[]', normalizeFeedIdHex(feedIdHex));
  url.searchParams.set('encoding', encoding);
  if (parsed) url.searchParams.set('parsed', 'true');
  return url.toString();
}

export function createHermesClient({ hermesUrl = DEFAULT_PYTH_HERMES_URL, apiKey, timeoutMs = 5_000, httpRetries = 3 }) {
  if (!apiKey) throw new Error('PYTH_API_KEY is required for Pyth settlement');
  return new HermesClient(hermesUrl, {
    accessToken: apiKey,
    timeout: timeoutMs,
    httpRetries,
  });
}

export function redactedHermesConfig({ hermesUrl = DEFAULT_PYTH_HERMES_URL, apiKey }) {
  return {
    hermesUrl,
    apiKeyConfigured: Boolean(apiKey),
  };
}

export async function fetchEarliestValidPythUpdate({
  client,
  hermesUrl = DEFAULT_PYTH_HERMES_URL,
  feedIdHex,
  scheduledEndTs,
  oracleDelayWindowSec,
  maxConfidence,
  expectedExponent,
}) {
  const rules = normalizeRules({
    feedIdHex,
    scheduledEndTs,
    oracleDelayWindowSec,
    maxConfidence,
    expectedExponent,
  });
  const candidates = [];
  for (let ts = rules.scheduledEndTs; ts <= rules.windowEndTs; ts += 1) {
    const response = await client.getPriceUpdatesAtTimestamp(
      Number(ts),
      [rules.feedIdHex],
      { encoding: 'hex', parsed: true },
    );
    candidates.push(...extractHermesCandidates(response, Number(ts), hermesUrl));
  }
  return selectEarliestValidPythUpdate(candidates, rules);
}

export function extractHermesCandidates(response, requestedTimestamp, hermesUrl = DEFAULT_PYTH_HERMES_URL) {
  const parsed = Array.isArray(response?.parsed) ? response.parsed : [];
  const binaryHex = normalizeBinaryData(response?.binary?.data ?? []);
  const hermesResponseHash = hashHermesResponse(response);
  const binaryUpdateHash = hashBinaryUpdatesHex(binaryHex);
  return parsed.map((item) => {
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

export function selectEarliestValidPythUpdate(candidates, rulesInput) {
  const rules = normalizeRules(rulesInput);
  let selected = null;
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

export function pythAuditReceipt({
  matchId,
  idempotencyKey,
  selected,
  priceUpdateAccount,
  settlementTxSignature,
  settlementTxSignatures = [settlementTxSignature],
  settlementMode = 'atomic',
  receiverProgramId,
  wormholeProgramId,
  pushOracleProgramId,
}) {
  return {
    matchId: String(matchId),
    idempotencyKey,
    selectedPrice: selected.price.toString(),
    selectedPublishTime: selected.publishTime,
    confidence: selected.confidence.toString(),
    exponent: selected.exponent,
    feedIdHex: selected.feedIdHex,
    priceUpdateAccount,
    settlementMode,
    atomicSettlementTxSignature: settlementTxSignature,
    settlementTxSignatures,
    receiverProgramId,
    wormholeProgramId,
    pushOracleProgramId,
    hermesUrl: selected.hermesUrl,
    hermesResponseHash: selected.hermesResponseHash,
    binaryUpdateHash: selected.binaryUpdateHash,
  };
}

function normalizeRules(input) {
  const { feedIdHex, scheduledEndTs, oracleDelayWindowSec, maxConfidence, expectedExponent } = input;
  if (oracleDelayWindowSec === undefined && maxConfidence !== undefined && expectedExponent !== undefined) {
    const scheduled = Number(scheduledEndTs);
    const windowEnd = Number(input.windowEndTs);
    if (!Number.isSafeInteger(scheduled) || !Number.isSafeInteger(windowEnd)) {
      throw new Error('Pyth timestamp window must be safe JavaScript integers');
    }
    return {
      feedIdHex: normalizeFeedIdHex(feedIdHex),
      scheduledEndTs: scheduled,
      windowEndTs: windowEnd,
      maxConfidence: BigInt(maxConfidence),
      expectedExponent: Number(expectedExponent),
    };
  }
  const scheduled = BigInt(scheduledEndTs);
  const window = BigInt(oracleDelayWindowSec);
  if (window < 0n) throw new Error('oracleDelayWindowSec must be non-negative');
  const windowEnd = scheduled + window;
  if (scheduled > BigInt(Number.MAX_SAFE_INTEGER) || windowEnd > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error('Pyth timestamp window exceeds safe JavaScript integer range');
  }
  return {
    feedIdHex: normalizeFeedIdHex(feedIdHex),
    scheduledEndTs: Number(scheduled),
    windowEndTs: Number(windowEnd),
    maxConfidence: BigInt(maxConfidence),
    expectedExponent: Number(expectedExponent),
  };
}

function isValidCandidate(candidate, rules) {
  if (candidate.feedIdHex !== rules.feedIdHex) return false;
  if (candidate.publishTime < rules.scheduledEndTs || candidate.publishTime > rules.windowEndTs) return false;
  if (candidate.exponent !== rules.expectedExponent) return false;
  if (candidate.confidence > rules.maxConfidence) return false;
  if (candidate.price < I64_MIN || candidate.price > I64_MAX) return false;
  if (candidate.binaryDataHex.length === 0 || candidate.priceUpdateData.length === 0) return false;
  return true;
}

function parseBigIntField(value, name) {
  if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'bigint') {
    throw new Error(`Pyth ${name} must be numeric`);
  }
  return BigInt(value);
}

function parseIntegerField(value, name) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new Error(`Pyth ${name} must be a safe integer`);
  }
  return value;
}

function normalizeBinaryData(items) {
  if (!Array.isArray(items)) throw new Error('Hermes binary.data must be an array');
  return items.map((item) => {
    if (typeof item !== 'string') throw new Error('Hermes binary update must be a string');
    const hex = item.trim().toLowerCase().replace(/^0x/, '');
    if (!/^[0-9a-f]*$/.test(hex) || hex.length % 2 !== 0) {
      throw new Error('Hermes binary update must be even-length hex');
    }
    return hex;
  });
}

function hexToBase64(hex) {
  return Buffer.from(hex, 'hex').toString('base64');
}

function hashHermesResponse(response) {
  return sha256Hex(stableJson(response));
}

function hashBinaryUpdatesHex(hexItems) {
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

function sha256Hex(value) {
  return createHash('sha256').update(value).digest('hex');
}

function stableJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
}
