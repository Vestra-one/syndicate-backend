import { bindConfig, getTierForFeed, totalBettingDurationSec, type MatchConfig } from './index.ts';

/** Fixed-point decimals per launch feed (Pyth exponent -8 → display 8). */
export const FEED_DECIMALS: Record<string, number> = {
  'BTC/USD': 8,
  'ETH/USD': 8,
  'SOL/USD': 8,
};

export interface TableTermsPayload {
  tableId: string;
  priceFeedId: string;
  supportedFeeds: string[];
  chipsToken: string;
  decimals: number;
  oracleAdapter: 'pyth';
  settlementMode: 'exact-timestamp';
  oracleUnavailableMessage: string;
  buyIn: number;
  entryFee: number;
  rakeBps: number;
  rakeCap: number;
  smallBlind: number;
  bigBlind: number;
  minPlayers: number;
  maxPlayers: number;
  roundCount: number;
  roundDurationsSec: number[];
  observationWindowsSec: number[];
  sealWindowSec: number;
  beginLiveWindowSec: number;
  nonsealPenaltyBps: number;
  /** Σ round durations + Σ observations — what begin_live adds to live_start to derive
   *  scheduled_end_ts, and the on-chain CreateParams.total_betting_duration_sec. */
  totalBettingDurationSec: number;
  actionTimerSec: number;
  timeBankSec: number;
  settlementWindowSec: number;
  geofenceBlocklist: string[];
  allowDuplicateWalletPerMatch: false;
  fillWindowSec?: number;
  practiceMode?: boolean;
  timelockTargetRound: number;
  onchainMatchId?: string;
  matchPda?: string;
}

export function toTableTerms(
  tableId: string,
  config: MatchConfig,
  opts: { onchainMatchId?: string; matchPda?: string; timelockTargetRound?: number } = {},
): TableTermsPayload {
  return {
    tableId,
    priceFeedId: config.priceFeedId,
    supportedFeeds: config.supportedFeeds,
    chipsToken: config.chipsToken,
    decimals: FEED_DECIMALS[config.priceFeedId] ?? 8,
    oracleAdapter: 'pyth',
    settlementMode: 'exact-timestamp',
    oracleUnavailableMessage: config.oracleUnavailableMessage,
    buyIn: config.buyIn,
    entryFee: config.entryFee,
    rakeBps: config.rakeBps,
    rakeCap: config.rakeCap,
    smallBlind: config.smallBlind,
    bigBlind: config.bigBlind,
    minPlayers: config.minPlayers,
    maxPlayers: config.maxPlayers,
    roundCount: config.roundCount,
    roundDurationsSec: config.roundDurationsSec,
    observationWindowsSec: config.observationWindowsSec,
    sealWindowSec: config.sealWindowSec,
    beginLiveWindowSec: config.beginLiveWindowSec,
    nonsealPenaltyBps: config.nonsealPenaltyBps,
    totalBettingDurationSec: totalBettingDurationSec(config),
    actionTimerSec: config.actionTimerSec,
    timeBankSec: config.timeBankSec,
    settlementWindowSec: config.settlementWindowSec,
    geofenceBlocklist: config.geofenceBlocklist,
    allowDuplicateWalletPerMatch: false,
    fillWindowSec: config.fillWindowSec,
    practiceMode: config.practiceMode,
    timelockTargetRound: opts.timelockTargetRound ?? 1_000_000,
    onchainMatchId: opts.onchainMatchId,
    matchPda: opts.matchPda,
  };
}

export function tableTermsForTier(
  tableId: string,
  tierId: string,
  feedId: string,
  opts: { onchainMatchId?: string; matchPda?: string; timelockTargetRound?: number } = {},
): TableTermsPayload | undefined {
  const tier = getTierForFeed(tierId, feedId);
  if (!tier) return undefined;
  bindConfig(tier.config);
  return toTableTerms(tableId, tier.config, opts);
}
