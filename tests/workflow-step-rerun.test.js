// `bullswarm workflow step rerun` (stage 3 §2.7, D20, D21): a CLI-built plan
// revision that reruns one step with its last failed attempt's handoff, and
// with --avoid adds pools to the step's route. The runs here are real program
// runs driven by the real kernel; only the worker dispatch is scripted.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { rerunV2Step } from '../src/workflow/cli.js';
import { createV2DurableState, createV2GoalDocument } from '../src/workflow/v2-state.js';
import { runV2AutonomousWorkflow } from '../src/workflow/v2-runtime.js';
import { appliedStepRestart, readStepRestarts, requestStepRestart } from '../src/workflow/v2-dispatch.js';
import { acquireKernelLease } from '../src/workflow/v2-process.js';
import { exportV2Plan } from '../src/workflow/v2-revision.js';
import { countRetries } from '../src/workflow/step-vocabulary.js';

const BIN = resolve(new URL('..', import.meta.url).pathname, 'bin', 'bullswarm.js');
const requirements = [{ id: 'deliver', text: 'Deliver the requested files.' }];
const LANES = ['analyze', 'build', 'chore'];
const POOLS = ['pool-a', 'pool-b'].map((name) => ({ name, enabled: true, lanes: LANES, connector: { name, lanes: LANES } }));

const work = (id, options = {}) => ({
  id, purpose: `Deliver ${id}`, dependsOn: [], affects: ['deliver'], ownedFiles: [`${id}.txt`],
  prompt: `Write ${id}.txt.`, lane: 'build', effort: 'low', evidenceFor: [], inputs: [], produces: [], ...options,
});
const initial = (actions) => ({
  schemaVersion: 'bullswarm.workflow.planner-response.v2', kind: 'program', summary: 'Initial plan.',
  program: { schemaVersion: 'bullswarm.workflow.program.v2', actions },
});

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'bullswarm-rerun-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const workspace = join(root, 'repo');
  const bullswarmDir = join(root, 'home');
  mkdirSync(workspace); mkdirSync(bullswarmDir);
  const goalDocument = createV2GoalDocument({
    goal: 'Deliver the requested files', cwd: workspace, requirements,
    settings: { executionMode: 'program', workspaceMode: 'shared', scout: false, plannerMode: 'caller', concurrency: 3 },
  });
  return { root, workspace, bullswarmDir, goalDocument };
}

// A dispatcher that fails a step as `failed-evidence` on pool-a the times the
// script says, and otherwise succeeds. It records every task text it was given.
function scripted(script = {}) {
  const calls = [];
  const gates = new Map();
  const hold = (actionId) => {
    let release;
    gates.set(actionId, new Promise((done) => { release = done; }));
    return () => release();
  };
  const dispatch = async (options) => {
    const id = options.action.id;
    const call = { actionId: id, taskText: options.taskText };
    calls.push(call);
    const outcome = (script[id] ?? []).shift() ?? 'succeed';
    const files = options.paths(1);
    const record = {
      ordinal: 1, pool: 'pool-a', model: 'model-a', status: 'running',
      startedAt: new Date().toISOString(), taskFile: files.taskFile, outFile: files.outFile,
    };
    writeFileSync(files.taskFile, options.taskText);
    options.onAttempt?.('started', record);
    const gate = gates.get(id);
    if (gate) {
      gates.delete(id);
      let poll;
      const stop = await Promise.race([gate.then(() => false), new Promise((done) => { poll = setInterval(() => { if (options.shouldCancel?.()) done(true); }, 5); })]);
      clearInterval(poll);
      if (stop) {
        Object.assign(record, { status: 'cancelled', finishedAt: new Date().toISOString(), failureKind: 'cancelled' });
        options.onAttempt?.('finished', record);
        return { ok: false, status: 'cancelled', failureKind: 'cancelled', attempts: [record], verdict: { ok: false, why: 'cancelled' } };
      }
    }
    if (outcome === 'fail') {
      writeFileSync(files.outFile, `tried ${id}`);
      const why = 'command evidence failed: npm test → exit 1';
      Object.assign(record, { status: 'failed', finishedAt: new Date().toISOString(), failureKind: 'failed-evidence', why, changedFileCount: 1 });
      options.onAttempt?.('finished', record, { ok: false, why });
      return { ok: false, status: 'failed', failureKind: 'failed-evidence', attempts: [record], verdict: { ok: false, why } };
    }
    writeFileSync(join(options.targetDir, `${id}.txt`), options.action.prompt);
    writeFileSync(files.outFile, `delivered ${id}`);
    Object.assign(record, { status: 'succeeded', finishedAt: new Date().toISOString() });
    options.onAttempt?.('finished', record);
    return { ok: true, status: 'succeeded', attempts: [record], verdict: { ok: true, outFile: files.outFile } };
  };
  return { dispatch, calls, hold, count: (id) => calls.filter((call) => call.actionId === id).length };
}

