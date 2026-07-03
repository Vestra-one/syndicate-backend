import { useEffect, useRef } from 'react'
import { useGameStore } from '@/store/gameStore'

/**
 * Full-screen BTC/USD analysis screen, launched from the cabinet's brass
 * "CHART" button (see PriceBoardTabs / priceBoard.ts). A real, tradeable-grade
 * chart — same TradingView widget that powers Binance's and Hyperliquid's own
 * embedded charts — so players can study price action, drop indicators, and
 * draw on it before they commit a prediction. Closes on Esc or the × button.
 */
export function PriceChartOverlay() {
  const open = useGameStore((s) => s.priceChartOpen)
  const close = useGameStore((s) => s.closePriceChart)
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
    script.innerHTML = JSON.stringify({
      autosize: true,
      symbol: 'BINANCE:BTCUSDT',
      interval: '15',
      timezone: 'Etc/UTC',
      theme: 'dark',
      style: '1',
      locale: 'en',
      hide_top_toolbar: false,
      hide_legend: false,
      withdateranges: true,
      allow_symbol_change: true,
      save_image: false,
      calendar: false,
      support_host: 'https://www.tradingview.com',
    })
    outer.appendChild(script)
    container.appendChild(outer)
    return () => {
      container.innerHTML = ''
    }
  }, [open])

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
            BTC <span className="price-chart-title-sep">/</span> USD
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
