// A caller restart through the real kernel: `workflow step restart` stops the
// one running step, the step goes straight back in the queue (never through a
// terminal state), and its next attempt carries the stopped attempt's handoff
// block on the pool the caller named. The kernel is real; the dispatcher is a
// controllable stand-in whose held step honors shouldCancel the way the real
// process runner does, and records what the kernel asked of it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { readEvents } from '../src/workflow/events.js';
import { createV2GoalDocument } from '../src/workflow/v2-state.js';
import { runV2AutonomousWorkflow } from '../src/workflow/v2-runtime.js';
import { readStepRestarts, requestStepRestart, stepRestartPath } from '../src/workflow/v2-dispatch.js';
import { restartV2Step } from '../src/workflow/cli.js';

const BIN = resolve(new URL('..', import.meta.url).pathname, 'bin', 'bullswarm.js');
const work = (id, options = {}) => ({
  id, purpose: `Deliver ${id}`, dependsOn: [], affects: ['deliver'], ownedFiles: [`${id}.txt`],
  prompt: `Write ${id}.txt.`, lane: 'build', effort: 'low', evidenceFor: [], inputs: [], produces: [], ...options,
});
const initial = (actions) => ({
  schemaVersion: 'bullswarm.workflow.planner-response.v2', kind: 'program', summary: 'Initial plan.',
  program: { schemaVersion: 'bullswarm.workflow.program.v2', actions },
});

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'bullswarm-restart-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const workspace = join(root, 'repo');
  const bullswarmDir = join(root, 'home');
  mkdirSync(workspace); mkdirSync(bullswarmDir);
  const goalDocument = createV2GoalDocument({
    goal: 'Deliver the requested files', cwd: workspace,
    requirements: [{ id: 'deliver', text: 'Deliver the requested files.' }],
    settings: { executionMode: 'program', workspaceMode: 'shared', scout: false, plannerMode: 'caller', concurrency: 3 },
  });
  return { workspace, bullswarmDir, goalDocument };
}

// Each call is one dispatch; `hold(id)` keeps that step's next call running
// until shouldCancel says stop. A stopped call records a partial answer, a
// stream line and a diff, like a real attempt that was cut off.
function controller() {
  const holds = new Set();
  const calls = [];
  const dispatch = async (options) => {
    const files = options.paths(1);
    const call = {
      actionId: options.action.id, taskText: options.taskText, preferredPool: options.preferredPool,
      strictPool: options.strictPool, resumeHandoff: options.resumeHandoff ?? null, cancelled: false,
    };
    calls.push(call);
    const pool = options.strictPool ?? 'fixture';
    const record = {
      ordinal: 1, pool, model: `${pool}-model`, status: 'running', startedAt: new Date().toISOString(),
      taskFile: files.taskFile, outFile: files.outFile,
      ...(options.resumeHandoff ? { handoff: { from: options.resumeHandoff.from, bytes: options.resumeHandoff.bytes } } : {}),
    };
    writeFileSync(files.taskFile, options.taskText);
    options.onAttempt?.('started', record);
    if (holds.delete(options.action.id)) {
      const streamFile = files.taskFile.replace(/task-([^/]+)\.md$/, 'stream-$1.jsonl');
      writeFileSync(streamFile, `${JSON.stringify({ seq: 1, at: new Date().toISOString(), source: 'stdout', providerType: 'event', kind: 'response', status: 'completed', summary: `halfway through ${options.action.id}` })}\n`);
      writeFileSync(join(options.targetDir, `${options.action.id}.txt`), 'partial');
      writeFileSync(files.outFile, 'partial answer');
      await new Promise((done) => { const poll = setInterval(() => { if (options.shouldCancel?.()) { clearInterval(poll); done(); } }, 5); });
      call.cancelled = true;
      Object.assign(record, {
        status: 'cancelled', finishedAt: new Date().toISOString(), failureKind: 'cancelled', streamFile,
        outputFile: files.outFile, changedFileCount: 1, lastResponse: `halfway through ${options.action.id}`,
      });
      options.onAttempt?.('finished', record);
      return { ok: false, status: 'cancelled', failureKind: 'cancelled', attempts: [record], verdict: { ok: false, why: 'cancelled' } };
    }
    writeFileSync(join(options.targetDir, `${options.action.id}.txt`), options.action.prompt);
    writeFileSync(files.outFile, `delivered ${options.action.id}`);
    Object.assign(record, { status: 'succeeded', finishedAt: new Date().toISOString() });
    options.onAttempt?.('finished', record);
    return { ok: true, status: 'succeeded', attempts: [record], verdict: { ok: true, outFile: files.outFile } };
  };
  return { dispatch, calls, hold: (id) => holds.add(id), count: (id) => calls.filter((call) => call.actionId === id).length };
}

