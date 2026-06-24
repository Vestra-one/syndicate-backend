import type { Bet, Direction, PriceTick, Round } from '@/lib/types'

/**
 * Transport-agnostic contract between the game server and the client.
 *
 * Today this is backed by an in-browser mock ({@link createMockFeed}); swapping
 * in a real WebSocket implementation later means implementing this same
 * interface and pointing the store at it — no UI changes required.
 */

export type FeedEvent =
  | { type: 'tick'; tick: PriceTick }
  | { type: 'round'; round: Round } // any round create/phase-change/settle
  | { type: 'bet'; bet: Bet } // server-acknowledged bet (yours or others')

export type FeedListener = (event: FeedEvent) => void

export interface GameFeed {
  /** Begin streaming. Resolves once the initial snapshot has been delivered. */
  connect(): Promise<void>
  disconnect(): void
  subscribe(listener: FeedListener): () => void
  /** Request to place a bet on the current open round. */
  placeBet(direction: Direction, amount: number): void
}
