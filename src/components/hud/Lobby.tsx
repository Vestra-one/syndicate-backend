import { useWallet } from '@solana/wallet-adapter-react'
import { useWalletModal } from '@solana/wallet-adapter-react-ui'
import { useGameStore } from '@/store/gameStore'

/**
 * The lobby (§4) — the bridge between "Play Now" and a seated player.
 *
 * Resolving → a calm "finding you a table" state while we check the lobby.
 * Resolved   → the table terms + the explicit commit:
 *                join   → deposit into an existing open table
 *                create → open a new table on-chain and seat yourself
 *
 * The full cost is always shown BEFORE any wallet signature (§10.1).
 */
export function Lobby() {
  const terms = useGameStore((s) => s.terms)
  const match = useGameStore((s) => s.match)
  const seated = useGameStore((s) => s.seated)
  const playMode = useGameStore((s) => s.playMode)
  const playResolving = useGameStore((s) => s.playResolving)
  const playError = useGameStore((s) => s.playError)
  const lastTxSig = useGameStore((s) => s.lastTxSig)
  const join = useGameStore((s) => s.joinTable)
  const create = useGameStore((s) => s.createTable)

  const { connected, connecting } = useWallet()
  const { setVisible } = useWalletModal()

  // Resolving: connecting wallet + gateway — brief spinner
  if (playResolving) {
    return (
      <div className="lobby">
        <div className="lobby-card panel lobby-card--resolving">
          <div className="lobby-spinner" aria-hidden="true" />
          <div className="lobby-resolving-title">Getting ready…</div>
        </div>
      </div>
    )
  }

  // Game creation failed — show error card so the user isn't left staring at a blank table.
  if (playError && !playMode && !seated) {
    return (
      <div className="lobby">
        <div className="lobby-card panel lobby-card--error">
          <div className="lobby-error-icon" aria-hidden="true">✗</div>
          <div className="lobby-error-title">Couldn't create table</div>
          <div className="lobby-error-msg">{playError}</div>
          <button
            className="seal-btn lobby-error-dismiss"
            onClick={() => useGameStore.setState({ playError: null })}
          >
            Dismiss
          </button>
        </div>
      </div>
    )
  }

  // Nothing to commit to yet, or already seated → hide.
  if (!terms || seated || !playMode) return null
  // If we have a live match that's past filling, the lobby is done.
  if (match && match.phase !== 'FILLING') return null

  const filled = match?.seats.length ?? 0
  const total = terms.buyIn + terms.entryFee
  const isCreate = playMode === 'create'
  const walletReady = connected

  const handleCommit = () => {
    if (!walletReady) {
      setVisible(true)
      return
    }
    if (isCreate) void create()
    else void join()
  }

  // Display amounts in whole tokens (USDC has 6 decimals; price decimals differ).
  const fmt = (base: number) => (base / 1e6).toLocaleString(undefined, { maximumFractionDigits: 6 })

  return (
    <div className="lobby">
      <div className="lobby-card panel">
        <div className="lobby-head">
          <div>
            <div className="eyebrow">
              {isCreate ? 'create table' : 'join table'} · {terms.priceFeedId}
            </div>
            <div className="lobby-feed">
              {isCreate
                ? "You'll be first in — others can join before it goes live."
                : terms.tableId}
            </div>
          </div>
          <div className="lobby-players">
            <span className="lobby-players-count mono">
              {filled}/{terms.maxPlayers}
            </span>
            <span className="eyebrow">seated</span>
          </div>
        </div>

        <div className="lobby-grid">
          <Term label="buy-in" value={`${fmt(terms.buyIn)} ${terms.chipsToken}`} />
          <Term label="entry fee" value={`${fmt(terms.entryFee)} ${terms.chipsToken}`} />
          <Term label="blinds" value={`${fmt(terms.smallBlind)} / ${fmt(terms.bigBlind)}`} />
          <Term label="rake" value={`${terms.rakeBps / 100}% · cap ${fmt(terms.rakeCap)}`} />
          <Term label="rounds" value={`${terms.roundCount} betting rounds`} />
          <Term
            label="action timer"
            value={`${terms.actionTimerSec}s + ${terms.timeBankSec}s bank`}
          />
        </div>

        {/* Cost disclosure — always shown before any commitment (§10.1) */}
        <div className="lobby-cost">
          <span className="eyebrow">total to take your seat</span>
          <span className="lobby-cost-amount mono">
            {fmt(total)} {terms.chipsToken}
          </span>
        </div>

        {walletReady ? (
          <>
            <button className="seal-btn lobby-join" onClick={handleCommit}>
              {isCreate
                ? `Create table · deposit ${fmt(total)} ${terms.chipsToken}`
                : `Take your seat · deposit ${fmt(total)} ${terms.chipsToken}`}
            </button>
            <p className="lobby-note eyebrow">
              {isCreate
                ? "You'll be the host and first seat. Entry fee is refunded if the table voids."
                : 'Entry fee is refunded if the table voids or you leave before it goes live.'}
            </p>
          </>
        ) : (
          <>
            <button
              className="seal-btn lobby-join lobby-connect"
              onClick={handleCommit}
              disabled={connecting}
            >
              {connecting ? 'Connecting wallet…' : '◎ Connect wallet to continue'}
            </button>
            <p className="lobby-note eyebrow">
              You'll approve one transaction of {fmt(total)} {terms.chipsToken} after connecting.
            </p>
          </>
        )}
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
