/**
 * The realtime gateway: the one socket the client speaks to (§1, §3, §5).
 *
 * Transport-agnostic — the store depends only on this interface. `connect()`
 * performs the nonce-challenge auth handshake internally (signing with the
 * Wallet adapter) and resolves once authenticated. After that, gameplay flows
 * as `ServerMessage`s to subscribers and `ClientMessage`s via `send`.
 *
 * Two implementations, chosen by env (see `createGateway`):
 *   - mockGateway: a full play-money match emulator (no backend needed)
 *   - wsGateway:   a real WebSocket to the Satoshi's Table gateway
 */
import type { ClientMessage, ServerMessage } from '@/lib/protocol'
import type { Adapters } from '@/lib/adapters'
import { IS_DEMO } from '@/lib/adapters'
import { createMockGateway } from './mockGateway'
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

/** Pick the mock emulator or a real WS gateway based on env (mirrors adapter selection). */
export function createGateway(adapters: Adapters): Gateway {
  const url = import.meta.env.VITE_GATEWAY_WS_URL as string | undefined
  return IS_DEMO || !url ? createMockGateway(adapters) : createWsGateway(url, adapters)
}
