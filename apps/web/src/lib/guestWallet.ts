/**
 * Table wallet — play without installing anything. A keypair is created in this browser,
 * registered as a normal Wallet Standard wallet, and signs silently: no extension, no
 * pop-ups. On devnet the faucet funds it, so a visitor is in a hand seconds after landing.
 *
 * It is a convenience wallet for test chips. The key lives in localStorage (clearing site
 * data loses it), so it is only offered where chips have no value — never on mainnet.
 */
import { Keypair, Transaction, VersionedTransaction } from '@solana/web3.js'
import { ed25519 } from '@noble/curves/ed25519'

export const GUEST_WALLET_NAME = 'Table wallet'
const KEY = 'st-guest-key-v1'
const RPC = (import.meta.env.VITE_SOLANA_RPC_URL as string | undefined) ?? 'https://api.devnet.solana.com'

/** Guests are for test chips only. */
export function guestAllowed(): boolean {
  return !/mainnet/i.test(RPC)
}

function load(): Keypair | null {
  try {
    const raw = localStorage.getItem(KEY)
    return raw ? Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw) as number[])) : null
  } catch {
    return null
  }
}

export function hasGuestWallet(): boolean {
  return load() != null
}

export function guestAddress(): string | null {
  return load()?.publicKey.toBase58() ?? null
}

/** True when the connected wallet is this browser's table wallet (it signs silently). */
export function isGuestWallet(address: string | null | undefined): boolean {
  return address != null && address === guestAddress()
}

let registered = false

/** Register the table wallet with the page (idempotent). No-op without a key. */
export function registerGuestWallet(): void {
  const kp = load()
  if (!kp || registered || typeof window === 'undefined') return
  registered = true
  const CHAINS = ['solana:localnet', 'solana:devnet'] as const
  const ICON =
    'data:image/svg+xml;base64,' +
    btoa('<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" rx="8" fill="#14100a"/><circle cx="16" cy="16" r="9" fill="none" stroke="#e7c873" stroke-width="2"/><circle cx="16" cy="16" r="3" fill="#e7c873"/></svg>')
  const account = {
    address: kp.publicKey.toBase58(),
    publicKey: kp.publicKey.toBytes(),
    chains: CHAINS,
    features: ['solana:signTransaction', 'solana:signMessage'] as const,
  }
  let accounts: (typeof account)[] = []
  const listeners = new Set<(change: { accounts: (typeof account)[] }) => void>()
  const emit = () => listeners.forEach((l) => l({ accounts }))
  const signTx = (raw: Uint8Array): Uint8Array => {
    try {
      const tx = Transaction.from(raw)
      tx.partialSign(kp)
      return tx.serialize({ requireAllSignatures: false, verifySignatures: false })
    } catch {
      const tx = VersionedTransaction.deserialize(raw)
      tx.sign([kp])
      return tx.serialize()
    }
  }
  const wallet = {
    version: '1.0.0' as const,
    name: GUEST_WALLET_NAME,
    icon: ICON,
    chains: CHAINS,
    get accounts() {
      return accounts
    },
    features: {
      'standard:connect': { version: '1.0.0', connect: async () => { accounts = [account]; emit(); return { accounts } } },
      'standard:disconnect': { version: '1.0.0', disconnect: async () => { accounts = []; emit() } },
      'standard:events': {
        version: '1.0.0',
        on: (event: string, l: (change: { accounts: (typeof account)[] }) => void) => {
          if (event === 'change') listeners.add(l)
          return () => listeners.delete(l)
        },
      },
      'solana:signTransaction': {
        version: '1.0.0',
        supportedTransactionVersions: ['legacy', 0],
        signTransaction: async (...inputs: { transaction: Uint8Array }[]) =>
          inputs.map(({ transaction }) => ({ signedTransaction: signTx(transaction) })),
      },
      'solana:signMessage': {
        version: '1.0.0',
        signMessage: async (...inputs: { message: Uint8Array }[]) =>
          inputs.map(({ message }) => ({
            signedMessage: message,
            signature: ed25519.sign(message, kp.secretKey.slice(0, 32)),
          })),
      },
    },
  }
  const register = (api: { register: (w: unknown) => void }) => api.register(wallet)
  try {
    const ev = new Event('wallet-standard:register-wallet')
    Object.defineProperty(ev, 'detail', { value: register })
    window.dispatchEvent(ev)
  } catch {
    /* the app-ready listener below still registers it */
  }
  window.addEventListener('wallet-standard:app-ready', (e) => register((e as CustomEvent).detail))
}

/**
 * Start playing as a guest: create the key if needed, remember the table wallet as the
 * selected wallet, and reload so the wallet layer connects to it like any other wallet.
 * After the reload the guest is seated at `resumeJoin` — a table id, or by default the
 * open house table — without pressing anything else.
 */
export function startGuest(resumeJoin: string = 'house'): void {
  if (!guestAllowed()) return
  try {
    if (!load()) localStorage.setItem(KEY, JSON.stringify(Array.from(Keypair.generate().secretKey)))
    localStorage.setItem('walletName', JSON.stringify(GUEST_WALLET_NAME))
    sessionStorage.setItem('st-resume-join', resumeJoin)
  } catch {
    return // storage blocked: a guest wallet cannot persist, so do not pretend
  }
  window.location.reload()
}

/** Where the guest was headed when the page reloaded: a table id, or 'house'. */
export function peekResumeJoin(): string | null {
  try {
    return sessionStorage.getItem('st-resume-join')
  } catch {
    return null
  }
}

/** Consume it (once). */
export function takeResumeJoin(): string | null {
  try {
    const id = sessionStorage.getItem('st-resume-join')
    if (id) sessionStorage.removeItem('st-resume-join')
    return id
  } catch {
    return null
  }
}
