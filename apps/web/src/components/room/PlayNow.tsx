import { useState } from 'react'
import { useMemo } from 'react'
import { useWallet } from '@solana/wallet-adapter-react'
import { useWalletModal } from '@solana/wallet-adapter-react-ui'
import { useGameStore } from '@/store/gameStore'
import { formatChips } from '@/lib/format'
import { displayName, hostAlias } from '@/lib/seats'
import { isHouseBot, isScheduledTable } from '@/lib/houseBots'
import { guestAllowed, startGuest } from '@/lib/guestWallet'
import type { UpcomingGame } from '@/lib/protocol'
import { Coin, SeatPips, AvatarStack, FillRing } from './bits'
import { useNow } from '@/lib/useNow'

function OpenCard({ game, invited, onJoin: join }: { game: UpcomingGame; invited: boolean; onJoin: () => void }) {
  // A table we already paid into is ours to return to, not to "join" again.
  const mine = useGameStore((s) => s.mySeats.includes(game.matchId))
  const back = useGameStore((s) => s.returnToSeat)
  const onJoin = mine ? () => void back(game.matchId) : join
  const now = useNow(1000)
  const [base, quote = 'USD'] = game.feed.split('/')
  const total = Math.max(game.maxPlayers, 1)
  const oneLeft = total - game.seated === 1
  const dealtBy = game.creatorWallet ? displayName(game.creatorWallet, game.creatorHandle) : (game.creatorHandle ?? hostAlias(game.matchId))
  return (
    <button className={`card card--open ${invited ? 'card--invited' : ''}`} type="button" onClick={onJoin}>
      <span className="card-top">
        <Coin base={base} />
        <span className="card-mkt">
          <b>{base}<i>/{quote}</i></b>
          <span className="eyebrow">dealt by {dealtBy}</span>
        </span>
        <span className="card-flag">
          {invited && <span className="flag flag--seat">◆ your invite</span>}
          {isScheduledTable(game)
            ? <span className="flag flag--seat" title="Dealt on the clock so players can gather. Bots fill any empty seats.">Scheduled · open to all</span>
            : isHouseBot(game.creatorWallet) && <span className="flag flag--seat" title="House bots sit down with you and the hand starts straight away.">House table · instant</span>}
          {oneLeft && <span className="flag flag--seat">One seat left</span>}
        </span>
      </span>
      <span className="card-hero">
        <span className="amt">
          <span className="eyebrow">buy-in</span>
          <b>{formatChips(game.buyIn)}<em>USDC</em></b>
        </span>
        {game.fillDeadline ? <FillRing deadline={game.fillDeadline} now={now} /> : null}
      </span>
      <span className="card-meta">
        <span className="m"><SeatPips seated={game.seated} total={total} />{game.seated}/{total} seated</span>
        <span className="m"><AvatarStack seedKey={game.matchId} seated={game.seated} /></span>
        <span className="spacer" />
        {game.entryFee != null && <span className="m">+{formatChips(game.entryFee)} entry</span>}
      </span>
      <span className="card-act">
        <span className="hint">deals when it fills · refund if it never does</span>
        <span className="btn-gold">{mine ? 'You are seated — return →' : 'Join →'}</span>
      </span>
    </button>
  )
}

