/**
 * Syndicate — reference client flow (illustrative).
 *
 * Shows the end-to-end path: connect → authenticate → deposit → seal → play → claim,
 * using the wire types from `./protocol.ts`. External integrations (wallet adapter,
 * tlock-js, Anchor program client) are behind small interfaces you implement with your
 * chosen libraries — they're marked `// 🔵 client duty`. This file documents control
 * flow; it is not meant to compile as-is.
 */
import type {
  ServerMessage, ClientMessage, BettingAction, TableTerms, MatchStateView,
} from './protocol.ts';
import { DRAND, roundAt } from './protocol.ts';

// ---- integrations you provide (🔵) ----
interface Wallet {
  publicKeyBase58(): string;
  /** ed25519 sign of utf8(message), returned base64. */
  signMessageBase64(message: string): Promise<string>;
}
interface Tlock {
  /** Encrypt fixed-point price (i128 LE bytes) toward a drand round → base64 ciphertext. */
  seal(priceFixedPoint: number, targetRound: number, chainHash: string, api: string): Promise<string>;
}
interface ChainClient {
  deposit(matchId: string, seatIndex: number): Promise<string>; // returns tx sig; resolves on finality
  claim(matchId: string): Promise<string>;
  refund(matchId: string): Promise<string>;
}

// ---------------------------------------------------------------------------

export class SyndicateClient {
  private ws!: WebSocket;
  private wallet: Wallet;
  private tlock: Tlock;
  private chain: ChainClient;
  private gatewayUrl: string;

  constructor(opts: { gatewayUrl: string; wallet: Wallet; tlock: Tlock; chain: ChainClient }) {
    this.gatewayUrl = opts.gatewayUrl;
    this.wallet = opts.wallet;
    this.tlock = opts.tlock;
    this.chain = opts.chain;
  }

  /** 1) Connect + authenticate (§3). Resolves once authenticated. */
  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.gatewayUrl);
      this.ws.onmessage = async (raw) => {
        const msg = JSON.parse(raw.data) as ServerMessage;
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

  /** 2) Deposit on-chain (buy-in + entry fee). Seat is granted on finality (§7). */
  async joinTable(matchId: string, seatIndex: number): Promise<void> {
    // UI: show buy-in + entry fee BEFORE signing — never surprise the user financially.
    await this.chain.deposit(matchId, seatIndex); // 🔵 wallet signs; resolves on finality
  }

  /** 3) Seal the prediction client-side with tlock, before LIVE (§6). */
  async sealPrediction(matchId: string, terms: TableTerms, priceFixedPoint: number): Promise<void> {
    // targetRound usually comes from terms; recompute defensively if needed.
    const target = terms.timelockTargetRound; // or roundAt(genesis, period, matchEndUnix)
    const ciphertext = await this.tlock.seal(priceFixedPoint, target, DRAND.chainHash, DRAND.api); // 🔵
    this.send({ type: 'sealPrediction', matchId, ciphertext });
  }

  /** Optional: set the pre-signed default so a timeout never costs a free check. */
  setDefault(matchId: string, def: 'check_fold' | 'check_call_any'): void {
    this.send({ type: 'setDefault', matchId, default: def });
  }

  /** 4) Act on your turn. The action is a SIGNED intent. */
  async act(matchId: string, action: BettingAction): Promise<void> {
    // UI: render exposure (toCall, minRaiseTo, remaining stack) before committing.
    const intent = JSON.stringify({ matchId, action });
    const signature = await this.wallet.signMessageBase64(intent); // 🔵
    this.send({ type: 'act', matchId, action, signature });
  }

  /** 5) After SETTLED → claim; after VOID → refund. Both are idempotent/safe to retry. */
  claim(matchId: string): Promise<string> { return this.chain.claim(matchId); }   // 🔵
  refund(matchId: string): Promise<string> { return this.chain.refund(matchId); } // 🔵

  // ---- inbound gameplay handling (wire to your UI/store) ----
  private onServerMessage(msg: ServerMessage): void {
    switch (msg.type) {
      case 'tableTerms': /* render lobby terms */ break;
      case 'matchState': this.renderState(msg.state); break;
      case 'yourTurn':
        // Prompt the player; show toCall / minRaiseTo / deadline (server clock).
        break;
      case 'event':
        // Public action-feed event → update chart, pot, opponents (seat-indexed).
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
  private send(msg: ClientMessage): void { this.ws.send(JSON.stringify(msg)); }
}

/* ------------------------------------------------------------------
 Usage sketch:

   const client = new SyndicateClient({ gatewayUrl, wallet, tlock, chain });
   await client.connect();                         // wallet signs the nonce
   await client.joinTable(matchId, seatIndex);     // deposit on-chain (finality)
   await client.sealPrediction(matchId, terms, 6300042); // 63000.42 @ 2dp
   client.setDefault(matchId, 'check_fold');
   // ...on 'yourTurn' → client.act(matchId, { type: 'raiseTo', amount: 50 })
   // ...on 'settled'  → await client.claim(matchId)
   // ...on 'void'     → await client.refund(matchId)
------------------------------------------------------------------- */
