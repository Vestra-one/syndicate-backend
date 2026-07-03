import type { PublicEvent, SeatIndex } from '@/lib/protocol'
import { formatChips } from '@/lib/format'

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
 * A stable "read" on each opponent's style — the behaviour badge under their
 * pod (mirrors the reference's TIGHT / AGGRESSIVE / SAFE / PASSIVE / UNKNOWN).
 * Deterministic from the seat index, so it leaks no identity; you're always the
 * balanced baseline.
 */
export type SeatTagKind = 'tight' | 'aggressive' | 'safe' | 'passive' | 'unknown' | 'balanced'
export interface SeatTag { label: string; kind: SeatTagKind }

const TAGS: SeatTag[] = [
  { label: 'Tight player', kind: 'tight' },
  { label: 'Aggressive', kind: 'aggressive' },
  { label: 'Safe player', kind: 'safe' },
  { label: 'Passive', kind: 'passive' },
  { label: 'Unknown', kind: 'unknown' },
]

export function seatTag(seat: SeatIndex, yourSeat?: SeatIndex): SeatTag {
  if (seat === yourSeat) return { label: 'Balanced player', kind: 'balanced' }
  return TAGS[seat % TAGS.length]
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
