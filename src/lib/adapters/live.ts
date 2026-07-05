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
import { Buffer } from 'buffer'
import { walletBridge } from '@/lib/walletBridge'
import { i128le } from '@/lib/intent'
import type {
  Adapters,
  ChainClient,
  ClaimableWinning,
  CreateAndDepositInput,
  OnchainMatchStatus,
  OnchainSeatInfo,
  ReclaimableMatch,
  Tlock,
  TxProgressFn,
  Wallet,
} from './index'
import type { Chips } from '@/lib/protocol'
import IDL from '@/lib/idl/syndicate_program.json'
// Static import avoids a Rollup "mixed static/dynamic" warning
import { useGameStore } from '@/store/gameStore'

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const RPC_URL = import.meta.env.VITE_SOLANA_RPC_URL as string
// Derive program ID from the IDL's baked-in address so PDAs always match the
// program Anchor calls. VITE_PROGRAM_ID can still override for local forks.
const PROGRAM_ID = new PublicKey(
  (import.meta.env.VITE_PROGRAM_ID as string) ?? (IDL as { address: string }).address,
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

/** v2 seat PDA — keyed by (match, player) only. There is no seat-index PDA in v2. */
function seatPda(matchAccountPubkey: PublicKey, playerPubkey: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('seat'), matchAccountPubkey.toBuffer(), playerPubkey.toBuffer()],
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

/** Mint a fresh on-chain match id (random full-width u64 as a decimal string). */
export function newOnchainMatchId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8))
  let v = 0n
  for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(bytes[i])
  // Full u64 range, non-zero. NOTE: ids routinely exceed 2^53, so they MUST be carried as
  // decimal strings end-to-end — never round-trip an id through `n()`/Number (see `idStr`).
  return (v === 0n ? 1n : v).toString()
}

// ---------------------------------------------------------------------------
// On-chain reads: MatchAccount / SeatAccount (self-serve — no backend needed).
//
// v2 decodes via Anchor's IDL-driven coder (discriminators are baked into the IDL),
// so we never hand-maintain byte offsets against state.rs. `_ts` fields are on-chain
// unix SECONDS (Solana Clock), NOT the REST ms convention.
// ---------------------------------------------------------------------------

/**
 * Anchor returns u64/i64 as BN; coerce to a JS number for BOUNDED fields only (token base
 * units, unix-second timestamps — all comfortably < 2^53). Goes via the decimal string so a
 * value above 2^53 degrades to a lossy float instead of throwing: `BN.toNumber()` throws
 * ("can only safely store up to 53 bits"), which previously crashed whole account scans.
 * NEVER use this for ids — they span the full u64; use `idStr` to keep them exact.
 */
function n(v: unknown): number {
  if (typeof v === 'number') return v
  const bn = v as { toNumber?: () => number; toString?: () => string } | null
  if (bn && typeof bn.toNumber === 'function') return Number(bn.toString!())
  return Number(v ?? 0)
}

/** Exact decimal string for a full-width u64 id (BN or number). No precision loss, never throws. */
function idStr(v: unknown): string {
  if (v == null) return '0'
  return typeof v === 'number' ? String(v) : (v as { toString: () => string }).toString()
}

