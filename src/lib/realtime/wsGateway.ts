/**
 * v2 WebSocket transport (`wss://…/v1/ws`). Server frames are `{ v, t, server_time_ms, … }`;
 * client frames are `{ t, … }`. Auth is the in-band `challenge → auth → authenticated`
 * handshake (§2) — spectating needs none, so `connect()` resolves as soon as the socket is
 * open and only signs a challenge if the wallet is connected. Heartbeats: `ping`/`pong` @30s.
 */
import type { Adapters } from '@/lib/adapters'
import type { Gateway, GatewayListener } from './gateway'
import type { ClientFrame, ServerFrame } from './wsTypes'

const HEARTBEAT_MS = 30_000
const CONNECT_TIMEOUT_MS = 12_000

export function createWsGateway(url: string, adapters: Adapters): Gateway {
  const listeners = new Set<GatewayListener>()
  let ws: WebSocket | null = null
  let heartbeat: ReturnType<typeof setInterval> | null = null

  // A throwing listener must not swallow the frame for the others (and this runs inside an
  // async onmessage, so an uncaught throw becomes an unhandled rejection).
  const emit = (frame: ServerFrame) => {
    for (const l of listeners) {
      try {
        l(frame)
      } catch (err) {
        console.error('[ws] listener threw:', err)
      }
    }
  }

  const stopHeartbeat = () => {
    if (heartbeat) {
      clearInterval(heartbeat)
      heartbeat = null
    }
  }

  return {
    connect() {
      // Idempotent: tear down any prior socket + heartbeat so a re-connect can't orphan an
      // open socket (whose ping interval would then run forever, unreachable by stopHeartbeat).
      stopHeartbeat()
      if (ws) {
        try { ws.close() } catch { /* already closing */ }
        ws = null
      }
      return new Promise<void>((resolve, reject) => {
        let settled = false
        const sock = new WebSocket(url)
        ws = sock

        // Never leave connect() pending: a socket stuck in CONNECTING that fires neither
        // open/error/close would otherwise hang the store on status:'connecting' forever.
        const timer = setTimeout(() => {
          if (!settled) {
            settled = true
            try { sock.close() } catch { /* noop */ }
            reject(new Error('ws connect timed out'))
          }
        }, CONNECT_TIMEOUT_MS)

        sock.onopen = () => {
          clearTimeout(timer)
          heartbeat = setInterval(() => {
            if (sock.readyState === WebSocket.OPEN) sock.send(JSON.stringify({ t: 'ping' } satisfies ClientFrame))
          }, HEARTBEAT_MS)
          // Spectating needs no auth — the socket is usable now. If the server issues a
          // `challenge` we answer it below; if we're never challenged, we still resolve.
          if (!settled) {
            settled = true
            resolve()
          }
        }

        sock.onmessage = async (raw) => {
          let frame: ServerFrame
          try {
            frame = JSON.parse(raw.data) as ServerFrame
          } catch {
            return // ignore non-JSON
          }
          switch (frame.t) {
            case 'challenge': {
              // Answer the nonce challenge if a wallet is available (players); spectators skip.
              const address = adapters.wallet.address()
              if (!address) break
              try {
                const signature = await adapters.wallet.signMessageBase64(frame.nonce)
                sock.send(JSON.stringify({ t: 'auth', wallet: address, signature } satisfies ClientFrame))
              } catch (err) {
                console.warn('[ws] auth sign failed:', err)
              }
              break
            }
            case 'error':
              // Surface but don't tear down — most errors are per-subscription (lagged, not_found).
              emit(frame)
              break
            default:
              emit(frame)
          }
        }

        sock.onerror = () => {
          clearTimeout(timer)
          if (!settled) {
            settled = true
            reject(new Error('socket error'))
          }
        }
        sock.onclose = () => {
          clearTimeout(timer)
          stopHeartbeat()
          if (ws === sock) ws = null
          // A socket that goes CONNECTING → close WITHOUT an error event (server refuses the
          // upgrade, or disconnect() races the connect) fires only here — reject so the awaiter
          // isn't left hanging forever.
          if (!settled) {
            settled = true
            reject(new Error('socket closed before open'))
          }
        }
      })
    },
    disconnect() {
      stopHeartbeat()
      ws?.close()
      ws = null
      listeners.clear()
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    send(frame: ClientFrame) {
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(frame))
    },
    isOpen() {
      return ws?.readyState === WebSocket.OPEN
    },
  }
}
