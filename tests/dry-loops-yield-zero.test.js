// A reviewed round that found nothing new counts toward the low-yield stop,
// as long as the tail has at least one finding.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dryVerdict } from '../src/workflow/dry-loops.js';

const group = { id: 'review', steps: ['review-area-1'], areas: ['a', 'b', 'c', 'd'], perRound: 3 };
const loopOf = (dry = 1) => ({ id: 'harden', steps: ['review', 'fix'], until: { step: 'review', dry } });
const round = (n, found, reviewed, extra = {}) => ({ round: n, reviewed, new: found, reopened: 0, repeated: 0, outOfScope: 0, ignored: 0, fix: 'runs', ...extra });
const verdict = (rounds, loop = loopOf(), g = group) => dryVerdict(loop, { findings: { rounds, known: [], knownDropped: 0 } }, g);
const first = round(1, 3, [0, 1, 2]);

test('yield zero: a tail of [0, 2] that covers every area stops by yield', () => {
  const v = verdict([first, round(2, 0, [3, 0, 1]), round(3, 2, [2, 3, 0])]);
  assert.deepEqual([v.dry, v.by], [true, 'yield']);
});

test('yield zero: a tail of [2, 0] that covers every area stops by yield', () => {
  const v = verdict([first, round(2, 2, [3, 0, 1]), round(3, 0, [2, 3, 0])]);
  assert.deepEqual([v.dry, v.by], [true, 'yield']);
});

test('yield zero: a tail of [0, 0] is left to the dry rule', () => {
  const v = verdict([first, round(2, 0, [3, 0, 1]), round(3, 0, [2, 3, 0])], loopOf(3));
  assert.equal(v.dry, false);
  assert.equal(v.by, undefined);
});

test('yield zero: a reopened finding in either round keeps the loop going', () => {
  assert.equal(verdict([first, round(2, 0, [3, 0, 1], { reopened: 1 }), round(3, 2, [2, 3, 0])]).dry, false);
  assert.equal(verdict([first, round(2, 0, [3, 0, 1]), round(3, 2, [2, 3, 0], { reopened: 1 })]).dry, false);
});

test('yield zero: a tail that leaves an area unreviewed does not stop', () => {
  assert.equal(verdict([first, round(2, 0, [3, 0, 1]), round(3, 2, [0, 1, 3])]).dry, false);
});
