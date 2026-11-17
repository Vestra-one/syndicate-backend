// Design-audit capture: every screen/state at desktop/tablet/mobile via CDP (headless Chrome :9222).
// Organizes output into /design-audit/screenshots/<Feature>/<screen>-<viewport>.png.
// One tab per screen; per screen we navigate+seed once, then resize+recapture per viewport.
import { writeFileSync, mkdirSync } from 'node:fs'

const APP = 'http://localhost:5173/?view=app'
const ROOT = '/Users/ay/syn-front/design-audit/screenshots'

const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900, scale: 1, mobile: false },
  { name: 'tablet', width: 834, height: 1112, scale: 2, mobile: true },
  { name: 'mobile', width: 390, height: 844, scale: 3, mobile: true },
]

// ---------- shared seed snippets (from screenshots/shoot.mjs) -------------
const LIMITS = `{buyInMin:100000,buyInMax:1000000000,fillWindowMinSec:20,fillWindowMaxSec:86400}`

const seedDash = `(() => {
  const now = Date.now();
  window.__gameStore.setState({
    discoveryStatus: 'ready',
    walletAddress: 'H9Qoft4c9k2rXexampleWaitingRoomDevMock98of',
    chipBalance: 42000000,
    upcomingGames: [
      { matchId:'up-1', feed:'BTC/USD', buyIn:10000000, entryFee:500000, seated:2, maxPlayers:5, minPlayers:3, fillDeadline: now + 90000 },
      { matchId:'up-2', feed:'BTC/USD', buyIn:25000000, entryFee:1000000, seated:4, maxPlayers:6, minPlayers:3, fillDeadline: now + 240000 },
      { matchId:'up-3', feed:'ETH/USD', buyIn:5000000, entryFee:250000, seated:1, maxPlayers:4, minPlayers:2, fillDeadline: now + 45000 },
    ],
    activeGames: [
      { matchId:'live-1', feed:'BTC/USD', buyIn:10000000, potSize:86500000, spectators:12, actionsPerMin:9, startedAt: now - 420000 },
      { matchId:'live-2', feed:'ETH/USD', buyIn:50000000, potSize:310000000, spectators:41, actionsPerMin:14, startedAt: now - 1260000 },
    ],
  });
})()`

const seedEthChart = `(() => {
  const st = window.__gameStore.getState();
  const hist = st.priceHistory;
  const base = hist.length ? hist[hist.length - 1].price : 52700;
  const now = Date.now();
  const pts = [];
  let p = base * 0.9985;
  for (let i = 600; i > 0; i--) {
    p += base * (Math.sin(i * 0.045) * 0.00008 + (Math.random() - 0.5) * 0.00025);
    pts.push({ price: p, ts: now - i * 500 });
  }
  pts[pts.length - 1].price = base;
  const m = st.match;
  window.__gameStore.setState({ priceHistory: pts, match: m ? { ...m, round: 3 } : m });
})()`

const settled = `(() => {
  const ETH = n => BigInt(Math.round(n * 1e6)); // store settlement amounts are bigint
  const m = window.__gameStore.getState().match;
  window.__gameStore.setState({
    yourTurn: null,
    match: { ...m, phase: 'SETTLED' },
    sealStatus: 'sealed',
    yourPrediction: 6250100,
    settlement: {
      matchId: 'mock', settlementPrice: 6250212,
      awards: [ { seat:0, amount:ETH(11.2) }, { seat:2, amount:ETH(6.1) } ],
      uncalledReturns: [ { seat:1, amount:ETH(0.5) } ],
      rakeCollected: ETH(0.45),
      revealedPredictions: [
        { seat:0, prediction:6250100 }, { seat:1, prediction:6238900 },
        { seat:2, prediction:6249300 }, { seat:3, prediction:6262100 },
        { seat:4, prediction:6210400 }, { seat:5, prediction:6301500 },
      ],
    },
  });
})()`

