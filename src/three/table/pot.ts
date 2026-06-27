import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'

/**
 * The pot — a heap of struck gold "$" sovereigns resting on the felt, lit by the
 * same candlelight and casting the same shadows as the rest of the table.
 *
 * Each coin is modelled as two planar-mapped faces plus a reeded edge cylinder
 * (merged into one mesh with a 3-group material array). The faces carry a fully
 * cartesian-drawn strike — a beveled polished rim, an outer band of engraved
 * glyphs, beaded pearl rings, a baroque scrollwork ring with four cardinal
 * fleurs, and a large beveled "$" raised over a dark cracked patina field — so
 * the design reads true from any angle instead of being squashed by a lathe's
 * polar UVs. The thick edge is heavily milled (reeded) with bright rim lips.
 * Three subtly different gold alloys are minted so the pile catches light
 * unevenly like real metal.
 *
 * The pile grows monotonically with the pot: every coin has a fixed home slot,
 * so as the amount climbs only new coins drop in — the ones already on the felt
 * never shift. A small spill of coins lies flat around the base of the stacks so
 * even a tiny pot looks scattered and hand-built rather than gridded. When the
 * pot shrinks (a fresh hand) the surplus is swept away with a quick fade.
 */

export interface PotPile {
  group: THREE.Group
  /** Set the live pot value; coins animate toward the new amount. */
  setAmount: (amount: number) => void
  /** Advance animations. `t` is the scene clock (seconds-ish). */
  update: (t: number) => void
  dispose: () => void
}

const COIN_R = 0.21 // coin radius (world units)
const COIN_H = 0.06 // coin thickness — chunky enough to show its reeded edge
const GAP = 0.001 // hairline between stacked coins so edges separate
const MAX_CHIPS = 115 // total coin budget in the heap
const HEAP_R = 0.74 // radius of the mound footprint on the felt
const DOME = 5 // height bias: how much taller the centre piles than the rim
const DROP = 1.5 // how far above home a new coin starts
const DROP_DUR = 0.4 // seconds for a coin to settle
const LEAVE_DUR = 0.3 // seconds for a swept coin to vanish

/** coins ≈ 1.5·√amount — a satisfying heap that scales gently with the pot. */
function chipsFor(amount: number): number {
  if (amount <= 0) return 0
  return Math.max(1, Math.min(MAX_CHIPS, Math.round(1.5 * Math.sqrt(amount))))
}

// deterministic pseudo-random in [0,1) from two ints (stable per slot)
function hash(a: number, b: number): number {
  const s = Math.sin(a * 127.1 + b * 311.7) * 43758.5453
  return s - Math.floor(s)
}

const easeOutBack = (x: number) => {
  const c1 = 1.70158,
    c3 = c1 + 1
  return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2)
}
const easeInCubic = (x: number) => x * x * x

// ---- coin geometry ------------------------------------------------------------

/**
 * Two planar-mapped disc faces (front +Y, back -Y) plus an open reeded edge,
 * merged into a single geometry with three material groups: [face, face, edge].
 * Planar face UVs let the "$" and concentric ornaments be drawn in cartesian
 * space and stay legible — a lathe's polar UVs would smear them into the centre.
 */
function coinGeometry(): THREE.BufferGeometry {
  const R = COIN_R,
    H = COIN_H
  const front = new THREE.CircleGeometry(R, 128)
  front.rotateX(-Math.PI / 2) // face up (+Y)
  front.translate(0, H / 2, 0)
  const back = new THREE.CircleGeometry(R, 128)
  back.rotateX(Math.PI / 2) // face down (-Y)
  back.translate(0, -H / 2, 0)
  const edge = new THREE.CylinderGeometry(R, R, H, 128, 1, true)
  return mergeGeometries([front, back, edge], true)!
}

// ---- coin face strike ---------------------------------------------------------

type Mode = 'color' | 'bump' | 'metal' | 'rough'
const GRY = (v: number) => `rgb(${v | 0},${v | 0},${v | 0})`
/** Pick the right fill for the current channel: art colour, or grayscale data. */
function sty(mode: Mode, c: string, b: number, m: number, r: number): string {
  return mode === 'color' ? c : mode === 'bump' ? GRY(b) : mode === 'metal' ? GRY(m) : GRY(r)
}

