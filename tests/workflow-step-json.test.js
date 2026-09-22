import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { shapeStep } from '../mods/bullswarm/hooks/step.ts';
import { stepJsonModel } from '../src/workflow/step-json.js';
import { taskStepModel } from '../src/workflow/task-step.js';

function event(seq, summary) {
  return {
    seq,
    at: `2026-09-20T00:00:${String(seq).padStart(2, '0')}.000Z`,
    kind: seq % 2 ? 'command_execution' : 'response',
    status: 'completed',
    summary,
  };
}

function activity(events) {
  return {
    available: true,
    events,
    visibleEvents: events,
    todayEvents: events,
    visibleDetailEvents: events,
    turns: [{
      index: 0,
      response: events.at(-1),
      responseEvent: events.at(-1),
      atomicEvents: events,
      eventIndices: events.map((_, index) => index),
      responseText: events.at(-1)?.summary,
      summary: { commands: 1 },
    }],
    turnSummaries: [{ commands: 1 }],
    overviewRows: [{ type: 'response', event: events.at(-1) }],
  };
}

test('Step JSON writes one events array per attempt and replaces the selected alias with a reference', () => {
  const first = activity([event(1, 'Inspect the sample.'), event(2, 'Inspection complete.')]);
  const second = activity([event(3, 'Verify the sample.'), event(4, 'Verification complete.')]);
  const model = {
    identity: { actionId: 'sample-step', status: 'succeeded' },
    selectedAttempt: { ordinal: 2 },
    attempts: [{ ordinal: 1, activity: first }, { ordinal: 2, activity: second }],
    presentation: { header: {}, activity: { events: 2, turns: [] }, result: {}, task: {}, cost: {} },
  };
  const projected = stepJsonModel(model);
  const json = JSON.stringify(projected);

  assert.equal(projected.schemaVersion, 2);
  assert.deepEqual(projected.selectedAttempt, { sameAs: 'attempts[1]' });
  assert.equal((json.match(/"events":\[/g) ?? []).length, 2);
  assert.equal(json.includes('visibleEvents'), false);
  assert.equal(json.includes('todayEvents'), false);
  assert.equal(json.includes('visibleDetailEvents'), false);
  assert.equal(json.includes('atomicEvents'), false);
  assert.deepEqual(projected.attempts[0].activity.events, first.events);
  assert.deepEqual(projected.attempts[1].activity.events, second.events);
});

test('Step JSON references an identical activity shared by two attempts', () => {
  const shared = activity([event(1, 'No stream was captured.')]);
  const projected = stepJsonModel({
    selectedAttempt: { ordinal: 2 },
    attempts: [{ ordinal: 1, activity: shared }, { ordinal: 2, activity: shared }],
  });
  assert.deepEqual(projected.attempts[0].activity, { sameAs: 'attempts[1].activity' });
  assert.equal((JSON.stringify(projected).match(/"events":\[/g) ?? []).length, 1);
});

test('Step JSON projects an unmatched running command and removes it after completion', () => {
  const root = mkdtempSync(join(tmpdir(), 'bullswarm-running-command-'));
  try {
    const streamFile = join(root, 'stream-sample.jsonl');
    const started = {
      seq: 2,
      at: '2026-09-20T00:00:05.000Z',
      source: 'stdout',
      providerType: 'item.started',
      kind: 'command_execution',
      status: 'running',
      summary: 'inspect the made-up orchard',
    };
    const response = {
      seq: 1,
      at: '2026-09-20T00:00:00.000Z',
      source: 'stdout',
      providerType: 'item.completed',
      kind: 'response',
      status: 'completed',
      summary: 'I will inspect the made-up orchard.',
    };
    const record = {
      id: 'sample-running-task',
      pool: 'sample-pool',
      model: 'sample-model',
      streamFile,
      startedAt: response.at,
      status: 'running',
    };
    writeFileSync(streamFile, [response, started].map(JSON.stringify).join('\n'));
    const running = stepJsonModel(taskStepModel(record, {
      runsDir: root,
      nowMs: Date.parse('2026-09-20T00:00:12.000Z'),
    }));
    assert.deepEqual(running.presentation.activity.runningCommand, {
      text: 'inspect the made-up orchard',
      startedAt: '2026-09-20T00:00:05.000Z',
    });

    const completed = { ...started, seq: 3, at: '2026-09-20T00:00:13.000Z', providerType: 'item.completed', status: 'completed' };
    writeFileSync(streamFile, [response, started, completed].map(JSON.stringify).join('\n'));
    const settled = stepJsonModel(taskStepModel(record, {
      runsDir: root,
      nowMs: Date.parse('2026-09-20T00:00:14.000Z'),
    }));
    assert.equal(settled.presentation.activity.runningCommand, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('compact task JSON shapes the same pane rows as the full Step model', () => {
  const root = mkdtempSync(join(tmpdir(), 'bullswarm-step-json-'));
  try {
    const taskFile = join(root, 'task-sample.md');
    const outputFile = join(root, 'out-sample.md');
    const streamFile = join(root, 'stream-sample.jsonl');
    writeFileSync(taskFile, 'Review the invented orchard report.\n');
    writeFileSync(outputFile, 'The invented orchard report is complete.\n');
    writeFileSync(streamFile, [
      JSON.stringify(event(1, 'Inspect the invented orchard report.')),
      JSON.stringify(event(2, 'The invented orchard report is complete.')),
    ].join('\n'));
    const full = taskStepModel({
      id: 'sample-task',
      lane: 'build',
      pool: 'sample-pool',
      model: 'sample-model',
      effort: 'medium',
      taskFile,
      outFile: outputFile,
      streamFile,
      startedAt: '2026-09-20T00:00:00.000Z',
      endedAt: '2026-09-20T00:01:00.000Z',
      ok: true,
    }, { runsDir: root, nowMs: Date.parse('2026-09-20T00:02:00.000Z') });
    const compact = stepJsonModel(full);

    for (const width of [55, 120]) {
      for (const mode of ['overview', 'detail']) {
        assert.deepEqual(
          shapeStep({ step: compact }, { width, mode, expandedTurn: 0 }),
          shapeStep({ step: full }, { width, mode, expandedTurn: 0 }),
        );
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
