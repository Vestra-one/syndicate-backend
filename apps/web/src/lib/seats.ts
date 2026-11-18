import type { PublicEvent, SeatIndex } from '@/lib/protocol'
import { formatChips } from '@/lib/format'
import { isHouseBot } from '@/lib/houseBots'

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
    let i = nameIndex(s.wallet)
    while (taken.has(ALIASES[i])) i = (i + 1) % ALIASES.length
    taken.add(ALIASES[i])
    next.set(s.seat, ALIASES[i])
  }
  tableNames = next
}

export function seatAlias(seat: SeatIndex, yourSeat?: SeatIndex): string {
  if (seat === yourSeat) return 'You'
  return tableNames.get(seat) ?? ALIASES[seat % ALIASES.length] ?? `Seat ${seat + 1}`
}

/**
 * A stable, characterful host alias for invite links, where no seat index
 * exists yet. Deterministic from the match id — the same table always presents
 * the same inviter name + emblem — and leaks no identity.
 */
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
