import * as THREE from 'three'
import { useGameStore } from '@/store/gameStore'
import type { PriceTick } from '@/lib/types'

/**
 * The price-board cabinet that stands on the felt: a real 3D housing (a beveled
 * frame with an open screen well, dark sides, gold rim, base plinth) that catches
 * the room's candlelight and casts a shadow, with a clean, minimal live BTC/USD
 * chart recessed into it — focused on price and time, no ornament.
 *
 * The screen reads live ticks straight from the game store, so it tracks the
 * same feed the rest of the app uses.
 *
 * Local space: origin centred on the cabinet front face, +y up, front toward +z.
 */
export interface PriceBoardHandle {
  group: THREE.Group
  update: (t: number) => void
  dispose: () => void
}

/** trace a centred rounded rectangle onto a Shape or Path */
function roundRect(p: THREE.Shape | THREE.Path, halfW: number, halfH: number, r: number) {
  p.moveTo(-halfW + r, -halfH)
  p.lineTo(halfW - r, -halfH)
  p.quadraticCurveTo(halfW, -halfH, halfW, -halfH + r)
  p.lineTo(halfW, halfH - r)
  p.quadraticCurveTo(halfW, halfH, halfW - r, halfH)
  p.lineTo(-halfW + r, halfH)
  p.quadraticCurveTo(-halfW, halfH, -halfW, halfH - r)
  p.lineTo(-halfW, -halfH + r)
  p.quadraticCurveTo(-halfW, -halfH, -halfW + r, -halfH)
}

