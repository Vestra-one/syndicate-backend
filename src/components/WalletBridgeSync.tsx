/**
 * WalletBridgeSync — keeps the module-level walletBridge singleton in sync with
 * the Solana wallet adapter React context.  Mount exactly once, inside the
 * WalletProvider tree (see main.tsx).
 *
 * Why not hooks in the store?  The store lives outside React.  This component is
 * the single point where React state leaks into the imperative adapter world.
 */
import { useEffect } from 'react'
import { useWallet } from '@solana/wallet-adapter-react'
import { useWalletModal } from '@solana/wallet-adapter-react-ui'
import { walletBridge } from '@/lib/walletBridge'
export function WalletBridgeSync() {
  const { wallet, publicKey, connected } = useWallet()
  const { setVisible } = useWalletModal()

  // Keep bridge adapter + modal opener in sync
  useEffect(() => {
    walletBridge.adapter = wallet?.adapter ?? null
    walletBridge.showModal = () => setVisible(true)
  }, [wallet, setVisible])

  // Fire pending onConnected callback when the wallet connects
  useEffect(() => {
    if (connected && publicKey) {
      const cb = walletBridge.onConnected
      if (cb) {
        walletBridge.onConnected = null
        walletBridge.onConnectError = null
        cb(publicKey.toBase58())
      }
    }
  }, [connected, publicKey])

  return null
}
