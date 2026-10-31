// Stale warnings are saved in the run's events by the process that runs the
// attempts, so a run nobody watched still leaves a count (2026-10-31: the
// eval could not report stale warnings at all). Fake worker, temp repo and
// made-up names only; the thresholds and the check cadence are shrunk through
// the runner's test hooks.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readEvents } from '../src/workflow/events.js';
import { createV2GoalDocument } from '../src/workflow/v2-state.js';
import { runV2AutonomousWorkflow } from '../src/workflow/v2-runtime.js';
import { dispatchV2Action } from '../src/workflow/v2-dispatch.js';
import { DEFAULT_STALE_THRESHOLDS } from '../src/lib/stale.js';
import { implicitV3Requirements } from '../src/workflow/program-v3.js';
import { STAGE3_RUN_FEATURES, withProgramFormat } from '../src/workflow/run-features.js';
import { initialWatchMemory, notableWatchEvents, renderWatchEvent } from '../src/workflow/watch-cli.js';

process.env.BULLSWARM_UNICODE = '1';
delete process.env.BULLSWARM_ASCII;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const connector = (name) => ({
  name, lanes: ['analyze', 'build', 'chore'], enabled: true, spawn: { cmd: ['fake'] },
  modelSelection: { flag: '--model' },
  strategyAssignments: Object.fromEntries(['low', 'medium', 'high'].map((tier) => [tier, { pool: name, model: 'gpt-5.6-luna' }])),
});

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'bullswarm-stale-recorded-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const workspace = join(root, 'repo');
  const bullswarmDir = join(root, 'home');
  mkdirSync(workspace, { recursive: true });
  mkdirSync(bullswarmDir, { recursive: true });
  execFileSync('git', ['init', '-q', workspace]);
  writeFileSync(join(workspace, 'README.md'), 'acme\n');
  execFileSync('git', ['-C', workspace, 'add', '.']);
  execFileSync('git', ['-C', workspace, '-c', 'user.name=Acme Dev', '-c', 'user.email=dev@example.com', 'commit', '-qm', 'seed']);
  const goalDocument = createV2GoalDocument({
    goal: 'Deliver the report', cwd: workspace, requirements: implicitV3Requirements('Deliver the report'),
    settings: { executionMode: 'program', workspaceMode: 'shared', scout: false, plannerMode: 'caller', concurrency: 1 },
  });
  return { bullswarmDir, goalDocument };
}

// The real dispatch; `worker` is the fake worker (its own options carry onActivity).
const dispatchWith = (worker) => {
  const core = { config: { depthLimit: 2 }, pools: {}, incumbents: {}, decisionLog: [] };
  return (options) => dispatchV2Action({
    ...options,
    pools: [connector('codex')],
    dependencies: {
      watchOnce: async (_pool, task, targetDir, files, watchOptions) => {
        writeFileSync(files.taskFile, task);
        const verdict = await worker({ files, watchOptions });
        if (verdict) return verdict;
        if (!existsSync(files.outFile)) writeFileSync(files.outFile, 'done\n');
        return { ok: true, why: 'ok', meta: { exitCode: 0, wallSec: 1 } };
      },
      loadState: () => structuredClone(core),
      saveState: (_dir, next) => Object.assign(core, structuredClone(next)),
      now: () => Date.now(),
      uuid: () => 'session-fixed',
    },
  });
};

const launch = (f, runId, dispatch) => runV2AutonomousWorkflow({
  bullswarmDir: f.bullswarmDir, goalDocument: f.goalDocument, pools: [], runId, parentEnv: {},
  initialPlannerResponse: {
    schemaVersion: 'bullswarm.workflow.planner-response.v2', kind: 'program', summary: 'Report.',
    program: { schemaVersion: 'bullswarm.workflow.program.v3', steps: [{ id: 'report', prompt: 'Write the report.', lane: 'analyze', effort: 'low' }] },
  },
  dependencies: {
    savedRunTwin: true, refreshPools: async () => null, dispatchV2Action: dispatch,
    runFeatures: withProgramFormat(STAGE3_RUN_FEATURES, { v3: true }),
    // Quiet counts as stale after 1 s, one more level each further second.
    staleThresholds: { ...DEFAULT_STALE_THRESHOLDS, quietSec: 1 },
    staleCheckMs: 100,
  },
});

const typed = (runDir, ...types) => readEvents(runDir).filter((event) => types.includes(event.type));