const runDirOf = (f, runId) => join(f.bullswarmDir, 'workflows', runId);
const readState = (f, runId) => JSON.parse(readFileSync(join(runDirOf(f, runId), 'state.json'), 'utf8'));
const statusOf = (state, id) => state.actions.find((action) => action.id === id)?.status;

function start(f, runId, actions, ctl) {
  return runV2AutonomousWorkflow({
    bullswarmDir: f.bullswarmDir, goalDocument: f.goalDocument, pools: [], runId,
    initialPlannerResponse: initial(actions),
    dependencies: { dispatchV2Action: ctl.dispatch, controlPollMs: 10 },
  });
}
const resumer = (f, ctl) => async (runId) => {
  const finished = await runV2AutonomousWorkflow({
    bullswarmDir: f.bullswarmDir, resumeRunId: runId, pools: [],
    dependencies: { dispatchV2Action: ctl.dispatch, controlPollMs: 10 },
  });
  return { resumed: true, status: finished.state?.lifecycle?.status ?? null };
};

async function until(predicate, { timeoutMs = 5000, what = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try { if (predicate()) return; } catch { /* state mid-write */ }
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((done) => setTimeout(done, 5));
  }
}

// A finished partial run: `build` failed its evidence on pool-a, `docs`
// (depends on build) is blocked, `side` succeeded.
async function failedRun(t, { script = { build: ['fail'] }, runId = 'wf-rerun0-aaaaaa' } = {}) {
  const f = fixture(t);
  const ctl = scripted(script);
  await start(f, runId, [work('build'), work('docs', { dependsOn: ['build'] }), work('side')], ctl);
  const state = readState(f, runId);
  assert.equal(state.lifecycle.status, 'partial');
  assert.deepEqual(['build', 'docs', 'side'].map((id) => statusOf(state, id)), ['failed', 'blocked', 'succeeded']);
  return { f, ctl, runId, token: state.shortId };
}

