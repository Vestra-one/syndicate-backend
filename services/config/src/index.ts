/**
 * @syndicate/config — versioned game parameters (the single home of every tunable
 * number; `04 §2`, `06 §12`, `08 OQ7`). Validation rejects unsafe combinations at
 * author time; `bindConfig` snapshots + hashes a config so a match is replayable
 * against the exact parameters it ran under (`04 §18`).
 */
import { createHash } from 'node:crypto';

export interface MatchConfig {
  priceFeedId: string;      // e.g. "BTC/USD"
  chipsToken: string;       // e.g. "USDC" (decoupled from the feed)
  oracleAdapter: string;    // e.g. "switchboard-on-demand"
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
}

/** Minimum acceptable starting stack depth, in big blinds. */
export const MIN_START_BB = 20;

/** Returns a list of guardrail violations; empty means the config is safe to use. */
export function validateConfig(c: MatchConfig): string[] {
  const e: string[] = [];
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
  if (c.bigBlind > 0) {
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

/** Launch default: BTC/USD feed, USDC token, ~100 BB stacks (08 OQ5, OQ8). */
export function defaultBtcUsdcTier(buyIn: number): MatchConfig {
  const bigBlind = Math.max(2, Math.floor(buyIn / 100));
  return {
    priceFeedId: 'BTC/USD',
    chipsToken: 'USDC',
    oracleAdapter: 'switchboard-on-demand',
    buyIn,
    maxBuyIn: 5_000_000_000_000,
    chipsPerUnit: 1,
    smallBlind: Math.max(1, Math.floor(bigBlind / 2)),
    bigBlind,
    ante: 0,
    entryFee: 0,
    rakeBps: 300,
    rakeCap: buyIn,
    minPlayers: 2,
    maxPlayers: 5,
    actionTimerSec: 25,
    timeBankSec: 60,
    roundCount: 3,
    roundDurationsSec: [240, 180, 180],
    settlementWindowSec: 60,
    timelockTargetOffsetSec: 600,
  };
}