/** Anchor decodes Rust enums as `{ <variantLowerCamel>: {} }`; map to our status union. */
const MATCH_STATUS: Record<string, OnchainMatchStatus['status']> = {
  filling: 'FILLING',
  sealing: 'SEALING',
  live: 'LIVE',
  settled: 'SETTLED',
  void: 'VOID',
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mapMatchStatus(acct: any): OnchainMatchStatus {
  const key = Object.keys(acct.status ?? {})[0] ?? 'filling'
  return {
    status: MATCH_STATUS[key] ?? 'FILLING',
    fillDeadlineTs: n(acct.fillDeadlineTs),
    buyIn: n(acct.buyIn),
    entryFee: n(acct.entryFee),
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mapSeat(acct: any): OnchainSeatInfo {
  return {
    deposit: n(acct.deposit),
    entryFeePaid: n(acct.entryFeePaid),
    payout: n(acct.payout),
    claimed: !!acct.claimed,
    confirmed: !!acct.confirmed,
    engineSeat: n(acct.engineSeat),
  }
}

/**
 * Anchor programs log e.g. "Error Code: FillDeadlineNotReached. Error Number: 6025." on
 * failure. Pull the symbolic code out so callers can branch on it (idempotent-refund
 * detection, friendly countdown messaging) instead of parsing raw simulation output.
 */
function anchorErrorCode(err: unknown, logs?: string[]): string | null {
  const text = [((err as Error)?.message ?? ''), ...(logs ?? (err as { logs?: string[] })?.logs ?? [])].join('\n')
  return /Error Code:\s*(\w+)/.exec(text)?.[1] ?? null
}

/** Simulate (for a clean error code), then send + confirm. Throws Error(code) on a program error. */
async function simulateSignAndSend(
  conn: Connection,
  tx: Transaction,
  feePayer: PublicKey,
  onProgress?: TxProgressFn,
): Promise<string> {
  const adapter = walletBridge.adapter
  if (!adapter?.publicKey) throw new Error('[live] wallet not connected')

  // 'confirmed' blockhash (not the connection's 'finalized' default) buys the full validity
  // window before send, cutting spurious "block height exceeded" failures under load.
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash('confirmed')
  tx.recentBlockhash = blockhash
  tx.lastValidBlockHeight = lastValidBlockHeight
  tx.feePayer = feePayer

  const sim = await conn.simulateTransaction(tx)
  if (sim.value.err) {
    const code = anchorErrorCode(sim.value.err, sim.value.logs ?? undefined)
    throw new Error(code ?? `Transaction simulation failed: ${JSON.stringify(sim.value.err)}`)
  }

  const sender = adapter as unknown as { sendTransaction: (tx: Transaction, conn: Connection, opts?: object) => Promise<string> }
  let sig: string
  try {
    onProgress?.('signing') // wallet approval prompt is up
    sig = await sender.sendTransaction(tx, conn, { skipPreflight: true })
  } catch (err) {
    const code = anchorErrorCode(err)
    throw code ? new Error(code) : err
  }
  onProgress?.('confirming', sig) // broadcast — waiting on finality
  // A bare-signature confirmTransaction(sig, commitment) has no expiry — if the RPC's
  // signature-subscribe WS never fires (common on congested/public endpoints), this hangs
  // forever with no error surfaced. Passing the blockhash strategy bounds it to the
  // blockhash's ~90s validity window, so a stalled confirmation always eventually throws.
  const confirmation = await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'finalized')
  if (confirmation.value.err) {
    const code = anchorErrorCode(confirmation.value.err)
    throw new Error(code ?? `Transaction failed on-chain: ${JSON.stringify(confirmation.value.err)}`)
  }
  return sig
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
      return signBytesBase64(new TextEncoder().encode(message))
    },

    async signBytesBase64(bytes: Uint8Array): Promise<string> {
      return signBytesBase64(bytes)
    },
  }
}

/** ed25519-sign raw bytes with the connected wallet → base64 signature. */
async function signBytesBase64(bytes: Uint8Array): Promise<string> {
  // MessageSignerWalletAdapter adds signMessage; cast through unknown so we don't
  // need to import the entire union type just for this one property.
  const adapter = walletBridge.adapter as unknown as MessageSignerWalletAdapter | null
  if (!adapter?.signMessage) throw new Error('[live] wallet does not support signMessage')
  const sig = await adapter.signMessage(bytes)
  return btoa(String.fromCharCode(...sig))
}

// ---------------------------------------------------------------------------
// Time-lock sealer (stub — tlock-js integration is a follow-up)
// ---------------------------------------------------------------------------

