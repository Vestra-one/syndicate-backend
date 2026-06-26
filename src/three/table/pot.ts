import * as THREE from 'three'

/**
 * The pot: stacks of minted golden coins resting on the felt, lit by the same
 * candlelight and casting the same shadows as the table. Each coin is a lathed
 * solid with rounded, reeded edges and an embossed face (raised rim, beaded
 * border, radiant sunburst, central boss) so it reads as a real struck coin
 * with genuine depth as the camera sways — not a flat disc.
 *
 * The pile grows monotonically with the pot: coins land on the currently
 * shortest stack so the heap builds organically, and existing coins never move
 * as the amount climbs — only the new ones drop in. When the pot shrinks (a new
 * hand) the surplus is swept away.
 */

export interface PotPile {
  group: THREE.Group
  /** Set the live pot value; coins animate toward the new amount. */
  setAmount: (amount: number) => void
  /** Advance animations. `t` is the scene clock (seconds-ish). */
  update: (t: number) => void
  dispose: () => void
}

const COIN_R = 0.235 // coin radius (world units) — smaller than a chip
const COIN_H = 0.072 // coin thickness (full) — chunky enough to read in profile
const GAP = 0.0015 // hairline between stacked coins so edges separate
const NSTACKS = 6
const MAX_H = 18
const MAX_CHIPS = NSTACKS * MAX_H
const DROP = 1.7 // how far above home a new coin starts
const DROP_DUR = 0.42 // seconds for a coin to settle
const LEAVE_DUR = 0.3 // seconds for a swept coin to vanish

/** coins ≈ 1.4·√amount — a satisfying pile that scales gently with the pot. */
function chipsFor(amount: number): number {
  if (amount <= 0) return 0
  return Math.max(1, Math.min(MAX_CHIPS, Math.round(1.4 * Math.sqrt(amount))))
}

// A loose, organic cluster of stack centers (x,z offsets from the pile origin).
const STACK_POS: [number, number][] = [
  [0.0, 0.03],
  [0.6, 0.12],
  [-0.58, 0.14],
  [0.33, -0.52],
  [-0.36, -0.46],
  [0.05, 0.58],
]
// per-stack fill bias → staggered, hand-stacked heights (lower = grows taller)
const STACK_BIAS = [0.0, 0.55, 0.25, 0.85, 0.4, 0.7]

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

/** A lathed coin: rounded, slightly domed faces with a reeded rim. */
function coinGeometry(): THREE.LatheGeometry {
  // profile points (radius, y) in fractions, top centre -> outer -> bottom centre
  const R = COIN_R,
    HT = COIN_H / 2
  const prof: [number, number][] = [
    [0.0, 1.0],
    [0.34, 1.0],
    [0.6, 0.97],
    [0.79, 0.88],
    [0.91, 0.72],
    [0.98, 0.42],
    [1.0, 0.0],
    [0.98, -0.42],
    [0.91, -0.72],
    [0.79, -0.88],
    [0.6, -0.97],
    [0.34, -1.0],
    [0.0, -1.0],
  ]
  const pts = prof.map(([r, y]) => new THREE.Vector2(r * R, y * HT))
  return new THREE.LatheGeometry(pts, 96)
}

