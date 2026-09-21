// The dashboard's task ledger has one intentionally small contract: live run
// assignments and finished run decisions normalize to the same identifying
// fields, while older decision rows remain readable.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listTasks } from '../src/lib/tasks.js';
import { registerAssignment } from '../src/lib/assignments.js';

const NOW = Date.parse('2026-09-18T12:00:00.000Z');

function fixtureHome() {
  const home = mkdtempSync(join(tmpdir(), 'bullswarm-tasks-'));
  mkdirSync(join(home, 'assignments'), { recursive: true });
  writeFileSync(join(home, 'state.json'), `${JSON.stringify({
    decisionLog: [
      {
        kind: 'run', id: 'finished-new', lane: 'build', pool: 'echo', model: 'echo-local',
        project: 'bullswarm', startedAt: '2026-09-18T11:40:00.000Z', endedAt: '2026-09-18T11:42:05.000Z',
        taskFile: '/tmp/task-new.md', outFile: '/tmp/out-new.md', ok: true, reason: null, durationMs: null,
      },
      {
        // A pre-ledger row: it has the old picked/why/wallSec fields but none
        // of the new task identity fields. It must not make the reader throw.
        kind: 'run', picked: 'legacy-pool', lane: 'chore', ts: '2026-09-18T10:00:00.000Z',
        ok: false, why: 'legacy failure', wallSec: 3,
      },
      {
        kind: 'run', id: 'finished-old', lane: 'analyze', pool: 'old-pool', model: 'old-model',
        project: 'old-project', startedAt: '2026-09-17T23:00:00.000Z', endedAt: '2026-09-17T23:01:00.000Z',
        taskFile: '/tmp/task-old.md', ok: true,
      },
      { kind: 'workflow-v2', id: 'not-a-task', picked: 'workflow-pool', ok: true },
    ],
  }, null, 2)}\n`);
  registerAssignment(home, {
    id: 'live-task', pool: 'echo', model: 'echo-local', lane: 'build', effort: 'medium', source: 'run',
    project: 'bullswarm', taskFile: '/tmp/task-live.md', outFile: '/tmp/out-live.md',
    startedAt: '2026-09-18T11:50:00.000Z', workerPid: process.pid,
  });
  return home;
}

test('listTasks returns exact in-flight and finished row shapes, newest first', () => {
  const home = fixtureHome();
  try {
    const tasks = listTasks({ home, since: '2026-09-18T00:00:00.000Z', now: NOW });
    assert.deepEqual(tasks.inflight, [{
      id: 'live-task', lane: 'build', pool: 'echo', model: 'echo-local', project: 'bullswarm',
      startedAt: '2026-09-18T11:50:00.000Z', taskFile: '/tmp/task-live.md',
      outFile: '/tmp/out-live.md', streamFile: null,
    }]);
    assert.deepEqual(tasks.finished, [
      {
        id: 'finished-new', lane: 'build', pool: 'echo', model: 'echo-local', project: 'bullswarm',
        startedAt: '2026-09-18T11:40:00.000Z', taskFile: '/tmp/task-new.md',
        outFile: '/tmp/out-new.md', streamFile: null,
        endedAt: '2026-09-18T11:42:05.000Z', ok: true, reason: null, durationMs: 125000,
      },
      {
        id: null, lane: 'chore', pool: 'legacy-pool', model: null, project: null,
        startedAt: null, taskFile: null, outFile: null, streamFile: null,
        endedAt: '2026-09-18T10:00:00.000Z',
        ok: false, reason: 'legacy failure', durationMs: 3000,
      },
    ]);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('listTasks keeps only the run source in flight and applies the since boundary', () => {
  const home = fixtureHome();
  try {
    const tasks = listTasks({ home, since: NOW - 30 * 60_000, now: NOW });
    assert.deepEqual(tasks.finished.map((row) => row.id), ['finished-new']);
    assert.equal(tasks.inflight.length, 1);
    assert.equal(tasks.inflight[0].id, 'live-task');
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('listTasks carries the recorded streamFile on live and finished rows', () => {
  const home = mkdtempSync(join(tmpdir(), 'bullswarm-tasks-stream-'));
  mkdirSync(join(home, 'assignments'), { recursive: true });
  try {
    writeFileSync(join(home, 'state.json'), `${JSON.stringify({
      decisionLog: [{
        kind: 'run', id: 'finished-stream', lane: 'build', pool: 'codex', model: 'gpt-5.6-luna',
        startedAt: '2026-09-18T11:40:00.000Z', endedAt: '2026-09-18T11:41:00.000Z',
        taskFile: '/tmp/task-done.md', outFile: '/tmp/out-done.md',
        streamFile: '/tmp/stream-done.jsonl', ok: true,
      }],
    }, null, 2)}\n`);
    registerAssignment(home, {
      id: 'live-stream', pool: 'codex', model: 'gpt-5.6-luna', lane: 'build', source: 'run',
      taskFile: '/tmp/task-live.md', outFile: '/tmp/out-live.md',
      streamFile: '/tmp/stream-live.jsonl',
      startedAt: '2026-09-18T11:50:00.000Z', workerPid: process.pid,
    });
    const tasks = listTasks({ home, now: NOW });
    assert.equal(tasks.inflight[0].streamFile, '/tmp/stream-live.jsonl');
    assert.equal(tasks.finished[0].streamFile, '/tmp/stream-done.jsonl');
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('listTasks normalizes the workflow attempt spelling of the out file', () => {
  const home = mkdtempSync(join(tmpdir(), 'bullswarm-tasks-outfile-'));
  mkdirSync(join(home, 'assignments'), { recursive: true });
  try {
    writeFileSync(join(home, 'state.json'), `${JSON.stringify({
      decisionLog: [{
        kind: 'run', id: 'attempt-shape', lane: 'build', pool: 'echo', model: 'echo-local',
        startedAt: '2026-09-18T11:40:00.000Z', endedAt: '2026-09-18T11:41:00.000Z',
        taskFile: '/tmp/task-attempt.md', outputFile: '/tmp/out-attempt.md', ok: true,
      }],
    }, null, 2)}\n`);
    const tasks = listTasks({ home, now: NOW });
    assert.equal(tasks.finished[0].outFile, '/tmp/out-attempt.md');
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('listTasks carries task text and attempt pricing from a copied home', () => {
  const home = mkdtempSync(join(tmpdir(), 'bullswarm-tasks-copy-'));
  mkdirSync(join(home, 'assignments'), { recursive: true });
  mkdirSync(join(home, 'runs'), { recursive: true });
  try {
    writeFileSync(join(home, 'runs', 'task-priced.md'), '# Price the task row\n\nDetails.\n');
    writeFileSync(join(home, 'state.json'), `${JSON.stringify({
      decisionLog: [{
        kind: 'run', id: 'priced-1', lane: 'build', pool: 'codex', model: 'gpt-5.6-luna',
        cwd: '/tmp/example-project', startedAt: '2026-09-18T11:40:00.000Z', endedAt: '2026-09-18T11:41:00.000Z',
        taskFile: '/another/home/runs/task-priced.md', ok: true,
        usage: { tokenSource: 'transcript-summed', api: { usd: 1.25 } },
      }],
    })}\n`);
    const [task] = listTasks({ home, now: NOW }).finished;
    assert.equal(task.taskText, '# Price the task row\n\nDetails.');
    assert.equal(task.project, 'example-project');
    assert.equal(task.apiEquivalentUsd, 1.25);
    assert.equal(task.tokenSource, 'transcript-summed');
  } finally { rmSync(home, { recursive: true, force: true }); }
});