test('rerun refuses what it cannot rerun, with the §2.7 texts and exit codes, and writes nothing', async (t) => {
  const { f, runId, token } = await failedRun(t);
  const call = (options) => rerunV2Step({ bullswarmDir: f.bullswarmDir, token, pools: POOLS, waitMs: 0, ...options });
  const cases = [
    [{ token: 'nosuch', stepId: 'build' }, 1, 'no run found for "nosuch"'],
    [{ stepId: 'nope' }, 1, `run ${token} has no step "nope"`],
    [{ stepId: 'docs' }, 1, `step docs is blocked by build (failed); rerun or accept build first`],
    [{ stepId: 'build', avoid: ['pool-z'] }, 2, 'unknown pool "pool-z"; configured pools: pool-a, pool-b'],
    [{ stepId: 'build', avoid: ['pool-a', 'pool-b'] }, 2, 'no pool could run build after avoiding pool-a, pool-b (build/low work); rerun without --avoid, or change the step\'s effort or route'],
  ];
  for (const [options, code, why] of cases) {
    const result = await call(options);
    assert.deepEqual([result.code, result.status, result.why], [code, 'error', why], JSON.stringify(options));
  }
  // running, and pending without --avoid, on a copy of the state.
  const path = join(runDirOf(f, runId), 'state.json');
  const saved = readFileSync(path, 'utf8');
  const running = JSON.parse(saved);
  running.actions.find((action) => action.id === 'side').status = 'running';
  writeFileSync(path, JSON.stringify(running));
  const busy = await call({ stepId: 'side' });
  assert.deepEqual([busy.code, busy.why], [1, `step side is running; to stop it and run it again: bullswarm workflow step restart ${token} side [--pool <pool>]`]);
  const pending = JSON.parse(saved);
  Object.assign(pending.actions.find((action) => action.id === 'side'), { status: 'pending', finishedAt: null, outputFile: null, supersededAttempts: 1 });
  writeFileSync(path, JSON.stringify(pending));
  const notYet = await call({ stepId: 'side' });
  assert.deepEqual([notYet.code, notYet.why], [1, 'step side has not run yet; nothing to rerun (add --avoid to keep it off a pool when it runs)']);
  writeFileSync(path, saved);

  // A route whose use list the avoid empties.
  const routed = JSON.parse(saved);
  routed.program.actions.find((action) => action.id === 'build').route = { pools: { use: ['pool-a'] } };
  writeFileSync(path, JSON.stringify(routed));
  const onlyUse = await call({ stepId: 'build', avoid: ['pool-a'] });
  assert.deepEqual([onlyUse.code, onlyUse.why], [2, `step build may only use pool-a (route.pools.use); avoiding it leaves nothing. Change its route: bullswarm workflow plan export ${token} --out plan.json, edit it, then bullswarm workflow plan revise ${token} --program plan.json`]);
  writeFileSync(path, saved);

  // Not a program run.
  const verifiedDir = join(f.bullswarmDir, 'workflows', 'wf-verif0-bbbbbb');
  mkdirSync(verifiedDir, { recursive: true });
  const verified = createV2DurableState(createV2GoalDocument({ goal: 'Old run', cwd: f.workspace, requirements, settings: { executionMode: 'verified' } }), { runId: 'wf-verif0-bbbbbb', shortId: 'ver234' });
  writeFileSync(join(verifiedDir, 'state.json'), JSON.stringify(verified));
  const old = await call({ token: 'ver234', stepId: 'build' });
  assert.deepEqual([old.code, old.why], [1, 'run ver234 is not a program-mode run; step rerun needs a run started with --program']);

  assert.deepEqual(readStepRestarts(runDirOf(f, runId)), [], 'a refusal writes no intent');
  assert.equal(readState(f, runId).revisions?.length ?? 0, 0, 'a refusal writes no revision');
});

// F7: the §2.4 route checks run at every step rerun, not only with --avoid.
test('rerun without --avoid refuses a route today\'s pools cannot serve, and writes nothing', async (t) => {
  const { f, runId, token } = await failedRun(t);
  const path = join(runDirOf(f, runId), 'state.json');
  const saved = readFileSync(path, 'utf8');
  const routed = (route) => {
    const state = JSON.parse(saved);
    state.program.actions.find((action) => action.id === 'build').route = route;
    writeFileSync(path, JSON.stringify(state));
  };
  const call = (pools = POOLS) => rerunV2Step({ bullswarmDir: f.bullswarmDir, token, stepId: 'build', pools, waitMs: 0 });

  routed({ pools: { use: ['gone-pool'] } });
  const gone = await call();
  assert.deepEqual([gone.code, gone.status, gone.issues], [2, 'rejected', ['step build route.pools.use names "gone-pool", which is not a configured pool (configured: pool-a, pool-b)']]);

  routed({ pools: { use: ['pool-a'] } });
  const disabled = POOLS.map((pool) => (pool.name === 'pool-a' ? { ...pool, enabled: false } : pool));
  const none = await call(disabled);
  assert.equal(none.code, 2);
  assert.equal(none.status, 'rejected');
  assert.match(none.issues.join('\n'), /^step build: no enabled pool can run it under its route \(build\/low work; route: use pool-a\)$/);

  assert.deepEqual(readStepRestarts(runDirOf(f, runId)), [], 'a refusal writes no intent');
  assert.equal(readState(f, runId).revisions?.length ?? 0, 0, 'a refusal writes no revision');

  // A route the pools serve still reruns.
  routed({ pools: { use: ['pool-b'] } });
  const ok = await call();
  assert.deepEqual([ok.code, ok.status], [0, 'applied'], JSON.stringify(ok));
});