async function until(predicate, what, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try { if (predicate()) return; } catch { /* state mid-write */ }
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((done) => setTimeout(done, 5));
  }
}

const start = (f, runId, actions, ctl) => runV2AutonomousWorkflow({
  bullswarmDir: f.bullswarmDir, goalDocument: f.goalDocument, pools: [], runId,
  initialPlannerResponse: initial(actions),
  dependencies: { dispatchV2Action: ctl.dispatch, controlPollMs: 10 },
});

test('a restart stops the running step and runs it again with its handoff on the named pool', async (t) => {
  const f = fixture(t);
  const ctl = controller();
  ctl.hold('a');
  const runId = 'wf-rstrt1-abcdef';
  const runDir = join(f.bullswarmDir, 'workflows', runId);
  const kernel = start(f, runId, [work('a'), work('b'), work('c', { dependsOn: ['a'] })], ctl);
  await until(() => ctl.count('a') === 1 && ctl.count('b') === 1, 'a and b dispatched');

  const restarted = await restartV2Step({ bullswarmDir: f.bullswarmDir, token: runId, stepId: 'a', pool: 'codex', waitMs: 5000 });
  assert.deepEqual(
    { code: restarted.code, status: restarted.status, stoppedAttemptId: restarted.stoppedAttemptId, stoppedPool: restarted.stoppedPool, pool: restarted.pool },
    { code: 0, status: 'restarted', stoppedAttemptId: 'a-1', stoppedPool: 'fixture', pool: 'codex' },
  );
  const done = await kernel;
  assert.equal(done.result.status, 'completed');
  assert.deepEqual(ctl.calls.map((call) => call.actionId).sort(), ['a', 'a', 'b', 'c']);
  const [first, second] = ctl.calls.filter((call) => call.actionId === 'a');
  assert.equal(first.cancelled, true);
  // The next attempt is pinned to the named pool and carries the handoff.
  assert.equal(second.strictPool, 'codex');
  assert.equal(second.preferredPool, 'codex');
  assert.equal(second.resumeHandoff.from, 'a-1');
  assert.ok(second.taskText.endsWith(second.resumeHandoff.block));
  assert.match(second.resumeHandoff.block, /^## Prior attempt on this step\n\n- Pool: fixture\n/);
  assert.match(second.resumeHandoff.block, /\n- Failure: restarted — stopped by the caller with workflow step restart \(restart-[0-9a-f]{8}\)\n/);
  assert.match(second.resumeHandoff.block, /: halfway through a\n/);
  // Only a and nothing else was touched: b ran once, and c waited for the rerun a.
  const attempts = done.state.attempts.filter((attempt) => attempt.actionId === 'a');
  assert.deepEqual(attempts.map((attempt) => [attempt.id, attempt.status, attempt.failureKind, attempt.pool]), [
    ['a-1', 'cancelled', 'restarted', 'fixture'],
    ['a-2', 'succeeded', null, 'codex'],
  ]);
  const events = readEvents(runDir);
  const forA = events.filter((event) => event.payload?.actionId === 'a').map((event) => event.type);
  assert.deepEqual(forA, ['action.started', 'attempt.started', 'attempt.finished', 'step.restarted', 'action.started', 'attempt.started', 'attempt.finished', 'action.finished']);
  assert.equal(events.find((event) => event.type === 'step.restarted').payload.requestId, restarted.requestId);
  assert.deepEqual(events.filter((event) => event.type === 'attempt.started' && event.payload.actionId === 'a')[1].payload.handoff.from, 'a-1');
  assert.equal(events.some((event) => event.type === 'action.finished' && event.payload.actionId === 'a' && event.payload.status !== 'succeeded'), false,
    'a restarted step never passes through a terminal state');
  // The intent is delivered once the next attempt starts.
  assert.equal(existsSync(stepRestartPath(runDir, 'a')), false);
});

test('a restart the kernel cannot honor is refused with why, and the run goes on', async (t) => {
  const f = fixture(t);
  const ctl = controller();
  ctl.hold('a');
  const runId = 'wf-rstrt2-abcdef';
  const runDir = join(f.bullswarmDir, 'workflows', runId);
  const kernel = start(f, runId, [work('a'), work('b')], ctl);
  await until(() => ctl.count('b') === 1 && readEvents(runDir).some((event) => event.type === 'action.finished' && event.payload.actionId === 'b'), 'b finished');
  // b already finished when its restart reaches the kernel.
  const request = requestStepRestart(runDir, { actionId: 'b', attemptId: 'b-1' });
  await until(() => readEvents(runDir).some((event) => event.type === 'step.restart_refused'), 'refusal');
  const refusal = readEvents(runDir).find((event) => event.type === 'step.restart_refused').payload;
  assert.deepEqual(refusal, { requestId: request.id, actionId: 'b', why: 'it finished before the restart took effect' });
  assert.deepEqual(readStepRestarts(runDir), []);
  // Stop the held step with a restart so the run can finish.
  const restarted = await restartV2Step({ bullswarmDir: f.bullswarmDir, token: runId, stepId: 'a', waitMs: 5000 });
  assert.equal(restarted.status, 'restarted');
  const done = await kernel;
  assert.equal(done.result.status, 'completed');
  assert.equal(ctl.calls.filter((call) => call.actionId === 'a').at(-1).strictPool, null, 'no pool named: normal routing');
});

test('the command line validates --until and step restart before touching a run', () => {
  const home = mkdtempSync(join(tmpdir(), 'bullswarm-restart-cli-'));
  try {
    const run = (args) => spawnSync(process.execPath, [BIN, ...args], {
      env: { ...process.env, BULLSWARM_HOME: home, BULLSWARM_DISABLE_CLAUDE_PROFILES: '1' }, encoding: 'utf8',
    });
    const cases = [
      [['workflow', 'watch', 'ab12cd', '--until', 'soon'], 2, /--until must be outcome or trouble \(got "soon"\)/],
      [['workflow', 'watch', 'ab12cd', '--until', 'trouble', '--next'], 2, /--until cannot combine with --next/],
      [['workflow', 'watch', 'ab12cd', '--until'], 2, /--until requires a value/],
      [['workflow', 'watch', 'ab12cd', '--until', 'trouble'], 1, /no run found for "ab12cd"/],
      [['workflow', 'step', 'restart'], 2, /usage: bullswarm workflow step restart <runId> <step>/],
      [['workflow', 'step', 'restart', 'ab12cd', 'a', '--bogus'], 2, /unknown flag --bogus/],
      [['workflow', 'step', 'restart', 'ab12cd', 'a'], 1, /no run found for "ab12cd"/],
    ];
    for (const [args, status, pattern] of cases) {
      const result = run(args);
      assert.equal(result.status, status, `${args.join(' ')}: ${result.stderr}`);
      assert.match(result.stderr, pattern, args.join(' '));
    }
    const help = run(['workflow', 'step', 'restart', '--help']);
    assert.equal(help.status, 0);
    assert.match(help.stdout, /--pool <pool>/);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

