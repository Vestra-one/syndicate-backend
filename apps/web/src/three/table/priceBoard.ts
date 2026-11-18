import * as THREE from 'three'
import { useGameStore } from '@/store/gameStore'
import { PAST_FILLING_PHASES } from '@/lib/protocol'
import type { ConnectionStatus, PricePoint } from '@/lib/ui'
import { PRICE_RANGES, RANGE_WINDOW_MS, type PriceRange } from '@/lib/priceRanges'

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
/** The market printed on the board's header — the table's own, not always BTC. */
let boardFeed = 'BTC / USD'
export function setBoardFeed(feedId: string): void {
  boardFeed = feedId.replace('/', ' / ')
}

export interface PriceBoardHandle {
  group: THREE.Group
  update: (t: number) => void
  dispose: () => void
  /** World-space centre of each timeframe tab, for the clickable 2D overlay (tableView). */
  getTabAnchors: () => { range: PriceRange; world: THREE.Vector3 }[]
  /** World-space centre of the "CHART" launch button, for its clickable 2D overlay. */
  getChartButtonAnchor: () => THREE.Vector3
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
  const BEZEL = 0.17 // slimmer wooden frame — a tight gilt-edged surround
  const shw = hw - BEZEL // screen half-width
  const shh = hh - BEZEL // screen half-height

  // ---- mahogany-burl wood for the frame, echoing the table's burl rail. A
  //      colour map plus a matching bump so the grain catches the candlelight. ----
  const rnd = (a: number, b: number) => a + Math.random() * (b - a)
  function buildWoodTexture() {
    const S = 512
    const col = document.createElement('canvas')
    col.width = col.height = S
    const bmp = document.createElement('canvas')
    bmp.width = bmp.height = S
    const cx2 = col.getContext('2d')!
    const bx = bmp.getContext('2d')!
    cx2.fillStyle = '#946238' // warm honey-oak base
    cx2.fillRect(0, 0, S, S)
    bx.fillStyle = '#808080'
    bx.fillRect(0, 0, S, S)
    // burl mottling
    for (let i = 0; i < 2600; i++) {
      const px = rnd(0, S),
        py = rnd(0, S),
        s = rnd(2, 9),
        a = rnd(0, Math.PI),
        t = Math.random()
      cx2.fillStyle =
        t < 0.5
          ? `rgba(${(170 + rnd(-30, 40)) | 0},${(116 + rnd(-16, 22)) | 0},${(70 + rnd(-12, 18)) | 0},0.15)`
          : t < 0.85
            ? 'rgba(70,40,20,0.20)'
            : `rgba(${(208 + rnd(0, 40)) | 0},150,92,0.10)`
      cx2.beginPath()
      cx2.ellipse(px, py, s, s * rnd(0.4, 1), a, 0, Math.PI * 2)
      cx2.fill()
      bx.fillStyle = `rgba(${t < 0.5 ? 210 : 70},${t < 0.5 ? 210 : 70},${t < 0.5 ? 210 : 70},0.10)`
      bx.beginPath()
      bx.ellipse(px, py, s, s * rnd(0.4, 1), a, 0, Math.PI * 2)
      bx.fill()
    }
    // soft burl knots
    for (let i = 0; i < 54; i++) {
      const px = rnd(0, S),
        py = rnd(0, S),
        s = rnd(14, 46)
      const g = cx2.createRadialGradient(px, py, 0, px, py, s)
      g.addColorStop(0, 'rgba(196,140,84,0.13)')
      g.addColorStop(0.6, 'rgba(96,58,30,0.08)')
      g.addColorStop(1, 'rgba(0,0,0,0)')
      cx2.fillStyle = g
      cx2.beginPath()
      cx2.ellipse(px, py, s, s * rnd(0.5, 1), rnd(0, Math.PI), 0, Math.PI * 2)
      cx2.fill()
    }
    // wandering grain lines
    cx2.lineCap = bx.lineCap = 'round'
    for (let i = 0; i < 240; i++) {
      let a = rnd(0, Math.PI * 2),
        px = rnd(0, S),
        py = rnd(0, S)
      const lw = rnd(0.6, 1.8)
      cx2.strokeStyle = `rgba(${rnd(80, 130) | 0},${rnd(46, 78) | 0},${rnd(24, 44) | 0},${rnd(0.06, 0.16)})`
      cx2.lineWidth = lw
      bx.strokeStyle = `rgba(40,40,40,${rnd(0.05, 0.12)})`
      bx.lineWidth = lw
      cx2.beginPath()
      cx2.moveTo(px, py)
      bx.beginPath()
      bx.moveTo(px, py)
      for (let s = 0; s < 6; s++) {
        a += rnd(-0.4, 0.4)
        px += Math.cos(a) * rnd(8, 22)
        py += Math.sin(a) * rnd(8, 22)
        cx2.lineTo(px, py)
        bx.lineTo(px, py)
      }
      cx2.stroke()
      bx.stroke()
    }
    const mk = (cv: HTMLCanvasElement, srgb: boolean) => {
      const t = new THREE.CanvasTexture(cv)
      if (srgb) t.colorSpace = THREE.SRGBColorSpace
      t.wrapS = t.wrapT = THREE.RepeatWrapping
      t.repeat.set(0.5, 0.5)
      t.anisotropy = 8
      return t
    }
    return { map: mk(col, true), bumpMap: mk(bmp, false) }
  }
  const woodTex = buildWoodTexture()

