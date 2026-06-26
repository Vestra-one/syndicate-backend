import type { LiveGame } from './protocol'
import { IS_DEMO } from './adapters'

/**
 * Discovery (§8): the live-games feed behind the dashboard. Served over the
 * gateway `subscribe` or a thin REST endpoint in production; here it's
 * demo-synthesized so the dashboard is fully playable offline. Selecting any
 * table routes into the one demo match.
 */

function synth(): LiveGame[] {
  const now = Date.now()
  const min = (m: number) => now - m * 60_000
  return [
    { matchId: 'demo-match-001', feed: 'BTC/USD', buyIn: 1000, potSize: 0, spectators: 42, actionsPerMin: 18, startedAt: min(3) },
    { matchId: 'tbl-btc-high', feed: 'BTC/USD', buyIn: 5000, potSize: 21_500, spectators: 88, actionsPerMin: 31, startedAt: min(12) },
    { matchId: 'tbl-eth-mid', feed: 'ETH/USD', buyIn: 500, potSize: 1840, spectators: 31, actionsPerMin: 24, startedAt: min(7) },
    { matchId: 'tbl-sol-hot', feed: 'SOL/USD', buyIn: 1000, potSize: 4400, spectators: 54, actionsPerMin: 22, startedAt: min(9) },
    { matchId: 'tbl-sol-low', feed: 'SOL/USD', buyIn: 250, potSize: 920, spectators: 12, actionsPerMin: 9, startedAt: min(2) },
    { matchId: 'tbl-eth-micro', feed: 'ETH/USD', buyIn: 100, potSize: 260, spectators: 5, actionsPerMin: 6, startedAt: min(1) },
  ]
}

/** A "rated" popularity score — the default dashboard ranking (§8). */
export function ratedScore(g: LiveGame): number {
  return g.spectators * 2 + g.actionsPerMin + g.potSize / 1000
}

export async function fetchActiveGames(): Promise<LiveGame[]> {
  // Live mode would read the gateway `activeGames` broadcast or a REST endpoint.
  return IS_DEMO ? synth() : synth()
}
