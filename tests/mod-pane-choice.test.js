import assert from 'node:assert/strict';
import { test } from 'node:test';

import { paneChoice } from '../mods/bullswarm/hooks/runs.ts';
import { shapeStep } from '../mods/bullswarm/hooks/step.ts';

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

function stepPage(turnCount, { running = false, command = null } = {}) {
  const turns = Array.from({ length: turnCount }, (_, index) => ({
    index,
    number: index + 1,
    clock: `10:${String(index).padStart(2, '0')}`,
    text: `Made-up response ${String(index + 1)}.`,
    countsText: `${String(index + 1)} commands`,
    summary: { commands: index + 1, edits: index, errors: 0 },
    toolRows: [],
  }));
  return { presentation: {
    header: { actionId: 'sample-step', status: running ? 'running' : 'succeeded' },
    activity: {
      available: true,
      turns,
      totals: { commands: 38, edits: 11, errors: 0 },
      running,
      runningCommand: command,
    },
    result: { running, reportLines: [] },
    task: {},
    cost: { rows: [] },
  } };
}

test('Step pane follows and expands the latest turn until the reader chooses one', () => {
  const first = shapeStep(stepPage(2), { width: 90 });
  assert.equal(first.rows.find(row => row.kind === 'response' && row.selected)?.turnIndex, 1);
  assert.ok(first.rows.some(row => row.key === 'counts-1'));

  const followed = shapeStep(stepPage(3), { width: 90 });
  assert.equal(followed.rows.find(row => row.kind === 'response' && row.selected)?.turnIndex, 2);

  const chosen = shapeStep(stepPage(3), { width: 90, expandedTurn: 0 });
  assert.equal(chosen.rows.find(row => row.kind === 'response' && row.selected)?.turnIndex, 0);
  assert.match(chosen.rows.find(row => row.key === 'turn-0').text, /^▶/);
});

test('Step pane shows live command rows only while a command is running', () => {
  const command = { text: 'inspect the made-up orchard', startedAt: '2026-09-20T00:00:05.000Z' };
  const live = shapeStep(stepPage(2, { running: true, command }), {
    width: 48,
    nowMs: Date.parse('2026-09-20T00:00:12.000Z'),
  });
  assert.match(live.rows.find(row => row.key === 'counts-1').text, /running: inspect the made-up orchard 7s/);
  assert.match(live.rows.find(row => row.key === 'running-1').text, /^⋮ running 7s  inspect the made-up orchard$/);
  assert.equal(shapeStep(stepPage(2), { width: 48 }).rows.some(row => row.key.startsWith('running-')), false);
});

test('Step activity heading sheds the filter and then counts at pane widths', () => {
  const expected = new Map([
    [40, '── activity · overview · detail ──'],
    [48, '── activity · overview · detail ──'],
    [60, '4 turns so far'],
    [90, '0 err'],
  ]);
  for (const [width, fragment] of expected) {
    const heading = shapeStep(stepPage(4, { running: true }), { width }).rows.find(row => row.key === 'activity-section').text;
    assert.ok(heading.length <= width, `${String(width)}: ${heading}`);
    assert.match(heading, /── activity · overview · detail/);
    assert.ok(heading.includes(fragment), `${String(width)} should include ${fragment}: ${heading}`);
    assert.doesNotMatch(heading, /showing turns/);
  }
});
