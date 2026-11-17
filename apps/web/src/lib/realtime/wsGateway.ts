/**
 * v2 WebSocket transport (`wss://…/v1/ws`). Server frames are `{ v, t, server_time_ms, … }`;
 * client frames are `{ t, … }`. Auth is the in-band `challenge → auth → authenticated`
 * handshake (§2) — spectating needs none, so `connect()` resolves as soon as the socket is
 * open and only signs a challenge if the wallet is connected. Heartbeats: `ping`/`pong` @30s.
 */
import type { Adapters } from '@/lib/adapters'
import type { Gateway, GatewayListener } from './gateway'
import type { ClientFrame, ServerFrame } from './wsTypes'
import { log } from '@/lib/log'
import { adoptSession, clearSession, sessionTokenFor } from '@/lib/api'

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
        log.error('[ws] listener threw:', err)
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

        // The challenge nonce is kept so a rejected session-token auth can fall back to a
        // wallet signature over the same nonce (the server leaves it valid).
        let pendingNonce: string | null = null
        let triedSession = false

        const authBySignature = async (address: string, nonce: string) => {
          try {
            const signature = await adapters.wallet.signMessageBase64(nonce)
            if (sock.readyState === WebSocket.OPEN) {
              sock.send(JSON.stringify({ t: 'auth', wallet: address, signature } satisfies ClientFrame))
            }
          } catch (err) {
            log.warn('[ws] auth sign failed:', err)
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
              pendingNonce = frame.nonce
              // Already signed in over REST (or reconnecting mid-hand)? Present that session —
              // no wallet prompt. A dropped socket during a live turn must never need the
              // player to approve a signature before they can act again.
              const token = sessionTokenFor(address)
              if (token && !triedSession) {
                triedSession = true
                sock.send(JSON.stringify({ t: 'auth', wallet: address, session: token } satisfies ClientFrame))
              } else {
                await authBySignature(address, frame.nonce)
              }
              break
            }
            case 'authenticated':
              pendingNonce = null
              // A signature auth mints a session — reuse it for REST (one prompt covers both).
              if (frame.session && frame.expires_at) adoptSession(frame.wallet, frame.session, frame.expires_at)
              emit(frame)
              break
            case 'error': {
              // Session token rejected: `bad_session` (stale token) or — on a server that
              // predates session auth — `bad_frame`. Fall back to signing the nonce.
              const address = adapters.wallet.address()
              if (pendingNonce && triedSession && address && (frame.code === 'bad_session' || frame.code === 'bad_frame')) {
                const nonce = pendingNonce
                pendingNonce = null
                if (frame.code === 'bad_session') clearSession()
                await authBySignature(address, nonce)
                break
              }
              // Surface but don't tear down — most errors are per-subscription (lagged, not_found).
              emit(frame)
              break
            }
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
