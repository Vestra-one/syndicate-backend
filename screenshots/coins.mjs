// Focused capture of the per-seat coin stacks + committed piles + pot label.
import { writeFileSync, mkdirSync } from 'node:fs'

const APP = 'http://localhost:5173/'
const OUT = process.env.OUT_DIR || '/Users/ay/syn-front/screenshots/coins'
mkdirSync(OUT, { recursive: true })
const CDP_HTTP = 'http://127.0.0.1:9222'

const seedEthChart = `(() => {
  const st = window.__gameStore.getState();
  const hist = st.priceHistory;
  const base = hist.length ? hist[hist.length - 1].price : 62514;
  const now = Date.now();
  const pts = [];
  let p = base * 0.9985;
  for (let i = 600; i > 0; i--) { p += base * (Math.sin(i*0.045)*0.00008 + (Math.random()-0.5)*0.00025); pts.push({ price: p, ts: now - i*500 }); }
  pts[pts.length-1].price = base;
  window.__gameStore.setState({ priceHistory: pts });
})()`

const HIDE = `(() => { const s=document.createElement('style'); s.id='hidehud'; s.textContent='.hud,.scene-vignette{display:none!important}'; document.head.appendChild(s); })()`
const SHOW = `(() => { const e=document.getElementById('hidehud'); if(e) e.remove(); })()`

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl)
    let id = 0; const pending = new Map(); const events = []
    ws.onopen = () => resolve({
      send: (method, params = {}) => new Promise((res, rej) => { const mid = ++id; pending.set(mid, { res, rej }); ws.send(JSON.stringify({ id: mid, method, params })) }),
      events, close: () => ws.close(),
      waitFor: (method, timeoutMs) => new Promise((res) => { const t0 = Date.now(); const tick = () => { if (events.some(e => e.method === method)) return res(true); if (Date.now()-t0>timeoutMs) return res(false); setTimeout(tick,100) }; tick() }),
    })
    ws.onerror = (e) => reject(new Error('ws error: ' + e.message))
    ws.onmessage = (m) => { const msg = JSON.parse(m.data); if (msg.id && pending.has(msg.id)) { const { res, rej } = pending.get(msg.id); pending.delete(msg.id); msg.error ? rej(new Error(msg.error.message)) : res(msg.result) } else if (msg.method) events.push(msg) }
  })
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

async function shoot(name, { setup, pump = 150, evalAfter, pumpAfter = 60 } = {}) {
  const tab = await (await fetch(`${CDP_HTTP}/json/new?about:blank`, { method: 'PUT' })).json()
  const cdp = await connect(tab.webSocketDebuggerUrl)
  const logs = []
  try {
    await cdp.send('Page.enable'); await cdp.send('Runtime.enable')
    await cdp.send('Page.navigate', { url: APP })
    await cdp.waitFor('Page.loadEventFired', 15000)
    await sleep(4500)
    if (setup) { const r = await cdp.send('Runtime.evaluate', { expression: setup, awaitPromise: true }); if (r.exceptionDetails) logs.push('SETUP: ' + JSON.stringify(r.exceptionDetails).slice(0, 400)) }
    await sleep(1500)
    if (pump) { const r = await cdp.send('Runtime.evaluate', { expression: `window.__tableStep && window.__tableStep(${pump})` }); if (r.exceptionDetails) logs.push('PUMP: ' + JSON.stringify(r.exceptionDetails).slice(0, 300)) }
    if (evalAfter) { await cdp.send('Runtime.evaluate', { expression: evalAfter }); await cdp.send('Runtime.evaluate', { expression: `window.__tableStep && window.__tableStep(${pumpAfter})` }) }
    await sleep(400)
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' })
    writeFileSync(`${OUT}/${name}.png`, Buffer.from(shot.data, 'base64'))
    for (const e of cdp.events) {
      if (e.method === 'Runtime.exceptionThrown') logs.push('EXC: ' + JSON.stringify(e.params.exceptionDetails).slice(0, 400))
      if (e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error') logs.push('ERR: ' + (e.params.args || []).map(a => a.value ?? a.description ?? '').join(' ').slice(0, 300))
    }
    console.log(`✓ ${name}${logs.length ? '  [' + logs.length + ']' : ''}`)
    if (logs.length) writeFileSync(`${OUT}/${name}.log`, logs.join('\n'))
  } catch (err) { console.log(`✗ ${name}: ${err.message}`) }
  finally { cdp.close(); await fetch(`${CDP_HTTP}/json/close/${tab.id}`).catch(() => {}); await sleep(300) }
}

const live = `window.__mockLive(0); ${seedEthChart}`
const only = process.argv.slice(2)
const want = (n) => !only.length || only.some((o) => n.includes(o))
const run = async (n, opts) => { if (want(n)) await shoot(n, opts) }

await run('01-full', { setup: live })
await run('02-nohud', { setup: `${live}; ${HIDE}` })
await run('03-inspect-pot', { setup: `${live}; ${HIDE}`, evalAfter: `window.__inspect(0,1.9,3.4, 0,0.2,0.9)` })
await run('04-inspect-you', { setup: `${live}; ${HIDE}`, evalAfter: `window.__inspect(0,1.6,4.2, 0,0.2,2.4)` })
// Raise mid-slide: seat 1 (front-left) moves 3 coins stack→committed; capture ~10 frames in.
const raise = `(() => { const m = window.__gameStore.getState().match; const seats = m.seats.map(s => s.seat===1 ? {...s, stack: s.stack - 1500000, committedThisStreet: s.committedThisStreet + 1500000} : s); window.__gameStore.setState({ match: {...m, seats} }); })()`
await run('05-raise-midslide', { setup: `${live}; ${HIDE}`, evalAfter: raise, pumpAfter: 11 })
// All-in ribbon (HUD): seat 2 shoves.
const allin = `(() => { const m = window.__gameStore.getState().match; const seats = m.seats.map(s => s.seat===2 ? {...s, allIn:true, committedThisStreet: s.stack + s.committedThisStreet, stack:0} : s); window.__gameStore.setState({ match: {...m, seats} }); })()`
await run('06-allin', { setup: live, evalAfter: allin, pumpAfter: 40 })
// Knock ripple (no HUD): append a check event for seat 1 → fires handle.knock; catch mid-expansion.
const knock = `(() => { const st = window.__gameStore.getState(); const ev = { kind:'action', matchId:'mock', seat:1, action:'check', amount:0, feedPrice: st.match.feedPrice, pot: st.match.pot, ts: Date.now() }; window.__gameStore.setState({ feed: [...st.feed, ev] }); })()`
await run('07-knock', { setup: `${live}; ${HIDE}`, evalAfter: knock, pumpAfter: 9 })
// Win slide (no HUD): award the pot to seat 0 (you, front) directly via the dev
// hook so the crash-prone Resolution HUD never mounts; pot streams home.
await run('08-win-midslide', { setup: `${live}; ${HIDE}`, evalAfter: `window.__awardPot(0)`, pumpAfter: 13 })
// Knock ripple close-up: inspect seat 1 (far-left), knock, catch mid-expansion.
await run('09-knock-closeup', { setup: `${live}; ${HIDE}; window.__inspect(-1.9,1.35,2.5, -2.35,0.05,0.5)`, evalAfter: `window.__knock(1)`, pumpAfter: 12 })
console.log('done →', OUT)
