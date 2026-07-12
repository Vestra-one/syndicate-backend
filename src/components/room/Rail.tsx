import { useEffect, useState } from 'react'
import { useWallet } from '@solana/wallet-adapter-react'
import { useWalletModal } from '@solana/wallet-adapter-react-ui'
import { useGameStore } from '@/store/gameStore'
import { formatChips, formatSigned } from '@/lib/format'
import { hostAlias } from '@/lib/seats'
import { personaEmblem } from '@/components/hud/Seats'
import type { LeaderboardPeriod } from '@/store/gameStore'

function PersonaAvatar({ alias, large }: { alias: string; large?: boolean }) {
  const emblem = personaEmblem(alias)
  return (
    <span className={`av ${large ? 'av--lg' : ''}`} aria-hidden="true">
      {typeof emblem === 'string' ? emblem : <svg viewBox="0 0 32 32" style={{ width: '70%', height: '70%' }}>{emblem}</svg>}
    </span>
  )
}

function short(wallet: string): string {
  return `${wallet.slice(0, 4)}…${wallet.slice(-4)}`
}

export function ProfilePanel() {
  const walletAddress = useGameStore((s) => s.walletAddress)
  const chipBalance = useGameStore((s) => s.chipBalance)
  const profile = useGameStore((s) => s.profile)
  const loadProfile = useGameStore((s) => s.loadProfile)
  const saveHandle = useGameStore((s) => s.saveHandle)
  const { connected } = useWallet()
  const { setVisible } = useWalletModal()

  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void loadProfile()
  }, [walletAddress, loadProfile])

  if (!connected || !walletAddress) {
    return (
      <div className="rail-panel">
        <div className="panel-eyebrow"><span className="eyebrow">your seat at the house</span></div>
        <p style={{ fontSize: 12.5, color: 'var(--text-dim)', margin: '0 0 12px' }}>
          Connect your wallet to see your chips, stats, and rank.
        </p>
        <button className="btn-gold" style={{ width: '100%' }} type="button" onClick={() => setVisible(true)}>
          Connect wallet
        </button>
      </div>
    )
  }

  const alias = profile?.handle ?? hostAlias(walletAddress)
  const netChips = profile?.stats.netChips ?? 0n
  const netUp = netChips >= 0n

  const startEdit = () => { setDraft(profile?.handle ?? ''); setEditing(true); setError(null) }
  const commit = async () => {
    const handle = draft.trim()
    if (handle.length < 3) { setError('At least 3 characters'); return }
    setSaving(true)
    setError(null)
    try {
      await saveHandle(handle)
      setEditing(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save — try a different handle.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="rail-panel">
      <div className="panel-eyebrow"><span className="eyebrow">your seat at the house</span></div>
      <div className="me">
        <PersonaAvatar alias={alias} large />
        <div className="who">
          {editing ? (
            <div className="me-handle-edit">
              <input
                className="me-handle-input"
                value={draft}
                maxLength={20}
                autoFocus
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') void commit(); if (e.key === 'Escape') setEditing(false) }}
              />
              <button className="me-handle-btn" type="button" disabled={saving} onClick={() => void commit()}>✓</button>
              <button className="me-handle-btn" type="button" onClick={() => setEditing(false)}>✕</button>
            </div>
          ) : (
            <b>
              {alias}{' '}
              <button className="me-handle-btn" type="button" onClick={startEdit} aria-label="Edit handle">✎</button>
            </b>
          )}
          <span>{short(walletAddress)}</span>
          {error && <div style={{ color: 'var(--down)', fontSize: 11, marginTop: 4 }}>{error}</div>}
        </div>
        <div className="me-bal">
          <b>{chipBalance != null ? formatChips(chipBalance) : '—'}</b>
          <span>usdc chips</span>
        </div>
      </div>
      <div className="me-stats">
        <div className="me-stat"><b>{profile?.stats.tablesPlayed ?? 0}</b><span>tables</span></div>
        <div className="me-stat"><b>{profile?.stats.potsWon ?? 0}</b><span>pots won</span></div>
        <div className="me-stat"><b className={netUp ? 'up' : 'down'}>{formatSigned(Number(netChips) / 1e6)}</b><span>net usdc</span></div>
        <div className="me-stat"><b>{profile?.stats.bestPot != null ? formatChips(profile.stats.bestPot) : '—'}</b><span>best pot</span></div>
      </div>
    </div>
  )
}

export function LeaderboardPanel() {
  const walletAddress = useGameStore((s) => s.walletAddress)
  const leaderboard = useGameStore((s) => s.leaderboard)
  const period = useGameStore((s) => s.leaderboardPeriod)
  const loadLeaderboard = useGameStore((s) => s.loadLeaderboard)

  useEffect(() => {
    void loadLeaderboard(period)
  }, [period, loadLeaderboard])

  const entries = leaderboard?.entries ?? []
  const yourEntry = entries.find((e) => e.wallet === walletAddress)
  const setPeriod = (p: LeaderboardPeriod) => void loadLeaderboard(p)

  return (
    <div className="rail-panel" id="board">
      <div className="panel-eyebrow">
        <span className="eyebrow">the board · top winners</span>
        <div className="lb-tabs" role="group" aria-label="Leaderboard period">
          <button className={`lb-tab ${period === 'day' ? 'on' : ''}`} type="button" onClick={() => setPeriod('day')}>Tonight</button>
          <button className={`lb-tab ${period === 'all' ? 'on' : ''}`} type="button" onClick={() => setPeriod('all')}>All time</button>
        </div>
      </div>
      {entries.length === 0 ? (
        <div className="lb-empty">No settled hands yet {period === 'day' ? 'tonight' : ''} — the board fills in as tables settle.</div>
      ) : (
        entries.slice(0, 8).map((e) => {
          const alias = e.handle ?? hostAlias(e.wallet)
          const up = e.net_chips >= 0
          return (
            <div className="lb-row" key={e.wallet}>
              <span className={`lb-rank ${e.rank > 3 ? 'low' : ''}`}>{e.rank}</span>
              <PersonaAvatar alias={alias} />
              <div className="who"><b>{alias}</b><span>{short(e.wallet)}</span></div>
              <span className={`lb-win ${up ? '' : 'down'}`}>{formatSigned(e.net_chips / 1e6)}</span>
            </div>
          )
        })
      )}
      {yourEntry && (
        <div className="lb-you">
          <span>you · rank #{yourEntry.rank}</span>
          <b>{formatSigned(yourEntry.net_chips / 1e6)} {period === 'day' ? 'tonight' : ''}</b>
        </div>
      )}
    </div>
  )
}

const STEPS = [
  { label: 'Buy in.', desc: 'Take a seat with USDC — that stake is your ticket to the pot.' },
  { label: 'Seal your call.', desc: 'Commit a secret price prediction. No one sees it until reveal.' },
  { label: 'Outlast the table.', desc: 'Fold, call, raise through the rounds as the chart moves.' },
  { label: 'Closest takes pot.', desc: 'When the price prints, the nearest surviving call wins it all.' },
]

export function HowPanel() {
  return (
    <div className="rail-panel">
      <div className="panel-eyebrow"><span className="eyebrow">how a hand works</span></div>
      {STEPS.map((s, i) => (
        <div className="how-step" key={s.label}>
          <i>{i + 1}</i>
          <p><b>{s.label}</b> {s.desc}</p>
        </div>
      ))}
    </div>
  )
}
