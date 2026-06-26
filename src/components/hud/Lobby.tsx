import { useGameStore } from '@/store/gameStore'

/**
 * The lobby (§4): the table terms a player sees before committing, and the
 * explicit deposit that takes their seat. Surfaces the full financial picture
 * up front (§10.1 — never surprise the user with a cost). Shown during FILLING
 * until the player takes their seat; once deposited, the seat is granted on
 * finality and the match proceeds to sealing.
 */
export function Lobby() {
  const terms = useGameStore((s) => s.terms)
  const match = useGameStore((s) => s.match)
  const seated = useGameStore((s) => s.seated)
  const join = useGameStore((s) => s.joinTable)

  // Only while we can still take a seat: terms known, in FILLING, not yet seated.
  if (!terms || seated) return null
  if (match && match.phase !== 'FILLING') return null

  const filled = match?.seats.length ?? 0
  const total = terms.buyIn + terms.entryFee

  return (
    <div className="lobby">
      <div className="lobby-card panel">
        <div className="lobby-head">
          <div>
            <div className="eyebrow">join table · {terms.tableId}</div>
            <div className="lobby-feed">{terms.priceFeedId}</div>
          </div>
          <div className="lobby-players">
            <span className="lobby-players-count mono">
              {filled}/{terms.maxPlayers}
            </span>
            <span className="eyebrow">seated</span>
          </div>
        </div>

        <div className="lobby-grid">
          <Term label="buy-in" value={`${terms.buyIn} ${terms.chipsToken}`} />
          <Term label="entry fee" value={`${terms.entryFee} ${terms.chipsToken}`} />
          <Term label="blinds" value={`${terms.smallBlind} / ${terms.bigBlind}`} />
          <Term label="rake" value={`${terms.rakeBps / 100}% · cap ${terms.rakeCap}`} />
          <Term label="rounds" value={`${terms.roundCount} betting rounds`} />
          <Term label="action timer" value={`${terms.actionTimerSec}s + ${terms.timeBankSec}s bank`} />
        </div>

        <div className="lobby-cost">
          <span className="eyebrow">total to take your seat</span>
          <span className="lobby-cost-amount mono">
            {total} {terms.chipsToken}
          </span>
        </div>

        <button className="seal-btn lobby-join" onClick={() => join()}>
          Take your seat · deposit {total} {terms.chipsToken}
        </button>
        <p className="lobby-note eyebrow">
          Entry fee is refunded if the table voids or you leave before it goes live.
        </p>
      </div>
    </div>
  )
}

function Term({ label, value }: { label: string; value: string }) {
  return (
    <div className="lobby-term">
      <span className="eyebrow">{label}</span>
      <span className="lobby-term-value mono">{value}</span>
    </div>
  )
}
