// Runs never wait: every stop is a finished run whose result hands back what is
// left, and the caller decides what happens next. These tests cover the pieces
// that make that true: the handback in the result and its summary, resume as a
// retry of a finished run, the worker silence cutoff, "no eligible pool"
// failing fast with the time a retry can get through, a kernel that throws
// marking its run interrupted, and the launch-time refusals.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { readEvents } from '../src/workflow/events.js';
import { createV2GoalDocument } from '../src/workflow/v2-state.js';
import { reopenV2RunForRetry, runV2AutonomousWorkflow } from '../src/workflow/v2-runtime.js';
import { readRollupIndex } from '../src/workflow/rollup.js';
import {
  formatV2HandbackLines, summarizeV2Result, v2RetryPlan, validateV2ResultEnvelope,
} from '../src/workflow/v2-outcome.js';
import { classifyV2DispatchFailure, dispatchV2Action, workerSilenceTimeoutSec } from '../src/workflow/v2-dispatch.js';
import { runDelegate, watchOnce } from '../src/lib/watch.js';

const ROOT = resolve(new URL('..', import.meta.url).pathname);
const BIN = join(ROOT, 'bin', 'bullswarm.js');

const work = (id, options = {}) => ({
  id, purpose: `Deliver ${id}`, dependsOn: [], affects: ['deliver'], ownedFiles: [`${id}.txt`],
  prompt: `Write ${id}.txt.`, lane: 'build', effort: 'low', evidenceFor: [], inputs: [], produces: [], ...options,
});
const check = (id, dependsOn) => ({
  id, purpose: `Check ${id}`, dependsOn, affects: [], ownedFiles: [], prompt: 'Inspect the delivered files.',
  lane: 'analyze', effort: 'low', evidenceFor: ['deliver'], inputs: [], produces: [],
});
const initial = (actions) => ({
  schemaVersion: 'bullswarm.workflow.planner-response.v2', kind: 'program', summary: 'Initial plan.',
  program: { schemaVersion: 'bullswarm.workflow.program.v2', actions },
});

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'bullswarm-handback-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const workspace = join(root, 'repo');
  const bullswarmDir = join(root, 'home');
  mkdirSync(workspace); mkdirSync(bullswarmDir);
  const goalDocument = createV2GoalDocument({
    goal: 'Deliver the requested files', cwd: workspace,
    requirements: [{ id: 'deliver', text: 'Deliver the requested files and validate them.' }],
    settings: { executionMode: 'program', workspaceMode: 'shared', scout: false, plannerMode: 'caller', concurrency: 2 },
  });
  return { root, workspace, bullswarmDir, goalDocument };
}

// Each step succeeds unless `outcomes[id](callNumber)` returns a failed
// dispatch result for that call. A check records passing evidence unless
// `judgments[id]` gives the requirement record it reports instead.
function scripted(outcomes = {}, judgments = {}) {
  const calls = [];
  const dispatch = async (options) => {
    const id = options.action.id;
    calls.push(id);
    const files = options.paths(1);
    const record = {
      ordinal: 1, pool: 'fixture', model: 'fixture', status: 'running',
      startedAt: new Date().toISOString(), taskFile: files.taskFile, outFile: files.outFile,
    };
    writeFileSync(files.taskFile, options.taskText);
    options.onAttempt?.('started', record);
    const failure = outcomes[id]?.(calls.filter((entry) => entry === id).length) ?? null;
    if (failure) {
      Object.assign(record, { status: 'failed', finishedAt: new Date().toISOString(), failureKind: failure.failureKind, why: failure.verdict.why });
      options.onAttempt?.('finished', record);
      return { attempts: [record], ...failure };
    }
    if (options.action.evidenceFor?.length) {
      const candidatePath = options.taskText.match(/exact durable path: '([^']+)'/)?.[1];
      writeFileSync(candidatePath, JSON.stringify({
        schemaVersion: 'bullswarm.workflow.evidence.v2',
        requirements: Object.fromEntries(options.action.evidenceFor.map((requirement) => [requirement, judgments[id] ?? { status: 'passed', evidence: ['every file is present'], concerns: [] }])),
      }));
      writeFileSync(files.outFile, 'evidence recorded');
      const verdict = { ok: true, structured: options.outputValidator('prose'), outFile: files.outFile };
      Object.assign(record, { status: 'succeeded', finishedAt: new Date().toISOString() });
      options.onAttempt?.('finished', record, verdict);
      return { ok: true, status: 'succeeded', attempts: [record], verdict };
    }
    writeFileSync(join(options.targetDir, `${id}.txt`), 'done');
    writeFileSync(files.outFile, `delivered ${id}`);
    Object.assign(record, { status: 'succeeded', finishedAt: new Date().toISOString() });
    options.onAttempt?.('finished', record);
    return { ok: true, status: 'succeeded', attempts: [record], verdict: { ok: true, outFile: files.outFile } };
  };
  return { dispatch, calls };
}

