// A review round never gives two reviewers the same area (rotation with
// several non-functional areas), and coverRounds names the real first round
// by which every area has been reviewed. Made-up area names only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FINDINGS_ANSWER, coverRounds, isNonFunctionalArea, roundAreas } from '../src/workflow/dry-loops.js';
import { normaliseProgramV3, storedProgramV3 } from '../src/workflow/program-v3.js';
import { programAdvisories } from '../src/workflow/action-validator.js';

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

const dryAdvice = (areas, areasPerRound, maxRounds, dry) => {
  const program = {
    schemaVersion: 'bullswarm.workflow.program.v3',
    steps: [
      { id: 'build', lane: 'build', prompt: 'Build the acme parser.' },
      { id: 'review', dependsOn: ['build'], blindTo: ['build'], prompt: 'Review the acme parser.', answer: JSON.parse(JSON.stringify(FINDINGS_ANSWER)), areas, areasPerRound },
      { id: 'fix', dependsOn: ['review'], lane: 'build', prompt: 'Fix the acme parser.' },
      { id: 'ship', dependsOn: ['harden'], prompt: 'Ship the acme parser.' },
    ],
    loops: [{ id: 'harden', steps: ['review', 'fix'], until: { step: 'review', dry, nonFunctional: false, yield: false }, maxRounds }],
  };
  try { normaliseProgramV3(program); } catch { return null; }
  return programAdvisories(storedProgramV3(program)).find((item) => item.code === 'dry-loop-too-short')?.message ?? null;
};

test('the dry-loop-too-short advice names an areasPerRound that covers every area in the rounds left', () => {
  let advised = 0;
  for (let f = 1; f <= 5; f += 1) {
    for (let nf = 1; nf <= 3; nf += 1) {
      const areas = [...FUNCTIONAL.slice(0, f), ...NON_FUNCTIONAL.slice(0, nf)];
      for (let perRound = 1; perRound <= 4; perRound += 1) {
        for (let maxRounds = 2; maxRounds <= 5; maxRounds += 1) {
          for (let dry = 1; dry <= 3; dry += 1) {
            if (perRound > areas.length) continue;
            const message = dryAdvice(areas, perRound, maxRounds, dry);
            const named = message?.match(/areasPerRound to (\d+)/);
            if (!named) continue;
            advised += 1;
            const label = `f=${f} nf=${nf} p=${perRound} max=${maxRounds} dry=${dry}: ${message}`;
            assert.ok(Number(named[1]) > perRound, label);
            assert.ok(coverRounds(areas, Number(named[1])) <= maxRounds - 1, label);
          }
        }
      }
    }
  }
  assert.ok(advised > 0, 'the sweep produced advice to check');
});

test('2 functional + 3 non-functional areas, 2 per round, 3 rounds, dry 1: advice skips 3 (needs 3 rounds) and names 4', () => {
  const areas = [...FUNCTIONAL.slice(0, 2), ...NON_FUNCTIONAL];
  assert.equal(coverRounds(areas, 3), 3);
  assert.equal(coverRounds(areas, 4), 2);
  const message = dryAdvice(areas, 2, 3, 1);
  assert.match(message, /raise maxRounds to 4 or areasPerRound to 4$/);
});

test('no areasPerRound is suggested when none covers the areas in the rounds left', () => {
  const areas = [...FUNCTIONAL.slice(0, 5), ...NON_FUNCTIONAL];
  const message = dryAdvice(areas, 1, 2, 1);
  assert.ok(message, 'the loop is too short');
  assert.doesNotMatch(message, /areasPerRound to/);
});
