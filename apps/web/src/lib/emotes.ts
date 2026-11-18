/** Table talk — the fixed reactions a seated player can send. Ids match the server's set. */
export const EMOTES = [
  { id: 'nice', label: 'Nice call' },
  { id: 'bluff', label: 'Bluff?' },
  { id: 'sweat', label: 'Sweating' },
  { id: 'lol', label: 'Ha!' },
  { id: 'wow', label: 'Wow' },
  { id: 'gg', label: 'GG' },
] as const

export type EmoteId = (typeof EMOTES)[number]['id']

export function emoteLabel(id: string): string {
  return EMOTES.find((e) => e.id === id)?.label ?? id
}
