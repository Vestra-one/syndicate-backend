/**
 * Timeframe tabs on the price cabinet's chart. Every tab is a trailing-window
 * size over the cabinet's own live tick stream (no external market-data API —
 * round durations here are minutes, not days, so an intraday ladder is what's
 * actually useful). While a round or the pre-match wait is anchored, the axis
 * shows that span instead (see priceBoard.ts) and the tab selection is inert.
 */
export type PriceRange = '1m' | '5m' | '10m' | '15m' | '30m' | '1H'
export const PRICE_RANGES: PriceRange[] = ['1m', '5m', '10m', '15m', '30m', '1H']

export const RANGE_WINDOW_MS: Record<PriceRange, number> = {
  '1m': 60_000,
  '5m': 5 * 60_000,
  '10m': 10 * 60_000,
  '15m': 15 * 60_000,
  '30m': 30 * 60_000,
  '1H': 60 * 60_000,
}
