import { useCallback } from 'react'
import { useGameStore } from '@/store/gameStore'
import { useAnchor } from '@/lib/useAnchor'
import { projectPriceTab, projectPriceChartButton } from '@/three/table/tableView'
import { PRICE_RANGES, type PriceRange } from '@/lib/priceRanges'

/**
 * Clickable hit-targets over the price cabinet's timeframe tab row, drawn on
 * the canvas texture itself (see priceBoard.ts) — this overlay is invisible,
 * just real buttons pinned to each tab's projected world position so the
 * cabinet stays the single source of visual truth for the tab row's look.
 */
export function PriceBoardTabs() {
  return (
    <div className="pb-tabs" aria-hidden={false}>
      {PRICE_RANGES.map((range) => (
        <PriceBoardTab key={range} range={range} />
      ))}
      <PriceBoardChartButton />
    </div>
  )
}

function PriceBoardTab({ range }: { range: PriceRange }) {
  const active = useGameStore((s) => s.priceBoardRange === range)
  const setRange = useGameStore((s) => s.setPriceBoardRange)
  const ref = useAnchor<HTMLButtonElement>(useCallback(() => projectPriceTab(range), [range]))
  return (
    <button
      ref={ref}
      type="button"
      className="pb-tab"
      style={{ opacity: 0 }}
      aria-pressed={active}
      aria-label={`Show ${range} range`}
      onClick={() => setRange(range)}
    />
  )
}

/**
 * Invisible hit-target over the cabinet's raised brass "CHART" button (see
 * priceBoard.ts) — opens the full-screen BTC/USD analysis view on top of the
 * table (PriceChartOverlay).
 */
function PriceBoardChartButton() {
  const openPriceChart = useGameStore((s) => s.openPriceChart)
  const ref = useAnchor<HTMLButtonElement>(useCallback(() => projectPriceChartButton(), []))
  return (
    <button
      ref={ref}
      type="button"
      className="pb-chart-btn"
      style={{ opacity: 0 }}
      aria-label="Open full chart"
      onClick={() => openPriceChart()}
    />
  )
}
