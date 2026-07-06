// Screenshot every flow screen of syn-front via CDP against headless Chrome (:9222).
// One tab at a time (leftover tabs starve swiftshader). Node 22: global fetch/WebSocket.
import { writeFileSync, mkdirSync } from 'node:fs'

const APP = 'http://localhost:5173/'
const OUT = process.env.OUT_DIR || '/Users/ay/syn-front/screenshots/flow-2026-07-04'
mkdirSync(OUT, { recursive: true })

// ---------- screen specs -------------------------------------------------
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

// Seed a plausible random walk around the *current live* price so mock data and
// any real ticks already in the buffer stay on one scale (no 1845-vs-52k spikes).
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
  const ETH = n => Math.round(n * 1e6);
  const m = window.__gameStore.getState().match;
  window.__gameStore.setState({
    yourTurn: null,
    match: { ...m, phase: 'SETTLED' },
    sealStatus: 'sealed',
    yourPrediction: 6250100,
    settlement: {
      matchId: 'mock',
      settlementPrice: 6250212,
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

const SCREENS = [
  { name: '01-dashboard-real', setup: null, note: 'discovery as it really loads (live lobby fetch)' },
  { name: '02-dashboard-populated', setup: seedDash },
  { name: '03-dashboard-invite', setup: `${seedDash}; window.__gameStore.setState({ pendingInvite: 'up-2' })` },
  { name: '04-lobby-join', setup: `window.__mockWaiting(); window.__gameStore.setState({ seated:false, playMode:'join', fillDeadline:null, lobbySeated:2 })` },
  { name: '05-lobby-create', setup: `window.__mockWaiting(); window.__gameStore.setState({ seated:false, playMode:'create', fillDeadline:null, match:null, createLimits:${LIMITS} })` },
  { name: '06-tx-ceremony-signing-create', setup: `window.__mockWaiting(); window.__gameStore.setState({ txProgress: { kind:'create', stage:'signing', amount:10500000, chipsToken:'USDC', feed:'BTC/USD', seats:'1/5' } })` },
  { name: '07-tx-ceremony-confirming-join', setup: `window.__mockWaiting(); window.__gameStore.setState({ txProgress: { kind:'join', stage:'confirming', amount:10500000, chipsToken:'USDC', feed:'BTC/USD', seats:'3/5' } })` },
  { name: '08-tx-ceremony-error', setup: `window.__mockWaiting(); window.__gameStore.setState({ txProgress: { kind:'join', stage:'error', amount:10500000, chipsToken:'USDC', feed:'BTC/USD', seats:'3/5', error:'Transaction simulation failed: insufficient USDC balance.' } })` },
  { name: '09-waiting-filling', setup: `window.__mockWaiting({ seated:2, max:5, min:3, secs:78 })` },
  { name: '10-waiting-ready', setup: `window.__mockWaiting({ seated:3, max:5, min:3, secs:45 })` },
  { name: '11-waiting-full', setup: `window.__mockWaiting({ seated:5, max:5, min:3, secs:15 })` },
  { name: '12-live-your-turn', setup: `window.__mockLive(0); ${seedEthChart}`, pump: true, late: `window.__gameStore.setState({ yourTurn: { toCall: 750000, minRaiseTo: 1250000, deadline: Date.now() + 9500 } })` },
  { name: '13-live-opponent-turn', setup: `window.__mockLive(2); ${seedEthChart}`, pump: true },
  { name: '14-sealing-open', setup: `window.__mockLive(0); ${seedEthChart}; (() => { const m = window.__gameStore.getState().match; window.__gameStore.setState({ yourTurn:null, feed:[], match: { ...m, phase:'SEALING' }, sealStatus:'unsealed', sealClosed:false }); })()`, pump: true },
  { name: '15-sealing-sealed', setup: `window.__mockLive(0); ${seedEthChart}; (() => { const m = window.__gameStore.getState().match; window.__gameStore.setState({ yourTurn:null, feed:[], match: { ...m, phase:'SEALING' }, sealStatus:'sealed', yourPrediction:6250100, sealClosed:false }); })()`, pump: true },
  { name: '16-sealing-closed-missed', setup: `window.__mockLive(0); ${seedEthChart}; (() => { const m = window.__gameStore.getState().match; window.__gameStore.setState({ yourTurn:null, feed:[], match: { ...m, phase:'SEALING' }, sealStatus:'unsealed', sealClosed:true }); })()`, pump: true },
  { name: '17-price-chart-overlay', setup: `window.__mockLive(0); ${seedEthChart}; window.__gameStore.setState({ priceChartOpen: true })`, pump: true },
  { name: '18-resolution-settled', setup: `window.__mockLive(0); ${seedEthChart}; ${settled}`, pump: true },
  { name: '19-resolution-voided', setup: `window.__mockLive(0); ${seedEthChart}; (() => { const m = window.__gameStore.getState().match; window.__gameStore.setState({ yourTurn:null, match: { ...m, phase:'VOID' }, voided: { reason:'NotEnoughPlayers' } }); })()`, pump: true },
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
  // Chrome >=149 rejects GET /json/new — must be PUT
  const tab = await (await fetch(`${CDP_HTTP}/json/new?about:blank`, { method: 'PUT' })).json()
  const cdp = await connect(tab.webSocketDebuggerUrl)
  const logs = []
  try {
    await cdp.send('Page.enable')
    await cdp.send('Runtime.enable')
    await cdp.send('Page.navigate', { url: APP })
    await cdp.waitFor('Page.loadEventFired', 15000)
    await sleep(4500) // scene boot + bloom

    if (spec.setup) {
      const r = await cdp.send('Runtime.evaluate', { expression: spec.setup, awaitPromise: true })
      if (r.exceptionDetails) logs.push('SETUP EXCEPTION: ' + JSON.stringify(r.exceptionDetails).slice(0, 500))
    }
    await sleep(2500) // React re-render + board tick redraw

    if (spec.pump) {
      const r = await cdp.send('Runtime.evaluate', { expression: 'window.__tableStep && window.__tableStep(120)' })
      if (r.exceptionDetails) logs.push('PUMP EXCEPTION: ' + JSON.stringify(r.exceptionDetails).slice(0, 300))
      await sleep(800)
    }

    if (spec.late) {
      const r = await cdp.send('Runtime.evaluate', { expression: spec.late })
      if (r.exceptionDetails) logs.push('LATE EXCEPTION: ' + JSON.stringify(r.exceptionDetails).slice(0, 300))
      await sleep(600)
    }

    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' })
    writeFileSync(`${OUT}/${spec.name}.png`, Buffer.from(shot.data, 'base64'))

    // collect page console errors / exceptions for triage
    for (const e of cdp.events) {
      if (e.method === 'Runtime.exceptionThrown') logs.push('PAGE EXCEPTION: ' + JSON.stringify(e.params.exceptionDetails).slice(0, 400))
      if (e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error')
        logs.push('CONSOLE ERROR: ' + (e.params.args || []).map(a => a.value ?? a.description ?? '').join(' ').slice(0, 300))
    }
    console.log(`✓ ${spec.name}${logs.length ? '   [' + logs.length + ' log(s)]' : ''}`)
    if (logs.length) writeFileSync(`${OUT}/${spec.name}.log`, logs.join('\n'))
  } catch (err) {
    console.log(`✗ ${spec.name}: ${err.message}`)
  } finally {
    cdp.close()
    await fetch(`${CDP_HTTP}/json/close/${tab.id}`).catch(() => {})
    await sleep(300)
  }
}

const only = process.argv.slice(2)
for (const spec of SCREENS) {
  if (only.length && !only.some(o => spec.name.includes(o))) continue
  await shoot(spec)
}
console.log('done →', OUT)
