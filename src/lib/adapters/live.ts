/**
 * Live adapters — real Solana wallet, drand time-lock, and on-chain Anchor custody.
 *
 * Wallet:  @solana/wallet-adapter-react (via walletBridge singleton).
 * Chain:   @coral-xyz/anchor + IDL; builds deposit/claim/refund instructions.
 * Tlock:   stub — tlock-js integration lands after the base UI is live.
 *
 * Env vars required (set in .env):
 *   VITE_GATEWAY_WS_URL, VITE_SOLANA_RPC_URL, VITE_PROGRAM_ID
 * Optional:
 *   VITE_CHIPS_TOKEN_MINT  (SPL mint for the betting token; read from TableTerms if absent)
 */
import {
  Connection,
  PublicKey,
  SystemProgram,
  Transaction,
  type ConfirmOptions,
  type VersionedTransaction,
} from '@solana/web3.js'
import {
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction,
} from '@solana/spl-token'
import { AnchorProvider, Program, BN } from '@coral-xyz/anchor'
// Import the provider-level Wallet interface (not the NodeWallet class exported at the top level)
import type { Wallet as AnchorWallet } from '@coral-xyz/anchor/dist/cjs/provider'
import type { MessageSignerWalletAdapter } from '@solana/wallet-adapter-base'
import { walletBridge } from '@/lib/walletBridge'
import type { Adapters, ChainClient, CreateAndDepositInput, Tlock, Wallet } from './index'
import type { Chips } from '@/lib/protocol'
import IDL from '@/lib/idl/syndicate_program.json'
// Static import avoids a Rollup "mixed static/dynamic" warning
import { useGameStore } from '@/store/gameStore'

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const RPC_URL = import.meta.env.VITE_SOLANA_RPC_URL as string
const PROGRAM_ID = new PublicKey(
  (import.meta.env.VITE_PROGRAM_ID as string) ?? '8D2Wt3pLyoS8wLaTb3mcnC5WVja6xYMoumNqG2yZs1qX',
)

const CONFIRM_OPTS: ConfirmOptions = {
  commitment: 'finalized', // deposit/claim/refund need finality so the backend verifies
  preflightCommitment: 'processed',
}

// ---------------------------------------------------------------------------
// PDA helpers (mirrors frontend/protocol.ts PDA_SEEDS)
// ---------------------------------------------------------------------------

function u64LeBytes(id: string): Buffer {
  let v = BigInt(id)
  const out = Buffer.alloc(8)
  for (let i = 0; i < 8; i++) {
    out[i] = Number(v & 0xffn)
    v >>= 8n
  }
  return out
}

function u16LeBytes(n: number): Buffer {
  const b = Buffer.alloc(2)
  b.writeUInt16LE(n, 0)
  return b
}

function matchPda(onchainMatchId: string): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('match'), u64LeBytes(onchainMatchId)],
    PROGRAM_ID,
  )[0]
}

function vaultPda(matchAccountPubkey: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('vault'), matchAccountPubkey.toBuffer()],
    PROGRAM_ID,
  )[0]
}

function seatPda(matchAccountPubkey: PublicKey, playerPubkey: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('seat'), matchAccountPubkey.toBuffer(), playerPubkey.toBuffer()],
    PROGRAM_ID,
  )[0]
}

function seatIndexPda(matchAccountPubkey: PublicKey, seatIndex: number): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('seat-index'), matchAccountPubkey.toBuffer(), u16LeBytes(seatIndex)],
    PROGRAM_ID,
  )[0]
}

function protocolStatePda(): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from('protocol')], PROGRAM_ID)[0]
}

/** Parse a hex string ("0x…" or bare) into a fixed-length byte array. */
function hexToBytes(hex: string, len: number): number[] {
  const clean = hex.replace(/^0x/, '')
  if (clean.length !== len * 2) {
    throw new Error(`expected ${len}-byte hex, got ${clean.length / 2} bytes`)
  }
  const out: number[] = []
  for (let i = 0; i < len; i++) out.push(parseInt(clean.slice(i * 2, i * 2 + 2), 16))
  return out
}

/** Mint a fresh on-chain match id (random u64 as a decimal string). */
export function newOnchainMatchId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8))
  let v = 0n
  for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(bytes[i])
  // keep it within safe u64 and non-zero
  return (v === 0n ? 1n : v).toString()
}

// ---------------------------------------------------------------------------
// Anchor program singleton
// ---------------------------------------------------------------------------

function getConnection(): Connection {
  return new Connection(RPC_URL, CONFIRM_OPTS.commitment)
}

