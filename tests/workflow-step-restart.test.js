// `bullswarm workflow step restart`: the caller-side request (restartV2Step)
// and the dispatch-side pieces the kernel uses to requeue the step with its
// handoff. The run is a real finished run from the scrubbed fixture home
// (tests/fixtures/home-351), staged as it was while its `verify` step was
// still running on claude-code; the handoff is built from that attempt's real
// persisted stream.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { restartV2Step } from '../src/workflow/cli.js';
import { appendEvent } from '../src/workflow/events.js';
import {
  appliedStepRestart, clearStepRestart, markStepRestartApplied, readStepRestarts, requestStepRestart,
  requeueRestartedStep, stepRestartPath,
} from '../src/workflow/v2-dispatch.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const RUN = 'wf-mu8thu2e-27c504';
const SHORT = 'euqrni';
const SOURCE = join(ROOT, 'tests', 'fixtures', 'home-351', 'workflows', RUN);

function deadPid() {
  const child = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
  return Number(child.stdout);
}

function stagedRun(t, { running = true, kernelPid = process.pid } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'bs-step-restart-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const runDir = join(home, 'workflows', RUN);
  mkdirSync(dirname(runDir), { recursive: true });
  cpSync(SOURCE, runDir, { recursive: true });
  const state = JSON.parse(readFileSync(join(runDir, 'state.json'), 'utf8'));
  if (running) {
    state.lifecycle = { ...state.lifecycle, status: 'running', finishedAt: null, resultFile: null };
    Object.assign(state.actions.find((action) => action.id === 'verify'), { status: 'running', finishedAt: null });
    Object.assign(state.attempts.find((attempt) => attempt.id === 'verify-1'), {
      status: 'running', finishedAt: null, taskFile: join(runDir, 'task-verify-attempt-1.md'),
    });
    state.runner = { ...(state.runner ?? {}), pid: kernelPid, lastHeartbeatAt: new Date().toISOString() };
  }
  writeFileSync(join(runDir, 'state.json'), `${JSON.stringify(state)}\n`);
  return { home, runDir, state };
}

test('restart refuses what it cannot restart and says what to do instead', async (t) => {
  const finished = stagedRun(t, { running: false });
  const done = await restartV2Step({ bullswarmDir: finished.home, token: SHORT, stepId: 'verify', waitMs: 0 });
  assert.equal(done.code, 1);
  assert.equal(done.why, `run ${SHORT} already finished (completed); nothing is running. Retry its unfinished steps with: bullswarm workflow resume ${SHORT}`);

  const run = stagedRun(t);
  const cases = [
    [{ token: 'nosuch' }, 1, 'no run found for "nosuch"'],
    [{ stepId: 'nope' }, 1, `run ${SHORT} has no step "nope"`],
    [{ stepId: 'integrate' }, 1, `step integrate is not running (succeeded); restart stops a running attempt. To run it again: bullswarm workflow plan export ${SHORT} --out plan.json, then bullswarm workflow plan revise ${SHORT} --program plan.json --rerun integrate`],
    [{ pool: 'nope', poolNames: ['claude-code', 'codex'] }, 2, 'unknown pool "nope"; configured pools: claude-code, codex'],
  ];
  for (const [options, code, why] of cases) {
    const result = await restartV2Step({ bullswarmDir: run.home, token: SHORT, stepId: 'verify', waitMs: 0, ...options });
    assert.deepEqual([result.code, result.status, result.why], [code, 'error', why]);
  }
  const orphaned = stagedRun(t, { kernelPid: deadPid() });
  const dead = await restartV2Step({ bullswarmDir: orphaned.home, token: SHORT, stepId: 'verify', waitMs: 0 });
  assert.equal(dead.code, 1);
  assert.equal(dead.why, `the kernel of ${SHORT} is not running, so nothing can stop verify-1; bullswarm workflow resume ${SHORT} restarts its interrupted steps with their handoff`);
  for (const staged of [finished, run, orphaned]) assert.deepEqual(readStepRestarts(staged.runDir), [], 'a refusal writes nothing');
});