const failed = (failureKind, why, extra = {}) => ({ ok: false, status: 'failed', failureKind, verdict: { ok: false, why, meta: { exitCode: null } }, ...extra });
const STALLED_WHY = 'stalled: the worker wrote nothing for 60 min and was stopped';

test('failing steps end the run at once with a handback that says what a resume reruns and when a pool is back', async (t) => {
  const f = fixture(t);
  const retryAfter = new Date(Date.now() + 3 * 60_000).toISOString();
  const noPoolWhy = `no eligible pool: every pool that can run this step is paused until ${retryAfter}`;
  const s = scripted({
    a: () => failed('stalled', STALLED_WHY),
    b: () => failed('unavailable', noPoolWhy, { retryAfter }),
    c: () => failed('semantic', 'the worker reported the change could not be made'),
  });
  const run = await runV2AutonomousWorkflow({
    bullswarmDir: f.bullswarmDir, goalDocument: f.goalDocument, pools: [], runId: 'wf-handbk1-abcdef',
    initialPlannerResponse: initial([work('a'), work('b'), work('c'), work('d', { dependsOn: ['a'] }), check('verify', ['a', 'b', 'c', 'd'])]),
    // Launched as a stage-2 run: its handback keeps the saved-run shape (no
    // stage-3 `retries`), which is what this test pins.
    dependencies: { dispatchV2Action: s.dispatch, runFeatures: { deliverableGate: 1, proofLabels: 1 } },
  });
  assert.equal(run.result.status, 'partial');
  assert.equal(run.result.verified, false);
  assert.equal(run.result.reason, '5 of 5 steps did not succeed: a failed (stalled), b failed (unavailable), c failed (semantic) and 2 more');
  const byId = Object.fromEntries(run.result.handback.unfinished.map((entry) => [entry.id, entry]));
  assert.deepEqual(byId.a, { id: 'a', status: 'failed', failureKind: 'stalled', why: STALLED_WHY, retryable: true });
  assert.deepEqual(byId.b, { id: 'b', status: 'failed', failureKind: 'unavailable', why: noPoolWhy, retryAfter, retryable: true });
  assert.equal(byId.c.retryable, false, 'a step the worker failed needs the caller');
  assert.deepEqual([byId.d.status, byId.d.retryable], ['blocked', true]);
  assert.deepEqual([byId.verify.status, byId.verify.retryable], ['blocked', true]);
  assert.deepEqual(run.result.handback.unresolvedRequirements, [{ id: 'deliver', status: 'pending', why: 'no evidence recorded for the current work' }]);
  assert.deepEqual(run.result.handback.unreadSteering, []);
  assert.equal(run.state.actions.find((action) => action.id === 'b').lastFailure.retryAfter, retryAfter);
  assert.equal(readEvents(run.runDir).filter((event) => event.type === 'workflow.finished').at(-1).payload.unfinished, 5);

  const broken = structuredClone(run.result);
  broken.handback.unfinished[0].retryable = 'yes';
  assert.throws(() => validateV2ResultEnvelope(broken), /handback\.unfinished\[0\]\.retryable must be a boolean/);
  const extra = structuredClone(run.result);
  extra.handback.later = true;
  assert.throws(() => validateV2ResultEnvelope(extra), /handback\.later is not allowed/);

  const summary = summarizeV2Result(run.result, run.state, { runDir: run.runDir });
  const token = run.shortId;
  assert.equal(summary.handback.options.continue, `bullswarm workflow plan export ${token} --out plan.json, edit it, then bullswarm workflow plan revise ${token} --program plan.json (--rerun <step ids> runs finished steps again)`);
  assert.equal(summary.handback.options.retry, `bullswarm workflow resume ${token} (reruns a, b, d, verify)`);
  assert.ok(summary.handback.options.takeOver && summary.handback.options.restart);
  const lines = formatV2HandbackLines(summary).join('\n');
  assert.ok(lines.includes(`  step b: failed (unavailable) — ${noPoolWhy} · its pool is back at ${retryAfter}`), lines);
  assert.match(lines, /  requirement deliver: pending — no evidence recorded for the current work/);
  assert.match(lines, /your call:\n  continue  bullswarm workflow plan export /);
});

