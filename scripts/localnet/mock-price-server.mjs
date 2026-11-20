#!/usr/bin/env node
// Offline stand-in for services/signed-price-server (LOCALNET ONLY).
//
// Serves the same wire surface the backend + frontend consume — GET /prices, GET /prices/at,
// GET /health, WS /ws — but the price is a deterministic synthetic walk instead of a live
// exchange book. Payloads are signed exactly like the Go server: EIP-191 over
// keccak256(token(20) ‖ priceInWad(32, BE) ‖ timestampMs(32, BE)), so the on-chain
// `verify_signed_price` accepts them once this key's address is the protocol price signer.
//
//   ECDSA_PRIVATE_KEY=<hex> PORT=18088 node mock-price-server.mjs
//   node mock-price-server.mjs --address      # print the signer's Ethereum address
import http from 'node:http'
import { secp256k1 } from '@noble/curves/secp256k1'
import { keccak_256 } from '@noble/hashes/sha3'
import { WebSocketServer } from 'ws'

const KEY_HEX = (process.env.ECDSA_PRIVATE_KEY ?? '').replace(/^0x/, '').trim()
if (!/^[0-9a-fA-F]{64}$/.test(KEY_HEX)) {
  console.error('ECDSA_PRIVATE_KEY must be a 32-byte hex secp256k1 secret')
  process.exit(1)
}
const PRIV = Uint8Array.from(Buffer.from(KEY_HEX, 'hex'))
const PUB = secp256k1.getPublicKey(PRIV, false) // 65 bytes, 0x04 ‖ X ‖ Y
const ADDRESS = '0x' + Buffer.from(keccak_256(PUB.slice(1)).slice(12)).toString('hex')

if (process.argv.includes('--address')) {
  console.log(ADDRESS)
  process.exit(0)
}

// Same symbols + oracle tokens as services/game-server/src/config.rs FEEDS.
const FEEDS = {
  BTCUSD: { token: '0xa7BaE7da3E4950700BE9f107EB186e89a474d180', base: 64000, amp: 180 },
  ETHUSD: { token: '0x6Dd0C6a2e058bc3F7D6AaCe23965180BcBbb2635', base: 3100, amp: 14 },
  SOLUSD: { token: '0xD31a59c85aE9D8edEFeC411D448f90841571b89c', base: 150, amp: 1.2 },
}

function lattice(symbol, i, salt) {
  let h = 2166136261 ^ salt
  for (const c of symbol) h = Math.imul(h ^ c.charCodeAt(0), 16777619)
  h = Math.imul(h ^ (i | 0), 16777619)
  h ^= h >>> 13; h = Math.imul(h, 0x5bd1e995); h ^= h >>> 15
  return ((h >>> 0) / 4294967295) * 2 - 1
}
/** Smooth noise in [-1, 1]: hashed values at whole steps, eased between them. */
function noise(symbol, x, salt) {
  const i = Math.floor(x)
  const f = x - i
  const u = f * f * (3 - 2 * f)
  const a = lattice(symbol, i, salt * 1000 | 0)
  const b = lattice(symbol, i + 1, salt * 1000 | 0)
  return a + (b - a) * u
}

/** Deterministic price (integer cents) for a symbol at a millisecond timestamp. */
function centsAt(symbol, tsMs) {
  const f = FEEDS[symbol]
  const t = tsMs / 1000
  // A market-like wander rather than a sine wave: layered smooth noise, sized so a
  // two-minute move is typically about 0.1% of the price (what the live feeds do), with
  // the occasional larger run. Still a pure function of time, so any past second can be
  // looked up again.
  let walk = 0
  for (const [period, weight] of [[600, 0.8], [150, 0.45], [40, 0.25], [10, 0.12], [2.5, 0.05]]) {
    walk += noise(symbol, t / period, period) * weight
  }
  return Math.round((f.base + walk * f.amp) * 100)
}

function be32(v) {
  return Buffer.from(v.toString(16).padStart(64, '0'), 'hex')
}