// gold ramp — bright, polished, high-contrast against the dark field
const G_HI = '#fff4cf'
const G_LT = '#ffdc84'
const G = '#f2bd55'
const G_MD = '#d59a3c'
const G_LO = '#9c7128'
const G_DK = '#5a3f16'

/** Paint one face channel onto a SxS canvas context. */
function paintFace(ctx: CanvasRenderingContext2D, S: number, mode: Mode) {
  const C = S / 2,
    R = S / 2
  const TAU = Math.PI * 2
  const rad = (f: number) => f * R

  // backdrop (outside the coin — never seen, kept neutral)
  ctx.fillStyle = sty(mode, '#000', 128, 0, 220)
  ctx.fillRect(0, 0, S, S)

  ctx.save()
  ctx.beginPath()
  ctx.arc(C, C, R, 0, TAU)
  ctx.clip()

  const ring = (r0: number, r1: number, fill: string) => {
    ctx.beginPath()
    ctx.arc(C, C, rad(r1), 0, TAU)
    ctx.arc(C, C, rad(r0), 0, TAU, true)
    ctx.fillStyle = fill
    ctx.fill('evenodd')
  }
  const circle = (r: number, fill: string) => {
    ctx.beginPath()
    ctx.arc(C, C, rad(r), 0, TAU)
    ctx.fillStyle = fill
    ctx.fill()
  }
  const strokeRing = (r: number, w: number, fill: string) => {
    ctx.beginPath()
    ctx.arc(C, C, rad(r), 0, TAU)
    ctx.lineWidth = w
    ctx.strokeStyle = fill
    ctx.stroke()
  }

  // ---- dark cracked patina field over the whole disc ----
  if (mode === 'color') {
    const g = ctx.createRadialGradient(C, C, rad(0.05), C, C, R)
    g.addColorStop(0, '#140d07')
    g.addColorStop(0.5, '#0e0905')
    g.addColorStop(0.85, '#080503')
    g.addColorStop(1, '#040302')
    ctx.fillStyle = g
  } else {
    ctx.fillStyle = sty(mode, '#000', 112, 55, 205)
  }
  circle(1.0, ctx.fillStyle as string)

  // faint warm mottling + hairline cracks across the central field
  ctx.save()
  ctx.beginPath()
  ctx.arc(C, C, rad(0.9), 0, TAU)
  ctx.clip()
  for (let i = 0; i < 220; i++) {
    const a = hash(i, 1) * TAU,
      rr = Math.sqrt(hash(i, 2)) * rad(0.86)
    const x = C + Math.cos(a) * rr,
      y = C + Math.sin(a) * rr
    const s = 4 + hash(i, 3) * 22
    ctx.fillStyle = sty(mode, `rgba(70,46,22,${0.04 + hash(i, 4) * 0.06})`, 116 + (hash(i, 5) - 0.5) * 16, 64, 198)
    ctx.beginPath()
    ctx.ellipse(x, y, s, s * (0.5 + hash(i, 6) * 0.6), a, 0, TAU)
    ctx.fill()
  }
  ctx.lineCap = 'round'
  for (let i = 0; i < 90; i++) {
    const a = hash(i, 11) * TAU,
      r = hash(i, 12) * rad(0.84)
    let x = C + Math.cos(a) * r,
      y = C + Math.sin(a) * r
    ctx.strokeStyle = sty(mode, 'rgba(0,0,0,0.5)', 92, 60, 210)
    ctx.lineWidth = 0.6 + hash(i, 13) * 1.3
    ctx.beginPath()
    ctx.moveTo(x, y)
    let ang = hash(i, 14) * TAU
    const segs = 2 + (hash(i, 15) * 4) | 0
    for (let s = 0; s < segs; s++) {
      ang += (hash(i * 7, s) - 0.5) * 1.4
      const L = 8 + hash(i * 3, s) * 30
      x += Math.cos(ang) * L
      y += Math.sin(ang) * L
      ctx.lineTo(x, y)
    }
    ctx.stroke()
  }
  ctx.restore()

  // ---- outer beveled polished rim ----
  if (mode === 'color') {
    const g = ctx.createRadialGradient(C, C, rad(0.89), C, C, R)
    g.addColorStop(0, G_LO)
    g.addColorStop(0.4, G)
    g.addColorStop(0.62, G_HI)
    g.addColorStop(0.82, G_LT)
    g.addColorStop(1, G_MD)
    ring(0.89, 1.0, g as unknown as string)
  } else {
    ring(0.89, 1.0, sty(mode, '#000', 232, 250, 64))
  }
  // bright reeding ticks reading around the very edge
  for (let i = 0; i < 200; i++) {
    const a = (i / 200) * TAU
    ctx.strokeStyle = sty(mode, i % 2 ? 'rgba(255,240,190,0.5)' : 'rgba(70,45,15,0.55)', i % 2 ? 250 : 70, 250, 60)
    ctx.lineWidth = 1.4
    ctx.beginPath()
    ctx.moveTo(C + Math.cos(a) * rad(0.9), C + Math.sin(a) * rad(0.9))
    ctx.lineTo(C + Math.cos(a) * rad(0.992), C + Math.sin(a) * rad(0.992))
    ctx.stroke()
  }
  strokeRing(0.89, 3, sty(mode, G_DK, 70, 250, 110))

  // beaded pearl ring helper (reused for the three pearl borders)
  const beadRing = (r: number, n: number, dot: number) => {
    for (let i = 0; i < n; i++) {
      const a = (i / n) * TAU
      const x = C + Math.cos(a) * rad(r),
        y = C + Math.sin(a) * rad(r)
      if (mode === 'color') {
        const g = ctx.createRadialGradient(x - dot * 0.3, y - dot * 0.3, 0.5, x, y, dot)
        g.addColorStop(0, G_HI)
        g.addColorStop(0.6, G)
        g.addColorStop(1, G_LO)
        ctx.fillStyle = g
      } else {
        ctx.fillStyle = sty(mode, '#000', 224, 250, 64)
      }
      ctx.beginPath()
      ctx.arc(x, y, dot, 0, TAU)
      ctx.fill()
    }
  }

  // ---- engraved outer glyph band (narrow, dark, bright marks) ----
  ring(0.75, 0.88, sty(mode, '#080503', 124, 60, 192))
  strokeRing(0.88, 2.5, sty(mode, G_LT, 210, 250, 70))
  strokeRing(0.75, 2.5, sty(mode, G_LT, 210, 250, 70))
  beadRing(0.885, 120, R * 0.0085) // dotted ring hugging the rim
  // repeating ancient/binary-style marks struck in gold
  const glyphs = ['I', '0', 'I', 'II', '·', '0', 'I', '·', 'II', '0', 'I', '·']
  const nG = 52
  const rG = 0.815
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.font = `bold ${Math.round(R * 0.072)}px "Times New Roman", Georgia, serif`
  for (let i = 0; i < nG; i++) {
    const a = (i / nG) * TAU - Math.PI / 2
    const x = C + Math.cos(a) * rad(rG),
      y = C + Math.sin(a) * rad(rG)
    ctx.save()
    ctx.translate(x, y)
    ctx.rotate(a + Math.PI / 2)
    const ch = glyphs[i % glyphs.length]
    if (mode === 'color') {
      ctx.fillStyle = 'rgba(0,0,0,0.7)'
      ctx.fillText(ch, 1.2, 1.4)
      ctx.fillStyle = G_LT
      ctx.fillText(ch, 0, 0)
    } else {
      ctx.fillStyle = sty(mode, '#000', 196, 250, 80)
      ctx.fillText(ch, 0, 0)
    }
    ctx.restore()
  }

  // pearl borders framing the wide scrollwork band
  beadRing(0.73, 104, R * 0.011)
  beadRing(0.44, 64, R * 0.0095)
  strokeRing(0.715, 2, sty(mode, G_MD, 150, 250, 90))
  strokeRing(0.455, 2, sty(mode, G_MD, 150, 250, 90))

  // ---- baroque scrollwork ring with four cardinal fleurs ----
  drawScrollRing(ctx, S, mode)

  // ---- the big struck "$" over the patina field ----
  drawDollar(ctx, S, mode)

  ctx.restore()
}

