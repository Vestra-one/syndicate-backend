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
  settlementMode: string;   // canonical launch path: "exact-timestamp"
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
  /** Per-street no-betting observation window (plan_v2 §8/§12); len === roundCount. The
   *  last entry is the final price-uncertainty tail before scheduled_end_ts. */
  observationWindowsSec: number[];
  /** SEALING window length (plan_v2 §1): seats record their on-chain seal commitment
   *  within this window after `lock`. */
  sealWindowSec: number;
  /** Max delay after the seal deadline for the operator to call `begin_live` (plan_v2 §I).
   *  Pins match end near the seal round so timelock targets can't decrypt mid-match. */
  beginLiveWindowSec: number;
  /** Non-sealer penalty in basis points of buy-in (plan_v2 §5), forfeited to the pot. */
  nonsealPenaltyBps: number;
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
export const SETTLEMENT_MODE_EXACT_TIMESTAMP = 'exact-timestamp';
export const DEFAULT_ORACLE_UNAVAILABLE_MESSAGE = 'Pyth Oracle price for settlement is unavailable.';
export const DEFAULT_SUPPORTED_FEEDS = ['BTC/USD', 'ETH/USD', 'SOL/USD'] as const;
export const DEFAULT_GEOFENCE_BLOCKLIST = ['IN'] as const;
export const DEFAULT_ENTRY_FEE = 0;
export const DEFAULT_RAKE_BPS = 300;
export const DEFAULT_SEAL_WINDOW_SEC = 20;
/** Default non-sealer penalty: 25% of buy-in forfeited to the pot (plan_v2 §5). */
export const DEFAULT_NONSEAL_PENALTY_BPS = 2500;
/** Default begin_live window — matches on-chain DEFAULT_BEGIN_LIVE_WINDOW_SEC (plan_v2 §I). */
export const DEFAULT_BEGIN_LIVE_WINDOW_SEC = 5;
/** Must equal the on-chain MAX_TIMELOCK_SKEW_SEC (plan_v2 §I). */
export const MAX_TIMELOCK_SKEW_SEC = 20;

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
  if (c.settlementMode !== SETTLEMENT_MODE_EXACT_TIMESTAMP) e.push('settlementMode must be exact-timestamp');
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
  if (!Array.isArray(c.observationWindowsSec) || c.observationWindowsSec.length !== c.roundCount) {
    e.push('observationWindowsSec length must equal roundCount');
  }
  if (Array.isArray(c.observationWindowsSec) && c.observationWindowsSec.some((o) => o < 0 || !Number.isInteger(o))) {
    e.push('observation windows must be non-negative integers');
  }
  // The last street's observation window IS the final price-uncertainty tail; require it
  // to be positive so betting always closes before the settlement price is read (plan_v2 §12).
  if (Array.isArray(c.observationWindowsSec) && c.observationWindowsSec.length === c.roundCount) {
    const lastObs = c.observationWindowsSec[c.roundCount - 1] ?? 0;
    if (lastObs <= 0) e.push('the final street observation window (price-uncertainty tail) must be positive');
  }
  if (!Number.isInteger(c.sealWindowSec) || c.sealWindowSec <= 0) e.push('sealWindowSec must be a positive integer');
  if (!Number.isInteger(c.beginLiveWindowSec) || c.beginLiveWindowSec <= 0) e.push('beginLiveWindowSec must be a positive integer');
  if (!Number.isInteger(c.nonsealPenaltyBps) || c.nonsealPenaltyBps < 0 || c.nonsealPenaltyBps > 10_000) {
    e.push('nonsealPenaltyBps must be an integer in 0..=10000');
  }
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

/**
 * Total wall-clock betting span (seconds) = Σ street durations + Σ observation windows.
 * This is what `begin_live` adds to `live_start_ts` to derive `scheduled_end_ts`, and
 * what the on-chain `CreateParams.total_betting_duration_sec` must equal (plan_v2 §A/§D).
 */
export function totalBettingDurationSec(c: MatchConfig): number {
  const betting = c.roundDurationsSec.reduce((a, b) => a + b, 0);
  const observation = (c.observationWindowsSec ?? []).reduce((a, b) => a + b, 0);
  return betting + observation;
}