  // ---- materials ----
  const shellMat = new THREE.MeshStandardMaterial({
    ...woodTex,
    color: 0xb07b46, // deeper burl, tuned to the rail so it catches (not throws) candlelight
    metalness: 0.12,
    roughness: 0.56,
    bumpScale: 0.014,
    envMapIntensity: 0.75,
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
  // One continuous mitred moulding (outline + concentric hole) rather than four
  // overlapping bars: the old bars doubled up at the corners, leaving two gold
  // faces fighting for the same depth — that's the flicker seen when the camera
  // pans left/right. A single extruded frame has no overlaps and clean corners.
  const rimT = 0.05
  const rimShape = new THREE.Shape()
  roundRect(rimShape, shw + rimT, shh + rimT, 0.09)
  const rimHole = new THREE.Path()
  roundRect(rimHole, shw, shh, 0.06)
  rimShape.holes.push(rimHole)
  const rim = new THREE.Mesh(
    new THREE.ExtrudeGeometry(rimShape, {
      depth: 0.05,
      bevelEnabled: true,
      bevelThickness: 0.02,
      bevelSize: 0.022,
      bevelSegments: 2,
    }),
    goldMat,
  )
  rim.position.z = 0.005 // sits on the bezel face, standing proud as a gold frame
  rim.castShadow = true
  group.add(rim)

  // ---- base plinth so it sits believably on the felt ----
  // Front face sits flush with the cabinet front (z = 0): no protruding shelf, so
  // the lower boundary reads as one continuous face down to the felt. Built as a
  // beveled extrusion (same technique as the frame/rim above) rather than a bare
  // BoxGeometry — a plain box's hard 90° edges read as a flat, undifferentiated
  // slab under the room's warm lighting; the soft bevel gives it a moulded edge
  // that actually catches light like the rest of the cabinet.
  const BASE_H = 0.34
  const baseDepth = DEPTH + 0.2
  const baseShape = new THREE.Shape()
  roundRect(baseShape, (W * 1.08) / 2, BASE_H / 2, 0.035)
  const base = new THREE.Mesh(
    new THREE.ExtrudeGeometry(baseShape, {
      depth: baseDepth,
      bevelEnabled: true,
      bevelThickness: 0.018,
      bevelSize: 0.022,
      bevelSegments: 3,
    }),
    shellMat,
  )
  base.position.set(0, -hh - BASE_H / 2, -baseDepth) // front flush with cabinet front (z=0)
  base.castShadow = true
  base.receiveShadow = true
  group.add(base)
  // a pair of gold skirting mouldings — one standing proud over the frame/base
  // seam, one echoing it near the foot — so the plinth reads as a capped block
  // (top rail + kick strip) instead of one bare band over a plain slab.
  const baseBand = new THREE.Mesh(new THREE.BoxGeometry(W * 1.06, 0.08, 0.1), goldMat)
  baseBand.position.set(0, -hh, 0.02)
  baseBand.castShadow = true
  group.add(baseBand)
  const baseBandLow = new THREE.Mesh(new THREE.BoxGeometry(W * 1.02, 0.045, 0.06), goldMat)
  baseBandLow.position.set(0, -hh - BASE_H + 0.075, 0.015)
  baseBandLow.castShadow = true
  group.add(baseBandLow)

  // ---- "CHART" launch button — a raised brass push-button set into the base
  // plinth, centred beneath the screen like a physical control on the console
  // (the same instinct as a jukebox's illuminated action button). Pressing it
  // opens the full-screen BTC/USD analysis view (see PriceChartOverlay); the
  // actual click target is an invisible HTML button pinned to its world anchor
  // (getChartButtonAnchor, below) — the same technique as the timeframe tabs.
  // Centred on the plinth's top rail — big enough to read as a real control
  // from the table's default camera distance (a coin-sized medallion bridging
  // the rail, not a hidden rivet), popping proud in z so it clears both bands. ----
  const BTN_R = 0.15
  const BTN_POS = new THREE.Vector3(0, -hh - 0.02, 0.16)
  const btnCv = document.createElement('canvas')
  btnCv.width = btnCv.height = 256
  const bx2 = btnCv.getContext('2d')!
  const c0 = 128
  const face = bx2.createRadialGradient(c0 - 30, c0 - 40, 10, c0, c0, c0 - 4)
  face.addColorStop(0, '#f4dfa0')
  face.addColorStop(0.55, '#c99a4a')
  face.addColorStop(1, '#8a6a22')
  bx2.fillStyle = face
  bx2.beginPath()
  bx2.arc(c0, c0, c0 - 6, 0, Math.PI * 2)
  bx2.fill()
  bx2.strokeStyle = 'rgba(42,28,13,0.55)'
  bx2.lineWidth = 7
  bx2.stroke()
  bx2.strokeStyle = 'rgba(42,28,13,0.3)'
  bx2.lineWidth = 2
  bx2.beginPath()
  bx2.arc(c0, c0, c0 - 22, 0, Math.PI * 2)
  bx2.stroke()
  // engraved bar-chart glyph — reads as "chart" at a glance, not a generic icon
  const bars = [0.34, 0.55, 0.42, 0.68]
  const barW = 15
  const barGap = 9
  const totalW = bars.length * barW + (bars.length - 1) * barGap
  let barX = c0 - totalW / 2
  const floorY = c0 + 8
  bx2.fillStyle = '#2a1c0d'
  for (const h of bars) {
    const bh = h * 66
    bx2.fillRect(barX, floorY - bh, barW, bh)
    barX += barW + barGap
  }
  bx2.strokeStyle = 'rgba(42,28,13,0.55)'
  bx2.lineWidth = 2
  bx2.beginPath()
  bx2.moveTo(c0 - totalW / 2 - 4, floorY)
  bx2.lineTo(c0 + totalW / 2 + 4, floorY)
  bx2.stroke()
  bx2.fillStyle = 'rgba(42,28,13,0.9)'
  bx2.font = "700 26px 'Cinzel', Georgia, serif"
  bx2.textAlign = 'center'
  bx2.textBaseline = 'alphabetic'
  bx2.fillText('CHART', c0, floorY + 34)
  const btnTex = new THREE.CanvasTexture(btnCv)
  btnTex.colorSpace = THREE.SRGBColorSpace
  const btnMesh = new THREE.Mesh(
    new THREE.CircleGeometry(BTN_R, 48),
    new THREE.MeshStandardMaterial({ map: btnTex, metalness: 0.85, roughness: 0.32, envMapIntensity: 1.2 }),
  )
  btnMesh.position.copy(BTN_POS)
  btnMesh.castShadow = true
  group.add(btnMesh)
  const btnRim = new THREE.Mesh(new THREE.RingGeometry(BTN_R, BTN_R + 0.01, 48), goldMat)
  btnRim.position.copy(BTN_POS).setZ(BTN_POS.z + 0.001)
  group.add(btnRim)
  // a soft breathing glow behind it — the same "press me, this is live" cue as
  // the chart's own pulsing price marker, so the button reads as inviting.
  const glowCv = document.createElement('canvas')
  glowCv.width = glowCv.height = 128
  const gctx = glowCv.getContext('2d')!
  const glowGrad = gctx.createRadialGradient(64, 64, 0, 64, 64, 64)
  glowGrad.addColorStop(0, 'rgba(233,196,106,0.9)')
  glowGrad.addColorStop(1, 'rgba(233,196,106,0)')
  gctx.fillStyle = glowGrad
  gctx.fillRect(0, 0, 128, 128)
  const glowTex = new THREE.CanvasTexture(glowCv)
  const glowMat = new THREE.MeshBasicMaterial({
    map: glowTex,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  })
  const glow = new THREE.Mesh(new THREE.PlaneGeometry(BTN_R * 3.4, BTN_R * 3.4), glowMat)
  glow.position.copy(BTN_POS).setZ(BTN_POS.z - 0.04)
  group.add(glow)
  function getChartButtonAnchor(): THREE.Vector3 {
    group.updateMatrixWorld(true)
    return btnMesh.getWorldPosition(new THREE.Vector3())
  }

  // ================= minimal live chart: one header line, then all the rest is graph =================
  // A single compact header row (symbol + price + change, tabs, market-open) and
  // a thin bottom margin for the time axis — everything else goes to the plot.
  const PAD = { l: 26, r: 104, t: 72, b: 46 }
  const SANS = "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
  // a serif display face for the engraved-looking labels (symbol, your-call),
  // so they read as part of the table's gilt lettering rather than a dashboard.
  const SERIF = "'Cinzel', 'Trajan Pro', Georgia, 'Times New Roman', serif"
  const fmtPrice = (v: number) =>
    v >= 1000
      ? v.toLocaleString('en-US', { maximumFractionDigits: 0 })
      : v.toLocaleString('en-US', { maximumFractionDigits: 2 })
  // Fallback round length if the table's terms don't say (shouldn't happen once wired).
  const DEFAULT_ROUND_MS = 10 * 60_000

  // ---- timeframe tab row: a trailing-window size over the cabinet's own live
  // ticks (see readData/update) — inert while a round or the pre-match wait is
  // anchored, since that view is fixed to the round's own timeline instead. ----
  const TAB_W = 66
  const TAB_GAP = 8
  const TAB_H = 26
  const TAB_Y = 35 // vertical centre of the header row (tabs + market-open)
  function tabRects(): { range: PriceRange; x: number; y: number; w: number; h: number }[] {
    const totalW = PRICE_RANGES.length * TAB_W + (PRICE_RANGES.length - 1) * TAB_GAP
    let x = (SCW - totalW) / 2
    return PRICE_RANGES.map((range) => {
      const rect = { range, x, y: TAB_Y - TAB_H / 2, w: TAB_W, h: TAB_H }
      x += TAB_W + TAB_GAP
      return rect
    })
  }
  /** Canvas-pixel point (in the recessed screen) → world position, via the actual
   * mesh transform — stays correct even if the cabinet's geometry/placement changes. */
  function canvasPointToWorld(px: number, py: number): THREE.Vector3 {
    const w = shw * 2 + 0.04
    const h = shh * 2 + 0.04
    const localX = (px / SCW - 0.5) * w
    const localY = (0.5 - py / SCH) * h
    return screen.localToWorld(new THREE.Vector3(localX, localY, 0))
  }
  function getTabAnchors(): { range: PriceRange; world: THREE.Vector3 }[] {
    group.updateMatrixWorld(true)
    return tabRects().map((r) => ({ range: r.range, world: canvasPointToWorld(r.x + r.w / 2, r.y + r.h / 2) }))
  }

  /** "1:30" / "45s" style label for an elapsed-ms duration — precise, for the
   * round-anchored axis where the exact quarter-of-the-round reading matters. */
  const fmtAxisTime = (ms: number) => {
    const totalSec = Math.max(0, Math.round(ms / 1000))
    if (totalSec < 90) return `${totalSec}s`
    const m = Math.floor(totalSec / 60)
    const s = totalSec % 60
    return s === 0 ? `${m}m` : `${m}:${String(s).padStart(2, '0')}`
  }
  /** Coarser "how far back" label for the idle trailing-window ruler — rounds to
   * whole minutes once past ~90s. These quarters are already an approximation
   * (and shrink to whatever history is actually buffered, not the tab's nominal
   * size), so a precise "21:18" reads as broken; "21m" matches the tabs' own
   * clean Nm styling instead. */
  const fmtBack = (ms: number) => {
    const totalSec = Math.max(0, Math.round(ms / 1000))
    return totalSec < 90 ? `${totalSec}s` : `${Math.round(totalSec / 60)}m`
  }
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

  interface DrawState {
    history: PricePoint[]
    price: number | null
    prediction: number | null
    tNow: number
    clock: number
    // Fixed-window anchor: a live round's start (§ see readData), or — while
    // seated and waiting for the table to fill — the moment you sat down, so
    // the same "line travels left → right" treatment applies pre-game too.
    axisStart: number | null
    axisDurationMs: number | null
    range: PriceRange
    connStatus: ConnectionStatus
  }

  function drawChart(s: DrawState) {
    const { history, price, prediction, tNow, clock, axisStart, axisDurationMs, range, connStatus } = s
    cx.clearRect(0, 0, SCW, SCH)
    // warm near-black, like dark glass over candlelit wood — not the cold blue
    // of a trading terminal.
    const bg = cx.createLinearGradient(0, 0, 0, SCH)
    bg.addColorStop(0, '#0d0a07')
    bg.addColorStop(1, '#050402')
    cx.fillStyle = bg
    cx.fillRect(0, 0, SCW, SCH)

    const gx0 = PAD.l
    const gx1 = SCW - PAD.r
    const gy0 = PAD.t
    const gy1 = SCH - PAD.b
    const accent = '#e9a23b' // candle-gold, ties to the gilt runes on the rail
    const ink = '#f5ecd8' // warm parchment, not cold white
    const dim = 'rgba(208,184,138,0.62)' // dim gilt
    const faint = 'rgba(210,180,120,0.09)'

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

    // ---- header: one compact row — symbol + hero price + change chip on the
    // left, timeframe tabs centred, market-open indicator on the right — so
    // almost the entire screen below it is graph. ----
    const HEAD_Y = 44 // shared baseline for the symbol caption and the hero price
    cx.textBaseline = 'alphabetic'
    cx.textAlign = 'left'
    cx.fillStyle = dim
    cx.font = `600 13px ${SERIF}`
    tracked(boardFeed, gx0 + 2, HEAD_Y, '4px')
    // measureText() doesn't account for tracked()'s letterSpacing, so pad the
    // measured width by the ~4px/glyph gap it actually renders with (8 gaps
    // across 9 characters) — otherwise the price creeps in and overlaps the "D".
    const priceX = gx0 + 2 + cx.measureText(boardFeed).width + 4 * 8 + 20

    // hero price (tabular) + change chip, relative to `first` — the trailing
    // window's opening sample (or the round/wait anchor's opening sample).
    cx.fillStyle = ink
    cx.font = `600 34px ${SANS}`
    cx.textAlign = 'left'
    cx.textBaseline = 'alphabetic'
    const cell = digitCell()
    if (price != null) drawTabular(`$${fmtPrice(price)}`, priceX, HEAD_Y, cell)
    else cx.fillText('$—', priceX, HEAD_Y)
    // anchor the chip off a reserved max-width price so it never dances tick-to-tick
    const reserveW = cx.measureText('$').width + cell * 6 + cx.measureText(',').width
    const drawChangeChip = (baseline: number | null) => {
      if (price == null || baseline == null || baseline === 0) return
      const change = ((price - baseline) / baseline) * 100
      const flat = Math.abs(change) < 0.005 // rounds to 0.00% — show as neutral, not "−0.00"
      const up = change >= 0
      // warm semantics: luminous gold for a rise, ember for a fall, dim gilt flat
      const dirCol = flat ? '#b8a888' : up ? '#e9c46a' : '#d4644a'
      cx.font = `600 15px ${SANS}`
      const arrow = flat ? '•' : up ? '▲' : '▼'
      const chTxt = flat ? `${arrow} 0.00%` : `${arrow} ${up ? '+' : '−'}${Math.abs(change).toFixed(2)}%`
      const chW = cx.measureText(chTxt).width
      const chPadX = 10
      const chH = 24
      const chX = priceX + reserveW + 14
      const chCenter = HEAD_Y - 12
      cx.fillStyle = flat ? 'rgba(184,168,136,0.14)' : up ? 'rgba(233,196,106,0.16)' : 'rgba(212,100,74,0.16)'
      rr(chX, chCenter - chH / 2, chW + chPadX * 2, chH, chH / 2)
      cx.fill()
      cx.fillStyle = dirCol
      cx.textBaseline = 'middle'
      cx.fillText(chTxt, chX + chPadX, chCenter + 1)
    }

    // market-open indicator, right edge, centred on the tab row
    const headerR = SCW - 22
    cx.font = `600 12px ${SANS}`
    cx.textAlign = 'right'
    cx.textBaseline = 'middle'
    cx.fillStyle = 'rgba(208,184,138,0.85)'
    const openLabel = 'MARKET OPEN'
    tracked(openLabel, headerR, TAB_Y, '1.5px')
    const openW = cx.measureText(openLabel).width + 6 // tracked() widened it a touch
    const dotColor = connStatus === 'live' ? '#4fd18b' : connStatus === 'offline' ? '#d4644a' : '#e7b24d'
    cx.fillStyle = dotColor
    cx.beginPath()
    cx.arc(headerR - openW - 11, TAB_Y, 3.5, 0, Math.PI * 2)
    cx.fill()

    // timeframe tab row, centred
    for (const r of tabRects()) {
      const active = r.range === range
      cx.fillStyle = active ? 'rgba(233,162,59,0.20)' : 'rgba(255,255,255,0.04)'
      rr(r.x, r.y, r.w, r.h, r.h / 2)
      cx.fill()
      if (active) {
        cx.strokeStyle = 'rgba(233,162,59,0.6)'
        cx.lineWidth = 1
        rr(r.x, r.y, r.w, r.h, r.h / 2)
        cx.stroke()
      }
      cx.font = `600 12px ${SANS}`
      cx.textAlign = 'center'
      cx.textBaseline = 'middle'
      cx.fillStyle = active ? ink : 'rgba(208,184,138,0.55)'
      cx.fillText(r.range, r.x + r.w / 2, r.y + r.h / 2 + 1)
    }

    const raw = history.filter((h) => Number.isFinite(h.price))
    if (raw.length < 2 || price == null) {
      // Empty-chart state: a dimmed grid + a pulsing marker on the mid-line + a
      // label, so a warming-up feed reads as "waiting for the first tick" rather
      // than a broken panel with one stray line.
      cx.strokeStyle = faint
      cx.lineWidth = 1
      for (let i = 0; i <= 4; i++) {
        const gy = gy0 + ((gy1 - gy0) * i) / 4
        cx.beginPath(); cx.moveTo(gx0, gy); cx.lineTo(gx1, gy); cx.stroke()
      }
      for (let i = 0; i <= 4; i++) {
        const gx = gx0 + ((gx1 - gx0) * i) / 4
        cx.beginPath(); cx.moveTo(gx, gy0); cx.lineTo(gx, gy1); cx.stroke()
      }
      const midX = (gx0 + gx1) / 2
      const midY = (gy0 + gy1) / 2
      const pulse = 0.5 + 0.5 * Math.sin(clock / 320)
      cx.save()
      cx.globalAlpha = 0.4 + 0.5 * pulse
      cx.shadowColor = accent
      cx.shadowBlur = 8 + 14 * pulse
      cx.fillStyle = accent
      cx.beginPath(); cx.arc(midX, midY, 5 + 2 * pulse, 0, Math.PI * 2); cx.fill()
      cx.restore()
      cx.fillStyle = dim
      cx.font = `500 22px ${SERIF}`
      cx.textAlign = 'center'
      cx.textBaseline = 'middle'
      cx.fillText('waiting for first tick', midX, midY + 42)
      screenTex.needsUpdate = true
      return
    }

    // ---- fixed to the round's (or the wait's) timeline when one is anchored: the
    // x-axis spans the whole window (0 → its duration) instead of scrolling, so the
    // line starts at the left edge on round/wait start and travels toward the right
    // edge as it plays out — rather than always sitting pinned at "now" on the right.
    // Falls back to the selected tab's trailing window when there's nothing to anchor
    // to (no seat, no match — the idle lobby ticker); the tab is inert while anchored,
    // since the round's own timeline is what actually matters there. ----
    const anchored = axisStart != null && axisDurationMs != null
    const windowMs = RANGE_WINDOW_MS[range]
    const tStart = anchored ? axisStart! : Math.max(raw[0].ts, Math.max(raw[raw.length - 1].ts, clock) - windowMs)
    const tEnd = anchored ? axisStart! + axisDurationMs! : Math.max(raw[raw.length - 1].ts, clock)
    // the live edge of the drawn line — "now", clamped inside the anchored span
    const dataEnd = anchored ? Math.min(clock, tEnd) : tEnd
    const SAMPLES = 96
    const sampled = resample(raw, tStart, dataEnd, SAMPLES)
    const n = sampled.length
    // Pin the last sample to the (eased) live price, then run several light
    // smoothing passes with the endpoints held fixed. This both rounds single-
    // tick spikes into a fluid trace AND diffuses the live value back along the
    // tail, so the line glides up to the marker instead of hooking vertically.
    let buf = sampled.map((p) => p.price)
    buf[n - 1] = price
    const PASSES = 3
    for (let pass = 0; pass < PASSES; pass++) {
      const out = buf.slice()
      for (let i = 1; i < n - 1; i++) {
        const a = buf[Math.max(0, i - 2)]
        const b = buf[i - 1]
        const c = buf[i]
        const d = buf[i + 1]
        const e = buf[Math.min(n - 1, i + 2)]
        out[i] = (a + 2 * b + 3 * c + 2 * d + e) / 9
      }
      buf = out
    }
    const pts: PricePoint[] = sampled.map((p, i) => ({ ts: p.ts, price: buf[i] }))
    const first = sampled[0].price
    drawChangeChip(first)

    const prices = pts.map((p) => p.price)
    const lo = Math.min(...prices, prediction ?? Infinity)
    const hi = Math.max(...prices, prediction ?? -Infinity)
    const span = hi - lo || hi * 0.001 || 1
    const vmin = lo - span * 0.22
    const vmax = hi + span * 0.22
    const toX = (ts: number) => gx0 + ((ts - tStart) / (tEnd - tStart || 1)) * (gx1 - gx0)
    const toY = (v: number) => gy1 - ((v - vmin) / (vmax - vmin)) * (gy1 - gy0)

    const ly = toY(price)
    const hasPred = prediction != null && Number.isFinite(prediction)
    const py = hasPred ? toY(prediction!) : null

    // ---- horizontal grid + right price axis (skip ticks that collide with a pill) ----
    cx.font = `500 18px ${SANS}`
    let lastYLabel = ''
    for (let i = 0; i <= 4; i++) {
      const v = vmin + ((vmax - vmin) * i) / 4
      const gy = toY(v)
      cx.strokeStyle = faint
      cx.lineWidth = 1
      cx.beginPath()
      cx.moveTo(gx0, gy)
      cx.lineTo(gx1, gy)
      cx.stroke()
      const collides = Math.abs(gy - ly) < 28 || (py != null && Math.abs(gy - py) < 28)
      if (collides) continue
      // On a near-flat span every tick rounds to the same figure; drop repeats so
      // the axis never reads "62,457 / 62,457" stacked down the edge.
      const label = fmtPrice(v)
      if (label === lastYLabel) continue
      lastYLabel = label
      cx.fillStyle = dim
      cx.textAlign = 'left'
      cx.textBaseline = 'middle'
      cx.fillText(label, gx1 + 14, gy)
    }

    // ---- vertical grid + bottom time axis ----
    // Anchored (round or wait): quarters of the whole span, labelled as elapsed
    // time since the anchor (0:00 … full duration) — a fixed ruler the live point
    // travels across, not a "how long ago" readout.
    // Idle: quarters of the ACTUAL displayed window (which can be shorter than the
    // tab's nominal size early on, before that much history has been buffered),
    // relative to "now" on the right — so the labels always match what's drawn.
    cx.textBaseline = 'top'
    cx.fillStyle = dim
    const winMs = tEnd - tStart
    let lastLabel = ''
    for (let i = 0; i <= 4; i++) {
      const ts = tStart + (winMs * i) / 4
      const gx = toX(ts)
      cx.strokeStyle = faint
      cx.lineWidth = 1
      cx.beginPath()
      cx.moveTo(gx, gy0)
      cx.lineTo(gx, gy1)
      cx.stroke()
      let label: string
      if (anchored) {
        label = fmtAxisTime(ts - tStart)
      } else {
        const back = Math.round((winMs * (4 - i)) / 4)
        label = i === 4 || back === 0 ? 'now' : `−${fmtBack(back)}`
      }
      if (label === lastLabel) continue // don't repeat a label when the span is tiny
      lastLabel = label
      cx.textAlign = i === 0 ? 'left' : i === 4 ? 'right' : 'center'
      cx.fillText(label, gx, gy1 + 14)
    }

    // ---- area fill under the line ----
    cx.beginPath()
    cx.moveTo(toX(pts[0].ts), gy1)
    for (const p of pts) cx.lineTo(toX(p.ts), toY(p.price))
    cx.lineTo(toX(dataEnd), gy1)
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

    // ---- sealed-prediction line — your "conviction" target ----
    // The hero of the screen once sealed: where you've staked your read of the market.
    if (hasPred && py != null) {
      const pred = '#e8d6a0' // pale candle-gold, the conviction line
      // faint band between the live price and your call — the "gap to conviction"
      cx.fillStyle = 'rgba(232,214,160,0.07)'
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
      cx.font = `700 15px ${SERIF}`
      tracked('YOUR CALL', gx0 + 6, py - 7, '3px')
      edgePill(fmtPrice(prediction!), py, pred, '#241803')
    }

    // ---- latest point: dashed guide, pulsing live marker, live-price pill ----
    // toX(dataEnd), not tEnd: in round mode this is "now", which sits at the left
    // edge on round start and travels rightward, only reaching the right edge as
    // the round actually ends — tEnd is the fixed round-end anchor, not "now".
    const lx = toX(dataEnd)
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
  let axisStart: number | null = null
  let axisDurationMs: number | null = null
  // Stamped the first moment you're seated and waiting for the table to fill (no
  // live match yet); cleared the moment that's no longer true. Lets the pre-game
  // chart get the same fixed left→right axis treatment as a live round, anchored
  // to "since you sat down" rather than the (often much longer) on-chain fill deadline.
  let waitStart: number | null = null
  let dispPrice = 0 // eased toward targetPrice for the "live ticker" feel
  let dirty = true
  let liveUntil = 0 // keep painting (pulse + ease) until this wall-clock time

  // ---- selected timeframe tab (a trailing-window size — see priceRanges.ts) ----
  let range: PriceRange = '1m'
  let connStatus: ConnectionStatus = 'connecting'

  const readData = () => {
    const s = useGameStore.getState()
    history = s.priceHistory
    targetPrice = s.priceHistory.at(-1)?.price ?? null
    connStatus = s.status
    range = s.priceBoardRange
    const decimals = s.terms?.decimals ?? 2
    prediction =
      s.sealStatus === 'sealed' && s.yourPrediction != null
        ? s.yourPrediction / 10 ** decimals
        : null
    if (s.match && s.roundStartedAt != null) {
      axisStart = s.roundStartedAt
      const sec = s.terms?.roundDurationsSec?.[s.match.round - 1]
      axisDurationMs = sec && sec > 0 ? sec * 1000 : DEFAULT_ROUND_MS
      waitStart = null
    } else if (s.seated && (!s.match || !PAST_FILLING_PHASES.includes(s.match.phase))) {
      if (waitStart == null) waitStart = Date.now()
      axisStart = waitStart
      axisDurationMs = DEFAULT_ROUND_MS
    } else {
      waitStart = null
      axisStart = null
      axisDurationMs = null
    }
    if (targetPrice != null && dispPrice === 0) dispPrice = targetPrice
    dirty = true
    // a fresh tick keeps the board "live" (and the pulse breathing) for a beat
    // past the data cadence; once ticks stop, it settles and idles cost-free.
    liveUntil = Date.now() + 900
  }
  readData()
  const unsubscribe = useGameStore.subscribe(readData)

  function update(t: number) {
    // chart button's breathing glow — cheap, runs every frame regardless of
    // whether the chart itself needs a repaint.
    const btnPulse = 0.5 + 0.5 * Math.sin(t * 1.6)
    glowMat.opacity = 0.4 + 0.3 * btnPulse
    glow.scale.setScalar(1 + 0.08 * btnPulse)

    const clock = Date.now()
    if (targetPrice != null) {
      if (dispPrice === 0) dispPrice = targetPrice
      // exponential ease — frame-rate-tolerant for the small per-tick deltas
      dispPrice += (targetPrice - dispPrice) * 0.16
    }
    // While anchored (round or wait) and still within its span, keep repainting even
    // without fresh ticks — the marker travels along the fixed axis purely as wall-clock
    // time passes.
    const anchorLive = axisStart != null && axisDurationMs != null && clock < axisStart + axisDurationMs
    // repaint while data is fresh (animate pulse + ease), once after a change, or while anchored progress continues
    if (dirty || clock < liveUntil || anchorLive) {
      dirty = false
      drawChart({
        history,
        price: targetPrice != null ? dispPrice : null,
        prediction,
        tNow: t,
        clock,
        axisStart,
        axisDurationMs,
        range,
        connStatus,
      })
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
    woodTex.map.dispose()
    woodTex.bumpMap.dispose()
    btnTex.dispose()
    glowTex.dispose()
  }

  return { group, update, dispose, getTabAnchors, getChartButtonAnchor }
}
