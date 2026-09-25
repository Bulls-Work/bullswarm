// A caller restart through the real kernel: `workflow step restart` stops the
// one running step, the step goes straight back in the queue (never through a
// terminal state), and its next attempt carries the stopped attempt's handoff
// block on the pool the caller named. The kernel is real; the dispatcher is a
// controllable stand-in whose held step honors shouldCancel the way the real
// process runner does, and records what the kernel asked of it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { readEvents } from '../src/workflow/events.js';
import { createV2GoalDocument } from '../src/workflow/v2-state.js';
import { reviseV2Program, runV2AutonomousWorkflow } from '../src/workflow/v2-runtime.js';
import { dispatchV2Action, readStepRestarts, requestStepRestart, stepRestartPath } from '../src/workflow/v2-dispatch.js';
import { createRevisionRequest, exportV2Plan, normalizeRevisionInput, queueRevisionRequest } from '../src/workflow/v2-revision.js';
import { acceptV2Step, rerunV2Step, restartV2Step, stepReopenedLines } from '../src/workflow/cli.js';
import { notableWatchEvents, renderWatchEvent } from '../src/workflow/watch-cli.js';

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



// --- Stage 3: the kernel side of step rerun / accept, and the pin label ------

const readState = (runDir) => JSON.parse(readFileSync(join(runDir, 'state.json'), 'utf8'));
// A failed assertion must not leave a held step running: cancel the run and
// wait for its kernel, so the test file always ends.
async function guarded(runDir, kernel, body) {
  let finished = false;
  try {
    const result = await body();
    finished = true;
    return result;
  } finally {
    if (!finished) {
      try { writeFileSync(join(runDir, 'cancellation.json'), JSON.stringify({ requested: true, requestedAt: new Date().toISOString(), reason: 'test cleanup' })); } catch { /* run dir gone */ }
      await kernel.catch(() => {});
    }
  }
}
const revisionOf = (runDir, { source, rerun = [], accept = null, baseRevision }) => {
  const state = readState(runDir);
  const body = normalizeRevisionInput(exportV2Plan(state), { rerun });
  return createRevisionRequest({ ...body, baseRevision: baseRevision ?? state.program.revision, ...(accept ? { accept } : {}) }, { source });
};

test('a restart --pool runs through the real dispatcher pinned, and the route reason says the restart pinned it', async (t) => {
  const f = fixture(t);
  const runId = 'wf-rstpin-abcdef';
  const connector = (name) => ({
    name, lanes: ['analyze', 'build', 'chore'], enabled: true, spawn: { cmd: ['fake'] },
    modelSelection: { flag: '--model' },
    strategyAssignments: Object.fromEntries(['low', 'medium', 'high'].map((tier) => [tier, { pool: name, model: 'gpt-5.6-luna' }])),
  });
  const core = { config: { depthLimit: 2 }, pools: {}, incumbents: {}, decisionLog: [] };
  let held = true;
  const worker = async (_connector, task, targetDir, files, opts) => {
    writeFileSync(files.taskFile, task);
    if (held) {
      held = false;
      writeFileSync(join(targetDir, 'a.txt'), 'partial');
      for (;;) {
        if (opts.shouldCancel?.()) return { ok: false, cancelled: true, why: 'cancelled', meta: { cancelled: true } };
        await new Promise((done) => setTimeout(done, 5));
      }
    }
    writeFileSync(join(targetDir, 'a.txt'), 'done');
    writeFileSync(files.outFile, 'delivered a');
    return { ok: true, why: 'ok', meta: { exitCode: 0, wallSec: 1 } };
  };
  const kernel = runV2AutonomousWorkflow({
    bullswarmDir: f.bullswarmDir, goalDocument: f.goalDocument, pools: [], runId,
    initialPlannerResponse: initial([work('a')]),
    dependencies: {
      controlPollMs: 10, refreshPools: async () => null,
      dispatchV2Action: (options) => dispatchV2Action({
        ...options, pools: [connector('codex'), connector('grok')],
        dependencies: {
          watchOnce: worker, loadState: () => structuredClone(core), saveState: (_dir, next) => Object.assign(core, structuredClone(next)),
          uuid: () => 'session-fixed',
        },
      }),
    },
  });
  const runDir = join(f.bullswarmDir, 'workflows', runId);
  const done = await guarded(runDir, kernel, async () => {
    await until(() => readState(runDir).attempts.length === 1, 'a-1 running');
    const restarted = await restartV2Step({ bullswarmDir: f.bullswarmDir, token: runId, stepId: 'a', pool: 'grok', waitMs: 5000 });
    assert.equal(restarted.status, 'restarted');
    return kernel;
  });
  assert.equal(done.result.status, 'completed');
  const second = done.state.attempts.find((attempt) => attempt.id === 'a-2');
  assert.equal(second.pool, 'grok');
  assert.match(second.routeWhy, /^pinned to grok \(step restart\)/);
  assert.doesNotMatch(second.routeWhy, /--worker-pool/);
});