function createLiveTlock(): Tlock {
  return {
    async seal(priceWad, targetRound, chainHash, api): Promise<Uint8Array> {
      // Dynamic import: tlock-js pulls a heavy BLS bundle — load it only when sealing so it
      // code-splits out of the main app chunk. (Buffer/i128le are already in the main bundle.)
      const { timelockEncrypt, HttpChainClient, HttpCachingChain } = await import('tlock-js')
      const chain = new HttpCachingChain(`${api}/${chainHash}`)
      const client = new HttpChainClient(chain)
      // Plaintext is the i128-LE WAD price (16 bytes). Real drand tlock gates the reveal on
      // the round itself (unlike the mock scheme, no round bytes go in the plaintext).
      const armored = await timelockEncrypt(targetRound, Buffer.from(i128le(priceWad)), client)
      // The stored/committed ciphertext bytes are the UTF-8 bytes of the age-armored string;
      // the settlement worker (drand tlock) decrypts these same bytes.
      return new TextEncoder().encode(armored)
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
    async createAndDeposit(input: CreateAndDepositInput, onProgress?: TxProgressFn): Promise<{ txSig: string; matchPda: string }> {
      const adapter = walletBridge.adapter
      if (!adapter?.publicKey) throw new Error('[live] wallet not connected')

      const mintAddr = getChipsMint()
      if (!mintAddr) throw new Error('[live] chips token mint not configured (set VITE_CHIPS_TOKEN_MINT)')

      const conn = getConnection()
      const authority = adapter.publicKey
      const matchAcct = matchPda(input.onchainMatchId)
      const vault = vaultPda(matchAcct)
      const seat = seatPda(matchAcct, authority)
      const protState = protocolStatePda()

      const { ata: playerToken, createIx } = await ensureAta(conn, mintAddr, authority, authority)

      // v2 CreateParams — field order per the IDL (167-byte Borsh). No nonseal penalty;
      // v2 adds is_private + room_commitment (zeroed for public rooms).
      const params = {
        matchId: new BN(input.onchainMatchId),
        buyIn: new BN(input.buyIn),
        entryFee: new BN(input.entryFee),
        rakeBps: input.rakeBps,
        rakeCap: new BN(input.rakeCap),
        minPlayers: input.minPlayers,
        maxPlayers: input.maxPlayers,
        isPrivate: input.isPrivate,
        roomCommitment: hexToBytes(input.roomCommitmentHex, 32),
        configHash: hexToBytes(input.configHash, 32),
        priceToken: hexToBytes(input.priceTokenHex, 20),
        totalBettingDurationSec: new BN(input.totalBettingDurationSec),
        sealWindowSec: new BN(input.sealWindowSec),
        beginLiveWindowSec: new BN(input.beginLiveWindowSec),
        fillWindowSec: new BN(input.fillWindowSec), // program derives fill_deadline_ts = create_ts + fillWindowSec
        maxOracleConfidence: new BN(input.maxOracleConfidence ?? 0), // signed-price path; not Pyth-confidence gated
        oracleExponent: input.oracleExponent ?? -18, // signed_price::SIGNED_PRICE_EXPONENT — WAD-18 fixed-point
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const program = getProgram() as any

      const ix = await program.methods
        .createAndDeposit(params)
        .accounts({
          authority,
          protocolState: protState,
          mint: mintAddr,
          matchAccount: matchAcct,
          vault,
          seat,
          playerToken,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          rent: new PublicKey('SysvarRent111111111111111111111111111111111'),
        })
        .instruction()

      const tx = new Transaction()
      if (createIx) tx.add(createIx)
      tx.add(ix)

      if (import.meta.env.DEV) {
        console.log('[createAndDeposit] params', {
          program: PROGRAM_ID.toBase58(), protocolState: protState.toBase58(),
          matchAcct: matchAcct.toBase58(), mint: mintAddr.toBase58(),
          configHash: input.configHash, priceTokenHex: input.priceTokenHex,
          matchId: params.matchId.toString(), buyIn: params.buyIn.toString(),
          entryFee: params.entryFee.toString(), rakeBps: params.rakeBps,
          rakeCap: params.rakeCap.toString(), minPlayers: params.minPlayers,
          maxPlayers: params.maxPlayers, isPrivate: params.isPrivate,
          totalBettingDurationSec: params.totalBettingDurationSec.toString(),
          sealWindowSec: params.sealWindowSec.toString(),
          beginLiveWindowSec: params.beginLiveWindowSec.toString(),
          fillWindowSec: params.fillWindowSec.toString(),
          maxOracleConfidence: params.maxOracleConfidence.toString(),
          oracleExponent: params.oracleExponent,
        })
      }

      // Simulate first via our own RPC to get the actual program logs before MetaMask sees it.
      // Fetch the send blockhash at 'confirmed' (not the connection's 'finalized' default) so
      // we don't burn ~15-30s of the ~90s validity window before the tx is even signed.
      const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash('confirmed')
      tx.recentBlockhash = blockhash
      tx.lastValidBlockHeight = lastValidBlockHeight
      tx.feePayer = authority
      const simResult = await conn.simulateTransaction(tx)
      if (simResult.value.err) {
        console.error('[createAndDeposit] simulation error:', JSON.stringify(simResult.value.err))
        console.error('[createAndDeposit] simulation logs:', simResult.value.logs)
        throw new Error(
          `Transaction simulation failed: ${JSON.stringify(simResult.value.err)}\n` +
          (simResult.value.logs ?? []).join('\n')
        )
      }
      if (import.meta.env.DEV) console.log('[createAndDeposit] simulation OK, logs:', simResult.value.logs)

      const sender = adapter as unknown as { sendTransaction: (tx: Transaction, conn: Connection, opts?: object) => Promise<string> }
      let sig: string
      try {
        onProgress?.('signing') // wallet approval prompt is up
        sig = await sender.sendTransaction(tx, conn, { skipPreflight: true })
      } catch (err: unknown) {
        const logs: string[] = (err as { logs?: string[] })?.logs ?? []
        console.error('[createAndDeposit] send failed. logs:', logs)
        throw err
      }

      onProgress?.('confirming', sig) // broadcast — waiting on finality
      // Bounded confirm: the bare (sig, commitment) form has no expiry and hangs forever if
      // the RPC's signature-subscribe never fires (see simulateSignAndSend). The blockhash
      // strategy caps the wait at the blockhash's validity window.
      const confirmation = await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'finalized')
      if (confirmation.value.err) {
        throw new Error(anchorErrorCode(confirmation.value.err) ?? `Transaction failed on-chain: ${JSON.stringify(confirmation.value.err)}`)
      }
      return { txSig: sig, matchPda: matchAcct.toBase58() }
    },

    /**
     * deposit(matchId, joinCommitmentHex?) — become a seat *candidate* (§5).
     *
     * matchId is used to look up onchainMatchId from the store terms (the Anchor
     * instruction needs the on-chain u64 for PDA derivation). `joinCommitmentHex` binds a
     * private-room join (`sha256(roomcode ‖ joiner)`); public rooms pass 32 zero bytes.
     */
    async deposit(_matchId: string, joinCommitmentHex?: string, _amount?: number, onProgress?: TxProgressFn): Promise<string> {
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
      const protState = protocolStatePda()

      const joinCommitment = hexToBytes(joinCommitmentHex ?? '00'.repeat(32), 32)

      const { ata: playerToken, createIx } = await ensureAta(conn, mintAddr, player, player)

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const program = getProgram() as any

      const ix = await program.methods
        .deposit(joinCommitment)
        .accounts({
          player,
          protocolState: protState,
          matchAccount: matchAcct,
          seat,
          playerToken,
          vault,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .instruction()

      const tx = new Transaction()
      if (createIx) tx.add(createIx)
      tx.add(ix)

      return simulateSignAndSend(conn, tx, player, onProgress)
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
      const seat = seatPda(matchAcct, player)

      const { ata: playerToken, createIx } = await ensureAta(conn, mintAddr, player, player)

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const program = getProgram() as any

      const ix = await program.methods
        .claim()
        .accounts({
          player,
          matchAccount: matchAcct,
          seat,
          vault,
          playerToken,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .instruction()

      const tx = new Transaction()
      if (createIx) tx.add(createIx)
      tx.add(ix)

      // Route through simulateSignAndSend: it simulates first (so an already-settled/second
      // claim throws a clean `AlreadyClaimed` pre-signature), surfaces the symbolic Anchor
      // code, and bounds the confirm to the blockhash window instead of hanging.
      return simulateSignAndSend(conn, tx, player)
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
      const seat = seatPda(matchAcct, player)

      const { ata: playerToken, createIx } = await ensureAta(conn, mintAddr, player, player)

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const program = getProgram() as any

      const ix = await program.methods
        .refund()
        .accounts({
          player,
          matchAccount: matchAcct,
          seat,
          vault,
          playerToken,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .instruction()

      const tx = new Transaction()
      if (createIx) tx.add(createIx)
      tx.add(ix)

      // Same as claim(): simulate + clean Anchor code + bounded confirm via simulateSignAndSend.
      return simulateSignAndSend(conn, tx, player)
    },

    /**
     * Seal: register the on-chain prediction commitment during SEALING (§7). Accounts
     * (per ix.rs): player(signer), match_account(w), seat(w). Args: { commitment[32],
     * timelock_target:u64 }. `commitment = sha256(tlock_ciphertext)`.
     */
    async registerPredictionCommitment(onchainMatchId: string, commitmentHex: string, timelockTarget: number): Promise<string> {
      const adapter = walletBridge.adapter
      if (!adapter?.publicKey) throw new Error('[live] wallet not connected')
      const conn = getConnection()
      const player = adapter.publicKey
      const matchAcct = matchPda(onchainMatchId)
      const seat = seatPda(matchAcct, player)

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const program = getProgram() as any
      const ix = await program.methods
        .registerPredictionCommitment({ commitment: hexToBytes(commitmentHex, 32), timelockTarget: new BN(timelockTarget) })
        .accounts({ player, matchAccount: matchAcct, seat })
        .instruction()

      const tx = new Transaction().add(ix)
      return simulateSignAndSend(conn, tx, player)
    },

    // -------------------------------------------------------------------
    // Cancel & reclaim (§ stuck-room self-serve void + refund)
    // -------------------------------------------------------------------

    async getMatchStatus(onchainMatchId: string): Promise<OnchainMatchStatus | null> {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const program = getProgram() as any
      const acct = await program.account.matchAccount.fetchNullable(matchPda(onchainMatchId))
      return acct ? mapMatchStatus(acct) : null
    },

    async getMySeat(onchainMatchId: string): Promise<OnchainSeatInfo | null> {
      const adapter = walletBridge.adapter
      if (!adapter?.publicKey) return null
      const seat = seatPda(matchPda(onchainMatchId), adapter.publicKey)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const program = getProgram() as any
      const acct = await program.account.seatAccount.fetchNullable(seat)
      return acct ? mapSeat(acct) : null
    },

    /** Permissionless: anyone can send this once `now >= fill_deadline_ts`; only pays the fee. */
    async voidBeforeStart(onchainMatchId: string): Promise<string> {
      const adapter = walletBridge.adapter
      if (!adapter?.publicKey) throw new Error('[live] wallet not connected')

      const conn = getConnection()
      const matchAcct = matchPda(onchainMatchId)

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const program = getProgram() as any
      const ix = await program.methods
        .voidBeforeStart()
        .accounts({ matchAccount: matchAcct })
        .instruction()

      const tx = new Transaction().add(ix)
      return simulateSignAndSend(conn, tx, adapter.publicKey)
    },

    /**
     * Player-signed payout pull for a SETTLED match, by id. Mirror of `refundSelf` on the
     * claim instruction: keyed by the (match, player) seat PDA, so it works standalone from a
     * "my winnings" list. `simulateSignAndSend` surfaces a clean anchor code (e.g. AlreadyClaimed).
     */
    async claimSettled(onchainMatchId: string): Promise<string> {
      const adapter = walletBridge.adapter
      if (!adapter?.publicKey) throw new Error('[live] wallet not connected')
      const mintAddr = getChipsMint(import.meta.env.VITE_CHIPS_TOKEN_MINT)
      if (!mintAddr) throw new Error('[live] chips token mint not configured')

      const conn = getConnection()
      const player = adapter.publicKey
      const matchAcct = matchPda(onchainMatchId)
      const vault = vaultPda(matchAcct)
      const seat = seatPda(matchAcct, player)

      const seatInfo = await conn.getAccountInfo(seat)
      if (!seatInfo?.data) throw new Error('NoSeat')

      const { ata: playerToken, createIx } = await ensureAta(conn, mintAddr, player, player)

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const program = getProgram() as any
      const ix = await program.methods
        .claim()
        .accounts({
          player,
          matchAccount: matchAcct,
          seat,
          vault,
          playerToken,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .instruction()

      const tx = new Transaction()
      if (createIx) tx.add(createIx)
      tx.add(ix)
      return simulateSignAndSend(conn, tx, player)
    },

    /**
     * Player-signed refund. The v2 seat PDA is keyed by (match, player) alone, so this works
     * standalone (e.g. a "my matches" list) without any active gateway/match state.
     */
    async refundSelf(onchainMatchId: string): Promise<string> {
      const adapter = walletBridge.adapter
      if (!adapter?.publicKey) throw new Error('[live] wallet not connected')
      const mintAddr = getChipsMint(import.meta.env.VITE_CHIPS_TOKEN_MINT)
      if (!mintAddr) throw new Error('[live] chips token mint not configured')

      const conn = getConnection()
      const player = adapter.publicKey
      const matchAcct = matchPda(onchainMatchId)
      const vault = vaultPda(matchAcct)
      const seat = seatPda(matchAcct, player)

      const seatInfo = await conn.getAccountInfo(seat)
      if (!seatInfo?.data) throw new Error('NoSeat')

      const { ata: playerToken, createIx } = await ensureAta(conn, mintAddr, player, player)

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const program = getProgram() as any
      const ix = await program.methods
        .refund()
        .accounts({
          player,
          matchAccount: matchAcct,
          seat,
          vault,
          playerToken,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .instruction()

      const tx = new Transaction()
      if (createIx) tx.add(createIx)
      tx.add(ix)
      return simulateSignAndSend(conn, tx, player)
    },

    /**
     * Single-signature path: bundles void_before_start + refund into one atomic tx.
     * `simulateSignAndSend` simulates before prompting the wallet, so if someone else's
     * void beat us to it (BadStatus), this throws pre-signature and the caller can fall
     * back to the sequential pair with no wasted wallet prompt.
     */
    async cancelAndRefundSelf(onchainMatchId: string): Promise<string> {
      const adapter = walletBridge.adapter
      if (!adapter?.publicKey) throw new Error('[live] wallet not connected')
      const mintAddr = getChipsMint(import.meta.env.VITE_CHIPS_TOKEN_MINT)
      if (!mintAddr) throw new Error('[live] chips token mint not configured')

      const conn = getConnection()
      const player = adapter.publicKey
      const matchAcct = matchPda(onchainMatchId)
      const vault = vaultPda(matchAcct)
      const seat = seatPda(matchAcct, player)

      const seatInfo = await conn.getAccountInfo(seat)
      if (!seatInfo?.data) throw new Error('NoSeat')

      const { ata: playerToken, createIx } = await ensureAta(conn, mintAddr, player, player)

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const program = getProgram() as any
      const voidIx = await program.methods
        .voidBeforeStart()
        .accounts({ matchAccount: matchAcct })
        .instruction()
      const refundIx = await program.methods
        .refund()
        .accounts({
          player,
          matchAccount: matchAcct,
          seat,
          vault,
          playerToken,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .instruction()

      const tx = new Transaction()
      if (createIx) tx.add(createIx)
      tx.add(voidIx, refundIx)
      return simulateSignAndSend(conn, tx, player)
    },

    /** Scan the connected wallet's seats for matches stuck FILLING past deadline, or VOID. */
    async listReclaimableMatches(): Promise<ReclaimableMatch[]> {
      const adapter = walletBridge.adapter
      if (!adapter?.publicKey) return []

      const player = adapter.publicKey
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const program = getProgram() as any
      // `.all()` adds the SeatAccount discriminator filter; offset 40 = SeatAccount.player
      // (8 disc + 32 match_key). Anchor decodes each account via the IDL.
      const seatAccounts: Array<{ publicKey: PublicKey; account: unknown }> =
        await program.account.seatAccount.all([
          { memcmp: { offset: 40, bytes: player.toBase58() } },
        ])
      if (seatAccounts.length === 0) return []

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const matchKeys = seatAccounts.map((a) => (a.account as any).matchKey as PublicKey)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const matchAccts: any[] = await program.account.matchAccount.fetchMultiple(matchKeys)

      const nowSec = Date.now() / 1000
      const out: ReclaimableMatch[] = []
      for (let i = 0; i < seatAccounts.length; i++) {
        const seat = mapSeat(seatAccounts[i].account)
        if (seat.claimed) continue // nothing left to reclaim
        const matchAcct = matchAccts[i]
        if (!matchAcct) continue
        const status = mapMatchStatus(matchAcct)
        const reclaimable = status.status === 'VOID' || (status.status === 'FILLING' && nowSec >= status.fillDeadlineTs)
        if (!reclaimable) continue
        out.push({
          ...status,
          onchainMatchId: idStr(matchAcct.matchId),
          matchPda: matchKeys[i].toBase58(),
          deposit: seat.deposit,
          entryFeePaid: seat.entryFeePaid,
        })
      }
      return out
    },

    /** Scan the connected wallet's seats for SETTLED matches with an unclaimed payout. */
    async listClaimableWinnings(): Promise<ClaimableWinning[]> {
      const adapter = walletBridge.adapter
      if (!adapter?.publicKey) return []

      const player = adapter.publicKey
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const program = getProgram() as any
      // Same discriminator + player-offset filter as listReclaimableMatches (offset 40 =
      // SeatAccount.player, after 8 disc + 32 match_key).
      const seatAccounts: Array<{ publicKey: PublicKey; account: unknown }> =
        await program.account.seatAccount.all([
          { memcmp: { offset: 40, bytes: player.toBase58() } },
        ])
      if (seatAccounts.length === 0) return []

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const matchKeys = seatAccounts.map((a) => (a.account as any).matchKey as PublicKey)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const matchAccts: any[] = await program.account.matchAccount.fetchMultiple(matchKeys)

      const out: ClaimableWinning[] = []
      for (let i = 0; i < seatAccounts.length; i++) {
        const seat = mapSeat(seatAccounts[i].account)
        if (seat.claimed || seat.payout <= 0) continue // already pulled, or nothing to collect
        const matchAcct = matchAccts[i]
        if (!matchAcct) continue
        if (mapMatchStatus(matchAcct).status !== 'SETTLED') continue
        out.push({
          onchainMatchId: idStr(matchAcct.matchId),
          matchPda: matchKeys[i].toBase58(),
          payout: seat.payout,
        })
      }
      return out
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
