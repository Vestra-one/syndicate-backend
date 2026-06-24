import * as THREE from 'three'
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js'
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js'
import { createPriceBoard } from './priceBoard'

/**
 * The centerpiece: a candlelit, baroque price-betting table.
 *
 * This is an imperative Three.js engine intentionally kept outside React's
 * render cycle. `createTableScene` mounts a canvas into `container`, owns its
 * own RAF loop, and returns a handle for disposal. Gameplay layers (chips,
 * markers, seats, price arcs) will attach to `scene` in later steps.
 */
export interface TableSceneHandle {
  scene: THREE.Scene
  camera: THREE.PerspectiveCamera
  /** Outer radius of the table in world units — anchor for placing gameplay objects. */
  tableRadius: number
  /** World-space Y of the felt playing surface. */
  feltY: number
  dispose: () => void
}

export function createTableScene(container: HTMLElement): TableSceneHandle {
  // ---------- helpers ----------
  const rand = (a: number, b: number) => a + Math.random() * (b - a)
  function noiseFill(ctx: CanvasRenderingContext2D, w: number, h: number, _base: number, amt: number) {
    const id = ctx.getImageData(0, 0, w, h)
    const d = id.data
    for (let i = 0; i < d.length; i += 4) {
      const n = (Math.random() - 0.5) * amt
      d[i] = Math.max(0, Math.min(255, d[i] + n))
      d[i + 1] = Math.max(0, Math.min(255, d[i + 1] + n))
      d[i + 2] = Math.max(0, Math.min(255, d[i + 2] + n))
    }
    ctx.putImageData(id, 0, 0)
  }

  // ---------- master top-down table texture ----------
  // radii as fraction of outer radius
  const R_FELT = 0.56 // felt disc edge (recessed well)
  const R_WELL = 0.588 // top of well / inner rope edge
  const R_BAND0 = 0.588,
    R_BAND1 = 0.716 // wide engraved gold inscription band (own mesh)
  const R_WOOD0 = 0.716 // burl wood rail
  const R_OGOLD0 = 0.95,
    R_OGOLD1 = 0.968 // outer gold line

  function buildTableTextures() {
    const S = 2048,
      C = S / 2,
      R = S / 2
    const col = document.createElement('canvas')
    col.width = col.height = S
    const met = document.createElement('canvas')
    met.width = met.height = S
    const rou = document.createElement('canvas')
    rou.width = rou.height = S
    const cx = col.getContext('2d')!,
      mx = met.getContext('2d')!,
      rx = rou.getContext('2d')!

    cx.fillStyle = '#000'
    cx.fillRect(0, 0, S, S)
    mx.fillStyle = '#000'
    mx.fillRect(0, 0, S, S)
    rx.fillStyle = '#888'
    rx.fillRect(0, 0, S, S)

    const ring = (ctx: CanvasRenderingContext2D, r0: number, r1: number, style: string) => {
      ctx.beginPath()
      ctx.arc(C, C, r1 * R, 0, Math.PI * 2)
      ctx.arc(C, C, r0 * R, 0, Math.PI * 2, true)
      ctx.fillStyle = style
      ctx.fill('evenodd')
    }

    // ---- WOOD RAIL (burl mahogany) ----
    ring(cx, R_WOOD0, 1.0, '#3a190d')
    ring(rx, R_WOOD0, 1.0, '#7a7a7a')
    ring(mx, R_WOOD0, 1.0, '#000')
    cx.save()
    cx.beginPath()
    cx.arc(C, C, 1.0 * R, 0, Math.PI * 2)
    cx.arc(C, C, R_WOOD0 * R, 0, Math.PI * 2, true)
    cx.clip('evenodd')
    for (let i = 0; i < 7000; i++) {
      const a = rand(0, Math.PI * 2),
        rr = rand(R_WOOD0, 0.998) * R
      const x = C + Math.cos(a) * rr,
        y = C + Math.sin(a) * rr
      const s = rand(2, 11)
      const tt = Math.random()
      let cstr: string
      if (tt < 0.5)
        cstr = `rgba(${(108 + rand(-22, 28)) | 0},${(44 + rand(-12, 16)) | 0},${(26 + rand(-8, 12)) | 0},0.14)`
      else if (tt < 0.85) cstr = `rgba(30,13,8,0.20)`
      else cstr = `rgba(${(150 + rand(0, 38)) | 0},${78},${42},0.07)`
      cx.fillStyle = cstr
      cx.beginPath()
      cx.ellipse(x, y, s, s * rand(0.4, 1), a, 0, Math.PI * 2)
      cx.fill()
    }
    for (let i = 0; i < 140; i++) {
      const a = rand(0, Math.PI * 2),
        rr = rand(R_WOOD0, 0.99) * R
      const x = C + Math.cos(a) * rr,
        y = C + Math.sin(a) * rr,
        s = rand(14, 40)
      const g = cx.createRadialGradient(x, y, 0, x, y, s)
      g.addColorStop(0, 'rgba(125,64,34,0.10)')
      g.addColorStop(0.6, 'rgba(58,26,15,0.07)')
      g.addColorStop(1, 'rgba(0,0,0,0)')
      cx.fillStyle = g
      cx.beginPath()
      cx.ellipse(x, y, s, s * rand(0.5, 1), a, 0, Math.PI * 2)
      cx.fill()
    }
    cx.lineCap = 'round'
    for (let i = 0; i < 520; i++) {
      let a = rand(0, Math.PI * 2),
        r = rand(R_WOOD0, 0.94) * R
      cx.strokeStyle = `rgba(${rand(36, 76) | 0},${rand(16, 32) | 0},${rand(8, 16) | 0},${rand(0.05, 0.15)})`
      cx.lineWidth = rand(0.7, 2.0)
      cx.beginPath()
      cx.moveTo(C + Math.cos(a) * r, C + Math.sin(a) * r)
      const dir = Math.random() < 0.5 ? 1 : -1
      for (let s = 0; s < 7; s++) {
        a += dir * rand(0.015, 0.05)
        r += rand(-13, 13)
        cx.lineTo(C + Math.cos(a) * r, C + Math.sin(a) * r)
      }
      cx.stroke()
    }
    for (let i = 0; i < 900; i++) {
      const a = rand(0, 7),
        r0 = rand(R_WOOD0, 0.93) * R,
        len = rand(20, 90)
      cx.strokeStyle = `rgba(${rand(20, 60) | 0},${rand(8, 22) | 0},${rand(4, 12) | 0},0.10)`
      cx.lineWidth = rand(0.5, 1.4)
      cx.beginPath()
      cx.moveTo(C + Math.cos(a) * r0, C + Math.sin(a) * r0)
      cx.lineTo(C + Math.cos(a) * (r0 + len), C + Math.sin(a) * (r0 + len))
      cx.stroke()
    }
    const panels = 28
    for (let i = 0; i < panels; i++) {
      const a = (i / panels) * Math.PI * 2
      cx.strokeStyle = 'rgba(12,5,3,0.6)'
      cx.lineWidth = 3
      cx.beginPath()
      cx.moveTo(C + Math.cos(a) * R_WOOD0 * R, C + Math.sin(a) * R_WOOD0 * R)
      cx.lineTo(C + Math.cos(a) * 1.0 * R, C + Math.sin(a) * 1.0 * R)
      cx.stroke()
      cx.strokeStyle = 'rgba(150,80,40,0.10)'
      cx.lineWidth = 2
      const a2 = a + 0.004
      cx.beginPath()
      cx.moveTo(C + Math.cos(a2) * R_WOOD0 * R, C + Math.sin(a2) * R_WOOD0 * R)
      cx.lineTo(C + Math.cos(a2) * 1.0 * R, C + Math.sin(a2) * 1.0 * R)
      cx.stroke()
    }
    cx.restore()

    // ---- OUTER GOLD LINE ----
    const gold = '#caa23f'
    ring(cx, R_OGOLD0, R_OGOLD1, gold)
    ring(mx, R_OGOLD0, R_OGOLD1, '#fff')
    ring(rx, R_OGOLD0, R_OGOLD1, '#3a3a3a')
    ring(cx, R_OGOLD1, 1.0, '#1a0d08')
    ring(rx, R_OGOLD1, 1.0, '#666')

    const mk = (t: THREE.Texture) => {
      t.colorSpace = THREE.SRGBColorSpace
      t.anisotropy = 8
      return t
    }
    const cT = mk(new THREE.CanvasTexture(col))
    const mT = new THREE.CanvasTexture(met)
    mT.anisotropy = 8
    const rT = new THREE.CanvasTexture(rou)
    rT.anisotropy = 8
    return { map: cT, metalnessMap: mT, roughnessMap: rT }
  }

  // dark wood side texture
  function buildSideTexture() {
    const w = 1024,
      h = 128,
      c = document.createElement('canvas')
    c.width = w
    c.height = h
    const x = c.getContext('2d')!
    x.fillStyle = '#150a06'
    x.fillRect(0, 0, w, h)
    for (let i = 0; i < 1400; i++) {
      x.fillStyle = `rgba(${rand(40, 90) | 0},${rand(18, 40) | 0},${rand(10, 22) | 0},0.10)`
      x.beginPath()
      x.ellipse(rand(0, w), rand(0, h), rand(4, 40), rand(2, 8), 0, 0, Math.PI * 2)
      x.fill()
    }
    noiseFill(x, w, h, 0, 18)
    const t = new THREE.CanvasTexture(c)
    t.colorSpace = THREE.SRGBColorSpace
    t.wrapS = THREE.RepeatWrapping
    t.repeat.set(3, 1)
    return t
  }

  // ---------- recessed felt texture ----------
  function buildFeltTexture() {
    const S = 1024,
      C = S / 2,
      R = S / 2,
      c = document.createElement('canvas')
    c.width = c.height = S
    const cx = c.getContext('2d')!
    const rc = document.createElement('canvas')
    rc.width = rc.height = S
    const rx = rc.getContext('2d')!
    cx.fillStyle = '#0a110c'
    cx.fillRect(0, 0, S, S)
    rx.fillStyle = '#d8d8d8'
    rx.fillRect(0, 0, S, S)
    cx.save()
    cx.beginPath()
    cx.arc(C, C, R, 0, Math.PI * 2)
    cx.clip()
    for (let i = 0; i < 1700; i++) {
      const a = rand(0, 7),
        rr = Math.sqrt(Math.random()) * R
      cx.fillStyle = `rgba(${rand(8, 26) | 0},${rand(22, 40) | 0},${rand(16, 30) | 0},0.16)`
      cx.beginPath()
      cx.arc(C + Math.cos(a) * rr, C + Math.sin(a) * rr, rand(10, 40), 0, Math.PI * 2)
      cx.fill()
    }
    cx.lineCap = 'round'
    for (let i = 0; i < 320; i++) {
      const a = rand(0, 7),
        rr = Math.sqrt(Math.random()) * R * 0.97
      let x = C + Math.cos(a) * rr,
        y = C + Math.sin(a) * rr
      cx.strokeStyle = `rgba(${(150 + rand(0, 60)) | 0},${(110 + rand(0, 40)) | 0},${(40 + rand(0, 30)) | 0},${rand(0.05, 0.2)})`
      cx.lineWidth = rand(0.6, 1.5)
      cx.beginPath()
      cx.moveTo(x, y)
      let ang = rand(0, 7)
      for (let s = 0; s < rand(3, 7); s++) {
        ang += rand(-0.9, 0.9)
        const L = rand(10, 40)
        x += Math.cos(ang) * L
        y += Math.sin(ang) * L
        cx.lineTo(x, y)
      }
      cx.stroke()
    }
    cx.strokeStyle = 'rgba(190,150,70,0.28)'
    cx.lineWidth = 2.2
    cx.beginPath()
    cx.arc(C, C, R * 0.84, 0, Math.PI * 2)
    cx.stroke()
    cx.strokeStyle = 'rgba(190,150,70,0.15)'
    cx.lineWidth = 1.6
    cx.beginPath()
    cx.arc(C, C, R * 0.6, 0, Math.PI * 2)
    cx.stroke()
    const ao = cx.createRadialGradient(C, C, R * 0.55, C, C, R)
    ao.addColorStop(0, 'rgba(0,0,0,0)')
    ao.addColorStop(0.82, 'rgba(0,0,0,0.10)')
    ao.addColorStop(1, 'rgba(0,0,0,0.55)')
    cx.fillStyle = ao
    cx.fillRect(0, 0, S, S)
    cx.restore()
    const mk = (t: THREE.Texture) => {
      t.colorSpace = THREE.SRGBColorSpace
      t.anisotropy = 8
      return t
    }
    const cT = mk(new THREE.CanvasTexture(c))
    const rT = new THREE.CanvasTexture(rc)
    rT.anisotropy = 8
    return { map: cT, roughnessMap: rT }
  }

  // ---------- gold molding strip (for torus rings) ----------
  function buildGoldStrip(type: 'bead' | 'line') {
    const w = 64,
      h = 64
    const mkc = () => {
      const c = document.createElement('canvas')
      c.width = w
      c.height = h
      return c
    }
    const c = mkc(),
      b = mkc(),
      r = mkc()
    const cx = c.getContext('2d')!,
      bx = b.getContext('2d')!,
      rx = r.getContext('2d')!
    if (type === 'bead') {
      cx.fillStyle = '#4a3410'
      cx.fillRect(0, 0, w, h)
      bx.fillStyle = '#3a3a3a'
      bx.fillRect(0, 0, w, h)
      rx.fillStyle = '#9a9a9a'
      rx.fillRect(0, 0, w, h)
      const cg = cx.createRadialGradient(w / 2, h / 2, 1, w / 2, h / 2, w * 0.47)
      cg.addColorStop(0, '#ffeab0')
      cg.addColorStop(0.45, '#e0ad42')
      cg.addColorStop(0.8, '#9a7224')
      cg.addColorStop(1, '#5a4214')
      cx.fillStyle = cg
      cx.beginPath()
      cx.arc(w / 2, h / 2, w * 0.47, 0, Math.PI * 2)
      cx.fill()
      const bg = bx.createRadialGradient(w / 2, h / 2, 1, w / 2, h / 2, w * 0.47)
      bg.addColorStop(0, '#ffffff')
      bg.addColorStop(0.7, '#888')
      bg.addColorStop(1, '#111')
      bx.fillStyle = bg
      bx.beginPath()
      bx.arc(w / 2, h / 2, w * 0.47, 0, Math.PI * 2)
      bx.fill()
      const rg = rx.createRadialGradient(w / 2, h / 2, 1, w / 2, h / 2, w * 0.47)
      rg.addColorStop(0, '#2e2e2e')
      rg.addColorStop(1, '#707070')
      rx.fillStyle = rg
      rx.beginPath()
      rx.arc(w / 2, h / 2, w * 0.47, 0, Math.PI * 2)
      rx.fill()
    } else {
      const cg = cx.createLinearGradient(0, 0, 0, h)
      cg.addColorStop(0, '#5e4314')
      cg.addColorStop(0.32, '#b88c38')
      cg.addColorStop(0.48, '#fff2cc')
      cg.addColorStop(0.56, '#f0d488')
      cg.addColorStop(0.72, '#9a7228')
      cg.addColorStop(1, '#4e3810')
      cx.fillStyle = cg
      cx.fillRect(0, 0, w, h)
      for (let i = 0; i < 40; i++) {
        cx.fillStyle = `rgba(${rand(120, 255) | 0},${rand(90, 200) | 0},${rand(40, 110) | 0},0.10)`
        cx.fillRect(rand(0, w), 0, rand(1, 3), h)
      }
      bx.fillStyle = '#888'
      bx.fillRect(0, 0, w, h)
      const rg = rx.createLinearGradient(0, 0, 0, h)
      rg.addColorStop(0, '#555')
      rg.addColorStop(0.48, '#111')
      rg.addColorStop(0.56, '#1a1a1a')
      rg.addColorStop(1, '#555')
      rx.fillStyle = rg
      rx.fillRect(0, 0, w, h)
    }
    const mk = (cv: HTMLCanvasElement, srgb: boolean) => {
      const t = new THREE.CanvasTexture(cv)
      if (srgb) t.colorSpace = THREE.SRGBColorSpace
      t.wrapS = t.wrapT = THREE.RepeatWrapping
      t.anisotropy = 8
      return t
    }
    return { map: mk(c, true), bumpMap: mk(b, false), roughnessMap: mk(r, false) }
  }

  // ---------- premium engraved rim STRIP ----------
  function buildRimStrip() {
    const W = 8192,
      H = 256
    const mkc = () => {
      const c = document.createElement('canvas')
      c.width = W
      c.height = H
      return c
    }
    const c = mkc(),
      m = mkc(),
      r = mkc(),
      b = mkc()
    const cx = c.getContext('2d')!,
      mx = m.getContext('2d')!,
      rx = r.getContext('2d')!,
      bx = b.getContext('2d')!
    const grad = (ctx: CanvasRenderingContext2D, stops: [number, string][]) => {
      const g = ctx.createLinearGradient(0, 0, 0, H)
      for (const s of stops) g.addColorStop(s[0], s[1])
      ctx.fillStyle = g
      ctx.fillRect(0, 0, W, H)
    }
    grad(cx, [
      [0, '#a87f30'],
      [0.09, '#f8dd96'],
      [0.17, '#86631f'],
      [0.3, '#6b5018'],
      [0.5, '#5a4514'],
      [0.7, '#6b5018'],
      [0.83, '#86631f'],
      [0.91, '#f8dd96'],
      [1, '#a87f30'],
    ])
    mx.fillStyle = '#f2f2f2'
    mx.fillRect(0, 0, W, H)
    grad(rx, [
      [0, '#646464'],
      [0.09, '#3a3a3a'],
      [0.17, '#787878'],
      [0.5, '#909090'],
      [0.83, '#787878'],
      [0.91, '#3a3a3a'],
      [1, '#646464'],
    ])
    grad(bx, [
      [0, '#9a9a9a'],
      [0.09, '#f0f0f0'],
      [0.17, '#6e6e6e'],
      [0.5, '#565656'],
      [0.83, '#6e6e6e'],
      [0.91, '#f0f0f0'],
      [1, '#9a9a9a'],
    ])

    for (let i = 0; i < 1500; i++) {
      const y = Math.random() * H,
        lite = Math.random() < 0.5
      cx.strokeStyle = `rgba(${lite ? 255 : 28},${lite ? 222 : 16},${lite ? 162 : 8},${rand(0.02, 0.06)})`
      cx.lineWidth = rand(0.4, 1.1)
      cx.beginPath()
      cx.moveTo(0, y)
      cx.lineTo(W, y)
      cx.stroke()
      const bl = Math.random() < 0.5
      bx.strokeStyle = `rgba(${bl ? 255 : 0},${bl ? 255 : 0},${bl ? 255 : 0},${rand(0.03, 0.07)})`
      bx.lineWidth = rand(0.4, 1.0)
      bx.beginPath()
      bx.moveTo(0, y)
      bx.lineTo(W, y)
      bx.stroke()
    }
    for (let i = 0; i < 140; i++) {
      const y = rand(0, H),
        x0 = rand(0, W),
        len = rand(120, 640),
        lite = Math.random() < 0.6
      cx.strokeStyle = `rgba(${lite ? 255 : 18},${lite ? 236 : 11},${lite ? 188 : 6},${rand(0.05, 0.13)})`
      cx.lineWidth = rand(0.5, 1.3)
      cx.beginPath()
      cx.moveTo(x0, y)
      cx.lineTo(x0 + len, y + rand(-5, 5))
      cx.stroke()
      rx.strokeStyle = `rgba(255,255,255,${rand(0.05, 0.12)})`
      rx.lineWidth = rand(0.5, 1.2)
      rx.beginPath()
      rx.moveTo(x0, y)
      rx.lineTo(x0 + len, y + rand(-5, 5))
      rx.stroke()
    }
    const rivetRow = (vy: number, count: number, rad: number) => {
      const y = vy * H
      for (let i = 0; i < count; i++) {
        const x = ((i + 0.5) / count) * W
        const g = cx.createRadialGradient(x - rad * 0.3, y - rad * 0.3, 1, x, y, rad)
        g.addColorStop(0, '#fff4d2')
        g.addColorStop(0.5, '#e9bb58')
        g.addColorStop(1, '#765619')
        cx.fillStyle = g
        cx.beginPath()
        cx.arc(x, y, rad, 0, Math.PI * 2)
        cx.fill()
        const bg = bx.createRadialGradient(x, y, 1, x, y, rad)
        bg.addColorStop(0, '#ffffff')
        bg.addColorStop(0.55, '#b8b8b8')
        bg.addColorStop(1, '#3a3a3a')
        bx.fillStyle = bg
        bx.beginPath()
        bx.arc(x, y, rad, 0, Math.PI * 2)
        bx.fill()
        rx.fillStyle = '#161616'
        rx.beginPath()
        rx.arc(x, y, rad * 0.85, 0, Math.PI * 2)
        rx.fill()
      }
    }
    rivetRow(0.15, 232, 6.0)
    rivetRow(0.85, 232, 6.0)
    const beadLine = (vy: number, count: number, rad: number) => {
      const y = vy * H
      for (let i = 0; i < count; i++) {
        const x = ((i + 0.5) / count) * W
        const g = cx.createRadialGradient(x, y, 0, x, y, rad)
        g.addColorStop(0, '#fff6db')
        g.addColorStop(0.6, '#edc468')
        g.addColorStop(1, '#8a651f')
        cx.fillStyle = g
        cx.beginPath()
        cx.arc(x, y, rad, 0, Math.PI * 2)
        cx.fill()
        bx.fillStyle = '#f2f2f2'
        bx.beginPath()
        bx.arc(x, y, rad * 0.85, 0, Math.PI * 2)
        bx.fill()
        rx.fillStyle = '#202020'
        rx.beginPath()
        rx.arc(x, y, rad, 0, Math.PI * 2)
        rx.fill()
      }
    }
    beadLine(0.255, 300, 3.0)
    beadLine(0.745, 300, 3.0)

    const fs = H * 0.42
    const font = `${fs}px Georgia, "Times New Roman", serif`
    for (const ctx of [cx, bx, rx]) {
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.font = font
    }
    const phrase = 'FORTVNA·AVDACES·IVVAT· ALEA·IACTA·EST· NIL·SINE·NVMINE· '
    const advance = fs * 0.62,
      count = Math.round(W / advance),
      y = H * 0.5
    for (let i = 0; i < count; i++) {
      const x = ((i + 0.5) / count) * W,
        ch = phrase[i % phrase.length]
      cx.fillStyle = 'rgba(12,7,1,0.9)'
      cx.fillText(ch, x + 2.2, y + 2.6)
      cx.fillStyle = '#e6c163'
      cx.fillText(ch, x, y)
      cx.fillStyle = 'rgba(255,244,210,0.55)'
      cx.fillText(ch, x - 1.0, y - 1.4)
      bx.fillStyle = '#ededed'
      bx.fillText(ch, x, y)
      rx.fillStyle = '#202020'
      rx.fillText(ch, x, y)
    }
    const mk = (cv: HTMLCanvasElement, srgb: boolean) => {
      const t = new THREE.CanvasTexture(cv)
      if (srgb) t.colorSpace = THREE.SRGBColorSpace
      t.wrapS = THREE.RepeatWrapping
      t.wrapT = THREE.ClampToEdgeWrapping
      t.anisotropy = 16
      return t
    }
    return {
      map: mk(c, true),
      metalnessMap: mk(m, false),
      roughnessMap: mk(r, false),
      bumpMap: mk(b, false),
    }
  }

  // flat ring geometry with cylindrical UVs
  function makeRingUV(rIn: number, rOut: number, seg: number) {
    const g = new THREE.RingGeometry(rIn, rOut, seg, 3)
    const p = g.attributes.position,
      uv = g.attributes.uv
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i),
        yy = p.getY(i),
        rr = Math.hypot(x, yy)
      let u = Math.atan2(yy, x) / (Math.PI * 2)
      if (u < 0) u += 1
      uv.setXY(i, u, (rr - rIn) / (rOut - rIn))
    }
    uv.needsUpdate = true
    return g
  }

  // soft radial glow sprite texture
  const glowTex = (() => {
    const c = document.createElement('canvas')
    c.width = c.height = 128
    const x = c.getContext('2d')!
    const g = x.createRadialGradient(64, 64, 0, 64, 64, 64)
    g.addColorStop(0, 'rgba(255,235,190,1)')
    g.addColorStop(0.18, 'rgba(255,180,90,0.9)')
    g.addColorStop(0.5, 'rgba(255,120,40,0.35)')
    g.addColorStop(1, 'rgba(255,90,20,0)')
    x.fillStyle = g
    x.fillRect(0, 0, 128, 128)
    const t = new THREE.CanvasTexture(c)
    t.colorSpace = THREE.SRGBColorSpace
    return t
  })()

  // ---------- scene ----------
  const renderer = new THREE.WebGLRenderer({ antialias: true })
  renderer.setSize(container.clientWidth, container.clientHeight)
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
  renderer.toneMapping = THREE.ACESFilmicToneMapping
  renderer.toneMappingExposure = 1.07
  renderer.outputColorSpace = THREE.SRGBColorSpace
  renderer.shadowMap.enabled = true
  renderer.shadowMap.type = THREE.PCFSoftShadowMap
  container.appendChild(renderer.domElement)
  renderer.domElement.style.display = 'block'

  const scene = new THREE.Scene()
  scene.background = new THREE.Color(0x05030a)
  scene.fog = new THREE.FogExp2(0x05030a, 0.03)

  // procedural warm environment for metal reflections
  function buildEnvTexture() {
    const w = 2048,
      h = 1024,
      c = document.createElement('canvas')
    c.width = w
    c.height = h
    const x = c.getContext('2d')!
    const g = x.createLinearGradient(0, 0, 0, h)
    g.addColorStop(0, '#241806')
    g.addColorStop(0.4, '#5a3c16')
    g.addColorStop(0.55, '#241606')
    g.addColorStop(1, '#0a0603')
    x.fillStyle = g
    x.fillRect(0, 0, w, h)
    const sb = x.createLinearGradient(0, 0.3 * h, 0, 0.54 * h)
    sb.addColorStop(0, 'rgba(255,150,70,0)')
    sb.addColorStop(0.5, 'rgba(255,210,150,0.7)')
    sb.addColorStop(1, 'rgba(255,150,70,0)')
    x.fillStyle = sb
    x.fillRect(0, 0.3 * h, w, 0.24 * h)
    for (const px of [0.07, 0.2, 0.34, 0.5, 0.66, 0.8, 0.93]) {
      const cx2 = px * w,
        cy2 = (0.38 + Math.random() * 0.12) * h,
        rad = 26 + Math.random() * 44
      const rg = x.createRadialGradient(cx2, cy2, 0, cx2, cy2, rad)
      rg.addColorStop(0, 'rgba(255,238,195,0.9)')
      rg.addColorStop(0.4, 'rgba(255,184,96,0.7)')
      rg.addColorStop(1, 'rgba(255,150,70,0)')
      x.fillStyle = rg
      x.fillRect(0, 0, w, h)
    }
    const t = new THREE.CanvasTexture(c)
    t.mapping = THREE.EquirectangularReflectionMapping
    t.colorSpace = THREE.SRGBColorSpace
    return t
  }
  const pmrem = new THREE.PMREMGenerator(renderer)
  const envRT = pmrem.fromEquirectangular(buildEnvTexture())
  scene.environment = envRT.texture

  const camera = new THREE.PerspectiveCamera(
    45,
    container.clientWidth / container.clientHeight,
    0.1,
    200,
  )
  const camBase = new THREE.Vector3(0, 3.3, 7.9)
  const LOOK = new THREE.Vector3(0, -0.25, 0)
  camera.position.copy(camBase)
  camera.lookAt(LOOK)

  // ---- table ----
  const R_OUTER = 5.0,
    THICK = 0.55
  const yRail = THICK / 2
  const recess = 0.17
  const yFelt = yRail - recess
  const rFelt = R_FELT * R_OUTER
  const rWell = R_WELL * R_OUTER
  const tex = buildTableTextures()

  const tableTop = new THREE.Mesh(
    new THREE.RingGeometry(R_BAND1 * R_OUTER, R_OUTER, 180, 1),
    new THREE.MeshStandardMaterial({ ...tex, metalness: 1.0, roughness: 1.0, envMapIntensity: 0.55 }),
  )
  tableTop.rotation.x = -Math.PI / 2
  tableTop.position.y = yRail + 0.002
  tableTop.receiveShadow = true
  scene.add(tableTop)

  const rimMat = new THREE.MeshStandardMaterial({
    ...buildRimStrip(),
    metalness: 1.0,
    roughness: 1.0,
    bumpScale: 0.06,
    envMapIntensity: 1.6,
    color: 0xffffff,
  })
  const band = new THREE.Mesh(makeRingUV(R_BAND0 * R_OUTER, R_BAND1 * R_OUTER, 768), rimMat)
  band.rotation.x = -Math.PI / 2
  band.position.y = yRail + 0.004
  band.receiveShadow = true
  scene.add(band)

  const felt = new THREE.Mesh(
    new THREE.CircleGeometry(rFelt + 0.04, 120),
    new THREE.MeshStandardMaterial({
      ...buildFeltTexture(),
      metalness: 0,
      roughness: 1,
      envMapIntensity: 0.2,
    }),
  )
  felt.rotation.x = -Math.PI / 2
  felt.position.y = yFelt
  felt.receiveShadow = true
  scene.add(felt)

  const wall = new THREE.Mesh(
    new THREE.CylinderGeometry(rWell, rFelt, recess, 180, 1, true),
    new THREE.MeshStandardMaterial({
      map: buildSideTexture(),
      color: 0x1c0d06,
      metalness: 0.25,
      roughness: 0.78,
      envMapIntensity: 0.18,
      side: THREE.DoubleSide,
    }),
  )
  wall.position.y = yFelt + recess / 2
  wall.receiveShadow = true
  scene.add(wall)

  // ---- 3D gold moldings ----
  const lineAssets = buildGoldStrip('line')
  lineAssets.map.repeat.set(10, 1)
  lineAssets.bumpMap.repeat.set(10, 1)
  lineAssets.roughnessMap.repeat.set(10, 1)
  const goldMatLine = new THREE.MeshStandardMaterial({
    ...lineAssets,
    metalness: 1.0,
    roughness: 0.34,
    envMapIntensity: 1.7,
    color: 0xffe7ad,
  })
  const goldMatStep = goldMatLine.clone()
  goldMatStep.roughness = 0.4
  goldMatStep.color = new THREE.Color(0xc99a44)

  function goldRing(radius: number, tube: number, mat: THREE.Material, y: number, seg = 480) {
    const m = new THREE.Mesh(new THREE.TorusGeometry(radius, tube, 20, seg), mat)
    m.rotation.x = Math.PI / 2
    m.position.y = y
    m.castShadow = true
    m.receiveShadow = true
    scene.add(m)
    return m
  }
  const rIn = R_BAND0 * R_OUTER,
    rOut = R_BAND1 * R_OUTER
  goldRing(rIn, 0.06, goldMatLine, yRail + 0.006, 560)
  goldRing(rIn - 0.085, 0.034, goldMatStep, yRail - 0.03, 420)
  goldRing(rOut, 0.06, goldMatLine, yRail + 0.006, 600)
  goldRing(rOut + 0.085, 0.034, goldMatStep, yRail - 0.03, 440)
  goldRing(((R_OGOLD0 + R_OGOLD1) / 2) * R_OUTER, 0.048, goldMatLine, yRail + 0.012, 600)

  const sideTex = buildSideTexture()
  const body = new THREE.Mesh(
    new THREE.CylinderGeometry(R_OUTER, R_OUTER * 0.97, THICK, 160, 1, true),
    new THREE.MeshStandardMaterial({
      map: sideTex,
      color: 0x4a2616,
      metalness: 0.2,
      roughness: 0.6,
      envMapIntensity: 0.4,
    }),
  )
  body.castShadow = true
  body.receiveShadow = true
  scene.add(body)
  const cap = new THREE.Mesh(
    new THREE.CircleGeometry(R_OUTER * 0.97, 80),
    new THREE.MeshStandardMaterial({ color: 0x0a0503, roughness: 0.9 }),
  )
  cap.rotation.x = Math.PI / 2
  cap.position.y = -THICK / 2
  scene.add(cap)

  const ped = new THREE.Mesh(
    new THREE.CylinderGeometry(1.4, 2.0, 3.0, 40),
    new THREE.MeshStandardMaterial({ color: 0x1a0d07, roughness: 0.7, metalness: 0.2 }),
  )
  ped.position.y = -THICK / 2 - 1.5
  ped.castShadow = true
  scene.add(ped)

  // ---- price board (stands on the felt) ----
  const priceBoard = createPriceBoard()
  // a tabletop-scale cabinet; rest its base on the felt. Stand it nearly upright
  // (only a hair of back-lean) so it foreshortens like a real object on the
  // table rather than reading as a flat image aimed at the camera.
  const PB_SCALE = 0.62
  const PB_BASE_DROP = 1.94 // local distance from face centre to base underside
  priceBoard.group.scale.setScalar(PB_SCALE)
  priceBoard.group.position.set(0, yFelt + PB_BASE_DROP * PB_SCALE, -0.6)
  priceBoard.group.rotation.x = -0.06
  scene.add(priceBoard.group)

  // ---- floor ----
  const floorTex = (() => {
    const c = document.createElement('canvas')
    c.width = c.height = 512
    const x = c.getContext('2d')!
    x.fillStyle = '#0a0604'
    x.fillRect(0, 0, 512, 512)
    for (let i = 0; i < 900; i++) {
      x.fillStyle = `rgba(${rand(30, 70) | 0},${rand(16, 34) | 0},${rand(8, 16) | 0},0.08)`
      x.fillRect(rand(0, 512), rand(0, 512), rand(40, 200), rand(2, 5))
    }
    const t = new THREE.CanvasTexture(c)
    t.colorSpace = THREE.SRGBColorSpace
    t.wrapS = t.wrapT = THREE.RepeatWrapping
    t.repeat.set(4, 4)
    return t
  })()
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(80, 80),
    new THREE.MeshStandardMaterial({ map: floorTex, color: 0x120a06, roughness: 0.42, metalness: 0.5 }),
  )
  floor.rotation.x = -Math.PI / 2
  floor.position.y = -THICK / 2 - 3.0
  floor.receiveShadow = true
  scene.add(floor)

  // ---- candlesticks (brass) ----
  const brass = new THREE.MeshStandardMaterial({ color: 0x6e4a1e, metalness: 1.0, roughness: 0.34 })
  function candlestick(x: number, z: number, s = 1) {
    const g = new THREE.Group()
    const pts = (
      [
        [0.0, 0],
        [0.42, 0],
        [0.4, 0.06],
        [0.18, 0.1],
        [0.16, 0.5],
        [0.22, 0.62],
        [0.13, 0.66],
        [0.12, 1.5],
        [0.2, 1.62],
        [0.1, 1.68],
      ] as [number, number][]
    ).map((p) => new THREE.Vector2(p[0] * s, p[1] * s))
    const stick = new THREE.Mesh(new THREE.LatheGeometry(pts, 40), brass)
    g.add(stick)
    const candle = new THREE.Mesh(
      new THREE.CylinderGeometry(0.09 * s, 0.1 * s, 0.5 * s, 16),
      new THREE.MeshStandardMaterial({
        color: 0xe8d8b0,
        roughness: 0.7,
        emissive: 0x140d04,
        emissiveIntensity: 0.4,
      }),
    )
    candle.position.y = 1.68 * s + 0.25 * s
    g.add(candle)
    const flame = new THREE.Mesh(
      new THREE.SphereGeometry(0.045 * s, 10, 10),
      new THREE.MeshBasicMaterial({ color: 0xffe6b0 }),
    )
    flame.scale.set(1, 1.8, 1)
    flame.position.y = candle.position.y + 0.3 * s
    g.add(flame)
    const base = 5.5
    const light = new THREE.PointLight(0xffb158, base, 24, 2.3)
    light.position.copy(flame.position)
    g.add(light)
    const glow = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: glowTex,
        color: 0xffbf6e,
        transparent: true,
        opacity: 0.4,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    )
    glow.scale.set(0.62 * s, 0.9 * s, 1)
    glow.position.copy(flame.position)
    g.add(glow)
    g.position.set(x, floor.position.y, z)
    scene.add(g)
    return { flame, light, base }
  }
  const candles = [
    candlestick(-7.0, -4.4, 1.6),
    candlestick(7.4, -5.0, 1.7),
    candlestick(-2.6, -8.2, 1.2),
    candlestick(3.6, -8.6, 1.1),
  ]

  // ---- lights ----
  const key = new THREE.PointLight(0xffc079, 54, 40, 2.0)
  key.position.set(0.3, 6.8, 2.2)
  key.castShadow = true
  key.shadow.mapSize.set(2048, 2048)
  key.shadow.bias = -0.0005
  key.shadow.camera.far = 40
  scene.add(key)
  const pool = new THREE.SpotLight(0xffd49a, 60, 26, 1.05, 0.9, 1.4)
  pool.position.set(0, 9, 1.0)
  pool.target.position.set(0, 0, 0.3)
  scene.add(pool)
  scene.add(pool.target)
  const front = new THREE.PointLight(0xffac5c, 26, 22, 2.2)
  front.position.set(-1.0, 2.0, 7.2)
  scene.add(front)
  const rim = new THREE.PointLight(0xffb060, 16, 20, 2.4)
  rim.position.set(0.5, 3.4, -6.5)
  scene.add(rim)
  scene.add(new THREE.AmbientLight(0x2a1809, 0.18))
  const hemi = new THREE.HemisphereLight(0x2e2010, 0x05030a, 0.14)
  scene.add(hemi)

  // background furniture silhouettes
  for (let i = 0; i < 4; i++) {
    const m = new THREE.Mesh(
      new THREE.BoxGeometry(rand(1.5, 3.5), rand(3, 6), rand(1.5, 3)),
      new THREE.MeshStandardMaterial({
        color: 0x100a05,
        metalness: 0.4,
        roughness: 0.6,
        envMapIntensity: 0.25,
      }),
    )
    const a = rand(-0.6, 0.6) + (i < 2 ? Math.PI * 0.75 : Math.PI * 0.25),
      d = rand(14, 19)
    m.position.set(Math.cos(a) * d * (i % 2 ? 1 : -1), rand(-2, 0), -Math.abs(Math.sin(a) * d) - 4)
    scene.add(m)
  }

  // ---------- post ----------
  const composer = new EffectComposer(renderer)
  composer.addPass(new RenderPass(scene, camera))
  const bloom = new UnrealBloomPass(
    new THREE.Vector2(container.clientWidth, container.clientHeight),
    0.3,
    0.55,
    0.92,
  )
  composer.addPass(bloom)

  // ---------- interaction ----------
  const mouse = { x: 0, y: 0, tx: 0, ty: 0 }
  const onMouseMove = (e: MouseEvent) => {
    mouse.tx = e.clientX / window.innerWidth - 0.5
    mouse.ty = e.clientY / window.innerHeight - 0.5
  }
  window.addEventListener('mousemove', onMouseMove)

  const resize = () => {
    const w = container.clientWidth,
      h = container.clientHeight
    camera.aspect = w / h
    camera.updateProjectionMatrix()
    renderer.setSize(w, h)
    composer.setSize(w, h)
  }
  const ro = new ResizeObserver(resize)
  ro.observe(container)

  // flicker noise
  let t = 0
  const flick = (seed: number) =>
    0.94 +
    0.06 *
      (Math.sin(t * 2.7 + seed) * 0.6 +
        Math.sin(t * 6.3 + seed * 2.1) * 0.3 +
        Math.sin(t * 11.0 + seed * 0.7) * 0.1)

  let raf = 0
  let running = true
  function animate() {
    if (!running) return
    raf = requestAnimationFrame(animate)
    t += 0.016
    mouse.x += (mouse.tx - mouse.x) * 0.04
    mouse.y += (mouse.ty - mouse.y) * 0.04
    const dx = Math.sin(t * 0.13) * 0.3,
      dy = Math.cos(t * 0.17) * 0.16
    camera.position.x = camBase.x + dx + mouse.x * 1.6
    camera.position.y = camBase.y + dy - mouse.y * 1.1
    camera.position.z = camBase.z + Math.cos(t * 0.1) * 0.2
    camera.lookAt(LOOK)
    candles.forEach((c, i) => {
      const f = flick(i * 7.3)
      c.light.intensity = c.base * f
      c.flame.scale.set(0.96 + 0.08 * f, 1.85 + 0.2 * f, 0.96 + 0.08 * f)
      c.flame.position.x = Math.sin(t * 3.0 + i) * 0.006
    })
    key.intensity = 54 * (0.93 + 0.07 * flick(2.0))
    pool.intensity = 60 * (0.94 + 0.06 * flick(5.0))
    front.intensity = 26 * (0.88 + 0.12 * flick(8.0))
    rim.intensity = 16 * (0.9 + 0.1 * flick(11.0))
    priceBoard.update(t)
    composer.render()
  }
  animate()

  // ---------- disposal ----------
  function dispose() {
    running = false
    cancelAnimationFrame(raf)
    priceBoard.dispose()
    window.removeEventListener('mousemove', onMouseMove)
    ro.disconnect()
    composer.dispose()
    envRT.dispose()
    pmrem.dispose()
    scene.traverse((obj) => {
      const mesh = obj as THREE.Mesh
      if (mesh.geometry) mesh.geometry.dispose()
      const mat = mesh.material
      if (Array.isArray(mat)) mat.forEach((m) => m.dispose())
      else if (mat) mat.dispose()
    })
    renderer.dispose()
    if (renderer.domElement.parentNode === container) {
      container.removeChild(renderer.domElement)
    }
  }

  return { scene, camera, tableRadius: R_OUTER, feltY: yFelt, dispose }
}
