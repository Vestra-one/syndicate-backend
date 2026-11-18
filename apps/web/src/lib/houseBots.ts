/**
 * House bots keep one public table open so the lobby is never empty. The server
 * publishes their wallets (`/v1/config.house_bot_wallets`); the UI labels them so
 * nobody is left guessing whether a seat is a person. Bots play by the same rules
 * as everyone else and get no information a player would not.
 */
let bots = new Set<string>()

export function setHouseBots(wallets?: string[] | null): void {
  bots = new Set(wallets ?? [])
}

/** True when this deployment runs a house table. */
export function hasHouseBots(): boolean {
  return bots.size > 0
}

export function isHouseBot(wallet?: string | null): boolean {
  return wallet != null && bots.has(wallet)
}

/** Handle of the bot that hosts the scheduled tables (see `HOUSE_EVENT_HANDLE`). */
const EVENT_HANDLE = 'Main_Event'

/**
 * A scheduled table: dealt on the next round wall-clock mark so people can gather for a
 * hand with other people, as opposed to the always-open house table that deals as soon as
 * one person sits.
 */
export function isScheduledTable(game: { creatorWallet?: string; creatorHandle?: string }): boolean {
  return isHouseBot(game.creatorWallet) && game.creatorHandle === EVENT_HANDLE
}

