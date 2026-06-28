/**
 * @syndicate/config — versioned game parameters (the single home of every tunable
 * number; `04 §2`, `06 §12`, `08 OQ7`). Validation rejects unsafe combinations at
 * author time; `bindConfig` snapshots + hashes a config so a match is replayable
 * against the exact parameters it ran under (`04 §18`).
 */
import { createHash } from 'node:crypto';

export interface MatchConfig {
  priceFeedId: string;      // e.g. "BTC/USD"
  supportedFeeds: string[]; // feeds this config family permits; launch default BTC/ETH/SOL
  chipsToken: string;       // e.g. "USDC" (decoupled from the feed)
  oracleAdapter: string;    // canonical launch path: "pyth"
  settlementMode: string;   // canonical launch path: "bounded-exact-after"
  oracleDelayWindowSec: number; // first valid Pyth update after scheduled end, default 5s
  oracleUnavailableMessage: string;
  buyIn: number;            // in chips_token base units
  maxBuyIn: number;         // table cap (anti-manipulation, 08 OQ2)
  chipsPerUnit: number;     // stack = buyIn * chipsPerUnit
  smallBlind: number;
  bigBlind: number;
  ante: number;
  entryFee: number;         // fee on join (04 §14)
  rakeBps: number;          // pot rake (04 §14)
  rakeCap: number;
  minPlayers: number;
  maxPlayers: number;
  actionTimerSec: number;
  timeBankSec: number;
  roundCount: number;
  roundDurationsSec: number[];
  settlementWindowSec: number;
  timelockTargetOffsetSec: number;
  geofenceBlocklist: string[]; // ISO country codes; India ("IN") blocked by default
  allowDuplicateWalletPerMatch: boolean; // launch invariant: false
  /** Public queue: wait this long before starting with available players. */
  fillWindowSec: number;
  /** When true, identical rules but no on-chain custody (engine-only). */
  practiceMode?: boolean;
}

export interface TierDefinition {
  tierId: string;
  label: string;
  buyIn: number;
  fillWindowSec: number;
  practiceMode: boolean;
  config: MatchConfig;
}

export interface ConfigCatalog {
  feeds: string[];
  tiers: TierDefinition[];
  practiceTierId: string;
}

/** Minimum acceptable starting stack depth, in big blinds. */
export const MIN_START_BB = 20;
export const ORACLE_ADAPTER_PYTH = 'pyth';
export const SETTLEMENT_MODE_BOUNDED_EXACT_AFTER = 'bounded-exact-after';
export const DEFAULT_ORACLE_DELAY_WINDOW_SEC = 5;
export const DEFAULT_ORACLE_UNAVAILABLE_MESSAGE = 'Pyth Oracle price for settlement is unavailable.';
export const DEFAULT_SUPPORTED_FEEDS = ['BTC/USD', 'ETH/USD', 'SOL/USD'] as const;
export const DEFAULT_GEOFENCE_BLOCKLIST = ['IN'] as const;
export const DEFAULT_ENTRY_FEE = 0;
export const DEFAULT_RAKE_BPS = 300;