/** Minimal Anchor wallet shim backed by the bridge adapter. */
function bridgeAnchorWallet(): AnchorWallet {
  return {
    get publicKey() {
      const pk = walletBridge.adapter?.publicKey
      if (!pk) throw new Error('[live] wallet not connected')
      return pk
    },
    // Anchor's Wallet interface uses generics; we cast through `unknown` to satisfy the constraint
    // without duplicating complex conditional types from web3.js.
    signTransaction: async <T extends Transaction | VersionedTransaction>(tx: T): Promise<T> => {
      const adapter = walletBridge.adapter as { signTransaction?: (t: Transaction) => Promise<Transaction> }
      if (!adapter?.signTransaction) throw new Error('[live] wallet cannot sign transaction')
      return adapter.signTransaction(tx as Transaction) as Promise<T>
    },
    signAllTransactions: async <T extends Transaction | VersionedTransaction>(txs: T[]): Promise<T[]> => {
      const adapter = walletBridge.adapter as { signAllTransactions?: (t: Transaction[]) => Promise<Transaction[]> }
      if (!adapter?.signAllTransactions) throw new Error('[live] wallet cannot sign transactions')
      return adapter.signAllTransactions(txs as Transaction[]) as Promise<T[]>
    },
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getProgram(): Program<any> {
  const conn = getConnection()
  const provider = new AnchorProvider(conn, bridgeAnchorWallet(), CONFIRM_OPTS)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new Program(IDL as any, provider)
}

// ---------------------------------------------------------------------------
// Wallet adapter
// ---------------------------------------------------------------------------

function createLiveWallet(): Wallet {
  return {
    address: () => walletBridge.adapter?.publicKey?.toBase58() ?? null,

    async connect(): Promise<string> {
      const adapter = walletBridge.adapter
      // Already connected
      if (adapter?.publicKey) return adapter.publicKey.toBase58()

      // Open the wallet-selection modal and await the connection event
      return new Promise<string>((resolve, reject) => {
        const TIMEOUT_MS = 90_000
        const timer = setTimeout(() => {
          walletBridge.onConnected = null
          walletBridge.onConnectError = null
          reject(new Error('wallet connection timed out'))
        }, TIMEOUT_MS)

        walletBridge.onConnected = (address) => {
          clearTimeout(timer)
          resolve(address)
        }
        walletBridge.onConnectError = (err) => {
          clearTimeout(timer)
          reject(err)
        }
        walletBridge.showModal()
      })
    },

    async signMessageBase64(message: string): Promise<string> {
      // MessageSignerWalletAdapter adds signMessage; cast through unknown so we don't
      // need to import the entire union type just for this one property.
      const adapter = walletBridge.adapter as unknown as MessageSignerWalletAdapter | null
      if (!adapter?.signMessage) throw new Error('[live] wallet does not support signMessage')
      const bytes = new TextEncoder().encode(message)
      const sig = await adapter.signMessage(bytes)
      return btoa(String.fromCharCode(...sig))
    },
  }
}

// ---------------------------------------------------------------------------
// Time-lock sealer (stub — tlock-js integration is a follow-up)
// ---------------------------------------------------------------------------

function createLiveTlock(): Tlock {
  return {
    async seal(_price, _targetRound, _chainHash, _api): Promise<string> {
      // TODO: integrate tlock-js (https://www.npmjs.com/package/tlock-js)
      // import { timelockEncrypt } from 'tlock-js'
      // const plaintext = i128LeBytes(price)  // 16-byte LE fixed-point
      // return base64(await timelockEncrypt(chainHash, targetRound, plaintext, api))
      throw new Error('[live] tlock sealing not yet integrated — install tlock-js')
    },
  }
}

// ---------------------------------------------------------------------------
// On-chain custody (Anchor)
// ---------------------------------------------------------------------------

/** Find the chips token mint.  Prefer env var, else use SOL as an emergency stub. */
function getChipsMint(mintFromTerms?: string): PublicKey | null {
  const envMint = import.meta.env.VITE_CHIPS_TOKEN_MINT as string | undefined
  const raw = mintFromTerms ?? envMint
  if (!raw) return null
  try {
    return new PublicKey(raw)
  } catch {
    return null
  }
}

/** Ensure the player's ATA exists; returns any create-ATA instruction to prepend. */
async function ensureAta(
  conn: Connection,
  mint: PublicKey,
  owner: PublicKey,
  payer: PublicKey,
): Promise<{ ata: PublicKey; createIx?: import('@solana/web3.js').TransactionInstruction }> {
  const ata = getAssociatedTokenAddressSync(mint, owner)
  const info = await conn.getAccountInfo(ata)
  if (info) return { ata }
  const createIx = createAssociatedTokenAccountInstruction(payer, ata, owner, mint)
  return { ata, createIx }
}

function createLiveChain(): ChainClient {
  return {
    async chipBalance(): Promise<Chips> {
      const adapter = walletBridge.adapter
      if (!adapter?.publicKey) return 0
      const mint = getChipsMint()
      if (!mint) return 0
      const conn = getConnection()
      try {
        const ata = getAssociatedTokenAddressSync(mint, adapter.publicKey)
        const info = await conn.getTokenAccountBalance(ata)
        // Return raw integer base units (e.g. 1_000_000 for 1 USDC at 6 decimals)
        return Number(info.value.amount)
      } catch {
        return 0
      }
    },

    /**
     * Host create: open a match AND seat the creator in one tx (§7).  Maps the
     * config-derived CreateParams + the signed-price token, then signs+sends.
     * Resolves on finality so the room can be reported to matchmaking.
     */
    async createAndDeposit(input: CreateAndDepositInput): Promise<{ txSig: string; matchPda: string }> {
      const adapter = walletBridge.adapter
      if (!adapter?.publicKey) throw new Error('[live] wallet not connected')

      const mintAddr = getChipsMint()
      if (!mintAddr) throw new Error('[live] chips token mint not configured (set VITE_CHIPS_TOKEN_MINT)')

      const conn = getConnection()
      const authority = adapter.publicKey
      const matchAcct = matchPda(input.onchainMatchId)
      const vault = vaultPda(matchAcct)
      const seat = seatPda(matchAcct, authority)
      const seatIdx = seatIndexPda(matchAcct, input.seatIndex)
      const protState = protocolStatePda()

      const { ata: playerToken, createIx } = await ensureAta(conn, mintAddr, authority, authority)

      // fill_deadline_ts is absolute unix seconds; the engine fills until then.
      const fillDeadlineTs = Math.floor(Date.now() / 1000) + input.fillWindowSec

      const params = {
        matchId: new BN(input.onchainMatchId),
        buyIn: new BN(input.buyIn),
        entryFee: new BN(input.entryFee),
        rakeBps: input.rakeBps,
        rakeCap: new BN(input.rakeCap),
        nonsealPenaltyBps: input.nonsealPenaltyBps,
        minPlayers: input.minPlayers,
        maxPlayers: input.maxPlayers,
        configHash: hexToBytes(input.configHash, 32),
        priceToken: hexToBytes(input.priceTokenHex, 20),
        totalBettingDurationSec: new BN(input.totalBettingDurationSec),
        sealWindowSec: new BN(input.sealWindowSec),
        beginLiveWindowSec: new BN(input.beginLiveWindowSec),
        fillDeadlineTs: new BN(fillDeadlineTs),
        maxOracleConfidence: new BN(0), // signed-price path; not Pyth-confidence gated
        oracleExponent: -Math.abs(input.decimals), // price fixed-point exponent (decimals=8 → -8)
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const program = getProgram() as any
       
      const ix = await program.methods
        .createAndDeposit(params, input.seatIndex)
        .accounts({
          authority,
          protocolState: protState,
          mint: mintAddr,
          matchAccount: matchAcct,
          vault,
          seat,
          seatIndexAccount: seatIdx,
          playerToken,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          rent: new PublicKey('SysvarRent111111111111111111111111111111111'),
        })
        .instruction()

      const tx = new Transaction()
      if (createIx) tx.add(createIx)
      tx.add(ix)

      const sender = adapter as unknown as { sendTransaction: (tx: Transaction, conn: Connection, opts?: object) => Promise<string> }
      const sig = await sender.sendTransaction(tx, conn, { skipPreflight: false })
      await conn.confirmTransaction(sig, 'finalized')
      return { txSig: sig, matchPda: matchAcct.toBase58() }
    },

    /**
     * deposit(matchId, seatIndex, amount)
     *
     * matchId here is used to look up onchainMatchId from the store terms.
     * The Anchor instruction requires the on-chain u64 match id for PDA derivation.
     */
    async deposit(_matchId: string, seatIndex: number): Promise<string> {
      const adapter = walletBridge.adapter
      if (!adapter?.publicKey) throw new Error('[live] wallet not connected')

      // Read current terms to get onchainMatchId + chips mint
      // useGameStore is imported statically at the top of this file
      const terms = useGameStore.getState().terms
      const onchainMatchId =
        terms?.onchainMatchId ??
        (() => {
          throw new Error('[live] onchainMatchId not available in terms')
        })()

      const mintAddr =
        terms?.chipsToken === 'SOL'
          ? null
          : getChipsMint(import.meta.env.VITE_CHIPS_TOKEN_MINT)
      if (!mintAddr) throw new Error('[live] chips token mint not configured (set VITE_CHIPS_TOKEN_MINT)')

      const conn = getConnection()
      const player = adapter.publicKey
      const matchAcct = matchPda(onchainMatchId)
      const vault = vaultPda(matchAcct)
      const seat = seatPda(matchAcct, player)
      const seatIdx = seatIndexPda(matchAcct, seatIndex)
      const protState = protocolStatePda()

      const { ata: playerToken, createIx } = await ensureAta(conn, mintAddr, player, player)

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const program = getProgram() as any
       
      const ix = await program.methods
        .deposit(new BN(seatIndex))
        .accounts({
          player,
          protocolState: protState,
          matchAccount: matchAcct,
          seat,
          seatIndexAccount: seatIdx,
          playerToken,
          vault,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .instruction()

      const tx = new Transaction()
      if (createIx) tx.add(createIx)
      tx.add(ix)

      const sender = adapter as unknown as { sendTransaction: (tx: Transaction, conn: Connection, opts?: object) => Promise<string> }
      const sig = await sender.sendTransaction(tx, conn, { skipPreflight: false })
      await conn.confirmTransaction(sig, 'finalized')
      return sig
    },

    async claim(_matchId: string): Promise<string> {
      const adapter = walletBridge.adapter
      if (!adapter?.publicKey) throw new Error('[live] wallet not connected')

      // useGameStore is imported statically at the top of this file
      const terms = useGameStore.getState().terms
      const onchainMatchId =
        terms?.onchainMatchId ??
        (() => {
          throw new Error('[live] onchainMatchId not available')
        })()
      const mintAddr = getChipsMint(import.meta.env.VITE_CHIPS_TOKEN_MINT)
      if (!mintAddr) throw new Error('[live] chips token mint not configured')

      const conn = getConnection()
      const player = adapter.publicKey
      const matchAcct = matchPda(onchainMatchId)
      const vault = vaultPda(matchAcct)
      const yourSeat = useGameStore.getState().match?.yourSeat ?? 0
      const seat = seatPda(matchAcct, player)
      const seatIdx = seatIndexPda(matchAcct, yourSeat)

      const { ata: playerToken, createIx } = await ensureAta(conn, mintAddr, player, player)

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const program = getProgram() as any
       
      const ix = await program.methods
        .claim()
        .accounts({
          player,
          matchAccount: matchAcct,
          seat,
          seatIndexAccount: seatIdx,
          vault,
          playerToken,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .instruction()

      const tx = new Transaction()
      if (createIx) tx.add(createIx)
      tx.add(ix)

      const sender = adapter as unknown as { sendTransaction: (tx: Transaction, conn: Connection) => Promise<string> }
      const sig = await sender.sendTransaction(tx, conn)
      await conn.confirmTransaction(sig, 'finalized')
      return sig
    },

    async refund(_matchId: string): Promise<string> {
      const adapter = walletBridge.adapter
      if (!adapter?.publicKey) throw new Error('[live] wallet not connected')

      // useGameStore is imported statically at the top of this file
      const terms = useGameStore.getState().terms
      const onchainMatchId =
        terms?.onchainMatchId ??
        (() => {
          throw new Error('[live] onchainMatchId not available')
        })()
      const mintAddr = getChipsMint(import.meta.env.VITE_CHIPS_TOKEN_MINT)
      if (!mintAddr) throw new Error('[live] chips token mint not configured')

      const conn = getConnection()
      const player = adapter.publicKey
      const matchAcct = matchPda(onchainMatchId)
      const vault = vaultPda(matchAcct)
      const yourSeat = useGameStore.getState().match?.yourSeat ?? 0
      const seat = seatPda(matchAcct, player)
      const seatIdx = seatIndexPda(matchAcct, yourSeat)

      const { ata: playerToken, createIx } = await ensureAta(conn, mintAddr, player, player)

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const program = getProgram() as any
       
      const ix = await program.methods
        .refund()
        .accounts({
          player,
          matchAccount: matchAcct,
          seat,
          seatIndexAccount: seatIdx,
          vault,
          playerToken,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .instruction()

      const tx = new Transaction()
      if (createIx) tx.add(createIx)
      tx.add(ix)

      const sender = adapter as unknown as { sendTransaction: (tx: Transaction, conn: Connection) => Promise<string> }
      const sig = await sender.sendTransaction(tx, conn)
      await conn.confirmTransaction(sig, 'finalized')
      return sig
    },
  }
}

export function createLiveAdapters(): Adapters {
  return {
    wallet: createLiveWallet(),
    tlock: createLiveTlock(),
    chain: createLiveChain(),
  }
}
