#!/usr/bin/env node
/**
 * Browser end-to-end: two real app instances play one full hand against the local stack.
 *
 *   host creates a table → guest joins from the lobby → both seal a prediction →
 *   they bet through every street → the match settles on-chain → winners claim.
 *
 * Everything the product does for real happens for real: the React app, its store, the
 * REST + WebSocket protocol, the Anchor transactions, the on-chain program, the settlement
 * worker. The only stand-ins are the localnet ones (mock price feed, mock timelock) and the
 * wallet — a Wallet Standard wallet injected into the page whose signatures are produced
 * here from the funded e2e keypairs (no extension, no prompts).
 *
 * Prereq: the localnet is up (`scripts/localnet/up.sh` at the repo root).
 *
 *   node scripts/e2e-localnet.mjs
 *   LOCALNET_ENV=/path/to/.localnet/env SHOTS=./e2e-shots node scripts/e2e-localnet.mjs
 *
 * Exits non-zero on any failed expectation. Screenshots of each phase land in $SHOTS.
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import puppeteer from 'puppeteer-core'
import { Keypair, Transaction, VersionedTransaction } from '@solana/web3.js'
import { ed25519 } from '@noble/curves/ed25519'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
// Written by scripts/localnet/up.sh at the repo root.
const ENV_FILE = process.env.LOCALNET_ENV ?? resolve(ROOT, '../../.localnet/env')
const SHOTS = resolve(process.env.SHOTS ?? resolve(ROOT, 'e2e-shots'))
const PORT = Number(process.env.APP_PORT ?? 5199)
const APP = `http://127.0.0.1:${PORT}/`
const STREET_SEC = Number(process.env.STREET_SEC ?? 30)
const ROUND_COUNT = Number(process.env.ROUND_COUNT ?? 2)
const OBSERVATION_SEC = Number(process.env.OBSERVATION_SEC ?? 5)
const WALLET_NAME = 'Localnet Test Wallet'

if (!existsSync(ENV_FILE)) {
  console.error(`localnet env not found at ${ENV_FILE} — run scripts/localnet/up.sh (repo root) first`)
  process.exit(1)
}
const env = Object.fromEntries(
  readFileSync(ENV_FILE, 'utf8')
    .split('\n')
    .filter((l) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(l))
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
)
const gameUrl = env.GAME_SERVER_URL
const priceUrl = env.SIGNED_PRICE_SERVER_URL
mkdirSync(SHOTS, { recursive: true })

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failed = false
function expect(cond, label) {
  if (cond) log(`ok   ${label}`)
  else {
    failed = true
    log(`FAIL ${label}`)
  }
}

// ---------------------------------------------------------------------------------------
// Vite dev server pointed at the localnet
// ---------------------------------------------------------------------------------------
const vite = spawn('npx', ['vite', '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'], {
  cwd: ROOT,
  env: {
    ...process.env,
    VITE_API_URL: `${gameUrl}/v1`,
    VITE_WS_URL: `${gameUrl.replace(/^http/, 'ws')}/v1/ws`,
    VITE_PRICE_WS_URL: `${priceUrl.replace(/^http/, 'ws')}/ws`,
    VITE_SOLANA_RPC_URL: env.SOLANA_RPC_URL,
    VITE_PROGRAM_ID: env.SYNDICATE_PROGRAM_ID,
    VITE_TIMELOCK_MODE: 'mock',
    // Deliberately NO VITE_CHIPS_TOKEN_MINT: the app must learn the mint from the server.
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let viteLog = ''
vite.stdout.on('data', (d) => (viteLog += d))
vite.stderr.on('data', (d) => (viteLog += d))
async function waitForVite() {
  for (let i = 0; i < 120; i++) {
    try {
      const r = await fetch(APP)
      if (r.ok) return
    } catch { /* not up yet */ }
    await sleep(500)
  }
  throw new Error(`vite never came up:\n${viteLog}`)
}

