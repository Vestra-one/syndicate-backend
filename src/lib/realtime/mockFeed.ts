import type { Bet, Direction, MarketId, PriceTick, Round } from '@/lib/types'
import type { FeedEvent, FeedListener, GameFeed } from './feed'

/**
 * In-browser stand-in for the real game server. It walks a price via a random
 * walk, runs rounds on a fixed cadence (open → lock → settle), and echoes bets
 * back as acknowledgements. Deterministic enough to develop the whole UI
 * against before any backend exists.
 */

const ROUND_OPEN_MS = 15_000
const ROUND_LOCK_MS = 8_000
const TICK_MS = 250

let seq = 0
const uid = (p: string) => `${p}_${Date.now().toString(36)}_${(seq++).toString(36)}`

export function createMockFeed(market: MarketId, startPrice = 64_000): GameFeed {
  const listeners = new Set<FeedListener>()
  let price = startPrice
  let round: Round | null = null
  let tickTimer: ReturnType<typeof setInterval> | null = null
  let phaseTimer: ReturnType<typeof setTimeout> | null = null

  const emit = (event: FeedEvent) => listeners.forEach((l) => l(event))

  const newRound = (): Round => {
    const now = Date.now()
    return {
      id: uid('round'),
      market,
      phase: 'OPEN',
      opensAt: now,
      locksAt: now + ROUND_OPEN_MS,
      settlesAt: now + ROUND_OPEN_MS + ROUND_LOCK_MS,
      lockPrice: null,
      settlePrice: null,
      result: null,
      pool: { UP: 0, DOWN: 0 },
    }
  }

  const stepPrice = () => {
    // gentle random walk with slight mean pull, ~0.05% per tick volatility
    const drift = (startPrice - price) * 0.0008
    const shock = (Math.random() - 0.5) * price * 0.0012
    price = Math.max(1, price + drift + shock)
    emit({ type: 'tick', tick: { market, price, ts: Date.now() } })
  }

  const advancePhase = () => {
    if (!round) return
    if (round.phase === 'OPEN') {
      round = { ...round, phase: 'LOCKED', lockPrice: price }
      emit({ type: 'round', round })
      phaseTimer = setTimeout(advancePhase, ROUND_LOCK_MS)
    } else if (round.phase === 'LOCKED') {
      const settlePrice = price
      const result: Direction = settlePrice >= (round.lockPrice ?? settlePrice) ? 'UP' : 'DOWN'
      round = { ...round, phase: 'SETTLED', settlePrice, result }
      emit({ type: 'round', round })
      // brief intermission, then open the next round
      phaseTimer = setTimeout(() => {
        round = newRound()
        emit({ type: 'round', round })
        phaseTimer = setTimeout(advancePhase, ROUND_OPEN_MS)
      }, 2_000)
    }
  }

  return {
    async connect() {
      round = newRound()
      // deliver an initial snapshot synchronously-ish
      emit({ type: 'tick', tick: { market, price, ts: Date.now() } })
      emit({ type: 'round', round })
      tickTimer = setInterval(stepPrice, TICK_MS)
      phaseTimer = setTimeout(advancePhase, ROUND_OPEN_MS)
    },
    disconnect() {
      if (tickTimer) clearInterval(tickTimer)
      if (phaseTimer) clearTimeout(phaseTimer)
      tickTimer = phaseTimer = null
      listeners.clear()
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    placeBet(direction, amount) {
      if (!round || round.phase !== 'OPEN') return
      round = {
        ...round,
        pool: { ...round.pool, [direction]: round.pool[direction] + amount },
      }
      const bet: Bet = {
        id: uid('bet'),
        roundId: round.id,
        market,
        direction,
        amount,
        placedAt: Date.now(),
        payout: null,
        won: null,
      }
      emit({ type: 'round', round })
      emit({ type: 'bet', bet })
    },
  }
}
