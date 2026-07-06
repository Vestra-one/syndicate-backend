// Capture the landing-page coin pour (?view=soon) at several stages.
import { writeFileSync, mkdirSync } from 'node:fs'

const APP = 'http://localhost:5173/?view=soon'
const OUT = '/Users/ay/syn-front/scratchpad/cascade'
mkdirSync(OUT, { recursive: true })
const CDP_HTTP = 'http://127.0.0.1:9222'

// hide the ComingSoon overlay + vignette so we judge the 3D pour alone
const HIDE = `(()=>{const s=document.createElement('style');s.id='h';s.textContent='.cs,.scene-vignette{display:none!important}';document.head.appendChild(s)})()`

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

// One tab, pumped in increments, capturing a frame at each checkpoint so we see
// the SAME pour evolve (the pour is time-gated on the scene clock, advanced only
// by __tableStep in headless).
async function run(stages, { inspect } = {}) {
  const tab = await (await fetch(`${CDP_HTTP}/json/new?about:blank`, { method: 'PUT' })).json()
  const cdp = await connect(tab.webSocketDebuggerUrl)
  const logs = []
  try {
    await cdp.send('Page.enable'); await cdp.send('Runtime.enable')
    await cdp.send('Page.navigate', { url: APP })
    await cdp.waitFor('Page.loadEventFired', 15000)
    await sleep(4500)
    await cdp.send('Runtime.evaluate', { expression: HIDE })
    if (inspect) await cdp.send('Runtime.evaluate', { expression: `window.__inspect(${inspect})` })
    // Reset the pour to frame 0 by re-seeding the pot? Not needed — RAF is
    // throttled so t≈0; we pump from here. Capture cumulative checkpoints.
    let pumped = 0
    for (const [name, target] of stages) {
      const step = target - pumped
      if (step > 0) { await cdp.send('Runtime.evaluate', { expression: `window.__tableStep && window.__tableStep(${step})` }); pumped = target }
      await sleep(250)
      const shot = await cdp.send('Page.captureScreenshot', { format: 'png' })
      writeFileSync(`${OUT}/${name}.png`, Buffer.from(shot.data, 'base64'))
      console.log(`✓ ${name}  (frame ${target})`)
    }
    for (const e of cdp.events) {
      if (e.method === 'Runtime.exceptionThrown') logs.push('EXC: ' + JSON.stringify(e.params.exceptionDetails).slice(0, 400))
      if (e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error') logs.push('ERR: ' + (e.params.args || []).map(a => a.value ?? a.description ?? '').join(' ').slice(0, 300))
    }
    if (logs.length) { writeFileSync(`${OUT}/errors.log`, logs.join('\n')); console.log('  [logs]', logs.length) }
  } catch (err) { console.log('✗', err.message) }
  finally { cdp.close(); await fetch(`${CDP_HTTP}/json/close/${tab.id}`).catch(() => {}); await sleep(300) }
}

// Inspect camera close on the pot; frame checkpoints across the ~2.5s pour.
await run([
  ['01-f20', 20], ['02-f45', 45], ['03-f80', 80], ['04-f140', 140], ['05-f300', 300],
], { inspect: '0,1.9,3.4, 0,0.2,0.9' })
console.log('done →', OUT)