/** Filigree S-scrolls repeated around the inner band, with N/E/S/W fleurs. */
function drawScrollRing(ctx: CanvasRenderingContext2D, S: number, mode: Mode) {
  const C = S / 2,
    R = S / 2
  const rm = 0.585 * R
  const lw = R * 0.019
  const goldStroke = (drop: boolean) =>
    mode === 'color' ? (drop ? 'rgba(0,0,0,0.6)' : G_HI) : sty(mode, '#000', 224, 250, 58)

  const scroll = (cx: number, cy: number, ang: number, sc: number, flip: number) => {
    ctx.save()
    ctx.translate(cx, cy)
    ctx.rotate(ang)
    ctx.scale(flip * sc, sc)
    ctx.lineCap = 'round'
    ctx.lineWidth = lw / sc
    ctx.beginPath()
    // a C-scroll curling into a spiral eye
    ctx.moveTo(0, -R * 0.03)
    ctx.bezierCurveTo(R * 0.1, -R * 0.04, R * 0.14, R * 0.05, R * 0.1, R * 0.11)
    ctx.bezierCurveTo(R * 0.066, R * 0.155, R * 0.018, R * 0.12, R * 0.045, R * 0.085)
    ctx.stroke()
    // a little leaf bud off the scroll
    ctx.beginPath()
    ctx.ellipse(R * 0.12, -R * 0.012, R * 0.03, R * 0.016, 0.6, 0, Math.PI * 2)
    ctx.stroke()
    ctx.restore()
  }

  const reps = 14
  for (let pass = mode === 'color' ? 0 : 1; pass < 2; pass++) {
    // pass 0 = dark drop shadow (color only), pass 1 = gold
    ctx.strokeStyle = goldStroke(pass === 0)
    const off = pass === 0 ? R * 0.004 : 0
    for (let i = 0; i < reps; i++) {
      const a = (i / reps) * Math.PI * 2 - Math.PI / 2
      const cx = C + Math.cos(a) * rm + off,
        cy = C + Math.sin(a) * rm + off
      // a symmetric pair of mirrored scrolls per sector
      scroll(cx, cy, a + Math.PI / 2, 1, 1)
      scroll(cx, cy, a + Math.PI / 2, 1, -1)
    }
  }

  // four cardinal fleurs (diamond + stem + side curls) like the reference,
  // seated a touch further out so the bold "$" never crowds them
  const rf = 0.62 * R
  const fleur = (a: number) => {
    const cx = C + Math.cos(a) * rf,
      cy = C + Math.sin(a) * rf
    ctx.save()
    ctx.translate(cx, cy)
    ctx.rotate(a + Math.PI / 2)
    const drawFleur = (col: string, ox: number, oy: number) => {
      ctx.fillStyle = col
      ctx.strokeStyle = col
      ctx.lineWidth = R * 0.013
      ctx.lineCap = 'round'
      // central lozenge (long axis radial)
      ctx.beginPath()
      ctx.moveTo(ox + 0, oy - R * 0.1)
      ctx.lineTo(ox + R * 0.038, oy)
      ctx.lineTo(ox + 0, oy + R * 0.082)
      ctx.lineTo(ox - R * 0.038, oy)
      ctx.closePath()
      ctx.fill()
      // top pip
      ctx.beginPath()
      ctx.arc(ox + 0, oy - R * 0.124, R * 0.019, 0, Math.PI * 2)
      ctx.fill()
      // side curls sweeping up like a trident
      ctx.beginPath()
      ctx.moveTo(ox - R * 0.014, oy + R * 0.028)
      ctx.quadraticCurveTo(ox - R * 0.082, oy + R * 0.014, ox - R * 0.068, oy - R * 0.055)
      ctx.moveTo(ox + R * 0.014, oy + R * 0.028)
      ctx.quadraticCurveTo(ox + R * 0.082, oy + R * 0.014, ox + R * 0.068, oy - R * 0.055)
      ctx.stroke()
    }
    if (mode === 'color') {
      drawFleur('rgba(0,0,0,0.6)', R * 0.004, R * 0.004)
      drawFleur(G_HI, 0, 0)
    } else {
      drawFleur(sty(mode, '#000', 224, 250, 62), 0, 0)
    }
    ctx.restore()
  }
  for (let k = 0; k < 4; k++) fleur((k / 4) * Math.PI * 2 - Math.PI / 2)
}

