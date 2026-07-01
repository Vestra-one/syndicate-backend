import type { PublicEvent, SeatIndex } from '@/lib/protocol'

/**
 * Pseudonymous, seat-indexed aliases. The protocol never exposes opponent
 * wallets (§8) — only the seat index — so we derive a stable, characterful
 * table name from the seat. Deterministic: no identity is leaked.
 */
const ALIASES = ['You', 'The Banker', 'The Duchess', 'The Cardinal', 'The Stranger', 'The Marquis']

export function seatAlias(seat: SeatIndex, yourSeat?: SeatIndex): string {
  if (seat === yourSeat) return 'You'
  return ALIASES[seat] ?? `Seat ${seat}`
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

/** Human-readable line for the action feed. */
export function describeEvent(e: PublicEvent, yourSeat?: SeatIndex): string {
  const who = 'seat' in e ? seatAlias(e.seat, yourSeat) : ''
  switch (e.kind) {
    case 'action': {
      const amt = e.amount > 0 ? ` ${e.amount}` : ''
      const verb: Record<string, string> = {
        check: 'checks',
        call: `calls${amt}`,
        betTo: `bets${amt}`,
        raiseTo: `raises${amt}`,
        allIn: `is all-in${amt}`,
        fold: 'folds',
      }
      return `${who} ${verb[e.action] ?? e.action}`
    }
    case 'fold':
      return `${who} folds`
    case 'round':
      return `— Round ${e.round} —`
    case 'settlement':
      return `Settlement locked`
    case 'reveal':
      return `${who}'s prediction opens`
  }
}