// The pin check at rerun reads the run's state: a step named in independentOf
// that already finished on another provider leaves the pin free for the check.
test('rerun under a --worker-pool pin checks independentOf against the work the run already did', async (t) => {
  const f = fixture(t);
  const ctl = scripted({ check: ['fail'] });
  const runId = 'wf-rerunp-aaaaaa';
  await start(f, runId, [work('build'), work('check', { dependsOn: ['build'], route: { independentOf: ['build'] } })], ctl);
  const state = readState(f, runId);
  assert.deepEqual(['build', 'check'].map((id) => statusOf(state, id)), ['succeeded', 'failed']);
  const goalPath = join(runDirOf(f, runId), 'goal.json');
  const pin = (pool) => {
    const doc = JSON.parse(readFileSync(goalPath, 'utf8'));
    doc.config = { ...(doc.config ?? {}), workerRouting: { ...(doc.config?.workerRouting ?? {}), strictPool: pool } };
    writeFileSync(goalPath, JSON.stringify(doc));
  };
  const call = () => rerunV2Step({ bullswarmDir: f.bullswarmDir, token: state.shortId, stepId: 'check', pools: POOLS, waitMs: 0 });
  // build did its work on pool-a, the pin's provider: nothing is left for check.
  pin('pool-a');
  const refused = await call();
  assert.deepEqual([refused.code, refused.status], [2, 'rejected']);
  assert.deepEqual(refused.issues, ['step check: its route is independent of build, which runs on the run\'s pinned pool pool-a (--worker-pool, provider pool-a), so no pool is left for it; drop independentOf or run without --worker-pool']);
  assert.equal(readState(f, runId).revisions?.length ?? 0, 0, 'a refusal writes no revision');
  // Pinned to pool-b, build finished elsewhere: the rerun goes through.
  pin('pool-b');
  const ok = await call();
  assert.deepEqual([ok.code, ok.status], [0, 'applied'], JSON.stringify(ok));
});

