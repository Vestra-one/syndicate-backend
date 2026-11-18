/**
 * Lite mode — the table without the 3D room. The 3D scene is the showpiece, but on a slow
 * machine (integrated graphics, software rendering, an old phone) it starves the page:
 * clicks lag, requests time out and a player can miss their own turn. Lite mode swaps it
 * for a flat table that costs almost nothing, so the game itself always stays responsive.
 *
 * It turns on by itself when the browser has no real GPU or the scene cannot hold a
 * playable frame rate, and the player can switch it either way (the choice is remembered).
 */
import { useSyncExternalStore } from 'react'

const KEY = 'st-lite' // 'on' | 'off' — the player's own choice; absent = automatic
type Why = 'user' | 'no-gpu' | 'slow' | null

let lite = false
let why: Why = null
const listeners = new Set<() => void>()
const emit = () => {
  // The stylesheet follows too: blur and endlessly looping glows are what starve a
  // software-rendered page (price ticks and clocks stop landing while they repaint).
  try { document.documentElement.classList.toggle('lite', lite) } catch { /* no DOM */ }
  listeners.forEach((l) => l())
}

function softwareRenderer(): boolean {
  try {
    const c = document.createElement('canvas')
    const gl = (c.getContext('webgl2') ?? c.getContext('webgl')) as WebGLRenderingContext | null
    if (!gl) return true
    const ext = gl.getExtension('WEBGL_debug_renderer_info')
    const name = ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : ''
    gl.getExtension('WEBGL_lose_context')?.loseContext()
    return /swiftshader|llvmpipe|software|softpipe|basic render/i.test(name)
  } catch {
    return true
  }
}

function init() {
  if (typeof window === 'undefined') return
  let saved: string | null = null
  try {
    saved = localStorage.getItem(KEY)
  } catch {
    /* storage blocked: automatic only */
  }
  if (saved === 'on') { lite = true; why = 'user' }
  else if (saved === 'off') { lite = false; why = 'user' }
  else if (softwareRenderer()) { lite = true; why = 'no-gpu' }
}
init()
emit()

export function isLite(): boolean {
  return lite
}
export function liteReason(): Why {
  return why
}

/** The player's switch. Remembered across visits. */
export function setLite(on: boolean): void {
  lite = on
  why = 'user'
  try {
    localStorage.setItem(KEY, on ? 'on' : 'off')
  } catch {
    /* not remembered */
  }
  emit()
}

/** The 3D scene could not start at all (no WebGL): use the flat table. */
export function fallbackLite(): void {
  if (lite) return
  lite = true
  why = 'no-gpu'
  emit()
}

// Frame watchdog: the 3D scene reports every frame. If the first couple of seconds of
// real rendering average under ~15 fps, the machine cannot carry it — fall back.
let frames = 0
let total = 0
let judged = false
export function reportFrame(ms: number): void {
  if (judged || lite || why === 'user') return
  if (document.hidden) return
  frames++
  if (frames <= 10) return // warm-up: shader compiles, first uploads
  total += ms
  if (frames >= 55) {
    judged = true
    if (total / (frames - 10) > 66) {
      lite = true
      why = 'slow'
      emit()
    }
  }
}

export function useLite(): boolean {
  return useSyncExternalStore(
    (cb) => { listeners.add(cb); return () => listeners.delete(cb) },
    () => lite,
    () => false,
  )
}
