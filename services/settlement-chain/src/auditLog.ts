/** Structured audit logs for operator-attested custody actions. */

export function logButtonSeedAssigned(fields: {
  matchId?: string;
  onchainMatchId: string;
  matchPda: string;
  button: number;
  vrfSeedHex: string;
  vrfProofHashHex: string;
  txSig: string;
}): void {
  console.log(JSON.stringify({
    event: 'button_seed_assigned',
    ts: new Date().toISOString(),
    source: 'server_csprng',
    ...fields,
  }));
}
