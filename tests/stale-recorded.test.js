// Stale warnings are saved in the run's events by the process that runs the
// attempts, so a run nobody watched still leaves a count (2026-10-31: the
// eval could not report stale warnings at all). Fake worker, temp repo and
// made-up names only; the thresholds and the check cadence are shrunk through
// the runner's test hooks.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readEvents } from '../src/workflow/events.js';
import { createV2GoalDocument } from '../src/workflow/v2-state.js';
import { runV2AutonomousWorkflow } from '../src/workflow/v2-runtime.js';
import { dispatchV2Action } from '../src/workflow/v2-dispatch.js';
import { DEFAULT_STALE_THRESHOLDS } from '../src/lib/stale.js';
import { implicitV3Requirements } from '../src/workflow/program-v3.js';
import { STAGE3_RUN_FEATURES, withProgramFormat } from '../src/workflow/run-features.js';
import { createStaleRecorder } from '../src/workflow/stale-recorder.js';
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

// origin/main's (0.38.18) state validator, with its own imports resolved to this
// checkout's files: a build that old must still be able to read what this one
// writes. Null when the ref is not in this clone.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
async function mainValidator(t) {
  let source;
  try { source = execFileSync('git', ['-C', ROOT, 'show', 'origin/main:src/workflow/v2-state.js'], { encoding: 'utf8', maxBuffer: 1 << 26 }); } catch { return null; }
  const dir = mkdtempSync(join(tmpdir(), 'bullswarm-main-validator-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'src', 'workflow'), { recursive: true });
  writeFileSync(join(dir, 'package.json'), '{"type":"module"}\n');
  symlinkSync(join(ROOT, 'src', 'lib'), join(dir, 'src', 'lib'));
  for (const name of readdirSync(join(ROOT, 'src', 'workflow'))) {
    if (name !== 'v2-state.js') symlinkSync(join(ROOT, 'src', 'workflow', name), join(dir, 'src', 'workflow', name));
  }
  writeFileSync(join(dir, 'src', 'workflow', 'v2-state.js'), source);
  return (await import(pathToFileURL(join(dir, 'src', 'workflow', 'v2-state.js')).href)).validateV2DurableState;
}
const savedState = (run) => JSON.parse(readFileSync(join(run.runDir, 'state.json'), 'utf8'));

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
  // The marker is an event (an old build skips unknown event types), never a state key.
  assert.equal(typed(run.runDir, 'stale.recording').length, 1);
  assert.deepEqual(Object.keys(savedState(run).runner).sort(), ['lastHeartbeatAt', 'pid', 'startedAt']);
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
    // The limit is named in the event only; the attempt record keeps the seconds.
    const attempt = savedState(run).attempts.find((entry) => entry.failureKind === 'stalled');
    assert.equal(attempt.stalledBy, undefined);
    assert.equal(Number.isFinite(attempt[key]), true);
  }
});

test('state.json written by this runner validates under origin/main (0.38.18)', async (t) => {
  const validate = await mainValidator(t);
  if (!validate) return t.skip('origin/main is not in this clone');
  const f = fixture(t);
  const done = await launch(f, 'wf-stalec1-abcdef', dispatchWith(async () => { await sleep(1700); return null; }));
  assert.equal(validate(savedState(done)), true, 'a run that went stale and finished');
  const killed = await launch(f, 'wf-stalec2-abcdef', dispatchWith(async () => ({
    ok: false, why: 'no output for 3600s (silence)', failureKind: 'stalled',
    meta: { stalled: true, stalledBy: 'silence', exitCode: null, wallSec: 3600 },
  })));
  assert.equal(validate(savedState(killed)), true, 'a run whose attempt a limit killed');
  // The proof has teeth: the validator does refuse an unknown key.
  const tampered = savedState(done);
  tampered.runner.recordsStale = true;
  assert.throws(() => validate(tampered));
});

test('the recorder closes every open episode when the run ends', () => {
  const events = [];
  const state = { program: { actions: [] }, attempts: [{ id: 'report-1', actionId: 'report', ordinal: 1, status: 'running' }] };
  const probe = () => ({ stale: true, score: 2, staleSince: 1000, reasons: ['quiet'], progressWindowSec: 1, progressAt: null });
  const recorder = createStaleRecorder({ emit: (type, payload) => events.push({ type, payload }), probe, everyMs: 0 });
  recorder.check(state, 5000);
  assert.deepEqual(events.map((event) => event.type), ['attempt.stale']);
  assert.equal(typeof recorder.close, 'function', 'a close for the end of the run');
  recorder.close(9000);
  assert.deepEqual(events.map((event) => event.type), ['attempt.stale', 'attempt.stale_cleared']);
  assert.equal(events[1].payload.attemptId, 'report-1');
  recorder.close(9500);
  assert.equal(events.length, 2, 'closed once');
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
  const replay = notableWatchEvents({ events: recorded, state: midway, stale: alwaysStale, memory: initialWatchMemory(midway, { recordsStale: true }), nowMs: Date.now() });
  const lines = replay.notable.filter((event) => event.type === 'attempt.stale').map((event) => renderWatchEvent(event));
  assert.equal(lines.length, 1, 'the recorded warning, once, with no synthesized twin');
  const later = notableWatchEvents({ events: [], state: midway, stale: alwaysStale, memory: replay.memory, nowMs: Date.now() + 5000 });
  assert.deepEqual(later.notable.filter((event) => event.type === 'attempt.stale'), [], 'nothing further synthesized');
  assert.equal(probed, 0, 'a run that records its warnings is not scored by the watch');

  // An older run (no stale.recording marker, no recorded events) is still scored by the watch.
  const older = midway;
  const synth = notableWatchEvents({ events: [], state: older, stale: alwaysStale, memory: initialWatchMemory(older), nowMs: Date.now() });
  assert.equal(synth.notable.filter((event) => event.type === 'attempt.stale').length, 1);
  assert.ok(probed > 0);
});
