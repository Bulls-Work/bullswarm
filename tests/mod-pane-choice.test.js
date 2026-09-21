import assert from 'node:assert/strict';
import { test } from 'node:test';

import { paneChoice } from '../mods/bullswarm/hooks/runs.ts';

const workflow = { runId: 'wf-sample-123456', shortId: 'x9z8s2' };
const task = {
  id: 'f1e2d3c4-0b1a-4c2d-9e8f-7a6b5c4d3e21', source: 'run', pool: 'codex',
  model: 'gpt-5.6-luna', lane: 'build', runId: null, actionId: null,
  elapsedMinutes: 13, expectedMinutes: null,
};

test('pane keeps showing a selected workflow while a standalone task is in flight', () => {
  assert.deepEqual(paneChoice([workflow], [task], 'x9z8s2', null), {
    kind: 'workflow', shortId: 'x9z8s2',
  });
});

test('pane shows the standalone task after its own button is selected', () => {
  assert.deepEqual(paneChoice([workflow], [task], 'x9z8s2', task.id), {
    kind: 'task', taskId: task.id,
  });
});

test('pane promotes a standalone task only when no workflow exists', () => {
  assert.deepEqual(paneChoice([], [task], null, null), {
    kind: 'task', taskId: task.id,
  });
});