test('a reason quoting a long check finding cuts it between words and marks the cut', async (t) => {
  const f = fixture(t);
  // The finding a real check wrote on run t4pdp2 (2026-09-14); the reason line
  // used to end "It contains no menti".
  const finding = "README.md read directly (7 lines, 87 bytes): '# e2e-steady', 'A tiny text library.', '## capitalize(word)', 'Upper-cases the first letter.' It contains no mention of truncate and no usage example.";
  const s = scripted({}, { verify: { status: 'failed', evidence: [finding], concerns: [] } });
  const response = initial([work('a'), check('verify', ['a'])]);
  // Review only, no repair: 0 fix cycles in a stage-3 run (D13).
  response.program.defaults = { verifyRounds: 0 };
  const run = await runV2AutonomousWorkflow({
    bullswarmDir: f.bullswarmDir, goalDocument: f.goalDocument, pools: [], runId: 'wf-handbk4-abcdef',
    initialPlannerResponse: response,
    dependencies: { dispatchV2Action: s.dispatch },
  });
  assert.equal(run.result.status, 'completed');
  assert.equal(run.result.verified, false);
  const prefix = 'all 2 steps succeeded, but not verified: deliver failed — deliver: ';
  assert.ok(run.result.reason.startsWith(prefix), run.result.reason);
  const quoted = run.result.reason.slice(prefix.length);
  assert.ok(quoted.endsWith('…') && quoted.length <= 160, quoted);
  const kept = quoted.slice(0, -1);
  assert.ok(finding.startsWith(kept), quoted);
  assert.match(finding.slice(kept.length), /^[\s,;:—-]/, `the cut falls between words: ${quoted}`);
  const requirement = run.result.handback.unresolvedRequirements.find((entry) => entry.id === 'deliver');
  assert.equal(requirement.status, 'failed');
  assert.ok(requirement.why.startsWith("README.md read directly") && requirement.why.includes('no mention of truncate'), requirement.why);
});

