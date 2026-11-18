import { useGameStore } from '@/store/gameStore'
import { EMOTES, emoteLabel } from '@/lib/emotes'
import { seatAlias } from '@/lib/seats'
import { useNow } from '@/lib/useNow'

/**
 * Table talk: the last few reactions from the table, and — for a seated player — the row
 * of reactions to send. Fixed phrases only.
 */
export function TableTalk() {
  const talk = useGameStore((s) => s.talk)
  const yourSeat = useGameStore((s) => s.match?.yourSeat)
  const phase = useGameStore((s) => s.match?.phase)
  const sendEmote = useGameStore((s) => s.sendEmote)
  const now = useNow(1000)
  const recent = talk.filter((t) => now - t.at < 6000).slice(-3)
  const canTalk = yourSeat != null && (phase === 'SEALING' || phase === 'LIVE')
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
          {EMOTES.map((e) => (
            <button key={e.id} type="button" className="table-talk-btn" onClick={() => void sendEmote(e.id)}>
              {e.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
