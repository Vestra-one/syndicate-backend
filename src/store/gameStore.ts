import { create } from 'zustand'
import type {
  BettingAction,
  DefaultAction,
  FixedPrice,
  MatchStateView,
  PublicEvent,
  SettlementView,
  TableTerms,
  VoidReason,
} from '@/lib/protocol'
import { DRAND } from '@/lib/protocol'
import type { ConnectionStatus, PricePoint } from '@/lib/ui'
import { createAdapters, IS_DEMO, type Adapters } from '@/lib/adapters'
import { createGateway, type Gateway } from '@/lib/realtime/gateway'

const MAX_HISTORY = 240 // ~2 min at 500ms snapshots — enough for the board chart
const MAX_FEED = 40 // recent public events kept for the action feed

/** One-way latch for the prediction (§6, seal-once). */
export type SealStatus = 'unsealed' | 'sealing' | 'sealed'

interface GameState {
  status: ConnectionStatus
  walletAddress: string | null
  chipBalance: number | null

  terms: TableTerms | null
  match: MatchStateView | null
  yourTurn: { toCall: number; minRaiseTo: number; deadline: number } | null

  // self-centric, derived from the feed
  sealStatus: SealStatus
  yourPrediction: FixedPrice | null // plaintext, client-only — never sent in the clear
  defaultAction: DefaultAction

  priceHistory: PricePoint[]
  feed: PublicEvent[]

  settlement: SettlementView | null
  voided: { reason: VoidReason } | null

  // actions
  connect: () => Promise<void>
  disconnect: () => void
  sealPrediction: (price: FixedPrice) => Promise<void>
  act: (action: BettingAction) => Promise<void>
  setDefault: (def: DefaultAction) => void
  claim: () => Promise<string | null>
  refund: () => Promise<string | null>
}

let adapters: Adapters | null = null
let gateway: Gateway | null = null
let unsub: (() => void) | null = null
let depositedFor: string | null = null

export const useGameStore = create<GameState>((set, get) => ({
  status: 'offline',
  walletAddress: null,
  chipBalance: null,

  terms: null,
  match: null,
  yourTurn: null,

  sealStatus: 'unsealed',
  yourPrediction: null,
  defaultAction: 'check_fold',

  priceHistory: [],
  feed: [],

  settlement: null,
  voided: null,

  connect: async () => {
    if (gateway) return
    set({ status: 'connecting' })
    adapters = createAdapters()
    // Capture the instance locally — `gateway` (module-global) can be reassigned
    // by a StrictMode unmount/remount across the awaits below; we must act on the
    // instance we created, never whatever global points at after the await.
    const gw = createGateway(adapters)
    gateway = gw

    unsub = gw.subscribe((msg) => handleServerMessage(msg, set, get))

    try {
      await adapters.wallet.connect()
      set({ walletAddress: adapters.wallet.address() })
      await gw.connect() // resolves once authenticated
      set({ status: 'live' })
      void refreshBalance(set)
    } catch (err) {
      // geo-blocked / bad signature / socket error (§9)
      console.error('gateway connect failed:', err)
      set({ status: 'offline' })
    }
  },

  disconnect: () => {
    unsub?.()
    gateway?.disconnect()
    gateway = null
    unsub = null
    adapters = null
    depositedFor = null
    set({
      status: 'offline',
      match: null,
      yourTurn: null,
      sealStatus: 'unsealed',
      yourPrediction: null,
      settlement: null,
      voided: null,
    })
  },

  sealPrediction: async (price) => {
    const { terms, match, sealStatus } = get()
    if (!adapters || !gateway || !terms || !match) return
    if (sealStatus !== 'unsealed') return // seal-once
    set({ sealStatus: 'sealing' })
    try {
      const ciphertext = await adapters.tlock.seal(
        price,
        terms.timelockTargetRound,
        DRAND.chainHash,
        DRAND.api,
      )
      gateway.send({ type: 'sealPrediction', matchId: match.matchId, ciphertext })
      // The plaintext stays on the client for the distance-to-conviction chart.
      set({ sealStatus: 'sealed', yourPrediction: price })
    } catch (err) {
      console.error('seal failed:', err)
      set({ sealStatus: 'unsealed' })
    }
  },

  act: async (action) => {
    const { match, yourTurn } = get()
    if (!adapters || !gateway || !match || !yourTurn) return
    // Each action is a SIGNED intent (replay-safe log, §5).
    const intent = JSON.stringify({ matchId: match.matchId, action })
    const signature = await adapters.wallet.signMessageBase64(intent)
    gateway.send({ type: 'act', matchId: match.matchId, action, signature })
    set({ yourTurn: null }) // optimistic; server's next matchState is authoritative
  },

  setDefault: (def) => {
    const { match } = get()
    set({ defaultAction: def })
    if (gateway && match) gateway.send({ type: 'setDefault', matchId: match.matchId, default: def })
  },

  claim: async () => {
    const { match, settlement } = get()
    if (!adapters || !match) return null
    const sig = await adapters.chain.claim(match.matchId)
    if (IS_DEMO) {
      // Demo accounting: the gateway is the chain authority, so credit the
      // awarded pot to the wallet here. Live mode derives payout on-chain.
      const award = settlement?.awards.find((a) => a.seat === match.yourSeat)?.amount ?? 0
      set((s) => ({ chipBalance: (s.chipBalance ?? 0) + award }))
    } else {
      void refreshBalance(set)
    }
    return sig
  },

  refund: async () => {
    const { match, terms } = get()
    if (!adapters || !match) return null
    const sig = await adapters.chain.refund(match.matchId)
    if (IS_DEMO && terms) {
      // VOID returns buy-in + entry fee in full (§9).
      set((s) => ({ chipBalance: (s.chipBalance ?? 0) + terms.buyIn + terms.entryFee }))
    } else {
      void refreshBalance(set)
    }
    return sig
  },
}))

