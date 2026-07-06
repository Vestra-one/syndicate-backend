const APP='http://localhost:5173/?view=soon', CDP='http://127.0.0.1:9222'
function connect(u){return new Promise((res,rej)=>{const ws=new WebSocket(u);let id=0;const p=new Map();const ev=[];ws.onopen=()=>res({send:(m,pa={})=>new Promise((r,j)=>{const i=++id;p.set(i,{r,j});ws.send(JSON.stringify({id:i,method:m,params:pa}))}),ev,close:()=>ws.close(),wait:(m,t)=>new Promise(r=>{const t0=Date.now();const k=()=>{if(ev.some(e=>e.method===m))return r(1);if(Date.now()-t0>t)return r(0);setTimeout(k,80)};k()})});ws.onerror=e=>rej(e);ws.onmessage=x=>{const g=JSON.parse(x.data);if(g.id&&p.has(g.id)){const{r,j}=p.get(g.id);p.delete(g.id);g.error?j(new Error(g.error.message)):r(g.result)}else if(g.method)ev.push(g)}})}
const sleep=ms=>new Promise(r=>setTimeout(r,ms))
const tab=await(await fetch(`${CDP}/json/new?about:blank`,{method:'PUT'})).json()
const c=await connect(tab.webSocketDebuggerUrl)
await c.send('Page.enable');await c.send('Runtime.enable')
await c.send('Page.navigate',{url:APP});await c.wait('Page.loadEventFired',15000);await sleep(4500)
const ev=async e=>{const r=await c.send('Runtime.evaluate',{expression:e,returnByValue:true});return r.exceptionDetails?('EXC:'+JSON.stringify(r.exceptionDetails).slice(0,300)):r.result.value}
// 1) settle the on-load (silent, muted) pour
await ev(`window.__tableStep(320)`)
console.log('default muted:', await ev(`window.__audio.muted()`))
console.log('clinks during muted on-load pour (should be 0):', await ev(`window.__audio.clinks`))
console.log('aria-pressed initial (should be true=muted):', await ev(`document.querySelector('.cs-mute').getAttribute('aria-pressed')`))
// 2) click the button to UNMUTE -> should fire replay
await ev(`document.querySelector('.cs-mute').click()`)
await sleep(200)
console.log('muted after click (should be false):', await ev(`window.__audio.muted()`))
console.log('ctx state after unmute (want running):', await ev(`window.__audio.state()`))
console.log('replays fired (want 1):', await ev(`window.__audio.replays`))
// 3) pump the replayed pour -> clinks should accumulate now
await ev(`window.__tableStep(320)`)
console.log('clinks after replayed pour (want many, ~70):', await ev(`window.__audio.clinks`))
const errs=c.ev.filter(e=>e.method==='Runtime.exceptionThrown'||(e.method==='Runtime.consoleAPICalled'&&e.params.type==='error'))
console.log('runtime errors:', errs.length); errs.slice(0,3).forEach(e=>console.log('  -',JSON.stringify(e.params).slice(0,180)))
c.close();await fetch(`${CDP}/json/close/${tab.id}`).catch(()=>{})
