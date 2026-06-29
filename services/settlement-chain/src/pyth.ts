// NOTE: v1 settlement uses the signed-price-server (see the `/internal/pyth/resolve`
// proxy in `main.ts`), NOT Pyth Hermes. The Hermes fetch/select scaffolding that used
// to live here has been removed. Only the small, oracle-agnostic helpers that `main.ts`
// still relies on remain in this file.

export function normalizeFeedIdHex(value: unknown): string {
  if (typeof value !== 'string') throw new Error('feed id must be a string');
  const hex = value.trim().toLowerCase().replace(/^0x/, '');
  if (!/^[0-9a-f]{64}$/.test(hex)) throw new Error('feed id must be 32-byte hex');
  return `0x${hex}`;
}

export function redactSecrets(value: unknown, secrets: string[]): string {
  let out = typeof value === 'string' ? value : JSON.stringify(value);
  for (const secret of secrets.filter(Boolean)) out = out.split(secret).join('[REDACTED]');
  out = out.replace(/\[(?:\s*\d{1,3}\s*,){63}\s*\d{1,3}\s*\]/g, '[REDACTED_KEYPAIR]');
  return out;
}
