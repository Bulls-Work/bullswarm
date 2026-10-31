// A review round never gives two reviewers the same area (rotation with
// several non-functional areas), and coverRounds names the real first round
// by which every area has been reviewed. Made-up area names only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { coverRounds, isNonFunctionalArea, roundAreas } from '../src/workflow/dry-loops.js';

const FUNCTIONAL = ['parsing', 'joins', 'transactions', 'indexes lookup', 'views'];
const NON_FUNCTIONAL = ['query speed on 100k rows', 'code readability', 'test coverage'];

function sweep(visit) {
  for (let f = 1; f <= 5; f += 1) {
    for (let nf = 1; nf <= 3; nf += 1) {
      const areas = [...FUNCTIONAL.slice(0, f), ...NON_FUNCTIONAL.slice(0, nf)];
      for (let perRound = 1; perRound <= 5; perRound += 1) {
        if (perRound <= areas.length) visit(areas, perRound, `f=${f} nf=${nf} p=${perRound}`);
      }
    }
  }
}

test('the sweep uses areas that are recognised as functional and non-functional', () => {
  assert.ok(FUNCTIONAL.every((area) => !isNonFunctionalArea(area)));
  assert.ok(NON_FUNCTIONAL.every((area) => isNonFunctionalArea(area)));
});

test('no round gives two reviewers the same area', () => {
  sweep((areas, perRound, label) => {
    for (let round = 1; round <= 6; round += 1) {
      const picked = roundAreas(areas, perRound, round);
      assert.equal(picked.length, perRound, `${label} round ${round}`);
      assert.equal(new Set(picked).size, picked.length, `${label} round ${round}: ${JSON.stringify(picked)}`);
    }
  });
});

test('coverRounds is the first round by which every area has been reviewed', () => {
  sweep((areas, perRound, label) => {
    const seen = new Set();
    let first = 0;
    for (let round = 1; round <= 12 && !first; round += 1) {
      roundAreas(areas, perRound, round).forEach((index) => seen.add(index));
      if (seen.size === areas.length) first = round;
    }
    assert.equal(coverRounds(areas, perRound), first, label);
  });
});

test('one non-functional area rotates as before', () => {
  const areas = ['parsing', 'joins', 'transactions', 'code readability'];
  const rounds = (perRound) => [1, 2, 3, 4, 5, 6].map((round) => roundAreas(areas, perRound, round));
  assert.deepEqual(rounds(3), [[0, 1, 3], [2, 0, 3], [1, 2, 3], [0, 1, 3], [2, 0, 3], [1, 2, 3]]);
  assert.deepEqual(rounds(2), [[0, 3], [1, 3], [2, 3], [0, 3], [1, 3], [2, 3]]);
  assert.equal(coverRounds(areas, 3), 2);
  assert.equal(coverRounds(areas, 2), 3);
});
