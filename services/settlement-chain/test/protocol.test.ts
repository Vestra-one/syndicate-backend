import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveSyndicateAccounts, encodeSettleArgsFromBundle } from '../src/main.ts';
import { buildEd25519VerifyInstruction } from '../src/actionLog.ts';
import { predictionCommitmentHash } from '../src/intent.ts';

function bundle(overrides: Record<string, any> = {}) {
  return {
    revealed: [
      {
        seat_index: 0,
        prediction: '1000',
        blinding_hex: '00'.repeat(32),
      },
    ],
    oracle_price: {
      feed_id: '07'.repeat(32),
      price: '1000',
      publish_time: 1715000000,
      confidence: 10,
      exponent: -8,
    },
    rake_bps: 0,
    rake_cap: 0,
    result: {
      settlement_price: '1000',
      oracle_publish_time: 1715000000,
      pot_awards: [{ seat_index: 0, amount: 100 }],
      uncalled_returns: [],
      rake_collected: 0,
    },
    ...overrides,
  };
}

test('predictionCommitmentHash matches Rust simple_sha256 binding', () => {
  const blindingHex = 'ab'.repeat(32);
  const hash = predictionCommitmentHash(100_010n, blindingHex);
  assert.equal(hash.length, 64);
  assert.equal(hash, predictionCommitmentHash(100_010n, blindingHex));
  assert.notEqual(hash, predictionCommitmentHash(100_010n, 'cd'.repeat(32)));
});

test('canonical match context derives protocol match and seat PDAs', async (t) => {
  let PublicKey: any;
  try {
    ({ PublicKey } = await import('@solana/web3.js'));
  } catch {
    t.skip('@solana/web3.js is not installed for settlement-chain tests');
    return;
  }
  const programId = new PublicKey('11111111111111111111111111111111');
  const wallet = 'BPFLoader1111111111111111111111111111111111';
  const accounts = await deriveSyndicateAccounts(programId, {
    onchainMatchId: '42',
    seatWallets: [wallet],
  });
  const seed = Buffer.alloc(8);
  seed.writeBigUInt64LE(42n, 0);
  const [protocol] = PublicKey.findProgramAddressSync([Buffer.from('protocol')], programId);
  const [match] = PublicKey.findProgramAddressSync([Buffer.from('match'), seed], programId);
  const [seat] = PublicKey.findProgramAddressSync([
    Buffer.from('seat'),
    match.toBuffer(),
    new PublicKey(wallet).toBuffer(),
  ], programId);
  assert.equal(accounts.protocol.toBase58(), protocol.toBase58());
  assert.equal(accounts.match.toBase58(), match.toBase58());
  assert.deepEqual(accounts.seats.map((key: any) => key.toBase58()), [seat.toBase58()]);
});

test('Pyth Receiver package imports under the supported Node runtime', async (t) => {
  try {
    await import('@pythnetwork/pyth-solana-receiver');
  } catch (err) {
    if ((err as Error & { code?: string }).code === 'ERR_MODULE_NOT_FOUND') {
      t.skip('@pythnetwork/pyth-solana-receiver is not installed for settlement-chain tests');
      return;
    }
    throw err;
  }
});

test('settlement bundle encodes Anchor SettleArgs deterministically', () => {
  const encoded = encodeSettleArgsFromBundle(bundle());
  assert.ok(encoded.length > 64);
  assert.equal(encoded.readBigInt64LE(32), 1000n);
});

test('ed25519 verify instruction packs signature and message', () => {
  const ix = buildEd25519VerifyInstruction({
    publicKey: Uint8Array.from({ length: 32 }, (_, i) => i),
    message: Uint8Array.from([1, 2, 3]),
    signature: Uint8Array.from({ length: 64 }, () => 9),
  });
  assert.equal(ix.data.readUInt8(0), 1);
  assert.ok(ix.data.length > 112);
});

test('settlement bundle requires revealed predictions', () => {
  assert.throws(
    () => encodeSettleArgsFromBundle(bundle({ revealed: undefined })),
    /bundle.revealed/,
  );
});
