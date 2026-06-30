/**
 * The realtime gateway: the one socket the client speaks to (§1, §3, §5).
 *
 * Transport-agnostic — the store depends only on this interface. `connect()`
 * performs the nonce-challenge auth handshake internally (signing with the
 * Wallet adapter) and resolves once authenticated. After that, gameplay flows
 * as `ServerMessage`s to subscribers and `ClientMessage`s via `send`.
 *
 * A real WebSocket to the Satoshi's Table gateway (no mock/demo transport).
 */
import type { ClientMessage, ServerMessage } from '@/lib/protocol'
import type { Adapters } from '@/lib/adapters'
import { createWsGateway } from './wsGateway'

export type GatewayListener = (msg: ServerMessage) => void

export interface Gateway {
  /** Connect + authenticate (§3). Resolves once authenticated; rejects on auth/geo error. */
  connect(): Promise<void>
  disconnect(): void
  subscribe(listener: GatewayListener): () => void
  /** Send a post-auth client message (act / sealPrediction / setDefault / subscribe). */
  send(msg: ClientMessage): void
}

/** Open a real WebSocket gateway. Requires VITE_GATEWAY_WS_URL. */
export function createGateway(adapters: Adapters): Gateway {
  const url = import.meta.env.VITE_GATEWAY_WS_URL as string | undefined
  if (!url) {
    throw new Error('VITE_GATEWAY_WS_URL is not set — configure the gateway URL in .env')
  }
  return createWsGateway(url, adapters)
}