test('restart writes one intent for the running attempt and reports what its kernel answered', async (t) => {
  const run = stagedRun(t);
  const requested = await restartV2Step({ bullswarmDir: run.home, token: SHORT, stepId: 'verify', pool: 'codex', poolNames: ['claude-code', 'codex'], waitMs: 0 });
  assert.deepEqual(
    { code: requested.code, status: requested.status, stoppedAttemptId: requested.stoppedAttemptId, stoppedPool: requested.stoppedPool, pool: requested.pool },
    { code: 0, status: 'requested', stoppedAttemptId: 'verify-1', stoppedPool: 'claude-code', pool: 'codex' },
  );
  const [intent] = readStepRestarts(run.runDir);
  assert.deepEqual({ ...intent, id: undefined, requestedAt: undefined }, {
    schemaVersion: 1, id: undefined, actionId: 'verify', attemptId: 'verify-1', pool: 'codex', source: 'cli', requestedAt: undefined, appliedAt: null,
  });
  assert.equal(intent.id, requested.requestId);

  // The kernel answers with a durable event carrying the request id.
  for (const [type, payload, expected] of [
    ['step.restarted', { actionId: 'verify', attemptId: 'verify-1', stoppedPool: 'claude-code', pool: null }, { code: 0, status: 'restarted' }],
    ['step.restart_refused', { actionId: 'verify', why: 'it finished before the restart took effect' }, { code: 1, status: 'refused', why: 'it finished before the restart took effect' }],
  ]) {
    const waiting = restartV2Step({ bullswarmDir: run.home, token: SHORT, stepId: 'verify', waitMs: 5000, pollMs: 20 });
    let request = null;
    for (let i = 0; i < 100 && !request; i += 1) {
      await new Promise((done) => setTimeout(done, 20));
      request = readStepRestarts(run.runDir).find((entry) => entry.id !== intent.id && !entry.appliedAt && entry.pool === null) ?? null;
    }
    assert.ok(request, 'the second request replaced the first intent');
    appendEvent(run.runDir, run.state, type, { requestId: request.id, ...payload });
    const answered = await waiting;
    assert.deepEqual({ code: answered.code, status: answered.status, ...(answered.why ? { why: answered.why } : {}) }, expected);
    clearStepRestart(run.runDir, 'verify');
  }
});

