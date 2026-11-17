import { writeFileSync } from 'node:fs'

const APP = 'http://localhost:5173/'
const OUT = '/Users/ay/syn-front/scratchpad'
const LIMITS = `{buyInMin:100000,buyInMax:1000000000,fillWindowMinSec:20,fillWindowMaxSec:86400}`

// Give the create panel multiple feeds so the PairSelector renders.
const setups = {
  'create-default': `window.__mockWaiting(); (() => {
    const st = window.__gameStore.getState();
    window.__gameStore.setState({
      seated:false, playMode:'create', fillDeadline:null, match:null,
      createLimits:${LIMITS},
      terms: { ...st.terms, priceFeedId:'BTC/USD', supportedFeeds:['BTC/USD','ETH/USD','SOL/USD'], buyIn:10000000, fillWindowSec:300, maxPlayers:5, rakeBps:250 },
    });
  })()`,
  'create-eth-25': `window.__mockWaiting(); (() => {
    const st = window.__gameStore.getState();
    window.__gameStore.setState({
      seated:false, playMode:'create', fillDeadline:null, match:null,
      createLimits:${LIMITS},
      terms: { ...st.terms, priceFeedId:'ETH/USD', supportedFeeds:['BTC/USD','ETH/USD','SOL/USD'], buyIn:25000000, fillWindowSec:900, maxPlayers:5, rakeBps:250 },
    });
  })()`,
}

const rpc = (ws, id, method, params) =>
  new Promise((res) => {
    const on = (e) => {
      const m = JSON.parse(e.data)
      if (m.id === id) { ws.removeEventListener('message', on); res(m.result) }
    }
    ws.addEventListener('message', on)
    ws.send(JSON.stringify({ id, method, params }))
  })

const version = await (await fetch('http://localhost:9222/json/version')).json()
const browserWs = version.webSocketDebuggerUrl

for (const [name, setup] of Object.entries(setups)) {
  const target = await (await fetch(`http://localhost:9222/json/new?${encodeURIComponent(APP)}`, { method: 'PUT' })).json()
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((r) => (ws.onopen = r))
  let id = 1
  await rpc(ws, id++, 'Page.enable')
  await rpc(ws, id++, 'Runtime.enable')
  await rpc(ws, id++, 'Page.navigate', { url: APP })
  await new Promise((r) => setTimeout(r, 4000))
  await rpc(ws, id++, 'Runtime.evaluate', { expression: setup })
  await new Promise((r) => setTimeout(r, 1200))
  const shot = await rpc(ws, id++, 'Page.captureScreenshot', { format: 'png' })
  writeFileSync(`${OUT}/${name}.png`, Buffer.from(shot.data, 'base64'))
  console.log('saved', name)
  await fetch(`http://localhost:9222/json/close/${target.id}`)
  ws.close()
}
process.exit(0)
