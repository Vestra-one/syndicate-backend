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

export function isHouseBot(wallet?: string | null): boolean {
  return wallet != null && bots.has(wallet)
}
