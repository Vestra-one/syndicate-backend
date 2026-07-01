import { create } from 'zustand'
import type {
  BettingAction,
  DashboardSortKey,
  DefaultAction,
  FixedPrice,
  LiveGame,
  MatchStateView,
  PublicEvent,
  RoomListing,
  SettlementView,
  TableTerms,
  UpcomingGame,
  VoidReason,
} from '@/lib/protocol'
import { DRAND, PAST_FILLING_PHASES } from '@/lib/protocol'
import type { ConnectionStatus, PricePoint } from '@/lib/ui'
import { createAdapters, type Adapters } from '@/lib/adapters'
import { newOnchainMatchId } from '@/lib/adapters/live'
import { createGateway, type Gateway } from '@/lib/realtime/gateway'
import { fetchActiveGames, fetchUpcomingGames } from '@/lib/discovery'
import {
  pickTemplate,
  templateToCreateParams,
  templateToTerms,
  type ConfigTemplate,
} from '@/lib/config'
import { priceTokenFor } from '@/lib/price'
import { reportCreate, reportDeposit } from '@/lib/matchmaking'

/** Resolved Play Now action: join an existing open table, or create a new one. */
export type PlayMode = 'join' | 'create'

/**
 * A live on-chain commit (create-and-deposit or join-deposit), tracked stage-by-stage
 * so the waiting UI narrates the real transaction lifecycle instead of a blind spinner.
 *  preparing  → building the ix + simulating (before the wallet prompt)
 *  signing    → the wallet approval prompt is up; we're waiting on the user
 *  confirming → broadcast; waiting for Solana to finalize (the long wait)
 *  confirmed  → finalized on-chain; the seat is real
 *  error      → simulation/send/confirm failed (message in `error`)
 */
export type TxStageName = 'preparing' | 'signing' | 'confirming' | 'confirmed' | 'error'
export type TxCommit = {
  kind: PlayMode
  stage: TxStageName
  amount: number // total committed, token base units
  chipsToken: string
  feed?: string
  seats?: string // e.g. "2/6" at commit time
  sig?: string
  error?: string
}

const MAX_HISTORY = 240 // ~2 min at 500ms snapshots — enough for the board chart
const MAX_FEED = 40 // recent public events kept for the action feed

/** One-way latch for the prediction (§6, seal-once). */
export type SealStatus = 'unsealed' | 'sealing' | 'sealed'

/** Which top-level surface the app is showing. */
export type AppView = 'discovery' | 'table'

/** Discovery feed load state — distinguishes "empty" from "still loading" from "failed". */
export type DiscoveryStatus = 'idle' | 'loading' | 'ready' | 'error'

interface GameState {
  view: AppView
  activeGames: LiveGame[]
  upcomingGames: UpcomingGame[]
  discoveryStatus: DiscoveryStatus
  dashboardSort: DashboardSortKey

  status: ConnectionStatus
  walletAddress: string | null
  chipBalance: number | null

  terms: TableTerms | null
  match: MatchStateView | null
  yourTurn: { toCall: number; minRaiseTo: number; deadline: number } | null
  /** Epoch-ms the fill window closes (room voids if under min). Drives the waiting-room countdown. */
  fillDeadline: number | null
  /** Epoch-ms the current round began — anchors the price-board chart's x-axis to the round. */
  roundStartedAt: number | null

  // self-centric, derived from the feed
  sealStatus: SealStatus
  yourPrediction: FixedPrice | null // plaintext, client-only — never sent in the clear
  defaultAction: DefaultAction

  priceHistory: PricePoint[]
  feed: PublicEvent[]

  settlement: SettlementView | null
  voided: { reason: VoidReason } | null
  reviewing: boolean // resolution dismissed to inspect the final table
  seated: boolean // deposit confirmed → seat taken (gates the lobby)

  // Play Now matchmaking
  rooms: RoomListing[] // open tables discovered over the gateway lobby
  playResolving: boolean // true while deciding join-vs-create
  playMode: PlayMode | null // resolved action for the current lobby card
  playError: string | null // resolution / commit failure surfaced to the user
  lobbySeated: number | null // seats already taken in the room being joined (from the lobby listing)
  lastTx: { sig: string; label: string } | null // most recent on-chain tx (banner + explorer link)
  txProgress: TxCommit | null // live commit tx being narrated by the waiting ceremony
  pendingInvite: string | null // matchId from a ?table=… deep-link, awaiting the user's accept