/** A large beveled gold dollar sign struck over the central field. */
function drawDollar(ctx: CanvasRenderingContext2D, S: number, mode: Mode) {
  const C = S / 2
  ctx.save()
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.font = `bold ${Math.round(S * 0.74)}px Georgia, "Times New Roman", serif`
  const ch = '$'
  if (mode === 'color') {
    // soft cast shadow into the patina
    ctx.fillStyle = 'rgba(0,0,0,0.55)'
    ctx.fillText(ch, C + S * 0.012, C + S * 0.016)
    // body gradient
    const g = ctx.createLinearGradient(0, C - S * 0.3, 0, C + S * 0.3)
    g.addColorStop(0, G_HI)
    g.addColorStop(0.4, G_LT)
    g.addColorStop(0.55, G)
    g.addColorStop(0.8, G_MD)
    g.addColorStop(1, G_LO)
    ctx.fillStyle = g
    ctx.fillText(ch, C, C)
    // top-left bevel highlight
    ctx.fillStyle = 'rgba(255,248,214,0.5)'
    ctx.fillText(ch, C - S * 0.006, C - S * 0.008)
  } else if (mode === 'bump') {
    // dark halo (recessed) then bright body (raised) for a beveled relief
    ctx.fillStyle = GRY(80)
    ctx.lineWidth = S * 0.02
    ctx.strokeStyle = GRY(80)
    ctx.strokeText(ch, C, C)
    ctx.fillStyle = GRY(238)
    ctx.fillText(ch, C, C)
    ctx.fillStyle = GRY(255)
    ctx.fillText(ch, C - S * 0.005, C - S * 0.006)
  } else {
    ctx.fillStyle = sty(mode, '#000', 0, 250, 58)
    ctx.fillText(ch, C, C)
  }
  ctx.restore()
}

