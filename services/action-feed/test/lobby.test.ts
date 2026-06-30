import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyLobbyUpdate,
  listForming,
  type FormingGamesState,
  type RoomsChannelPayload,
} from '../src/lobby.ts';

const idHandle = (w: string) => w; // identity resolver for deterministic assertions

function upsert(over: Partial<RoomsChannelPayload> = {}): RoomsChannelPayload {
  return {
    kind: 'upsert',
    matchId: 'M1',
    roomCode: 'r1',
    feedId: 'BTC/USD',
    tierId: 'tier-low',
    buyIn: 1000,
    seated: 1,
    seats: [{ seatIndex: 0, wallet: 'HOST', joinedTs: 10 }],
    maxPlayers: 5,
    fillDeadline: 10_000,
    version: 1,
    ...over,
  };
}

test('applyLobbyUpdate upserts a forming game with enriched seat handles', () => {
  const games: FormingGamesState = new Map();
  const res = applyLobbyUpdate(games, upsert(), (w) => `handle-${w}`);
  assert.ok(res);
  assert.equal(res!.evicted, false);
  assert.equal(games.size, 1);
  const game = games.get('M1')!;
  assert.equal(game.phase, 'FILLING');
  assert.deepEqual(game.seats, [{ seatIndex: 0, wallet: 'HOST', handle: 'handle-HOST', joinedTs: 10 }]);
});

test('applyLobbyUpdate is last-writer-wins on version (stale updates dropped)', () => {
  const games: FormingGamesState = new Map();
  applyLobbyUpdate(games, upsert({ version: 5, seated: 3 }), idHandle);
  // A lower-version update must not overwrite the newer state.
  const stale = applyLobbyUpdate(games, upsert({ version: 2, seated: 1 }), idHandle);
  assert.equal(stale, null);
  assert.equal(games.get('M1')!.seated, 3);
  // An equal-or-higher version applies.
  applyLobbyUpdate(games, upsert({ version: 6, seated: 4 }), idHandle);
  assert.equal(games.get('M1')!.seated, 4);
});

test("applyLobbyUpdate evicts the game on kind:'started' and reports the transition", () => {
  const games: FormingGamesState = new Map();
  applyLobbyUpdate(games, upsert({ version: 1 }), idHandle);
  const res = applyLobbyUpdate(games, upsert({ kind: 'started', version: 2 }), idHandle);
  assert.ok(res);
  assert.equal(res!.evicted, true);
  assert.equal(res!.game.matchId, 'M1');
  assert.equal(games.size, 0, 'started game removed from the forming model');
});

test('applyLobbyUpdate ignores payloads without a matchId', () => {
  const games: FormingGamesState = new Map();
  const res = applyLobbyUpdate(games, { kind: 'upsert', matchId: '' } as RoomsChannelPayload, idHandle);
  assert.equal(res, null);
  assert.equal(games.size, 0);
});

test('listForming drops past-deadline rooms and ranks fuller/sooner first', () => {
  const games: FormingGamesState = new Map();
  applyLobbyUpdate(games, upsert({ matchId: 'A', seated: 1, fillDeadline: 5_000, version: 1 }), idHandle);
  applyLobbyUpdate(games, upsert({ matchId: 'B', seated: 3, fillDeadline: 9_000, version: 1 }), idHandle);
  applyLobbyUpdate(games, upsert({ matchId: 'C', seated: 2, fillDeadline: 1_000, version: 1 }), idHandle);

  const list = listForming(games, 2_000); // C is past its deadline
  assert.deepEqual(list.map((g) => g.matchId), ['B', 'A']);
  assert.equal(games.has('C'), false, 'expired room evicted from the model');
});