test('resume reopens a finished run for the steps a retry can fix and leaves the rest to the caller', async (t) => {
  const f = fixture(t);
  const runId = 'wf-handbk2-abcdef';
  const s = scripted({
    a: (call) => (call === 1 ? failed('stalled', STALLED_WHY) : null),
    c: () => failed('semantic', 'the worker reported the change could not be made'),
  });
  const first = await runV2AutonomousWorkflow({
    bullswarmDir: f.bullswarmDir, goalDocument: f.goalDocument, pools: [], runId,
    initialPlannerResponse: initial([work('a'), work('c'), work('d', { dependsOn: ['a'] })]),
    dependencies: { dispatchV2Action: s.dispatch },
  });
  assert.equal(first.result.status, 'partial');
  assert.deepEqual(v2RetryPlan(first.state), { rerun: ['a'], blocked: ['d'], needsCaller: [{ id: 'c', status: 'failed', failureKind: 'semantic' }] });

  const reopened = reopenV2RunForRetry({ bullswarmDir: f.bullswarmDir, runId });
  assert.equal(reopened.status, 'reopened');
  assert.deepEqual(reopened.requeued, ['a', 'd']);
  assert.equal(reopened.archivedResult, join(first.runDir, 'result-before-resume-1.json'));
  assert.ok(existsSync(reopened.archivedResult));
  assert.equal(existsSync(join(first.runDir, 'result.json')), false);
  assert.equal(reopened.state.lifecycle.status, 'running');
  assert.equal(existsSync(join(first.runDir, 'rollup.json')), false);
  assert.equal(existsSync(join(first.runDir, 'rollup-before-resume-1.json')), true);
  assert.equal(readRollupIndex(f.bullswarmDir).find((record) => record.runId === runId)?.status, 'running');
  assert.deepEqual(readEvents(first.runDir).filter((event) => event.type === 'workflow.reopened').at(-1).payload, {
    previousStatus: 'partial', source: 'resume', archivedResult: reopened.archivedResult, requeued: ['a', 'd'],
  });

  const resumed = await runV2AutonomousWorkflow({ bullswarmDir: f.bullswarmDir, resumeRunId: runId, pools: [], dependencies: { dispatchV2Action: s.dispatch } });
  assert.deepEqual(s.calls.slice(0, 2).sort(), ['a', 'c']);
  assert.deepEqual(s.calls.slice(2), ['a', 'd'], 'only the retryable step and the step blocked behind it ran again');
  assert.equal(resumed.result.status, 'partial', 'c still needs the caller');
  assert.deepEqual(resumed.result.handback.unfinished.map((entry) => [entry.id, entry.retryable]), [['c', false]]);
  assert.equal(resumed.state.actions.find((action) => action.id === 'a').supersededAttempts, 1);

  const again = reopenV2RunForRetry({ bullswarmDir: f.bullswarmDir, runId });
  assert.equal(again.status, 'nothing-to-retry');
  assert.deepEqual(again.needsCaller, [{ id: 'c', status: 'failed', failureKind: 'semantic' }]);
  assert.equal(JSON.parse(readFileSync(join(first.runDir, 'state.json'), 'utf8')).lifecycle.status, 'partial', 'nothing changed');
});

test('a kernel that throws marks its run interrupted with the error, and a resume finishes it without repeating work', async (t) => {
  const f = fixture(t);
  const runId = 'wf-handbk3-abcdef';
  const s = scripted();
  await assert.rejects(runV2AutonomousWorkflow({
    bullswarmDir: f.bullswarmDir, goalDocument: f.goalDocument, pools: [], runId,
    initialPlannerResponse: initial([work('a')]),
    dependencies: { dispatchV2Action: s.dispatch, writeResultAtomic: () => { throw new Error('disk full while writing the result'); } },
  }), /disk full while writing the result/);
  const runDir = join(f.bullswarmDir, 'workflows', runId);
  assert.equal(JSON.parse(readFileSync(join(runDir, 'state.json'), 'utf8')).lifecycle.status, 'interrupted');
  assert.equal(readEvents(runDir).filter((event) => event.type === 'workflow.interrupted').at(-1).payload.reason, 'kernel stopped on an error: disk full while writing the result');
  const resumed = await runV2AutonomousWorkflow({ bullswarmDir: f.bullswarmDir, resumeRunId: runId, pools: [], dependencies: { dispatchV2Action: s.dispatch } });
  assert.equal(resumed.result.status, 'completed');
  assert.deepEqual(s.calls, ['a'], 'finished work is never repeated');
});