// ---------------------------------------------------------------------------------------
// Injected wallet: a Wallet Standard wallet whose signing is done in this process
// ---------------------------------------------------------------------------------------
function walletScript(pubkeyB58, pubkeyBytes) {
  return `(() => {
    const ICON = 'data:image/svg+xml;base64,' + btoa('<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" rx="6" fill="#c9a227"/></svg>');
    const CHAINS = ['solana:localnet', 'solana:devnet', 'solana:mainnet'];
    const account = {
      address: ${JSON.stringify(pubkeyB58)},
      publicKey: new Uint8Array(${JSON.stringify(pubkeyBytes)}),
      chains: CHAINS,
      features: ['solana:signTransaction', 'solana:signMessage'],
    };
    let accounts = [];
    const listeners = new Set();
    const emit = () => listeners.forEach((l) => l({ accounts }));
    const wallet = {
      version: '1.0.0',
      name: ${JSON.stringify(WALLET_NAME)},
      icon: ICON,
      chains: CHAINS,
      get accounts() { return accounts; },
      features: {
        'standard:connect': { version: '1.0.0', connect: async () => { accounts = [account]; emit(); return { accounts }; } },
        'standard:disconnect': { version: '1.0.0', disconnect: async () => { accounts = []; emit(); } },
        'standard:events': { version: '1.0.0', on: (event, l) => { if (event === 'change') listeners.add(l); return () => listeners.delete(l); } },
        'solana:signTransaction': {
          version: '1.0.0',
          supportedTransactionVersions: ['legacy', 0],
          signTransaction: async (...inputs) => Promise.all(inputs.map(async ({ transaction }) => ({
            signedTransaction: new Uint8Array(await window.__e2eSignTx(Array.from(transaction))),
          }))),
        },
        'solana:signMessage': {
          version: '1.0.0',
          signMessage: async (...inputs) => Promise.all(inputs.map(async ({ message }) => ({
            signedMessage: message,
            signature: new Uint8Array(await window.__e2eSignMsg(Array.from(message))),
          }))),
        },
      },
    };
    const register = ({ register }) => register(wallet);
    try {
      const ev = new Event('wallet-standard:register-wallet');
      Object.defineProperty(ev, 'detail', { value: register });
      window.dispatchEvent(ev);
    } catch (e) { console.error('wallet register failed', e); }
    window.addEventListener('wallet-standard:app-ready', (e) => register(e.detail));
    // Remembered selection → the WalletProvider auto-connects on load (no modal).
    try { localStorage.setItem('walletName', JSON.stringify(${JSON.stringify(WALLET_NAME)})); } catch {}
    // Headless Chrome renders the 3D table in software; at 60fps that starves the page's own
    // network callbacks on small CI boxes. Cap animation frames (test harness only).
    const FRAME_MS = ${Number(process.env.FRAME_MS ?? (process.env.E2E_3D ? 400 : 0))};
    if (FRAME_MS > 0) {
      const timers = new Map(); let seq = 0;
      window.requestAnimationFrame = (cb) => { const id = ++seq; timers.set(id, setTimeout(() => { timers.delete(id); cb(performance.now()); }, FRAME_MS)); return id; };
      window.cancelAnimationFrame = (id) => { clearTimeout(timers.get(id)); timers.delete(id); };
    }
    // Track sockets so the test can sever the game socket mid-hand (reconnect scenario).
    const RealWS = window.WebSocket;
    window.__e2eSockets = [];
    window.WebSocket = class extends RealWS {
      constructor(...args) { super(...args); window.__e2eSockets.push(this); }
    };
    // Shorten the streets of any table this page creates so a full hand fits in a test run.
    const realFetch = window.fetch.bind(window);
    window.fetch = (input, init) => {
      const url = typeof input === 'string' ? input : input.url;
      if (init?.method === 'POST' && /\\/rooms\\/intents$/.test(url) && typeof init.body === 'string') {
        const body = JSON.parse(init.body);
        body.streets = {
          count: ${ROUND_COUNT},
          durations_sec: Array(${ROUND_COUNT}).fill(${STREET_SEC}),
          observation_sec: Array(${ROUND_COUNT}).fill(${OBSERVATION_SEC}),
        };
        init = { ...init, body: JSON.stringify(body) };
      }
      return realFetch(input, init);
    };
  })()`
}

