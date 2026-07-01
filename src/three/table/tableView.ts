import * as THREE from 'three'

/**
 * Bridges the 3D table to the 2D HUD: world-space anchors for each seat (on the
 * table's outer ring) and the pot (centre of the felt), plus a projector that
 * maps them to live screen coordinates. The HUD reads these every frame so the
 * player medallions and chips stay pinned to the table as the camera sways —
 * they ride the table instead of hovering in screen space.
 *
 * Table geometry (from tableScene): circular, R_OUTER = 5, rim top y ≈ 0.275,
 * felt y ≈ 0.105, front of table toward +z (camera side).
 */
const R_SEAT = 4.35 // on the outer rim, just inside the wooden edge
const Y_SEAT = 0.62 // medallion centre floats just above the rim

/**
 * Seat angles are measured in degrees from the front (toward the camera, +z),
 * positive = toward the right (+x). The price cabinet is the hero piece across
 * the BACK of the felt; the playable table is everything in front of its base
 * line. You sit dead front (0°, drawn as panels) and opponents fan across the
 * FRONT arc, in front of the cabinet, facing it — never up its sides. The cap
 * stays under 90° so every seat sits camera-side of the cabinet's front line
 * (z > 0); LOW hugs the front near you, HIGH is the widest before a seat would
 * begin to ride up alongside the cabinet.
 */
const FLANK_LOW = 42
const FLANK_HIGH = 78
const FLANK_MID = 64

/**
 * Lay out `n` opponents across the front arc, balanced left↔right and spread so
 * the arrangement looks composed for any table size (2–5 players ⇒ 1–4
 * opponents). Returns angles in degrees, ordered left (negative) → right
 * (positive) for a stable seat→slot mapping.
 *
 *   1 → [front-right]          2 → [±front]
 *   3 → [left, right pair]     4 → [both sides, paired]
 */
export function seatAngles(n: number): number[] {
  if (n <= 0) return []
  if (n === 1) return [FLANK_MID]
  const right = Math.ceil(n / 2)
  const left = n - right
  const spread = (k: number): number[] =>
    k === 1
      ? [FLANK_MID]
      : Array.from({ length: k }, (_, i) => FLANK_LOW + ((FLANK_HIGH - FLANK_LOW) * i) / (k - 1))
  const r = spread(right)
  const l = spread(left)
    .map((a) => -a)
    .sort((a, b) => a - b)
  return [...l, ...r]
}

function seatWorld(angleDeg: number): THREE.Vector3 {
  const a = (angleDeg * Math.PI) / 180
  return new THREE.Vector3(Math.sin(a) * R_SEAT, Y_SEAT, Math.cos(a) * R_SEAT)
}
// The 3D coin heap is centred on (0, felt, 1.1); the amount label floats just
// above the top of the pile and a touch toward the camera so the number reads
// over the coins rather than buried in them.
const POT_WORLD = new THREE.Vector3(0, 0.85, 1.25)
// The pre-game countdown sits lower and further forward than the pot label so the
// ring rests on the open felt, clear of the price cabinet behind it.
const FELT_CENTRE_WORLD = new THREE.Vector3(0, 0.42, 1.42)

export interface ScreenPoint {
  x: number
  y: number
  behind: boolean
}

let camera: THREE.PerspectiveCamera | null = null
let canvas: HTMLElement | null = null

export function bindTableView(cam: THREE.PerspectiveCamera, el: HTMLElement) {
  camera = cam
  canvas = el
}
export function unbindTableView() {
  camera = null
  canvas = null
}
export function isTableViewReady() {
  return !!camera && !!canvas
}

const _v = new THREE.Vector3()
function project(world: THREE.Vector3): ScreenPoint | null {
  if (!camera || !canvas) return null
  _v.copy(world).project(camera)
  const rect = canvas.getBoundingClientRect()
  return {
    x: (_v.x * 0.5 + 0.5) * rect.width + rect.left,
    y: (-_v.y * 0.5 + 0.5) * rect.height + rect.top,
    behind: _v.z > 1,
  }
}

export function projectSeatAngle(angleDeg: number): ScreenPoint | null {
  return project(seatWorld(angleDeg))
}
export function projectPot(): ScreenPoint | null {
  return project(POT_WORLD)
}
export function projectFeltCentre(): ScreenPoint | null {
  return project(FELT_CENTRE_WORLD)
}
