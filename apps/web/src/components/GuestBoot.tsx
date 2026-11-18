import { useEffect, useRef } from 'react'
import { useGameStore } from '@/store/gameStore'
import { guestAddress, takeResumeJoin } from '@/lib/guestWallet'

/**
 * Finishes the "play instantly" hand-off after the page reloads into the table wallet:
 * tops the guest up with test chips when it is short, and re-opens the table they chose.
 * Renders nothing.
 */
export function GuestBoot() {
  const wallet = useGameStore((s) => s.walletAddress)
  const faucet = useGameStore((s) => s.faucet)
  const balance = useGameStore((s) => s.chipBalance)
  const getTestChips = useGameStore((s) => s.getTestChips)
  const joinGame = useGameStore((s) => s.joinGame)
  const funded = useRef(false)
  const resumed = useRef(false)
  const isGuest = wallet != null && wallet === guestAddress()

  useEffect(() => {
    if (!isGuest || !faucet || funded.current) return
    // A fresh guest has no chip account yet (null) or too little for a buy-in.
    if (balance != null && balance >= 20_000_000n) return
    funded.current = true
    void getTestChips()
  }, [isGuest, faucet, balance, getTestChips])

  useEffect(() => {
    if (!isGuest || resumed.current) return
    resumed.current = true
    const id = takeResumeJoin()
    if (id) void joinGame(id)
  }, [isGuest, joinGame])

  return null
}
