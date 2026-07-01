/**
 * Table invite deep-links (§4). A created table isn't discoverable by others
 * until matchmaking is deployed, so the host has to hand out a link — this is
 * the mechanism. The link carries the gateway match id; opening it lands the
 * invitee on the join Lobby for that table.
 */
const PARAM = 'table'

/** Absolute, shareable URL for a table, e.g. https://app…/?table=<matchId> */
export function buildInviteUrl(matchId: string): string {
  const url = new URL(window.location.origin + window.location.pathname)
  url.searchParams.set(PARAM, matchId)
  return url.toString()
}

/**
 * Read the `?table=<id>` deep-link and strip it from the address bar (so a
 * refresh or share of the current URL doesn't re-trigger the join). Returns the
 * id, or null when absent.
 */
export function consumeInviteParam(): string | null {
  const params = new URLSearchParams(window.location.search)
  const id = params.get(PARAM)
  if (!id) return null
  const url = new URL(window.location.href)
  url.searchParams.delete(PARAM)
  window.history.replaceState({}, '', url.toString())
  return id
}
