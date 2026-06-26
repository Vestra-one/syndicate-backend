/**
 * Mock gateway — a self-contained play-money match emulator that speaks the
 * REAL protocol (`ServerMessage` / `ClientMessage`). It exists so the entire UI
 * can be built and demoed before the backend `[contract]` messages land; the
 * live `wsGateway` is a drop-in replacement with zero UI changes.
 *
 * It runs the full lifecycle FILLING -> SEALING -> LIVE(rounds) ->
 * SETTLEMENT_WINDOW -> DECRYPT -> SETTLED, with bot opponents, a single pot, a
 * simplified one-orbit poker betting model, an oracle-style settlement price,
 * and the post-match reveal. You are seat 0; seats 1..3 are bots.
 *
 * The betting model is deliberately simplified (one action per seat per round,
 * no re-raise wars) — enough to exercise turns, exposure, the deadline, the
 * pre-signed default, and settlement. It is NOT the authoritative engine.
 */
import type {
  BettingAction,
  Chips,
  ClientMessage,
  DefaultAction,
  FixedPrice,
  MatchStateView,
  PublicEvent,
  SeatIndex,
  SeatView,
  ServerMessage,
  SettlementView,
  TableTerms,
} from '@/lib/protocol'
import type { Adapters } from '@/lib/adapters'
import type { Gateway, GatewayListener } from './gateway'

const MATCH_ID = 'demo-match-001'
const YOU: SeatIndex = 0
const SEAT_COUNT = 4

const TERMS: TableTerms = {
  tableId: 'demo-table',
  priceFeedId: 'BTC/USD',
  supportedFeeds: ['BTC/USD', 'ETH/USD', 'SOL/USD'],
  chipsToken: 'USDC',
  decimals: 2,
  oracleAdapter: 'pyth',
  settlementMode: 'bounded-exact-after',
  oracleDelayWindowSec: 5,
  oracleUnavailableMessage: 'Oracle unavailable — match will void and refund.',
  buyIn: 1_000,
  entryFee: 20,
  rakeBps: 200, // 2%
  rakeCap: 100,
  smallBlind: 5,
  bigBlind: 10,
  minPlayers: SEAT_COUNT,
  maxPlayers: SEAT_COUNT,
  roundCount: 3,
  roundDurationsSec: [30, 30, 30],
  actionTimerSec: 20,
  timeBankSec: 15,
  settlementWindowSec: 8,
  geofenceBlocklist: ['IN'],
  allowDuplicateWalletPerMatch: false,
  timelockTargetRound: 9_000_000,
}

const PRICE_TICK_MS = 500
const START_PRICE = 64_000

interface Seat extends SeatView {
  prediction: FixedPrice | null
}