test('a quiet attempt leaves attempt.stale level 1, level 2, then attempt.stale_cleared when output resumes', async (t) => {
  const f = fixture(t);
  const run = await launch(f, 'wf-stalea-abcdef', dispatchWith(async ({ watchOptions }) => {
    await sleep(2600); // quiet past two windows
    watchOptions.onActivity({ at: new Date().toISOString(), bytes: 10 });
    await sleep(600);
    return null;
  }));
  assert.equal(run.result.status, 'completed');
  const marks = typed(run.runDir, 'attempt.stale', 'attempt.stale_cleared');
  const stale = marks.filter((event) => event.type === 'attempt.stale').map((event) => event.payload);
  assert.deepEqual(stale.slice(0, 2).map((payload) => payload.level), [1, 2]);
  assert.equal(stale.length, 2, 'one warning per window, never a repeat');
  for (const payload of stale) {
    assert.equal(payload.actionId, 'report');
    assert.equal(payload.attemptId, 'report-1');
    assert.equal(payload.pool, 'codex');
    assert.equal(typeof payload.score, 'number');
    assert.ok(payload.reasons.length > 0);
    assert.ok(Number.isFinite(Date.parse(payload.staleSince)));
    assert.equal(Number.isInteger(payload.noProgressSec), true);
  }
  assert.deepEqual(marks.map((event) => event.type), ['attempt.stale', 'attempt.stale', 'attempt.stale_cleared']);
  const cleared = marks.at(-1).payload;
  assert.deepEqual({ actionId: cleared.actionId, attemptId: cleared.attemptId, level: cleared.level }, { actionId: 'report', attemptId: 'report-1', level: 2 });
  assert.ok(cleared.staleSec >= 1);
  assert.equal(run.state.runner.recordsStale, true);
});

test('a stale attempt that ends records stale_cleared before attempt.finished', async (t) => {
  const f = fixture(t);
  const run = await launch(f, 'wf-staleb-abcdef', dispatchWith(async () => { await sleep(1700); return null; }));
  const types = typed(run.runDir, 'attempt.stale', 'attempt.stale_cleared', 'attempt.finished').map((event) => event.type);
  assert.deepEqual(types, ['attempt.stale', 'attempt.stale_cleared', 'attempt.finished']);
});

test('a killed attempt names the limit that stopped it and the seconds', async (t) => {
  const f = fixture(t);
  for (const [stalledBy, key, runId] of [['silence', 'silentSec', 'wf-stalek1-abcdef'], ['no-progress', 'noProgressSec', 'wf-stalek2-abcdef']]) {
    const run = await launch(f, runId, dispatchWith(async () => ({
      ok: false, why: `no output for 3600s (${stalledBy})`, failureKind: 'stalled',
      meta: { stalled: true, stalledBy, exitCode: null, wallSec: 3600 },
    })));
    const finished = typed(run.runDir, 'attempt.finished').map((event) => event.payload).find((payload) => payload.failureKind === 'stalled');
    assert.ok(finished, `${stalledBy}: a stalled attempt.finished`);
    assert.equal(finished.stalled, true);
    assert.equal(finished.stalledBy, stalledBy);
    assert.equal(Number.isFinite(finished[key]), true, `${stalledBy}: ${key}`);
    const attempt = run.state.attempts.find((entry) => entry.failureKind === 'stalled');
    assert.equal(attempt.stalledBy, stalledBy);
  }
});

test('a watch prints each recorded warning once and does not synthesize its own; an older run still gets synthesized ones', async (t) => {
  const f = fixture(t);
  const run = await launch(f, 'wf-stalew-abcdef', dispatchWith(async () => { await sleep(1700); return null; }));
  const events = readEvents(run.runDir);
  const recorded = events.filter((event) => event.type === 'attempt.stale');
  assert.equal(recorded.length, 1);
  // The run as the watch saw it mid-attempt: running, quiet, recorded flag set.
  const attempt = { ...run.state.attempts[0], status: 'running', finishedAt: null };
  const midway = { ...run.state, attempts: [attempt] };
  let probed = 0;
  const alwaysStale = () => { probed += 1; return { stale: true, score: 2, staleSince: Date.now() - 5000, reasons: ['quiet'], progressWindowSec: 1 }; };
  const replay = notableWatchEvents({ events: recorded, state: midway, stale: alwaysStale, memory: initialWatchMemory(midway), nowMs: Date.now() });
  const lines = replay.notable.filter((event) => event.type === 'attempt.stale').map((event) => renderWatchEvent(event));
  assert.equal(lines.length, 1, 'the recorded warning, once, with no synthesized twin');
  const later = notableWatchEvents({ events: [], state: midway, stale: alwaysStale, memory: replay.memory, nowMs: Date.now() + 5000 });
  assert.deepEqual(later.notable.filter((event) => event.type === 'attempt.stale'), [], 'nothing further synthesized');
  assert.equal(probed, 0, 'a run that records its warnings is not scored by the watch');

  // An older run (no runner flag, no recorded events) is still scored by the watch.
  const older = { ...midway, runner: { ...midway.runner, recordsStale: undefined } };
  const synth = notableWatchEvents({ events: [], state: older, stale: alwaysStale, memory: initialWatchMemory(older), nowMs: Date.now() });
  assert.equal(synth.notable.filter((event) => event.type === 'attempt.stale').length, 1);
  assert.ok(probed > 0);
});
