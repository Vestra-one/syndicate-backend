/**
 * Syndicate — reference client flow (illustrative).
 *
 * Shows the v1 player-created path: connect → (host) create_and_deposit + report txhash →
 * (joiners) deposit + report txhash → explicit seal (one wallet popup, no session key) →
 * play with server-clock countdowns → claim. v1 uses a company-signed price (NOT Pyth) and
 * has no indexer: the client REPORTS its create/deposit txhashes and the backend verifies them
 * on-chain. External integrations (wallet adapter, tlock-js, Anchor program client) are behind
 * small interfaces you implement. This file documents control flow; it is not meant to compile.
 */
import type {
  ServerMessage, ServerEnvelope, ClientMessage, BettingAction, TableTerms, MatchStateView,
  CreateAndDepositArgs, RegisterPredictionCommitmentArgs, RoomListing,
} from './protocol.ts';
import { DRAND, remainingMs } from './protocol.ts';

// ---- integrations you provide (🔵) ----
interface Wallet {
  publicKeyBase58(): string;
  /** ed25519 sign of utf8(message), returned base64 (gateway auth + action intents). */
  signMessageBase64(message: string): Promise<string>;
}
interface Tlock {
  /** Encrypt fixed-point price (i128 LE bytes) toward a drand round → base64 ciphertext. */
  seal(priceFixedPoint: number, targetRound: number, chainHash: string, api: string): Promise<string>;
  /** H(prediction || blinding) commitment + the blinding factor (32-byte hex each). */
  commit(priceFixedPoint: number): Promise<{ commitmentHex: string; blindingHex: string }>;
}
interface ChainClient {
  /** Host: open the match and seat the creator in one tx. Resolves on finality → tx sig. */
  createAndDeposit(args: CreateAndDepositArgs): Promise<{ txSig: string; matchPda: string }>;
  /** Joiner: deposit buy-in + entry fee into an existing match. Resolves on finality → tx sig. */
  deposit(onchainMatchId: string, seatIndex: number): Promise<string>;
  /** Explicit seal: ONE wallet popup signs register_prediction_commitment. */
  registerPredictionCommitment(args: RegisterPredictionCommitmentArgs): Promise<string>;
  claim(matchId: string): Promise<string>;
  refund(matchId: string): Promise<string>;
}
/** Matchmaking REST (txhash reporting) + the timelock ciphertext store. */
interface BackendApi {
  /** POST /rooms — report the verified host create. */
  reportCreate(body: import('./protocol.ts').CreateRoomReport): Promise<{ ok: boolean; roomCode?: string; reason?: string }>;
  /** POST /matches/:matchId/deposits — report the verified joiner deposit. */
  reportDeposit(matchId: string, body: import('./protocol.ts').DepositReport): Promise<{ ok: boolean; seat?: number; reason?: string }>;
  /** GET /rooms — lobby feed (also pushed over WS as roomsUpdated). */
  listRooms(filter?: { feed?: string; template?: string; buyIn?: number }): Promise<RoomListing[]>;
}

// ---------------------------------------------------------------------------

export class SyndicateClient {
  private ws!: WebSocket;
  private wallet: Wallet;
  private tlock: Tlock;
  private chain: ChainClient;
  private api: BackendApi;
  private gatewayUrl: string;
  /** local clock minus the latest server clock — used to render fair countdowns. */
  private clockOffsetMs = 0;

  constructor(opts: { gatewayUrl: string; wallet: Wallet; tlock: Tlock; chain: ChainClient; api: BackendApi }) {
    this.gatewayUrl = opts.gatewayUrl;
    this.wallet = opts.wallet;
    this.tlock = opts.tlock;
    this.chain = opts.chain;
    this.api = opts.api;
  }

