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
