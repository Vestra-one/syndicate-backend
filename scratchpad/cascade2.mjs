import { writeFileSync, mkdirSync } from 'node:fs'
const APP = 'http://localhost:5173/?view=soon'
const OUT = '/Users/ay/syn-front/scratchpad/cascade'
mkdirSync(OUT, { recursive: true })
const CDP_HTTP = 'http://127.0.0.1:9222'
const HIDE = `(()=>{const s=document.createElement('style');s.id='h';s.textContent='.cs,.scene-vignette{display:none!important}';document.head.appendChild(s)})()`
function connect(wsUrl){return new Promise((resolve,reject)=>{const ws=new WebSocket(wsUrl);let id=0;const pending=new Map();const events=[];ws.onopen=()=>resolve({send:(m,p={})=>new Promise((res,rej)=>{const mid=++id;pending.set(mid,{res,rej});ws.send(JSON.stringify({id:mid,method:m,params:p}))}),events,close:()=>ws.close(),waitFor:(m,t)=>new Promise((res)=>{const t0=Date.now();const tick=()=>{if(events.some(e=>e.method===m))return res(true);if(Date.now()-t0>t)return res(false);setTimeout(tick,100)};tick()})});ws.onerror=e=>reject(new Error('ws '+e.message));ws.onmessage=m=>{const msg=JSON.parse(m.data);if(msg.id&&pending.has(msg.id)){const{res,rej}=pending.get(msg.id);pending.delete(msg.id);msg.error?rej(new Error(msg.error.message)):res(msg.result)}else if(msg.method)events.push(msg)}})}
const sleep=ms=>new Promise(r=>setTimeout(r,ms))
async function run(name, stages, inspect){
  const tab=await(await fetch(`${CDP_HTTP}/json/new?about:blank`,{method:'PUT'})).json()
  const cdp=await connect(tab.webSocketDebuggerUrl)
  try{
    await cdp.send('Page.enable');await cdp.send('Runtime.enable')
    await cdp.send('Page.navigate',{url:APP});await cdp.waitFor('Page.loadEventFired',15000);await sleep(4500)
    await cdp.send('Runtime.evaluate',{expression:HIDE})
    if(inspect)await cdp.send('Runtime.evaluate',{expression:`window.__inspect(${inspect})`})
    // report coin count via a probe on the group child count if exposed
    let pumped=0
    for(const[n,target]of stages){const step=target-pumped;if(step>0){await cdp.send('Runtime.evaluate',{expression:`window.__tableStep&&window.__tableStep(${step})`});pumped=target}
      await sleep(200)
      const shot=await cdp.send('Page.captureScreenshot',{format:'png'})
      writeFileSync(`${OUT}/${name}-${n}.png`,Buffer.from(shot.data,'base64'));console.log(`✓ ${name}-${n} (f${target})`)}
  }catch(e){console.log('✗',e.message)}finally{cdp.close();await fetch(`${CDP_HTTP}/json/close/${tab.id}`).catch(()=>{});await sleep(300)}
}
// default camera (what the user sees on the landing page)
await run('def',[['a20',20],['b50',50],['c110',110],['d300',300]], null)
// memory's known-good pot inspect
await run('pot',[['a20',20],['b50',50],['c110',110],['d300',300]], '0,1.9,2.7, 0,0.12,1.0')
console.log('done')
