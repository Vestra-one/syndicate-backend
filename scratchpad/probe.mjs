const CDP='http://127.0.0.1:9222'
const tab=await(await fetch(`${CDP}/json/new?about:blank`,{method:'PUT'})).json()
const ws=new WebSocket(tab.webSocketDebuggerUrl)
let id=0;const p=new Map()
const send=(m,pr={})=>new Promise((r)=>{const i=++id;p.set(i,r);ws.send(JSON.stringify({id:i,method:m,params:pr}))})
ws.onmessage=(m)=>{const j=JSON.parse(m.data);if(j.id&&p.has(j.id)){p.get(j.id)(j.result);p.delete(j.id)}}
await new Promise(r=>ws.onopen=r)
await send('Page.enable');await send('Runtime.enable')
await send('Page.navigate',{url:'http://localhost:5173/?view=app'})
await new Promise(r=>setTimeout(r,6000))
const seed=`(()=>{const now=Date.now();window.__gameStore.setState({discoveryStatus:'ready',upcomingGames:[{matchId:'up-1',feed:'BTC/USD',buyIn:10000000,entryFee:500000,seated:2,maxPlayers:5,minPlayers:3,fillDeadline:now+90000}],activeGames:[{matchId:'live-1',feed:'BTC/USD',buyIn:10000000,potSize:86500000,spectators:12,actionsPerMin:9,startedAt:now-420000}]});return 'seeded';})()`
console.log('seed:',(await send('Runtime.evaluate',{expression:seed})).result)
await new Promise(r=>setTimeout(r,300))
const probe=`(()=>{const s=window.__gameStore.getState();return JSON.stringify({view:s.view,status:s.discoveryStatus,up:s.upcomingGames.length,act:s.activeGames.length});})()`
console.log('t+300ms:',(await send('Runtime.evaluate',{expression:probe})).result.value)
await new Promise(r=>setTimeout(r,2000))
console.log('t+2.3s:',(await send('Runtime.evaluate',{expression:probe})).result.value)
await fetch(`${CDP}/json/close/${tab.id}`)
process.exit(0)