/** Warm gold base color with a soft radial sheen and faint micro-noise. */
function goldTexture(): THREE.Texture {
  const S = 256
  const cv = document.createElement('canvas')
  cv.width = cv.height = S
  const x = cv.getContext('2d')!
  const g = x.createLinearGradient(0, 0, S, S)
  g.addColorStop(0, '#f6dd94')
  g.addColorStop(0.45, '#e8b94e')
  g.addColorStop(0.7, '#c98f2f')
  g.addColorStop(1, '#b07d2a')
  x.fillStyle = g
  x.fillRect(0, 0, S, S)
  for (let i = 0; i < 4000; i++) {
    const a = Math.random() * 0.18
    x.fillStyle = `rgba(${Math.random() < 0.5 ? '255,240,200' : '120,80,20'},${a})`
    x.fillRect(Math.random() * S, Math.random() * S, 1.5, 1.5)
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
  const RAYS = 26 // sunburst spokes on the face
  const REEDS = 116 // milled ridges on the edge
  const BEADS = 60 // dots in the beaded border
  for (let py = 0; py < H; py++) {
    const v = py / (H - 1)
    const t = Math.min(v, 1 - v) // 0 at face centre, 0.25 at rim, 0.5 at equator
    for (let px = 0; px < W; px++) {
      const u = px / W
      let val = 128
      if (t < 0.25) {
        // ---- face ----
        const fr = t / 0.25 // 0 centre -> 1 rim
        if (fr < 0.13) {
          // central boss: a raised dome with a tiny pip
          val = 150 + (0.13 - fr) * 360
        } else if (fr < 0.66) {
          // radiant sunburst spokes
          const ray = Math.cos(u * Math.PI * 2 * RAYS)
          val = 128 + ray * 34 * (0.4 + 0.6 * (1 - Math.abs(fr - 0.4) / 0.3))
        } else if (fr < 0.74) {
          // inner groove ring (recessed) + bright lip
          val = fr < 0.7 ? 86 : 196
        } else if (fr < 0.86) {
          // beaded border: round dots
          const bead = Math.cos(u * Math.PI * 2 * BEADS)
          const band = 1 - Math.abs(fr - 0.8) / 0.06
          val = 128 + Math.max(0, bead) * 90 * Math.max(0, band)
        } else {
          // raised outer rim of the coin
          val = 205
        }
      } else {
        // ---- reeded edge ----
        const reed = Math.cos(u * Math.PI * 2 * REEDS)
        val = 128 + reed * 60
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

// ---- coin pile ---------------------------------------------------------------

interface Chip {
  mesh: THREE.Mesh
  homeY: number
  born: number
  leaving: boolean
  leaveStart: number
}

export function createPotPile(opts: { feltY: number; center: THREE.Vector3 }): PotPile {
  const group = new THREE.Group()
  group.position.copy(opts.center)
  group.position.y = opts.feltY

  const geom = coinGeometry()
  const goldMap = goldTexture()
  const bump = reliefBump()
  const material = new THREE.MeshStandardMaterial({
    map: goldMap,
    bumpMap: bump,
    bumpScale: 0.08,
    color: 0xd9b06e,
    metalness: 0.95,
    roughness: 0.38,
    envMapIntensity: 0.95,
  })

  // Precompute a monotonic, staggered fill order: each new coin lands on the
  // currently-shortest (bias-weighted) stack, so stacks grow to uneven heights
  // like a hand-built heap, yet existing coins never move as the pot climbs.
  const slotStack: number[] = []
  const slotHeight: number[] = []
  {
    const counts = new Array(NSTACKS).fill(0)
    for (let i = 0; i < MAX_CHIPS; i++) {
      let best = 0,
        bestV = Infinity
      for (let s = 0; s < NSTACKS; s++) {
        const v = counts[s] + STACK_BIAS[s]
        if (v < bestV) {
          bestV = v
          best = s
        }
      }
      slotStack[i] = best
      slotHeight[i] = counts[best]
      counts[best]++
    }
  }

  const chips: Chip[] = []
  let target = 0
  let lastT = -1

  function slotTransform(i: number) {
    const s = slotStack[i]
    const h = slotHeight[i]
    const [sx, sz] = STACK_POS[s]
    const jx = (hash(i, 1) - 0.5) * 0.04
    const jz = (hash(i, 2) - 0.5) * 0.04
    const lean = (hash(s, h) - 0.5) * 0.045
    const rotY = hash(i, 3) * Math.PI * 2
    const homeY = (h + 0.5) * (COIN_H + GAP)
    return { x: sx + jx, z: sz + jz, homeY, rotY, lean }
  }

  function grow(to: number, t: number) {
    for (let i = chips.length; i < to; i++) {
      const tf = slotTransform(i)
      const mesh = new THREE.Mesh(geom, material)
      mesh.castShadow = true
      mesh.receiveShadow = true
      mesh.position.set(tf.x, tf.homeY, tf.z)
      mesh.rotation.set(tf.lean, tf.rotY, tf.lean * 0.7)
      group.add(mesh)
      chips.push({ mesh, homeY: tf.homeY, born: t, leaving: false, leaveStart: 0 })
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
        c.mesh.scale.setScalar(0.55 + 0.45 * sc)
      }
    }
    lastT = t
  }

  function dispose() {
    geom.dispose()
    goldMap.dispose()
    bump.dispose()
    material.dispose()
  }

  return { group, setAmount, update, dispose }
}