export function PlayNow() {
  const upcomingGames = useGameStore((s) => s.upcomingGames)
  const joinGame = useGameStore((s) => s.joinGame)
  const createGame = useGameStore((s) => s.createGame)
  const pendingInvite = useGameStore((s) => s.pendingInvite)
  const status = useGameStore((s) => s.discoveryStatus)
  const { connected } = useWallet()
  const { setVisible } = useWalletModal()

  const sorted = useMemo(
    () => [...upcomingGames].sort((a, b) => (a.fillDeadline ?? Infinity) - (b.fillDeadline ?? Infinity)),
    [upcomingGames],
  )

  const handleJoin = (matchId: string) => {
    if (!connected) {
      // No wallet? Sit down anyway: a table wallet is made here and filled with test chips.
      // (Players who want their own wallet connect it from the header first.)
      if (guestAllowed()) startGuest(matchId)
      else setVisible(true)
      return
    }
    void joinGame(matchId)
  }
  const handleCreate = () => {
    if (!connected) { setVisible(true); return }
    void createGame()
  }

  return (
    <section className="zone" id="play" aria-labelledby="play-h">
      <div className="zone-head">
        <div className="zone-title">
          <span className="eyebrow"><span className="golddot" />open tables · filling now</span>
          <h2 id="play-h">Play now</h2>
        </div>
        <div className="zone-tools">
          <CodeEntry />
          <button className="btn-gold" type="button" onClick={handleCreate}>Deal a table</button>
        </div>
      </div>
      <div className="engrave" aria-hidden="true" />
      <p className="zone-sub">Tables waiting on traders, closing soonest first. Take a seat before the fill window shuts — or deal your own and let the room come to you.</p>

      <div className="grid">
        <NextTable games={sorted} onJoin={handleJoin} />
        {sorted.length === 0 && status === 'loading'
          ? [0, 1].map((i) => <div key={i} className="card card--skeleton"><span className="skel-bar" style={{ height: 120, margin: 16 }} /></div>)
          : sorted.map((g) => (
            <OpenCard
              key={g.matchId}
              game={g}
              invited={!!pendingInvite && (g.matchId === pendingInvite || g.onchainMatchId === pendingInvite)}
              onJoin={() => handleJoin(g.matchId)}
            />
          ))}
        <button className="card card--deal" type="button" onClick={handleCreate}>
          <span className="deal-seat" aria-hidden="true">+</span>
          <h3>Start a table</h3>
          <p>Set the stakes, take seat 1 — the room joins you before it goes live.</p>
          <span className="btn-gold">Deal a table</span>
        </button>
      </div>
    </section>
  )
}

/** The next scheduled table: when it deals, who is in, and a seat. */
function NextTable({ games, onJoin }: { games: UpcomingGame[]; onJoin: (matchId: string) => void }) {
  const now = useNow(1000)
  const next = games
    .filter((g) => isScheduledTable(g) && (g.fillDeadline ?? 0) > now)
    .sort((a, b) => (a.fillDeadline ?? 0) - (b.fillDeadline ?? 0))[0]
  if (!next) return null
  const left = Math.max(0, Math.floor(((next.fillDeadline ?? 0) - now) / 1000))
  const mmss = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`
  const others = Math.max(0, next.seated - 1)
  const full = next.seated >= next.maxPlayers
  return (
    <div className="next-table">
      <div className="next-table-clock">
        <span className="eyebrow">next table for everyone</span>
        <b className="mono">{mmss}</b>
      </div>
      <div className="next-table-who">
        {others === 0 ? 'Be the first to sit. Bots fill any empty seats, so the hand always runs.' : `${others} ${others === 1 ? 'player is' : 'players are'} in. Sit down and play them when the clock runs out.`}
      </div>
      <button className="btn-gold" type="button" disabled={full || left < 25} onClick={() => onJoin(next.matchId)}>
        {full ? 'Table full' : left < 25 ? 'Dealing…' : 'Take a seat'}
      </button>
    </div>
  )
}



/** Sit at a friends-only table: type the code a friend sent (or accept one from a link). */
function CodeEntry() {
  const pending = useGameStore((s) => s.pendingCode)
  const from = useGameStore((s) => s.inviteFrom)
  const joinByCode = useGameStore((s) => s.joinByCode)
  const [code, setCode] = useState('')
  const value = code || pending || ''
  // A friends-only table is listed nowhere, so the lobby itself has to remember it.
  const myRoom = useGameStore((s) => s.myRoom)
  const returnToSeat = useGameStore((s) => s.returnToSeat)
  if (myRoom) {
    return (
      <span className="code-entry code-entry--invited">
        <span className="code-entry-note">Your friends table <b className="mono">{myRoom.code}</b> is open</span>
        <button className="ghost-btn" type="button" onClick={() => void returnToSeat(myRoom.matchId)}>Return to it</button>
      </span>
    )
  }
  return (
    <form className={`code-entry ${pending ? 'code-entry--invited' : ''}`} onSubmit={(e) => { e.preventDefault(); if (value) void joinByCode(value) }}>
      {pending && <span className="code-entry-note">{from ? `${from} invited you` : 'You were invited'} to a friends table</span>}
      <input
        className="code-entry-input mono"
        value={value}
        maxLength={12}
        placeholder="Table code"
        aria-label="Friends table code"
        onChange={(e) => setCode(e.target.value.toUpperCase())}
      />
      <button className="ghost-btn" type="submit" disabled={!value}>{pending ? 'Take your seat' : 'Join'}</button>
    </form>
  )
}
