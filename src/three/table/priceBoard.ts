import * as THREE from 'three'

/**
 * The baroque BTC/USD price board — a wide, gently-arched gilded cabinet that
 * stands on the felt, built to match `price.png`:
 *   - a large recessed teal screen with a golden price-line chart + axes,
 *   - a thin ornate bronze/gold frame with a shallow segmental arch,
 *   - two fluted gold columns standing at the outer edges,
 *   - a horizontal cartouche over the screen top (Bitcoin badge, BTC/USD, price),
 *   - a smaller cartouche over the screen bottom (TIME REMAINING + countdown).
 *
 * Local space: origin centred on the board face, +y up, front face toward +z.
 */
export interface PriceBoardHandle {
  group: THREE.Group
  update: (t: number) => void
  dispose: () => void
}

// reference values, matched exactly to price.png
const PRICE = '$104,283.45'
const PAIR = 'BTC / USD'
const PCT = '+1.26%'
const PRICE_LABELS = ['107,000', '106,000', '105,000', '104,500', '104,000']
const HILITE_LABEL = '104,500'
const TIME_LABELS = ['18:00', '22:00', '02:00', '06:00', '10:00']

export function createPriceBoard(): PriceBoardHandle {
  const rand = (a: number, b: number) => a + Math.random() * (b - a)

  // ----- board dimensions (local units) -----
  const W = 5.7
  const H = 3.5
  const hw = W / 2
  const hh = H / 2
  const DEPTH = 0.32

  // shallow segmental arch
  const archRise = 0.4
  const shoulderY = hh - archRise

  // large arched screen, inset a thin border from the frame
  const sxw = hw - 0.3
  const syb = -hh + 0.34
  const syT = hh - 0.24 // screen arch peak
  const screenArchYR = 0.4
  const syS = syT - screenArchYR // screen shoulder

  // ---------- vector outlines ----------
  function archedRect(
    halfW: number,
    bottomY: number,
    shoulder: number,
    archYR: number,
    ctor: () => THREE.Path,
  ) {
    const s = ctor()
    s.moveTo(-halfW, bottomY)
    s.lineTo(halfW, bottomY)
    s.lineTo(halfW, shoulder)
    s.absellipse(0, shoulder, halfW, archYR, 0, Math.PI, false)
    s.lineTo(-halfW, bottomY)
    return s
  }
  const outerShape = () => archedRect(hw, -hh, shoulderY, archRise, () => new THREE.Shape()) as THREE.Shape
  const screenHolePath = () =>
    archedRect(sxw, syb, syS, screenArchYR, () => new THREE.Path()) as THREE.Path

  function boxUV(geo: THREE.BufferGeometry) {
    const pos = geo.attributes.position
    const uv = new Float32Array(pos.count * 2)
    for (let i = 0; i < pos.count; i++) {
      uv[i * 2] = (pos.getX(i) + hw) / W
      uv[i * 2 + 1] = (pos.getY(i) + hh) / H
    }
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2))
  }

  // ---------- shared gold gradients ----------
  // muted antique gold (no white-hot highlight — candlelight supplies sparkle)
  function goldV(ctx: CanvasRenderingContext2D, y0: number, y1: number) {
    const g = ctx.createLinearGradient(0, y0, 0, y1)
    g.addColorStop(0, '#33260c')
    g.addColorStop(0.18, '#8a6a28')
    g.addColorStop(0.44, '#c39f4c')
    g.addColorStop(0.52, '#dcc079')
    g.addColorStop(0.66, '#a9842f')
    g.addColorStop(0.86, '#6e521b')
    g.addColorStop(1, '#2c2109')
    return g
  }

  // ====================================================================
  // FRAME FACE canvas (ornate bronze border + gold moldings; screen is a hole)
  // ====================================================================
  const FW = 2048
  const FH = Math.round((FW * H) / W)
  const fpx = (x: number) => ((x + hw) / W) * FW
  const fpy = (y: number) => ((hh - y) / H) * FH
  const fu = (u: number) => (u / W) * FW

  function buildFrameTexture() {
    const c = document.createElement('canvas')
    c.width = FW
    c.height = FH
    const cx = c.getContext('2d')!

    const traceOuter = (inset: number) => {
      cx.beginPath()
      cx.moveTo(fpx(-hw + inset), fpy(-hh + inset))
      cx.lineTo(fpx(hw - inset), fpy(-hh + inset))
      cx.lineTo(fpx(hw - inset), fpy(shoulderY))
      cx.ellipse(fpx(0), fpy(shoulderY), fu(hw - inset), fu(archRise - inset), 0, 0, Math.PI, true)
      cx.lineTo(fpx(-hw + inset), fpy(-hh + inset))
      cx.closePath()
    }
    const traceScreen = (inset: number) => {
      cx.beginPath()
      cx.moveTo(fpx(-sxw - inset), fpy(syb - inset))
      cx.lineTo(fpx(sxw + inset), fpy(syb - inset))
      cx.lineTo(fpx(sxw + inset), fpy(syS))
      cx.ellipse(fpx(0), fpy(syS), fu(sxw + inset), fu(screenArchYR + inset), 0, 0, Math.PI, true)
      cx.lineTo(fpx(-sxw - inset), fpy(syb - inset))
      cx.closePath()
    }

    // bronze field — dark, so the gold moldings read as the bright element
    cx.save()
    traceOuter(0)
    cx.clip()
    cx.fillStyle = '#1f1408'
    cx.fillRect(0, 0, FW, FH)
    for (let i = 0; i < 7000; i++) {
      const x = rand(0, FW)
      const y = rand(0, FH)
      const s = rand(2, 9)
      const tt = Math.random()
      cx.fillStyle =
        tt < 0.5
          ? `rgba(${(110 + rand(-26, 30)) | 0},${(74 + rand(-16, 20)) | 0},${(30 + rand(-10, 14)) | 0},0.11)`
          : tt < 0.85
            ? 'rgba(20,11,4,0.20)'
            : `rgba(${(170 + rand(0, 36)) | 0},116,54,0.05)`
      cx.beginPath()
      cx.ellipse(x, y, s, s * rand(0.4, 1), rand(0, 7), 0, Math.PI * 2)
      cx.fill()
    }
    cx.restore()

    // gold molding: shadow -> body -> highlight
    const molding = (trace: (inset: number) => void, inset: number, width: number) => {
      trace(inset)
      cx.lineWidth = width * 1.3
      cx.strokeStyle = 'rgba(18,10,3,0.85)'
      cx.stroke()
      trace(inset)
      cx.lineWidth = width
      cx.strokeStyle = goldV(cx, 0, FH)
      cx.stroke()
      trace(inset - 0.01)
      cx.lineWidth = width * 0.28
      cx.strokeStyle = 'rgba(255,248,218,0.85)'
      cx.stroke()
    }
    molding(traceOuter, 0.05, fu(0.17))
    molding(traceOuter, 0.19, fu(0.05))
    // screen bezel
    cx.save()
    traceScreen(0.12)
    cx.lineWidth = fu(0.24)
    cx.strokeStyle = '#120a04'
    cx.stroke()
    cx.restore()
    molding(traceScreen, 0.03, fu(0.14))
    molding(traceScreen, 0.13, fu(0.045))

    // bead-and-reel rows for baroque richness
    const beadRow = (
      halfW: number,
      bottomY: number,
      shoulder: number,
      archYR: number,
      beadRU: number,
      spacing: number,
    ) => {
      const pts: [number, number][] = []
      for (let x = -halfW; x <= halfW + 1e-6; x += spacing) pts.push([x, bottomY])
      for (let y = bottomY + spacing; y <= shoulder; y += spacing) pts.push([halfW, y])
      const archLen = Math.PI * (0.5 * (halfW + archYR))
      const steps = Math.max(6, Math.round(archLen / spacing))
      for (let i = 0; i <= steps; i++) {
        const a = (i / steps) * Math.PI
        pts.push([Math.cos(a) * halfW, shoulder + Math.sin(a) * archYR])
      }
      for (let y = shoulder - spacing; y >= bottomY; y -= spacing) pts.push([-halfW, y])
      const r = fu(beadRU)
      for (const [bx, by] of pts) {
        const cxp = fpx(bx)
        const cyp = fpy(by)
        const g = cx.createRadialGradient(cxp - r * 0.3, cyp - r * 0.3, 0.5, cxp, cyp, r)
        g.addColorStop(0, '#ffe9ad')
        g.addColorStop(0.6, '#c69a3e')
        g.addColorStop(1, '#5e441a')
        cx.fillStyle = g
        cx.beginPath()
        cx.arc(cxp, cyp, r, 0, Math.PI * 2)
        cx.fill()
      }
    }
    beadRow(sxw + 0.18, syb - 0.18, syS + 0.18, screenArchYR + 0.18, 0.03, 0.1)
    beadRow(hw - 0.28, -hh + 0.28, shoulderY, archRise - 0.1, 0.026, 0.11)

    const t = new THREE.CanvasTexture(c)
    t.colorSpace = THREE.SRGBColorSpace
    t.anisotropy = 8
    return t
  }

  // ====================================================================
  // SCREEN canvas (teal field, grid, axes, golden chart) — live-updatable
  // ====================================================================
  const SCW = 1280
  const SCH = Math.round((SCW * (syT - syb)) / (sxw * 2))
  const screenCanvas = document.createElement('canvas')
  screenCanvas.width = SCW
  screenCanvas.height = SCH
  const sc = screenCanvas.getContext('2d')!

  const N = 320
  const series: number[] = []
  {
    let v = 0.22
    for (let i = 0; i < N; i++) {
      const dip = Math.exp(-((i - N * 0.42) ** 2) / (2 * (N * 0.12) ** 2)) * -0.14
      // steady rise + sharper jitter for a jagged tick-by-tick look
      v += 0.0019 + (Math.random() - 0.5) * 0.04
      series.push(Math.max(0.08, Math.min(0.95, 0.28 + v + dip)))
    }
  }

  function drawScreen() {
    sc.fillStyle = '#081310'
    sc.fillRect(0, 0, SCW, SCH)
    const vg = sc.createRadialGradient(SCW / 2, SCH * 0.45, SCH * 0.12, SCW / 2, SCH / 2, SCW * 0.62)
    vg.addColorStop(0, 'rgba(22,46,38,0.45)')
    vg.addColorStop(1, 'rgba(2,6,5,0.9)')
    sc.fillStyle = vg
    sc.fillRect(0, 0, SCW, SCH)

    // generous insets: the arched gold bezel hides the outer edge / top corners
    const padL = 158
    const padR = 56
    const padT = 70
    const padB = 72
    const gx0 = padL
    const gx1 = SCW - padR
    const gy0 = padT
    const gy1 = SCH - padB

    sc.strokeStyle = 'rgba(150,180,150,0.12)'
    sc.lineWidth = 1.2
    const rows = PRICE_LABELS.length
    for (let i = 0; i < rows; i++) {
      const gy = gy0 + ((gy1 - gy0) * i) / (rows - 1)
      sc.beginPath()
      sc.moveTo(gx0, gy)
      sc.lineTo(gx1, gy)
      sc.stroke()
    }
    const cols = TIME_LABELS.length
    for (let i = 0; i < cols; i++) {
      const gx = gx0 + ((gx1 - gx0) * i) / (cols - 1)
      sc.beginPath()
      sc.moveTo(gx, gy0)
      sc.lineTo(gx, gy1)
      sc.stroke()
    }

    // "PRICE" header
    sc.fillStyle = 'rgba(196,156,84,0.7)'
    sc.font = '16px Georgia, serif'
    sc.textAlign = 'left'
    sc.textBaseline = 'alphabetic'
    sc.fillText('P R I C E', 16, gy0 - 14)

    // price labels
    sc.font = '21px Georgia, serif'
    sc.textBaseline = 'middle'
    for (let i = 0; i < rows; i++) {
      const gy = gy0 + ((gy1 - gy0) * i) / (rows - 1)
      const label = PRICE_LABELS[i]
      if (label === HILITE_LABEL) {
        sc.fillStyle = '#c89a3e'
        const bw = 92
        const bh = 30
        sc.fillRect(gx0 - bw - 8, gy - bh / 2, bw, bh)
        sc.fillStyle = '#1a1206'
        sc.textAlign = 'center'
        sc.fillText(label, gx0 - bw / 2 - 8, gy)
      } else {
        sc.fillStyle = '#caa24a'
        sc.textAlign = 'right'
        sc.fillText(label, gx0 - 14, gy)
      }
    }
    // time labels
    sc.fillStyle = '#c2a052'
    sc.font = '20px Georgia, serif'
    sc.textAlign = 'center'
    sc.textBaseline = 'top'
    for (let i = 0; i < cols; i++) {
      const gx = gx0 + ((gx1 - gx0) * i) / (cols - 1)
      sc.fillText(TIME_LABELS[i], gx, gy1 + 14)
    }

    const toX = (i: number) => gx0 + ((gx1 - gx0) * i) / (N - 1)
    const toY = (v: number) => gy1 - (gy1 - gy0) * v
    // area fill
    sc.beginPath()
    sc.moveTo(toX(0), gy1)
    for (let i = 0; i < N; i++) sc.lineTo(toX(i), toY(series[i]))
    sc.lineTo(toX(N - 1), gy1)
    sc.closePath()
    const fillG = sc.createLinearGradient(0, gy0, 0, gy1)
    fillG.addColorStop(0, 'rgba(255,200,90,0.16)')
    fillG.addColorStop(1, 'rgba(255,200,90,0)')
    sc.fillStyle = fillG
    sc.fill()
    // glowing line
    sc.beginPath()
    sc.moveTo(toX(0), toY(series[0]))
    for (let i = 1; i < N; i++) sc.lineTo(toX(i), toY(series[i]))
    sc.save()
    sc.shadowColor = 'rgba(255,196,86,0.85)'
    sc.shadowBlur = 9
    sc.strokeStyle = '#ffca60'
    sc.lineWidth = 1.7
    sc.lineJoin = 'round'
    sc.stroke()
    sc.restore()
    // end dot
    const ex = toX(N - 1)
    const ey = toY(series[N - 1])
    const dg = sc.createRadialGradient(ex, ey, 0, ex, ey, 15)
    dg.addColorStop(0, '#fff6d8')
    dg.addColorStop(0.45, '#ffce68')
    dg.addColorStop(1, 'rgba(255,180,80,0)')
    sc.fillStyle = dg
    sc.beginPath()
    sc.arc(ex, ey, 15, 0, Math.PI * 2)
    sc.fill()

    if (screenTex) screenTex.needsUpdate = true
  }

  // ====================================================================
  // CARTOUCHE canvas — transparent ground, ornate gold plaque with text
  // ====================================================================
  function buildCartouche(
    wUnits: number,
    hUnits: number,
    draw: (cx: CanvasRenderingContext2D, W: number, H: number) => void,
  ) {
    const pxPerUnit = 460
    const cw = Math.round(wUnits * pxPerUnit)
    const ch = Math.round(hUnits * pxPerUnit)
    const c = document.createElement('canvas')
    c.width = cw
    c.height = ch
    const cx = c.getContext('2d')!
    const m = cw * 0.04 // outer margin so scrolls don't clip

    // plaque silhouette: rounded plate with scrolled (notched) ends
    const x0 = m
    const y0 = m
    const w = cw - 2 * m
    const h = ch - 2 * m
    const r = h * 0.42
    const plaque = () => {
      cx.beginPath()
      cx.moveTo(x0 + r, y0)
      cx.lineTo(x0 + w - r, y0)
      cx.quadraticCurveTo(x0 + w, y0, x0 + w, y0 + r)
      cx.lineTo(x0 + w, y0 + h - r)
      cx.quadraticCurveTo(x0 + w, y0 + h, x0 + w - r, y0 + h)
      cx.lineTo(x0 + r, y0 + h)
      cx.quadraticCurveTo(x0, y0 + h, x0, y0 + h - r)
      cx.lineTo(x0, y0 + r)
      cx.quadraticCurveTo(x0, y0, x0 + r, y0)
      cx.closePath()
    }
    // outer gold body
    plaque()
    cx.fillStyle = goldV(cx, y0, y0 + h)
    cx.fill()
    cx.lineWidth = cw * 0.012
    cx.strokeStyle = 'rgba(18,10,3,0.8)'
    cx.stroke()
    // dark inset
    const ins = h * 0.14
    const iw = w - 2 * ins
    const ih = h - 2 * ins
    const ir = r * 0.6
    cx.beginPath()
    cx.moveTo(x0 + ins + ir, y0 + ins)
    cx.lineTo(x0 + ins + iw - ir, y0 + ins)
    cx.quadraticCurveTo(x0 + ins + iw, y0 + ins, x0 + ins + iw, y0 + ins + ir)
    cx.lineTo(x0 + ins + iw, y0 + ins + ih - ir)
    cx.quadraticCurveTo(x0 + ins + iw, y0 + ins + ih, x0 + ins + iw - ir, y0 + ins + ih)
    cx.lineTo(x0 + ins + ir, y0 + ins + ih)
    cx.quadraticCurveTo(x0 + ins, y0 + ins + ih, x0 + ins, y0 + ins + ih - ir)
    cx.lineTo(x0 + ins, y0 + ins + ir)
    cx.quadraticCurveTo(x0 + ins, y0 + ins, x0 + ins + ir, y0 + ins)
    cx.closePath()
    cx.fillStyle = '#160d05'
    cx.fill()
    cx.lineWidth = cw * 0.006
    cx.strokeStyle = 'rgba(255,240,190,0.4)'
    cx.stroke()
    // inner highlight on top rim
    plaque()
    cx.clip()
    cx.fillStyle = 'rgba(255,248,220,0.12)'
    cx.fillRect(x0, y0, w, h * 0.18)

    draw(cx, cw, ch)

    const t = new THREE.CanvasTexture(c)
    t.colorSpace = THREE.SRGBColorSpace
    t.anisotropy = 8
    return { tex: t, wUnits, hUnits }
  }

  const cartoucheText = (
    cx: CanvasRenderingContext2D,
    txt: string,
    x: number,
    y: number,
    size: number,
    color: string,
    weight = '',
  ) => {
    cx.font = `${weight} ${size}px Georgia, "Times New Roman", serif`
    cx.textAlign = 'center'
    cx.textBaseline = 'middle'
    cx.fillStyle = 'rgba(0,0,0,0.7)'
    cx.fillText(txt, x + size * 0.03, y + size * 0.035)
    cx.fillStyle = color
    cx.fillText(txt, x, y)
  }

  // ---------- build meshes ----------
  const group = new THREE.Group()

  // frame face
  const faceShape = outerShape()
  faceShape.holes.push(screenHolePath())
  const faceGeo = new THREE.ShapeGeometry(faceShape, 28)
  boxUV(faceGeo)
  const frameTex = buildFrameTexture()
  const faceMat = new THREE.MeshStandardMaterial({
    map: frameTex,
    emissiveMap: frameTex,
    emissive: 0xe8b878,
    emissiveIntensity: 0.16,
    metalness: 0.8,
    roughness: 0.52,
    envMapIntensity: 0.85,
  })
  const face = new THREE.Mesh(faceGeo, faceMat)
  face.position.z = DEPTH
  face.castShadow = true
  group.add(face)

  // body (thickness)
  const bodyShape = outerShape()
  bodyShape.holes.push(screenHolePath())
  const bodyGeo = new THREE.ExtrudeGeometry(bodyShape, {
    depth: DEPTH,
    bevelEnabled: true,
    bevelThickness: 0.05,
    bevelSize: 0.05,
    bevelSegments: 2,
  })
  const body = new THREE.Mesh(
    bodyGeo,
    new THREE.MeshStandardMaterial({
      color: 0x2a1408,
      metalness: 0.35,
      roughness: 0.65,
      envMapIntensity: 0.5,
    }),
  )
  body.castShadow = true
  body.receiveShadow = true
  group.add(body)

  // recessed screen (rectangular plane behind the arched hole)
  const screenTex = new THREE.CanvasTexture(screenCanvas)
  screenTex.colorSpace = THREE.SRGBColorSpace
  drawScreen()
  const screen = new THREE.Mesh(
    new THREE.PlaneGeometry(sxw * 2, syT - syb),
    new THREE.MeshStandardMaterial({
      map: screenTex,
      emissiveMap: screenTex,
      emissive: 0xffffff,
      emissiveIntensity: 0.5,
      metalness: 0.1,
      roughness: 0.55,
    }),
  )
  screen.position.set(0, (syT + syb) / 2, DEPTH - 0.05)
  group.add(screen)

  // ---------- gold columns (3D lathe) at the outer edges ----------
  const colMat = new THREE.MeshStandardMaterial({
    color: 0xc9a855,
    metalness: 0.78,
    roughness: 0.52,
    emissive: 0x4a3210,
    emissiveIntensity: 0.16,
    envMapIntensity: 0.85,
  })
  const colTop = shoulderY
  const colBot = -hh + 0.16
  const colH = colTop - colBot
  function column(side: number) {
    const r = 0.125
    const profile: [number, number][] = [
      [0.0, 0.0],
      [r * 1.5, 0.0],
      [r * 1.45, 0.06],
      [r * 1.0, 0.1],
      [r * 1.15, 0.16],
      [r * 0.86, 0.2], // base torus
      [r * 0.86, 0.26],
      [r * 0.98, 0.3], // shaft start (entasis)
      [r * 1.0, colH * 0.55],
      [r * 0.9, colH - 0.34],
      [r * 1.05, colH - 0.3], // capital neck
      [r * 1.0, colH - 0.24],
      [r * 1.35, colH - 0.16], // capital flare
      [r * 1.4, colH - 0.06],
      [r * 1.5, colH - 0.04],
      [r * 1.5, colH],
      [0.0, colH],
    ]
    const pts = profile.map((p) => new THREE.Vector2(p[0], p[1]))
    const geo = new THREE.LatheGeometry(pts, 40)
    const m = new THREE.Mesh(geo, colMat)
    m.position.set(side * (hw - 0.16), colBot, DEPTH - 0.02)
    m.castShadow = true
    group.add(m)
  }
  column(-1)
  column(1)

  // ---------- cartouches (raised plaques over the screen) ----------
  const topCart = buildCartouche(2.6, 0.86, (cx, cw, ch) => {
    cartoucheText(cx, PAIR, cw / 2, ch * 0.4, ch * 0.15, '#e6cd8b')
    cartoucheText(cx, PRICE, cw / 2, ch * 0.62, ch * 0.3, '#ffeeba', 'bold')
    cartoucheText(cx, `${PCT}  ▲`, cw / 2, ch * 0.83, ch * 0.13, '#83e0a3')
  })
  const cartoucheMat = (tex: THREE.Texture) =>
    new THREE.MeshStandardMaterial({
      map: tex,
      emissiveMap: tex,
      emissive: 0xe8b878,
      emissiveIntensity: 0.2,
      transparent: true,
      metalness: 0.82,
      roughness: 0.5,
      envMapIntensity: 0.9,
    })
  const topMesh = new THREE.Mesh(
    new THREE.PlaneGeometry(topCart.wUnits, topCart.hUnits),
    cartoucheMat(topCart.tex),
  )
  topMesh.position.set(0, syT - 0.04, DEPTH + 0.05)
  group.add(topMesh)

  // bitcoin medallion on top of the cartouche
  const btcCanvas = document.createElement('canvas')
  btcCanvas.width = btcCanvas.height = 256
  {
    const b = btcCanvas.getContext('2d')!
    const g = b.createRadialGradient(110, 100, 4, 128, 128, 124)
    g.addColorStop(0, '#ffeab0')
    g.addColorStop(0.55, '#e3b350')
    g.addColorStop(1, '#7a5618')
    b.fillStyle = g
    b.beginPath()
    b.arc(128, 128, 122, 0, Math.PI * 2)
    b.fill()
    b.lineWidth = 8
    b.strokeStyle = '#3a2708'
    b.stroke()
    b.fillStyle = '#3a2708'
    b.font = 'bold 150px Georgia, serif'
    b.textAlign = 'center'
    b.textBaseline = 'middle'
    b.fillText('₿', 128, 138)
  }
  const btcTex = new THREE.CanvasTexture(btcCanvas)
  btcTex.colorSpace = THREE.SRGBColorSpace
  const btc = new THREE.Mesh(
    new THREE.PlaneGeometry(0.46, 0.46),
    new THREE.MeshStandardMaterial({
      map: btcTex,
      emissiveMap: btcTex,
      emissive: 0xffcf80,
      emissiveIntensity: 0.5,
      transparent: true,
      metalness: 0.9,
      roughness: 0.34,
      envMapIntensity: 1.6,
    }),
  )
  btc.position.set(0, syT + 0.38, DEPTH + 0.07)
  group.add(btc)

  const botCart = buildCartouche(1.86, 0.58, (cx, cw, ch) => {
    cartoucheText(cx, 'TIME  REMAINING', cw / 2, ch * 0.34, ch * 0.17, '#d6bc82')
    cartoucheText(cx, '00:24', cw / 2, ch * 0.67, ch * 0.32, '#ffeeba', 'bold')
  })
  const botMesh = new THREE.Mesh(
    new THREE.PlaneGeometry(botCart.wUnits, botCart.hUnits),
    cartoucheMat(botCart.tex),
  )
  botMesh.position.set(0, syb + 0.06, DEPTH + 0.05)
  group.add(botMesh)

  // ---------- base plinth + feet ----------
  const baseMat = new THREE.MeshStandardMaterial({
    color: 0x281406,
    metalness: 0.45,
    roughness: 0.55,
    envMapIntensity: 0.6,
  })
  const base = new THREE.Mesh(new THREE.BoxGeometry(W * 1.04, 0.42, DEPTH + 0.6), baseMat)
  base.position.set(0, -hh - 0.13, DEPTH / 2)
  base.castShadow = true
  base.receiveShadow = true
  group.add(base)
  for (const side of [-1, 1]) {
    const foot = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.24, DEPTH + 0.7), baseMat)
    foot.position.set(side * (hw - 0.5), -hh - 0.4, DEPTH / 2)
    foot.castShadow = true
    group.add(foot)
  }

  function update(_t: number) {
    // animation hook — kept static to match the reference
  }

  function dispose() {
    group.traverse((o) => {
      const m = o as THREE.Mesh
      if (m.geometry) m.geometry.dispose()
      const mat = m.material
      if (Array.isArray(mat)) mat.forEach((x) => x.dispose())
      else if (mat) mat.dispose()
    })
  }

  return { group, update, dispose }
}
