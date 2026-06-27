import * as THREE from 'three'

/**
 * The pot — a heap of minted gold sovereigns resting on the felt, lit by the
 * same candlelight and casting the same shadows as the rest of the table.
 *
 * Each coin is a lathed solid with a doming face, a raised milled rim and a
 * reeded edge, struck with an embossed crest (radiant guilloché, beaded border,
 * faceted central boss) so it reads as a real coin with genuine relief as the
 * camera sways — never a flat disc. Three subtly different gold alloys are
 * minted so the pile catches the light unevenly like real metal.
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

const COIN_R = 0.205 // coin radius (world units)
const COIN_H = 0.052 // coin thickness — chunky enough to read in profile
const GAP = 0.001 // hairline between stacked coins so edges separate
const NSTACKS = 8 // columns in the heap
const MAX_H = 13 // tallest a column is allowed to grow
const FLAT_MAX = 11 // loose coins spilled flat around the base
const MAX_CHIPS = NSTACKS * MAX_H + FLAT_MAX
const DROP = 1.5 // how far above home a new coin starts
const DROP_DUR = 0.4 // seconds for a coin to settle
const LEAVE_DUR = 0.3 // seconds for a swept coin to vanish

/** coins ≈ 1.5·√amount — a satisfying heap that scales gently with the pot. */
function chipsFor(amount: number): number {
  if (amount <= 0) return 0
  return Math.max(1, Math.min(MAX_CHIPS, Math.round(1.5 * Math.sqrt(amount))))
}

// A loose, organic cluster of stack centres (x,z offsets from the pile origin).
const STACK_POS: [number, number][] = [
  [0.0, 0.0],
  [0.46, 0.16],
  [-0.44, 0.18],
  [0.26, -0.42],
  [-0.3, -0.38],
  [0.04, 0.5],
  [-0.52, -0.28],
  [0.5, -0.22],
]
// per-stack fill bias → staggered, hand-stacked heights (lower = grows taller)
const STACK_BIAS = [0.0, 0.5, 0.3, 0.75, 0.45, 0.85, 0.65, 0.6]

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

// ---- coin geometry & textures ------------------------------------------------

/** A lathed coin: domed faces, a raised rim, and a reeded (milled) edge. */
function coinGeometry(): THREE.LatheGeometry {
  const R = COIN_R,
    HT = COIN_H / 2
  // profile points (radius, y) as fractions, top centre → outer → bottom centre
  const prof: [number, number][] = [
    [0.0, 0.86],
    [0.3, 0.92],
    [0.58, 1.0], // raised rim crown
    [0.78, 0.98],
    [0.9, 0.86],
    [0.97, 0.6],
    [1.0, 0.18],
    [1.0, -0.18],
    [0.97, -0.6],
    [0.9, -0.86],
    [0.78, -0.98],
    [0.58, -1.0],
    [0.3, -0.92],
    [0.0, -0.86],
  ]
  const pts = prof.map(([r, y]) => new THREE.Vector2(r * R, y * HT))
  const geo = new THREE.LatheGeometry(pts, 112)
  geo.computeVertexNormals()
  return geo
}

/** Warm gold base colour with a soft diagonal sheen and faint micro-grain. */
function goldTexture(tint: [string, string, string, string]): THREE.Texture {
  const S = 256
  const cv = document.createElement('canvas')
  cv.width = cv.height = S
  const x = cv.getContext('2d')!
  const g = x.createLinearGradient(0, 0, S, S)
  g.addColorStop(0, tint[0])
  g.addColorStop(0.45, tint[1])
  g.addColorStop(0.7, tint[2])
  g.addColorStop(1, tint[3])
  x.fillStyle = g
  x.fillRect(0, 0, S, S)
  for (let i = 0; i < 4200; i++) {
    const a = Math.random() * 0.16
    x.fillStyle = `rgba(${Math.random() < 0.5 ? '255,242,205' : '120,80,20'},${a})`
    x.fillRect(Math.random() * S, Math.random() * S, 1.4, 1.4)
  }
  const t = new THREE.CanvasTexture(cv)
  t.colorSpace = THREE.SRGBColorSpace
  t.wrapS = t.wrapT = THREE.RepeatWrapping
  t.anisotropy = 8
  return t
}

/**
 * Emboss/relief as a grayscale bump, mapped over the lathe (u = around the
 * coin, v = along the profile). Symmetric about the equator so both faces are
 * struck identically. Mid-gray is flat; lighter is raised, darker recessed.
 */