// ---------- screens grouped by feature ------------------------------------
const SCREENS = [
  { feat: 'Landing', name: 'landing', url: 'http://localhost:5173/?view=soon' },

  { feat: 'Dashboard', name: 'dashboard-empty', setup: null },
  { feat: 'Dashboard', name: 'dashboard-populated', setup: seedDash },
  { feat: 'Dashboard', name: 'dashboard-invite', setup: `${seedDash}; window.__gameStore.setState({ pendingInvite: 'up-2' })` },

  { feat: 'Lobby', name: 'lobby-join', setup: `window.__mockWaiting(); window.__gameStore.setState({ seated:false, playMode:'join', fillDeadline:null, lobbySeated:2 })` },
  { feat: 'Lobby', name: 'lobby-create', setup: `window.__mockWaiting(); window.__gameStore.setState({ seated:false, playMode:'create', fillDeadline:null, match:null, createLimits:${LIMITS} })` },

  { feat: 'Transaction', name: 'tx-signing-create', setup: `window.__mockWaiting(); window.__gameStore.setState({ txProgress: { kind:'create', stage:'signing', amount:10500000, chipsToken:'USDC', feed:'BTC/USD', seats:'1/5' } })` },
  { feat: 'Transaction', name: 'tx-confirming-join', setup: `window.__mockWaiting(); window.__gameStore.setState({ txProgress: { kind:'join', stage:'confirming', amount:10500000, chipsToken:'USDC', feed:'BTC/USD', seats:'3/5' } })` },
  { feat: 'Transaction', name: 'tx-error', setup: `window.__mockWaiting(); window.__gameStore.setState({ txProgress: { kind:'join', stage:'error', amount:10500000, chipsToken:'USDC', feed:'BTC/USD', seats:'3/5', error:'Transaction simulation failed: insufficient USDC balance.' } })` },

  { feat: 'WaitingRoom', name: 'waiting-filling', setup: `window.__mockWaiting({ seated:2, max:5, min:3, secs:78 })` },
  { feat: 'WaitingRoom', name: 'waiting-ready', setup: `window.__mockWaiting({ seated:3, max:5, min:3, secs:45 })` },
  { feat: 'WaitingRoom', name: 'waiting-full', setup: `window.__mockWaiting({ seated:5, max:5, min:3, secs:15 })` },

  { feat: 'LiveMatch', name: 'live-your-turn', setup: `window.__mockLive(0); ${seedEthChart}`, pump: true, late: `window.__gameStore.setState({ yourTurn: { toCall: 750000, minRaiseTo: 1250000, deadline: Date.now() + 9500 } })` },
  { feat: 'LiveMatch', name: 'live-opponent-turn', setup: `window.__mockLive(2); ${seedEthChart}`, pump: true },

  { feat: 'Sealing', name: 'sealing-open', setup: `window.__mockLive(0); ${seedEthChart}; (() => { const m = window.__gameStore.getState().match; window.__gameStore.setState({ yourTurn:null, feed:[], match: { ...m, phase:'SEALING' }, sealStatus:'unsealed', sealClosed:false }); })()`, pump: true },
  { feat: 'Sealing', name: 'sealing-sealed', setup: `window.__mockLive(0); ${seedEthChart}; (() => { const m = window.__gameStore.getState().match; window.__gameStore.setState({ yourTurn:null, feed:[], match: { ...m, phase:'SEALING' }, sealStatus:'sealed', yourPrediction:6250100, sealClosed:false }); })()`, pump: true },
  { feat: 'Sealing', name: 'sealing-closed-missed', setup: `window.__mockLive(0); ${seedEthChart}; (() => { const m = window.__gameStore.getState().match; window.__gameStore.setState({ yourTurn:null, feed:[], match: { ...m, phase:'SEALING' }, sealStatus:'unsealed', sealClosed:true }); })()`, pump: true },

  { feat: 'PriceChart', name: 'price-chart-overlay', setup: `window.__mockLive(0); ${seedEthChart}; window.__gameStore.setState({ priceChartOpen: true })`, pump: true },

  { feat: 'Resolution', name: 'resolution-settled', setup: `window.__mockLive(0); ${seedEthChart}; ${settled}`, pump: true },
  { feat: 'Resolution', name: 'resolution-voided', setup: `window.__mockLive(0); ${seedEthChart}; (() => { const m = window.__gameStore.getState().match; window.__gameStore.setState({ yourTurn:null, match: { ...m, phase:'VOID' }, voided: { reason:'NotEnoughPlayers' } }); })()`, pump: true },
]

