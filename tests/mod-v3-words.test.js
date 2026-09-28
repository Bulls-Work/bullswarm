// The Claude mod's words for v3 runs (0.37.0, wave E): a run's checked answer
// in its verdict note, a launched workflow's watch mode, a run waiting at a
// gate or an out-of-rounds loop with the command that moves it, and loop
// rounds read out of `workflow watch` / `workflow wait` output. The inputs
// are real outputs of a grok run (tests/fixtures/v3-runs).
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseVerdict, verdictContext, watchContext } from '../mods/bullswarm/hooks/verdict.ts';
import { parseRuns, runLine } from '../mods/bullswarm/hooks/runs.ts';
import { readFileSync } from 'node:fs';

const RUN_JSON = JSON.stringify({
  ok: true, why: 'all 1 step succeeded', failureKind: null, retryAfter: null, runId: 'wf-mulitn5f-6c56dd', shortId: '5r8jyi',
  pick: { pool: 'grok', model: 'grok-4.7' }, outFile: '/tmp/out-task-attempt-1.md',
  answer: { words: 13 }, answerCheck: { ok: true, errors: [], file: '/tmp/answer-task-attempt-1.json' },
});

test('a run verdict carries its checked answer into the note', () => {
  const verdict = parseVerdict(RUN_JSON, 0);
  assert.deepEqual(verdict.answer, { words: 13 });
  assert.equal(verdict.answerOk, true);
  const note = verdictContext('run', verdict);
  assert.match(note, /answer \{"words":13\} \(checked against its schema\)/);
  const failed = parseVerdict(JSON.stringify({
    ok: false, why: 'answer does not match its schema', failureKind: 'schema', shortId: '5r8jyi', pick: { pool: 'grok' },
    outFile: '/tmp/out.md', answer: null, answerCheck: { ok: false, errors: ['words must be integer'], file: '/tmp/a.json' },
  }), 1);
  assert.match(verdictContext('run', failed), /answer check failed: words must be integer/);
  const plain = parseVerdict(JSON.stringify({ ok: true, why: 'all 1 step succeeded', pick: { pool: 'grok' }, outFile: '/tmp/o.md' }), 0);
  assert.doesNotMatch(verdictContext('run', plain), /answer/, 'a run with no answer schema claims no answer');
});

test('a launched workflow is watched with --until trouble, which wakes at a gate', () => {
  const note = verdictContext('workflow goal', parseVerdict(JSON.stringify({ ok: true, shortId: '2fne62', runId: 'wf-mulitifp-c82a30' }), 0));
  assert.match(note, /bullswarm workflow watch 2fne62 --until trouble/);
  assert.match(note, /gate/);
  assert.doesNotMatch(note, /never waits for you/);
});

test('a foreground goal that parked names the gate and the continue command', () => {
  const doc = {
    action: 'workflow-waiting', runId: 'wf-mulitifp-c82a30', shortId: '2fne62', status: 'waiting',
    waitingFor: [{ id: 'approve', type: 'gate', since: '2026-09-28T17:31:44.628Z', note: 'Read NOTE.md and decide whether to write DONE.md' }],
    next: ['bullswarm workflow continue 2fne62 approve'],
  };
  const note = verdictContext('workflow goal', parseVerdict(JSON.stringify(doc), 0));
  assert.match(note, /2fne62 is waiting for you at gate approve \(Read NOTE\.md and decide whether to write DONE\.md\)/);
  assert.match(note, /bullswarm workflow continue 2fne62 approve/);
});

test('watch and wait output: waiting at a gate, the loop round, and the answers read out', () => {
  const watch = [
    '✓ count finished · unproven · 35s',
    '  answer {"lines":4,"short":true}',
    "↻ loop polish round 2 of 3 · check's evidence passed did not hold",
    '✓ check finished · proven by command · 52s',
    '  answer {"lines":2,"passed":true}',
    "✓ loop polish passed in round 2 of 3 · check's evidence passed",
    '⧖ gate approve waiting · Read NOTE.md and decide whether to write DONE.md · continue: bullswarm workflow continue 2fne62 approve',
    'outcome: waiting',
    'waiting: gate approve · Read NOTE.md and decide whether to write DONE.md',
    'next: bullswarm workflow continue 2fne62 approve',
  ].join('\n');
  const note = watchContext(watch);
  assert.match(note, /waiting for you at gate approve/);
  assert.match(note, /bullswarm workflow continue 2fne62 approve/);
  assert.match(note, /loop polish passed in round 2 of 3/);
  assert.match(note, /2 checked answers/);
  const outOfRounds = watchContext([
    "⧖ loop polish out of rounds (3 of 3) · check's evidence passed did not hold · continue: bullswarm workflow continue 2fne62 polish --rounds <n>",
    'outcome: waiting',
    "waiting: loop polish · out of rounds (3 of 3); check's evidence passed did not hold",
    'next: bullswarm workflow continue 2fne62 polish --rounds <1-5>   (more rounds; without --rounds the loop passes as it stands)',
  ].join('\n'));
  assert.match(outOfRounds, /loop polish is out of rounds \(3 of 3\)/);
  assert.match(outOfRounds, /--rounds/);
  assert.equal(watchContext('✓ count finished · unproven · 35s'), null, 'nothing v3 to say about a plain step line');
});

test('the strip and prompt context list a waiting run with where it waits', () => {
  const runs = parseRuns(JSON.stringify({ runs: [{
    runId: 'wf-mulitifp-c82a30', shortId: '2fne62', legacy: false, goal: 'Write a two-line note, then wait for approval',
    status: 'waiting', startedAt: '2026-09-28T17:28:00.114Z', ongoing: true, actionsSucceeded: 3, actionsTotal: 4,
    waitingFor: [{ id: 'approve', type: 'gate', since: '2026-09-28T17:31:44.628Z', note: 'Read NOTE.md' }],
  }] }));
  assert.deepEqual(runs[0].waitingFor, [{ id: 'approve', type: 'gate', note: 'Read NOTE.md' }]);
  const line = runLine(runs[0], [], Date.parse('2026-09-28T17:40:00.000Z'));
  assert.match(line, /2fne62 \(waiting at gate approve, 12m\): 3\/4 done; continue: bullswarm workflow continue 2fne62 approve/);
  // pools.ts (the prompt context) does not load under Node's type stripping;
  // its header names the watch mode that wakes at a gate.
  const pools = readFileSync(new URL('../mods/bullswarm/hooks/pools.ts', import.meta.url), 'utf8');
  assert.match(pools, /bullswarm workflow watch <shortId> --until trouble/);
  assert.doesNotMatch(pools, /watch <shortId> --next/);
});
