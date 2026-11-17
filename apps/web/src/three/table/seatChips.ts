import * as THREE from 'three'
import {
  type CoinKit,
  COIN_R,
  COIN_H,
  hash,
  easeOutBack,
  easeInOutCubic,
} from './pot'

/**
 * Every seated player's money made physical: a neat personal coin stack resting
 * on the felt at their seat (height ∝ stack value) and a small "committed" pile
 * ringed just outside the central pot holding what they've put in this betting
 * round. Together with the pot heap they turn the felt from a chart-with-labels
 * into a live table where you can *see* the money move.
 *
 * The whole thing is state-driven: `setSeats` is handed the current stack and
 * committed value for each seat and animates the delta —
 *   • committed grew  → coins slide from the player's stack to the committed pile
 *   • committed shrank → those coins sweep inward into the pot (a fold sends them
 *                        immediately; the end-of-round sweep sends everyone's)
 *   • stack grew       → coins drop in (a pot won, merging into the winner)
 *   • folded           → the player's stack desaturates toward dead-money grey
 * No feed plumbing: the diff of two snapshots is enough to choreograph the beat.
 *
 * All coins reuse the table's one shared {@link CoinKit} (geometry + textures),
 * scaled down from the fat pot sovereigns so a stack reads as a tidy chip column
 * rather than a second heap. Each seat clones the kit's materials (cheap — they
 * share the expensive textures) so a folded stack can be dimmed on its own.
 */

export interface SeatChipState {
  /** Stable seat index (0-based) — identity across snapshots. */
  seat: number
  /** Seat angle in degrees, front = 0, +x = right (matches tableView). */
  angle: number
  /** Personal stack, in whole token units (e.g. USDC), not base units. */
  stack: number
  /** Committed this betting round, in whole token units. */
  committed: number
  folded: boolean
  allIn: boolean
}

export interface SeatChips {
  group: THREE.Group
  /**
   * Reconcile the physical chips to this set of seats; absent seats empty out.
   * `instant` snaps stacks and committed piles to rest with no travel/drop —
   * used to hydrate an in-progress hand so existing bets don't animate in.
   */
  setSeats: (seats: SeatChipState[], instant?: boolean) => void
  /** A check: no coins move — ripple the felt at the seat (a knuckle-knock). */
  knock: (seat: number) => void
  /**
   * A win: stream coins from the pot to the winner's stack (the merge). Pass the
   * amount won (whole token units) to scale the stream — a monster pot pours, a
   * small one trickles; omitted falls back to a fixed handful.
   */
  awardPot: (seat: number, amount?: number) => void
  update: (t: number) => void
  dispose: () => void
}

// --- tuning ------------------------------------------------------------------
const CHIP_SCALE = 0.72 // seat coins are daintier than the pot's fat sovereigns
const R_STACK = 2.5 // personal stack radius on the felt (rim-ward)
const R_COMMIT_RING = 0.98 // committed piles ring the pot at this radius from it
const POT_LOCAL = new THREE.Vector3(0, 0, 1.1) // pot centre in the group's frame
const STACK_COL_CAP = 10 // coins per column before a stack starts a new one
const COMMIT_COL_CAP = 5
const GAP = 0.004 // hairline between stacked coins
const DROP = 1.1 // how far above home a dropped-in coin starts
const DROP_DUR = 0.42
const TRAVEL_DUR = 0.52 // slide from stack → committed, or committed → pot
const TRAVEL_ARC = 0.45 // apex lift of a sliding coin's parabola
const DIM_RATE = 3.2 // folded-stack desaturation speed (per second)

const CH = COIN_H * CHIP_SCALE // scaled coin thickness
const PITCH = CH + GAP // vertical spacing in a column
const DIM_COLOR = new THREE.Color(0x4a4038) // dead-money grey-brown

const COINS_PER_STACK = (v: number) =>
  v <= 0 ? 0 : Math.max(1, Math.min(22, Math.round(4.4 * Math.sqrt(v))))
const COINS_PER_COMMIT = (v: number) =>
  v <= 0 ? 0 : Math.max(1, Math.min(9, Math.round(3 * Math.sqrt(v))))

