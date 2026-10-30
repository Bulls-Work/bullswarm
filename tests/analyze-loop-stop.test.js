// The no-new-ground limit (BULLSWARM_WORKER_NO_NEW_GROUND_SEC): an analyze
// worker that keeps calling tools but never reaches a target it has not used
// before, and writes no new analysis text, is stopped as `stalled` (2026-10-12
// benchmark: an analyze worker re-read the same files for over an hour; the
// silence clock restarts on every byte and the no-progress clock covers only
// build and chore steps).
//
// Every worker is a local `node -e` script behind an inline event-stream
// connector in a temporary Bullswarm home: no real pool, no network, no quota.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { saveState } from '../src/lib/state.js';
import { dispatchV2Action } from '../src/workflow/v2-dispatch.js';
import { normalizeAttempt } from '../src/workflow/attempt-record.js';
import {
  createV2DurableState, createV2GoalDocument, deserializeV2DurableState,
} from '../src/workflow/v2-state.js';

process.env.BULLSWARM_UNICODE = '1';
delete process.env.BULLSWARM_ASCII;

const EVENT_STREAM = {
  format: 'jsonl',
  modelPaths: ['model'],
  rules: [
    { rootMatch: { path: 'type', equals: 'tool' }, idPaths: ['id'], kindPaths: ['name'], summaryPaths: ['command'], statusPath: 'status' },
    { rootMatch: { path: 'type', equals: 'response' }, idPaths: ['id'], kind: 'response', summaryPaths: ['text'], status: 'completed' },
  ],
  output: [{ match: { path: 'type', equals: 'response' }, path: 'text', mode: 'last' }],
};

const FINAL = 'Completed the requested analysis, read the affected files, and summarized the findings together with the remaining risks in the report below.';
const finish = (ms) => `setTimeout(() => { clearInterval(timer); console.log(JSON.stringify({ type: 'response', id: 'done', text: '${FINAL}' })); }, ${ms});`;
const read = (target) => `console.log(JSON.stringify({ type: 'tool', id: 'read-' + n, name: 'read_file', command: ${target}, status: 'completed' }));`;
// Re-reads the same two files for `ms`, then answers.
const repeatSame = (ms) => `let n = 0; const timer = setInterval(() => { n += 1; ${read("'cat ' + ['a', 'b'][n % 2] + '.txt'")} }, 100); ${finish(ms)}`;
// Reads a file it has not read before every tick.
const newTargets = (ms) => `let n = 0; const timer = setInterval(() => { n += 1; ${read("'cat file-' + n + '.txt'")} }, 100); ${finish(ms)}`;
// Re-reads the same files but writes a new long piece of analysis every 500 ms.
const repeatWithText = (ms) => `let n = 0; let k = 0; const timer = setInterval(() => { n += 1; ${read("'cat ' + ['a', 'b'][n % 2] + '.txt'")} `
  + "if (n % 5 === 0) { k += 1; console.log(JSON.stringify({ type: 'response', id: 'r' + k, text: 'Analysis part ' + k + ': ' + 'finding '.repeat(40) })); } }, 100); "
  + finish(ms);
// Re-reads the same files and says the same long thing again and again.
const repeatWithSameText = (ms) => `let n = 0; const timer = setInterval(() => { n += 1; ${read("'cat ' + ['a', 'b'][n % 2] + '.txt'")} `
  + "if (n % 5 === 0) console.log(JSON.stringify({ type: 'response', id: 'r' + n, text: 'Still looking at it: ' + 'finding '.repeat(40) })); }, 100); "
  + finish(ms);

const fixturePool = (name, script) => ({
  name,
  enabled: true,
  lanes: ['analyze', 'build', 'chore'],
  capabilities: ['strong-analysis', 'code-reading', 'file-editing', 'workflow-planning'],
  spawn: { cmd: [process.execPath, '-e', script, '--', '{taskFile}'] },
  authSignatures: [],
  outputExtraction: { strategy: 'event-stream' },
  eventStream: EVENT_STREAM,
  meter: { type: 'none' },
  model: `${name}/model`,
  modelSelection: { flag: '--model' },
  strategyAssignments: { low: { pool: name, model: `${name}/model` } },
});

function isolatedHome(t, pool) {
  const home = mkdtempSync(join(tmpdir(), 'bs-no-new-ground-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  saveState(home, {
    version: 1, pools: { [pool.name]: { enabled: true } },
    incumbents: {}, decisionLog: [], config: { depthLimit: 2 },
  });
  return home;
}

function dispatch(t, script, action, extra = {}) {
  const pool = fixturePool('worker', script);
  const home = isolatedHome(t, pool);
  return dispatchV2Action({
    action: { effort: 'low', ...action },
    taskText: 'Read the notes.',
    targetDir: home,
    paths: (ordinal) => ({ taskFile: join(home, `task-${ordinal}.md`), outFile: join(home, `out-${ordinal}.md`) }),
    pools: [pool],
    bullswarmDir: home,
    silenceTimeoutSec: 30,
    noProgressTimeoutSec: 0,
    maxMechanicalRetries: 0,
    ...extra,
  });
}

const ANALYZE = { id: 'read-notes', lane: 'analyze' };

