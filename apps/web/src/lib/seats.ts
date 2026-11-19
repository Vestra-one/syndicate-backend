import type { PublicEvent, SeatIndex } from '@/lib/protocol'
import { formatChips } from '@/lib/format'
import { houseBotWallets, isHouseBot } from '@/lib/houseBots'

/**
 * Pseudonymous table names. A name follows the player's wallet, so the same rival reads as
 * the same name hand after hand — that is what lets a rivalry build — while the wallet
 * itself is never shown. Two players who would share a name at one table get the next one.
 *
 * 'You' is intentionally NOT in this list — your own seat resolves via `yourSeat`.
 */
const ALIASES = [
  'The Banker', 'The Duchess', 'The Cardinal', 'The Stranger', 'The Marquis', 'The Chancellor',
  'The Admiral', 'The Countess', 'The Magistrate', 'The Envoy', 'The Baron', 'The Abbess',
  'The Captain', 'The Viscount', 'The Oracle', 'The Consul', 'The Regent', 'The Courier',
  'The Jeweller', 'The Advocate', 'The Navigator', 'The Governess', 'The Alchemist', 'The Warden',
]

/** seat → alias for the table on screen (rebuilt whenever the seats change). */
let tableNames = new Map<number, string>()

function nameIndex(wallet: string): number {
  let h = 0
  for (let i = 0; i < wallet.length; i++) h = (h * 31 + wallet.charCodeAt(i)) >>> 0
  return h % ALIASES.length
}

export function setSeatWallets(seats: { seat: number; wallet?: string | null }[]): void {
  const next = new Map<number, string>()
  const taken = new Set<string>()
  for (const s of [...seats].sort((x, y) => x.seat - y.seat)) {
    if (!s.wallet) continue
    let i = canonicalIndex(s.wallet)
    while (taken.has(ALIASES[i])) i = (i + 1) % ALIASES.length
    taken.add(ALIASES[i])
    next.set(s.seat, ALIASES[i])
  }
  tableNames = next
}

export function seatAlias(seat: SeatIndex, yourSeat?: SeatIndex): string {
  if (seat === yourSeat) return 'You'
  // No wallet known for the seat yet (a table still filling): a neutral label, never a
  // persona that would turn into someone else once the hand is dealt.
  return tableNames.get(seat) ?? `Player ${seat + 1}`
}

/**
 * A stable, characterful host alias for invite links, where no seat index
 * exists yet. Deterministic from the match id — the same table always presents
 * the same inviter name + emblem — and leaks no identity.
 */
/**
 * The one name a player goes by, everywhere: the table, the lobby, the boards, past hands.
 * House bots always wear their table alias (never an internal handle); a person is the
 * handle they chose, or their alias until they choose one.
 */
/** The connected player's own wallet and chosen handle — theirs wins everywhere, at once. */
let self: { wallet: string; handle: string | null } | null = null
export function setSelfName(wallet: string | null, handle: string | null): void {
  self = wallet ? { wallet, handle } : null
}

export function displayName(wallet: string, handle?: string | null): string {
  if (self && wallet === self.wallet && self.handle) return self.handle
  if (handle && !isHouseBot(wallet)) return handle
  return ALIASES[canonicalIndex(wallet)]
}

/**
 * A wallet's alias, the same on every screen. Bots claim theirs first (in a fixed order,
 * stepping past each other), and a person whose alias would duplicate a bot's steps to the
 * next free one — so there is never a second "The Banker" at the table or on a board.
 */
function canonicalIndex(wallet: string): number {
  const bots = houseBotWallets().sort()
  const taken = new Set<number>()
  for (const b of bots) {
    let i = nameIndex(b)
    while (taken.has(i)) i = (i + 1) % ALIASES.length
    taken.add(i)
    if (b === wallet) return i
  }
  let i = nameIndex(wallet)
  while (taken.has(i)) i = (i + 1) % ALIASES.length
  return i
}

export function hostAlias(matchId: string): string {
  let h = 0
  for (let i = 0; i < matchId.length; i++) h = (Math.imul(h, 31) + matchId.charCodeAt(i)) >>> 0
  return ALIASES[h % ALIASES.length]
}

/**
 * The badge under each pod. It is a read of what that seat has actually done in this
 * hand — nothing is invented, and before anyone has acted there is no read.
 */
export type SeatTagKind = 'tight' | 'aggressive' | 'safe' | 'passive' | 'unknown' | 'balanced' | 'bot'
/** `hint` says what the badge is based on — surfaced as its tooltip. */
export interface SeatTag { label: string; kind: SeatTagKind; hint: string }

const BOT_TAG: SeatTag = {
  label: 'House bot',
  kind: 'bot',
  hint: 'House bot — keeps this table open around the clock. Plays by the same rules as you and never sees your sealed call.',
}
const YOU_TAG: SeatTag = { label: 'You', kind: 'balanced', hint: 'Your seat.' }
const NO_READ: SeatTag = { label: 'No read yet', kind: 'unknown', hint: 'No bets from this seat yet in this hand.' }

export function seatTag(
  seat: SeatIndex,
  yourSeat?: SeatIndex,
  wallet?: string | null,
  feed?: PublicEvent[],
): SeatTag {
  if (seat === yourSeat) return YOU_TAG
  if (isHouseBot(wallet)) return BOT_TAG
  let pressed = 0
  let called = 0
  let checked = 0
  for (const e of feed ?? []) {
    if (e.kind !== 'action' || e.seat !== seat) continue
    if (e.action === 'betTo' || e.action === 'raiseTo' || e.action === 'allIn') pressed++
    else if (e.action === 'call') called++
    else if (e.action === 'check') checked++
  }
  if (pressed >= 2) return { label: 'Pressing', kind: 'aggressive', hint: `Bet or raised ${pressed} times this hand.` }
  if (pressed === 1) return { label: 'Bet once', kind: 'safe', hint: 'Bet or raised once this hand.' }
  if (called >= 1) return { label: 'Calling', kind: 'passive', hint: `Called ${called} time${called === 1 ? '' : 's'} this hand without raising.` }
  if (checked >= 1) return { label: 'Checking', kind: 'tight', hint: 'Has only checked this hand.' }
  return NO_READ
}

/** Human-readable line for the action feed. Amounts arrive in token base units. */
export function describeEvent(e: PublicEvent, yourSeat?: SeatIndex, token = ''): string {
  const who = 'seat' in e ? seatAlias(e.seat, yourSeat) : ''
  const you = who === 'You' // second-person conjugation ("You call", not "You calls")
  switch (e.kind) {
    case 'action': {
      const amt = e.amount > 0 ? ` ${formatChips(e.amount)}${token ? ` ${token}` : ''}` : ''
      const s = you ? '' : 's'
      const verb: Record<string, string> = {
        check: `check${s}`,
        timeout: you ? 'ran out of time' : 'ran out of time',
        call: `call${s}${amt}`,
        betTo: `bet${s}${amt}`,
        raiseTo: `raise${s}${amt}`,
        allIn: `${you ? 'are' : 'is'} all-in${amt}`,
        fold: `fold${s}`,
      }
      return `${who} ${verb[e.action] ?? e.action}`
    }
    case 'fold':
      return `${who} fold${you ? '' : 's'}`
    case 'round':
      return `— Round ${e.round} —`
    case 'settlement':
      return `Settlement locked`
    case 'reveal':
      return you ? 'Your prediction opens' : `${who}'s prediction opens`
  }
}
