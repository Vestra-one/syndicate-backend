/**
 * Real WebSocket gateway. Implements the §3 nonce-challenge auth handshake
 * (this part of the protocol is [live] today) and then forwards gameplay
 * messages verbatim. Game-message shapes are [contract] and may still firm up.
 */
import type { ServerMessage } from '@/lib/protocol'
import type { Adapters } from '@/lib/adapters'
import type { Gateway, GatewayListener } from './gateway'

export function createWsGateway(url: string, adapters: Adapters): Gateway {
  const listeners = new Set<GatewayListener>()
  let ws: WebSocket | null = null

  const emit = (msg: ServerMessage) => listeners.forEach((l) => l(msg))

  return {
    connect() {
      return new Promise<void>((resolve, reject) => {
        const sock = new WebSocket(url)
        ws = sock
        sock.onmessage = async (raw) => {
          const msg = JSON.parse(raw.data) as ServerMessage
          switch (msg.type) {
            case 'challenge': {
              // ed25519 sign of the raw nonce string, base64 (§3).
              const address = adapters.wallet.address() ?? (await adapters.wallet.connect())
              const signature = await adapters.wallet.signMessageBase64(msg.nonce)
              sock.send(JSON.stringify({ type: 'auth', wallet: address, signature }))
              break
            }
            case 'authenticated':
              resolve()
              emit(msg)
              break
            case 'error':
              // geo-blocked / bad signature / nonce expired / wallet mismatch (§9)
              reject(new Error(msg.reason))
              emit(msg)
              break
            default:
              emit(msg) // gameplay / feed / discovery, after auth
          }
        }
        sock.onerror = () => reject(new Error('socket error'))
        // If the socket drops after auth (no in-flight connect() promise to reject),
        // null it out so isOpen() correctly reports the session as dead.
        sock.onclose = () => { if (ws === sock) ws = null }
      })
    },
    disconnect() {
      ws?.close()
      ws = null
      listeners.clear()
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    send(msg) {
      ws?.send(JSON.stringify(msg))
    },
    isOpen() {
      return ws?.readyState === WebSocket.OPEN
    },
  }
}
