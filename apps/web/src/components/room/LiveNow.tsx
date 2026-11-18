import { useEffect, useMemo, useState } from 'react'
import { useGameStore } from '@/store/gameStore'
import { ratedScore } from '@/lib/discovery'
import { formatChips } from '@/lib/format'
import type { DashboardSortKey, LiveGame } from '@/lib/protocol'
import { Coin, AvatarStack, RoundPips, Sparkline, agoLabel } from './bits'
import { useNow } from '@/lib/useNow'
import { displayName } from '@/lib/seats'

const SORTS: { key: DashboardSortKey; label: string }[] = [
  { key: 'gameTime', label: 'Hot' },
  { key: 'potSize', label: 'Biggest pot' },
  { key: 'newest', label: 'Newest' },
]

function sortGames(games: LiveGame[], key: DashboardSortKey): LiveGame[] {
  const g = [...games]
  switch (key) {
    case 'potSize': return g.sort((a, b) => Number(b.potSize - a.potSize))
    case 'buyIn': return g.sort((a, b) => Number(a.buyIn - b.buyIn))
    case 'newest': return g.sort((a, b) => b.startedAt - a.startedAt)
    case 'gameTime': default: return g.sort((a, b) => ratedScore(b) - ratedScore(a))
  }
}

const EYE = (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.3}>
    <path d="M1.5 8s2.4-4.2 6.5-4.2S14.5 8 14.5 8s-2.4 4.2-6.5 4.2S1.5 8 1.5 8z" />
    <circle cx="8" cy="8" r="1.9" />
  </svg>
)
const CLK = (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.3}>
    <circle cx="8" cy="8" r="6.2" />
    <path d="M8 4.6V8l2.3 1.6" />
  </svg>
)

const CardsIcon = (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.4}>
    <rect x="1.5" y="1.5" width="5.4" height="5.4" rx="1" />
    <rect x="9.1" y="1.5" width="5.4" height="5.4" rx="1" />
    <rect x="1.5" y="9.1" width="5.4" height="5.4" rx="1" />
    <rect x="9.1" y="9.1" width="5.4" height="5.4" rx="1" />
  </svg>
)
const RowsIcon = (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.4}>
    <path d="M1.5 3.5h13M1.5 8h13M1.5 12.5h13" />
  </svg>
)

function LiveCard({ game, onWatch: watch }: { game: LiveGame; onWatch: () => void }) {
  // Our own hand is not something to "watch": say we are seated and take us back to it.
  const mine = useGameStore((s) => s.mySeats.includes(game.matchId))
  const back = useGameStore((s) => s.returnToSeat)
  const onWatch = mine ? () => void back(game.matchId) : watch
  const now = useNow(1000)
  const [base, quote = 'USD'] = game.feed.split('/')
  const roundCount = game.roundCount ?? 4
  const round = game.round ?? 0
  const isFinal = roundCount > 0 && round >= roundCount
  const tint = base.toUpperCase() === 'ETH' ? 'var(--eth)' : base.toUpperCase() === 'SOL' ? 'var(--sol)' : 'var(--gold-bright)'
  return (
    <button className="card card--live" type="button" onClick={onWatch}>
      <span className="card-top">
        <Coin base={base} />
        <span className="card-mkt">
          <b>{base}<i>/{quote}</i></b>
          {(game.creatorHandle || game.creatorWallet) && <span className="eyebrow">dealt by {game.creatorWallet ? displayName(game.creatorWallet, game.creatorHandle) : game.creatorHandle}</span>}
        </span>
        <span className="card-flag">
          <span className="flag flag--live"><span className="livedot" />{mine ? 'You are seated' : 'Live'}</span>
        </span>
      </span>
      <span className="card-hero">
        <span className="amt">
          <span className="eyebrow">pot to play for</span>
          <b>{formatChips(game.potSize)}<em>USDC</em></b>
        </span>
        <Sparkline seed={game.matchId} color={tint} />
      </span>
      <span className="card-meta">
        <span className="m" title="Round">
          <RoundPips round={round} total={roundCount} />
          {isFinal ? <span style={{ color: 'var(--live)' }}>final round</span> : `R${round}/${roundCount}`}
        </span>
        {game.seated != null && game.maxPlayers != null && (
          <span className="m">{game.seated}/{game.maxPlayers}</span>
        )}
        <span className="m">{EYE}{game.spectators}</span>
        <span className="spacer" />
        <span className="m mono">{CLK}{agoLabel(game.startedAt, now)}</span>
      </span>
      <span className="card-act">
        <span className="hint">predictions sealed until reveal</span>
        <span className="go">{mine ? 'Return to your seat →' : 'Watch →'}</span>
      </span>
    </button>
  )
}