test('a worker that goes silent is stopped as stalled; one that keeps writing never is', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'bullswarm-silence-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const taskFile = join(dir, 'task.md');
  writeFileSync(taskFile, 'task');
  const quiet = {
    name: 'fixture-quiet',
    spawn: { cmd: ['node', '-e', "process.stdout.write('starting\\n'); setTimeout(() => process.stdout.write('late\\n'), 5000);", '{taskFile}'] },
    outputExtraction: { strategy: 'stdout' },
  };
  const started = Date.now();
  const silent = await runDelegate(quiet, taskFile, dir, { silenceTimeoutSec: 0.5 });
  assert.equal(silent.stalled, true);
  assert.ok(Date.now() - started < 4000, 'stopped long before the worker would have finished');
  assert.doesNotMatch(silent.stdout, /late/);

  const chatty = {
    name: 'fixture-chatty',
    spawn: { cmd: ['node', '-e', "let n = 0; const timer = setInterval(() => { process.stdout.write('tick ' + (++n) + '\\n'); if (n === 6) clearInterval(timer); }, 200);", '{taskFile}'] },
    outputExtraction: { strategy: 'stdout' },
  };
  const busy = await runDelegate(chatty, taskFile, dir, { silenceTimeoutSec: 0.5 });
  assert.equal(busy.stalled, false, 'a worker that keeps writing is not cut off, however long it runs');
  assert.equal(busy.exitCode, 0);
  assert.match(busy.stdout, /tick 6/);

  const verdict = await watchOnce(quiet, 'Do the thing.', dir, { taskFile: join(dir, 'task-2.md'), outFile: join(dir, 'out-2.md') }, { silenceTimeoutSec: 0.5 });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.failureKind, 'stalled');
  assert.equal(verdict.why, 'stalled: the worker wrote nothing for 0.5 s and was stopped');
  assert.equal(verdict.meta.stalled, true);
  assert.equal(classifyV2DispatchFailure(verdict), 'stalled');

  assert.equal(workerSilenceTimeoutSec({}), 3600);
  assert.equal(workerSilenceTimeoutSec({ BULLSWARM_WORKER_SILENCE_SEC: '90' }), 90);
  assert.equal(workerSilenceTimeoutSec({ BULLSWARM_WORKER_SILENCE_SEC: 'soon' }), 3600);
});

test('with no pool able to run a step, dispatch fails at once and says why', async () => {
  const NOW = Date.parse('2026-09-14T10:00:00Z');
  const pool = (name, extra = {}) => ({
    name, lanes: ['analyze', 'build', 'chore'], enabled: true, spawn: { cmd: ['fake'] },
    modelSelection: { flag: '--model' }, strategyAssignments: { low: { pool: name, model: 'gpt-5.6-luna' } }, ...extra,
  });
  const core = { config: { depthLimit: 2 }, pools: {}, incumbents: {}, decisionLog: [] };
  const dependencies = {
    watchOnce: async () => { throw new Error('nothing may be dispatched'); },
    loadState: () => structuredClone(core),
    saveState: () => {},
    now: () => NOW,
  };
  const base = { action: { id: 'do-work', lane: 'build', effort: 'low' }, taskText: 'do it', targetDir: '/tmp', paths: { taskFile: '/tmp/task.md', outFile: '/tmp/out.md' }, bullswarmDir: '/tmp/bs', dependencies };

  const oneFree = await dispatchV2Action({
    ...base,
    pools: [pool('luna-1')],
    strictPool: 'gone-pool',
  });
  assert.equal(oneFree.retryAfter, undefined);
  assert.equal(oneFree.verdict.why, 'no eligible pool: the pinned pool gone-pool cannot run build/low work (it is disabled or has no model on the low tier)');

  const none = await dispatchV2Action({ ...base, pools: [] });
  assert.equal(none.verdict.why, 'no eligible pool: no enabled pool has a model on the low tier for build work');
});

