import { writeFileSync } from 'node:fs'
const APP='http://localhost:5173/?view=soon', CDP='http://127.0.0.1:9222', OUT='/Users/ay/syn-front/scratchpad/cascade'
function connect(u){return new Promise((res,rej)=>{const ws=new WebSocket(u);let id=0;const p=new Map();const ev=[];ws.onopen=()=>res({send:(m,pa={})=>new Promise((r,j)=>{const i=++id;p.set(i,{r,j});ws.send(JSON.stringify({id:i,method:m,params:pa}))}),ev,close:()=>ws.close(),wait:(m,t)=>new Promise(r=>{const t0=Date.now();const k=()=>{if(ev.some(e=>e.method===m))return r(1);if(Date.now()-t0>t)return r(0);setTimeout(k,80)};k()})});ws.onerror=e=>rej(e);ws.onmessage=x=>{const g=JSON.parse(x.data);if(g.id&&p.has(g.id)){const{r,j}=p.get(g.id);p.delete(g.id);g.error?j(new Error(g.error.message)):r(g.result)}else if(g.method)ev.push(g)}})}
const sleep=ms=>new Promise(r=>setTimeout(r,ms))
const tab=await(await fetch(`${CDP}/json/new?about:blank`,{method:'PUT'})).json()
const c=await connect(tab.webSocketDebuggerUrl)
await c.send('Page.enable');await c.send('Runtime.enable')
await c.send('Page.navigate',{url:APP});await c.wait('Page.loadEventFired',15000);await sleep(4500)
await c.send('Runtime.evaluate',{expression:`window.__tableStep&&window.__tableStep(300)`});await sleep(300)
const shot=await c.send('Page.captureScreenshot',{format:'png'})
writeFileSync(`${OUT}/landing-full.png`,Buffer.from(shot.data,'base64'));console.log('✓ landing-full')
c.close();await fetch(`${CDP}/json/close/${tab.id}`).catch(()=>{})
