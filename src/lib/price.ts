/**
 * Signed-price feed client (§2, read-only).  Used for:
 *   - the 20-byte `priceTokenHex` a host passes into `create_and_deposit`
 *   - (optionally) a live display ticker
 *
 * Source: GET ${VITE_PRICE_URL}/prices
 * The feed keys symbols WITHOUT a slash ("BTCUSD"); our feed ids use one ("BTC/USD").
 */
const PRICE_URL = (import.meta.env.VITE_DEVNET_USER as string | undefined)
  ? '/price-proxy'
  : (import.meta.env.VITE_PRICE_URL as string | undefined)

export interface SignedPrice {
  token: string // 20-byte ERC-20 address, hex 0x…
  symbol: string // e.g. "BTCUSD"
  price: string
  price_in_wad: string
  timestamp: number
  v: number
  r: string
  s: string
}

/** "BTC/USD" → "BTCUSD" (the feed's symbol key). */
export function toFeedSymbol(feedId: string): string {
  return feedId.replace('/', '').toUpperCase()
}

let cache: { at: number; prices: SignedPrice[] } | null = null
const TTL_MS = 5_000

async function fetchPrices(): Promise<SignedPrice[]> {
  if (!PRICE_URL) throw new Error('VITE_PRICE_URL is not set — configure the price feed URL')
  if (cache && Date.now() - cache.at < TTL_MS) return cache.prices
  const res = await fetch(`${PRICE_URL}/prices`, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(8_000),
  })
  if (!res.ok) throw new Error(`/prices ${res.status}`)
  const data = (await res.json()) as { prices: SignedPrice[] }
  cache = { at: Date.now(), prices: data.prices ?? [] }
  return cache.prices
}

/** Resolve the 20-byte price token (hex 0x…) for a feed id like "BTC/USD". */
export async function priceTokenFor(feedId: string): Promise<string> {
  const want = toFeedSymbol(feedId)
  const prices = await fetchPrices()
  const hit = prices.find((p) => p.symbol.toUpperCase() === want)
  if (!hit) throw new Error(`no signed-price token for ${feedId} (${want})`)
  return hit.token
}

/** Latest display price for a feed id, as a float (convenience for the chart/seed). */
export async function latestPriceFor(feedId: string): Promise<number | null> {
  try {
    const prices = await fetchPrices()
    const hit = prices.find((p) => p.symbol.toUpperCase() === toFeedSymbol(feedId))
    return hit ? Number(hit.price) : null
  } catch {
    return null
  }
}
