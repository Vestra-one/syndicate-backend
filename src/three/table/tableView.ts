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
 * Seat angles in degrees, measured from the front (toward the camera, +z),
 * positive = clockwise toward the right (+x). The price board occupies the back
 * (~180°) and is wide, so opponents sit only on the camera-facing sides, clear
 * of the screen. Seat 0 (you) sits dead front and is drawn as panels, not a
 * medallion.
 */
const SEAT_DEG: Record<number, number> = {
  0: 0, // you — front (panels)
  1: 68, // right, lower
  2: 292, // left, lower
  3: 115, // right, upper
}
function seatWorld(seat: number): THREE.Vector3 {
  const a = ((SEAT_DEG[seat] ?? 0) * Math.PI) / 180
  return new THREE.Vector3(Math.sin(a) * R_SEAT, Y_SEAT, Math.cos(a) * R_SEAT)
}
// The 3D coin pile sits at (0, felt, 1.1); the amount label rests on the felt
// just in front of (and below) the coins, toward the camera, so the number
// reads on the table rather than floating in the air above the pile.
const POT_WORLD = new THREE.Vector3(0, 0.06, 2.05)

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

export function projectSeat(seat: number): ScreenPoint | null {
  return project(seatWorld(seat))
}
export function projectPot(): ScreenPoint | null {
  return project(POT_WORLD)
}