// direction from the felt centre out to a seat angle (unit, on the felt plane)
function seatDir(angleDeg: number): THREE.Vector3 {
  const a = (angleDeg * Math.PI) / 180
  return new THREE.Vector3(Math.sin(a), 0, Math.cos(a))
}

/**
 * Local resting positions for a pile of `n` coins packed into vertical columns
 * of at most `cap`, the columns fanned in a short row so a tall stack becomes a
 * tidy pair rather than one precarious tower. `seed` decorrelates the tiny
 * per-coin jitter between piles.
 */
function columnSlots(n: number, cap: number, center: THREE.Vector3, seed: number): THREE.Vector3[] {
  const cols = Math.max(1, Math.ceil(n / cap))
  const pitchXZ = 2 * COIN_R * CHIP_SCALE * 1.04
  const slots: THREE.Vector3[] = []
  for (let i = 0; i < n; i++) {
    const col = Math.floor(i / cap)
    const row = i % cap
    const cx = (col - (cols - 1) / 2) * pitchXZ
    const jx = (hash(seed + i, 1) - 0.5) * 0.02
    const jz = (hash(seed + i, 2) - 0.5) * 0.02
    slots.push(
      new THREE.Vector3(
        center.x + cx + jx,
        CH / 2 + row * PITCH,
        center.z + jz,
      ),
    )
  }
  return slots
}

type Phase = 'drop' | 'travel' | 'idle'

interface Coin {
  mesh: THREE.Mesh
  phase: Phase
  t0: number
  dur: number
  from: THREE.Vector3
  home: THREE.Vector3 // final resting local position
  rotY: number
  dying: boolean // remove once it arrives (a coin swept to the pot)
}

interface Seat {
  angle: number
  stackCenter: THREE.Vector3
  commitCenter: THREE.Vector3
  stackCoins: Coin[]
  commitCoins: Coin[]
  mats: THREE.Material[] // this seat's material clones (per alloy: [face, edge])
  baseColors: THREE.Color[]
  baseEmissive: number[]
  dim: number // 0 = bright, 1 = fully folded/grey
  folded: boolean
  allIn: boolean
  halo: THREE.Mesh | null // pulsing ring marking an all-in seat (null otherwise)
}

