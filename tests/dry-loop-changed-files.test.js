// A dry loop's reviewers are told which files the last fix changed (facts from
// the fix attempts' changedFiles). Pure unit tests of reviewRoundBlock on
// state objects; nothing dispatches. Made-up names only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FINDINGS_ANSWER, reviewRoundBlock } from '../src/workflow/dry-loops.js';
import { storedProgramV3 } from '../src/workflow/program-v3.js';

const V3 = 'bullswarm.workflow.program.v3';
const findingsAnswer = JSON.parse(JSON.stringify(FINDINGS_ANSWER));
const t = (n) => `2026-10-01T00:${String(n).padStart(2, '0')}:00.000Z`;

// [review, fix] (fixers after the review) or [fix, review] (fixFirst) loop.
// `attempts`: [{ step, at (minute), status, files }]. Round k starts at the
// kernel's `loop-harden-round-k` revision (minute 10 * k).
function stateOf({ round, fixers = ['fix'], fixFirst = false, attempts = [], skipped = [] }) {
  const steps = fixFirst
    ? [...fixers.map((id) => ({ id, lane: 'build', prompt: 'Fix the acme parser.' })),
      { id: 'review', dependsOn: fixers, prompt: 'Review the acme parser.', answer: findingsAnswer }]
    : [{ id: 'review', prompt: 'Review the acme parser.', answer: findingsAnswer },
      ...fixers.map((id) => ({ id, dependsOn: ['review'], lane: 'build', prompt: 'Fix the acme parser.' }))];
  const program = storedProgramV3({
    schemaVersion: V3,
    steps,
    loops: [{ id: 'harden', steps: [...steps.map((s) => s.id)], until: { step: 'review', dry: 1, nonFunctional: false }, maxRounds: 5 }],
  });
  const rounds = Array.from({ length: round - 1 }, (_, k) => ({
    round: k + 1, reviewed: [0], new: 1, reopened: 0, repeated: 0, outOfScope: 0, ignored: 0,
    fix: skipped.includes(k + 1) ? 'skipped' : 'runs',
  }));
  return {
    program,
    actions: program.actions.map((a) => ({ id: a.id, status: 'succeeded', attempts: 1 })),
    attempts: attempts.map((a, i) => ({
      id: `att-${i}`, actionId: a.step, ordinal: i + 1, status: a.status ?? 'succeeded', startedAt: t(a.at),
      ...(a.files ? { changedFiles: a.files } : {}),
    })),
    revisions: Array.from({ length: round - 1 }, (_, k) => ({ id: `loop-harden-round-${k + 2}`, status: 'applied', processedAt: t(10 * (k + 2)) })),
    controlNodes: [{ id: 'harden', type: 'loop', status: 'pending', at: null, round, maxRounds: 5, findings: { rounds, known: [], knownDropped: 0 } }],
  };
}

const lineOf = (block) => block.split('\n').find((line) => /fix changed|recorded no changed file/.test(line)) ?? null;

test('round 2 lists the files the round before changed', () => {
  const state = stateOf({ round: 2, attempts: [{ step: 'fix', at: 5, files: ['src/b.js', 'src/a.js'] }] });
  const block = reviewRoundBlock(state, { id: 'review' });
  assert.equal(lineOf(block), "Round 1's fix changed these files: src/a.js, src/b.js.");
  const lines = block.split('\n');
  assert.match(lines[lines.indexOf(lineOf(block)) - 1], /^Round 1's findings went to fix/, 'the line follows the findings-went-to line');
  assert.doesNotMatch(block, /skip|ignore/i.test(lineOf(block)) ? /x^/ : /\bskip\b/, 'facts only');
});

test('round 1 has no such line', () => {
  assert.equal(lineOf(reviewRoundBlock(stateOf({ round: 1 }), { id: 'review' })), null);
});

test('at most 30 paths are listed, sorted, then the count of the rest', () => {
  const files = Array.from({ length: 34 }, (_, i) => `src/f${String(i).padStart(2, '0')}.js`).reverse();
  const block = reviewRoundBlock(stateOf({ round: 2, attempts: [{ step: 'fix', at: 5, files }] }), { id: 'review' });
  const line = lineOf(block);
  const listed = line.replace(/^.*these files: /, '').replace(/ \(and 4 more\)\.$/, '').split(', ');
  assert.equal(listed.length, 30);
  assert.deepEqual(listed, [...listed].sort());
  assert.equal(listed[0], 'src/f00.js');
  assert.match(line, / \(and 4 more\)\.$/);
});

test('a skipped fix gives no line', () => {
  const state = stateOf({ round: 2, skipped: [1], attempts: [{ step: 'fix', at: 5, files: ['src/a.js'] }] });
  assert.equal(lineOf(reviewRoundBlock(state, { id: 'review' })), null);
});

test('a fixer with no changedFiles: says none recorded when it succeeded, nothing when it failed', () => {
  const ok = stateOf({ round: 2, attempts: [{ step: 'fix', at: 5 }] });
  assert.equal(lineOf(reviewRoundBlock(ok, { id: 'review' })), "Round 1's fix recorded no changed file.");
  const empty = stateOf({ round: 2, attempts: [{ step: 'fix', at: 5, files: [] }] });
  assert.equal(lineOf(reviewRoundBlock(empty, { id: 'review' })), "Round 1's fix recorded no changed file.");
  const failed = stateOf({ round: 2, attempts: [{ step: 'fix', at: 5, status: 'failed' }] });
  assert.equal(lineOf(reviewRoundBlock(failed, { id: 'review' })), null);
});

test('two fixers give the union of their files', () => {
  const state = stateOf({
    round: 2, fixers: ['fix-a', 'fix-b'],
    attempts: [{ step: 'fix-a', at: 5, files: ['src/a.js', 'src/shared.js'] }, { step: 'fix-b', at: 6, files: ['src/b.js', 'src/shared.js'] }],
  });
  assert.equal(lineOf(reviewRoundBlock(state, { id: 'review' })), "Round 1's fix changed these files: src/a.js, src/b.js, src/shared.js.");
});

test('only the previous round counts: earlier rounds and the latest attempt per fixer', () => {
  const state = stateOf({
    round: 3,
    attempts: [
      { step: 'fix', at: 5, files: ['src/round1.js'] },
      { step: 'fix', at: 15, status: 'failed', files: ['src/stale.js'] },
      { step: 'fix', at: 16, files: ['src/round2.js'] },
    ],
  });
  assert.equal(lineOf(reviewRoundBlock(state, { id: 'review' })), "Round 2's fix changed these files: src/round2.js.");
});

test('a fixer that runs before the review: the fix that ran before this review counts', () => {
  const state = stateOf({
    round: 2, fixFirst: true,
    attempts: [{ step: 'fix', at: 5, files: ['src/old.js'] }, { step: 'fix', at: 12, files: ['src/new.js'] }],
  });
  assert.equal(lineOf(reviewRoundBlock(state, { id: 'review' })), "Round 1's fix changed these files: src/new.js.");
});

test('a reviewer blind to the fixer still gets the list (facts about the tree)', () => {
  const state = stateOf({ round: 2, attempts: [{ step: 'fix', at: 5, files: ['src/a.js'] }] });
  assert.equal(lineOf(reviewRoundBlock(state, { id: 'review', blindTo: ['fix'] })), "Round 1's fix changed these files: src/a.js.");
});