test('the kernel side requeues the stopped step and hands its next attempt the real handoff', (t) => {
  const run = stagedRun(t);
  const { state, runDir } = run;
  const verify = state.actions.find((action) => action.id === 'verify');
  const stopped = state.attempts.find((attempt) => attempt.id === 'verify-1');
  // What the kernel records when a restart stops the attempt.
  Object.assign(stopped, {
    status: 'cancelled', finishedAt: '2026-09-19T21:55:00.000Z', failureKind: 'restarted',
    why: 'stopped by the caller with workflow step restart (restart-1a2b3c4d)',
    streamFile: join(runDir, 'stream-verify-attempt-1.jsonl'), diffFile: join(runDir, 'diff-verify-attempt-1.txt'),
  });
  const request = requestStepRestart(runDir, { actionId: 'verify', attemptId: 'verify-1', pool: 'codex', id: 'restart-1a2b3c4d' });

  assert.deepEqual(requeueRestartedStep(state, request), { requeued: false, why: 'its attempt is still running' });
  verify.status = 'cancelled';
  assert.deepEqual(requeueRestartedStep(state, request), { requeued: true, why: null, attemptId: 'verify-1', stoppedPool: 'claude-code' });
  assert.deepEqual({ status: verify.status, finishedAt: verify.finishedAt, lastFailure: verify.lastFailure }, { status: 'pending', finishedAt: null, lastFailure: null });
  assert.equal(appliedStepRestart(state, runDir, 'verify'), null, 'not delivered until the kernel marks it applied');

  markStepRestartApplied(runDir, request, { at: '2026-09-19T21:55:01.000Z', attemptId: 'verify-1' });
  const applied = appliedStepRestart(state, runDir, 'verify');
  assert.equal(applied.pool, 'codex');
  assert.equal(applied.handoff.from, 'verify-1');
  const block = applied.handoff.block;
  assert.equal(applied.handoff.bytes, Buffer.byteLength(block, 'utf8'));
  assert.match(block, /^## Prior attempt on this step\n/);
  assert.match(block, /\n- Pool: claude-code\n- Model: claude-opus-5\n/);
  assert.match(block, /\n- Failure: restarted — stopped by the caller with workflow step restart \(restart-1a2b3c4d\)\n/);
  // The last things the worker said, read back from its real persisted stream.
  const responses = readFileSync(join(runDir, 'stream-verify-attempt-1.jsonl'), 'utf8').split('\n').filter(Boolean)
    .map((line) => JSON.parse(line)).filter((record) => record.kind === 'response').slice(-3);
  for (const record of responses) assert.ok(block.includes(`  - ${record.at}: ${record.summary.replace(/\s+/g, ' ').trim()}`), record.at);

  for (const [status, why] of [['succeeded', 'it finished before the restart took effect'], ['removed', 'a plan revision removed it']]) {
    verify.status = status;
    assert.deepEqual(requeueRestartedStep(state, request), { requeued: false, why });
  }
  assert.deepEqual(requeueRestartedStep(state, { ...request, actionId: 'nope' }), { requeued: false, why: 'the plan has no step nope' });

  clearStepRestart(runDir, 'verify');
  assert.equal(existsSync(stepRestartPath(runDir, 'verify')), false);
  assert.throws(() => stepRestartPath(runDir, '../state'), /kebab-case/);
  writeFileSync(join(runDir, 'restart-other.json'), '{"actionId":"not-other"}');
  assert.deepEqual(readStepRestarts(runDir), [], 'an intent whose file name and step disagree is ignored');
});

// Stage 3 (D18): --pool never overrides the step's route.
test('restart refuses a --pool the step\'s route does not allow, and writes nothing', async (t) => {
  const run = stagedRun(t);
  const state = JSON.parse(readFileSync(join(run.runDir, 'state.json'), 'utf8'));
  state.program.actions.find((action) => action.id === 'verify').route = { pools: { avoid: ['codex'] }, providers: { use: ['claude-code', 'codex'] } };
  writeFileSync(join(run.runDir, 'state.json'), `${JSON.stringify(state)}\n`);
  const pools = [{ name: 'claude-code' }, { name: 'claude-code:acme' }, { name: 'codex' }, { name: 'grok' }];
  const poolNames = pools.map((pool) => pool.name);
  for (const pool of ['codex', 'grok']) {
    const refused = await restartV2Step({ bullswarmDir: run.home, token: SHORT, stepId: 'verify', pool, poolNames, pools, waitMs: 0 });
    assert.deepEqual([refused.code, refused.status], [2, 'error'], pool);
    assert.equal(refused.why, `step verify's route does not allow pool ${pool} (avoid codex · providers claude-code, codex); change the route or use bullswarm workflow step rerun ${SHORT} verify --avoid <pool>`);
  }
  assert.deepEqual(readStepRestarts(run.runDir), [], 'a refused restart writes no intent');
  const allowed = await restartV2Step({ bullswarmDir: run.home, token: SHORT, stepId: 'verify', pool: 'claude-code:acme', poolNames, pools, waitMs: 0 });
  assert.deepEqual([allowed.code, allowed.status, allowed.pool], [0, 'requested', 'claude-code:acme']);
  // Without --pool the route is the kernel's business: the restart goes through.
  clearStepRestart(run.runDir, 'verify');
  const plain = await restartV2Step({ bullswarmDir: run.home, token: SHORT, stepId: 'verify', waitMs: 0 });
  assert.deepEqual([plain.code, plain.status], [0, 'requested']);
});