function buildFaceMaps(): {
  map: THREE.Texture
  bumpMap: THREE.Texture
  metalnessMap: THREE.Texture
  roughnessMap: THREE.Texture
} {
  const S = 1024
  const make = (mode: Mode, srgb: boolean) => {
    const cv = document.createElement('canvas')
    cv.width = cv.height = S
    paintFace(cv.getContext('2d')!, S, mode)
    const t = new THREE.CanvasTexture(cv)
    if (srgb) t.colorSpace = THREE.SRGBColorSpace
    t.anisotropy = 8
    return t
  }
  return {
    map: make('color', true),
    bumpMap: make('bump', false),
    metalnessMap: make('metal', false),
    roughnessMap: make('rough', false),
  }
}

// ---- reeded edge --------------------------------------------------------------

function paintEdge(ctx: CanvasRenderingContext2D, W: number, H: number, mode: Mode) {
  // base gold
  if (mode === 'color') {
    const g = ctx.createLinearGradient(0, 0, 0, H)
    g.addColorStop(0, G_MD)
    g.addColorStop(0.12, G_HI)
    g.addColorStop(0.2, G_LT)
    g.addColorStop(0.5, G)
    g.addColorStop(0.8, G_LT)
    g.addColorStop(0.88, G_HI)
    g.addColorStop(1, G_MD)
    ctx.fillStyle = g
  } else {
    ctx.fillStyle = sty(mode, '#000', 150, 250, 78)
  }
  ctx.fillRect(0, 0, W, H)

  // vertical reeds (milling)
  const reeds = 150
  for (let i = 0; i < reeds; i++) {
    const x = (i / reeds) * W
    const w = W / reeds
    // bright crest
    ctx.fillStyle = sty(mode, 'rgba(255,243,200,0.55)', 220, 250, 50)
    ctx.fillRect(x, 0, w * 0.42, H)
    // dark groove
    ctx.fillStyle = sty(mode, 'rgba(50,32,10,0.6)', 70, 250, 120)
    ctx.fillRect(x + w * 0.5, 0, w * 0.4, H)
  }
  // bright polished rim lips top & bottom
  ctx.fillStyle = sty(mode, 'rgba(255,245,205,0.6)', 235, 250, 46)
  ctx.fillRect(0, 0, W, H * 0.09)
  ctx.fillRect(0, H * 0.91, W, H * 0.09)
  ctx.fillStyle = sty(mode, 'rgba(0,0,0,0.45)', 96, 250, 150)
  ctx.fillRect(0, H * 0.09, W, H * 0.02)
  ctx.fillRect(0, H * 0.89, W, H * 0.02)
}

