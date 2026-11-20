/**
 * Table talk — the fixed reactions a seated player can send. Ids match the server's set.
 * `level` is what your Fibs level must be to use one: the first three are free, the rest
 * are earned at the table.
 */
export const EMOTES = [
  { id: 'nice', label: 'Nice call', level: 1 },
  { id: 'gg', label: 'GG', level: 1 },
  { id: 'lol', label: 'Ha!', level: 1 },
  { id: 'bluff', label: 'Bluff?', level: 2 },
  { id: 'sweat', label: 'Sweating', level: 3 },
  { id: 'wow', label: 'Wow', level: 4 },
] as const

export type EmoteId = (typeof EMOTES)[number]['id']

export function emoteLabel(id: string): string {
  // A typed line travels as "say:<text>"; it is shown as text, never as markup.
  if (id.startsWith('say:')) return id.slice(4)
  return EMOTES.find((e) => e.id === id)?.label ?? id
}
