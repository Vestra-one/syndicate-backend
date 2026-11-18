import * as THREE from 'three'
import type { PriceRange } from '@/lib/priceRanges'

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

/**
 * The single source of truth for which seat sits at which angle: you (if seated)
 * dead front at 0°, opponents fanned across the front arc in stable seat order.
 * Both the HUD pods (Seats.tsx) and the 3D coin stacks (seatChips) read this, so
 * a player's medallion and their physical chips always share the same bearing.
 */
export function seatFanAngles(
  seatIndices: number[],
  yourSeat: number | undefined,
): Map<number, number> {
  const others = seatIndices.filter((s) => s !== yourSeat).sort((a, b) => a - b)
  const angles = seatAngles(others.length)
  const map = new Map<number, number>()
  others.forEach((s, i) => map.set(s, angles[i]))
  if (yourSeat != null && seatIndices.includes(yourSeat)) map.set(yourSeat, 0)
  return map
}

function seatWorld(angleDeg: number, radius = R_SEAT, y = Y_SEAT): THREE.Vector3 {
  const a = (angleDeg * Math.PI) / 180
  return new THREE.Vector3(Math.sin(a) * radius, y, Math.cos(a) * radius)
}
// The 3D coin heap is centred on (0, felt, 1.1); the amount label floats well
// clear above the top of the pile (raised so a tall pot never buries the number
// in coins) and a touch toward the camera so it reads over the heap.
const POT_WORLD = new THREE.Vector3(0, 1.5, 1.2)
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
  return flat || (!!camera && !!canvas)
}

/**
 * Flat table (lite mode): no camera to project through, so the same anchors resolve to
 * fixed places on the screen — opponents across the top, the pot above the chart, your
 * own seat at the front. Everything that pins to the table keeps working unchanged.
 */
let flat = false
export function setFlatTableView(on: boolean) {
  flat = on
}
function flatAt(fx: number, fy: number): ScreenPoint {
  return { x: window.innerWidth * fx, y: window.innerHeight * fy, behind: false }
}
function flatSeat(angleDeg: number): ScreenPoint {
  const a = Math.abs(angleDeg)
  const side = angleDeg < 0 ? -1 : 1
  if (a < 8) return flatAt(0.5, 0.7) // your own seat, at the front
  // Opponents sit at 42°…78° a side: the outer pair at the table's shoulders, the inner
  // pair (and a lone opponent) either side of the chart's top edge.
  if (a >= 72) return flatAt(0.5 + side * 0.4, 0.38)
  return flatAt(0.5 + side * 0.23, 0.19)
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
  if (flat) return flatSeat(angleDeg)
  return project(seatWorld(angleDeg))
}
/**
 * A tighter seat ring for the pre-game waiting console: pulled off the far
 * outer rim and lowered a touch so the medallions sit ON the open felt in
 * front of the cabinet, clear of the flanking rails.
 */
const R_WAIT = 3.35
const Y_WAIT = 0.5
export function projectWaitingSeat(angleDeg: number): ScreenPoint | null {
  // The waiting fan runs −40°…+40°: lay it out as one row at the front of the felt.
  if (flat) return flatAt(0.5 + (angleDeg / 40) * 0.3, 0.68)
  return project(seatWorld(angleDeg, R_WAIT, Y_WAIT))
}
export function projectPot(): ScreenPoint | null {
  if (flat) return flatAt(0.5, 0.2)
  return project(POT_WORLD)
}
export function projectFeltCentre(): ScreenPoint | null {
  if (flat) return flatAt(0.5, 0.47)
  return project(FELT_CENTRE_WORLD)
}

/**
 * World-space anchors for the price cabinet's clickable timeframe tabs, handed in
 * by tableScene once the cabinet mesh exists (its screen sits at a fixed local
 * transform, so these anchors never move — only the camera does). Lets the 2D
 * PriceBoardTabs overlay project each tab's real position without reaching into
 * the Three.js scene graph itself.
 */
let priceTabAnchors: { range: PriceRange; world: THREE.Vector3 }[] = []
export function bindPriceBoardTabs(anchors: { range: PriceRange; world: THREE.Vector3 }[]) {
  priceTabAnchors = anchors
}
export function unbindPriceBoardTabs() {
  priceTabAnchors = []
}
export function projectPriceTab(range: PriceRange): ScreenPoint | null {
  const a = priceTabAnchors.find((x) => x.range === range)
  return a ? project(a.world) : null
}

/**
 * World-space anchor for the cabinet's "CHART" launch button (see priceBoard's
 * getChartButtonAnchor), for the same invisible-overlay click technique as the
 * timeframe tabs above.
 */
let chartButtonAnchor: THREE.Vector3 | null = null
export function bindPriceChartButton(anchor: THREE.Vector3) {
  chartButtonAnchor = anchor
}
export function unbindPriceChartButton() {
  chartButtonAnchor = null
}
export function projectPriceChartButton(): ScreenPoint | null {
  return chartButtonAnchor ? project(chartButtonAnchor) : null
}