  /** 1) Connect + authenticate (§3). Resolves once authenticated. */
  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.gatewayUrl);
      this.ws.onmessage = async (raw) => {
        const msg = JSON.parse(raw.data) as ServerEnvelope;
        if (typeof msg.serverTime === 'number') this.clockOffsetMs = Date.now() - msg.serverTime;
        switch (msg.type) {
          case 'challenge': {
            const signature = await this.wallet.signMessageBase64(msg.nonce); // 🔵
            this.send({ type: 'auth', wallet: this.wallet.publicKeyBase58(), signature });
            break;
          }
          case 'authenticated':
            resolve();
            break;
          case 'error':
            reject(new Error(`gateway: ${msg.reason}`)); // e.g. 'geo-blocked'
            break;
          default:
            this.onServerMessage(msg); // gameplay/feed (after auth)
        }
      };
      this.ws.onerror = () => reject(new Error('socket error'));
    });
  }

  /**
   * 2a) HOST: create the match on-chain (create_and_deposit) and REPORT the txhash. The backend
   * verifies the finalized tx before registering the room — it never creates matches itself.
   */
  async hostCreate(args: CreateAndDepositArgs): Promise<string> {
    // UI: show buy-in + entry fee BEFORE signing — never surprise the user financially.
    const { txSig, matchPda } = await this.chain.createAndDeposit(args); // 🔵 wallet signs; finality
    const res = await this.api.reportCreate({
      createTxSig: txSig,
      matchPda,
      onchainMatchId: args.onchainMatchId,
      configHash: args.configHash,
      wallet: this.wallet.publicKeyBase58(),
      seatIndex: args.seatIndex,
    });
    if (!res.ok) throw new Error(`create rejected: ${res.reason}`);
    return res.roomCode!;
  }

  /** 2b) JOINER: deposit into an existing match and REPORT the txhash. */
  async joinTable(matchId: string, onchainMatchId: string, seatIndex: number): Promise<void> {
    const txSig = await this.chain.deposit(onchainMatchId, seatIndex); // 🔵 finality
    const res = await this.api.reportDeposit(matchId, {
      depositTxSig: txSig,
      wallet: this.wallet.publicKeyBase58(),
      seatIndex,
    });
    if (!res.ok) throw new Error(`deposit rejected: ${res.reason}`);
  }

  /**
   * 3) Seal during SEALING (§6): tlock-encrypt the prediction, register the on-chain commitment
   * with ONE wallet popup (no session key), then hand the ciphertext + blinding to the gateway so
   * the worker can decrypt + binding-check at settlement. The ciphertext the client uploads here
   * is EXACTLY what the worker reads — same store, same key derivation.
   */
  async sealPrediction(matchId: string, onchainMatchId: string, seatIndex: number, terms: TableTerms, priceFixedPoint: number): Promise<void> {
    const target = terms.timelockTargetRound; // satisfies the on-chain two-sided bound
    const ciphertext = await this.tlock.seal(priceFixedPoint, target, DRAND.chainHash, DRAND.api); // 🔵
    const { commitmentHex, blindingHex } = await this.tlock.commit(priceFixedPoint); // 🔵 H(pred||blinding)
    // One wallet popup: bind the commitment + timelock target on-chain.
    await this.chain.registerPredictionCommitment({ onchainMatchId, commitmentHex, timelockTargetRound: target }); // 🔵
    // The gateway stores ciphertext + blinding for the worker's settlement-time reveal.
    const signature = await this.wallet.signMessageBase64(`${matchId}:${commitmentHex}`); // 🔵
    this.send({ type: 'sealPrediction', matchId, seatIndex, ciphertext, commitmentHex, targetRound: target, blindingHex, signature });
  }

  /** Optional: set the pre-signed default so a timeout never costs a free check. */
  setDefault(matchId: string, def: 'check_fold' | 'check_call_any'): void {
    this.send({ type: 'setDefault', matchId, default: def });
  }

  /** 4) Act on your turn. The action is a SIGNED intent. */
  async act(matchId: string, action: BettingAction): Promise<void> {
    const intent = JSON.stringify({ matchId, action });
    const signature = await this.wallet.signMessageBase64(intent); // 🔵
    this.send({ type: 'act', matchId, action, signature });
  }

  /** 5) After SETTLED → claim; after VOID → refund. Both are idempotent/safe to retry. */
  claim(matchId: string): Promise<string> { return this.chain.claim(matchId); }   // 🔵
  refund(matchId: string): Promise<string> { return this.chain.refund(matchId); } // 🔵

  /** Subscribe to the global lobby; updates arrive as `roomsUpdated`. */
  subscribeLobby(filter?: { feed?: string; template?: string; buyIn?: number }): void {
    this.send({ type: 'subscribeLobby', ...filter });
  }

  // ---- inbound gameplay handling (wire to your UI/store) ----
  private onServerMessage(msg: ServerMessage): void {
    switch (msg.type) {
      case 'tableTerms': /* render lobby terms */ break;
      case 'matchState': this.renderState(msg.state); break;
      case 'yourTurn':
        // Fair countdown from the server clock + the engine's ABSOLUTE deadline (never synthesized).
        if (msg.yourTurnDeadline !== undefined) {
          const ms = remainingMs(msg.yourTurnDeadline, Date.now() - this.clockOffsetMs, Date.now());
          this.renderTurnTimer(ms);
        }
        break;
      case 'lobbyList':
      case 'roomsUpdated':
        // Update the lobby store; discard out-of-order roomsUpdated by `update.version`.
        break;
      case 'settled':
        // Resolution ceremony; reveal numbers; enable claim().
        break;
      case 'void':
        // Full refund path; reassure the user, enable refund().
        break;
    }
  }

  private renderState(_state: MatchStateView): void { /* update store */ }
  private renderTurnTimer(_remainingMs: number): void { /* update countdown UI */ }
  private send(msg: ClientMessage): void { this.ws.send(JSON.stringify(msg)); }
}

/* ------------------------------------------------------------------
 Usage sketch (player-created, signed-price, explicit seal):

   const client = new SyndicateClient({ gatewayUrl, wallet, tlock, chain, api });
   await client.connect();                                  // wallet signs the nonce

   // HOST opens the match on-chain and reports it:
   const roomCode = await client.hostCreate({
     onchainMatchId, configHash, priceTokenHex, seatIndex: 0,
   });

   // JOINERS deposit and report:
   await client.joinTable(matchPda, onchainMatchId, 1);

   // During SEALING — one wallet popup:
   await client.sealPrediction(matchPda, onchainMatchId, seatIndex, terms, 6300042); // 63000.42 @ 2dp
   client.setDefault(matchPda, 'check_fold');
   // ...on 'yourTurn'  → client.act(matchPda, { type: 'raiseTo', amount: 50 })
   // ...on 'settled'   → await client.claim(matchPda)
   // ...on 'void'      → await client.refund(matchPda)
------------------------------------------------------------------- */