/** Returns a list of guardrail violations; empty means the config is safe to use. */
export function validateConfig(c: MatchConfig): string[] {
  const e: string[] = [];
  if (!c.priceFeedId) e.push('priceFeedId is required');
  if (!Array.isArray(c.supportedFeeds) || c.supportedFeeds.length === 0) e.push('supportedFeeds must be non-empty');
  if (Array.isArray(c.supportedFeeds) && c.supportedFeeds.length > 0 && !c.supportedFeeds.includes(c.priceFeedId)) {
    e.push('priceFeedId must be included in supportedFeeds');
  }
  if (new Set(c.supportedFeeds).size !== c.supportedFeeds.length) e.push('supportedFeeds must be unique');
  if (c.oracleAdapter !== ORACLE_ADAPTER_PYTH) e.push('oracleAdapter must be pyth');
  if (c.settlementMode !== SETTLEMENT_MODE_BOUNDED_EXACT_AFTER) e.push('settlementMode must be bounded-exact-after');
  if (!Number.isInteger(c.oracleDelayWindowSec) || c.oracleDelayWindowSec <= 0) e.push('oracleDelayWindowSec must be a positive integer');
  if (!c.oracleUnavailableMessage || c.oracleUnavailableMessage.trim() !== DEFAULT_ORACLE_UNAVAILABLE_MESSAGE) {
    e.push('oracleUnavailableMessage must match the canonical Pyth unavailable message');
  }
  if (!Array.isArray(c.geofenceBlocklist)) e.push('geofenceBlocklist must be an array');
  if (Array.isArray(c.geofenceBlocklist) && !c.geofenceBlocklist.includes('IN')) e.push('geofenceBlocklist must include IN by default');
  if (c.allowDuplicateWalletPerMatch) e.push('duplicate wallets in one match are not allowed');
  if (!Number.isInteger(c.fillWindowSec) || c.fillWindowSec <= 0) e.push('fillWindowSec must be a positive integer');
  if (c.practiceMode && c.buyIn !== 0) e.push('practiceMode requires buyIn 0');
  if (c.minPlayers < 2) e.push('minPlayers must be >= 2');
  if (c.maxPlayers > 5) e.push('maxPlayers must be <= 5');
  if (c.minPlayers > c.maxPlayers) e.push('minPlayers exceeds maxPlayers');
  if (c.bigBlind <= 0) e.push('bigBlind must be positive');
  if (c.smallBlind <= 0) e.push('smallBlind must be positive');
  if (c.bigBlind <= c.smallBlind) e.push('bigBlind must exceed smallBlind');
  if (c.buyIn > c.maxBuyIn) e.push('buyIn exceeds maxBuyIn');
  if (c.rakeBps > 10_000) e.push('rakeBps exceeds 100%');
  if (c.rakeBps < 0 || c.rakeCap < 0 || c.entryFee < 0) e.push('fees must be non-negative');
  if (c.roundCount < 1) e.push('roundCount must be >= 1');
  if (c.roundDurationsSec.length !== c.roundCount) e.push('roundDurations length != roundCount');
  if (c.roundDurationsSec.some((d) => d <= 0)) e.push('round durations must be positive');
  const matchDuration = c.roundDurationsSec.reduce((a, b) => a + b, 0);
  if (c.settlementWindowSec <= 0) e.push('settlementWindow must be positive');
  if (c.settlementWindowSec > matchDuration) e.push('settlementWindow exceeds match duration');
  if (c.bigBlind > 0 && !c.practiceMode) {
    const startStack = c.buyIn * c.chipsPerUnit;
    if (startStack / c.bigBlind < MIN_START_BB) e.push(`starting stack < ${MIN_START_BB} BB (too shallow)`);
  }
  return e;
}

export function isValid(c: MatchConfig): boolean {
  return validateConfig(c).length === 0;
}

export interface BoundConfig {
  config: MatchConfig;
  /** sha256 of the canonical config — recorded per match as the replay anchor. */
  hash: string;
}

/** Key-sorted JSON so the hash is independent of property order (deterministic). */
export function canonicalize(c: MatchConfig): string {
  const sorted: Record<string, unknown> = {};
  for (const k of Object.keys(c).sort()) sorted[k] = (c as Record<string, unknown>)[k];
  return JSON.stringify(sorted);
}

export function bindConfig(c: MatchConfig): BoundConfig {
  const errs = validateConfig(c);
  if (errs.length) throw new Error('cannot bind invalid config: ' + errs.join('; '));
  const hash = createHash('sha256').update(canonicalize(c)).digest('hex');
  return { config: c, hash };
}

/** Versioned config sets; binding records the exact parameters a match runs under. */
export class ConfigRegistry {
  private sets = new Map<string, MatchConfig>();
  publish(version: string, c: MatchConfig): void {
    const errs = validateConfig(c);
    if (errs.length) throw new Error('invalid config: ' + errs.join('; '));
    this.sets.set(version, c);
  }
  get(version: string): MatchConfig | undefined {
    return this.sets.get(version);
  }
  bind(version: string): BoundConfig {
    const c = this.get(version);
    if (!c) throw new Error('unknown config version: ' + version);
    return bindConfig(c);
  }
}