  // actions
  fetchBalance: () => Promise<void>
  loadDiscovery: () => Promise<void>
  ingestLivePrice: (price: number, ts: number) => void
  setDashboardSort: (key: DashboardSortKey) => void
  enterTable: (matchId: string) => Promise<void>
  leaveToDiscovery: () => void
  backToDashboard: () => void
  connect: () => Promise<void>
  disconnect: () => void
  joinGame: (matchId: string) => Promise<void>
  createGame: () => Promise<void>
  dismissInvite: () => void
  joinTable: () => Promise<void>
  createTable: () => Promise<void>
  dismissTxProgress: () => void
  sealPrediction: (price: FixedPrice) => Promise<void>
  act: (action: BettingAction) => Promise<void>
  setDefault: (def: DefaultAction) => void
  claim: () => Promise<string | null>
  refund: () => Promise<string | null>
  setReviewing: (v: boolean) => void
  playAgain: () => Promise<void>
}

let adapters: Adapters | null = null
let gateway: Gateway | null = null
let unsub: (() => void) | null = null

/** The room we resolved to JOIN via Play Now (so joinTable knows the on-chain ids). */
let joinRoom: RoomListing | null = null
/** The template + derived ids we resolved to CREATE via Play Now. */
let createCtx: { tmpl: ConfigTemplate; priceTokenHex: string; onchainMatchId: string } | null = null

/**
 * Turn a raw deposit error into a user-facing message. `simulateSignAndSend` throws
 * `Error(<AnchorErrorCode>)` for program errors, or an Error with the raw message
 * otherwise — surface something actionable instead of "see console".
 */
function depositErrorMessage(err: unknown, kind: PlayMode = 'join'): string {
  const msg = err instanceof Error ? err.message : String(err)
  // Anchor / SPL / system-program cases we can phrase better than the raw code.
  if (/User rejected|rejected the request|denied|declined|cancell?ed/i.test(msg)) {
    return 'You cancelled the transaction in your wallet.'
  }
  if (/already in use|SeatAlreadyExists|AlreadySeated/i.test(msg)) {
    return 'You already have a seat at this table.'
  }
  if (/MatchFull|SeatTaken|TableFull/i.test(msg)) return 'This table just filled up — pick another.'
  if (/DepositsClosed|MatchStarted|NotFilling/i.test(msg)) return 'This table already started — deposits are closed.'
  if (/insufficient|0x1\b|InsufficientFunds/i.test(msg)) {
    return 'Insufficient balance — you need enough USDC (buy-in + entry fee) plus SOL for fees.'
  }
  if (/block height exceeded|blockhash|expired|timed out/i.test(msg)) {
    return 'The network dropped the transaction (RPC congestion). Try again.'
  }
  // Unmatched program/simulation errors can be a wall of logs — keep the card readable.
  const verb = kind === 'create' ? 'open the table' : 'take your seat'
  return `Couldn't ${verb} — the transaction was rejected on-chain. Check your balance and try again.`
}

/**
 * The action-feed's `/upcoming-games` (used by the Dashboard row list) only carries the
 * off-chain matchId/buyIn/seats — it omits `onchainMatchId`/`tierId`, which only the
 * gateway's lobby snapshot has. joinTable needs onchainMatchId to derive the deposit PDA,
 * so resolve the full RoomListing over the socket before showing the join Lobby.
 */
/**
 * Reuse an already-authenticated gateway when one is live — avoids re-running the
 * wallet-signed nonce challenge (§3) on every createGame/joinGame call. Only tears
 * down and reconnects (which re-signs) when there's no live session to reuse.
 */
async function ensureAuthedGateway(adapters: Adapters, set: SetState, get: () => GameState): Promise<boolean> {
  if (gateway?.isOpen() && get().status === 'live') return true
  if (gateway) { unsub?.(); gateway.disconnect(); gateway = null; unsub = null }
  const gw = createGateway(adapters)
  gateway = gw
  unsub = gw.subscribe((msg) => handleServerMessage(msg, set, get))
  try {
    await gw.connect() // resolves once authenticated (wallet signs the nonce)
    set({ status: 'live' })
    void refreshBalance(set)
    return true
  } catch {
    set({ status: 'offline' })
    return false
  }
}

