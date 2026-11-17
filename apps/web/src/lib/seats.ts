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
 * A stable "read" on each opponent's style — the behaviour badge under their
 * pod (mirrors the reference's TIGHT / AGGRESSIVE / SAFE / PASSIVE / UNKNOWN).
 * Deterministic from the seat index, so it leaks no identity; you're always the
 * balanced baseline.
 */
export type SeatTagKind = 'tight' | 'aggressive' | 'safe' | 'passive' | 'unknown' | 'balanced' | 'bot'
/** `hint` explains how the read is computed — surfaced as the badge's tooltip. */
export interface SeatTag { label: string; kind: SeatTagKind; hint: string }

/**
 * The five personas (plus the "balanced" self-baseline). A read is derived from
 * a player's observed betting tendencies across the hand — never from identity.
 */
const TAGS: SeatTag[] = [
  { label: 'Tight', kind: 'tight', hint: 'Tight — folds most hands, commits chips only on strong convictions.' },
  { label: 'Aggressive', kind: 'aggressive', hint: 'Aggressive — raises and re-raises often, applies pressure to the table.' },
  { label: 'Safe', kind: 'safe', hint: 'Safe — sizes bets conservatively and rarely risks the whole stack.' },
  { label: 'Passive', kind: 'passive', hint: 'Passive — calls far more than it raises, lets others set the pace.' },
  { label: 'Unknown', kind: 'unknown', hint: 'Unknown — not enough hands observed yet to read this player.' },
]

const BOT_TAG: SeatTag = {
  label: 'House bot',
  kind: 'bot',
  hint: 'House bot — keeps this table open around the clock. Plays by the same rules as you and never sees your sealed call.',
}

export function seatTag(seat: SeatIndex, yourSeat?: SeatIndex, wallet?: string | null): SeatTag {
  if (seat !== yourSeat && isHouseBot(wallet)) return BOT_TAG
  if (seat === yourSeat)
    return { label: 'Balanced', kind: 'balanced', hint: 'Balanced — your baseline read: a mix of calls, raises, and folds.' }
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