/** Launch default: configurable Pyth feed, USDC token, ~100 BB stacks. */
export function defaultFeedUsdcTier(priceFeedId: string, buyIn: number): MatchConfig {
  const bigBlind = Math.max(2, Math.floor(buyIn / 100));
  return {
    priceFeedId,
    supportedFeeds: [...DEFAULT_SUPPORTED_FEEDS],
    chipsToken: 'USDC',
    oracleAdapter: ORACLE_ADAPTER_PYTH,
    settlementMode: SETTLEMENT_MODE_BOUNDED_EXACT_AFTER,
    oracleDelayWindowSec: DEFAULT_ORACLE_DELAY_WINDOW_SEC,
    oracleUnavailableMessage: DEFAULT_ORACLE_UNAVAILABLE_MESSAGE,
    buyIn,
    maxBuyIn: 5_000_000_000_000,
    chipsPerUnit: 1,
    smallBlind: Math.max(1, Math.floor(bigBlind / 2)),
    bigBlind,
    ante: 0,
    entryFee: DEFAULT_ENTRY_FEE,
    rakeBps: DEFAULT_RAKE_BPS,
    rakeCap: buyIn,
    minPlayers: 2,
    maxPlayers: 5,
    actionTimerSec: 25,
    timeBankSec: 60,
    roundCount: 3,
    roundDurationsSec: [240, 180, 180],
    settlementWindowSec: 60,
    timelockTargetOffsetSec: 600,
    geofenceBlocklist: [...DEFAULT_GEOFENCE_BLOCKLIST],
    allowDuplicateWalletPerMatch: false,
    fillWindowSec: 120,
    practiceMode: false,
  };
}

/** Launch default: BTC/USD feed, USDC token, ~100 BB stacks. */
export function defaultBtcUsdcTier(buyIn: number): MatchConfig {
  return defaultFeedUsdcTier('BTC/USD', buyIn);
}

export function defaultEthUsdcTier(buyIn: number): MatchConfig {
  return defaultFeedUsdcTier('ETH/USD', buyIn);
}

export function defaultSolUsdcTier(buyIn: number): MatchConfig {
  return defaultFeedUsdcTier('SOL/USD', buyIn);
}

/** No-stakes practice preset — identical rules, zero custody. */
export function practiceModeConfig(priceFeedId = 'BTC/USD'): MatchConfig {
  const base = defaultFeedUsdcTier(priceFeedId, 0);
  return { ...base, buyIn: 0, entryFee: 0, rakeBps: 0, rakeCap: 0, practiceMode: true, fillWindowSec: 60 };
}

export const TIER_BUY_INS = {
  low: 10_000_000,      // $10 USDC (6 decimals)
  mid: 50_000_000,      // $50
  high: 100_000_000,    // $100
} as const;

const DEFAULT_FILL_WINDOWS = { low: 90, mid: 120, high: 180 } as const;

/** Launch catalog: 3 buy-in tiers + practice mode. */
export function buildConfigCatalog(): ConfigCatalog {
  const feeds = [...DEFAULT_SUPPORTED_FEEDS];
  const tiers: TierDefinition[] = [
    {
      tierId: 'tier-low',
      label: 'Low Stakes',
      buyIn: TIER_BUY_INS.low,
      fillWindowSec: DEFAULT_FILL_WINDOWS.low,
      practiceMode: false,
      config: defaultBtcUsdcTier(TIER_BUY_INS.low),
    },
    {
      tierId: 'tier-mid',
      label: 'Mid Stakes',
      buyIn: TIER_BUY_INS.mid,
      fillWindowSec: DEFAULT_FILL_WINDOWS.mid,
      practiceMode: false,
      config: defaultBtcUsdcTier(TIER_BUY_INS.mid),
    },
    {
      tierId: 'tier-high',
      label: 'High Stakes',
      buyIn: TIER_BUY_INS.high,
      fillWindowSec: DEFAULT_FILL_WINDOWS.high,
      practiceMode: false,
      config: defaultBtcUsdcTier(TIER_BUY_INS.high),
    },
    {
      tierId: 'tier-practice',
      label: 'Practice',
      buyIn: 0,
      fillWindowSec: 60,
      practiceMode: true,
      config: practiceModeConfig('BTC/USD'),
    },
  ];
  for (const tier of tiers) {
    tier.config.fillWindowSec = tier.fillWindowSec;
    if (tier.practiceMode) tier.config.practiceMode = true;
  }
  return { feeds, tiers, practiceTierId: 'tier-practice' };
}

export function getTierById(tierId: string): TierDefinition | undefined {
  return buildConfigCatalog().tiers.find((t) => t.tierId === tierId);
}

export function getTierForFeed(tierId: string, feedId: string): TierDefinition | undefined {
  const tier = getTierById(tierId);
  if (!tier) return undefined;
  if (tier.practiceMode) {
    return { ...tier, config: practiceModeConfig(feedId) };
  }
  const buyIn = tier.buyIn;
  const config = defaultFeedUsdcTier(feedId, buyIn);
  config.fillWindowSec = tier.fillWindowSec;
  return { ...tier, config };
}
