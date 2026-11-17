/**
 * Procedural coin-clink audio for the landing-page pour.
 *
 * No audio assets ship with the app — each coin's touchdown is synthesised on
 * the fly via the Web Audio API (a handful of inharmonic partials with a fast
 * metallic decay), so the sound is perfectly in sync with the physics and a
 * cascade rings like many distinct coins rather than one sample on repeat.
 *
 * The hard constraint is autoplay policy: a fresh AudioContext stays *suspended*
 * until the first user gesture, so the on-load pour is inevitably silent — by
 * the time anyone clicks, the coins have already landed and there's nothing left
 * to ring. So the flow is: start muted; the first gesture (and the mute button)
 * resumes audio; and enabling sound REPLAYS the pour (`fireReplay`) so the coins
 * fall again, this time audibly. The mute preference persists across reloads.
 */

const STORAGE_KEY = 'st-audio-muted'

let ctx: AudioContext | null = null
let master: GainNode | null = null
let muted = readMuted()
let lastClink = -1 // ctx-time of the previous clink, to throttle dense bursts
let unlockBound = false
let replayFn: (() => void) | null = null
let lastReplay = -1 // perf-time of the last replay, to dedupe double triggers

function readMuted(): boolean {
  // Default to muted: autoplay blocks the on-load pour anyway, so the button
  // starts as "tap to enable sound" and enabling it replays the coins audibly.
  try {
    const v = localStorage.getItem(STORAGE_KEY)
    return v === null ? true : v === '1'
  } catch {
    return true
  }
}

function ensureCtx(): AudioContext | null {
  if (typeof window === 'undefined') return null
  if (!ctx) {
    const AC =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!AC) return null
    ctx = new AC()
    master = ctx.createGain()
    master.gain.value = muted ? 0 : 1
    master.connect(ctx.destination)
  }
  return ctx
}

/** Run `cb` once the context is actually running (resuming it if suspended). */
function whenRunning(cb: () => void) {
  const ac = ensureCtx()
  if (!ac) return
  if (ac.state === 'running') cb()
  else ac.resume().then(cb).catch(() => {})
}

/**
 * Register (or clear) the pour-replay callback. The landing table registers a
 * "re-drop the heap" here so enabling sound can rain the coins in again audibly.
 */
export function onReplayRequest(fn: (() => void) | null) {
  replayFn = fn
}

function fireReplay() {
  if (muted || !replayFn) return
  // Dedupe: a single unmute can arrive via both the global gesture unlock and
  // setMuted() — only pour once.
  const now = performance.now()
  if (lastReplay >= 0 && now - lastReplay < 400) return
  lastReplay = now
  replayFn()
}

/**
 * Register one-shot listeners that resume audio on the first user interaction.
 * Safe to call repeatedly (binds only once). On unlock, if we're unmuted, the
 * pour replays so the coins are heard even though the on-load drop was silent.
 */
export function initAudioUnlock() {
  if (unlockBound || typeof window === 'undefined') return
  unlockBound = true
  const unlock = () => {
    window.removeEventListener('pointerdown', unlock)
    window.removeEventListener('keydown', unlock)
    window.removeEventListener('touchstart', unlock)
    // Resolve after the triggering click's own handler has run, so `muted`
    // already reflects a mute-button toggle before we decide whether to replay.
    whenRunning(() => fireReplay())
  }
  window.addEventListener('pointerdown', unlock)
  window.addEventListener('keydown', unlock)
  window.addEventListener('touchstart', unlock)
}

export function isMuted(): boolean {
  return muted
}

export function setMuted(next: boolean) {
  muted = next
  try {
    localStorage.setItem(STORAGE_KEY, next ? '1' : '0')
  } catch {
    /* private mode / storage disabled — preference just won't persist */
  }
  const ac = ensureCtx()
  if (ac && master) master.gain.setTargetAtTime(next ? 0 : 1, ac.currentTime, 0.02)
  // Enabling sound is a deliberate "let me hear it" — resume and replay the pour.
  if (!next) whenRunning(() => fireReplay())
}

export function toggleMuted(): boolean {
  setMuted(!muted)
  return muted
}

/**
 * A single metallic coin "ting" — a struck, quickly-decaying cluster of
 * inharmonic partials plus a short noise transient for the strike. Pitch and
 * level are jittered per hit so a rapid cascade never sounds mechanical.
 */
export function playCoinClink() {
  if (muted) return
  const ac = ensureCtx()
  if (!ac || !master || ac.state !== 'running') return
  const now = ac.currentTime
  // Cap density: a ~2.5s pour lands dozens of coins, but back-to-back hits in
  // the same few ms would just clip — thin them so the cascade stays crisp.
  if (lastClink >= 0 && now - lastClink < 0.013) return
  lastClink = now

  const r = () => Math.random()
  const dur = 0.12 + r() * 0.06
  const f0 = 1950 + r() * 1000 // fundamental, jittered per coin
  const level = 0.16 + r() * 0.06

  const voice = ac.createGain()
  voice.gain.value = level
  voice.connect(master)

  // inharmonic partials give the bright, bell-like ring of struck metal
  const partials = [1, 2.74, 5.19]
  for (let i = 0; i < partials.length; i++) {
    const osc = ac.createOscillator()
    osc.type = 'sine'
    osc.frequency.value = f0 * partials[i] * (0.99 + r() * 0.02)
    const pg = ac.createGain()
    const amp = 0.6 / (i + 1)
    const decay = dur * (1 - i * 0.22)
    pg.gain.setValueAtTime(0.0001, now)
    pg.gain.linearRampToValueAtTime(amp, now + 0.0015)
    pg.gain.exponentialRampToValueAtTime(0.0001, now + Math.max(0.03, decay))
    osc.connect(pg)
    pg.connect(voice)
    osc.start(now)
    osc.stop(now + dur + 0.03)
  }

  // brief filtered-noise transient — the "click" of the strike before the ring
  const n = Math.floor(ac.sampleRate * 0.02)
  const buf = ac.createBuffer(1, n, ac.sampleRate)
  const d = buf.getChannelData(0)
  for (let i = 0; i < n; i++) d[i] = (r() * 2 - 1) * (1 - i / n)
  const src = ac.createBufferSource()
  src.buffer = buf
  const hp = ac.createBiquadFilter()
  hp.type = 'highpass'
  hp.frequency.value = 3500
  const ng = ac.createGain()
  ng.gain.value = 0.4
  src.connect(hp)
  hp.connect(ng)
  ng.connect(voice)
  src.start(now)
}