function resolveRoomListing(gw: Gateway, matchId: string, timeoutMs = 5000): Promise<RoomListing | null> {
  return new Promise((resolve) => {
    let done = false
    const finish = (room: RoomListing | null) => {
      if (done) return
      done = true
      clearTimeout(timer)
      unsubscribe()
      resolve(room)
    }
    const unsubscribe = gw.subscribe((msg) => {
      if (msg.type === 'lobbyList') {
        const hit = msg.rooms.find((r) => r.matchId === matchId)
        if (hit) finish(hit)
      }
    })
    const timer = setTimeout(() => finish(null), timeoutMs)
    gw.send({ type: 'subscribeLobby' })
  })
}

export const useGameStore = create<GameState>((set, get) => ({
  view: 'discovery',
  activeGames: [],
  upcomingGames: [],
  discoveryStatus: 'idle',
  dashboardSort: 'gameTime',

  status: 'offline',
  walletAddress: null,
  chipBalance: null,

  terms: null,
  match: null,
  yourTurn: null,
  fillDeadline: null,
  roundStartedAt: null,

  sealStatus: 'unsealed',
  yourPrediction: null,
  defaultAction: 'check_fold',

  priceHistory: [],
  feed: [],

  settlement: null,
  voided: null,
  reviewing: false,
  seated: false,

  rooms: [],
  playResolving: false,
  playMode: null,
  playError: null,
  lobbySeated: null,
  lastTx: null,
  txProgress: null,
  pendingInvite: null,

  fetchBalance: async () => {
    if (!adapters) adapters = createAdapters()
    // Explicit user/post-tx refresh — always hit the chain, never coalesce away.
    await refreshBalance(set, true)
  },

  loadDiscovery: async () => {
    set({ discoveryStatus: 'loading' })
    const [activeResult, upcomingResult] = await Promise.allSettled([
      fetchActiveGames(),
      fetchUpcomingGames(),
    ])
    const active = activeResult.status === 'fulfilled' ? activeResult.value : []
    const upcoming = upcomingResult.status === 'fulfilled' ? upcomingResult.value : []
    if (activeResult.status === 'rejected') console.warn('active-games fetch failed:', activeResult.reason)
    if (upcomingResult.status === 'rejected') console.warn('upcoming-games fetch failed:', upcomingResult.reason)
    // Only show error if BOTH endpoints fail
    if (activeResult.status === 'rejected' && upcomingResult.status === 'rejected') {
      set({ activeGames: [], upcomingGames: [], discoveryStatus: 'error' })
    } else {
      set({ activeGames: active, upcomingGames: upcoming, discoveryStatus: 'ready' })
    }
  },

  /**
   * Push a spot tick from the always-on price feed into the chart history (§2).
   * During an active match the gateway's feedPrice is authoritative, so we only
   * feed the chart from spot ticks pre-match (no match, or still FILLING).
   */
  ingestLivePrice: (price, ts) => {
    const m = get().match
    if (m && PAST_FILLING_PHASES.includes(m.phase)) return
    set((s) => ({ priceHistory: [...s.priceHistory, { price, ts }].slice(-MAX_HISTORY) }))
  },

  setDashboardSort: (key) => set({ dashboardSort: key }),

  /** Pick a table from the dashboard → connect to it and show the table view. */
  enterTable: async (_matchId) => {
    set({ view: 'table' })
    await get().connect()
  },

  /** Leave the current table and return to the live-games dashboard. */
  leaveToDiscovery: () => {
    get().disconnect()
    set({ view: 'discovery' })
    void get().loadDiscovery()
  },

  /**
   * Back out of the current create/join Lobby (pre-seat) to the dashboard. Unlike
   * `leaveToDiscovery`, this deliberately leaves the gateway connected — severing it
   * would force a fresh (wallet-signed) auth handshake on the next create/join, which
   * is the "double sign" this button exists to avoid users working around via refresh.
   */
  backToDashboard: () => {
    joinRoom = null
    createCtx = null
    set({
      view: 'discovery',
      playMode: null,
      playResolving: false,
      playError: null,
      terms: null,
      match: null,
      lobbySeated: null,
      fillDeadline: null,
      roundStartedAt: null,
    })
    void get().loadDiscovery()
  },

  /** Join an upcoming (FILLING) game by matchId — connect wallet + gateway, then show deposit Lobby. */
  joinGame: async (matchId: string) => {
    if (!adapters) adapters = createAdapters()
    joinRoom = null
    createCtx = null
    set({ playError: null, pendingInvite: null })

    try {
      const addr = await adapters.wallet.connect()
      set({ walletAddress: addr })
    } catch {
      set({ playError: 'Wallet connection was cancelled.' })
      return
    }

    set({ view: 'table', status: 'connecting', playResolving: true, playMode: null, match: null, terms: null, seated: false, lobbySeated: null })
    if (!(await ensureAuthedGateway(adapters, set, get))) {
      set({ playResolving: false, playError: 'Could not reach the table server.' })
      return
    }

    // Subscribe to match — live seat/board updates once we're seated.
    gateway!.send({ type: 'subscribe', matchId })

    // Resolve the room's onchainMatchId/tierId over the lobby socket (the REST
    // discovery feed doesn't carry them), then build terms from its config template.
    const room = await resolveRoomListing(gateway!, matchId)
    if (!room) {
      set({ playResolving: false, playError: 'That table just filled up or closed — pick another.' })
      return
    }
    joinRoom = room
    try {
      const tmpl = await pickTemplate(room.feedId, room.tierId)
      const base = templateToTerms(tmpl)
      set({
        terms: {
          ...base,
          buyIn: room.buyIn ?? base.buyIn,
          maxPlayers: room.maxPlayers || base.maxPlayers,
          minPlayers: room.minPlayers || base.minPlayers,
          onchainMatchId: room.onchainMatchId,
        },
        lobbySeated: room.seated,
        playMode: 'join',
        playResolving: false,
        fillDeadline: room.fillDeadline ? toEpochMs(room.fillDeadline) : null,
      })
    } catch {
      set({ playResolving: false, playError: 'Could not load table config.' })
    }
  },

  /** Create a new game — connect wallet + gateway, load config, then show create Lobby. */
  createGame: async () => {
    if (!adapters) adapters = createAdapters()
    joinRoom = null
    createCtx = null
    set({ playError: null })

    try {
      const addr = await adapters.wallet.connect()
      set({ walletAddress: addr })
    } catch {
      set({ playError: 'Wallet connection was cancelled.' })
      return
    }

    set({ view: 'table', status: 'connecting', playResolving: true, playMode: null, match: null, terms: null, seated: false, lobbySeated: null })
    if (!(await ensureAuthedGateway(adapters, set, get))) {
      set({ playResolving: false, playError: 'Could not reach the table server.' })
      return
    }

    try {
      const tmpl = await pickTemplate('BTC/USD')
      const priceTokenHex = await priceTokenFor(tmpl.config.priceFeedId)
      const onchainMatchId = newOnchainMatchId()
      createCtx = { tmpl, priceTokenHex, onchainMatchId }
      set({ terms: { ...templateToTerms(tmpl), onchainMatchId }, playMode: 'create', playResolving: false })
    } catch {
      set({ playResolving: false, playMode: null, playError: 'Could not load table config.' })
    }
  },

  connect: async () => {
    if (gateway) return
    set({ status: 'connecting' })
    if (!adapters) adapters = createAdapters()
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
    joinRoom = null
    createCtx = null
    set({
      status: 'offline',
      match: null,
      yourTurn: null,
      sealStatus: 'unsealed',
      yourPrediction: null,
      settlement: null,
      voided: null,
      seated: false,
      rooms: [],
      playMode: null,
      playResolving: false,
      playError: null,
      lobbySeated: null,
      fillDeadline: null,
    })
  },

  /** Take your seat: deposit buy-in + entry fee into an OPEN table (§7). */
  joinTable: async () => {
    const { match, terms, seated } = get()
    if (!adapters || !terms || seated) return

    // matchId/onchainMatchId/seat come from the resolved room, else the live match.
    const matchId = joinRoom?.matchId ?? match?.matchId
    const onchainMatchId = joinRoom?.onchainMatchId ?? terms.onchainMatchId
    const seatIndex = joinRoom?.seated ?? match?.yourSeat ?? 0
    if (!matchId || !onchainMatchId) {
      set({ playError: 'Table is still loading — try again in a moment.' })
      return
    }

    // Ensure the adapter can read onchainMatchId off terms for PDA derivation.
    if (!terms.onchainMatchId) set({ terms: { ...terms, onchainMatchId } })

    // Guard: a wallet can hold only one seat per match. Re-depositing reverts on-chain
    // ("account already in use"), so if the seat already exists just take it — the deposit
    // already happened on a prior attempt.
    try {
      const existing = await adapters.chain.getMySeat(onchainMatchId)
      if (existing && existing.deposit > 0) {
        console.log('[joinTable] wallet already seated (seat', existing.seatIndex, ') — entering table')
        set({ seated: true })
        void refreshBalance(set)
        return
      }
    } catch (err) {
      // A read failure here isn't fatal — fall through to the deposit attempt.
      console.warn('[joinTable] seat pre-check failed:', err)
    }

    const commit: TxCommit = {
      kind: 'join',
      stage: 'preparing',
      amount: terms.buyIn + terms.entryFee,
      chipsToken: terms.chipsToken,
      feed: terms.priceFeedId,
      seats: `${Math.max(match?.seats.length ?? 0, get().lobbySeated ?? 0)}/${terms.maxPlayers}`,
    }
    set({ seated: true, txProgress: commit }) // optimistic; revert on failure
    try {
      const txSig = await adapters.chain.deposit(matchId, seatIndex, terms.buyIn + terms.entryFee, (stage) =>
        set((s) => (s.txProgress ? { txProgress: { ...s.txProgress, stage } } : {})),
      )
      set((s) => ({
        lastTx: { sig: txSig, label: 'Deposit confirmed on-chain' },
        txProgress: s.txProgress ? { ...s.txProgress, stage: 'confirmed', sig: txSig } : null,
      }))
      // Best-effort registry report (capital safety never depends on it, §7).
      reportDeposit(matchId, {
        depositTxSig: txSig,
        wallet: adapters.wallet.address() ?? '',
        seatIndex,
      }).then((r) => {
        if (r.ok) console.log('[reportDeposit] deposit registered — seat:', r.seat ?? seatIndex)
        else console.warn('[reportDeposit] failed:', r.reason)
      }).catch((e) => console.warn('[reportDeposit] error:', e))
      void refreshBalance(set)
    } catch (err) {
      console.error('deposit failed:', err)
      const msg = depositErrorMessage(err)
      set((s) => ({
        seated: false,
        playError: msg,
        txProgress: s.txProgress ? { ...s.txProgress, stage: 'error', error: msg } : null,
      }))
    }
  },

  /** Host create: open a new table on-chain and seat yourself (§7). */
  createTable: async () => {
    const { seated, terms } = get()
    if (!adapters || !createCtx || seated) return
    const { tmpl, priceTokenHex, onchainMatchId } = createCtx
    const p = templateToCreateParams(tmpl)
    const commit: TxCommit = {
      kind: 'create',
      stage: 'preparing',
      amount: p.buyIn + p.entryFee,
      chipsToken: terms?.chipsToken ?? 'USDC',
      feed: terms?.priceFeedId,
      seats: terms ? `1/${terms.maxPlayers}` : undefined,
    }
    set({ seated: true, txProgress: commit }) // optimistic
    try {
      const { txSig, matchPda } = await adapters.chain.createAndDeposit({
        onchainMatchId,
        configHash: p.configHash,
        priceTokenHex,
        seatIndex: 0,
        buyIn: p.buyIn,
        entryFee: p.entryFee,
        rakeBps: p.rakeBps,
        rakeCap: p.rakeCap,
        nonsealPenaltyBps: p.nonsealPenaltyBps,
        minPlayers: p.minPlayers,
        maxPlayers: p.maxPlayers,
        totalBettingDurationSec: p.totalBettingDurationSec,
        sealWindowSec: p.sealWindowSec,
        beginLiveWindowSec: p.beginLiveWindowSec,
        fillWindowSec: p.fillWindowSec,
        decimals: p.decimals,
      }, (stage) => set((s) => (s.txProgress ? { txProgress: { ...s.txProgress, stage } } : {})))
      // Record the on-chain ids so subsequent ix (seal/claim) derive the right PDAs.
      set((s) => ({
        terms: s.terms ? { ...s.terms, onchainMatchId, matchPda } : s.terms,
        lastTx: { sig: txSig, label: 'Table created on-chain' },
        txProgress: s.txProgress ? { ...s.txProgress, stage: 'confirmed', sig: txSig } : null,
        fillDeadline: Date.now() + p.fillWindowSec * 1000,
      }))
      // Best-effort registry report so others can discover the room.
      reportCreate({
        createTxSig: txSig,
        matchPda,
        onchainMatchId,
        configHash: p.configHash,
        wallet: adapters.wallet.address() ?? '',
        seatIndex: 0,
        maxPlayers: p.maxPlayers,
      }).then((r) => {
        if (r.ok) console.log('[reportCreate] room registered — roomCode:', r.roomCode, 'fillDeadline:', r.fillDeadline)
        else console.warn('[reportCreate] failed:', r.reason)
      }).catch((e) => console.warn('[reportCreate] error:', e))
      // Subscribe to our new match for gameplay pushes.
      gateway?.send({ type: 'subscribe', matchId: matchPda })
      void refreshBalance(set)
    } catch (err) {
      console.error('create failed:', err)
      const msg = depositErrorMessage(err, 'create')
      set((s) => ({
        seated: false,
        playError: msg,
        txProgress: s.txProgress ? { ...s.txProgress, stage: 'error', error: msg } : null,
      }))
    }
  },

  dismissTxProgress: () => set({ txProgress: null }),

  dismissInvite: () => set({ pendingInvite: null }),

  sealPrediction: async (price) => {
    const { terms, match, sealStatus } = get()
    if (!adapters || !gateway || !terms || !match) return
    if (sealStatus !== 'unsealed') return // seal-once
    set({ sealStatus: 'sealing' })
    try {
      const targetRound = terms.timelockTargetRound
      const ciphertext = await adapters.tlock.seal(price, targetRound, DRAND.chainHash, DRAND.api)
      const seatIndex = match.yourSeat ?? 0
      // Commitment and blinding are placeholder-generated here; tlock-js integration (§6)
      // will produce the real H(prediction||blinding) + 32-byte blinding factor.
      const randHex = () => Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, '0')).join('')
      const blindingHex = randHex()
      const commitmentHex = randHex() // TODO: replace with H(price_i128_le || blinding)
      const signature = await adapters.wallet.signMessageBase64(`${match.matchId}:${commitmentHex}`)
      gateway.send({
        type: 'sealPrediction',
        matchId: match.matchId,
        seatIndex,
        ciphertext,
        commitmentHex,
        targetRound,
        blindingHex,
        signature,
      })
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
    const { match } = get()
    if (!adapters || !match) return null
    const sig = await adapters.chain.claim(match.matchId)
    set({ lastTx: { sig, label: 'Payout claimed on-chain' } })
    // Payout is derived on-chain; re-read the SPL balance after finality (force past the throttle).
    void refreshBalance(set, true)
    return sig
  },

  refund: async () => {
    const { match } = get()
    if (!adapters || !match) return null
    const sig = await adapters.chain.refund(match.matchId)
    set({ lastTx: { sig, label: 'Refund confirmed on-chain' } })
    void refreshBalance(set, true)
    return sig
  },

  setReviewing: (v) => set({ reviewing: v }),

  /** Leave the finished match and matchmake into a fresh one — no page refresh.
   * Keeps the wallet/chain so the balance carries over; re-runs Play Now. */
  playAgain: async () => {
    set({
      match: null,
      yourTurn: null,
      sealStatus: 'unsealed',
      yourPrediction: null,
      settlement: null,
      voided: null,
      reviewing: false,
      seated: false,
      feed: [],
      priceHistory: [],
      fillDeadline: null,
      roundStartedAt: null,
    })
    await get().createGame()
  },
}))

