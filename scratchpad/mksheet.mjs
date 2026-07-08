import { readdirSync, writeFileSync, statSync } from 'node:fs'
const ROOT = '/Users/ay/syn-front/design-audit/screenshots'
const feats = readdirSync(ROOT).filter(f => statSync(`${ROOT}/${f}`).isDirectory()).sort()
let html = `<!doctype html><meta charset=utf8><title>Satoshi's Table — Design Audit contact sheet</title>
<style>body{background:#05030a;color:#f3e4c4;font:14px system-ui;margin:0;padding:32px}
h1{font-family:Georgia,serif;color:#f3d98a}h2{color:#caa23f;border-bottom:1px solid rgba(202,162,63,.28);padding-bottom:6px;margin-top:40px}
.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:16px}
figure{margin:0}img{width:100%;border:1px solid rgba(202,162,63,.2);border-radius:8px;display:block}
figcaption{color:#b59b6e;font-size:12px;margin-top:6px;text-align:center}
.vp{display:grid;grid-template-columns:2fr 1fr 1fr;gap:12px;align-items:start;margin-bottom:8px}</style>
<h1>Satoshi's Table — Design Audit contact sheet</h1><p style="color:#6f5d3e">20 states × desktop / tablet / mobile · 2026-07-07</p>`
for (const feat of feats) {
  html += `<h2>${feat}</h2>`
  const files = readdirSync(`${ROOT}/${feat}`).filter(f => f.endsWith('.png'))
  const bases = [...new Set(files.map(f => f.replace(/-(desktop|tablet|mobile)\.png$/, '')))].sort()
  for (const b of bases) {
    html += `<div class=vp>`
    for (const vp of ['desktop','tablet','mobile']) {
      const f = `${b}-${vp}.png`
      if (files.includes(f)) html += `<figure><img src="${feat}/${f}"><figcaption>${b} · ${vp}</figcaption></figure>`
      else html += `<div></div>`
    }
    html += `</div>`
  }
}
writeFileSync(`${ROOT}/index.html`, html)
console.log('wrote', `${ROOT}/index.html`, '·', feats.length, 'features')