export function createPriceBoard(): PriceBoardHandle {
  const group = new THREE.Group()

  // cabinet face dimensions (local units)
  const W = 7.1
  const H = 3.2
  const hw = W / 2
  const hh = H / 2
  const DEPTH = 0.4
  const BEZEL = 0.26
  const shw = hw - BEZEL // screen half-width
  const shh = hh - BEZEL // screen half-height

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

  // ---- cabinet frame: rounded-rect outline with a screen opening ----
  const outline = new THREE.Shape()
  roundRect(outline, hw, hh, 0.14)
  const hole = new THREE.Path()
  roundRect(hole, shw, shh, 0.07)
  outline.holes.push(hole)
  const frame = new THREE.Mesh(
    new THREE.ExtrudeGeometry(outline, {
      depth: DEPTH,
      bevelEnabled: true,
      bevelThickness: 0.04,
      bevelSize: 0.05,
      bevelSegments: 3,
    }),
    shellMat,
  )
  frame.position.z = -DEPTH // front face sits at z = 0
  frame.castShadow = true
  frame.receiveShadow = true
  group.add(frame)

  // ---- back panel closing the cabinet behind the screen ----
  const backPanel = new THREE.Mesh(new THREE.BoxGeometry(W * 0.94, H * 0.94, 0.06), shellMat)
  backPanel.position.z = -DEPTH + 0.04
  backPanel.receiveShadow = true
  group.add(backPanel)

  // ---- live chart screen, recessed into the opening ----
  const SCW = 1280
  const SCH = Math.round((SCW * shh) / shw)
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
    new THREE.PlaneGeometry(shw * 2 + 0.04, shh * 2 + 0.04),
    new THREE.MeshBasicMaterial({ map: screenTex }),
  )
  screen.position.z = -0.05 // recessed behind the front face, seen through the well
  group.add(screen)

  // ---- slim gold rim around the screen opening ----
  const rimT = 0.05
  const rimZ = 0.02
  const mkBar = (w: number, h: number, x: number, y: number) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, rimT * 1.4), goldMat)
    m.position.set(x, y, rimZ)
    m.castShadow = true
    group.add(m)
  }
  mkBar(shw * 2 + rimT * 2, rimT, 0, shh + rimT / 2)
  mkBar(shw * 2 + rimT * 2, rimT, 0, -shh - rimT / 2)
  mkBar(rimT, shh * 2 + rimT * 2, -shw - rimT / 2, 0)
  mkBar(rimT, shh * 2 + rimT * 2, shw + rimT / 2, 0)

  // ---- base plinth so it sits believably on the felt ----
  const base = new THREE.Mesh(new THREE.BoxGeometry(W * 1.08, 0.34, DEPTH + 0.45), shellMat)
  base.position.set(0, -hh - 0.17, -DEPTH / 2)
  base.castShadow = true
  base.receiveShadow = true
  group.add(base)
  const baseBand = new THREE.Mesh(new THREE.BoxGeometry(W * 1.08, 0.04, DEPTH + 0.46), goldMat)
  baseBand.position.set(0, -hh - 0.01, -DEPTH / 2)
  group.add(baseBand)

  // ================= minimal live chart =================
  const PAD = { l: 18, r: 98, t: 98, b: 52 }
  const fmtPrice = (v: number) =>
    v >= 1000
      ? v.toLocaleString('en-US', { maximumFractionDigits: 0 })
      : v.toLocaleString('en-US', { maximumFractionDigits: 2 })
  const fmtTime = (ts: number) => {
    const d = new Date(ts)
    return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`
  }

  function drawChart(history: PriceTick[], price: number | null) {
    cx.clearRect(0, 0, SCW, SCH)
    const bg = cx.createLinearGradient(0, 0, 0, SCH)
    bg.addColorStop(0, '#0b1016')
    bg.addColorStop(1, '#060a0e')
    cx.fillStyle = bg
    cx.fillRect(0, 0, SCW, SCH)

    const gx0 = PAD.l
    const gx1 = SCW - PAD.r
    const gy0 = PAD.t
    const gy1 = SCH - PAD.b
    const accent = '#e9a23b'
    const muted = 'rgba(156,172,188,0.72)'
    const faint = 'rgba(150,170,190,0.10)'
    const sans = "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"

    cx.textBaseline = 'alphabetic'
    cx.textAlign = 'left'
    cx.fillStyle = muted
    cx.font = `600 22px ${sans}`
    cx.fillText('B T C   /   U S D', gx0 + 4, 42)

    const pts = history.filter((h) => Number.isFinite(h.price))
    if (pts.length < 2 || price == null) {
      cx.fillStyle = 'rgba(180,196,212,0.55)'
      cx.font = `500 28px ${sans}`
      cx.textAlign = 'center'
      cx.fillText('awaiting price feed…', SCW / 2, SCH / 2)
      screenTex.needsUpdate = true
      return
    }

    const prices = pts.map((p) => p.price)
    const lo = Math.min(...prices)
    const hi = Math.max(...prices)
    const span = hi - lo || hi * 0.001 || 1
    const vmin = lo - span * 0.2
    const vmax = hi + span * 0.2
    const t0 = pts[0].ts
    const t1 = pts[pts.length - 1].ts
    const tspan = t1 - t0 || 1
    const toX = (ts: number) => gx0 + ((ts - t0) / tspan) * (gx1 - gx0)
    const toY = (v: number) => gy1 - ((v - vmin) / (vmax - vmin)) * (gy1 - gy0)

    const change = ((price - prices[0]) / prices[0]) * 100
    const up = change >= 0

    // prominent current price + change
    cx.textAlign = 'left'
    cx.fillStyle = '#f2f6fa'
    cx.font = `600 54px ${sans}`
    const priceStr = `$${fmtPrice(price)}`
    cx.fillText(priceStr, gx0 + 4, 86)
    cx.fillStyle = up ? '#46d18b' : '#f06a6a'
    cx.font = `600 24px ${sans}`
    cx.fillText(
      `${up ? '▲' : '▼'} ${up ? '+' : ''}${change.toFixed(2)}%`,
      gx0 + 4 + cx.measureText(priceStr).width + 22,
      82,
    )

    // horizontal grid + price axis (right)
    cx.textBaseline = 'middle'
    cx.font = `500 19px ${sans}`
    for (let i = 0; i <= 4; i++) {
      const v = vmin + ((vmax - vmin) * i) / 4
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
    for (let i = 0; i <= 4; i++) {
      const ts = t0 + (tspan * i) / 4
      const gx = toX(ts)
      cx.strokeStyle = faint
      cx.lineWidth = 1
      cx.beginPath()
      cx.moveTo(gx, gy0)
      cx.lineTo(gx, gy1)
      cx.stroke()
      cx.fillStyle = muted
      cx.textAlign = i === 0 ? 'left' : i === 4 ? 'right' : 'center'
      cx.fillText(fmtTime(ts), gx, gy1 + 12)
    }

    // area fill under the line
    cx.beginPath()
    cx.moveTo(toX(t0), gy1)
    for (const p of pts) cx.lineTo(toX(p.ts), toY(p.price))
    cx.lineTo(toX(t1), gy1)
    cx.closePath()
    const area = cx.createLinearGradient(0, gy0, 0, gy1)
    area.addColorStop(0, 'rgba(233,162,59,0.24)')
    area.addColorStop(1, 'rgba(233,162,59,0)')
    cx.fillStyle = area
    cx.fill()

    // the price line
    cx.beginPath()
    cx.moveTo(toX(t0), toY(pts[0].price))
    for (const p of pts) cx.lineTo(toX(p.ts), toY(p.price))
    cx.strokeStyle = accent
    cx.lineWidth = 2.6
    cx.lineJoin = 'round'
    cx.lineCap = 'round'
    cx.save()
    cx.shadowColor = 'rgba(233,162,59,0.55)'
    cx.shadowBlur = 10
    cx.stroke()
    cx.restore()

    // latest point + guide + price pill
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
    cx.fillStyle = 'rgba(255,255,255,0.92)'
    cx.beginPath()
    cx.arc(lx, ly, 2, 0, Math.PI * 2)
    cx.fill()
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

  // initial paint + throttled live refresh
  // Refresh from the live feed on a timer (not the RAF loop — RAF can be
  // throttled; the data cadence is ~250ms anyway). The scene's render loop
  // uploads the updated canvas each frame.
  const refresh = () => {
    const s = useGameStore.getState()
    drawChart(s.priceHistory, s.price)
  }
  refresh()
  const timer = setInterval(refresh, 250)

  function update(_t: number) {
    // chart refresh is timer-driven; nothing to do per frame
  }

  function dispose() {
    clearInterval(timer)
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