/** On-chain deadlines are unix seconds; the UI counts down in epoch-ms. Pass through values already in ms. */
function toEpochMs(deadline: number): number {
  return deadline > 1e12 ? deadline : deadline * 1000
}

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
      // Merge: keep any on-chain ids we already resolved (create path) if the
      // gateway's terms omit them.
      set((s) => ({
        terms: {
          ...msg.terms,
          onchainMatchId: msg.terms.onchainMatchId ?? s.terms?.onchainMatchId,
          matchPda: msg.terms.matchPda ?? s.terms?.matchPda,
        },
      }))
      break
    case 'matchState':
      ingestMatchState(msg.state, set, get)
      break
    case 'yourTurn':
      set({ yourTurn: { toCall: msg.toCall, minRaiseTo: msg.minRaiseTo, deadline: msg.yourTurnDeadline ?? Date.now() + 30_000 } })
      break
    case 'event':
      set((s) => ({ feed: [...s.feed, msg.event].slice(-MAX_FEED) }))
      break
    case 'lobbyList':
      // Full snapshot of open rooms.
      set({ rooms: msg.rooms })
      break
    case 'roomsUpdated':
      // Incremental upsert; a 'started' room is no longer joinable → drop it.
      set((s) => ({ rooms: applyRoomsUpdate(s.rooms, msg.update) }))
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
      break // queueStatus/profile/leaderboard handled by their own surfaces later
  }
}

