/**
 * The realtime gateway: the one socket the client speaks to (§9, §12).
 *
 * Transport-agnostic — the store depends only on this interface. `connect()` opens the
 * socket and (if a wallet is connected) answers the auth challenge; it resolves once the
 * socket is open (spectating needs no auth). After that, `subscribe` receives v2
 * `ServerFrame`s and `send` posts v2 `ClientFrame`s.
 */
import type { Adapters } from '@/lib/adapters'
import type { ClientFrame, ServerFrame } from './wsTypes'
import { createWsGateway } from './wsGateway'

export type GatewayListener = (frame: ServerFrame) => void

export interface Gateway {
  /** Open the socket; answers the nonce challenge if a wallet is connected. Resolves on open. */
  connect(): Promise<void>
  disconnect(): void
  subscribe(listener: GatewayListener): () => void
  /** Send a v2 client frame (subscribe / act / seal / set_default / ping). */
  send(frame: ClientFrame): void
  /** True if the underlying socket is open — lets callers reuse a live session. */
  isOpen(): boolean
}

/** Open a real v2 WebSocket gateway. Requires VITE_WS_URL (or the dev WS proxy). */
export function createGateway(adapters: Adapters): Gateway {
  // The `/ws-proxy` path only exists in the Vite dev server — gate it on import.meta.env.DEV
  // so production builds always use the direct VITE_WS_URL (never the nonexistent proxy).
  const devUser = import.meta.env.DEV ? (import.meta.env.VITE_DEVNET_USER as string | undefined) : undefined
  // In local dev with Basic Auth, use the Vite WS proxy so the auth header is injected
  // server-side (the browser WebSocket API cannot set Authorization headers directly).
  const url = devUser
    ? `${window.location.origin.replace(/^http/, 'ws')}/ws-proxy`
    : (import.meta.env.VITE_WS_URL as string | undefined)
  if (!url) {
    throw new Error('VITE_WS_URL is not set — configure the v2 WebSocket URL in .env')
  }
  return createWsGateway(url, adapters)
}