/**
 * Derive the drand `timelock_target` round a prediction is sealed to. Must land in the
 * on-chain valid window (plan_v2 §I): `(latest_match_end, latest_match_end + MAX_TIMELOCK_SKEW_SEC]`
 * where `latest_match_end = projectedLiveStart + totalBettingDuration + beginLiveWindowSec`
 * (the latest possible match end given the begin_live slack). Picking the FIRST round after
 * `latest_match_end` publishes within one beacon period (3s) → always inside the 20s skew,
 * concealment-safe and promptly decryptable. (`timelockTargetOffsetSec` is no longer used
 * for this and is retained only as legacy config metadata.)
 * Mirrors the on-chain pinned-beacon math: round publish = genesis + round*period.
 */
export const DRAND_GENESIS_TIME = 1_692_803_367;
export const DRAND_PERIOD_SEC = 3;
export function timelockTargetRound(c: MatchConfig, projectedLiveStartUnix: number): number {
  const latestMatchEnd = projectedLiveStartUnix + totalBettingDurationSec(c) + c.beginLiveWindowSec;
  // First round whose publish time is strictly after the latest possible match end.
  const round = Math.floor((latestMatchEnd - DRAND_GENESIS_TIME) / DRAND_PERIOD_SEC) + 1;
  return Math.max(round, 1);
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
    settlementMode: SETTLEMENT_MODE_EXACT_TIMESTAMP,
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
    roundDurationsSec: [220, 160, 120],
    observationWindowsSec: [20, 20, 40],
    sealWindowSec: DEFAULT_SEAL_WINDOW_SEC,
    beginLiveWindowSec: DEFAULT_BEGIN_LIVE_WINDOW_SEC,
    nonsealPenaltyBps: DEFAULT_NONSEAL_PENALTY_BPS,
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
  return { ...base, buyIn: 0, entryFee: 0, rakeBps: 0, rakeCap: 0, nonsealPenaltyBps: 0, practiceMode: true, fillWindowSec: 60 };
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

/**
 * A published, hashed game template (plan_v2 §C/§H). Each (non-practice) tier × supported
 * feed is a coexisting template. The indexer projects ONLY matches whose on-chain
 * `config_hash` is in this allowlist; clients use the template to build the
 * `[create_match, deposit]` params (durations, sealWindow, penalty, oracle tolerance).
 */
export interface GameTemplate {
  templateId: string;
  tierId: string;
  label: string;
  feed: string;
  buyIn: number;
  config: MatchConfig;
  configHash: string;
  totalBettingDurationSec: number;
}

/** Build every coexisting published template across tiers and supported feeds. */
export function buildTemplates(): GameTemplate[] {
  const catalog = buildConfigCatalog();
  const out: GameTemplate[] = [];
  for (const tier of catalog.tiers) {
    const feeds = tier.practiceMode ? catalog.feeds : catalog.feeds;
    for (const feed of feeds) {
      const t = getTierForFeed(tier.tierId, feed);
      if (!t) continue;
      const bound = bindConfig(t.config);
      out.push({
        templateId: `${tier.tierId}:${feed}`,
        tierId: tier.tierId,
        label: tier.label,
        feed,
        buyIn: t.buyIn,
        config: t.config,
        configHash: bound.hash,
        totalBettingDurationSec: totalBettingDurationSec(t.config),
      });
    }
  }
  return out;
}

/** config_hash -> template map (consumed by indexer allowlist + client). */
export function buildTemplateHashMap(): Map<string, GameTemplate> {
  const m = new Map<string, GameTemplate>();
  for (const t of buildTemplates()) m.set(t.configHash, t);
  return m;
}

/** Allowlisted config hashes — the indexer ignores matches with any other config_hash. */
export function templateAllowlist(): Set<string> {
  return new Set(buildTemplates().map((t) => t.configHash));
}

export function getTemplateByHash(configHash: string): GameTemplate | undefined {
  return buildTemplateHashMap().get(configHash);
}