function LiveRow({ game, onWatch }: { game: LiveGame; onWatch: () => void }) {
  const now = useNow(1000)
  const [base, quote = 'USD'] = game.feed.split('/')
  const roundCount = game.roundCount ?? 4
  const round = game.round ?? 0
  return (
    <div className="rowline" role="button" tabIndex={0} onClick={onWatch}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onWatch() } }}>
      <span className="mkt"><Coin base={base} sm /><b>{base}<i>/{quote}</i></b></span>
      <span className="pot">{formatChips(game.potSize)}<em>USDC</em></span>
      <span className="dim">R{round}/{roundCount}</span>
      <span className="dim">
        <AvatarStack seedKey={game.matchId} seated={game.seated ?? 0} />
        {game.seated ?? '—'}/{game.maxPlayers ?? '—'}
      </span>
      <span className="dim">{game.spectators}</span>
      <span className="dim mono">{agoLabel(game.startedAt, now)}</span>
      <span className="watch">Watch →</span>
    </div>
  )
}

export function LiveNow() {
  const activeGames = useGameStore((s) => s.activeGames)
  const sort = useGameStore((s) => s.dashboardSort)
  const setSort = useGameStore((s) => s.setDashboardSort)
  const enterTable = useGameStore((s) => s.enterTable)
  const status = useGameStore((s) => s.discoveryStatus)

  const [view, setView] = useState<'cards' | 'rows'>(() => {
    try { return (localStorage.getItem('room.liveView') as 'cards' | 'rows') || 'cards' } catch { return 'cards' }
  })
  useEffect(() => {
    try { localStorage.setItem('room.liveView', view) } catch { /* private mode */ }
  }, [view])

  const sorted = useMemo(() => sortGames(activeGames, sort), [activeGames, sort])
  const onWatch = (matchId: string) => void enterTable(matchId)

  return (
    <section className="zone" id="live" aria-labelledby="live-h">
      <div className="zone-head">
        <div className="zone-title">
          <span className="eyebrow"><span className="livedot" />in progress · watch the felt</span>
          <h2 id="live-h">Live now</h2>
        </div>
        <div className="zone-tools">
          {sorted.length > 0 && SORTS.map((s) => (
            <button key={s.key} type="button" className={`room-chip ${sort === s.key ? 'on' : ''}`} onClick={() => setSort(s.key)}>
              {s.label}
            </button>
          ))}
          <div className="viewtoggle" role="group" aria-label="Live view">
            <button type="button" className={view === 'cards' ? 'on' : ''} aria-label="Card view" title="Cards" onClick={() => setView('cards')}>{CardsIcon}</button>
            <button type="button" className={view === 'rows' ? 'on' : ''} aria-label="Row view" title="Rows" onClick={() => setView('rows')}>{RowsIcon}</button>
          </div>
        </div>
      </div>
      <div className="engrave" aria-hidden="true" />
      <p className="zone-sub">Every hand in play right now. Step down to any table and watch the calls land — predictions stay sealed until the reveal.</p>

      {sorted.length === 0 ? (
        status === 'loading' ? (
          <div className="grid">
            {[0, 1, 2].map((i) => <div key={i} className="card card--skeleton"><span className="skel-bar" style={{ height: 120, margin: 16 }} /></div>)}
          </div>
        ) : (
          <div className="zone-empty">No hands on the felt right now — start one below.</div>
        )
      ) : view === 'cards' ? (
        <div className="grid">
          {sorted.map((g) => <LiveCard key={g.matchId} game={g} onWatch={() => onWatch(g.matchId)} />)}
        </div>
      ) : (
        <div className="rows-wrap">
          <div className="rows">
            <div className="rowline head" aria-hidden="true">
              <span>Table</span><span>Pot</span><span>Round</span><span>Players</span><span>Watching</span><span>Started</span><span></span>
            </div>
            {sorted.map((g) => <LiveRow key={g.matchId} game={g} onWatch={() => onWatch(g.matchId)} />)}
          </div>
        </div>
      )}
    </section>
  )
}