type SetState = (partial: Partial<GameState> | ((s: GameState) => Partial<GameState>)) => void

function handleServerMessage(
  msg: Parameters<Parameters<Gateway['subscribe']>[0]>[0],
  set: SetState,
  get: () => GameState,
) {
  switch (msg.type) {
    case 'authenticated':
      set({ walletAddress: msg.wallet, status: 'live' })
      break
    case 'tableTerms':
      set({ terms: msg.terms })
      break
    case 'matchState':
      ingestMatchState(msg.state, set, get)
      break
    case 'yourTurn':
      set({ yourTurn: { toCall: msg.toCall, minRaiseTo: msg.minRaiseTo, deadline: msg.deadline } })
      break
    case 'event':
      set((s) => ({ feed: [...s.feed, msg.event].slice(-MAX_FEED) }))
      break
    case 'settled':
      set({ settlement: msg.result, yourTurn: null })
      break
    case 'void':
      set({ voided: { reason: msg.reason }, yourTurn: null })
      break
    case 'error':
      console.error('gateway error:', msg.reason)
      break
    default:
      break // discovery/profile/leaderboard handled by their own surfaces later
  }
}

function ingestMatchState(state: MatchStateView, set: SetState, get: () => GameState) {
  const terms = get().terms
  // Convert the protocol's fixed-point feed price to a float for the chart.
  const decimals = terms?.decimals ?? 2
  const point: PricePoint = { price: state.feedPrice / 10 ** decimals, ts: Date.now() }

  set((s) => ({
    match: state,
    priceHistory: [...s.priceHistory, point].slice(-MAX_HISTORY),
  }))

  // Demo nicety: debit the play-money buy-in once, when we're first seated.
  if (IS_DEMO && depositedFor !== state.matchId && terms && adapters) {
    depositedFor = state.matchId
    void adapters.chain
      .deposit(state.matchId, state.yourSeat ?? 0, terms.buyIn + terms.entryFee)
      .then(() => refreshBalance(set))
  }
}

async function refreshBalance(set: SetState) {
  if (!adapters) return
  try {
    const balance = await adapters.chain.chipBalance()
    set({ chipBalance: balance })
  } catch {
    /* live chain not wired yet — leave balance null */
  }
}