async function openPlayer(browser, name, keypairPath) {
  const kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(keypairPath, 'utf8'))))
  const ctx = await browser.createBrowserContext()
  const page = await ctx.newPage()
  await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 })
  const errors = []
  page.on('console', (m) => {
    const t = m.text()
    if (m.type() === 'error' || /\[seal\]|\[act\]|\[head\]|\[ws\]|rejected|failed/i.test(t)) {
      if (m.type() === 'error') errors.push(t)
      if (process.env.VERBOSE) log(`  [${name}:${m.type()}] ${t.slice(0, 300)}`)
    }
  })
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
  // Every signMessage is a wallet prompt for a real user — count them by purpose.
  const prompts = { login: 0, socket: 0, grant: 0, intent: 0 }
  await page.exposeFunction('__e2eSignMsg', (bytes) => {
    const text = Buffer.from(bytes).toString('utf8')
    if (text.startsWith('syndicate-login:')) prompts.login++
    else if (/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(text)) prompts.socket++
    else if (text.startsWith("Satoshi's Table — one-tap play")) prompts.grant++
    else prompts.intent++
    return Array.from(ed25519.sign(Uint8Array.from(bytes), kp.secretKey.slice(0, 32)))
  })
  await page.exposeFunction('__e2eSignTx', (bytes) => {
    const raw = Uint8Array.from(bytes)
    try {
      const tx = Transaction.from(raw)
      tx.partialSign(kp)
      return Array.from(tx.serialize({ requireAllSignatures: false, verifySignatures: false }))
    } catch {
      const tx = VersionedTransaction.deserialize(raw)
      tx.sign([kp])
      return Array.from(tx.serialize())
    }
  })
  await page.evaluateOnNewDocument(walletScript(kp.publicKey.toBase58(), Array.from(kp.publicKey.toBytes())))
  await page.goto(APP, { waitUntil: 'domcontentloaded' })
  const p = { name, page, wallet: kp.publicKey.toBase58(), errors, prompts }
  await waitFor(p, 'store ready', () => !!window.__gameStore, 60_000)
  await waitFor(p, 'wallet auto-connected', (w) => window.__gameStore.getState().walletAddress === w, 60_000, p.wallet)
  return p
}

/** Read a JSON-safe projection of the store. */
const state = (p) =>
  p.page.evaluate(() => {
    const s = window.__gameStore.getState()
    const big = (v) => (v == null ? null : v.toString())
    return {
      view: s.view,
      status: s.status,
      wallet: s.walletAddress,
      chipBalance: big(s.chipBalance),
      playMode: s.playMode,
      playResolving: s.playResolving,
      playError: s.playError,
      seated: s.seated,
      lobbySeated: s.lobbySeated,
      tx: s.txProgress ? { stage: s.txProgress.stage, error: s.txProgress.error, raw: s.txProgress.errorRaw } : null,
      phase: s.match?.phase ?? null,
      matchId: s.match?.matchId ?? null,
      round: s.match?.round ?? null,
      pot: big(s.match?.pot),
      toActSeat: s.match?.toActSeat ?? null,
      yourSeat: s.match?.yourSeat ?? null,
      yourStack: big(s.match?.yourStack),
      seats: (s.match?.seats ?? []).map((x) => ({ seat: x.seat, stack: big(x.stack), folded: x.folded })),
      yourTurn: s.yourTurn,
      actPending: !!s.actPending,
      sealStatus: s.sealStatus,
      sealClosed: s.sealClosed,
      sealedSeats: s.sealedSeats,
      targetRound: s.terms?.timelockTargetRound ?? 0,
      mint: s.terms?.chipsTokenMint ?? null,
      onchainMatchId: s.terms?.onchainMatchId ?? null,
      lastPrice: s.priceHistory.at(-1)?.price ?? null,
      // Same gate the betting panel applies (useRoundGate): the engine assigns the next
      // street's turn early, but acts are only accepted once that street's window opens.
      bettingOpen: (() => {
        const win = s.streetSchedule?.[Math.max(0, (s.match?.round ?? 1) - 1)]
        return !win || (Date.now() >= win.open && Date.now() < win.close)
      })(),
      settlement: s.settlement
        ? {
            price: s.settlement.settlementPrice,
            awards: s.settlement.awards.map((a) => ({ seat: a.seat, amount: big(a.amount) })),
            rake: big(s.settlement.rakeCollected),
            reveals: s.settlement.revealedPredictions,
          }
        : null,
      voided: s.voided,
      feed: s.feed.length,
    }
  })