// Stage 3: the marked twin of the test above (owner decision, 2026-09-25). A
// step no capable pool can take now never waits: it goes to the caller at once,
// with each capable pool's reason and the first known return, and is filed as
// quota when every pool is out for a usage limit.
test('marked run: with every capable pool at a window limit, the step goes to the caller at once with the first return, never a wait', async () => {
  const NOW = Date.parse('2026-09-14T10:00:00Z');
  const pool = (name, extra = {}) => ({
    name, lanes: ['analyze', 'build', 'chore'], enabled: true, spawn: { cmd: ['fake'] },
    modelSelection: { flag: '--model' }, strategyAssignments: { low: { pool: name, model: 'gpt-5.6-luna' } }, ...extra,
  });
  const core = { config: { depthLimit: 2 }, pools: {}, incumbents: {}, decisionLog: [] };
  let clock = NOW;
  const slept = [];
  const dependencies = {
    watchOnce: async () => { throw new Error('nothing may be dispatched'); },
    loadState: () => structuredClone(core),
    saveState: () => {},
    now: () => clock,
    sleep: async (ms) => { slept.push(ms); clock += ms; },
  };
  const base = {
    action: { id: 'do-work', lane: 'build', effort: 'low' }, taskText: 'do it', targetDir: '/tmp',
    paths: { taskFile: '/tmp/task.md', outFile: '/tmp/out.md' }, bullswarmDir: '/tmp/bs', dependencies, failureRule: true,
  };
  // A pool whose meter reads its 5-hour window at the limit until then.
  const quotaUntil = (minutes) => ({ fiveHourUsedPct: 100, fiveHourResetsAt: new Date(NOW + minutes * 60_000).toISOString() });

  // Every capable pool at its limit: a usage limit, back to the caller.
  const spent = await dispatchV2Action({ ...base, pools: [pool('luna-1', quotaUntil(30)), pool('luna-2', quotaUntil(90))] });
  assert.equal(spent.ok, false);
  assert.equal(spent.status, 'failed', 'it goes to the caller, it does not wait');
  assert.equal(spent.failureKind, 'quota');
  assert.equal(spent.retryAfter, '2026-09-14T10:30:00.000Z', 'the first pool back');
  assert.equal(spent.verdict.why, 'no pool with quota to spare: luna-1 at its 5-hour limit until 2026-09-14T10:30:00.000Z; luna-2 at its 5-hour limit until 2026-09-14T11:30:00.000Z');
  assert.deepEqual(spent.attempts, []);
  assert.deepEqual(slept, [], 'no wait of any kind');
  assert.equal(clock, NOW);

  // A 5-hour wall is a usage limit too, and its reset counts as a return.
  const walled = await dispatchV2Action({
    ...base,
    pools: [pool('luna-1', { burstGate: true, fiveHourResetsAt: new Date(NOW + 20 * 60_000).toISOString() }), pool('luna-2', quotaUntil(90))],
  });
  assert.equal(walled.failureKind, 'quota');
  assert.equal(walled.retryAfter, '2026-09-14T10:20:00.000Z');
  assert.equal(walled.verdict.why, 'no pool with quota to spare: luna-1 at its 5-hour limit until 2026-09-14T10:20:00.000Z; luna-2 at its 5-hour limit until 2026-09-14T11:30:00.000Z');

  // Nothing capable at all: it fails at once, as in a saved run.
  const none = await dispatchV2Action({ ...base, pools: [] });
  assert.equal(none.ok, false);
  assert.equal(none.failureKind, 'unavailable');
  assert.equal(none.retryAfter, undefined);
  assert.equal(none.verdict.why, 'no eligible pool: no enabled pool has a model on the low tier for build work');
  assert.deepEqual(slept, [], 'still no wait');
});

test('a failing requirement keeps its reason in the summary even when a large run has to shrink it', () => {
  const fixtureEnvelope = JSON.parse(readFileSync(join(ROOT, 'tests', 'fixtures', 'real-result-ze5xz2.json'), 'utf8'));
  const big = structuredClone(fixtureEnvelope);
  big.status = 'partial';
  big.verified = false;
  big.requirements[0].status = 'failed';
  big.requirements[0].evidence.at(-1).evidence[0] = `The export button still downloads an empty CSV; ${'details '.repeat(40)}`;
  big.actions = Array.from({ length: 30 }, (_, index) => ({
    ...fixtureEnvelope.actions[0], id: `step-${index}`, status: 'failed',
    failure: { kind: 'semantic', message: `step ${index} failed: ${'x'.repeat(250)}` },
  }));
  const summary = summarizeV2Result(big);
  const bytes = Buffer.byteLength(JSON.stringify(summary), 'utf8');
  assert.ok(bytes < 4096, `summary is ${bytes} bytes`);
  assert.match(summary.requirements[0].why, /^The export button still downloads an empty CSV/);
  assert.ok(summary.requirements[0].why.length >= 80, summary.requirements[0].why);
  assert.equal(summary.requirements[1].why, null, 'a passed requirement carries no reason');
  assert.ok(summary.handback.unfinishedOmitted > 0);
  assert.equal(summary.handback.options.retry, undefined, 'no step failed for a reason a retry fixes');
});