test('a queued step rerun the live kernel rejects: the kernel deletes its intent, and a later plan revise --rerun carries no handoff', async (t) => {
  const f = fixture(t);
  const ctl = controller();
  ctl.hold('a');
  const runId = 'wf-rrrej-abcdef';
  const runDir = join(f.bullswarmDir, 'workflows', runId);
  const kernel = start(f, runId, [work('a'), work('b')], ctl);
  const done = await guarded(runDir, kernel, async () => {
  await until(() => readEvents(runDir).some((event) => event.type === 'action.finished' && event.payload.actionId === 'b'), 'b finished');
  // What `step rerun` leaves when its CLI returned `queued`: an applied intent
  // naming the revision, and the revision in the queue.
  const request = revisionOf(runDir, { source: 'step-rerun', rerun: ['b'], baseRevision: 99 });
  requestStepRestart(runDir, { actionId: 'b', attemptId: 'b-1', source: 'step-rerun', revisionRequestId: request.id, appliedAt: new Date().toISOString() });
  // Another step's rerun intent, for another request, is left alone.
  requestStepRestart(runDir, { actionId: 'a', attemptId: 'a-1', source: 'step-rerun', revisionRequestId: 'rev-other-000000', appliedAt: new Date().toISOString() });
  queueRevisionRequest(runDir, request);
  await until(() => readEvents(runDir).some((event) => event.type === 'program.revision_rejected'), 'the rejection');
  assert.equal(existsSync(stepRestartPath(runDir, 'b')), false, 'the rejected rerun\'s intent is gone');
  assert.equal(existsSync(stepRestartPath(runDir, 'a')), true, 'an intent of another request stays');
  rmSync(stepRestartPath(runDir, 'a'));
  // A later plain rerun of b: no stale handoff.
  const revised = await reviseV2Program({ bullswarmDir: f.bullswarmDir, runId, request: revisionOf(runDir, { source: 'cli', rerun: ['b'] }), waitMs: 5000 });
  assert.equal(revised.status, 'applied');
  await until(() => ctl.count('b') === 2, 'b ran again');
  const restarted = await restartV2Step({ bullswarmDir: f.bullswarmDir, token: runId, stepId: 'a', waitMs: 5000 });
  assert.equal(restarted.status, 'restarted');
  return kernel;
  });
  assert.equal(done.result.status, 'completed');
  const rerunCall = ctl.calls.filter((call) => call.actionId === 'b')[1];
  assert.equal(rerunCall.resumeHandoff, null);
  assert.doesNotMatch(rerunCall.taskText, /## Prior attempt on this step/);
});

test('step accept through the live kernel and through an offline apply: step.accepted follows the revision, and the dependent runs', async (t) => {
  const f = fixture(t);
  const ctl = controller();
  const failing = new Set(['a']);
  const dispatch = async (options) => {
    if (!failing.delete(options.action.id)) return ctl.dispatch(options);
    const files = options.paths(1);
    const record = { ordinal: 1, pool: 'fixture', model: 'fixture-model', status: 'running', startedAt: new Date().toISOString(), taskFile: files.taskFile, outFile: files.outFile };
    options.onAttempt?.('started', record);
    writeFileSync(files.outFile, 'nearly');
    Object.assign(record, { status: 'failed', finishedAt: new Date().toISOString(), failureKind: 'semantic', why: 'the report says it is incomplete' });
    options.onAttempt?.('finished', record);
    return { ok: false, status: 'failed', failureKind: 'semantic', attempts: [record], verdict: { ok: false, why: record.why } };
  };
  ctl.hold('h');
  const runId = 'wf-accept-abcdef';
  const runDir = join(f.bullswarmDir, 'workflows', runId);
  const kernel = runV2AutonomousWorkflow({
    bullswarmDir: f.bullswarmDir, goalDocument: f.goalDocument, pools: [], runId,
    initialPlannerResponse: initial([work('a'), work('c', { dependsOn: ['a'] }), work('h')]),
    dependencies: { dispatchV2Action: dispatch, controlPollMs: 10 },
  });
  let accepted = null;
  const done = await guarded(runDir, kernel, async () => {
  await until(() => readState(runDir).actions.find((action) => action.id === 'c').status === 'blocked', 'c blocked behind the failed a');
  accepted = await reviseV2Program({
    bullswarmDir: f.bullswarmDir, runId, waitMs: 5000,
    request: revisionOf(runDir, { source: 'step-accept', accept: [{ step: 'a', reason: 'good enough for the demo', requirements: null }] }),
  });
  assert.deepEqual([accepted.status, accepted.appliedBy, accepted.record.changes.accepted], ['applied', 'kernel', ['a']]);
  await until(() => ctl.count('c') === 1, 'the dependent ran');
  await restartV2Step({ bullswarmDir: f.bullswarmDir, token: runId, stepId: 'h', waitMs: 5000 });
  return kernel;
  });
  assert.equal(done.result.status, 'completed');
  const events = readEvents(runDir);
  const revisedAt = events.findIndex((event) => event.type === 'program.revised' && event.payload.requestId === accepted.record.id);
  const acceptedEvent = events.findIndex((event) => event.type === 'step.accepted');
  assert.ok(revisedAt >= 0 && acceptedEvent === revisedAt + 1, 'step.accepted right after the revision');
  assert.deepEqual(events[acceptedEvent].payload, { actionId: 'a', reason: 'good enough for the demo', requirements: null });
  const a = done.state.actions.find((action) => action.id === 'a');
  assert.deepEqual([a.status, a.acceptance.evidence, a.acceptance.attemptId], ['succeeded', 'choice', 'a-1']);

  // Offline: a finished run whose failed step is accepted with no kernel alive.
  const g = fixture(t);
  const offlineId = 'wf-acptof-abcdef';
  const offlineDir = join(g.bullswarmDir, 'workflows', offlineId);
  failing.add('a');
  const finished = await runV2AutonomousWorkflow({
    bullswarmDir: g.bullswarmDir, goalDocument: g.goalDocument, pools: [], runId: offlineId,
    initialPlannerResponse: initial([work('a'), work('c', { dependsOn: ['a'] })]),
    dependencies: { dispatchV2Action: dispatch, controlPollMs: 10 },
  });
  assert.equal(finished.result.status, 'partial');
  const offline = await reviseV2Program({
    bullswarmDir: g.bullswarmDir, runId: offlineId, waitMs: 0,
    request: revisionOf(offlineDir, { source: 'step-accept', accept: [{ step: 'a', reason: 'shipped by hand', requirements: null }] }),
  });
  assert.deepEqual([offline.status, offline.appliedBy], ['applied', 'offline']);
  const offlineEvents = readEvents(offlineDir);
  assert.equal(offlineEvents.at(-1).type, 'step.accepted');
  assert.deepEqual(offlineEvents.at(-1).payload, { actionId: 'a', reason: 'shipped by hand', requirements: null });
  assert.equal(offlineEvents.at(-2).type, 'program.revised');
});

// F22 (D32, P3): reopening a cancelled run with a single-step verb.
const actStep = (id) => work(id, { role: 'act', lane: 'analyze', deliverable: 'outward', ownedFiles: [] });
const cancelRun = (runDir) => writeFileSync(join(runDir, 'cancellation.json'), JSON.stringify({ requested: true, requestedAt: new Date().toISOString(), reason: 'caller cancelled' }));
const statuses = (runDir) => Object.fromEntries(readState(runDir).actions.map((action) => [action.id, action.status]));

test('step rerun on a cancelled run never runs again an act step the cancellation stopped after its worker started: it stays cancelled and is listed (F22)', async (t) => {
  const f = fixture(t);
  const ctl = controller();
  for (const id of ['sendit', 'other2', 'other3']) ctl.hold(id);
  const runId = 'wf-f22rr-abcdef';
  const runDir = join(f.bullswarmDir, 'workflows', runId);
  const kernel = start(f, runId, [actStep('sendit'), work('other2'), work('other3')], ctl);
  const cancelled = await guarded(runDir, kernel, async () => {
    await until(() => ['sendit', 'other2', 'other3'].every((id) => ctl.count(id) === 1), 'all three workers started');
    cancelRun(runDir);
    return kernel;
  });
  assert.equal(cancelled.result.status, 'cancelled');
  assert.deepEqual(statuses(runDir), { sendit: 'cancelled', other2: 'cancelled', other3: 'cancelled' });

  const rerun = await rerunV2Step({ bullswarmDir: f.bullswarmDir, token: runId, stepId: 'other2', waitMs: 0 });
  assert.deepEqual([rerun.code, rerun.status, rerun.appliedBy], [0, 'applied', 'offline']);
  const reopened = readEvents(runDir).find((event) => event.type === 'workflow.reopened').payload;
  assert.deepEqual([reopened.previousStatus, reopened.requeued, reopened.keptCancelled], ['cancelled', ['other3'], ['sendit']]);
  // Listed to the caller: the verb returns it and prints it.
  assert.deepEqual(rerun.reopened, { previousStatus: 'cancelled', archivedResult: reopened.archivedResult, requeued: ['other3'], keptCancelled: ['sendit'] });
  assert.deepEqual(stepReopenedLines(rerun.reopened), [
    'reopened the cancelled run; its earlier result is archived; running again: other3',
    'not run again (act step, may have acted): sendit',
  ]);
  // The watch's reopened line lists it too.
  const { notable } = notableWatchEvents({ events: readEvents(runDir).filter((event) => event.type === 'workflow.reopened'), state: readState(runDir) });
  assert.deepEqual(notable.map((event) => [event.type, event.keptCancelled]), [['run.reopened', ['sendit']]]);
  assert.match(renderWatchEvent(notable[0]), /run reopened from cancelled by a plan revision · not run again \(act step, may have acted\): sendit$/);
  assert.deepEqual(statuses(runDir), { sendit: 'cancelled', other2: 'pending', other3: 'pending' });

  const resumed = await runV2AutonomousWorkflow({
    bullswarmDir: f.bullswarmDir, resumeRunId: runId, pools: [],
    dependencies: { dispatchV2Action: ctl.dispatch, controlPollMs: 10 },
  });
  assert.equal(ctl.count('sendit'), 1, 'the act step\'s worker ran once');
  assert.deepEqual([ctl.count('other2'), ctl.count('other3')], [2, 2]);
  assert.deepEqual(statuses(runDir), { sendit: 'cancelled', other2: 'succeeded', other3: 'succeeded' });
  assert.equal(resumed.result.status, 'partial');
});

test('step accept on a cancelled run keeps a started act step cancelled too; an act step cancelled before any worker of it started is requeued (F22)', async (t) => {
  const f = fixture(t);
  const ctl = controller();
  const failing = new Set(['broken']);
  const dispatch = async (options) => {
    if (!failing.delete(options.action.id)) return ctl.dispatch(options);
    const files = options.paths(1);
    const record = { ordinal: 1, pool: 'fixture', model: 'fixture-model', status: 'running', startedAt: new Date().toISOString(), taskFile: files.taskFile, outFile: files.outFile };
    options.onAttempt?.('started', record);
    writeFileSync(files.outFile, 'nearly');
    Object.assign(record, { status: 'failed', finishedAt: new Date().toISOString(), failureKind: 'semantic', why: 'the report says it is incomplete' });
    options.onAttempt?.('finished', record);
    return { ok: false, status: 'failed', failureKind: 'semantic', attempts: [record], verdict: { ok: false, why: record.why } };
  };
  ctl.hold('sendit');
  const runId = 'wf-f22ac-abcdef';
  const runDir = join(f.bullswarmDir, 'workflows', runId);
  // `later` is an act step that only starts after sendit: the cancellation
  // stops it before any worker of it ran.
  const kernel = runV2AutonomousWorkflow({
    bullswarmDir: f.bullswarmDir, goalDocument: f.goalDocument, pools: [], runId,
    initialPlannerResponse: initial([work('broken'), actStep('sendit'), { ...actStep('later'), dependsOn: ['sendit'] }]),
    dependencies: { dispatchV2Action: dispatch, controlPollMs: 10 },
  });
  const cancelled = await guarded(runDir, kernel, async () => {
    await until(() => ctl.count('sendit') === 1 && statuses(runDir).broken === 'failed', 'sendit running, broken failed');
    cancelRun(runDir);
    return kernel;
  });
  assert.equal(cancelled.result.status, 'cancelled');
  assert.deepEqual(statuses(runDir), { broken: 'failed', sendit: 'cancelled', later: 'cancelled' });

  const accepted = await acceptV2Step({ bullswarmDir: f.bullswarmDir, token: runId, stepId: 'broken', reason: 'fine for now', waitMs: 0 });
  assert.deepEqual([accepted.code, accepted.status, accepted.appliedBy], [0, 'applied', 'offline']);
  const reopened = readEvents(runDir).find((event) => event.type === 'workflow.reopened').payload;
  assert.deepEqual([reopened.requeued, reopened.keptCancelled], [['later'], ['sendit']]);
  assert.deepEqual([accepted.reopened.requeued, accepted.reopened.keptCancelled], [['later'], ['sendit']]);
  assert.deepEqual(stepReopenedLines({ previousStatus: 'completed', requeued: ['a'] }), ['reopened the completed run; its earlier result is archived; running again: a']);

  const resumed = await runV2AutonomousWorkflow({
    bullswarmDir: f.bullswarmDir, resumeRunId: runId, pools: [],
    dependencies: { dispatchV2Action: dispatch, controlPollMs: 10 },
  });
  assert.equal(ctl.count('sendit'), 1, 'the act step\'s worker ran once');
  assert.equal(ctl.count('later'), 0, 'blocked behind the cancelled act step');
  assert.deepEqual(statuses(runDir), { broken: 'succeeded', sendit: 'cancelled', later: 'blocked' });
  assert.equal(resumed.result.status, 'partial');
});

test('a second requirement accept on the same check: its step.accepted names only the requirement it added (F21)', async (t) => {
  const f = fixture(t);
  const goalDocument = createV2GoalDocument({
    goal: 'Deliver alpha and beta', cwd: f.workspace,
    requirements: [{ id: 'alpha', text: 'alpha.txt is right' }, { id: 'beta', text: 'beta.txt is right' }],
    settings: { executionMode: 'program', workspaceMode: 'shared', scout: false, plannerMode: 'caller', concurrency: 1 },
  });
  const ctl = controller();
  const dispatch = async (options) => {
    if (!options.action.evidenceFor.length) return ctl.dispatch(options);
    const files = options.paths(1);
    const candidatePath = options.taskText.match(/exact durable path: '([^']+)'/)?.[1];
    writeFileSync(candidatePath, JSON.stringify({ schemaVersion: 'bullswarm.workflow.evidence.v2', requirements: Object.fromEntries(options.action.evidenceFor.map((id) => [id, { status: 'failed', evidence: [`${id}.txt is wrong`], concerns: [] }])) }));
    const record = { ordinal: 1, pool: 'fixture', model: 'fixture-model', status: 'running', startedAt: new Date().toISOString(), taskFile: files.taskFile, outFile: files.outFile };
    options.onAttempt?.('started', record);
    writeFileSync(files.outFile, 'judged');
    Object.assign(record, { status: 'succeeded', finishedAt: new Date().toISOString() });
    const verdict = { ok: true, structured: options.outputValidator('prose'), outFile: files.outFile };
    options.onAttempt?.('finished', record, verdict);
    return { ok: true, status: 'succeeded', attempts: [record], verdict };
  };
  const runId = 'wf-f21acc-abcdef';
  const runDir = join(f.bullswarmDir, 'workflows', runId);
  const planned = initial([
    work('build', { affects: ['alpha', 'beta'] }),
    work('check', { dependsOn: ['build'], affects: [], ownedFiles: [], lane: 'analyze', evidenceFor: ['alpha', 'beta'] }),
  ]);
  planned.program.defaults = { verifyRounds: 0 };
  const run = await runV2AutonomousWorkflow({
    bullswarmDir: f.bullswarmDir, goalDocument, pools: [], runId, initialPlannerResponse: planned,
    dependencies: { dispatchV2Action: dispatch, controlPollMs: 10 },
  });
  assert.deepEqual(Object.values(run.state.ledger.requirements).map((entry) => entry.status), ['failed', 'failed']);
  for (const id of ['alpha', 'beta']) {
    const accepted = await acceptV2Step({ bullswarmDir: f.bullswarmDir, token: runId, stepId: 'check', reason: `${id} is fine for now`, requirements: [id], waitMs: 0 });
    assert.deepEqual([accepted.code, accepted.status, accepted.requirements], [0, 'applied', [id]], id);
  }
  const events = readEvents(runDir).filter((event) => event.type === 'step.accepted').map((event) => event.payload);
  assert.deepEqual(events, [
    { actionId: 'check', reason: 'alpha is fine for now', requirements: ['alpha'] },
    { actionId: 'check', reason: 'beta is fine for now', requirements: ['beta'] },
  ]);
});