function buildEdgeMaps(): {
  map: THREE.Texture
  bumpMap: THREE.Texture
  metalnessMap: THREE.Texture
  roughnessMap: THREE.Texture
} {
  const W = 2048,
    H = 128
  const make = (mode: Mode, srgb: boolean) => {
    const cv = document.createElement('canvas')
    cv.width = W
    cv.height = H
    paintEdge(cv.getContext('2d')!, W, H, mode)
    const t = new THREE.CanvasTexture(cv)
    if (srgb) t.colorSpace = THREE.SRGBColorSpace
    t.wrapS = THREE.RepeatWrapping
    t.anisotropy = 8
    return t
  }
  return {
    map: make('color', true),
    bumpMap: make('bump', false),
    metalnessMap: make('metal', false),
    roughnessMap: make('rough', false),
  }
}

// three gold alloys so the heap doesn't read as one uniform colour
const ALLOY_TINTS = [0xf3d489, 0xe8c270, 0xead09a]

// ---- coin pile ---------------------------------------------------------------

interface Chip {
  mesh: THREE.Mesh
  homeY: number
  born: number
  leaving: boolean
  leaveStart: number
  spin: number // residual settle wobble seed
}

interface Slot {
  x: number
  z: number
  homeY: number
  rotY: number
  lean: number
  leanAxis: number
  matIdx: number
}

