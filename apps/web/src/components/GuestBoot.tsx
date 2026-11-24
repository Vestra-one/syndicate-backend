import { useEffect, useRef, useState } from 'react'
import { useGameStore } from '@/store/gameStore'
import { guestAddress, peekResumeJoin, takeResumeJoin } from '@/lib/guestWallet'

const BUY_IN_FLOOR = 20_000_000n // two house buy-ins: below this a guest gets a top-up
const FUNDED_KEY = 'st-guest-funded-at'

/**
 * Finishes "Play instantly" after the page reloads into the table wallet. In order: make
 * sure the guest has chips (once — never again on a mere reload), then take them where
 * they were going: the table they clicked, or the open house table, seated, with nothing
 * further to press. While that runs the screen says so instead of showing a bare lobby.
 */
export function GuestBoot() {
  const wallet = useGameStore((s) => s.walletAddress)
  const faucet = useGameStore((s) => s.faucet)
  const balance = useGameStore((s) => s.chipBalance)
  const view = useGameStore((s) => s.view)
  const txError = useGameStore((s) => s.txProgress?.stage === 'error')
  const finding = useGameStore((s) => s.findingTable && s.view === 'discovery')
  const [pending, setPending] = useState<string | null>(() => peekResumeJoin())
  const [step, setStep] = useState('Setting up your table wallet…')
  const funding = useRef(false)
  const routed = useRef(false)
  const isGuest = wallet != null && wallet === guestAddress()

  // 1. Chips. A brand-new guest has no chip account, so the balance reads as empty/unknown;
  //    give the read a moment, then top up if it is short and we have not just done so.
  useEffect(() => {
    if (!isGuest || !faucet || funding.current) return
    const known = balance != null
    if (known && balance >= BUY_IN_FLOOR) return
    const t = setTimeout(() => {
      const s = useGameStore.getState()
      if ((s.chipBalance ?? 0n) >= BUY_IN_FLOOR || funding.current) return
      let last = 0
      try { last = Number(localStorage.getItem(`${FUNDED_KEY}:${wallet}`) ?? 0) } catch { /* ignore */ }
      // A top-up is on its way or was refused by the cooldown: do not ask again on reload.
      if (Date.now() - last < 90_000) return
      funding.current = true
      try { localStorage.setItem(`${FUNDED_KEY}:${wallet}`, String(Date.now())) } catch { /* ignore */ }
      setStep('Filling it with test chips…')
      void s.getTestChips().finally(() => { funding.current = false })
    }, known ? 0 : 2500)
    return () => clearTimeout(t)
  }, [isGuest, faucet, balance, wallet])

  // 2. Take them to the table, once the chips are in.
  useEffect(() => {
    if (!isGuest || !pending || routed.current) return
    if (balance == null || balance < 10_000_000n) return
    routed.current = true
    takeResumeJoin()
    setStep('Taking your seat…')
    const s = useGameStore.getState()
    void (async () => {
      try {
        if (pending === 'house') await s.playHouse({ sit: true })
        // Invited to a friends table: open its join sheet, never a house hand they did not ask for.
        else if (pending.startsWith('code:')) await s.joinByCode(pending.slice(5))
        else {
          await s.joinGame(pending)
          const now = useGameStore.getState()
          if (now.playMode === 'join' && now.terms) await now.joinTable()
        }
      } finally {
        setPending(null)
      }
    })()
  }, [isGuest, pending, balance])

  // Never leave the curtain up: if something went wrong, or it is simply taking too long,
  // show the lobby (which has the error or the table list).
  useEffect(() => {
    if (!pending) return
    const t = setTimeout(() => { takeResumeJoin(); setPending(null) }, 75_000)
    return () => clearTimeout(t)
  }, [pending])
  useEffect(() => {
    if (pending && (view === 'table' || txError)) { takeResumeJoin(); setPending(null) }
  }, [pending, view, txError])

  if (!pending) return finding ? <Curtain title="Finding you the next table…" note="Dealing you in as soon as a seat is free." /> : null
  return (
    <Curtain title={step} note="While we seat you: you are about to guess where the price will be two minutes from now, then bet on that guess like a poker hand. Closest guess still in takes the pot. You get 30 seconds to make it." />
  )
}

function Curtain({ title, note }: { title: string; note: string }) {
  return (
    <div className="guest-curtain" role="status">
      <div className="guest-curtain-card">
        <span className="guest-curtain-spin" aria-hidden="true" />
        <b>{title}</b>
        <small>{note}</small>
      </div>
    </div>
  )
}

/** Chips landing from a hand the player already left — said wherever they are now, lobby
 *  or the next table, because that payout has no result screen of its own. */
export function LobbyToast() {
  const note = useGameStore((s) => s.collectNote)
  const [seen, setSeen] = useState<string | null>(null)
  useEffect(() => {
    if (!note) return
    const t = setTimeout(() => setSeen(note.id), 12000)
    return () => clearTimeout(t)
  }, [note])
  if (!note || seen === note.id) return null
  return (
    <div className="lobby-toast" role="status" onClick={() => setSeen(note.id)}>
      <span className="lobby-toast-dot" aria-hidden="true" />
      {note.label}
    </div>
  )
}
