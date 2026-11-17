import { useWallet } from '@solana/wallet-adapter-react'
import { useWalletModal } from '@solana/wallet-adapter-react-ui'
import { useGameStore } from '@/store/gameStore'
import { formatChips, formatChipsPrecise } from '@/lib/format'
import { hostAlias } from '@/lib/seats'
import { PAST_FILLING_PHASES } from '@/lib/protocol'
import { SeatPips, mmss } from './bits'
import { useNow } from '@/lib/useNow'

/**
 * The join sheet — bridges "Play Now" and a seated player, as an in-page modal over
 * the Room lobby (not a full-screen table takeover). Deposit terms are always shown
 * in full before any wallet signature.
 */
export function JoinSheet({ matchId }: { matchId: string }) {
  const now = useNow(1000)
  const terms = useGameStore((s) => s.terms)
  const match = useGameStore((s) => s.match)
  const lobbySeated = useGameStore((s) => s.lobbySeated)
  const playResolving = useGameStore((s) => s.playResolving)
  const playError = useGameStore((s) => s.playError)
  const fillDeadline = useGameStore((s) => s.fillDeadline)
  const upcomingGames = useGameStore((s) => s.upcomingGames)
  const join = useGameStore((s) => s.joinTable)
  const close = useGameStore((s) => s.closeRoomModal)
  const txProgress = useGameStore((s) => s.txProgress)
  const { connected } = useWallet()
  const { setVisible } = useWalletModal()

  const listed = upcomingGames.find((g) => g.matchId === matchId)
  const dealtBy = listed?.creatorHandle ?? hostAlias(matchId)
  const busy = !!txProgress

  if (playResolving) {
    return (
      <Shell onClose={busy ? undefined : close}>
        <div className="sheet-spinner"><span className="sheet-spinner-dot" /></div>
      </Shell>
    )
  }

  if (playError && !terms) {
    return (
      <Shell onClose={close}>
        <div className="sheet-error">
          <div className="sheet-error-icon">✗</div>
          <div className="sheet-error-msg">{playError}</div>
          <button className="btn-gold" type="button" onClick={close}>Back to tables</button>
        </div>
      </Shell>
    )
  }

  if (!terms) return null
  if (match && PAST_FILLING_PHASES.includes(match.phase)) return null

  const filled = Math.max(match?.seats.length ?? 0, lobbySeated ?? 0)
  const total = terms.buyIn + terms.entryFee
  const countdown = mmss(fillDeadline, now)

  const handleCommit = () => {
    if (!connected) { setVisible(true); return }
    void join()
  }

  return (
    <Shell onClose={busy ? undefined : close}>
      <div className="sheet-head">
        <div className="sheet-title">
          <span className="eyebrow">join table · {terms.priceFeedId.toLowerCase()}</span>
          <h3>Take your seat.</h3>
        </div>
        {!busy && <button className="sheet-x" type="button" onClick={close} aria-label="Close">✕</button>}
      </div>
      <p className="sheet-sub">Dealt by {dealtBy}{countdown ? ` · closes in ${countdown}` : ''}</p>

      <div className="seatline">
        <SeatPips seated={filled} total={terms.maxPlayers} youAt={filled + 1} />
        <p><b>{filled} of {terms.maxPlayers} seated</b> — you'll take seat {filled + 1}. Table deals when it fills.</p>
      </div>

      <div className="terms">
        <div className="term"><span>buy-in</span><b>{formatChips(terms.buyIn)} <i>USDC</i></b></div>
        <div className="term"><span>entry fee</span><b>{formatChips(terms.entryFee)} <i>USDC</i></b></div>
        {(terms.ante ?? 0n) > 0n && (
          <div className="term" title="Every seat puts this into the pot when the hand starts. Fold everyone out and the antes are yours."><span>ante</span><b>{formatChipsPrecise(terms.ante ?? 0n)} each</b></div>
        )}
        <div className="term"><span>blinds</span><b>{formatChipsPrecise(terms.smallBlind)} / {formatChipsPrecise(terms.bigBlind)}</b></div>
        <div className="term"><span>rake</span><b>{(terms.rakeBps / 100).toFixed(2)}% <i>cap {formatChipsPrecise(terms.rakeCap)}</i></b></div>
        <div className="term"><span>rounds</span><b>{terms.roundCount} × {terms.roundDurationsSec[0] ?? 0}s</b></div>
        <div className="term"><span>action timer</span><b>{terms.actionTimerSec}s{terms.timeBankSec > 0 && <i> +{terms.timeBankSec}s bank</i>}</b></div>
      </div>

      <div className="total">
        <span className="part">{formatChips(terms.buyIn)}<em>buy-in</em></span>
        <span className="op">+</span>
        <span className="part">{formatChips(terms.entryFee)}<em>entry</em></span>
        <span className="op">=</span>
        <span className="sum">{formatChips(total)} <em>USDC</em></span>
      </div>

      {playError && <div className="sheet-inline-error">{playError}</div>}

      <button className="btn-gold" type="button" disabled={busy} onClick={handleCommit}>
        {connected ? `Take your seat · deposit ${formatChips(total)} USDC` : 'Connect wallet to continue'}
      </button>
      <p className="sheet-fine">entry refunded if the table never fills</p>
      {!busy && <button className="sheet-back" type="button" onClick={close}>← Back to tables</button>}
    </Shell>
  )
}

function Shell({ children, onClose }: { children: React.ReactNode; onClose?: () => void }) {
  return (
    <div
      className="veil"
      role="dialog"
      aria-modal="true"
      onMouseDown={(e) => { if (onClose && e.target === e.currentTarget) onClose() }}
    >
      <div className="sheet">{children}</div>
    </div>
  )
}