function reliefBump(): THREE.Texture {
  const W = 1024,
    H = 512
  const cv = document.createElement('canvas')
  cv.width = W
  cv.height = H
  const x = cv.getContext('2d')!
  const img = x.createImageData(W, H)
  const d = img.data
  const RAYS = 30 // guilloché spokes on the face
  const REEDS = 132 // milled ridges on the edge
  const BEADS = 72 // dots in the beaded border
  for (let py = 0; py < H; py++) {
    const v = py / (H - 1)
    const t = Math.min(v, 1 - v) // 0 at face centre, 0.25 at rim, 0.5 at equator
    for (let px = 0; px < W; px++) {
      const u = px / W
      let val = 128
      if (t < 0.25) {
        // ---- face ----
        const fr = t / 0.25 // 0 centre → 1 rim
        if (fr < 0.16) {
          // faceted central boss — a raised dome cut with radial facets
          const facet = 0.5 + 0.5 * Math.cos(u * Math.PI * 2 * 8)
          val = 150 + (0.16 - fr) * 320 + facet * 26
        } else if (fr < 0.32) {
          // moat ring around the boss (recessed) with a bright inner lip
          val = fr < 0.2 ? 196 : 84
        } else if (fr < 0.68) {
          // radiant guilloché — fine sunburst spokes
          const ray = Math.cos(u * Math.PI * 2 * RAYS)
          const fall = 1 - Math.abs(fr - 0.5) / 0.18
          val = 128 + ray * 30 * (0.45 + 0.55 * Math.max(0, fall))
        } else if (fr < 0.78) {
          // beaded border: round raised dots
          const bead = Math.cos(u * Math.PI * 2 * BEADS)
          const band = 1 - Math.abs(fr - 0.73) / 0.05
          val = 128 + Math.max(0, bead) * 96 * Math.max(0, band)
        } else if (fr < 0.88) {
          // engraved groove between border and rim
          val = 92
        } else {
          // raised milled rim of the coin face
          val = 210
        }
      } else {
        // ---- reeded edge ----
        const reed = Math.cos(u * Math.PI * 2 * REEDS)
        val = 128 + reed * 64
      }
      const i = (py * W + px) * 4
      const c = Math.max(0, Math.min(255, val)) | 0
      d[i] = d[i + 1] = d[i + 2] = c
      d[i + 3] = 255
    }
  }
  x.putImageData(img, 0, 0)
  const tex = new THREE.CanvasTexture(cv)
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping
  tex.anisotropy = 8
  return tex
}

// three gold alloys so the heap doesn't read as one uniform colour
const GOLD_TINTS: Array<[string, string, string, string]> = [
  ['#f8e29c', '#ecc05a', '#cb9636', '#b07d2a'], // bright sovereign
  ['#f3d488', '#d8a544', '#b07f2c', '#8f6420'], // deep ducat
  ['#fbe7ad', '#e6b85a', '#c08a3a', '#9d6f28'], // rose-gold guinea
]

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
  const bump = reliefBump()
  const maps = GOLD_TINTS.map((tint) => goldTexture(tint))
  const materials = maps.map(
    (map, i) =>
      new THREE.MeshStandardMaterial({
        map,
        bumpMap: bump,
        bumpScale: 0.24,
        color: [0xe6c179, 0xd9ad5e, 0xe9c98a][i],
        metalness: 1.0,
        roughness: 0.3,
        envMapIntensity: 1.2,
      }),
  )

  // Precompute every coin's fixed home slot. A handful of loose coins lie flat
  // around the base (sprinkled in early so a small pot looks scattered), the
  // rest stack into bias-weighted columns. The order is monotonic: slot i never
  // changes, so growing the pot only reveals later slots — placed coins hold.
  const slots: Slot[] = []
  {
    const counts = new Array(NSTACKS).fill(0)
    let flatUsed = 0
    for (let i = 0; i < MAX_CHIPS; i++) {
      const wantFlat = flatUsed < FLAT_MAX && i % 4 === 1
      if (wantFlat) {
        const k = flatUsed++
        const a = hash(k, 7) * Math.PI * 2
        const rad = 0.62 + hash(k, 8) * 0.46
        const tilt = hash(k, 9) < 0.22 // a few rest tipped against a stack
        const lean = tilt ? 0.16 + hash(k, 11) * 0.1 : (hash(k, 12) - 0.5) * 0.05
        slots.push({
          x: Math.cos(a) * rad,
          z: Math.sin(a) * rad * 0.82,
          // lift the coin's centre by its own tilt so the low edge never sinks
          // through the felt
          homeY: COIN_H / 2 + Math.sin(lean) * COIN_R + 0.002,
          rotY: hash(k, 10) * Math.PI * 2,
          lean,
          leanAxis: hash(k, 13) * Math.PI * 2,
          matIdx: k % materials.length,
        })
      } else {
        let best = 0,
          bestV = Infinity
        for (let s = 0; s < NSTACKS; s++) {
          const c = counts[s]
          if (c >= MAX_H) continue
          const v = c + STACK_BIAS[s]
          if (v < bestV) {
            bestV = v
            best = s
          }
        }
        const h = counts[best]
        counts[best]++
        const [sx, sz] = STACK_POS[best]
        const jx = (hash(i, 1) - 0.5) * 0.035
        const jz = (hash(i, 2) - 0.5) * 0.035
        slots.push({
          x: sx + jx,
          z: sz + jz,
          homeY: COIN_H / 2 + h * (COIN_H + GAP),
          rotY: hash(i, 3) * Math.PI * 2,
          lean: (hash(best, h) - 0.5) * 0.05,
          leanAxis: hash(i, 5) * Math.PI * 2,
          matIdx: (best + h) % materials.length,
        })
      }
    }
  }

  const chips: Chip[] = []
  let target = 0
  let lastT = -1

  function grow(to: number, t: number) {
    for (let i = chips.length; i < to; i++) {
      const sl = slots[i]
      const mesh = new THREE.Mesh(geom, materials[sl.matIdx])
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
    bump.dispose()
    maps.forEach((m) => m.dispose())
    materials.forEach((m) => m.dispose())
  }

  return { group, setAmount, update, dispose }
}