test('the limit reads BULLSWARM_WORKER_NO_NEW_GROUND_SEC, 0 turns it off, and only analyze steps get it', async () => {
  const { workerNoNewGroundTimeoutSec, noNewGroundLimitApplies } = await import('../src/workflow/dispatch-silence.js');
  assert.equal(workerNoNewGroundTimeoutSec({}), 3600);
  assert.equal(workerNoNewGroundTimeoutSec({ BULLSWARM_WORKER_NO_NEW_GROUND_SEC: '900' }), 900);
  assert.equal(workerNoNewGroundTimeoutSec({ BULLSWARM_WORKER_NO_NEW_GROUND_SEC: '0' }), 0);
  assert.equal(workerNoNewGroundTimeoutSec({ BULLSWARM_WORKER_NO_NEW_GROUND_SEC: 'soon' }), 3600);
  assert.equal(noNewGroundLimitApplies({ id: 'a', lane: 'analyze' }), true);
  assert.equal(noNewGroundLimitApplies({ id: 'a', lane: 'build' }), false);
  assert.equal(noNewGroundLimitApplies({ id: 'a', lane: 'chore' }), false);
  assert.equal(noNewGroundLimitApplies({ id: 'a', lane: 'analyze', role: 'act' }), false);
  assert.equal(noNewGroundLimitApplies({ id: 'a', lane: 'analyze', deliverable: { type: 'outward' } }), false);
});

test('an analyze worker that re-reads the same targets past the limit is stopped as stalled, no-new-ground', { timeout: 30_000 }, async (t) => {
  const started = Date.now();
  const result = await dispatch(t, repeatSame(6000), ANALYZE, { noNewGroundTimeoutSec: 1 });
  assert.ok(Date.now() - started < 5500, 'stopped soon after the limit, not when the worker finished');
  assert.equal(result.ok, false);
  const [attempt] = result.attempts;
  assert.equal(attempt.failureKind, 'stalled');
  assert.equal(attempt.stalled, true);
  assert.equal(attempt.noNewGroundSec, 1);
  assert.equal(attempt.silentSec, undefined, 'the silence limit did not stop it');
  assert.equal(attempt.noProgressSec, undefined);
  assert.match(attempt.why, /^stalled: no new file or command for 1 s/);
});

test('a worker that repeats the same long text is not writing new analysis and is stopped', { timeout: 30_000 }, async (t) => {
  const result = await dispatch(t, repeatWithSameText(6000), ANALYZE, { noNewGroundTimeoutSec: 1 });
  assert.equal(result.attempts[0].noNewGroundSec, 1);
  assert.equal(result.attempts[0].failureKind, 'stalled');
});

test('an analyze worker that keeps reaching new targets past the limit is not stopped', { timeout: 30_000 }, async (t) => {
  const result = await dispatch(t, newTargets(3000), ANALYZE, { noNewGroundTimeoutSec: 1 });
  assert.equal(result.attempts.length, 1);
  assert.notEqual(result.attempts[0].failureKind, 'stalled');
  assert.equal(result.attempts[0].stalled, undefined);
  assert.equal(result.attempts[0].noNewGroundSec, undefined);
  assert.equal(result.ok, true);
});

test('a new long piece of analysis text restarts the clock even when every read repeats', { timeout: 30_000 }, async (t) => {
  const result = await dispatch(t, repeatWithText(3500), ANALYZE, { noNewGroundTimeoutSec: 1 });
  assert.equal(result.attempts.length, 1);
  assert.equal(result.attempts[0].stalled, undefined);
  assert.equal(result.ok, true);
});

test('build and chore steps are not stopped by the limit, however much they repeat', { timeout: 30_000 }, async (t) => {
  for (const action of [{ id: 'b', lane: 'build' }, { id: 'c', lane: 'chore' }]) {
    const result = await dispatch(t, repeatSame(2500), action, { noNewGroundTimeoutSec: 1 });
    assert.equal(result.attempts.length, 1, action.id);
    assert.equal(result.attempts[0].stalled, undefined, action.id);
    assert.equal(result.attempts[0].noNewGroundSec, undefined, action.id);
  }
});

test('a step stopped for no new ground keeps noNewGroundSec through the attempt record and the durable state', () => {
  const stalled = {
    id: 'read-notes-1', actionId: 'read-notes', ordinal: 1, status: 'interrupted',
    pool: 'worker', model: 'worker/model', startedAt: '2026-10-14T10:00:00.000Z',
    finishedAt: '2026-10-14T11:00:01.000Z', failureKind: 'stalled',
    why: 'stalled: no new file or command for 60 min, the worker was stopped',
    stalled: true, partialOutput: '/tmp/out-read-notes.md', noNewGroundSec: 3600,
  };
  const recorded = normalizeAttempt(stalled, { id: 'read-notes-1', actionId: 'read-notes', ordinal: 1 });
  assert.equal(recorded.noNewGroundSec, 3600);
  assert.equal(recorded.silentSec, undefined);

  const goal = createV2GoalDocument({
    goal: 'A reader that loops', cwd: '/tmp/repo',
    requirements: [{ id: 'r1', text: 'Summarize the notes' }], settings: {},
  });
  const state = createV2DurableState(goal, { runId: 'wf-nong', shortId: 'nng123' });
  state.program = {
    schemaVersion: 'bullswarm.workflow.program.v2', revision: 1,
    actions: [{
      id: 'read-notes', purpose: 'Summarize', dependsOn: [], affects: ['r1'], ownedFiles: [],
      prompt: 'Read.', lane: 'analyze', effort: 'low', evidenceFor: [], inputs: [], produces: [],
    }],
  };
  state.actions = [{ id: 'read-notes', status: 'running', attempts: 1, programRevision: 1 }];
  state.presentation = { stages: [{ id: 'r1-read', label: 'Read', revision: 1, actionIds: ['read-notes'], startedAt: null, completedAt: null }] };
  state.attempts = [stalled];
  const loaded = deserializeV2DurableState(JSON.stringify(state));
  assert.equal(loaded.attempts[0].noNewGroundSec, 3600);
});
