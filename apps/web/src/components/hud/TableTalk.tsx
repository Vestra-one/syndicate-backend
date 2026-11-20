import { useState } from 'react'
import { useGameStore } from '@/store/gameStore'
import { EMOTES, emoteLabel } from '@/lib/emotes'
import { seatAlias } from '@/lib/seats'
import { useNow } from '@/lib/useNow'
import { levelOf, readStats } from '@/lib/sessionStats'

/**
 * Table talk: the last few reactions from the table, and — for a seated player — the row
 * of reactions to send, plus a box to type a short line of your own.
 */
export function TableTalk() {
  const talk = useGameStore((s) => s.talk)
  const yourSeat = useGameStore((s) => s.match?.yourSeat)
  const phase = useGameStore((s) => s.match?.phase)
  const sendEmote = useGameStore((s) => s.sendEmote)
  const now = useNow(1000)
  const wallet = useGameStore((s) => s.walletAddress)
  const level = levelOf(readStats(wallet).fibs ?? 0).level
  const recent = talk.filter((t) => now - t.at < (t.emote.startsWith('say:') ? 12000 : 6000)).slice(-4)
  const [text, setText] = useState('')
  const say = () => { const t = [...text].map((c) => (c < ' ' ? ' ' : c)).join('').trim().slice(0, 80); if (t) void sendEmote(`say:${t}`); setText('') }
  const seated = useGameStore((s) => s.seated)
  const canTalk = (yourSeat != null || seated) && (phase === 'SEALING' || phase === 'LIVE')
  if (!canTalk && recent.length === 0) return null
  return (
    <div className="table-talk">
      <div className="table-talk-lines" aria-live="polite">
        {recent.map((t) => (
          <div key={`${t.seat}-${t.at}`} className={`table-talk-line ${t.seat === yourSeat ? 'table-talk-line--you' : ''}`}>
            <b>{seatAlias(t.seat, yourSeat)}</b> {emoteLabel(t.emote)}
          </div>
        ))}
      </div>
      {canTalk && (
        <div className="table-talk-bar">
          {EMOTES.map((e) => {
            const locked = level < e.level
            // Reactions not earned yet stay out of the way; they appear the moment you level up.
            if (locked) return null
            return (
              <button
                key={e.id}
                type="button"
                className={`table-talk-btn ${locked ? 'table-talk-btn--locked' : ''}`}
                disabled={locked}
                title={locked ? `Unlocks at level ${e.level} — earn Fibs by playing` : undefined}
                onClick={() => void sendEmote(e.id)}
              >
                {locked ? `🔒 Lv ${e.level}` : e.label}
              </button>
            )
          })}
          <form className="table-talk-say" onSubmit={(ev) => { ev.preventDefault(); say() }}>
            <input
              className="table-talk-input"
              value={text}
              maxLength={80}
              placeholder="Say something…"
              aria-label="Say something to the table"
              onChange={(ev) => setText(ev.target.value)}
            />
          </form>
        </div>
      )}
    </div>
  )
}