function signedPrice(symbol, tsMs) {
  const f = FEEDS[symbol]
  const cents = BigInt(centsAt(symbol, tsMs))
  const wad = cents * 10n ** 16n // cents → 1e18 fixed point
  const msgHash = keccak_256(Buffer.concat([Buffer.from(f.token.slice(2), 'hex'), be32(wad), be32(BigInt(tsMs))]))
  const ethHash = keccak_256(Buffer.concat([Buffer.from('\x19Ethereum Signed Message:\n32', 'binary'), msgHash]))
  const sig = secp256k1.sign(ethHash, PRIV, { lowS: true })
  const whole = cents / 100n
  const frac = (cents % 100n).toString().padStart(2, '0')
  return {
    token: f.token,
    symbol,
    price: `${whole}.${frac}`,
    price_in_wad: wad.toString(),
    quantity: '0',
    timestamp: tsMs,
    trade_id: Math.floor(tsMs / 1000),
    exchange: 'localnet-mock',
    v: sig.recovery + 27,
    r: '0x' + sig.r.toString(16).padStart(64, '0'),
    s: '0x' + sig.s.toString(16).padStart(64, '0'),
    public_key: '0x' + Buffer.from(PUB).toString('hex'),
    signed_at: Date.now(),
  }
}

const json = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json', 'access-control-allow-origin': '*' })
  res.end(JSON.stringify(body))
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost')
  if (url.pathname === '/health') {
    return json(res, 200, { ok: true, status: 'ok', book_mid_ok: true, mock: true, signer: ADDRESS })
  }
  if (url.pathname === '/prices') {
    const want = (url.searchParams.get('symbols') ?? '').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean)
    const symbols = want.length ? want.filter((s) => FEEDS[s]) : Object.keys(FEEDS)
    const now = Date.now()
    return json(res, 200, { prices: symbols.map((s) => signedPrice(s, now)), count: symbols.length })
  }
  if (url.pathname === '/prices/at') {
    const symbol = (url.searchParams.get('symbol') ?? '').trim().toUpperCase()
    const ts = Number(url.searchParams.get('timestamp'))
    if (!FEEDS[symbol] || !Number.isInteger(ts) || ts <= 0) return json(res, 400, { error: 'symbol and unix-second timestamp required' })
    // Like the real archive: a second that has not happened yet has no signed price.
    if (ts * 1000 > Date.now()) return json(res, 404, { error: 'no signed price for that second' })
    return json(res, 200, { price: signedPrice(symbol, ts * 1000 + 500) })
  }
  json(res, 404, { error: 'not found' })
})

// WS /ws?symbols=BTCUSD — one signed tick per subscribed symbol every 500ms.
const wss = new WebSocketServer({ server, path: '/ws' })
wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://localhost')
  let symbols = (url.searchParams.get('symbols') ?? '').split(',').map((s) => s.trim().toUpperCase()).filter((s) => FEEDS[s])
  if (!url.searchParams.has('symbols')) symbols = Object.keys(FEEDS)
  ws.send(JSON.stringify({ type: 'connected', symbols }))
  ws.on('message', (raw) => {
    try {
      const m = JSON.parse(raw.toString())
      const list = (m.symbols ?? []).map((s) => String(s).toUpperCase()).filter((s) => FEEDS[s])
      if (m.action === 'subscribe') symbols = [...new Set([...symbols, ...list])]
      if (m.action === 'unsubscribe') symbols = symbols.filter((s) => !list.includes(s))
    } catch { /* ignore */ }
  })
  const timer = setInterval(() => {
    const now = Date.now()
    for (const s of symbols) ws.send(JSON.stringify(signedPrice(s, now)))
  }, 500)
  ws.on('close', () => clearInterval(timer))
})

const port = Number(process.env.PORT ?? 18088)
server.listen(port, '127.0.0.1', () => console.log(`mock signed-price server on :${port} — signer ${ADDRESS}`))
