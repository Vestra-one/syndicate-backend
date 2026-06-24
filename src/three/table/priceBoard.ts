import * as THREE from 'three'
import { useGameStore } from '@/store/gameStore'
import type { PriceTick } from '@/lib/types'

/**
 * The price-board cabinet that stands on the felt: a real 3D housing (beveled
 * frame, dark sides, gold rim, base plinth) that catches the room's candlelight
 * and casts a shadow, with a clean, minimal live BTC/USD chart on its screen —
 * focused on price and time, no ornament.
 *
 * The screen reads live ticks straight from the game store, so it tracks the
 * same feed the rest of the app uses.
 *
 * Local space: origin centred on the cabinet face, +y up, front toward +z.
 */
export interface PriceBoardHandle {
  group: THREE.Group
  update: (t: number) => void
  dispose: () => void
}

export function createPriceBoard(): PriceBoardHandle {
  const group = new THREE.Group()

  // cabinet face dimensions (local units)
  const W = 4.8
  const H = 3.2
  const hw = W / 2
  const hh = H / 2
  const DEPTH = 0.4
  const BEZEL = 0.2

  // ---- materials ----
  const shellMat = new THREE.MeshStandardMaterial({
    color: 0x1b130c,
    metalness: 0.45,
    roughness: 0.5,
    envMapIntensity: 0.7,
  })
  const goldMat = new THREE.MeshStandardMaterial({
    color: 0xb89149,
    metalness: 1.0,
    roughness: 0.34,
    envMapIntensity: 1.4,
  })

  // ---- cabinet body (rounded-rect beveled slab) ----
  const shape = new THREE.Shape()
  const r = 0.14
  const bx = hw
  const by = hh
  shape.moveTo(-bx + r, -by)
  shape.lineTo(bx - r, -by)
  shape.quadraticCurveTo(bx, -by, bx, -by + r)
  shape.lineTo(bx, by - r)
  shape.quadraticCurveTo(bx, by, bx - r, by)
  shape.lineTo(-bx + r, by)
  shape.quadraticCurveTo(-bx, by, -bx, by - r)
  shape.lineTo(-bx, -by + r)
  shape.quadraticCurveTo(-bx, -by, -bx + r, -by)
  const body = new THREE.Mesh(
    new THREE.ExtrudeGeometry(shape, {
      depth: DEPTH,
      bevelEnabled: true,
      bevelThickness: 0.05,
      bevelSize: 0.06,
      bevelSegments: 3,
    }),
    shellMat,
  )
  body.position.z = -DEPTH / 2
  body.castShadow = true
  body.receiveShadow = true
  group.add(body)

  // ---- live chart screen ----
  const SCW = 1180
  const SCH = Math.round((SCW * (H - 2 * BEZEL)) / (W - 2 * BEZEL))
  const screenCanvas = document.createElement('canvas')
  screenCanvas.width = SCW
  screenCanvas.height = SCH
  const cx = screenCanvas.getContext('2d')!
  cx.fillStyle = '#0a0e13'
  cx.fillRect(0, 0, SCW, SCH) // seed so the CanvasTexture uploads with content
  const screenTex = new THREE.CanvasTexture(screenCanvas)
  screenTex.colorSpace = THREE.SRGBColorSpace
  screenTex.anisotropy = 16
  const screen = new THREE.Mesh(
    new THREE.PlaneGeometry(W - 2 * BEZEL, H - 2 * BEZEL),
    new THREE.MeshStandardMaterial({
      emissiveMap: screenTex,
      emissive: 0xffffff,
      emissiveIntensity: 1.0,
      color: 0x000000,
      metalness: 0,
      roughness: 0.6,
    }),
  )
  screen.position.z = DEPTH / 2 + 0.01
  group.add(screen)

  // ---- slim gold rim around the screen ----
  const rimT = 0.06
  const rimZ = DEPTH / 2 + 0.03
  const sw = W - 2 * BEZEL
  const sh = H - 2 * BEZEL
  const mkBar = (w: number, h: number, x: number, y: number) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, rimT * 1.4), goldMat)
    m.position.set(x, y, rimZ)
    m.castShadow = true
    group.add(m)
  }
  mkBar(sw + rimT * 2, rimT, 0, sh / 2 + rimT / 2)
  mkBar(sw + rimT * 2, rimT, 0, -sh / 2 - rimT / 2)
  mkBar(rimT, sh + rimT * 2, -sw / 2 - rimT / 2, 0)
  mkBar(rimT, sh + rimT * 2, sw / 2 + rimT / 2, 0)

  // ---- base plinth so it sits believably on the felt ----
  const base = new THREE.Mesh(new THREE.BoxGeometry(W * 1.08, 0.34, DEPTH + 0.45), shellMat)
  base.position.set(0, -hh - 0.17, 0)
  base.castShadow = true
  base.receiveShadow = true
  group.add(base)
  const baseBand = new THREE.Mesh(new THREE.BoxGeometry(W * 1.08, 0.04, DEPTH + 0.46), goldMat)
  baseBand.position.set(0, -hh - 0.01, 0)
  group.add(baseBand)

  // ================= minimal live chart =================
  const PAD = { l: 18, r: 96, t: 96, b: 50 }
  const fmtPrice = (v: number) =>
    v >= 1000
      ? v.toLocaleString('en-US', { maximumFractionDigits: 0 })
      : v.toLocaleString('en-US', { maximumFractionDigits: 2 })
  const fmtTime = (ts: number) => {
    const d = new Date(ts)
    const hh2 = d.getHours().toString().padStart(2, '0')
    const mm = d.getMinutes().toString().padStart(2, '0')
    return `${hh2}:${mm}`
  }

  function drawChart(history: PriceTick[], price: number | null) {
    cx.clearRect(0, 0, SCW, SCH)
    // background
    const bg = cx.createLinearGradient(0, 0, 0, SCH)
    bg.addColorStop(0, '#0b1016')
    bg.addColorStop(1, '#070a0e')
    cx.fillStyle = bg
    cx.fillRect(0, 0, SCW, SCH)

    const gx0 = PAD.l
    const gx1 = SCW - PAD.r
    const gy0 = PAD.t
    const gy1 = SCH - PAD.b

    const accent = '#e9a23b'
    const muted = 'rgba(150,166,182,0.7)'
    const faint = 'rgba(150,170,190,0.10)'
    const sans = "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"

    // header — focus on price
    cx.textBaseline = 'alphabetic'
    cx.textAlign = 'left'
    cx.fillStyle = muted
    cx.font = `600 22px ${sans}`
    cx.fillText('B T C   /   U S D', gx0 + 4, 40)

    const pts = history.filter((h) => Number.isFinite(h.price))
    if (pts.length < 2 || price == null) {
      cx.fillStyle = 'rgba(180,196,212,0.5)'
      cx.font = `500 26px ${sans}`
      cx.textAlign = 'center'
      cx.fillText('awaiting price feed…', SCW / 2, SCH / 2)
      screenTex.needsUpdate = true
      return
    }

    const prices = pts.map((p) => p.price)
    const lo = Math.min(...prices)
    const hi = Math.max(...prices)
    const span = hi - lo || hi * 0.001 || 1
    const padv = span * 0.18
    const vmin = lo - padv
    const vmax = hi + padv
    const t0 = pts[0].ts
    const t1 = pts[pts.length - 1].ts
    const tspan = t1 - t0 || 1
    const toX = (ts: number) => gx0 + ((ts - t0) / tspan) * (gx1 - gx0)
    const toY = (v: number) => gy1 - ((v - vmin) / (vmax - vmin)) * (gy1 - gy0)

    const first = prices[0]
    const change = ((price - first) / first) * 100
    const up = change >= 0

    // big current price + change
    cx.textAlign = 'left'
    cx.fillStyle = '#f2f6fa'
    cx.font = `600 52px ${sans}`
    cx.fillText(`$${fmtPrice(price)}`, gx0 + 4, 84)
    cx.fillStyle = up ? '#46d18b' : '#f06a6a'
    cx.font = `600 24px ${sans}`
    const pm = `${up ? '▲' : '▼'} ${up ? '+' : ''}${change.toFixed(2)}%`
    const pw = cx.measureText(`$${fmtPrice(price)}`).width
    cx.fillText(pm, gx0 + 4 + pw + 22, 80)

    // horizontal grid + price axis (right)
    cx.textBaseline = 'middle'
    cx.font = `500 19px ${sans}`
    const rows = 4
    for (let i = 0; i <= rows; i++) {
      const v = vmin + ((vmax - vmin) * i) / rows
      const gy = toY(v)
      cx.strokeStyle = faint
      cx.lineWidth = 1
      cx.beginPath()
      cx.moveTo(gx0, gy)
      cx.lineTo(gx1, gy)
      cx.stroke()
      cx.fillStyle = muted
      cx.textAlign = 'left'
      cx.fillText(fmtPrice(v), gx1 + 12, gy)
    }

    // vertical grid + time axis (bottom)
    cx.textBaseline = 'top'
    const cols = 4
    for (let i = 0; i <= cols; i++) {
      const ts = t0 + (tspan * i) / cols
      const gx = toX(ts)
      cx.strokeStyle = faint
      cx.lineWidth = 1
      cx.beginPath()
      cx.moveTo(gx, gy0)
      cx.lineTo(gx, gy1)
      cx.stroke()
      cx.fillStyle = muted
      cx.textAlign = i === 0 ? 'left' : i === cols ? 'right' : 'center'
      cx.fillText(fmtTime(ts), gx, gy1 + 12)
    }

    // area fill under the line
    cx.beginPath()
    cx.moveTo(toX(pts[0].ts), gy1)
    for (const p of pts) cx.lineTo(toX(p.ts), toY(p.price))
    cx.lineTo(toX(t1), gy1)
    cx.closePath()
    const area = cx.createLinearGradient(0, gy0, 0, gy1)
    area.addColorStop(0, 'rgba(233,162,59,0.22)')
    area.addColorStop(1, 'rgba(233,162,59,0)')
    cx.fillStyle = area
    cx.fill()

    // the price line
    cx.beginPath()
    cx.moveTo(toX(pts[0].ts), toY(pts[0].price))
    for (const p of pts) cx.lineTo(toX(p.ts), toY(p.price))
    cx.strokeStyle = accent
    cx.lineWidth = 2.4
    cx.lineJoin = 'round'
    cx.lineCap = 'round'
    cx.save()
    cx.shadowColor = 'rgba(233,162,59,0.55)'
    cx.shadowBlur = 10
    cx.stroke()
    cx.restore()

    // latest point: guide line + dot + label pill
    const lx = toX(t1)
    const ly = toY(price)
    cx.strokeStyle = 'rgba(233,162,59,0.35)'
    cx.lineWidth = 1
    cx.setLineDash([5, 5])
    cx.beginPath()
    cx.moveTo(gx0, ly)
    cx.lineTo(gx1, ly)
    cx.stroke()
    cx.setLineDash([])
    cx.fillStyle = accent
    cx.beginPath()
    cx.arc(lx, ly, 5, 0, Math.PI * 2)
    cx.fill()
    cx.fillStyle = 'rgba(255,255,255,0.9)'
    cx.beginPath()
    cx.arc(lx, ly, 2, 0, Math.PI * 2)
    cx.fill()
    // current price pill on the right axis
    cx.fillStyle = accent
    const pill = fmtPrice(price)
    cx.font = `600 19px ${sans}`
    const pillW = cx.measureText(pill).width + 16
    cx.fillRect(gx1 + 6, ly - 15, pillW, 30)
    cx.fillStyle = '#1a1206'
    cx.textBaseline = 'middle'
    cx.textAlign = 'left'
    cx.fillText(pill, gx1 + 14, ly + 1)

    screenTex.needsUpdate = true
  }

  // initial paint + throttled live updates
  let lastDraw = -1
  const refresh = () => {
    const s = useGameStore.getState()
    if ((globalThis as { __pbLog?: number }).__pbLog !== s.priceHistory.length) {
      ;(globalThis as { __pbLog?: number }).__pbLog = s.priceHistory.length
      console.log('[priceBoard] history', s.priceHistory.length, 'price', s.price, 'status', s.status)
    }
    drawChart(s.priceHistory, s.price)
  }
  refresh()

  function update(t: number) {
    if (lastDraw < 0 || t - lastDraw > 0.12) {
      lastDraw = t
      refresh()
    }
  }

  function dispose() {
    group.traverse((o) => {
      const m = o as THREE.Mesh
      if (m.geometry) m.geometry.dispose()
      const mat = m.material
      if (Array.isArray(mat)) mat.forEach((x) => x.dispose())
      else if (mat) mat.dispose()
    })
    screenTex.dispose()
  }

  return { group, update, dispose }
}
