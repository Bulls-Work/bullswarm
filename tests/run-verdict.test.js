// The `bullswarm run` verdict built from a run's durable state
// (src/workflow/run-verdict.js). QA-REPORT-3 (B1): an attempt that recorded
// `returnedEarly` puts `notDone` in the verdict, at most five items, each
// trimmed, and one text line; `ok` and `why` stay the run's facts.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { runVerdict, runVerdictLines } from '../src/workflow/run-verdict.js';

function runWith(returnedEarly) {
  return {
    runId: 'wf-mum29ye9-ae9157', shortId: 'wtzq2s',
    result: { reason: 'all 1 step succeeded' },
    state: {
      actions: [{ id: 'task', status: 'succeeded' }],
      attempts: [{
        actionId: 'task', status: 'succeeded', pool: 'acme', model: 'acme-model', outputFile: '/tmp/out-task-attempt-1.md',
        ...(returnedEarly ? { returnedEarly } : {}),
      }],
    },
  };
}

test('runVerdict: returnedEarly becomes notDone with the first five items, trimmed; ok and why are unchanged', () => {
  const long = `${'the triage report '.repeat(20)}end`;
  const items = [long, 'b', 'c', 'd', 'e', 'f', 'g'];
  const verdict = runVerdict({ run: runWith({ count: 7, items }), stepId: 'task' });
  assert.equal(verdict.ok, true);
  assert.equal(verdict.why, 'all 1 step succeeded');
  assert.equal(verdict.notDone.count, 7);
  assert.equal(verdict.notDone.items.length, 5);
  assert.ok(verdict.notDone.items[0].length <= 160 && verdict.notDone.items[0].endsWith('…'), verdict.notDone.items[0]);
  assert.deepEqual(verdict.notDone.items.slice(1), ['b', 'c', 'd', 'e']);
  const lines = runVerdictLines(verdict);
  const said = lines.filter((line) => line.startsWith('worker left'));
  assert.equal(said.length, 1);
  assert.match(said[0], /^worker left 7 items not done: the triage report .*…; b; c; d; e \(and 2 more\)$/);
  assert.equal(lines[0], 'OK [acme] all 1 step succeeded');
});

test('runVerdict: one item reads in the singular; no record means notDone null and no line', () => {
  const one = runVerdict({ run: runWith({ count: 1, items: ['the changelog entry'] }), stepId: 'task' });
  assert.deepEqual(one.notDone, { count: 1, items: ['the changelog entry'] });
  assert.ok(runVerdictLines(one).includes('worker left 1 item not done: the changelog entry'));
  const none = runVerdict({ run: runWith(null), stepId: 'task' });
  assert.equal(none.notDone, null);
  assert.equal(runVerdictLines(none).some((line) => /not done/.test(line)), false);
});

test('runVerdict: top-level pool and model are the last attempt\'s; a never-dispatched step gives null', () => {
  const verdict = runVerdict({ run: runWith(null), stepId: 'task' });
  assert.equal(verdict.pool, 'acme');
  assert.equal(verdict.model, 'acme-model');
  assert.equal(verdict.pick.pool, 'acme');
  const run = runWith(null);
  run.state.attempts = [];
  const idle = runVerdict({ run, stepId: 'task' });
  assert.equal(idle.pool, null);
  assert.equal(idle.model, null);
});