async function waitFor(p, label, fn, timeoutMs = 60_000, arg) {
  const t0 = Date.now()
  for (;;) {
    let ok = false
    try {
      ok = await p.page.evaluate(fn, arg)
    } catch { /* navigation / not ready */ }
    if (ok) {
      log(`ok   [${p.name}] ${label} (${((Date.now() - t0) / 1000).toFixed(1)}s)`)
      return
    }
    if (Date.now() - t0 > timeoutMs) {
      const s = await state(p).catch(() => null)
      await shot(p, `timeout-${label.replace(/\W+/g, '-')}`)
      throw new Error(`[${p.name}] timed out waiting for: ${label}\nstate: ${JSON.stringify(s)}\nerrors: ${p.errors.slice(-5).join('\n')}`)
    }
    await sleep(400)
  }
}

async function shot(p, name) {
  try {
    await p.page.screenshot({ path: resolve(SHOTS, `${name}-${p.name}.png`) })
  } catch (e) {
    log(`  (screenshot ${name} failed: ${e.message})`)
  }
}

/**
 * "Play someone else's seat": a signed-in outsider sends a perfectly well-formed fold for the
 * seat whose turn it is — correct chain head, valid signature by the outsider's OWN key.
 * A valid signature only proves who signed; the server must also check the signer holds
 * the seat. Returns the server's reply frame.
 */
async function forgeFoldForSeat(matchId, onchainMatchId, victimSeat, headHex, attackerKeypairPath) {
  const kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(attackerKeypairPath, 'utf8'))))
  const sign = (bytes) => Buffer.from(ed25519.sign(bytes, kp.secretKey.slice(0, 32))).toString('base64')
  const u64 = (v) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(v)); return b }
  const u16 = (v) => { const b = Buffer.alloc(2); b.writeUInt16LE(v); return b }
  const nonce = 424242
  const intent = Buffer.concat([
    Buffer.from('syndicate/action/v1'), Buffer.from([0]),
    u64(onchainMatchId), u64(onchainMatchId), u16(victimSeat), Buffer.from(kp.publicKey.toBytes()),
    u64(nonce), Buffer.from(headHex, 'hex'), Buffer.from([0 /* fold */]), u64(0),
  ])
  const ws = new WebSocket(`${gameUrl.replace(/^http/, 'ws')}/v1/ws`)
  return await new Promise((resolveReply, reject) => {
    const timer = setTimeout(() => { ws.close(); reject(new Error('attacker socket timed out')) }, 15_000)
    ws.onmessage = (ev) => {
      const f = JSON.parse(ev.data)
      if (f.t === 'challenge') {
        ws.send(JSON.stringify({ t: 'auth', wallet: kp.publicKey.toBase58(), signature: sign(Buffer.from(f.nonce)) }))
      } else if (f.t === 'authenticated') {
        ws.send(JSON.stringify({
          t: 'act', match_id: matchId, seat_index: victimSeat, nonce,
          prev_head_hex: headHex, action: 'fold', signature: sign(intent),
        }))
      } else if (f.t === 'error' || f.t === 'action') {
        clearTimeout(timer)
        ws.close()
        resolveReply(f)
      }
    }
    ws.onerror = () => { clearTimeout(timer); reject(new Error('attacker socket error')) }
  })
}

const act = (p, action) =>
  p.page.evaluate((a) => {
    const s = window.__gameStore.getState()
    const amount = a.amount != null ? BigInt(a.amount) : undefined
    return s.act(amount != null ? { type: a.type, amount } : { type: a.type })
  }, action)

