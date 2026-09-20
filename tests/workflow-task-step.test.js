import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { test } from 'node:test';

import {
  adaptTaskRecord,
  taskRecordToStepInput,
  taskStepInput,
  taskStepModel,
} from '../src/workflow/task-step.js';
import { renderStepPage } from '../src/workflow/step-view.js';
import { runDashboard } from '../src/workflow/dashboard.js';

const REAL_HOME = '/home/dev/.claude-acme/jobs/cce88dd2/tmp/home-351';
const REAL_RUNS = join(REAL_HOME, 'runs');
const NOW = Date.parse('2026-09-20T00:00:00.000Z');

function bodyFor() {
  return { lines: [], push(line = '') { this.lines.push(String(line)); } };
}

function plain(value) {
  return String(value ?? '').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
}

class FakeInput extends EventEmitter {
  isTTY = true;
  setRawMode() {}
  pause() {}
  resume() {}
  press(key) { this.emit('data', key); }
}

class FakeOutput extends EventEmitter {
  isTTY = true;
  columns = 80;
  rows = 32;
  text = '';
  write(value) { this.text += String(value); }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test('task adapter reads the record and copied sibling artifacts without following source-home paths', () => {
  const root = mkdtempSync(join(tmpdir(), 'bullswarm-task-step-'));
  try {
    const recordPath = join(root, 'task-record.json');
    writeFileSync(join(root, 'task-copy.md'), 'Inspect the copied task.\nKeep unknowns honest.\n');
    writeFileSync(join(root, 'out-copy.md'), 'copied output\n');
    writeFileSync(recordPath, JSON.stringify({
      id: 'copied-task', lane: 'build', pool: 'codex', model: 'gpt-5.6-luna',
      project: 'bullswarm', startedAt: '2026-09-19T23:58:00.000Z',
      endedAt: '2026-09-20T00:00:00.000Z', durationMs: 120000, ok: true,
      taskFile: '/source-home/runs/task-copy.md', outFile: '/source-home/runs/out-copy.md',
    }));
    const input = taskStepInput(recordPath, { runsDir: root });
    assert.equal(input.row.state.attempts[0].pool, 'codex');
    assert.equal(input.row.state.attempts[0].effort, null);
    assert.equal(input.row.state.attempts[0].taskFile, join(root, 'task-copy.md'));
    assert.equal(input.row.state.attempts[0].outputFile, join(root, 'out-copy.md'));
    assert.equal(input.row.state.attempts[0].streamFile, null);
    assert.equal(input.row.state.attempts[0].usage, null);
    assert.equal(adaptTaskRecord, taskStepInput);
    assert.equal(taskRecordToStepInput, taskStepInput);

    const model = taskStepModel(recordPath, { runsDir: root, nowMs: NOW });
    assert.deepEqual(model.task.lines, ['Inspect the copied task.', 'Keep unknowns honest.']);
    assert.deepEqual(model.resultBlock.output.lines, ['copied output', '']);
    assert.equal(model.header.activeDurationMs, 120000);
    assert.equal(model.identity.workflowStatus, null);
    assert.equal(model.identity.verified, null);
    assert.equal(model.availability.verificationAvailable, false);
    assert.ok(model.artifacts.task.startsWith(root));
    assert.equal(model.artifacts.record, recordPath);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('task adapter carries only supplied effort, usage, and structured stream facts', () => {
  const root = mkdtempSync(join(tmpdir(), 'bullswarm-task-step-stream-'));
  try {
    writeFileSync(join(root, 'task.md'), 'Run the bounded task.\n');
    writeFileSync(join(root, 'out.md'), 'result text\n');
    writeFileSync(join(root, 'stream.jsonl'), [
      JSON.stringify({ at: '2026-09-19T23:58:10.000Z', kind: 'response', status: 'completed', summary: 'starting' }),
      JSON.stringify({ at: '2026-09-19T23:58:20.000Z', kind: 'command_execution', status: 'completed', summary: 'npm test' }),
    ].join('\n'));
    const record = {
      id: 'stream-task', lane: 'build', pool: 'codex', model: 'gpt-5.6-luna', effort: 'medium',
      taskFile: 'task.md', outFile: 'out.md', streamFile: 'stream.jsonl',
      startedAt: '2026-09-19T23:58:00.000Z', endedAt: '2026-09-20T00:00:00.000Z', ok: true,
      usage: { tokens: { standardRead: 12, output: 4, totalKnown: 16 }, tokenSource: 'recorded' },
    };
    const model = taskStepModel(record, { runsDir: root, nowMs: NOW });
    assert.equal(model.header.effort, 'medium');
    assert.equal(model.tokens.totalKnown, 16);
    assert.equal(model.activity.available, true);
    assert.equal(model.activity.turns.length, 1);
    assert.equal(model.activity.turns[0].summary.commands, 1);
    assert.equal(model.verdict.verification.verdict, null);
    assert.equal(model.verdict.workflow.status, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('real snapshot task records render through the Step blocks at 55, 120, and 200 columns', () => {
  if (!existsSync(join(REAL_HOME, 'state.json'))) return;
  const state = JSON.parse(readFileSync(join(REAL_HOME, 'state.json'), 'utf8'));
  const records = (state.decisionLog ?? [])
    .filter((entry) => entry?.kind === 'run' && entry.taskFile)
    .slice(0, 3)
    .map((entry) => ({
      ...entry,
      taskFile: join(REAL_RUNS, basename(entry.taskFile)),
      outFile: entry.outFile ? join(REAL_RUNS, basename(entry.outFile)) : null,
    }));
  assert.ok(records.length, 'snapshot has no task records');
  for (const record of records) {
    const model = taskStepModel(record, { nowMs: NOW });
    for (const width of [55, 120, 200]) {
      const body = bodyFor();
      renderStepPage(model, { width, stepView: 'overview' }, body);
      for (const line of body.lines) assert.ok([...plain(line)].length <= width, `${width}: ${plain(line)}`);
      assert.match(body.lines.join('\n'), /task · prompt \+ task|result · output \+ artifacts|cost · money pair/);
    }
  }
});

test('dashboard task route uses the Step toggle and Esc leaves the task page', async () => {
  const home = mkdtempSync(join(tmpdir(), 'bullswarm-task-dashboard-'));
  const runs = join(home, 'runs');
  mkdirSync(runs, { recursive: true });
  writeFileSync(join(runs, 'task-key.md'), 'Use the shared task view.\n');
  writeFileSync(join(runs, 'out-key.md'), 'done\n');
  writeFileSync(join(home, 'state.json'), JSON.stringify({ decisionLog: [{
    kind: 'run', source: 'run', id: 'key-task', lane: 'build', pool: 'codex', model: 'gpt-5.6-luna',
    project: 'bullswarm', taskFile: join(runs, 'task-key.md'), outFile: join(runs, 'out-key.md'),
    ok: true, startedAt: new Date(Date.now() - 120000).toISOString(),
    endedAt: new Date(Date.now() - 60000).toISOString(), durationMs: 60000,
  }] }));
  const input = new FakeInput();
  const output = new FakeOutput();
  const dashboard = runDashboard(home, { input, output, refreshMs: 100000, spinnerMs: 100000 });
  try {
    await settle();
    input.press('r');
    await settle();
    const beforeOpen = output.text.length;
    input.press('\r');
    await settle();
    assert.match(plain(output.text.slice(beforeOpen)), /Step key-task/);
    const beforeToggle = output.text.length;
    input.press('v');
    await settle();
    assert.match(plain(output.text.slice(beforeToggle)), /\[v overview\]/);
    const beforeBack = output.text.length;
    input.press('\x1b');
    await settle();
    assert.match(plain(output.text.slice(beforeBack)), /bullswarm · runs/);
  } finally {
    input.press('q');
    await dashboard;
    rmSync(home, { recursive: true, force: true });
  }
});