export function createMockGateway(adapters: Adapters): Gateway {
  const listeners = new Set<GatewayListener>()
  const timers = new Set<ReturnType<typeof setTimeout>>()
  let priceTimer: ReturnType<typeof setInterval> | null = null
  let live = false
  let started = false // guard against a double connect() (StrictMode)
  let disposed = false

  // ---- match state ----
  let phase: MatchStateView['phase'] = 'FILLING'
  let round = 0
  const buttonSeat: SeatIndex = 0
  let toActSeat: SeatIndex | null = null
  let priceFloat = START_PRICE
  let seats: Seat[] = []
  let currentDefault: DefaultAction = 'check_fold'
  let pendingAct: ((action: BettingAction) => void) | null = null

  const emit = (msg: ServerMessage) => listeners.forEach((l) => l(msg))
  const now = () => Date.now()
  const fixed = (p: number): FixedPrice => Math.round(p * 10 ** TERMS.decimals)
  const feedPrice = () => fixed(priceFloat)

  const delay = (ms: number) =>
    new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        timers.delete(t)
        resolve()
      }, ms)
      timers.add(t)
    })

  // ---- derived helpers ----
  const pot = () => seats.reduce((n, s) => n + s.totalContribution, 0)
  const currentBet = () => seats.reduce((m, s) => Math.max(m, s.committedThisStreet), 0)
  const toCall = (s: Seat) => Math.max(0, currentBet() - s.committedThisStreet)
  const minRaiseTo = () => currentBet() + TERMS.bigBlind
  const activeSeats = () => seats.filter((s) => !s.folded)

  function snapshot(): MatchStateView {
    const me = seats[YOU]
    return {
      matchId: MATCH_ID,
      phase,
      round,
      pot: pot(),
      currentBet: currentBet(),
      buttonSeat,
      toActSeat,
      feedPrice: feedPrice(),
      seats: seats.map((s) => ({
        seat: s.seat,
        wallet: s.seat === YOU ? (adapters.wallet.address() ?? undefined) : undefined,
        stack: s.stack,
        committedThisStreet: s.committedThisStreet,
        totalContribution: s.totalContribution,
        folded: s.folded,
        allIn: s.allIn,
      })),
      yourSeat: YOU,
      yourStack: me?.stack,
      yourExposure: me?.totalContribution,
    }
  }

  const pushState = () => emit({ type: 'matchState', state: snapshot() })
  const pushEvent = (event: PublicEvent) => emit({ type: 'event', event })

  // ---- seat / money mechanics ----
  function newSeat(seat: SeatIndex): Seat {
    return {
      seat,
      stack: TERMS.buyIn,
      committedThisStreet: 0,
      totalContribution: 0,
      folded: false,
      allIn: false,
      prediction: null,
    }
  }

  function commit(s: Seat, amount: Chips) {
    const amt = Math.min(amount, s.stack)
    s.stack -= amt
    s.committedThisStreet += amt
    s.totalContribution += amt
    if (s.stack === 0) s.allIn = true
  }

  /** Apply a legal-ish action, emit the public event. Returns the chip delta committed. */
  function applyAction(s: Seat, action: BettingAction) {
    let committed = 0
    switch (action.type) {
      case 'fold':
        s.folded = true
        pushEvent({ kind: 'fold', matchId: MATCH_ID, seat: s.seat, ts: now() })
        pushState()
        return
      case 'check':
        break
      case 'call': {
        const before = s.committedThisStreet
        commit(s, toCall(s))
        committed = s.committedThisStreet - before
        break
      }
      case 'betTo':
      case 'raiseTo': {
        const before = s.committedThisStreet
        commit(s, action.amount - s.committedThisStreet)
        committed = s.committedThisStreet - before
        break
      }
      case 'allIn': {
        const before = s.committedThisStreet
        commit(s, s.stack)
        committed = s.committedThisStreet - before
        break
      }
    }
    pushEvent({
      kind: 'action',
      matchId: MATCH_ID,
      seat: s.seat,
      action: action.type,
      amount: committed,
      feedPrice: feedPrice(),
      pot: pot(),
      ts: now(),
    })
    pushState()
  }

  // ---- bot decision (intentionally simple) ----
  function botAction(s: Seat): BettingAction {
    const call = toCall(s)
    if (call === 0) {
      return Math.random() < 0.25 ? { type: 'raiseTo', amount: minRaiseTo() } : { type: 'check' }
    }
    if (call >= s.stack) return Math.random() < 0.5 ? { type: 'allIn' } : { type: 'fold' }
    if (call > s.stack * 0.4) return Math.random() < 0.4 ? { type: 'fold' } : { type: 'call' }
    return Math.random() < 0.15 ? { type: 'raiseTo', amount: minRaiseTo() } : { type: 'call' }
  }

  /** Resolve the player's turn: wait for an `act`, or apply the default on timeout. */
  function awaitYourAction(): Promise<BettingAction> {
    emit({
      type: 'yourTurn',
      matchId: MATCH_ID,
      toCall: toCall(seats[YOU]),
      minRaiseTo: minRaiseTo(),
      deadline: now() + TERMS.actionTimerSec * 1000,
    })
    return new Promise<BettingAction>((resolve) => {
      let done = false
      const finish = (a: BettingAction) => {
        if (done) return
        done = true
        pendingAct = null
        clearTimeout(timeout)
        timers.delete(timeout)
        resolve(a)
      }
      pendingAct = finish
      const timeout = setTimeout(() => {
        const call = toCall(seats[YOU])
        const fallback: BettingAction =
          call === 0
            ? { type: 'check' }
            : currentDefault === 'check_call_any'
              ? { type: 'call' }
              : { type: 'fold' }
        finish(fallback)
      }, TERMS.actionTimerSec * 1000)
      timers.add(timeout)
    })
  }

  // ---- one betting round (single orbit, button-relative order) ----
  async function playRound(r: number) {
    round = r
    seats.forEach((s) => (s.committedThisStreet = 0))
    pushEvent({ kind: 'round', matchId: MATCH_ID, round: r, ts: now() })

    if (r === 1) {
      // post blinds
      commit(seats[(buttonSeat + 1) % SEAT_COUNT], TERMS.smallBlind)
      commit(seats[(buttonSeat + 2) % SEAT_COUNT], TERMS.bigBlind)
    }
    pushState()

    const firstToAct = r === 1 ? buttonSeat + 3 : buttonSeat + 1
    for (let i = 0; i < SEAT_COUNT; i++) {
      if (!live) return
      const seat = seats[(firstToAct + i) % SEAT_COUNT]
      if (seat.folded || seat.allIn) continue
      if (activeSeats().length === 1) break // everyone else folded
      toActSeat = seat.seat
      pushState()
      if (seat.seat === YOU) {
        const action = await awaitYourAction()
        applyAction(seat, action)
      } else {
        await delay(700 + Math.random() * 900)
        if (!live) return
        applyAction(seat, botAction(seat))
      }
    }
    toActSeat = null
    pushState()
  }

  // ---- settlement ----
  function settle() {
    phase = 'SETTLEMENT_WINDOW'
    pushState()

    const settlementPrice = feedPrice()
    const contenders = activeSeats().filter((s) => s.prediction != null)
    const winner =
      contenders.length > 0
        ? contenders.reduce((best, s) =>
            Math.abs(s.prediction! - settlementPrice) < Math.abs(best.prediction! - settlementPrice)
              ? s
              : best,
          )
        : activeSeats()[0]

    const grossPot = pot()
    const rake = Math.min(Math.floor((grossPot * TERMS.rakeBps) / 10_000), TERMS.rakeCap)
    const award = grossPot - rake
    const awards = winner ? [{ seat: winner.seat, amount: award }] : []

    const reveal = (s: Seat) => s.prediction ?? settlementPrice

    phase = 'DECRYPT'
    pushState()
    for (const s of seats) {
      pushEvent({
        kind: 'reveal',
        matchId: MATCH_ID,
        seat: s.seat,
        prediction: reveal(s),
        ts: now(),
      })
    }

    phase = 'SETTLED'
    if (winner) winner.stack += award
    pushState()

    const result: SettlementView = {
      matchId: MATCH_ID,
      settlementPrice,
      awards,
      uncalledReturns: [],
      rakeCollected: rake,
      revealedPredictions: seats.map((s) => ({ seat: s.seat, prediction: reveal(s) })),
    }
    pushEvent({ kind: 'settlement', matchId: MATCH_ID, settlementPrice, awards, ts: now() })
    emit({ type: 'settled', result })
  }

  // ---- the match timeline ----
  async function runMatch() {
    // FILLING — seats arrive one by one
    phase = 'FILLING'
    seats = [newSeat(0)]
    pushState()
    for (let i = 1; i < SEAT_COUNT; i++) {
      await delay(600)
      if (!live) return
      seats.push(newSeat(i))
      pushState()
    }

    // dwell in FILLING so the lobby (table terms + deposit) can be read
    await delay(4500)
    if (!live) return
    // SEALING — wait for the player to seal (or time out into a default prediction)
    phase = 'SEALING'
    pushState()
    // bots seal immediately around the current price
    for (let i = 1; i < SEAT_COUNT; i++) {
      seats[i].prediction = fixed(priceFloat * (1 + (Math.random() - 0.5) * 0.04))
    }
    // give the player up to the action timer to seal
    const sealDeadline = now() + TERMS.actionTimerSec * 1000
    while (live && seats[YOU].prediction == null && now() < sealDeadline) {
      await delay(200)
    }
    if (!live) return
    if (seats[YOU].prediction == null) {
      // missed the seal window — default to the current market price
      seats[YOU].prediction = feedPrice()
    }

    // LIVE — N betting rounds
    phase = 'LIVE'
    pushState()
    for (let r = 1; r <= TERMS.roundCount; r++) {
      if (!live) return
      if (activeSeats().length === 1) break
      await playRound(r)
    }
    if (!live) return

    // SETTLEMENT_WINDOW -> DECRYPT -> SETTLED
    await delay(800)
    if (!live) return
    settle()
  }

  function stepPrice() {
    const drift = (START_PRICE - priceFloat) * 0.0006
    const shock = (Math.random() - 0.5) * priceFloat * 0.0015
    priceFloat = Math.max(1, priceFloat + drift + shock)
    if (phase !== 'SETTLED' && phase !== 'VOID') pushState()
  }

  function handleClientMessage(msg: ClientMessage) {
    switch (msg.type) {
      case 'sealPrediction':
        // The ciphertext is opaque to us; in demo we recover the sealed price by
        // trusting the store to also set it via... we can't. So decode the demo
        // tlock placeholder if present, else mark as sealed at current price.
        seats[YOU].prediction = decodeDemoSeal(msg.ciphertext) ?? feedPrice()
        pushState()
        break
      case 'act':
        pendingAct?.(msg.action)
        break
      case 'setDefault':
        currentDefault = msg.default
        break
      case 'subscribe':
      case 'auth':
      case 'ping':
        break
    }
  }

  return {
    async connect() {
      if (started || disposed) return // idempotent; survives StrictMode double-invoke
      started = true
      // Simulated §3 handshake: challenge -> client signs -> authenticated.
      const address = adapters.wallet.address() ?? (await adapters.wallet.connect())
      const nonce = `demo-nonce-${now()}`
      await adapters.wallet.signMessageBase64(nonce)
      if (disposed) return
      live = true
      emit({ type: 'authenticated', wallet: address })
      emit({ type: 'tableTerms', terms: TERMS })
      priceTimer = setInterval(stepPrice, PRICE_TICK_MS)
      void runMatch()
    },
    disconnect() {
      live = false
      disposed = true
      if (priceTimer) clearInterval(priceTimer)
      priceTimer = null
      timers.forEach(clearTimeout)
      timers.clear()
      pendingAct = null
      listeners.clear()
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    send(msg) {
      handleClientMessage(msg)
    },
  }
}

/** Decode the demo tlock placeholder ("demo-tlock:<price>@<round>") back to a price. */
function decodeDemoSeal(ciphertext: string): FixedPrice | null {
  try {
    const decoded = decodeURIComponent(escape(atob(ciphertext)))
    const m = /^demo-tlock:(\d+)@/.exec(decoded)
    return m ? Number(m[1]) : null
  } catch {
    return null
  }
}
