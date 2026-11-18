/**
 * Table sounds — short synthesized cues (no audio files): your turn, a bet landing, the
 * seal, the last seconds, and the result. Honours the "Sound" switch (`st-sound`).
 */
type Cue = 'turn' | 'chip' | 'seal' | 'tick' | 'win' | 'lose'

let ctx: AudioContext | null = null

function enabled(): boolean {
  try {
    return localStorage.getItem('st-sound') !== 'off'
  } catch {
    return true
  }
}

function audio(): AudioContext | null {
  if (typeof window === 'undefined') return null
  try {
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!Ctor) return null
    ctx ??= new Ctor()
    if (ctx.state === 'suspended') void ctx.resume()
    return ctx
  } catch {
    return null
  }
}

/** One soft note: frequency (Hz), start offset and length (s), peak gain. */
function note(ac: AudioContext, freq: number, at: number, len: number, gain: number, type: OscillatorType = 'sine') {
  const osc = ac.createOscillator()
  const amp = ac.createGain()
  osc.type = type
  osc.frequency.value = freq
  const t = ac.currentTime + at
  amp.gain.setValueAtTime(0.0001, t)
  amp.gain.exponentialRampToValueAtTime(gain, t + 0.012)
  amp.gain.exponentialRampToValueAtTime(0.0001, t + len)
  osc.connect(amp).connect(ac.destination)
  osc.start(t)
  osc.stop(t + len + 0.02)
}

const SCORES: Record<Cue, Array<[number, number, number, number, OscillatorType?]>> = {
  turn: [[660, 0, 0.16, 0.09], [880, 0.12, 0.22, 0.09]],
  chip: [[1900, 0, 0.05, 0.05, 'triangle'], [2400, 0.035, 0.06, 0.04, 'triangle']],
  seal: [[392, 0, 0.18, 0.08], [523, 0.1, 0.3, 0.08]],
  tick: [[1000, 0, 0.04, 0.035, 'square']],
  win: [[523, 0, 0.18, 0.1], [659, 0.13, 0.18, 0.1], [784, 0.26, 0.2, 0.1], [1047, 0.4, 0.5, 0.11]],
  lose: [[330, 0, 0.25, 0.08], [262, 0.2, 0.45, 0.08]],
}

export function playCue(cue: Cue): void {
  if (!enabled()) return
  const ac = audio()
  if (!ac) return
  for (const [freq, at, len, gain, type] of SCORES[cue]) note(ac, freq, at, len, gain, type)
}