// ---------- CDP plumbing --------------------------------------------------
const CDP_HTTP = 'http://127.0.0.1:9222'

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl)
    let id = 0
    const pending = new Map()
    const events = []
    ws.onopen = () => resolve({
      send: (method, params = {}) => new Promise((res, rej) => {
        const mid = ++id
        pending.set(mid, { res, rej })
        ws.send(JSON.stringify({ id: mid, method, params }))
      }),
      events,
      close: () => ws.close(),
      waitFor: (method, timeoutMs) => new Promise((res) => {
        const t0 = Date.now()
        const tick = () => {
          if (events.some(e => e.method === method)) return res(true)
          if (Date.now() - t0 > timeoutMs) return res(false)
          setTimeout(tick, 100)
        }
        tick()
      }),
    })
    ws.onerror = (e) => reject(new Error('ws error: ' + e.message))
    ws.onmessage = (m) => {
      const msg = JSON.parse(m.data)
      if (msg.id && pending.has(msg.id)) {
        const { res, rej } = pending.get(msg.id)
        pending.delete(msg.id)
        msg.error ? rej(new Error(msg.error.message)) : res(msg.result)
      } else if (msg.method) {
        events.push(msg)
      }
    }
  })
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms))

async function shoot(spec) {
  const dir = `${ROOT}/${spec.feat}`
  mkdirSync(dir, { recursive: true })
  const tab = await (await fetch(`${CDP_HTTP}/json/new?about:blank`, { method: 'PUT' })).json()
  const cdp = await connect(tab.webSocketDebuggerUrl)
  const logs = []
  try {
    await cdp.send('Page.enable')
    await cdp.send('Runtime.enable')
    await cdp.send('Page.navigate', { url: spec.url || APP })
    await cdp.waitFor('Page.loadEventFired', 15000)
    await sleep(4500) // scene boot + bloom

    if (spec.setup) {
      const r = await cdp.send('Runtime.evaluate', { expression: spec.setup, awaitPromise: true })
      if (r.exceptionDetails) logs.push('SETUP EXCEPTION: ' + JSON.stringify(r.exceptionDetails).slice(0, 500))
    }
    await sleep(2200)
    if (spec.pump) { await cdp.send('Runtime.evaluate', { expression: 'window.__tableStep && window.__tableStep(120)' }); await sleep(600) }
    if (spec.late) { await cdp.send('Runtime.evaluate', { expression: spec.late }); await sleep(500) }

    for (const vp of VIEWPORTS) {
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width: vp.width, height: vp.height, deviceScaleFactor: vp.scale, mobile: vp.mobile,
      })
      await sleep(400)
      // re-pump so 3D anchors + canvas resize settle at the new viewport
      await cdp.send('Runtime.evaluate', { expression: 'window.__tableStep && window.__tableStep(30)' })
      await sleep(300)
      // Kill background intervals (8s discovery poll, price feed) then re-apply the
      // seed as the LAST write, so nothing clobbers mock state before capture.
      await cdp.send('Runtime.evaluate', { expression: 'for (let i=1;i<99999;i++) clearInterval(i)' })
      if (spec.setup) await cdp.send('Runtime.evaluate', { expression: spec.setup, awaitPromise: true })
      if (spec.late) await cdp.send('Runtime.evaluate', { expression: spec.late })
      await sleep(350)
      const shot = await cdp.send('Page.captureScreenshot', { format: 'png' })
      writeFileSync(`${dir}/${spec.name}-${vp.name}.png`, Buffer.from(shot.data, 'base64'))
    }

    for (const e of cdp.events) {
      if (e.method === 'Runtime.exceptionThrown') logs.push('PAGE EXCEPTION: ' + JSON.stringify(e.params.exceptionDetails).slice(0, 400))
      if (e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error')
        logs.push('CONSOLE ERROR: ' + (e.params.args || []).map(a => a.value ?? a.description ?? '').join(' ').slice(0, 300))
    }
    console.log(`✓ ${spec.feat}/${spec.name}${logs.length ? '  [' + logs.length + ' log(s)]' : ''}`)
    if (logs.length) writeFileSync(`${dir}/${spec.name}.log`, logs.join('\n'))
  } catch (err) {
    console.log(`✗ ${spec.feat}/${spec.name}: ${err.message}`)
  } finally {
    cdp.close()
    await fetch(`${CDP_HTTP}/json/close/${tab.id}`).catch(() => {})
    await sleep(300)
  }
}

const only = process.argv.slice(2)
for (const spec of SCREENS) {
  if (only.length && !only.some(o => spec.name.includes(o) || spec.feat.toLowerCase().includes(o.toLowerCase()))) continue
  await shoot(spec)
}
console.log('done →', ROOT)