test('rerun --avoid amends the route, hands the failed attempt\'s handoff to the next attempt, and relaunches an offline run', async (t) => {
  const { f, ctl, runId, token } = await failedRun(t);
  const relaunched = [];
  const relaunch = async (id) => { relaunched.push(id); return resumer(f, ctl)(id); };
  const result = await rerunV2Step({
    bullswarmDir: f.bullswarmDir, token, stepId: 'build', avoid: ['pool-b'], pools: POOLS, waitMs: 0, relaunch,
  });
  assert.equal(result.code, 0, JSON.stringify(result));
  assert.equal(result.status, 'applied');
  assert.equal(result.appliedBy, 'offline');
  assert.deepEqual(result.avoid, ['pool-b']);
  assert.equal(result.handoffFrom, 'build-1');
  assert.deepEqual(result.handoff, { attemptId: 'build-1', failureKind: 'failed-evidence', pool: 'pool-a' });
  assert.deepEqual(result.changes.amended, ['build']);
  assert.deepEqual(relaunched, [runId], 'an offline apply relaunches the kernel');

  const state = readState(f, runId);
  const record = state.revisions.at(-1);
  assert.equal(record.source, 'step-rerun');
  assert.equal(record.summary, 'step rerun build avoiding pool-b (last attempt: failed-evidence on pool-a)');
  // The route is durable: plan export shows it.
  assert.deepEqual(exportV2Plan(state).program.actions.find((action) => action.id === 'build').route, { pools: { avoid: ['pool-b'] } });
  // The next attempt carried the failed attempt's handoff; the dependent ran.
  assert.equal(ctl.count('build'), 2);
  const second = ctl.calls.filter((call) => call.actionId === 'build')[1];
  assert.match(second.taskText, /## Prior attempt on this step/);
  assert.match(second.taskText, /- Failure: failed-evidence — command evidence failed: npm test → exit 1/);
  assert.deepEqual(['build', 'docs', 'side'].map((id) => statusOf(state, id)), ['succeeded', 'succeeded', 'succeeded']);
  assert.equal(state.lifecycle.status, 'completed');
  assert.deepEqual(readStepRestarts(runDirOf(f, runId)), [], 'the intent is gone once its attempt started');
  // The budget belongs to the rerun's definition: retries before it no longer count.
  assert.equal(countRetries(state, 'build'), 0);
});

test('the rerun gets its one automatic retry again: a retry spent before it no longer counts', async (t) => {
  const f = fixture(t);
  const runId = 'wf-rerunb-bbbbbb';
  const seen = [];
  let spent = false;
  const at = () => new Date().toISOString();
  const dispatch = async (options) => {
    const id = options.action.id;
    seen.push({ id, retriesAlready: options.retriesAlready, failureRule: options.failureRule });
    const attempt = (ordinal, pool, extra = {}) => {
      const files = options.paths(ordinal);
      writeFileSync(files.taskFile, options.taskText);
      return { ordinal, pool, model: 'model-a', status: 'running', startedAt: at(), taskFile: files.taskFile, outFile: files.outFile, ...extra };
    };
    if (id === 'build' && !spent) {
      spent = true;
      // A process failure on pool-a, then the step's one retry on pool-b fails too.
      const first = attempt(1, 'pool-a');
      options.onAttempt?.('started', first);
      Object.assign(first, { status: 'failed', finishedAt: at(), failureKind: 'process', why: 'exit 1' });
      options.onAttempt?.('finished', first, { ok: false, why: 'exit 1' });
      const second = attempt(2, 'pool-b', { retryOf: { attempt: 'build-1', how: 'other-pool' } });
      options.onAttempt?.('started', second);
      Object.assign(second, { status: 'failed', finishedAt: at(), failureKind: 'process', why: 'exit 1' });
      options.onAttempt?.('finished', second, { ok: false, why: 'exit 1' });
      return { ok: false, status: 'failed', failureKind: 'process', attempts: [first, second], verdict: { ok: false, why: 'exit 1' } };
    }
    const done = attempt(1, 'pool-a');
    options.onAttempt?.('started', done);
    writeFileSync(join(options.targetDir, `${id}.txt`), options.action.prompt);
    writeFileSync(done.outFile, `delivered ${id}`);
    Object.assign(done, { status: 'succeeded', finishedAt: at() });
    options.onAttempt?.('finished', done);
    return { ok: true, status: 'succeeded', attempts: [done], verdict: { ok: true, outFile: done.outFile } };
  };
  const ctl = { dispatch };
  await start(f, runId, [work('build'), work('docs', { dependsOn: ['build'] })], ctl);
  let state = readState(f, runId);
  assert.equal(statusOf(state, 'build'), 'failed');
  assert.deepEqual(state.attempts.filter((a) => a.actionId === 'build').map((a) => [a.id, a.retryOf ?? null]), [
    ['build-1', null], ['build-2', { attempt: 'build-1', how: 'other-pool' }],
  ]);
  assert.equal(countRetries(state, 'build'), 1, 'the retry is spent');
  assert.deepEqual(seen[0], { id: 'build', retriesAlready: 0, failureRule: true });

  const token = state.shortId;
  const result = await rerunV2Step({ bullswarmDir: f.bullswarmDir, token, stepId: 'build', pools: POOLS, waitMs: 0, relaunch: resumer(f, ctl) });
  assert.equal(result.status, 'applied', JSON.stringify(result));
  const rerun = seen.filter((call) => call.id === 'build');
  assert.equal(rerun.length, 2);
  assert.deepEqual(rerun[1], { id: 'build', retriesAlready: 0, failureRule: true }, 'the rerun\'s dispatch has its whole budget back');
  state = readState(f, runId);
  assert.deepEqual(['build', 'docs'].map((id) => statusOf(state, id)), ['succeeded', 'succeeded']);
  assert.equal(countRetries(state, 'build'), 0);
});

test('a rerun after a failure its pool caused tells the dispatcher to start elsewhere; a usage limit or a failure of the work does not', async (t) => {
  const cases = [
    { label: 'sign-in', fails: [['pool-a', 'auth', {}]], leaves: ['pool-a'] },
    { label: 'died at start', fails: [['pool-a', 'process', {}]], leaves: ['pool-a'] },
    // A usage limit is not the pool's failure: the caller chose where the
    // rerun goes (owner decision, 2026-09-25), so the dispatcher is told nothing.
    { label: 'quota', fails: [['pool-a', 'quota', {}]], leaves: [] },
    { label: 'throttle', fails: [['pool-a', 'throttle', {}]], leaves: [] },
    { label: 'work exit', fails: [['pool-a', 'process', { lastResponse: 'I tried and the tests fail', changedFileCount: 2 }]], leaves: [] },
    { label: 'evidence', fails: [['pool-a', 'failed-evidence', { changedFileCount: 1 }]], leaves: [] },
    // The pool that died first is still left when the retry failed on its work.
    { label: 'then work', fails: [['pool-a', 'provider', {}], ['pool-b', 'failed-evidence', { changedFileCount: 1 }]], leaves: ['pool-a'] },
  ];
  for (const [index, { label, fails, leaves }] of cases.entries()) {
    const f = fixture(t);
    const runId = `wf-rerunp-${'abcdef0'[index].repeat(6)}`;
    const seen = [];
    let failed = false;
    const at = () => new Date().toISOString();
    const dispatch = async (options) => {
      const id = options.action.id;
      if (id === 'build') seen.push(options.leavePools ?? null);
      if (id === 'build' && !failed) {
        failed = true;
        const records = fails.map(([pool, failureKind, extra], i) => {
          const files = options.paths(i + 1);
          writeFileSync(files.taskFile, options.taskText);
          const record = { ordinal: i + 1, pool, model: 'model-a', status: 'running', startedAt: at(), taskFile: files.taskFile, outFile: files.outFile };
          options.onAttempt?.('started', record);
          Object.assign(record, { status: 'failed', finishedAt: at(), failureKind, why: 'it failed', ...extra });
          options.onAttempt?.('finished', record, { ok: false, why: 'it failed' });
          return record;
        });
        return { ok: false, status: 'failed', failureKind: records.at(-1).failureKind, attempts: records, verdict: { ok: false, why: 'it failed' } };
      }
      const files = options.paths(1);
      writeFileSync(files.taskFile, options.taskText);
      const record = { ordinal: 1, pool: 'pool-b', model: 'model-a', status: 'running', startedAt: at(), taskFile: files.taskFile, outFile: files.outFile };
      options.onAttempt?.('started', record);
      writeFileSync(join(options.targetDir, `${id}.txt`), options.action.prompt);
      writeFileSync(files.outFile, `delivered ${id}`);
      Object.assign(record, { status: 'succeeded', finishedAt: at() });
      options.onAttempt?.('finished', record);
      return { ok: true, status: 'succeeded', attempts: [record], verdict: { ok: true, outFile: files.outFile } };
    };
    const ctl = { dispatch };
    await start(f, runId, [work('build')], ctl);
    const token = readState(f, runId).shortId;
    const result = await rerunV2Step({ bullswarmDir: f.bullswarmDir, token, stepId: 'build', pools: POOLS, waitMs: 0, relaunch: resumer(f, ctl) });
    assert.equal(result.status, 'applied', JSON.stringify(result));
    assert.deepEqual(result.leaves, leaves, label);
    const kindOf = Object.fromEntries(fails.map(([pool, failureKind]) => [pool, failureKind]));
    assert.deepEqual(seen, [[], leaves.map((pool) => ({ pool, failureKind: kindOf[pool] }))], label);
    assert.equal(statusOf(readState(f, runId), 'build'), 'succeeded');
  }
});

test('rerun without --avoid is a plain rerun; a succeeded step gets no handoff; a pending step only amends its route', async (t) => {
  const { f, ctl, runId, token } = await failedRun(t);
  const relaunch = resumer(f, ctl);
  const side = await rerunV2Step({ bullswarmDir: f.bullswarmDir, token, stepId: 'side', pools: POOLS, waitMs: 0, relaunch });
  assert.equal(side.status, 'applied', JSON.stringify(side));
  assert.equal(side.handoffFrom, null);
  assert.deepEqual(side.changes.rerun, ['side']);
  assert.equal(readState(f, runId).revisions.at(-1).summary, 'step rerun side (last attempt: succeeded on pool-a)');
  const sideCalls = ctl.calls.filter((call) => call.actionId === 'side');
  assert.equal(sideCalls.length, 2);
  assert.doesNotMatch(sideCalls[1].taskText, /## Prior attempt on this step/);

  // A pending step: only the route changes; nothing reruns and no intent is written.
  const path = join(runDirOf(f, runId), 'state.json');
  const paused = readState(f, runId);
  paused.lifecycle = { ...paused.lifecycle, status: 'paused', finishedAt: null, resultFile: null };
  paused.pause = { requestedAt: new Date().toISOString(), mode: 'drain', source: 'cli', pausedAt: new Date().toISOString() };
  Object.assign(paused.actions.find((action) => action.id === 'build'), { status: 'pending', finishedAt: null, outputFile: null, lastFailure: null, supersededAttempts: 1 });
  Object.assign(paused.actions.find((action) => action.id === 'docs'), { status: 'pending' });
  writeFileSync(path, JSON.stringify(paused));
  const later = await rerunV2Step({ bullswarmDir: f.bullswarmDir, token, stepId: 'build', avoid: ['pool-a'], pools: POOLS, waitMs: 0, relaunch: () => { throw new Error('a paused run is not relaunched'); } });
  assert.equal(later.status, 'applied', JSON.stringify(later));
  assert.equal(later.pending, true);
  assert.equal(later.paused, true);
  assert.equal(later.handoffFrom, null);
  assert.deepEqual(later.changes.amended, ['build']);
  assert.deepEqual(readStepRestarts(runDirOf(f, runId)), []);
  assert.deepEqual(readState(f, runId).program.actions.find((action) => action.id === 'build').route, { pools: { avoid: ['pool-a'] } });
});

test('a pool label resolves to its id, with a note', async (t) => {
  const { f, token, runId } = await failedRun(t);
  const result = await rerunV2Step({
    bullswarmDir: f.bullswarmDir, token, stepId: 'build', avoid: ['beta'], pools: POOLS, labels: { 'pool-b': 'beta' },
    waitMs: 0, relaunch: async () => null,
  });
  assert.equal(result.status, 'applied', JSON.stringify(result));
  assert.deepEqual(result.avoid, ['pool-b']);
  assert.deepEqual(result.notes, ['(label "beta" is pool pool-b)']);
  assert.deepEqual(readState(f, runId).program.actions.find((action) => action.id === 'build').route, { pools: { avoid: ['pool-b'] } });
});

test('a live kernel applies the rerun; its next attempt carries the handoff', async (t) => {
  const f = fixture(t);
  const ctl = scripted({ build: ['fail'] });
  const release = ctl.hold('side');
  const runId = 'wf-rerunl-cccccc';
  const running = start(f, runId, [work('build'), work('docs', { dependsOn: ['build'] }), work('side')], ctl);
  await until(() => statusOf(readState(f, runId), 'build') === 'failed' && statusOf(readState(f, runId), 'side') === 'running', { what: 'build failed while side runs' });
  const token = readState(f, runId).shortId;
  const result = await rerunV2Step({ bullswarmDir: f.bullswarmDir, token, stepId: 'build', avoid: ['pool-b'], pools: POOLS, waitMs: 5000, pollMs: 10, relaunch: () => { throw new Error('a live kernel is not relaunched'); } });
  assert.equal(result.status, 'applied', JSON.stringify(result));
  assert.equal(result.appliedBy, 'kernel');
  await until(() => ctl.count('build') === 2, { what: 'the rerun attempt' });
  release();
  await running;
  const state = readState(f, runId);
  assert.match(ctl.calls.filter((call) => call.actionId === 'build')[1].taskText, /## Prior attempt on this step/);
  assert.equal(state.lifecycle.status, 'completed');
});

test('a rejected rerun deletes its intent, and an intent whose revision was never applied is ignored', async (t) => {
  const { f, runId, token } = await failedRun(t);
  const runDir = runDirOf(f, runId);
  // Reopened but holding a cancellation: the offline apply rejects the revision.
  const state = readState(f, runId);
  state.lifecycle = { ...state.lifecycle, status: 'running', finishedAt: null, resultFile: null };
  writeFileSync(join(runDir, 'state.json'), JSON.stringify(state));
  writeFileSync(join(runDir, 'cancellation.json'), JSON.stringify({ requested: true, requestedAt: new Date().toISOString() }));
  const rejected = await rerunV2Step({ bullswarmDir: f.bullswarmDir, token, stepId: 'build', pools: POOLS, waitMs: 0 });
  assert.deepEqual([rejected.code, rejected.status], [2, 'rejected']);
  assert.match(rejected.issues[0], /pending cancellation/);
  assert.equal(rejected.oldKernel, false, 'an offline rejection is not an old kernel');
  assert.deepEqual(readStepRestarts(runDir), [], 'the rejected rerun left no intent');

  // appliedStepRestart only honours a step-rerun intent whose revision applied.
  requestStepRestart(runDir, { actionId: 'build', attemptId: 'build-1', source: 'step-rerun', revisionRequestId: 'rev-never-000000', appliedAt: new Date().toISOString() });
  assert.equal(appliedStepRestart(readState(f, runId), runDir, 'build'), null);
  const applied = readState(f, runId);
  applied.revisions = [...(applied.revisions ?? []), { id: 'rev-never-000000', status: 'applied' }];
  assert.equal(appliedStepRestart(applied, runDir, 'build').handoff.from, 'build-1');
});

test('a queued rerun that an older kernel rejects prints the pause, run again, resume hint', async (t) => {
  const { f, runId, token } = await failedRun(t);
  const runDir = runDirOf(f, runId);
  // Stand in for a live kernel that predates stage 3: hold the lease and
  // answer the queued request with the rejection an old validator gives.
  const lease = acquireKernelLease(runDir);
  t.after(() => lease.release());
  const answering = (async () => {
    await until(() => existsSync(join(runDir, 'revisions')) && readStepRestarts(runDir).length === 1, { what: 'queued request' });
    const [intent] = readStepRestarts(runDir);
    const state = readState(f, runId);
    state.revisions = [...(state.revisions ?? []), {
      id: intent.revisionRequestId, status: 'rejected', source: 'step-rerun', queuedAt: new Date().toISOString(),
      processedAt: new Date().toISOString(), summary: null, baseRevision: null, programRevision: null, changes: null,
      steeringIds: [], issues: ['actions[0].route is not allowed'],
    }];
    writeFileSync(join(runDir, 'state.json'), JSON.stringify(state));
  })();
  const result = await rerunV2Step({ bullswarmDir: f.bullswarmDir, token, stepId: 'build', avoid: ['pool-b'], pools: POOLS, waitMs: 5000, pollMs: 10 });
  await answering;
  assert.deepEqual([result.code, result.status, result.oldKernel], [2, 'rejected', true]);
  assert.deepEqual(readStepRestarts(runDir), [], 'the CLI deletes the intent of a rejection it saw');
  const queued = await rerunV2Step({ bullswarmDir: f.bullswarmDir, token, stepId: 'build', pools: POOLS, waitMs: 0 });
  assert.deepEqual([queued.code, queued.status], [0, 'queued']);
  assert.equal(readStepRestarts(runDir).length, 1, 'a queued rerun keeps its intent for the kernel');
});

test('the CLI prints the applied rerun, and --json carries the §2.7 shape', async (t) => {
  const { f, runId, token } = await failedRun(t);
  // A paused run is revised directly and not relaunched, so the binary can run it.
  const path = join(runDirOf(f, runId), 'state.json');
  const state = readState(f, runId);
  state.lifecycle = { ...state.lifecycle, status: 'paused', finishedAt: null, resultFile: null };
  state.pause = { requestedAt: new Date().toISOString(), mode: 'drain', source: 'cli', pausedAt: new Date().toISOString() };
  writeFileSync(path, JSON.stringify(state));
  const env = { ...process.env, BULLSWARM_HOME: f.bullswarmDir, BULLSWARM_DISABLE_CLAUDE_PROFILES: '1' };
  const text = spawnSync(process.execPath, [BIN, 'workflow', 'step', 'rerun', token, 'side'], { env, encoding: 'utf8' });
  assert.equal(text.status, 0, text.stderr);
  assert.deepEqual(text.stdout.trim().split('\n'), [
    `✓ side of ${token} runs again · revision 2 (applied directly; the run stays paused)`,
    `  resume   bullswarm workflow resume ${token}`,
  ]);
  const blocked = spawnSync(process.execPath, [BIN, 'workflow', 'step', 'rerun', token, 'docs', '--json'], { env, encoding: 'utf8' });
  assert.equal(blocked.status, 1);
  assert.equal(JSON.parse(blocked.stdout).why, 'step docs is blocked by build (failed); rerun or accept build first');
  const json = spawnSync(process.execPath, [BIN, 'workflow', 'step', 'rerun', token, 'build', '--json'], { env, encoding: 'utf8' });
  assert.equal(json.status, 0, json.stderr);
  const payload = JSON.parse(json.stdout);
  for (const key of ['action', 'status', 'runId', 'shortId', 'step', 'avoid', 'handoffFrom', 'programRevision', 'changes', 'appliedBy', 'relaunch', 'next']) {
    assert.ok(key in payload, key);
  }
  assert.deepEqual([payload.action, payload.status, payload.step, payload.handoffFrom, payload.appliedBy, payload.relaunch], ['step-rerun', 'applied', 'build', 'build-1', 'offline', null]);
  assert.deepEqual(payload.avoid, []);
  assert.equal(payload.next.watch, `bullswarm workflow watch ${token} --until trouble`);
});
