import type { PublicEvent, SeatIndex } from '@/lib/protocol'
import { formatChips } from '@/lib/format'
import { isHouseBot } from '@/lib/houseBots'

/**
 * Pseudonymous, seat-indexed aliases. The protocol never exposes opponent
 * wallets (§8) — only the seat index — so we derive a stable, characterful
 * table name from the seat. Deterministic: no identity is leaked.
 *
 * 'You' is intentionally NOT in this list — your own seat resolves via the
 * `yourSeat` check, and every other seat must always read as an opponent
 * (seat indices are engine-assigned, so any seat can be an opponent).
 */
const ALIASES = ['The Banker', 'The Duchess', 'The Cardinal', 'The Stranger', 'The Marquis', 'The Chancellor']

export function seatAlias(seat: SeatIndex, yourSeat?: SeatIndex): string {
  if (seat === yourSeat) return 'You'
  return ALIASES[seat] ?? `Seat ${seat + 1}`
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