// ---------------------------------------------------------------------------------------
// The hand
// ---------------------------------------------------------------------------------------
async function main() {
  await waitForVite()
  log(`app ${APP}  api ${gameUrl}  shots ${SHOTS}`)
  const browser = await puppeteer.launch({
    executablePath: process.env.CHROME_PATH ?? '/usr/bin/google-chrome',
    headless: true,
    args: [
      '--no-sandbox',
      // E2E_3D=1 renders the real 3D table (software GL — needs a few spare cores). By
      // default WebGL is off: the app falls back to the HUD alone, which is what the test
      // drives and asserts on, and the run stays fast on small machines.
      ...(process.env.E2E_3D ? ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] : ['--disable-gpu', '--disable-3d-apis']),
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows',
    ],
  })
  try {
    const keys = (n) => env[`PLAYER${n}_KEYPAIR`]
    const host = await openPlayer(browser, 'host', keys(1))
    const guest = await openPlayer(browser, 'guest', keys(2))
    await shot(host, '01-lobby')

    // ---- create ----
    await host.page.evaluate(() => void window.__gameStore.getState().createGame())
    await waitFor(host, 'create sheet ready (config loaded, session signed)', () => window.__gameStore.getState().playMode === 'create')
    await host.page.evaluate(() => {
      const s = window.__gameStore.getState()
      s.setCreateSeats(2)
      s.setCreateFillWindow(120)
    })
    const before = { host: BigInt((await state(host)).chipBalance ?? 0), guest: 0n }
    await shot(host, '02-create-sheet')
    await host.page.evaluate(() => void window.__gameStore.getState().createTable())
    await waitFor(host, 'table created on-chain → table view', () => {
      const s = window.__gameStore.getState()
      if (s.txProgress?.stage === 'error') throw new Error(s.txProgress.errorRaw ?? s.txProgress.error)
      return s.view === 'table' && s.seated && s.lastTx?.label === 'Table created on-chain'
    }, 120_000)
    await shot(host, '03-waiting-room')
    await waitFor(host, 'create ceremony dismissed', () => !window.__gameStore.getState().txProgress, 30_000).catch(() => {})
    await shot(host, '03b-waiting-room-alone')

    // ---- join (discovered from the lobby, like a real second player) ----
    let matchId = null
    for (let i = 0; i < 60 && !matchId; i++) {
      const lobby = await (await fetch(`${gameUrl}/v1/lobby`)).json()
      matchId = lobby.rooms.find((r) => r.creator_wallet === host.wallet)?.match_id ?? null
      if (!matchId) await sleep(1000)
    }
    expect(!!matchId, `host's table is listed in the public lobby (${matchId})`)
    await guest.page.evaluate(() => void window.__gameStore.getState().loadDiscovery())
    await waitFor(guest, 'guest sees the table in its lobby', (id) => window.__gameStore.getState().upcomingGames.some((g) => g.matchId === id), 30_000, matchId)
    await shot(guest, '04-lobby-with-table')
    await guest.page.evaluate((id) => void window.__gameStore.getState().joinGame(id), matchId)
    await waitFor(guest, 'join sheet ready', () => window.__gameStore.getState().playMode === 'join')
    before.guest = BigInt((await state(guest)).chipBalance ?? 0)
    await shot(guest, '05-join-sheet')
    await guest.page.evaluate(() => void window.__gameStore.getState().joinTable())
    await waitFor(guest, 'deposit confirmed → table view', () => {
      const s = window.__gameStore.getState()
      if (s.txProgress?.stage === 'error') throw new Error(s.txProgress.errorRaw ?? s.txProgress.error)
      return s.view === 'table' && s.seated && s.lastTx?.label === 'Deposit confirmed on-chain'
    }, 120_000)

    await sleep(1500)
    await shot(guest, '05b-waiting-room-full')
    // ---- lock → sealing ----
    for (const p of [host, guest]) {
      await waitFor(p, 'table locked → SEALING with a server-assigned timelock round', () => {
        const s = window.__gameStore.getState()
        return s.match?.phase === 'SEALING' && (s.terms?.timelockTargetRound ?? 0) > 0 && s.match?.yourSeat != null
      }, 120_000)
    }
    await shot(host, '06-sealing')
    const spot = (await state(host)).lastPrice ?? 64000
    // Predictions in the UI's fixed point (cents). Host calls slightly up, guest slightly down.
    const calls = { host: Math.round((spot + 25) * 100), guest: Math.round((spot - 40) * 100) }
    for (const p of [host, guest]) {
      await p.page.evaluate((price) => void window.__gameStore.getState().sealPrediction(price), calls[p.name])
    }
    for (const p of [host, guest]) {
      await waitFor(p, 'prediction sealed (on-chain commitment + server accepted)', () => {
        const s = window.__gameStore.getState()
        return s.sealStatus === 'sealed'
      }, 90_000)
    }
    await waitFor(host, 'both seats show as sealed', () => window.__gameStore.getState().sealedSeats.length === 2, 30_000)
    await shot(host, '07-sealed')
    await sleep(8000)
    await shot(guest, '07b-sealed-waiting-for-live')

    // ---- live betting ----
    for (const p of [host, guest]) {
      await waitFor(p, 'match LIVE', () => window.__gameStore.getState().match?.phase === 'LIVE', 180_000)
    }
    await shot(host, '08-live')
    const players = [host, guest]
    let actions = 0
    let shotTurn = false
    let severed = false
    const betRounds = new Set()
    const shots = new Set()
    let attack = null
    const socketPromptsBefore = host.prompts.socket
    const liveDeadline = Date.now() + (ROUND_COUNT * (STREET_SEC + OBSERVATION_SEC) + 240) * 1000
    for (;;) {
      const snaps = await Promise.all(players.map(state))
      if (snaps.every((s) => s.settlement) || snaps.some((s) => s.voided)) break
      if (Date.now() > liveDeadline) throw new Error(`match never settled\n${JSON.stringify(snaps)}`)
      for (let i = 0; i < players.length; i++) {
        const s = snaps[i]
        if (s.phase === 'LIVE' && !s.yourTurn && !shots.has('opp')) {
          shots.add('opp')
          await shot(players[i], '09b-opponents-turn')
        }
        if (s.phase === 'LIVE' && s.yourTurn && !s.bettingOpen && !shots.has('queued')) {
          shots.add('queued')
          await shot(players[i], '09c-turn-queued-until-round-opens')
        }
        if (s.phase === 'SETTLEMENT_WINDOW' && !shots.has('settling')) {
          shots.add('settling')
          await shot(players[i], '09d-settling')
        }
        if (!s.yourTurn || s.actPending || s.phase !== 'LIVE' || !s.bettingOpen) continue
        // Before the rightful player moves, an outsider tries to fold this seat for them.
        if (!attack) {
          const view = await (await fetch(`${gameUrl}/v1/matches/${matchId}`)).json()
          attack = await forgeFoldForSeat(matchId, view.onchain_match_id, s.yourSeat, view.head, env.ATTACKER_KEYPAIR)
          log(`     outsider tried to fold seat ${s.yourSeat} → ${attack.t}${attack.code ? ` (${attack.code})` : ''}`)
        }
        if (!shotTurn) {
          await shot(players[i], '09-your-turn')
          shotTurn = true
        }
        // Simple line: call what's owed; first to act on a later street opens with a bet
        // (so a sized bet + a call cross the wire, not only checks); otherwise check.
        let action
        if (s.yourTurn.toCall > 0) action = { type: 'call' }
        else if (s.round >= 2 && !betRounds.has(s.round)) {
          betRounds.add(s.round)
          action = { type: 'betTo', amount: String(s.yourTurn.minRaiseTo) }
        } else action = { type: 'check' }
        log(`     ${players[i].name} (seat ${s.yourSeat}) → ${action.type}${action.amount ? ` ${action.amount}` : ''}  [round ${s.round}, to_call ${s.yourTurn.toCall}]`)
        await act(players[i], action)
        actions++
      }
      // Reconnect scenario: once the first street's betting is done, drop the host's game
      // socket. The app must notice, reconnect, re-authenticate WITHOUT a wallet prompt
      // (session token), recover its turn, and keep playing.
      if (!severed && actions >= 2) {
        severed = true
        const n = await host.page.evaluate(() => {
          const live = window.__e2eSockets.filter((w) => w.url.includes('/v1/ws') && w.readyState === 1)
          live.forEach((w) => w.close())
          return live.length
        })
        log(`     severed the host's game socket (${n} open) — it must recover on its own`)
      }
      await sleep(700)
    }
    const [hs, gs] = await Promise.all(players.map(state))
    expect(!hs.voided && !gs.voided, 'match settled (not voided)')
    expect(actions >= 2, `signed actions were accepted by the engine (${actions} sent)`)
    expect(hs.feed > 0 && gs.feed > 0, 'both clients received the live action feed')
    expect(attack?.t === 'error' && attack.code === 'not_your_seat', `an outsider cannot act for someone else's seat (${attack?.code ?? attack?.t})`)
    expect(!hs.seats.some((x) => x.folded) && !gs.seats.some((x) => x.folded), 'nobody was folded by the forged action')
    for (const p of players) {
      expect(p.prompts.grant === 1 && p.prompts.intent === 0, `[${p.name}] one-tap play: 1 grant, then no wallet prompt for any move or seal (grant ${p.prompts.grant}, per-move ${p.prompts.intent})`)
    }
    expect(severed, 'host socket was severed mid-hand and the hand still completed')
    expect(host.prompts.socket === socketPromptsBefore, `reconnect needed no wallet signature (socket-auth prompts: ${host.prompts.socket})`)
    for (const p of players) {
      expect(p.prompts.login + p.prompts.socket <= 1, `[${p.name}] one sign-in prompt covers REST + socket (login ${p.prompts.login}, socket ${p.prompts.socket})`)
    }
    await shot(host, '10-resolution')
    await shot(guest, '10-resolution')

    // ---- settlement + claims ----
    const s = hs.settlement
    expect(!!s && s.price > 0, `settlement price revealed (${s?.price})`)
    expect(s?.reveals.length === 2, `both sealed predictions were decrypted and revealed (${JSON.stringify(s?.reveals)})`)
    const sealedOk = s?.reveals.every((r) => Object.values(calls).includes(r.prediction))
    expect(sealedOk, 'revealed predictions equal what each player sealed')
    const paid = (s?.awards ?? []).reduce((a, x) => a + BigInt(x.amount), 0n)
    const detail = await (await fetch(`${gameUrl}/v1/matches/${matchId}`)).json()
    const pool = BigInt(detail.params.buy_in) * 2n
    expect(paid + BigInt(s?.rake ?? 0) === pool, `conservation: payouts ${paid} + rake ${s?.rake} == 2 × buy-in ${pool}`)

    for (const p of players) {
      const st = await state(p)
      const mine = st.settlement.awards.find((a) => a.seat === st.yourSeat)
      if (!mine || BigInt(mine.amount) === 0n) {
        log(`     ${p.name} has no payout to claim`)
        continue
      }
      await p.page.evaluate(() => window.__gameStore.getState().claim())
      await waitFor(p, 'payout claimed → wallet balance updated', (exp) => {
        const b = window.__gameStore.getState().chipBalance
        return b != null && b.toString() === exp
      }, 90_000, (before[p.name] - BigInt(detail.params.buy_in) - BigInt(detail.params.entry_fee) + BigInt(mine.amount)).toString())
    }
    await shot(host, '11-claimed')

    const noise = (e) => /favicon|WebGL|GPU|swiftshader|deprecat/i.test(e)
    for (const p of players) {
      const real = p.errors.filter((e) => !noise(e))
      expect(real.length === 0, `[${p.name}] no console errors${real.length ? `: ${real.slice(0, 3).join(' | ')}` : ''}`)
    }
  } finally {
    await browser.close()
    vite.kill()
  }
  if (failed) {
    console.error('\nBROWSER E2E FAILED')
    process.exit(1)
  }
  console.log('\nBROWSER E2E PASSED — create → join → seal → bet → settle → claim')
  process.exit(0) // the dev server's child processes can otherwise keep node alive
}

main().catch((e) => {
  console.error(e)
  vite.kill()
  process.exit(1)
})
