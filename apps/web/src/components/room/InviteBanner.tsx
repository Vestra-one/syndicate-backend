import { useEffect, useState } from 'react'
import { useGameStore } from '@/store/gameStore'
import { toEpochMs } from '@/lib/discovery'
import { hostAlias } from '@/lib/seats'
import { api, type MatchDetail } from '@/lib/api'
import { personaEmblem } from '@/components/hud/Seats'
import { useNow } from '@/lib/useNow'
import { mmss } from './bits'
import '@/components/hud/hud.css'

function fmt(amount: number | bigint) {
  return (Number(amount) / 1e6).toLocaleString(undefined, { maximumFractionDigits: 2 })
}

function InviteAvatar({ alias, muted }: { alias: string; muted?: boolean }) {
  const emblem = personaEmblem(alias)
  return (
    <div className={`dash-invite-avatar ${muted ? 'dash-invite-avatar--muted' : ''}`} aria-hidden="true">
      {typeof emblem === 'string'
        ? <span className="dash-invite-mono">{emblem}</span>
        : <svg viewBox="0 0 32 32" className="dash-invite-sigil">{emblem}</svg>}
    </div>
  )
}

/**
 * Surfaces a `?table=…` deep-link invite as an accept prompt (moved verbatim from the
 * old Dashboard — resolves the real table from the discovery lists or a direct fetch,
 * and never auto-joins: taking the seat still needs a user gesture for the wallet).
 */
export function InviteBanner({
  matchId, inviter, connected, onTakeSeat, onDeal, onDismiss,
}: {
  matchId: string
  inviter: string | null
  connected: boolean
  onTakeSeat: (joinId: string) => void
  onDeal: () => void
  onDismiss: () => void
}) {
  const now = useNow(1000)
  const upcoming = useGameStore((s) => s.upcomingGames)
  const active = useGameStore((s) => s.activeGames)

  const listed = upcoming.find((g) => g.matchId === matchId || g.onchainMatchId === matchId)
  const isLive = active.some((g) => g.matchId === matchId || g.onchainMatchId === matchId)
  const inList = !!listed || isLive

  const [detail, setDetail] = useState<MatchDetail | null>(null)
  const [detailFailed, setDetailFailed] = useState(false)
  useEffect(() => {
    if (inList) return
    let alive = true
    api.getMatch(matchId)
      .then((d) => { if (alive) setDetail(d) })
      .catch(() => { if (alive) setDetailFailed(true) })
    return () => { alive = false }
  }, [matchId, inList])

  const name = inviter ?? hostAlias(matchId)
  const detailDeadline = detail?.timing.fill_deadline != null ? toEpochMs(detail.timing.fill_deadline) : undefined

  const src = listed
    ? { feed: listed.feed, buyIn: listed.buyIn, seated: listed.seated as number | null, max: listed.maxPlayers, deadline: listed.fillDeadline }
    : detail
      ? { feed: detail.feed, buyIn: detail.params.buy_in, seated: null as number | null, max: detail.params.max_players, deadline: detailDeadline }
      : null

  let mode: 'loading' | 'open' | 'closed'
  if (listed) {
    mode = listed.seated < listed.maxPlayers && !(listed.fillDeadline != null && listed.fillDeadline <= now) ? 'open' : 'closed'
  } else if (isLive || detailFailed) {
    mode = 'closed'
  } else if (detail) {
    mode = detail.phase.toUpperCase() === 'FILLING' && !(detailDeadline != null && detailDeadline <= now) ? 'open' : 'closed'
  } else {
    mode = 'loading'
  }

  // An invite is to a PERSON's table, not to one hand: when that hand is over, follow the
  // host to the table they dealt next ("Deal this table again"), and wait for it if they
  // have not dealt it yet. One link keeps working for the whole evening.
  const hostWallet = listed?.creatorWallet
    ?? active.find((g) => g.matchId === matchId || g.onchainMatchId === matchId)?.creatorWallet
    ?? detail?.creator_wallet
    ?? null
  const successor = mode === 'closed' && hostWallet
    ? upcoming
        .filter((g) => g.creatorWallet === hostWallet && g.matchId !== matchId && g.seated < g.maxPlayers && !(g.fillDeadline != null && g.fillDeadline <= now))
        .sort((a, b) => (b.fillDeadline ?? 0) - (a.fillDeadline ?? 0))[0]
    : undefined
  if (successor) {
    return <InviteBanner matchId={successor.matchId} inviter={inviter} connected={connected} onTakeSeat={onTakeSeat} onDeal={onDeal} onDismiss={onDismiss} />
  }

  if (mode === 'loading') {
    return (
      <div className="dash-invite dash-invite--loading">
        <InviteAvatar alias={name} />
        <div className="dash-invite-body">
          <div className="eyebrow"><strong>{name}</strong> invited you</div>
          <div className="dash-invite-finding">Finding the table<span className="dash-invite-dots"><i /><i /><i /></span></div>
        </div>
        <div className="dash-invite-actions">
          <button className="dash-ghost-btn" onClick={onDismiss}>Dismiss</button>
        </div>
      </div>
    )
  }

  if (mode === 'closed') {
    const started = isLive || (!!detail && detail.phase.toUpperCase() !== 'FILLING')
    return (
      <div className="dash-invite dash-invite--closed">
        <InviteAvatar alias={name} muted />
        <div className="dash-invite-body">
          <div className="eyebrow">{hostWallet ? 'hand in progress' : 'invite expired'}</div>
          <div className="dash-invite-title">{started ? `${name}’s hand is already under way` : `${name}’s table has closed`}</div>
          <div className="dash-invite-sub">{hostWallet ? `Stay here — the moment ${name} deals the next hand, your seat appears.` : 'Deal your own table?'}</div>
        </div>
        <div className="dash-invite-actions">
          <button className="play-now-btn" onClick={onDeal}>Deal a table</button>
          <button className="dash-ghost-btn" onClick={onDismiss}>Dismiss</button>
        </div>
      </div>
    )
  }

  const s = src!
  const countdown = mmss(s.deadline, now)
  const secsLeft = s.deadline != null ? Math.round((s.deadline - now) / 1000) : null
  const cdClass = secsLeft != null && secsLeft < 15
    ? 'dash-invite-countdown dash-invite-countdown--crit'
    : secsLeft != null && secsLeft < 60
      ? 'dash-invite-countdown dash-invite-countdown--warn'
      : 'dash-invite-countdown'
  const joinId = listed?.matchId ?? detail?.match_id ?? matchId
  const [base] = s.feed.split('/')

  return (
    <div className="dash-invite">
      <InviteAvatar alias={name} />
      <div className="dash-invite-body">
        <div className="eyebrow"><strong>{name}</strong> invited you</div>
        <div className="dash-invite-meta">
          <span className={`dash-invite-feed feed-${base.toLowerCase()}`}>{s.feed}</span>
          <span className="dash-invite-dot">·</span>
          <span><span className="mono">{fmt(s.buyIn)}</span> USDC buy-in</span>
          <span className="dash-invite-dot">·</span>
          <span>{s.seated != null ? `${s.seated}/${s.max} seated` : `${s.max} seats`}</span>
          {countdown && <>
            <span className="dash-invite-dot">·</span>
            <span className={cdClass}>closes in {countdown}</span>
          </>}
        </div>
      </div>
      <div className="dash-invite-actions">
        <button className="play-now-btn" onClick={() => onTakeSeat(joinId)}>
          {connected ? 'Take your seat' : 'Connect & take seat'}
        </button>
        <button className="dash-ghost-btn" onClick={onDismiss}>Dismiss</button>
      </div>
    </div>
  )
}
