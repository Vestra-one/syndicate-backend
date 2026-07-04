/**
 * Table invite deep-links (§4). A created table isn't discoverable by others
 * until matchmaking is deployed, so the host has to hand out a link — this is
 * the mechanism. The link carries the gateway match id; opening it lands the
 * invitee on the join Lobby for that table.
 */
const PARAM = 'table'
const FROM = 'from'

/**
 * Absolute, shareable URL for a table, e.g. https://app…/?table=<matchId>.
 * An optional `from` alias lets the invitee's banner name the inviter
 * ("The Duchess invited you") — a pseudonymous table alias, never a wallet.
 */
export function buildInviteUrl(matchId: string, from?: string): string {
  const url = new URL(window.location.origin + window.location.pathname)
  url.searchParams.set(PARAM, matchId)
  if (from) url.searchParams.set(FROM, from)
  return url.toString()
}

export interface InviteParam {
  matchId: string
  /** The sharer's pseudonymous alias, if the link carried one. */
  inviter: string | null
}

/**
 * Read the `?table=<id>&from=<alias>` deep-link and strip it from the address
 * bar (so a refresh or share of the current URL doesn't re-trigger the join).
 * Returns the invite, or null when absent.
 */
export function consumeInviteParam(): InviteParam | null {
  const params = new URLSearchParams(window.location.search)
  const id = params.get(PARAM)
  if (!id) return null
  const inviter = params.get(FROM)
  const url = new URL(window.location.href)
  url.searchParams.delete(PARAM)
  url.searchParams.delete(FROM)
  window.history.replaceState({}, '', url.toString())
  return { matchId: id, inviter }
}
