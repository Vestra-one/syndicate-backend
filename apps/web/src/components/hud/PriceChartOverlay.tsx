import { useEffect, useRef } from 'react'
import { useGameStore } from '@/store/gameStore'

/**
 * Full-screen BTC/USD analysis screen, launched from the cabinet's brass
 * "CHART" button (see PriceBoardTabs / priceBoard.ts). A real, tradeable-grade
 * chart — same TradingView widget that powers Binance's and Hyperliquid's own
 * embedded charts — so players can study price action, drop indicators, and
 * draw on it before they commit a prediction. Closes on Esc or the × button.
 */
/**
 * Map the table's own feed id (e.g. "BTC/USD") to the TradingView symbol that
 * charts it, and to the pair label we show in the header — so the chart always
 * reflects the market this table settles on, never a hardcoded BTC.
 */
const FEED_TO_TV: Record<string, string> = {
  'BTC/USD': 'BINANCE:BTCUSDT',
  'ETH/USD': 'BINANCE:ETHUSDT',
  'SOL/USD': 'BINANCE:SOLUSDT',
  'BNB/USD': 'BINANCE:BNBUSDT',
  'XRP/USD': 'BINANCE:XRPUSDT',
  'DOGE/USD': 'BINANCE:DOGEUSDT',
}
function tvSymbol(feed: string): string {
  if (FEED_TO_TV[feed]) return FEED_TO_TV[feed]
  // Fall back to BINANCE:<BASE>USDT for any "BASE/QUOTE" feed.
  const base = feed.split('/')[0]?.toUpperCase()
  return base ? `BINANCE:${base}USDT` : 'BINANCE:BTCUSDT'
}

export function PriceChartOverlay() {
  const open = useGameStore((s) => s.priceChartOpen)
  const close = useGameStore((s) => s.closePriceChart)
  const feed = useGameStore((s) => s.terms?.priceFeedId ?? 'BTC/USD')
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, close])

  // Mount the TradingView Advanced Chart widget fresh each time the screen
  // opens — it manages its own iframe lifecycle, so we just hand it an empty
  // container and let it go; tearing down on close avoids it ticking in the
  // background between visits.
  useEffect(() => {
    if (!open) return
    const container = containerRef.current
    if (!container) return
    // Mirrors TradingView's own documented embed markup exactly (outer
    // ".tradingview-widget-container" wrapping the widget div + script) — the
    // widget's loader script walks up from itself expecting that structure.
    const outer = document.createElement('div')
    outer.className = 'tradingview-widget-container'
    outer.style.height = '100%'
    outer.style.width = '100%'
    const widgetDiv = document.createElement('div')
    widgetDiv.className = 'tradingview-widget-container__widget'
    widgetDiv.style.height = '100%'
    widgetDiv.style.width = '100%'
    outer.appendChild(widgetDiv)
    const script = document.createElement('script')
    script.type = 'text/javascript'
    script.src = 'https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js'
    script.async = true
    // Show times in the viewer's own timezone (falls back to UTC if unavailable).
    let timezone = 'Etc/UTC'
    try {
      timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'Etc/UTC'
    } catch { /* keep UTC */ }
    script.innerHTML = JSON.stringify({
      autosize: true,
      symbol: tvSymbol(feed),
      interval: '15',
      timezone,
      theme: 'dark',
      style: '1',
      locale: 'en',
      // Pull the widget toward the room's gold/mahogany identity instead of the
      // stock green/red + blue: warm up-candles, muted down-candles, dark felt bg.
      backgroundColor: 'rgba(20, 14, 10, 0.92)',
      gridColor: 'rgba(233, 162, 59, 0.06)',
      overrides: {
        'mainSeriesProperties.candleStyle.upColor': '#e9a23b',
        'mainSeriesProperties.candleStyle.borderUpColor': '#f2c877',
        'mainSeriesProperties.candleStyle.wickUpColor': '#e9a23b',
        'mainSeriesProperties.candleStyle.downColor': '#7a3b34',
        'mainSeriesProperties.candleStyle.borderDownColor': '#9c4c43',
        'mainSeriesProperties.candleStyle.wickDownColor': '#9c4c43',
        'paneProperties.background': '#140e0a',
        'paneProperties.backgroundType': 'solid',
      },
      hide_top_toolbar: false,
      hide_legend: false,
      withdateranges: true,
      allow_symbol_change: false,
      save_image: false,
      calendar: false,
      support_host: 'https://www.tradingview.com',
    })
    outer.appendChild(script)
    container.appendChild(outer)
    return () => {
      container.innerHTML = ''
    }
  }, [open, feed])

  if (!open) return null

  return (
    <div
      className="price-chart-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close()
      }}
    >
      <div className="price-chart-panel">
        <header className="price-chart-head">
          <div className="price-chart-title">
            {feed.split('/')[0] ?? 'BTC'} <span className="price-chart-title-sep">/</span> {feed.split('/')[1] ?? 'USD'}
          </div>
          <div className="price-chart-sub">Live market — analyse freely, it won't seal your call</div>
          <button className="price-chart-close" onClick={close} aria-label="Close chart">
            ×
          </button>
        </header>
        <div className="price-chart-body" ref={containerRef} />
      </div>
    </div>
  )
}