export function createPotPile(opts: { feltY: number; center: THREE.Vector3 }): PotPile {
  const group = new THREE.Group()
  group.position.copy(opts.center)
  group.position.y = opts.feltY

  const geom = coinGeometry()
  const faceMaps = buildFaceMaps()
  const edgeMaps = buildEdgeMaps()

  // one [face, face, edge] material array per alloy tint
  const matSets = ALLOY_TINTS.map((tint) => {
    const face = new THREE.MeshStandardMaterial({
      ...faceMaps,
      bumpScale: 0.6,
      color: tint,
      metalness: 1.0,
      roughness: 0.24,
      envMapIntensity: 1.15,
      emissive: 0xffffff,
      emissiveMap: faceMaps.map,
      emissiveIntensity: 0.09,
    })
    const edge = new THREE.MeshStandardMaterial({
      ...edgeMaps,
      bumpScale: 0.6,
      color: tint,
      metalness: 1.0,
      roughness: 0.22,
      envMapIntensity: 1.3,
      emissive: 0xffffff,
      emissiveMap: edgeMaps.map,
      emissiveIntensity: 0.12,
    })
    return [face, face, edge] as THREE.Material[]
  })

  // Precompute every coin's fixed home slot as a physically sound mound. Coins
  // stack into a hexagonal lattice of columns whose centres are more than one
  // coin-diameter apart, so coins in neighbouring columns can never overlap —
  // nothing intertwines. Each new coin drops into the column that keeps the heap
  // a rounded dome (centre piles tallest, the rim gets a coin or two for a
  // natural scattered base). The order is monotonic — slot i never changes, so
  // growing the pot only reveals later slots and placed coins hold still.
  const slots: Slot[] = []
  {
    // hex lattice of column centres, spaced just over a diameter apart
    const S = 2 * COIN_R * 1.06
    const ROW = S * 0.8660254
    const cols: { x: number; z: number; r: number; h: number; bias: number }[] = []
    const jmax = Math.ceil(HEAP_R / ROW) + 1
    const kmax = Math.ceil(HEAP_R / S) + 1
    for (let j = -jmax; j <= jmax; j++) {
      const cz = j * ROW
      const xoff = j & 1 ? S / 2 : 0
      for (let k = -kmax; k <= kmax; k++) {
        const cx = k * S + xoff
        const r = Math.hypot(cx, cz)
        // a fixed per-column reluctance breaks the even fill into an organic,
        // hand-stacked profile — some columns end up taller than their neighbours
        if (r <= HEAP_R) cols.push({ x: cx, z: cz, r, h: 0, bias: hash(k * 13 + 1, j * 7 + 3) * 1.6 })
      }
    }
    for (let i = 0; i < MAX_CHIPS; i++) {
      // pick the column that best keeps a domed profile (low + central wins),
      // nudged by each column's reluctance so heights stagger naturally
      let best = cols[0],
        bestCost = Infinity
      for (const c of cols) {
        const cost = c.h + DOME * (c.r / HEAP_R) ** 2 + c.bias
        if (cost < bestCost) {
          bestCost = cost
          best = c
        }
      }
      const h = best.h++
      // tiny in-cell jitter (kept well under the lattice margin so columns stay
      // more than a diameter apart) and a touch more lean for lone base coins
      const jx = (hash(i, 1) - 0.5) * 0.008
      const jz = (hash(i, 2) - 0.5) * 0.008
      const lean = (hash(i, 4) - 0.5) * (h === 0 ? 0.07 : 0.03)
      slots.push({
        x: best.x + jx,
        z: best.z + jz,
        homeY: COIN_H / 2 + h * (COIN_H + GAP) + COIN_R * Math.sin(Math.abs(lean)),
        rotY: hash(i, 3) * Math.PI * 2,
        lean,
        leanAxis: hash(i, 5) * Math.PI * 2,
        matIdx: i % matSets.length,
      })
    }
  }

  const chips: Chip[] = []
  let target = 0
  let lastT = -1

  function grow(to: number, t: number) {
    for (let i = chips.length; i < to; i++) {
      const sl = slots[i]
      const mesh = new THREE.Mesh(geom, matSets[sl.matIdx])
      mesh.castShadow = true
      mesh.receiveShadow = true
      mesh.position.set(sl.x, sl.homeY, sl.z)
      // lean the coin off-axis a touch so stacks aren't perfectly columnar
      mesh.rotation.set(
        Math.cos(sl.leanAxis) * sl.lean,
        sl.rotY,
        Math.sin(sl.leanAxis) * sl.lean,
      )
      group.add(mesh)
      chips.push({ mesh, homeY: sl.homeY, born: t, leaving: false, leaveStart: 0, spin: hash(i, 6) })
    }
  }

  function setAmount(amount: number) {
    target = chipsFor(amount)
  }

  function update(t: number) {
    if (lastT < 0) lastT = t

    const live = chips.filter((c) => !c.leaving).length
    if (target > live) {
      grow(target, t)
    } else if (target < live) {
      let excess = live - target
      for (let i = chips.length - 1; i >= 0 && excess > 0; i--) {
        const c = chips[i]
        if (!c.leaving) {
          c.leaving = true
          c.leaveStart = t
          excess--
        }
      }
    }

    for (let i = chips.length - 1; i >= 0; i--) {
      const c = chips[i]
      if (c.leaving) {
        const p = Math.min(1, (t - c.leaveStart) / LEAVE_DUR)
        const s = 1 - easeInCubic(p)
        c.mesh.scale.setScalar(Math.max(0.0001, s))
        c.mesh.position.y = c.homeY + p * 0.5
        if (p >= 1) {
          group.remove(c.mesh)
          chips.splice(i, 1)
        }
      } else {
        const age = t - c.born
        const p = Math.min(1, age / DROP_DUR)
        const settle = easeOutBack(p)
        c.mesh.position.y = c.homeY + (1 - settle) * DROP
        const sc = Math.min(1, age / (DROP_DUR * 0.5))
        c.mesh.scale.setScalar(0.6 + 0.4 * sc)
      }
    }
    lastT = t
  }

  function dispose() {
    geom.dispose()
    ;[faceMaps, edgeMaps].forEach((m) =>
      Object.values(m).forEach((t) => (t as THREE.Texture).dispose()),
    )
    matSets.forEach((set) => set.forEach((m) => m.dispose()))
  }

  return { group, setAmount, update, dispose }
}
