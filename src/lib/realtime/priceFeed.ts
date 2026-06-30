/**
 * Always-on signed-price ticker (§2, read-only) for the price-cabinet chart.
 *
 * Connects to the price service WS (`?symbols=BTCUSD`) and streams spot ticks.
 * This keeps the 3D cabinet chart alive on the lobby/idle screens — independent
 * of any match. Once a match goes live, the gateway's authoritative feedPrice
 * takes over (see gameStore.ingestLivePrice's match guard).
 *
 * Auto-reconnects with a short backoff; silently no-ops if no WS URL is set.
 */
const WS_URL = import.meta.env.VITE_PRICE_WS_URL as string | undefined

export interface PriceFeedHandle {
  stop: () => void
}

interface PriceTick {
  type?: string
  symbol?: string
  price?: string | number
  timestamp?: number
}

/** Stream ticks for one symbol (e.g. "BTCUSD"); `onTick` gets a float price. */
export function startPriceFeed(
  symbol: string,
  onTick: (price: number, ts: number) => void,
): PriceFeedHandle {
  if (!WS_URL) return { stop: () => {} }

  let ws: WebSocket | null = null
  let stopped = false
  let retry: ReturnType<typeof setTimeout> | null = null
  const want = symbol.toUpperCase()

  const connect = () => {
    if (stopped) return
    ws = new WebSocket(`${WS_URL}?symbols=${encodeURIComponent(symbol)}`)

    ws.onmessage = (e) => {
      try {
        const m = JSON.parse(e.data as string) as PriceTick
        if (m.type === 'connected' || m.price == null) return
        if ((m.symbol ?? '').toUpperCase() !== want) return
        const price = Number(m.price)
        if (Number.isFinite(price)) onTick(price, Date.now())
      } catch {
        /* ignore malformed frames */
      }
    }
    // Reconnect on drop; the server also closes idle sockets.
    ws.onclose = () => {
      if (!stopped) retry = setTimeout(connect, 2_000)
    }
    ws.onerror = () => ws?.close()
  }

  connect()

  return {
    stop: () => {
      stopped = true
      if (retry) clearTimeout(retry)
      ws?.close()
      ws = null
    },
  }
}
