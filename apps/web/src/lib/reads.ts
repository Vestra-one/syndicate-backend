import type { PublicEvent } from '@/lib/protocol'

/**
 * Your book on each opponent: what you have actually watched them do across this sitting.
 * Nothing here is invented or leaked — it is the same information a player at a card table
 * collects by paying attention, kept so that a bet from a familiar opponent means something.
 */
export interface Read {
  hands: number
  /** hands in which they bet or raised at least once */
  pressed: number
  /** times they had to answer someone else's bet … */
  faced: number
  /** … and how many of those they folded */
  folded: number
  /** showdowns where their call was revealed after they had bet or raised … */
  shown: number
  /** … and the call turned out to be in the worse half of the table */
  shownWeak: number
}

const KEY = 'st-reads'
const SEEN = 'st-reads-seen'
const empty = (): Read => ({ hands: 0, pressed: 0, faced: 0, folded: 0, shown: 0, shownWeak: 0 })

function load(): Record<string, Read> {
  try { return JSON.parse(sessionStorage.getItem(KEY) ?? '{}') as Record<string, Read> } catch { return {} }
}

/** Fold one finished hand into the book. Safe to call again for the same hand. */
export function recordReads(
  matchId: string,
  feed: PublicEvent[],
  walletOf: (seat: number) => string | null | undefined,
  yourSeat: number | null | undefined,
  shown: { seat: number; dist: number; folded: boolean }[],
): void {
  try {
    const seen: string[] = JSON.parse(sessionStorage.getItem(SEEN) ?? '[]')
    if (seen.includes(matchId)) return
    const book = load()
    const hand = new Map<number, { pressed: boolean; faced: number; folded: number }>()
    const at = (seat: number) => {
      let h = hand.get(seat)
      if (!h) { h = { pressed: false, faced: 0, folded: 0 }; hand.set(seat, h) }
      return h
    }
    let bettor: number | null = null
    for (const e of feed) {
      if (e.kind === 'round') { bettor = null; continue }
      if (e.kind !== 'action' && e.kind !== 'fold') continue
      const h = at(e.seat)
      const action = e.kind === 'fold' ? 'fold' : e.action
      const facing = bettor != null && bettor !== e.seat
      if (action === 'betTo' || action === 'raiseTo' || action === 'allIn') {
        if (facing) h.faced++
        h.pressed = true
        bettor = e.seat
      } else if (action === 'call') {
        if (facing) h.faced++
      } else if (action === 'fold') {
        if (facing) { h.faced++; h.folded++ }
      }
    }
    const live = shown.filter((s) => !s.folded).map((s) => s.dist).sort((a, b) => a - b)
    const median = live.length ? live[Math.floor((live.length - 1) / 2)] : null
    for (const [seat, h] of hand) {
      if (seat === yourSeat) continue
      const wallet = walletOf(seat)
      if (!wallet) continue
      const r = book[wallet] ?? empty()
      r.hands++
      if (h.pressed) r.pressed++
      r.faced += h.faced
      r.folded += h.folded
      const s = shown.find((x) => x.seat === seat && !x.folded)
      if (s && h.pressed && median != null && live.length >= 2) {
        r.shown++
        if (s.dist > median) r.shownWeak++
      }
      book[wallet] = r
    }
    sessionStorage.setItem(KEY, JSON.stringify(book))
    sessionStorage.setItem(SEEN, JSON.stringify([...seen, matchId].slice(-60)))
  } catch { /* no storage: no book */ }
}

/** The one line worth knowing about this opponent right now, or null before there is one. */
export function readLine(wallet: string | null | undefined): { label: string; hint: string } | null {
  if (!wallet) return null
  const r = load()[wallet]
  if (!r || r.hands < 2) return null
  const hint = [
    `Your book on this player, ${r.hands} hands:`,
    `bet or raised in ${r.pressed}`,
    r.faced ? `folded to ${r.folded} of ${r.faced} bets` : null,
    r.shown ? `${r.shownWeak} of ${r.shown} shown bets were on a weak call` : null,
  ].filter(Boolean).join(' · ')
  if (r.shown >= 2 && r.shownWeak * 2 >= r.shown) return { label: `Bluffs: ${r.shownWeak} of ${r.shown} shown`, hint }
  if (r.faced >= 3 && r.folded * 3 >= r.faced * 2) return { label: `Folds to bets ${r.folded}/${r.faced}`, hint }
  if (r.faced >= 3 && r.folded * 3 <= r.faced) return { label: `Calls bets ${r.faced - r.folded}/${r.faced}`, hint }
  if (r.pressed * 2 >= r.hands) return { label: `Bets ${r.pressed} of ${r.hands} hands`, hint }
  if (r.pressed === 0) return { label: `Never bet in ${r.hands} hands`, hint }
  if (r.faced >= 2) return { label: `Folds to bets ${r.folded}/${r.faced}`, hint }
  return { label: `Bets ${r.pressed} of ${r.hands} hands`, hint }
}