/** Apply an incremental roomsUpdated to the open-rooms list. */
function applyRoomsUpdate(
  rooms: RoomListing[],
  u: import('@/lib/protocol').RoomsUpdate,
): RoomListing[] {
  if (u.kind === 'started') return rooms.filter((r) => r.matchId !== u.matchId)
  const existing = rooms.find((r) => r.matchId === u.matchId)
  const merged: RoomListing = {
    roomCode: u.roomCode ?? existing?.roomCode ?? '',
    matchId: u.matchId,
    onchainMatchId: existing?.onchainMatchId,
    feedId: u.feedId ?? existing?.feedId ?? '',
    tierId: u.tierId ?? existing?.tierId ?? '',
    configHash: u.configHash ?? existing?.configHash,
    buyIn: u.buyIn ?? existing?.buyIn,
    seated: u.seated,
    minPlayers: existing?.minPlayers ?? 0,
    maxPlayers: u.maxPlayers ?? existing?.maxPlayers ?? 0,
    fillDeadline: u.fillDeadline ?? existing?.fillDeadline ?? 0,
  }
  return [...rooms.filter((r) => r.matchId !== u.matchId), merged]
}



function ingestMatchState(state: MatchStateView, set: SetState, get: () => GameState) {
  const terms = get().terms
  // Convert the protocol's fixed-point feed price to a float for the chart.
  const decimals = terms?.decimals ?? 2
  const point: PricePoint = { price: state.feedPrice / 10 ** decimals, ts: Date.now() }
  const now = Date.now()
  // A new round (or the match's first LIVE state) restarts the price-board's
  // x-axis — the client-observed instant is close enough for a chart axis.
  const prevRound = get().match?.round
  const isNewRound = prevRound == null || state.round !== prevRound

  set((s) => ({
    match: state,
    priceHistory: [...s.priceHistory, point].slice(-MAX_HISTORY),
    roundStartedAt: isNewRound ? now : s.roundStartedAt,
  }))
  // No auto-deposit — real custody always requires the explicit lobby deposit (§7).
}

// The public devnet RPC (api.devnet.solana.com) rate-limits aggressively; refreshBalance
// gets called from several places in quick succession (wallet connect, gateway connect,
// post-deposit). Coalesce overlapping calls and skip redundant ones within a short window
// so we don't pile on duplicate getTokenAccountBalance requests.
let balanceInFlight: Promise<void> | null = null
let lastBalanceFetchAt = 0
const BALANCE_MIN_INTERVAL_MS = 2500

async function refreshBalance(set: SetState, force = false) {
  if (!adapters) return
  if (balanceInFlight) return balanceInFlight
  // Post-transaction refreshes (claim/refund/reclaim) must bypass the rate-limit
  // coalescing, or the balance can stay stale right after the balance actually moved.
  if (!force && Date.now() - lastBalanceFetchAt < BALANCE_MIN_INTERVAL_MS) return
  balanceInFlight = (async () => {
    try {
      const balance = await adapters!.chain.chipBalance()
      set({ chipBalance: balance })
    } catch {
      /* live chain not wired yet — leave balance null */
    } finally {
      lastBalanceFetchAt = Date.now()
      balanceInFlight = null
    }
  })()
  return balanceInFlight
}
