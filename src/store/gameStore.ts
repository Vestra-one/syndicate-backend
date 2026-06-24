import { create } from 'zustand'
import type {
  Bet,
  ConnectionStatus,
  Direction,
  MarketId,
  PriceTick,
  Round,
  Wallet,
} from '@/lib/types'
import type { GameFeed } from '@/lib/realtime/feed'
import { createMockFeed } from '@/lib/realtime/mockFeed'

const MAX_HISTORY = 240 // ~1 min at 250ms ticks — enough to draw a sparkline

interface GameState {
  market: MarketId
  status: ConnectionStatus
  price: number | null
  priceHistory: PriceTick[]
  round: Round | null
  wallet: Wallet
  myBets: Bet[]

  connect: () => void
  disconnect: () => void
  placeBet: (direction: Direction, amount: number) => void
}

let feed: GameFeed | null = null
let unsub: (() => void) | null = null

const DEFAULT_MARKET = (import.meta.env.VITE_DEFAULT_MARKET as string) || 'BTC-USD'

export const useGameStore = create<GameState>((set, get) => ({
  market: DEFAULT_MARKET,
  status: 'offline',
  price: null,
  priceHistory: [],
  round: null,
  wallet: { currency: 'FIBO', balance: 1_000 },
  myBets: [],

  connect: () => {
    if (feed) return
    set({ status: 'connecting' })
    feed = createMockFeed(get().market)
    unsub = feed.subscribe((event) => {
      switch (event.type) {
        case 'tick':
          set((s) => ({
            price: event.tick.price,
            priceHistory: [...s.priceHistory, event.tick].slice(-MAX_HISTORY),
          }))
          break
        case 'round':
          handleRound(event.round, set, get)
          break
        case 'bet':
          // server-acknowledged bet — append if it's ours and not already tracked
          set((s) =>
            s.myBets.some((b) => b.id === event.bet.id)
              ? s
              : { myBets: [...s.myBets, event.bet] },
          )
          break
      }
    })
    void feed.connect().then(() => set({ status: 'live' }))
  },

  disconnect: () => {
    unsub?.()
    feed?.disconnect()
    feed = null
    unsub = null
    set({ status: 'offline' })
  },

  placeBet: (direction, amount) => {
    const { round, wallet } = get()
    if (!feed || !round || round.phase !== 'OPEN') return
    if (amount <= 0 || amount > wallet.balance) return
    // optimistic debit; server ack arrives via the 'bet' event
    set({ wallet: { ...wallet, balance: wallet.balance - amount } })
    feed.placeBet(direction, amount)
  },
}))

function handleRound(
  round: Round,
  set: (partial: Partial<GameState>) => void,
  get: () => GameState,
) {
  if (round.phase === 'SETTLED' && round.result) {
    settleMyBets(round, set, get)
  }
  set({ round })
}

function settleMyBets(
  round: Round,
  set: (partial: Partial<GameState>) => void,
  get: () => GameState,
) {
  const { myBets, wallet } = get()
  const total = round.pool.UP + round.pool.DOWN
  const winningPool = round.result ? round.pool[round.result] : 0
  let credited = 0

  const updated = myBets.map((bet) => {
    if (bet.roundId !== round.id || bet.payout !== null) return bet
    const won = bet.direction === round.result
    // pari-mutuel: winners split the whole pool pro-rata; fall back to stake refund
    const payout = won ? (winningPool > 0 ? bet.amount * (total / winningPool) : bet.amount) : 0
    credited += payout
    return { ...bet, won, payout }
  })

  set({
    myBets: updated,
    wallet: { ...wallet, balance: wallet.balance + credited },
  })
}
