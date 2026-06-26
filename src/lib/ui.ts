/**
 * UI-only types — display concepts that are NOT part of the wire protocol.
 * Wire types live in `@/lib/protocol`.
 */

/** A single point on the price chart. `price` is a plain float for rendering
 * (derived from the protocol's fixed-point `feedPrice` via the feed decimals). */
export interface PricePoint {
  price: number
  /** epoch ms */
  ts: number
}

/** Connection lifecycle of the gateway socket, for the connection indicator. */
export type ConnectionStatus = 'connecting' | 'live' | 'reconnecting' | 'offline'