test('plan validate refuses a directory or glob as an owned file and names requirements no step checks', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'bullswarm-validate-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  const target = join(root, 'target');
  mkdirSync(home);
  mkdirSync(join(target, 'src'), { recursive: true });
  writeFileSync(join(home, 'state.json'), JSON.stringify({ version: 1, pools: {}, incumbents: {}, decisionLog: [], config: { depthLimit: 2 } }));
  const programOf = (ownedFiles) => ({
    schemaVersion: 'bullswarm.workflow.program.v2',
    actions: [
      { id: 'build-it', purpose: 'Build it', dependsOn: [], affects: ['requirement-1'], ownedFiles, prompt: 'Build it.', lane: 'build', effort: 'low', evidenceFor: [], inputs: [], produces: [] },
      { id: 'check-it', purpose: 'Check it', dependsOn: ['build-it'], affects: [], ownedFiles: [], prompt: 'Check it.', lane: 'analyze', effort: 'low', evidenceFor: ['requirement-1'], inputs: [], produces: [] },
    ],
  });
  const validate = (name, ownedFiles) => {
    const path = join(root, name);
    writeFileSync(path, JSON.stringify(programOf(ownedFiles)));
    return spawnSync(process.execPath, [BIN, 'workflow', 'plan', 'validate', '1. Build it. 2. Document it.', '--cwd', target, '--program', path, '--json'], {
      encoding: 'utf8', env: { ...process.env, BULLSWARM_HOME: home, BULLSWARM_DEPTH: '0' },
    });
  };
  const glob = validate('glob.json', ['src/']);
  assert.equal(glob.status, 2, glob.stdout || glob.stderr);
  assert.ok(JSON.parse(glob.stdout).issues.some((issue) => issue.includes('must name one exact file, not a directory or glob ("src/")')), glob.stdout);
  const directory = validate('dir.json', ['src']);
  assert.equal(directory.status, 2, directory.stdout || directory.stderr);
  assert.ok(JSON.parse(directory.stdout).issues.some((issue) => issue.includes('ownedFiles[0] names a directory ("src"); list the exact files step build-it may change')), directory.stdout);
  const good = validate('good.json', ['src/index.js']);
  assert.equal(good.status, 0, good.stderr);
  const { advisories } = JSON.parse(good.stdout);
  assert.deepEqual(advisories.map((advisory) => advisory.code), ['requirement-unchecked']);
  assert.match(advisories[0].message, /^no step gives evidence for requirement-2; /);
});

// L2: a failed step the summary's handback left out for size is still named
// in the text, before any requirement line; requirement lines give way for
// it, and the steps still left out are counted with the blocked ones.
test('the text handback never hides a failed step behind requirement lines', () => {
  const summary = {
    actions: [
      { id: 'build', status: 'succeeded' }, { id: 'kernel', status: 'failed' },
      { id: 'integrate', status: 'blocked' }, { id: 'docs', status: 'blocked' },
    ],
    requirements: Array.from({ length: 9 }, (_, index) => ({ id: `requirement-${index + 1}`, status: 'failed', why: 'not met' })),
    handback: { unfinished: [], unfinishedOmitted: 3, unreadSteering: [], options: {} },
  };
  const lines = formatV2HandbackLines(summary);
  assert.equal(lines[0], '  step kernel: failed');
  assert.equal(lines[1], '  … and 2 more unfinished step(s) (2 blocked by a failed step)');
  assert.equal(lines.filter((line) => line.startsWith('  requirement ')).length, 5, 'one requirement line gives way for the failed step');
  assert.equal(lines[7], '  … and 4 more open requirement(s)');
  // Nothing hidden: the text reads as before.
  const whole = { ...summary, handback: { unfinished: [{ id: 'kernel', status: 'failed', failureKind: 'process', why: 'exit 1', retryable: false }], unreadSteering: [], options: {} } };
  const plain = formatV2HandbackLines(whole);
  assert.equal(plain[0], '  step kernel: failed (process) — exit 1');
  assert.equal(plain.filter((line) => line.startsWith('  requirement ')).length, 6);
});