export function createSeatChips(opts: { feltY: number; kit: CoinKit }): SeatChips {
  const { kit } = opts
  const group = new THREE.Group()
  group.position.y = opts.feltY

  const seats = new Map<number, Seat>()

  function seatCenters(angle: number): { stack: THREE.Vector3; commit: THREE.Vector3 } {
    const dir = seatDir(angle)
    const stack = dir.clone().multiplyScalar(R_STACK)
    // committed pile rings the pot: sit it just outside the heap on the line
    // from the pot out toward this seat, so bets always face the middle.
    const fromPot = stack.clone().sub(POT_LOCAL)
    fromPot.y = 0
    const commit = POT_LOCAL.clone().add(fromPot.normalize().multiplyScalar(R_COMMIT_RING))
    commit.y = 0
    stack.y = 0
    return { stack, commit }
  }

  function makeSeat(angle: number): Seat {
    const { stack, commit } = seatCenters(angle)
    // clone the kit materials so this seat can be dimmed on its own (clones
    // share the kit's textures — only the cheap material wrapper is duplicated)
    const mats: THREE.Material[] = []
    const baseColors: THREE.Color[] = []
    const baseEmissive: number[] = []
    for (const set of kit.matSets) {
      for (const m of set as THREE.MeshStandardMaterial[]) {
        const c = m.clone()
        mats.push(c)
        baseColors.push(c.color.clone())
        baseEmissive.push(c.emissiveIntensity)
      }
    }
    return {
      angle,
      stackCenter: stack,
      commitCenter: commit,
      stackCoins: [],
      commitCoins: [],
      mats,
      baseColors,
      baseEmissive,
      dim: 0,
      folded: false,
      allIn: false,
      halo: null,
    }
  }

  // each seat's material clones are laid out [alloy0 face, alloy0 edge, alloy1
  // face, ...]; a coin picks an alloy and takes that pair as its [face,face,edge]
  function seatMatArray(s: Seat, alloy: number): THREE.Material[] {
    const face = s.mats[alloy * 2]
    const edge = s.mats[alloy * 2 + 1]
    return [face, face, edge]
  }

  function newCoin(s: Seat, idx: number, home: THREE.Vector3, from: THREE.Vector3, t: number, phase: Phase): Coin {
    const alloy = idx % kit.matSets.length
    const mesh = new THREE.Mesh(kit.geom, seatMatArray(s, alloy))
    mesh.scale.setScalar(CHIP_SCALE)
    mesh.castShadow = true
    mesh.receiveShadow = true
    const rotY = hash(idx * 3 + 1, s.angle) * Math.PI * 2
    // a whisper of lean so a column isn't robotically straight
    const lean = (hash(idx, 7) - 0.5) * 0.05
    mesh.rotation.set(Math.cos(rotY) * lean, rotY, Math.sin(rotY) * lean)
    mesh.position.copy(from)
    group.add(mesh)
    return { mesh, phase, t0: t, dur: phase === 'travel' ? TRAVEL_DUR : DROP_DUR, from: from.clone(), home: home.clone(), rotY, dying: false }
  }

  // current world-local height of the top of a seat's stack, so a coin leaving
  // for the committed pile launches from where it visually sat.
  function stackTop(s: Seat): THREE.Vector3 {
    const n = s.stackCoins.length
    const slot = columnSlots(Math.max(1, n), STACK_COL_CAP, s.stackCenter, s.angle + 1)
    return slot[Math.max(0, Math.min(n, slot.length) - 1)].clone()
  }

  let lastT = 0

  function reflowStack(s: Seat) {
    const slots = columnSlots(s.stackCoins.length, STACK_COL_CAP, s.stackCenter, s.angle + 1)
    s.stackCoins.forEach((c, i) => {
      c.home.copy(slots[i])
      if (c.phase === 'idle') c.mesh.position.copy(c.home)
    })
  }
  function reflowCommit(s: Seat) {
    const alive = s.commitCoins.filter((c) => !c.dying)
    const slots = columnSlots(alive.length, COMMIT_COL_CAP, s.commitCenter, s.angle + 50)
    alive.forEach((c, i) => {
      c.home.copy(slots[i])
      if (c.phase === 'idle') c.mesh.position.copy(c.home)
    })
  }

  function setSeatStack(s: Seat, count: number, t: number, instant = false) {
    const cur = s.stackCoins.length
    if (count > cur) {
      for (let i = cur; i < count; i++) {
        const slots = columnSlots(i + 1, STACK_COL_CAP, s.stackCenter, s.angle + 1)
        const home = slots[i]
        if (instant) {
          s.stackCoins.push(newCoin(s, i, home, home, t, 'idle'))
          continue
        }
        const from = home.clone()
        from.y += DROP
        s.stackCoins.push(newCoin(s, i, home, from, t + (i - cur) * 0.04, 'drop'))
      }
    } else if (count < cur) {
      // top coins leave the stack (they become the ones sliding to committed);
      // remove instantly — a travelling coin spawns in their place.
      const remove = s.stackCoins.splice(count, cur - count)
      for (const c of remove) group.remove(c.mesh)
      reflowStack(s)
    }
  }

  function addCommit(s: Seat, add: number, t: number, instant = false) {
    // launch each new committed coin from the current top of the stack
    const launch = stackTop(s)
    const base = s.commitCoins.filter((c) => !c.dying).length
    for (let i = 0; i < add; i++) {
      const slots = columnSlots(base + i + 1, COMMIT_COL_CAP, s.commitCenter, s.angle + 50)
      const home = slots[base + i]
      const c = instant
        ? newCoin(s, base + i + 100, home, home, t, 'idle')
        : newCoin(s, base + i + 100, home, launch, t + i * 0.05, 'travel')
      s.commitCoins.push(c)
    }
    // a small ring blooms where the bet lands, timed to the first coin's arrival —
    // the felt "takes" the chips (skipped on instant hydration, which has no throw)
    if (!instant && add > 0) {
      addRipple(s.commitCenter, t + TRAVEL_DUR * 0.85, 0.5, 0.06, 0.42, 0.5)
    }
  }

  function sweepCommit(s: Seat, remove: number, t: number, to: THREE.Vector3) {
    const alive = s.commitCoins.filter((c) => !c.dying)
    // sweep the outermost coins first
    const victims = alive.slice(Math.max(0, alive.length - remove))
    for (const c of victims) {
      c.phase = 'travel'
      c.dying = true
      c.t0 = t
      c.dur = TRAVEL_DUR
      c.from.copy(c.mesh.position)
      c.home.copy(to)
    }
    reflowCommit(s)
  }

  function setSeats(list: SeatChipState[], instant = false) {
    const t = lastT
    const present = new Set<number>()
    for (const st of list) {
      present.add(st.seat)
      let s = seats.get(st.seat)
      if (!s) {
        s = makeSeat(st.angle)
        seats.set(st.seat, s)
      } else if (s.angle !== st.angle) {
        // table re-seated (a player left/joined shifting the fan) — re-anchor
        const { stack, commit } = seatCenters(st.angle)
        s.angle = st.angle
        s.stackCenter.copy(stack)
        s.commitCenter.copy(commit)
        reflowStack(s)
        reflowCommit(s)
      }

      const wantCommit = COINS_PER_COMMIT(st.committed)
      const curCommit = s.commitCoins.filter((c) => !c.dying).length
      // committed first, sourcing its coins from the pre-shrink stack top
      if (wantCommit > curCommit) addCommit(s, wantCommit - curCommit, t, instant)
      else if (wantCommit < curCommit) sweepCommit(s, curCommit - wantCommit, t, POT_LOCAL)

      setSeatStack(s, COINS_PER_STACK(st.stack), t, instant)
      // hydrating an already-folded player: snap straight to dead-money grey so
      // they don't visibly fade from bright on join
      if (instant && st.folded) {
        s.dim = 1
        paintDim(s)
      }
      s.folded = st.folded
      setAllIn(s, st.allIn && !st.folded)
    }
    // seats no longer in the list (shouldn't happen mid-match) — empty them out
    for (const [seat, s] of seats) {
      if (!present.has(seat)) {
        setSeatStack(s, 0, t)
        const curCommit = s.commitCoins.filter((c) => !c.dying).length
        if (curCommit > 0) sweepCommit(s, curCommit, t, POT_LOCAL)
        setAllIn(s, false)
      }
    }
  }

  const _p = new THREE.Vector3()
  function stepCoin(c: Coin, t: number): boolean {
    // returns true when the coin should be removed
    if (c.phase === 'idle') return false
    // staggered spawns hold at their launch pose until their turn comes up
    if (t < c.t0) {
      if (c.phase === 'drop') c.mesh.position.set(c.home.x, c.home.y + DROP, c.home.z)
      else c.mesh.position.copy(c.from)
      return false
    }
    const p = Math.min(1, (t - c.t0) / c.dur)
    if (c.phase === 'drop') {
      const settle = easeOutBack(p)
      c.mesh.position.set(c.home.x, c.home.y + (1 - settle) * DROP, c.home.z)
      const s = Math.min(1, (t - c.t0) / (c.dur * 0.5))
      c.mesh.scale.setScalar(CHIP_SCALE * (0.6 + 0.4 * s))
      if (p >= 1) {
        c.phase = 'idle'
        c.mesh.position.copy(c.home)
        c.mesh.scale.setScalar(CHIP_SCALE)
      }
      return false
    }
    // travel: parabolic slide from → home
    const e = easeInOutCubic(p)
    _p.lerpVectors(c.from, c.home, e)
    _p.y += TRAVEL_ARC * Math.sin(Math.PI * p)
    c.mesh.position.copy(_p)
    if (c.dying) c.mesh.scale.setScalar(CHIP_SCALE * (1 - 0.4 * p))
    if (p >= 1) {
      if (c.dying) return true
      c.phase = 'idle'
      c.mesh.position.copy(c.home)
    }
    return false
  }

  // --- felt ripple (a check = a knuckle-knock, no coins) --------------------
  const rippleGeom = new THREE.RingGeometry(0.72, 0.9, 48)
  rippleGeom.rotateX(-Math.PI / 2)
  const rippleBase = new THREE.MeshBasicMaterial({
    color: 0xffce7a,
    transparent: true,
    opacity: 0.5,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
  })
  interface Ripple {
    mesh: THREE.Mesh
    t0: number
    dur: number
    s0: number // starting scale
    s1: number // ending scale
    op: number // peak opacity
  }
  const ripples: Ripple[] = []

  // spawn one expanding ring on the felt at a local centre
  function addRipple(center: THREE.Vector3, t0: number, dur: number, s0: number, s1: number, op: number) {
    const m = new THREE.Mesh(rippleGeom, rippleBase.clone())
    m.position.set(center.x, 0.014, center.z)
    m.scale.setScalar(s0)
    m.renderOrder = 3
    group.add(m)
    ripples.push({ mesh: m, t0, dur, s0, s1, op })
  }

  function knock(seatIdx: number) {
    const s = seats.get(seatIdx)
    if (!s) return
    // a double-tap: two rings staggered a beat apart, over the player's chips
    for (let k = 0; k < 2; k++) {
      addRipple(s.stackCenter, lastT + k * 0.16, 0.62, 0.12, 0.74, 0.55)
    }
  }

  function stepRipple(r: Ripple, t: number): boolean {
    if (t < r.t0) {
      r.mesh.visible = false
      return false
    }
    r.mesh.visible = true
    const p = Math.min(1, (t - r.t0) / r.dur)
    const s = r.s0 + p * (r.s1 - r.s0)
    r.mesh.scale.set(s, s, s)
    ;(r.mesh.material as THREE.MeshBasicMaterial).opacity = r.op * (1 - p) * (1 - p)
    return p >= 1
  }

  // --- all-in halo (a player with everything in the middle) ------------------
  // A steady ring of light under the seat's chips that breathes while the player
  // is all-in — the hand's biggest commitment gets a visual the coin diff can't
  // convey (an all-in stack often has zero coins left on the felt to read).
  const haloGeom = new THREE.RingGeometry(0.62, 0.86, 56)
  haloGeom.rotateX(-Math.PI / 2)
  const haloBase = new THREE.MeshBasicMaterial({
    color: 0xffb347,
    transparent: true,
    opacity: 0.0,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
  })

  function setAllIn(s: Seat, allIn: boolean) {
    if (allIn === s.allIn) return
    s.allIn = allIn
    if (allIn && !s.halo) {
      const m = new THREE.Mesh(haloGeom, haloBase.clone())
      m.position.set(s.stackCenter.x, 0.012, s.stackCenter.z)
      m.renderOrder = 3
      group.add(m)
      s.halo = m
    } else if (!allIn && s.halo) {
      group.remove(s.halo)
      ;(s.halo.material as THREE.Material).dispose()
      s.halo = null
    }
  }

  function stepHalo(s: Seat, t: number) {
    if (!s.halo) return
    // a slow breathing pulse — bright enough to catch the eye, never strobing
    const pulse = 0.5 + 0.5 * Math.sin(t * 3.0)
    ;(s.halo.material as THREE.MeshBasicMaterial).opacity = 0.28 + 0.32 * pulse
    const sc = 1 + 0.06 * pulse
    s.halo.scale.set(sc, sc, sc)
  }

  // --- pot → winner stream (a win = the pot merging into a stack) ------------
  // Decorative coins that arc from the pot to the winner's stack and fade as
  // they land; the winner's real stack grows via the normal setSeats diff, so
  // together they read as the pot sliding home and merging.
  const loose: Coin[] = []
  function awardPot(seatIdx: number, amount?: number) {
    const s = seats.get(seatIdx)
    if (!s) return
    // scale the stream with the pot won (√amount, like the heap), clamped so a
    // huge pot still pours in a readable arc and a tiny one shows more than a coin
    const n = amount == null ? 14 : Math.max(6, Math.min(30, Math.round(2.2 * Math.sqrt(Math.max(0, amount)))))
    for (let i = 0; i < n; i++) {
      const mats = kit.matSets[i % kit.matSets.length]
      const from = POT_LOCAL.clone().add(
        new THREE.Vector3((hash(i, 1) - 0.5) * 0.6, 0.06 + hash(i, 3) * 0.18, (hash(i, 2) - 0.5) * 0.6),
      )
      const to = s.stackCenter.clone().add(
        new THREE.Vector3((hash(i, 4) - 0.5) * 0.28, CH / 2 + hash(i, 6) * 0.3, (hash(i, 5) - 0.5) * 0.28),
      )
      const mesh = new THREE.Mesh(kit.geom, mats)
      mesh.scale.setScalar(CHIP_SCALE)
      mesh.castShadow = true
      mesh.receiveShadow = true
      mesh.position.copy(from)
      const rotY = hash(i, 9) * Math.PI * 2
      mesh.rotation.set(0, rotY, 0)
      group.add(mesh)
      loose.push({
        mesh,
        phase: 'travel',
        t0: lastT + i * 0.035,
        dur: TRAVEL_DUR * 1.25,
        from: from.clone(),
        home: to,
        rotY,
        dying: true,
      })
    }
  }

  // paint this seat's materials at its current dim level (0 = bright, 1 = grey)
  function paintDim(s: Seat) {
    const k = s.dim
    for (let i = 0; i < s.mats.length; i++) {
      const m = s.mats[i] as THREE.MeshStandardMaterial
      m.color.copy(s.baseColors[i]).lerp(DIM_COLOR, k * 0.72)
      m.emissiveIntensity = s.baseEmissive[i] * (1 - k * 0.75)
    }
  }

  function applyDim(s: Seat, dt: number) {
    const target = s.folded ? 1 : 0
    if (Math.abs(s.dim - target) < 0.001) return
    s.dim += Math.sign(target - s.dim) * Math.min(Math.abs(target - s.dim), DIM_RATE * dt)
    paintDim(s)
  }

  function update(t: number) {
    // real seconds since the previous frame (clamped like the scene loop) so
    // fold-dimming eases at wall-clock speed, not per-frame
    let dt = t - lastT
    if (!(dt > 0) || dt > 0.1) dt = 0.016
    lastT = t
    for (const s of seats.values()) {
      for (let i = s.stackCoins.length - 1; i >= 0; i--) {
        if (stepCoin(s.stackCoins[i], t)) {
          group.remove(s.stackCoins[i].mesh)
          s.stackCoins.splice(i, 1)
        }
      }
      for (let i = s.commitCoins.length - 1; i >= 0; i--) {
        if (stepCoin(s.commitCoins[i], t)) {
          group.remove(s.commitCoins[i].mesh)
          s.commitCoins.splice(i, 1)
        }
      }
      applyDim(s, dt)
      stepHalo(s, t)
    }
    for (let i = loose.length - 1; i >= 0; i--) {
      if (stepCoin(loose[i], t)) {
        group.remove(loose[i].mesh)
        loose.splice(i, 1)
      }
    }
    for (let i = ripples.length - 1; i >= 0; i--) {
      if (stepRipple(ripples[i], t)) {
        group.remove(ripples[i].mesh)
        ;(ripples[i].mesh.material as THREE.Material).dispose()
        ripples.splice(i, 1)
      }
    }
  }

  function dispose() {
    for (const s of seats.values()) {
      for (const c of [...s.stackCoins, ...s.commitCoins]) group.remove(c.mesh)
      s.mats.forEach((m) => m.dispose())
      if (s.halo) {
        group.remove(s.halo)
        ;(s.halo.material as THREE.Material).dispose()
        s.halo = null
      }
    }
    for (const c of loose) group.remove(c.mesh)
    for (const r of ripples) {
      group.remove(r.mesh)
      ;(r.mesh.material as THREE.Material).dispose()
    }
    rippleGeom.dispose()
    rippleBase.dispose()
    haloGeom.dispose()
    haloBase.dispose()
    seats.clear()
  }

  return { group, setSeats, knock, awardPot, update, dispose }
}
