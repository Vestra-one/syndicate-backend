import * as THREE from 'three'
import { useGameStore } from '@/store/gameStore'
import type { PricePoint } from '@/lib/ui'

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
  const PAD = { l: 26, r: 104, t: 104, b: 50 }
  const SANS = "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
  const fmtPrice = (v: number) =>
    v >= 1000
      ? v.toLocaleString('en-US', { maximumFractionDigits: 0 })
      : v.toLocaleString('en-US', { maximumFractionDigits: 2 })
  // the trailing slice of time the board shows; the line is resampled onto a
  // uniform grid across this window so spacing is even regardless of how
  // irregularly ticks actually arrived.
  const WINDOW_MS = 60_000

  // canvas rounded-rect path
  const rr = (x: number, y: number, w: number, h: number, r: number) => {
    const k = Math.min(r, h / 2, w / 2)
    cx.beginPath()
    cx.moveTo(x + k, y)
    cx.arcTo(x + w, y, x + w, y + h, k)
    cx.arcTo(x + w, y + h, x, y + h, k)
    cx.arcTo(x, y + h, x, y, k)
    cx.arcTo(x, y, x + w, y, k)
    cx.closePath()
  }
  // tracked-out caps with real letter-spacing (Chrome canvas supports ctx.letterSpacing)
  const tracked = (text: string, x: number, y: number, ls: string) => {
    const c = cx as CanvasRenderingContext2D & { letterSpacing?: string }
    const prev = c.letterSpacing
    c.letterSpacing = ls
    cx.fillText(text, x, y)
    c.letterSpacing = prev ?? '0px'
  }
  // Tabular figures: lay numerals on a fixed cell so the live price never
  // shimmies as digits change (system-ui digits aren't tabular by default).
  // Non-digit glyphs ($ , .) keep their natural width. Returns total advance.
  const digitCell = () => {
    let w = 0
    for (let d = 0; d <= 9; d++) w = Math.max(w, cx.measureText(String(d)).width)
    return w
  }
  const drawTabular = (text: string, x: number, y: number, cell: number) => {
    cx.textAlign = 'left'
    let cur = x
    for (const ch of text) {
      if (ch >= '0' && ch <= '9') {
        const w = cx.measureText(ch).width
        cx.fillText(ch, cur + (cell - w) / 2, y)
        cur += cell
      } else {
        cx.fillText(ch, cur, y)
        cur += cx.measureText(ch).width
      }
    }
    return cur - x
  }

  // Resample an irregular series onto `n` points evenly spaced over [t0, t1],
  // linearly interpolating between the source samples. Even X spacing kills the
  // jerky/stair-stepped look that comes from non-uniform tick arrival.
  const resample = (src: PricePoint[], t0: number, t1: number, n: number): PricePoint[] => {
    const out: PricePoint[] = []
    let j = 0
    for (let i = 0; i < n; i++) {
      const ts = t0 + ((t1 - t0) * i) / (n - 1)
      while (j < src.length - 2 && src[j + 1].ts < ts) j++
      const a = src[j]
      const b = src[Math.min(j + 1, src.length - 1)]
      const f = b.ts > a.ts ? Math.max(0, Math.min(1, (ts - a.ts) / (b.ts - a.ts))) : 0
      out.push({ ts, price: a.price + (b.price - a.price) * f })
    }
    return out
  }

  function drawChart(
    history: PricePoint[],
    price: number | null,
    prediction: number | null,
    tNow: number,
    clock: number,
  ) {
    cx.clearRect(0, 0, SCW, SCH)
    const bg = cx.createLinearGradient(0, 0, 0, SCH)
    bg.addColorStop(0, '#0c1219')
    bg.addColorStop(1, '#05080c')
    cx.fillStyle = bg
    cx.fillRect(0, 0, SCW, SCH)

    const gx0 = PAD.l
    const gx1 = SCW - PAD.r
    const gy0 = PAD.t
    const gy1 = SCH - PAD.b
    const accent = '#e9a23b'
    const ink = '#f4f7fa'
    const dim = 'rgba(160,178,196,0.66)'
    const faint = 'rgba(150,170,190,0.085)'

    // ---- header: symbol (always shown, even before the feed warms up) ----
    cx.textBaseline = 'alphabetic'
    cx.textAlign = 'left'
    cx.fillStyle = dim
    cx.font = `600 19px ${SANS}`
    tracked('BTC / USD', gx0 + 2, 40, '7px')

    const raw = history.filter((h) => Number.isFinite(h.price))
    if (raw.length < 2 || price == null) {
      cx.fillStyle = 'rgba(180,196,212,0.5)'
      cx.font = `500 26px ${SANS}`
      cx.textAlign = 'center'
      cx.fillText('awaiting price feed…', SCW / 2, SCH / 2)
      screenTex.needsUpdate = true
      return
    }

    // ---- resample the raw ticks onto a uniform trailing window ----
    const tEnd = Math.max(raw[raw.length - 1].ts, clock)
    const tStart = Math.max(raw[0].ts, tEnd - WINDOW_MS)
    const SAMPLES = 96
    const pts = resample(raw, tStart, tEnd, SAMPLES)
    // pin the final sample to the (eased) live price so line, marker, and pill agree
    pts[pts.length - 1] = { ts: tEnd, price }
    const first = pts[0].price

    const prices = pts.map((p) => p.price)
    const lo = Math.min(...prices, prediction ?? Infinity)
    const hi = Math.max(...prices, prediction ?? -Infinity)
    const span = hi - lo || hi * 0.001 || 1
    const vmin = lo - span * 0.22
    const vmax = hi + span * 0.22
    const toX = (ts: number) => gx0 + ((ts - tStart) / (tEnd - tStart || 1)) * (gx1 - gx0)
    const toY = (v: number) => gy1 - ((v - vmin) / (vmax - vmin)) * (gy1 - gy0)

    const change = first !== 0 ? ((price - first) / first) * 100 : 0
    const up = change >= 0
    const ly = toY(price)
    const hasPred = prediction != null && Number.isFinite(prediction)
    const py = hasPred ? toY(prediction!) : null
    const dirCol = up ? '#4fd18b' : '#f0716e'

    // ---- header: hero price (tabular) + change chip at a fixed anchor ----
    cx.fillStyle = ink
    cx.font = `600 52px ${SANS}`
    cx.textBaseline = 'alphabetic'
    const cell = digitCell()
    const priceBaseline = 88
    drawTabular(`$${fmtPrice(price)}`, gx0 + 2, priceBaseline, cell)
    // anchor the chip off a reserved max-width price so it never dances tick-to-tick
    const reserveW = cx.measureText('$').width + cell * 6 + cx.measureText(',').width

    cx.font = `600 22px ${SANS}`
    const chTxt = `${up ? '▲' : '▼'} ${up ? '+' : ''}${change.toFixed(2)}%`
    const chW = cx.measureText(chTxt).width
    const chPadX = 13
    const chH = 32
    const chX = gx0 + 2 + reserveW + 22
    const chCenter = priceBaseline - 17
    cx.fillStyle = up ? 'rgba(79,209,139,0.16)' : 'rgba(240,113,110,0.16)'
    rr(chX, chCenter - chH / 2, chW + chPadX * 2, chH, chH / 2)
    cx.fill()
    cx.fillStyle = dirCol
    cx.textBaseline = 'middle'
    cx.fillText(chTxt, chX + chPadX, chCenter + 1)

    // ---- horizontal grid + right price axis (skip ticks that collide with a pill) ----
    cx.font = `500 18px ${SANS}`
    for (let i = 0; i <= 4; i++) {
      const v = vmin + ((vmax - vmin) * i) / 4
      const gy = toY(v)
      cx.strokeStyle = faint
      cx.lineWidth = 1
      cx.beginPath()
      cx.moveTo(gx0, gy)
      cx.lineTo(gx1, gy)
      cx.stroke()
      const collides = Math.abs(gy - ly) < 20 || (py != null && Math.abs(gy - py) < 20)
      if (collides) continue
      cx.fillStyle = dim
      cx.textAlign = 'left'
      cx.textBaseline = 'middle'
      cx.fillText(fmtPrice(v), gx1 + 14, gy)
    }

    // ---- vertical grid + bottom time axis (relative elapsed: −45s … now) ----
    cx.textBaseline = 'top'
    cx.fillStyle = dim
    for (const back of [0, 15, 30, 45, 60]) {
      const ts = tEnd - back * 1000
      if (ts < tStart - 1) continue
      const gx = toX(ts)
      cx.strokeStyle = faint
      cx.lineWidth = 1
      cx.beginPath()
      cx.moveTo(gx, gy0)
      cx.lineTo(gx, gy1)
      cx.stroke()
      cx.textAlign = back === 0 ? 'right' : ts <= tStart + 1 ? 'left' : 'center'
      cx.fillText(back === 0 ? 'now' : `−${back}s`, gx, gy1 + 14)
    }

    // ---- area fill under the line ----
    cx.beginPath()
    cx.moveTo(toX(pts[0].ts), gy1)
    for (const p of pts) cx.lineTo(toX(p.ts), toY(p.price))
    cx.lineTo(toX(tEnd), gy1)
    cx.closePath()
    const area = cx.createLinearGradient(0, gy0, 0, gy1)
    area.addColorStop(0, 'rgba(233,162,59,0.26)')
    area.addColorStop(1, 'rgba(233,162,59,0)')
    cx.fillStyle = area
    cx.fill()

    // ---- the price line ----
    cx.beginPath()
    cx.moveTo(toX(pts[0].ts), toY(pts[0].price))
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

    // a pill drawn at the right edge, anchored on a value's y, with a short
    // connector tab into the plot — shared by the live price and the call line.
    const edgePill = (text: string, y: number, fill: string, fg: string) => {
      cx.font = `600 19px ${SANS}`
      const w = cx.measureText(text).width + 20
      const h = 30
      cx.fillStyle = fill
      rr(gx1 + 8, y - h / 2, w, h, 7)
      cx.fill()
      cx.fillStyle = fg
      cx.textBaseline = 'middle'
      cx.textAlign = 'left'
      cx.fillText(text, gx1 + 18, y + 1)
    }

    // ---- sealed-prediction line — your "conviction" target ----
    // The hero of the screen once sealed: where you've staked your read of the market.
    if (hasPred && py != null) {
      const pred = '#7fd0ff'
      // faint band between the live price and your call — the "gap to conviction"
      cx.fillStyle = 'rgba(127,208,255,0.07)'
      cx.fillRect(gx0, Math.min(py, ly), gx1 - gx0, Math.abs(ly - py))
      cx.strokeStyle = pred
      cx.lineWidth = 2
      cx.setLineDash([7, 6])
      cx.beginPath()
      cx.moveTo(gx0, py)
      cx.lineTo(gx1, py)
      cx.stroke()
      cx.setLineDash([])
      cx.fillStyle = pred
      cx.textBaseline = 'bottom'
      cx.textAlign = 'left'
      cx.font = `700 15px ${SANS}`
      tracked('YOUR CALL', gx0 + 6, py - 7, '2px')
      edgePill(fmtPrice(prediction!), py, pred, '#06121c')
    }

    // ---- latest point: dashed guide, pulsing live marker, live-price pill ----
    const lx = toX(tEnd)
    cx.strokeStyle = 'rgba(233,162,59,0.32)'
    cx.lineWidth = 1
    cx.setLineDash([5, 5])
    cx.beginPath()
    cx.moveTo(gx0, ly)
    cx.lineTo(gx1, ly)
    cx.stroke()
    cx.setLineDash([])
    // a soft halo that breathes — the "this is live" cue
    const pulse = 0.5 + 0.5 * Math.sin(tNow * 3.2)
    cx.save()
    cx.fillStyle = `rgba(233,162,59,${0.16 + 0.14 * pulse})`
    cx.beginPath()
    cx.arc(lx, ly, 9 + 4 * pulse, 0, Math.PI * 2)
    cx.fill()
    cx.restore()
    cx.save()
    cx.shadowColor = 'rgba(233,162,59,0.85)'
    cx.shadowBlur = 12
    cx.fillStyle = accent
    cx.beginPath()
    cx.arc(lx, ly, 5, 0, Math.PI * 2)
    cx.fill()
    cx.restore()
    cx.fillStyle = 'rgba(255,255,255,0.95)'
    cx.beginPath()
    cx.arc(lx, ly, 2, 0, Math.PI * 2)
    cx.fill()
    edgePill(fmtPrice(price), ly, accent, '#1a1206')

    screenTex.needsUpdate = true
  }

  // ---- live data + animation state ----
  // We don't repaint on a fixed timer. Instead we read the latest target from
  // the store whenever it changes, then ease toward it each animation frame and
  // repaint only while something is actually moving (or pulsing) — smooth when
  // live, zero cost when idle.
  let history: PricePoint[] = []
  let targetPrice: number | null = null
  let prediction: number | null = null
  let dispPrice = 0 // eased toward targetPrice for the "live ticker" feel
  let dirty = true
  let liveUntil = 0 // keep painting (pulse + ease) until this wall-clock time

  const readData = () => {
    const s = useGameStore.getState()
    history = s.priceHistory
    targetPrice = s.priceHistory.at(-1)?.price ?? null
    const decimals = s.terms?.decimals ?? 2
    prediction =
      s.sealStatus === 'sealed' && s.yourPrediction != null
        ? s.yourPrediction / 10 ** decimals
        : null
    if (targetPrice != null && dispPrice === 0) dispPrice = targetPrice
    dirty = true
    // a fresh tick keeps the board "live" (and the pulse breathing) for a beat
    // past the data cadence; once ticks stop, it settles and idles cost-free.
    liveUntil = Date.now() + 900
  }
  readData()
  const unsubscribe = useGameStore.subscribe(readData)

  function update(t: number) {
    const clock = Date.now()
    if (targetPrice != null) {
      if (dispPrice === 0) dispPrice = targetPrice
      // exponential ease — frame-rate-tolerant for the small per-tick deltas
      dispPrice += (targetPrice - dispPrice) * 0.16
    }
    // repaint while data is fresh (animate pulse + ease), or once after a change
    if (dirty || clock < liveUntil) {
      dirty = false
      drawChart(history, targetPrice != null ? dispPrice : null, prediction, t, clock)
    }
  }

  function dispose() {
    unsubscribe()
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
