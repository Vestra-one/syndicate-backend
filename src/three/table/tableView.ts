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
 * positive = toward the right (+x). You sit dead front (0°, drawn as panels)
 * and the wide price board fills the back (~180°), so opponents are seated only
 * on the two camera-facing flanks, within this band — clear of both you and the
 * board. LOW hugs the front edge, HIGH sits up near the board's shoulders.
 */
const FLANK_LOW = 58
const FLANK_HIGH = 120
const FLANK_MID = 90

/**
 * Lay out `n` opponents symmetrically around the table, balanced left↔right and
 * spread across each flank so the arrangement looks composed for any table size
 * (2–5 players ⇒ 1–4 opponents). Returns angles in degrees, ordered left flank
 * (negative) → right flank (positive) for a stable seat→slot mapping.
 *
 *   1 → [mid-right]            2 → [±mid]
 *   3 → [left-mid, right pair] 4 → [both flanks, paired]
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
const POT_WORLD = new THREE.Vector3(0, 0.2, 1.1)

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
