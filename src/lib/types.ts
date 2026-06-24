/**
 * Core domain model for the price-betting game.
 *
 * The game runs as a sequence of timed rounds on a market. During the OPEN
 * phase players place directional bets (UP / DOWN). At lock, the entry price is
 * frozen; at settle, the exit price decides the winning side and payouts.
 */

export type MarketId = string // e.g. "BTC-USD"

export type Direction = 'UP' | 'DOWN'

export type RoundPhase =
  | 'OPEN' // accepting bets
  | 'LOCKED' // bets closed, price in flight
  | 'SETTLED' // result known, payouts applied

export interface PriceTick {
  market: MarketId
  price: number
  /** epoch ms */
  ts: number
}

export interface Round {
  id: string
  market: MarketId
  phase: RoundPhase
  /** epoch ms */
  opensAt: number
  locksAt: number
  settlesAt: number
  /** price captured at lock; null until LOCKED */
  lockPrice: number | null
  /** price captured at settle; null until SETTLED */
  settlePrice: number | null
  /** winning side; null until SETTLED */
  result: Direction | null
  /** aggregate stake per side, for the pari-mutuel pool display */
  pool: Record<Direction, number>
}

export interface Bet {
  id: string
  roundId: string
  market: MarketId
  direction: Direction
  amount: number
  /** epoch ms */
  placedAt: number
  /** filled once the bet's round settles */
  payout: number | null
  won: boolean | null
}

export interface Wallet {
  /** display currency code, e.g. "USD" or "FIBO" */
  currency: string
  balance: number
}

export interface Player {
  id: string
  name: string
  /** seat index around the table, 0-based */
  seat: number
  /** stake committed in the current round, if any */
  stake: number | null
  direction: Direction | null
  isYou: boolean
}

export type ConnectionStatus = 'connecting' | 'live' | 'reconnecting' | 'offline'
