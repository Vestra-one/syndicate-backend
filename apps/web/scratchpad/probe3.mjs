const CDP='http://127.0.0.1:9222'
function connect(u){return new Promise((res,rej)=>{const ws=new WebSocket(u);let id=0;const p=new Map();const ev=[];ws.onopen=()=>res({send:(m,pa={})=>new Promise((r,j)=>{const i=++id;p.set(i,{r,j});ws.send(JSON.stringify({id:i,method:m,params:pa}))}),ev,close:()=>ws.close(),wait:(m,t)=>new Promise(r=>{const t0=Date.now();const k=()=>{if(ev.some(e=>e.method===m))return r(1);if(Date.now()-t0>t)return r(0);setTimeout(k,80)};k()})});ws.onerror=e=>rej(e);ws.onmessage=x=>{const g=JSON.parse(x.data);if(g.id&&p.has(g.id)){const{r,j}=p.get(g.id);p.delete(g.id);g.error?j(new Error(g.error.message)):r(g.result)}else if(g.method)ev.push(g)}})}
const sleep=ms=>new Promise(r=>setTimeout(r,ms))
const tab=await(await fetch(`${CDP}/json/new?about:blank`,{method:'PUT'})).json()
const c=await connect(tab.webSocketDebuggerUrl)
await c.send('Page.enable');await c.send('Runtime.enable')
await c.send('Page.navigate',{url:'http://localhost:5173/?view=soon'});await c.wait('Page.loadEventFired',15000);await sleep(4500)
const ev=async e=>{const r=await c.send('Runtime.evaluate',{expression:e,returnByValue:true});return r.exceptionDetails?('EXC:'+JSON.stringify(r.exceptionDetails).slice(0,300)):r.result.value}
console.log('before:', await ev(`JSON.stringify(window.__potInfo())`))
console.log('setPot:', await ev(`(()=>{window.__setPot(2400);return 'ok'})()`))
await ev(`window.__tableStep(60)`)
console.log('after setPot+60:', await ev(`JSON.stringify(window.__potInfo())`))
c.close();await fetch(`${CDP}/json/close/${tab.id}`).catch(()=>{})
