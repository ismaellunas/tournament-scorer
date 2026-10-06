'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Engine = require('../src/engine.js');

const SIZES = [4, 5, 6, 8, 11, 13, 16];
const RUNS_PER_SIZE = 200;

function makeTeams(T) {
  const teams = [];
  for (let i = 1; i <= T; i++) teams.push({ id: `t${i}`, name: `Team ${i}`, players: '' });
  return teams;
}

// Plays the whole bracket out with random winners, returns the final
// bracket plus a log of every result applied (in play order).
function simulateRandom(teams, rng) {
  let results = {};
  let at = 1;
  let guard = 0;
  while (true) {
    const bracket = Engine.computeBracket(teams, results);
    if (bracket.playable.length === 0) return { bracket, results };
    const m = bracket.playable[Math.floor(rng() * bracket.playable.length)];
    const winnerId = rng() < 0.5 ? m.slotA.teamId : m.slotB.teamId;
    results = Engine.setResult(teams, results, m.id, winnerId, at++);
    if (++guard > 10000) throw new Error('simulation did not terminate');
  }
}

// Small deterministic PRNG so failures are reproducible from the seed.
function mulberry32(seed) {
  let a = seed;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

for (const T of SIZES) {
  test(`T=${T}: ${RUNS_PER_SIZE} random simulations are structurally valid`, () => {
    for (let run = 0; run < RUNS_PER_SIZE; run++) {
      const rng = mulberry32(T * 100000 + run);
      const teams = makeTeams(T);
      const { bracket, results } = simulateRandom(teams, rng);
      const seedInfo = `T=${T} run=${run}`;

      // 1. Match count: 2T-2 with no reset, 2T-1 with a reset.
      const expected = bracket.resetPlayed ? 2 * T - 1 : 2 * T - 2;
      assert.equal(bracket.totalReal, expected, `${seedInfo}: match count`);

      // 2. Champion always exists.
      assert.ok(bracket.champion, `${seedInfo}: champion exists`);

      const lossCount = {};
      for (const team of teams) lossCount[team.id] = 0;

      for (const id of bracket.order) {
        const m = bracket.matches[id];
        if (m.isBye) continue;

        // 3. No team ever appears twice in one match.
        if (m.slotA.kind === 'team' && m.slotB.kind === 'team') {
          assert.notEqual(m.slotA.teamId, m.slotB.teamId, `${seedInfo}: ${id} has same team twice`);
        }

        if (m.loser.kind === 'team') lossCount[m.loser.teamId]++;
      }

      // 4. No team plays after its second loss (every non-champion team
      //    loses exactly twice; the champion loses 0 or 1 times).
      for (const team of teams) {
        if (team.id === bracket.champion) {
          assert.ok(lossCount[team.id] <= 1, `${seedInfo}: champion ${team.id} losses <= 1`);
        } else {
          assert.equal(lossCount[team.id], 2, `${seedInfo}: ${team.id} losses == 2`);
        }
      }

      // 5. Every team gets a unique or tied placing.
      for (const team of teams) {
        const status = bracket.teamStatus[team.id];
        assert.ok(status.label.startsWith('Champion') || status.label.startsWith('Eliminated'),
          `${seedInfo}: ${team.id} has a terminal status, got "${status.label}"`);
      }
      const places = teams.map((t) => bracket.placings.placeOf[t.id] || (t.id === bracket.champion ? { place: 1 } : null));
      assert.ok(places.every(Boolean), `${seedInfo}: every team has a place`);

      // 7 (partial, see below for the explicit prune test): results actually
      // recorded all round-trip through computeBracket consistently.
      const recount = Engine.computeBracket(teams, results);
      assert.equal(recount.champion, bracket.champion, `${seedInfo}: recompute is stable`);
    }
  });
}

test('6. forcing GF1 outcomes controls whether GF2 appears', () => {
  const teams = makeTeams(4); // N=4, k=2: W1,W2 x1 each, L1,L2 x1 each, GF1/GF2
  let results = {};
  let at = 1;
  const play = (id, winnerId) => { results = Engine.setResult(teams, results, id, winnerId, at++); };

  // Drive a specific path: 1 beats 4, 2 beats 3 in W1; so W1-1: t1 v t4, W1-2: t2 v t3 (seed order [1,4,2,3]).
  let b = Engine.computeBracket(teams, results);
  assert.equal(b.matches['W1-1'].slotA.teamId, 't1');
  assert.equal(b.matches['W1-1'].slotB.teamId, 't4');
  assert.equal(b.matches['W1-2'].slotA.teamId, 't2');
  assert.equal(b.matches['W1-2'].slotB.teamId, 't3');

  play('W1-1', 't1'); // t4 drops to L1
  play('W1-2', 't2'); // t3 drops to L1
  play('L1-1', 't4');  // t3 eliminated (2nd loss would be here only if they'd lost twice; t3 has 1 loss so far)
  play('W2-1', 't1');  // t2 drops to L2, faces t4
  play('L2-1', 't4');  // t2 eliminated (2 losses)
  // t4 is now losers-bracket champion with 1 loss, t1 is winners-bracket champion with 0 losses.

  // Case A: winners-bracket champion (t1) wins GF1 -> GF2 skipped.
  let resultsA = Engine.setResult(teams, results, 'GF1', 't1', at++);
  let bA = Engine.computeBracket(teams, resultsA);
  assert.equal(bA.champion, 't1');
  assert.equal(bA.matches.GF2.isBye, true, 'GF2 should be skipped');
  assert.equal(bA.resetPlayed, false);
  assert.equal(bA.totalReal, 2 * 4 - 2);

  // Case B: losers-bracket champion (t4) wins GF1 -> GF2 required and playable.
  let resultsB = Engine.setResult(teams, results, 'GF1', 't4', at++);
  let bB = Engine.computeBracket(teams, resultsB);
  assert.equal(bB.champion, null, 'no champion yet, GF2 still pending');
  assert.equal(bB.matches.GF2.isBye, false, 'GF2 should be playable');
  assert.equal(bB.matches.GF2.winner.kind, 'pending');
  const gf2Playable = bB.playable.some((m) => m.id === 'GF2');
  assert.ok(gf2Playable, 'GF2 should appear in the playable queue');

  // Finish case B: t1 wins the reset -> t1 champion, GF2 counted as real.
  let resultsB2 = Engine.setResult(teams, resultsB, 'GF2', 't1', at++);
  let bB2 = Engine.computeBracket(teams, resultsB2);
  assert.equal(bB2.champion, 't1');
  assert.equal(bB2.resetPlayed, true);
  assert.equal(bB2.totalReal, 2 * 4 - 1);
});

test('7. changing an early winner prunes downstream results', () => {
  const teams = makeTeams(4);
  let results = {};
  let at = 1;
  const play = (id, winnerId) => { results = Engine.setResult(teams, results, id, winnerId, at++); };

  play('W1-1', 't1');
  play('W1-2', 't2');
  play('L1-1', 't4');
  play('W2-1', 't1');
  play('L2-1', 't4');
  play('GF1', 't1');

  assert.ok(results['GF1'], 'sanity: GF1 has a result before the change');
  assert.ok(results['W2-1'], 'sanity: W2-1 has a result before the change');

  // Now change W1-1's winner from t1 to t4. This invalidates everything
  // downstream that assumed t1 was the W1-1 winner.
  const changed = Engine.setResult(teams, results, 'W1-1', 't4', at++);
  const { prunedResults, removedIds } = Engine.diffPrune(teams, results, changed);

  assert.ok(removedIds.includes('L1-1'), 'L1-1 depended on who lost W1-1');
  assert.ok(removedIds.includes('W2-1'), 'W2-1 depended on W1-1 winner advancing');
  assert.ok(removedIds.includes('L2-1'), 'L2-1 is downstream of W2-1 and L1-1');
  assert.ok(removedIds.includes('GF1'), 'GF1 is downstream of everything');
  assert.ok(!('W1-2' in prunedResults) === false, 'W1-2 is unrelated and must survive');
  assert.ok(prunedResults['W1-2'], 'W1-2 untouched result survives pruning');

  // The pruned result set must itself be valid (idempotent under pruning).
  const reprune = Engine.pruneResults(teams, prunedResults);
  assert.deepEqual(Object.keys(reprune).sort(), Object.keys(prunedResults).sort());

  const finalBracket = Engine.computeBracket(teams, prunedResults);
  assert.equal(finalBracket.matches['W1-1'].winner.teamId, 't4');
  assert.equal(finalBracket.champion, null, 'tournament is no longer finished after the cascade');
});

test('undo last removes the most recently recorded result', () => {
  const teams = makeTeams(4);
  let results = {};
  results = Engine.setResult(teams, results, 'W1-1', 't1', 10);
  results = Engine.setResult(teams, results, 'W1-2', 't2', 20);
  const lastId = Engine.findLastResultId(results);
  assert.equal(lastId, 'W1-2');
  const after = Engine.clearResult(results, lastId);
  assert.ok(!after['W1-2']);
  assert.ok(after['W1-1']);
});

test('seed order matches the spec reference sequences', () => {
  assert.deepEqual(Engine.seedOrder(4), [1, 4, 2, 3]);
  assert.deepEqual(Engine.seedOrder(8), [1, 8, 4, 5, 2, 7, 3, 6]);
  assert.deepEqual(Engine.seedOrder(16), [1, 16, 8, 9, 4, 13, 5, 12, 2, 15, 7, 10, 3, 14, 6, 11]);
});

test('N=8 match graph matches the spec reference table', () => {
  const teams = makeTeams(8);
  const b = Engine.computeBracket(teams, {});
  const label = (slot) => slot.kind === 'team' ? teams.findIndex((t) => t.id === slot.teamId) + 1 : slot.kind;

  assert.deepEqual([label(b.matches['W1-1'].slotA), label(b.matches['W1-1'].slotB)], [1, 8]);
  assert.deepEqual([label(b.matches['W1-2'].slotA), label(b.matches['W1-2'].slotB)], [4, 5]);
  assert.deepEqual([label(b.matches['W1-3'].slotA), label(b.matches['W1-3'].slotB)], [2, 7]);
  assert.deepEqual([label(b.matches['W1-4'].slotA), label(b.matches['W1-4'].slotB)], [3, 6]);

  assert.equal(b.matches['W2-1'].slotA.kind, 'pending');
  assert.equal(b.matches['L1-1'].slotA.kind, 'pending');

  const numberOrder = b.order.filter((id) => !b.matches[id].isBye);
  assert.deepEqual(numberOrder, [
    'W1-1', 'W1-2', 'W1-3', 'W1-4',
    'L1-1', 'L1-2',
    'W2-1', 'W2-2',
    'L2-1', 'L2-2',
    'L3-1',
    'W3-1',
    'L4-1',
    'GF1', 'GF2',
  ]);
});

test('N=16 numbering order matches the spec reference', () => {
  const teams = makeTeams(16);
  const b = Engine.computeBracket(teams, {});
  const numberOrder = b.order.filter((id) => !b.matches[id].isBye);
  assert.deepEqual(numberOrder, [
    'W1-1', 'W1-2', 'W1-3', 'W1-4', 'W1-5', 'W1-6', 'W1-7', 'W1-8',
    'L1-1', 'L1-2', 'L1-3', 'L1-4',
    'W2-1', 'W2-2', 'W2-3', 'W2-4',
    'L2-1', 'L2-2', 'L2-3', 'L2-4',
    'L3-1', 'L3-2',
    'W3-1', 'W3-2',
    'L4-1', 'L4-2',
    'L5-1',
    'W4-1',
    'L6-1',
    'GF1', 'GF2',
  ]);
});

test('byes only exist for seeds greater than T', () => {
  const teams = makeTeams(5); // N=8, byes at seeds 6,7,8
  const b = Engine.computeBracket(teams, {});
  // seed order for N=8: [1,8,4,5,2,7,3,6] -> seeds 8,7,6 are byes
  assert.equal(b.matches['W1-1'].slotB.kind, 'bye'); // seed 8
  assert.equal(b.matches['W1-1'].slotA.kind, 'team'); // seed 1
  assert.equal(b.matches['W1-3'].slotB.kind, 'bye'); // seed 7
  assert.equal(b.matches['W1-4'].slotB.kind, 'bye'); // seed 6
  assert.equal(b.matches['W1-2'].slotA.kind, 'team'); // seed 4 (T=5, real)
  assert.equal(b.matches['W1-2'].slotB.kind, 'team'); // seed 5 (T=5, real)
});