// L4 and L5: a marked run whose loop left a requirement failing hands back
// the review verbs; an accepted requirement reads as accepted by choice.
function reviewEnvelope({ accepted = false } = {}) {
  return {
    runId: 'wf-test-review', shortId: 'rev001', status: 'partial', verified: false, executionMode: 'program',
    reason: 'not verified', finishedAt: '2026-09-24T01:10:00Z', goal: 'Ship the acme report',
    requirements: [{
      id: 'requirement-3', text: 'totals are right', mandatory: true, status: 'failed', workRevision: 2,
      evidence: [{ sourceAction: 'verify-round-2', status: 'failed', evidence: ['the empty week still totals 1'], reviewer: { pool: 'pool-b', model: 'model-b', provider: null } }],
      ...(accepted ? { accepted: { step: 'verify-round-2', reason: 'the empty week is out of scope', at: '2026-09-24T01:20:00Z' } } : {}),
    }],
    actions: [
      { id: 'report', status: 'succeeded', outputFile: '/runs/acme/out-report-attempt-1.md' },
      { id: 'verify-round-2', status: 'succeeded', outputFile: '/runs/acme/out-verify-round-2-attempt-1.md' },
    ],
    usage: { total: 2, byPool: { 'pool-a': 1, 'pool-b': 1 } },
    verifyRounds: { max: 2, used: 2, stoppedBy: 'rounds', phases: [] },
    ...(accepted ? {} : {
      callerDecision: { verifyRounds: '2/2', requirements: [{ id: 'requirement-3', status: 'failed', round: 2, evidence: 'the empty week still totals 1', next: 'fix it with a step' }] },
    }),
    handback: { unfinished: [], unresolvedRequirements: [{ id: 'requirement-3', status: 'failed', why: 'the empty week still totals 1' }], unreadSteering: [] },
  };
}

test('a marked run with a requirement its loop left failing hands back rerun and accept for the check', () => {
  const MARKED = { deliverableGate: 1, proofLabels: 1, failureRule: 1, reviewPlacement: 'caller' };
  const summary = summarizeV2Result(reviewEnvelope(), null, { runDir: '/runs/acme', features: MARKED });
  assert.equal(summary.handback.options.rerunReview, 'bullswarm workflow step rerun rev001 verify-round-2 --avoid pool-b (judges it again on another pool)');
  assert.equal(summary.handback.options.acceptRequirement, 'bullswarm workflow step accept rev001 verify-round-2 --requirement requirement-3 --reason "…" (recorded as your choice, never proof)');
  const lines = formatV2HandbackLines(summary);
  assert.ok(lines.includes('  rerun     bullswarm workflow step rerun rev001 verify-round-2 --avoid pool-b (judges it again on another pool)'));
  assert.ok(lines.includes('  accept    bullswarm workflow step accept rev001 verify-round-2 --requirement requirement-3 --reason "…" (recorded as your choice, never proof)'));
  // A saved (stage-2) run's options are unchanged.
  const saved = summarizeV2Result(reviewEnvelope(), null, { runDir: '/runs/acme', features: { deliverableGate: 1, proofLabels: 1 } });
  assert.deepEqual(Object.keys(saved.handback.options), ['continue', 'takeOver', 'restart']);
});

test('an accepted requirement reads `failed · accepted by choice` and its summary row carries accepted', () => {
  const MARKED = { deliverableGate: 1, proofLabels: 1, failureRule: 1, reviewPlacement: 'caller' };
  const summary = summarizeV2Result(reviewEnvelope({ accepted: true }), null, { runDir: '/runs/acme', features: MARKED });
  assert.equal(summary.verified, false);
  assert.equal(summary.requirements[0].accepted, 'the empty week is out of scope');
  assert.equal(summary.requirements[0].status, 'failed');
  const lines = formatV2HandbackLines(summary);
  assert.ok(lines.includes('  requirement requirement-3: failed · accepted by choice "the empty week is out of scope"'), lines.join('\n'));
  assert.equal(Object.hasOwn(summary.handback.options, 'acceptRequirement'), false, 'nothing left to accept');
});
