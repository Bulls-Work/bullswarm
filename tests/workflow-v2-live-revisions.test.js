// Live plan revisions and pause: the caller of a program-mode run rewrites its
// plan at any time (while agents run, while paused, after it finished) and the
// kernel makes the run match, stopping only the agents whose steps changed.
// Runtime tests drive the real kernel with a controllable fake dispatcher whose
// held steps honor shouldCancel the way the real process runner does.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { readEvents } from '../src/workflow/events.js';
import { createV2GoalDocument, deserializeV2DurableState, validateV2DurableState } from '../src/workflow/v2-state.js';
import { pauseV2Run, reviseV2Program, runV2AutonomousWorkflow, unpauseV2Run } from '../src/workflow/v2-runtime.js';
import {
  createRevisionRequest, exportV2Plan, normalizeRevisionInput, planV2Revision, queueRevisionRequest, V2RevisionError,
} from '../src/workflow/v2-revision.js';
import { peekSteering, queueSteering } from '../src/workflow/steering.js';
import { projectV2DependencyStages } from '../src/workflow/v2-presentation.js';

const BIN = resolve(new URL('..', import.meta.url).pathname, 'bin', 'bullswarm.js');
const requirements = [{ id: 'deliver', text: 'Deliver the requested files and validate them.' }];

const work = (id, options = {}) => ({
  id, purpose: `Deliver ${id}`, dependsOn: [], affects: ['deliver'], ownedFiles: [`${id}.txt`],
  prompt: `Write ${id}.txt.`, lane: 'build', effort: 'low', evidenceFor: [], inputs: [], produces: [], ...options,
});
const check = (id, dependsOn) => ({
  id, purpose: `Check ${id}`, dependsOn, affects: [], ownedFiles: [], prompt: 'Inspect the delivered files.',
  lane: 'analyze', effort: 'low', evidenceFor: ['deliver'], inputs: [], produces: [],
});
const programOf = (actions) => ({ schemaVersion: 'bullswarm.workflow.program.v2', actions });
const initial = (actions) => ({ schemaVersion: 'bullswarm.workflow.planner-response.v2', kind: 'program', summary: 'Initial plan.', program: programOf(actions) });

function fixture(t, settings = {}) {
  const root = mkdtempSync(join(tmpdir(), 'bullswarm-live-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const workspace = join(root, 'repo');
  const bullswarmDir = join(root, 'home');
  mkdirSync(workspace); mkdirSync(bullswarmDir);
  const goalDocument = createV2GoalDocument({
    goal: 'Deliver the requested files', cwd: workspace, requirements,
    settings: { executionMode: 'program', workspaceMode: 'shared', scout: false, plannerMode: 'caller', concurrency: 3, ...settings },
  });
  return { root, workspace, bullswarmDir, goalDocument };
}

// A dispatcher whose steps finish at once unless held. A held step waits for
// release() or for shouldCancel(), exactly like a real worker being stopped.
function controller() {
  const gates = new Map();
  const calls = [];
  const hold = (actionId) => {
    let release;
    const promise = new Promise((done) => { release = done; });
    gates.set(actionId, { promise, release });
    return () => release();
  };
  const dispatch = async (options) => {
    const files = options.paths(1);
    const call = { actionId: options.action.id, prompt: options.action.prompt, cancelled: false };
    calls.push(call);
    const record = {
      ordinal: 1, pool: 'fixture', model: 'fixture', status: 'running',
      startedAt: new Date().toISOString(), taskFile: files.taskFile, outFile: files.outFile,
    };
    writeFileSync(files.taskFile, options.taskText);
    options.onAttempt?.('started', record);
    const gate = gates.get(options.action.id);
    if (gate) {
      gates.delete(options.action.id);
      let poll;
      const outcome = await Promise.race([
        gate.promise.then(() => 'released'),
        new Promise((done) => { poll = setInterval(() => { if (options.shouldCancel?.()) done('cancelled'); }, 5); }),
      ]);
      clearInterval(poll);
      if (outcome === 'cancelled') {
        call.cancelled = true;
        Object.assign(record, { status: 'cancelled', finishedAt: new Date().toISOString(), failureKind: 'cancelled' });
        options.onAttempt?.('finished', record);
        return { ok: false, status: 'cancelled', failureKind: 'cancelled', attempts: [record], verdict: { ok: false, why: 'cancelled' } };
      }
    }
    if (options.action.evidenceFor?.length) {
      const candidatePath = options.taskText.match(/exact durable path: '([^']+)'/)?.[1];
      writeFileSync(candidatePath, JSON.stringify({
        schemaVersion: 'bullswarm.workflow.evidence.v2',
        requirements: Object.fromEntries(options.action.evidenceFor.map((id) => [id, { status: 'passed', evidence: ['inspected the files'], concerns: [] }])),
      }));
      writeFileSync(files.outFile, 'evidence recorded');
      const structured = options.outputValidator('prose');
      const verdict = { ok: true, structured, outFile: files.outFile };
      Object.assign(record, { status: 'succeeded', finishedAt: new Date().toISOString() });
      options.onAttempt?.('finished', record, verdict);
      return { ok: true, status: 'succeeded', attempts: [record], verdict };
    }
    writeFileSync(join(options.targetDir, `${options.action.id}.txt`), options.action.prompt);
    writeFileSync(files.outFile, `delivered ${options.action.id}`);
    Object.assign(record, { status: 'succeeded', finishedAt: new Date().toISOString() });
    options.onAttempt?.('finished', record);
    return { ok: true, status: 'succeeded', attempts: [record], verdict: { ok: true, outFile: files.outFile } };
  };
  const count = (actionId) => calls.filter((call) => call.actionId === actionId).length;
  return { dispatch, hold, calls, count };
}

const runDirOf = (f, runId) => join(f.bullswarmDir, 'workflows', runId);
const readState = (f, runId) => JSON.parse(readFileSync(join(runDirOf(f, runId), 'state.json'), 'utf8'));
const statusOf = (state, id) => state.actions.find((action) => action.id === id)?.status;
const eventsOf = (f, runId, type) => readEvents(runDirOf(f, runId)).filter((event) => event.type === type);

async function until(predicate, { timeoutMs = 5000, what = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try { if (predicate()) return; } catch { /* state mid-write */ }
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((done) => setTimeout(done, 5));
  }
}

function start(f, runId, actions, ctl) {
  return runV2AutonomousWorkflow({
    bullswarmDir: f.bullswarmDir, goalDocument: f.goalDocument, pools: [], runId,
    initialPlannerResponse: initial(actions),
    dependencies: { dispatchV2Action: ctl.dispatch, controlPollMs: 10 },
  });
}

function resume(f, runId, ctl) {
  return runV2AutonomousWorkflow({
    bullswarmDir: f.bullswarmDir, resumeRunId: runId, pools: [],
    dependencies: { dispatchV2Action: ctl.dispatch, controlPollMs: 10 },
  });
}

function revisionFrom(f, runId, edit, options = {}) {
  const state = deserializeV2DurableState(readFileSync(join(runDirOf(f, runId), 'state.json'), 'utf8'));
  const document = exportV2Plan(state, { pendingSteering: peekSteering(state, runDirOf(f, runId)) });
  edit(document);
  return createRevisionRequest(normalizeRevisionInput(document, options), { source: 'test' });
}

test('a revision is planned by action id: kept, amended, removed, added, rerun, and everything downstream', async (t) => {
  const f = fixture(t);
  const ctl = controller();
  const done = await start(f, 'wf-plan1a-abcdef', [work('a'), work('b', { dependsOn: ['a'] }), work('c'), check('check', ['b', 'c'])], ctl);
  assert.equal(done.result.status, 'completed');
  const state = done.state;
  const doc = exportV2Plan(state);
  assert.equal(doc.baseRevision, 1);
  assert.deepEqual(doc.program.actions.map((action) => action.id), ['a', 'b', 'c', 'check']);

  // Exported and resubmitted untouched: nothing to do, never a false amendment.
  const unchanged = planV2Revision(state, normalizeRevisionInput(doc));
  assert.equal(unchanged.ok, false);
  assert.match(unchanged.issues[0], /changes nothing/);

  const rerunA = planV2Revision(state, normalizeRevisionInput(doc, { rerun: ['a'] }));
  assert.equal(rerunA.ok, true, JSON.stringify(rerunA.issues));
  assert.deepEqual(rerunA.changes, { added: [], amended: [], restored: [], removed: [], rerun: ['a'], invalidated: ['b', 'check'] });

  const edited = structuredClone(doc);
  edited.program.actions.find((action) => action.id === 'c').prompt = 'Write c.txt with the new wording.';
  edited.program.actions = edited.program.actions.filter((action) => action.id !== 'check');
  edited.program.actions.push(work('d', { dependsOn: ['c'] }));
  const mixed = planV2Revision(state, normalizeRevisionInput(edited));
  assert.equal(mixed.ok, true, JSON.stringify(mixed.issues));
  assert.deepEqual(mixed.changes, { added: ['d'], amended: ['c'], restored: [], removed: ['check'], rerun: [], invalidated: [] });
  assert.deepEqual(mixed.affected.sort(), ['c', 'check']);

  const stale = planV2Revision(state, { ...normalizeRevisionInput(doc, { rerun: ['a'] }), baseRevision: 0 });
  assert.match(stale.issues.join(' '), /plan changed since revision 0/);
  const unknownRerun = planV2Revision(state, normalizeRevisionInput(doc, { rerun: ['nope'] }));
  assert.match(unknownRerun.issues.join(' '), /rerun names "nope"/);
  const broken = structuredClone(doc);
  broken.program.actions[0].dependsOn = ['ghost'];
  assert.equal(planV2Revision(state, normalizeRevisionInput(broken)).ok, false);

  // The three accepted input shapes, and a foreign one.
  assert.equal(normalizeRevisionInput(programOf([work('a')])).program.actions[0].id, 'a');
  assert.equal(normalizeRevisionInput(initial([work('a')])).summary, 'Initial plan.');
  assert.throws(() => normalizeRevisionInput({ schemaVersion: 'nope' }), V2RevisionError);
});

test('while agents run: an amended running step is stopped and restarted, a removed step never runs, a new step joins, the rest keep going', async (t) => {
  const f = fixture(t);
  const ctl = controller();
  const releaseA = ctl.hold('a');
  const releaseSlow = ctl.hold('slow');
  const runId = 'wf-live2a-abcdef';
  const kernel = start(f, runId, [
    work('a'), work('slow'), work('b'),
    work('c', { dependsOn: ['a', 'b'] }), check('check', ['c', 'slow']),
  ], ctl);
  await until(() => statusOf(readState(f, runId), 'b') === 'succeeded' && ctl.count('a') === 1 && ctl.count('slow') === 1, { what: 'first wave' });

  const request = revisionFrom(f, runId, (doc) => {
    doc.summary = 'A needs the v2 wording; the check is replaced by a report step';
    doc.program.actions.find((action) => action.id === 'a').prompt = 'Write a.txt with the v2 wording.';
    doc.program.actions = doc.program.actions.filter((action) => action.id !== 'check');
    doc.program.actions.push(work('report', { dependsOn: ['c'] }));
  });
  const outcome = await reviseV2Program({ bullswarmDir: f.bullswarmDir, runId, request, waitMs: 5000, pollMs: 5 });
  assert.equal(outcome.status, 'applied');
  assert.equal(outcome.appliedBy, 'kernel');
  assert.deepEqual(outcome.record.changes, { added: ['report'], amended: ['a'], restored: [], removed: ['check'], rerun: [], invalidated: [] });

  // Only the amended agent was stopped; the untouched slow agent is still running.
  assert.equal(ctl.calls.find((call) => call.actionId === 'a').cancelled, true);
  assert.equal(ctl.calls.find((call) => call.actionId === 'slow').cancelled, false);
  assert.equal(statusOf(readState(f, runId), 'slow'), 'running');
  releaseA();
  releaseSlow();
  const result = await kernel;

  assert.equal(result.result.status, 'completed', result.result.reason);
  assert.deepEqual(ctl.calls.filter((call) => call.actionId === 'a').map((call) => call.prompt), ['Write a.txt.', 'Write a.txt with the v2 wording.']);
  assert.equal(ctl.count('b'), 1, 'a finished result that nothing changed is reused');
  assert.equal(ctl.count('slow'), 1);
  assert.equal(ctl.count('check'), 0, 'a removed step never runs');
  assert.equal(ctl.count('report'), 1);
  assert.equal(readFileSync(join(f.workspace, 'a.txt'), 'utf8'), 'Write a.txt with the v2 wording.');
  assert.deepEqual(result.result.actions.map((action) => [action.id, action.status]), [
    ['a', 'succeeded'], ['slow', 'succeeded'], ['b', 'succeeded'], ['c', 'succeeded'], ['check', 'removed'], ['report', 'succeeded'],
  ]);
  const a = result.state.actions.find((action) => action.id === 'a');
  assert.equal(a.attempts, 2);
  assert.equal(a.supersededAttempts, 1);
  assert.equal(a.programRevision, 2);
  assert.equal(result.state.program.revision, 2);
  validateV2DurableState(result.state);
  const stopped = eventsOf(f, runId, 'action.finished').find((event) => event.payload.actionId === 'a' && event.payload.status === 'cancelled');
  assert.equal(stopped.payload.failureKind, 'superseded');
  assert.equal(result.state.attempts.find((attempt) => attempt.id === 'a-1').failureKind, 'superseded', 'the stopped attempt says why it stopped');
  assert.deepEqual(eventsOf(f, runId, 'program.revision_stopping')[0].payload.actionIds, ['a']);
  assert.equal(eventsOf(f, runId, 'program.revised')[0].payload.summary, 'A needs the v2 wording; the check is replaced by a report step');
  const stages = projectV2DependencyStages(result.state);
  assert.deepEqual(stages.flatMap((stage) => stage.actionIds).sort(), ['a', 'b', 'c', 'report', 'slow']);
});

test('discarding a finished result reruns it and everything that consumed it, and its evidence stops counting until judged again', async (t) => {
  const f = fixture(t);
  const ctl = controller();
  const releaseSlow = ctl.hold('slow');
  const runId = 'wf-live3a-abcdef';
  // slow is read-only: a writer affecting the same requirement would have to
  // be a dependency of check-a.
  const kernel = start(f, runId, [work('a'), check('check-a', ['a']), work('slow', { lane: 'analyze', ownedFiles: [], affects: [] })], ctl);
  await until(() => statusOf(readState(f, runId), 'check-a') === 'succeeded', { what: 'check-a' });
  assert.equal(readState(f, runId).ledger.requirements.deliver.status, 'passed');

  // Hold the rerun so check-a cannot be judged again before the state is read.
  const releaseRerun = ctl.hold('a');
  const request = revisionFrom(f, runId, () => {}, { rerun: ['a'], summary: 'Redo a from scratch' });
  const outcome = await reviseV2Program({ bullswarmDir: f.bullswarmDir, runId, request, waitMs: 5000, pollMs: 5 });
  assert.equal(outcome.status, 'applied');
  assert.deepEqual(outcome.record.changes.rerun, ['a']);
  assert.deepEqual(outcome.record.changes.invalidated, ['check-a']);
  assert.notEqual(outcome.state.ledger.requirements.deliver.status, 'passed', 'the discarded judgment no longer counts');
  releaseRerun();
  releaseSlow();
  const result = await kernel;
  assert.equal(result.result.status, 'completed');
  assert.equal(result.result.verified, true);
  assert.equal(ctl.count('a'), 2);
  assert.equal(ctl.count('check-a'), 2);
  assert.equal(ctl.count('slow'), 1);
  validateV2DurableState(result.state);
});

test('pause lets running steps finish, starts nothing new, accepts a revision while paused, and resume continues the revised plan', async (t) => {
  const f = fixture(t);
  const ctl = controller();
  const releaseA = ctl.hold('a');
  const runId = 'wf-live4a-abcdef';
  const kernel = start(f, runId, [work('a'), work('b', { dependsOn: ['a'] })], ctl);
  await until(() => ctl.count('a') === 1, { what: 'a started' });

  const pausing = await pauseV2Run({ bullswarmDir: f.bullswarmDir, runId, mode: 'drain' });
  assert.equal(pausing.status, 'pausing');
  await until(() => eventsOf(f, runId, 'workflow.pause_requested').length === 1, { what: 'pause adopted' });
  releaseA();
  const paused = await kernel;
  assert.equal(paused.result, null);
  assert.equal(paused.paused.mode, 'drain');
  assert.equal(paused.state.lifecycle.status, 'paused');
  assert.equal(statusOf(paused.state, 'a'), 'succeeded', 'a draining step keeps its result');
  assert.equal(ctl.count('b'), 0, 'nothing new starts while pausing');

  const request = revisionFrom(f, runId, (doc) => { doc.program.actions.push(work('c', { dependsOn: ['b'] })); });
  const revised = await reviseV2Program({ bullswarmDir: f.bullswarmDir, runId, request, waitMs: 0 });
  assert.equal(revised.status, 'applied');
  assert.equal(revised.appliedBy, 'offline');
  assert.equal(revised.state.lifecycle.status, 'paused', 'a revision does not lift a pause');

  // A relaunch that is not a resume stays paused.
  const stillPaused = await resume(f, runId, ctl);
  assert.equal(stillPaused.state.lifecycle.status, 'paused');
  assert.equal(ctl.count('b'), 0);

  assert.equal(unpauseV2Run({ bullswarmDir: f.bullswarmDir, runId }).status, 'unpaused');
  // Until a kernel owns the run it stays paused on disk, so no watcher can see
  // a running run whose recorded kernel is dead.
  assert.equal(readState(f, runId).lifecycle.status, 'paused');
  assert.equal(eventsOf(f, runId, 'workflow.unpaused').length, 0);
  const result = await resume(f, runId, ctl);
  assert.equal(result.result.status, 'completed');
  assert.deepEqual(ctl.calls.map((call) => call.actionId), ['a', 'b', 'c']);
  assert.equal(result.state.pause, null);
  assert.equal(existsSync(join(runDirOf(f, runId), 'pause.json')), false);
  assert.deepEqual(eventsOf(f, runId, 'workflow.unpaused').map((event) => event.payload.source), ['resume']);
});

test('pause --now stops running steps, requeues them, and resume runs them again', async (t) => {
  const f = fixture(t);
  const ctl = controller();
  ctl.hold('a');
  const runId = 'wf-live5a-abcdef';
  const kernel = start(f, runId, [work('a'), work('b', { dependsOn: ['a'] })], ctl);
  await until(() => ctl.count('a') === 1, { what: 'a started' });
  await pauseV2Run({ bullswarmDir: f.bullswarmDir, runId, mode: 'now' });
  const paused = await kernel;
  assert.equal(paused.state.lifecycle.status, 'paused');
  assert.equal(ctl.calls[0].cancelled, true);
  assert.equal(statusOf(paused.state, 'a'), 'pending');
  assert.deepEqual(eventsOf(f, runId, 'workflow.paused')[0].payload.requeued, ['a']);
  // A stopped attempt records why it stopped, so it never reads as a pool failure.
  assert.equal(paused.state.attempts.find((attempt) => attempt.actionId === 'a').failureKind, 'paused');
  assert.deepEqual(eventsOf(f, runId, 'attempt.finished').map((event) => event.payload.failureKind), ['paused']);

  unpauseV2Run({ bullswarmDir: f.bullswarmDir, runId });
  const result = await resume(f, runId, ctl);
  assert.equal(result.result.status, 'completed');
  assert.deepEqual(ctl.calls.map((call) => call.actionId), ['a', 'a', 'b']);
});

test('a finished run is reopened by a revision and finishes again with the extended plan', async (t) => {
  const f = fixture(t);
  const ctl = controller();
  const runId = 'wf-live6a-abcdef';
  const first = await start(f, runId, [work('a')], ctl);
  assert.equal(first.result.status, 'completed');

  const request = revisionFrom(f, runId, (doc) => { doc.program.actions.push(work('b', { dependsOn: ['a'] })); });
  const revised = await reviseV2Program({ bullswarmDir: f.bullswarmDir, runId, request, waitMs: 0 });
  assert.equal(revised.status, 'applied');
  assert.deepEqual(revised.reopened, { previousStatus: 'completed', archivedResult: join(runDirOf(f, runId), 'result-before-revision-2.json'), requeued: [] });
  assert.equal(existsSync(revised.reopened.archivedResult), true);
  assert.equal(revised.state.lifecycle.status, 'running');

  const result = await resume(f, runId, ctl);
  assert.equal(result.result.status, 'completed');
  assert.deepEqual(ctl.calls.map((call) => call.actionId), ['a', 'b']);
  assert.equal(eventsOf(f, runId, 'workflow.reopened').length, 1);
  assert.equal(eventsOf(f, runId, 'workflow.finished').length, 2);
});

test('caller steering never halts running work or holds the finish; a revision after the finish reopens the run and consumes it', async (t) => {
  const f = fixture(t);
  const ctl = controller();
  const releaseA = ctl.hold('a');
  const runId = 'wf-live7a-abcdef';
  const kernel = start(f, runId, [work('a'), work('b', { dependsOn: ['a'] })], ctl);
  await until(() => ctl.count('a') === 1, { what: 'a started' });
  queueSteering(f.bullswarmDir, runId, 'Mention the release date in every file.');
  await until(() => eventsOf(f, runId, 'steering.received').length === 1, { what: 'steering announced' });
  assert.equal(readState(f, runId).lifecycle.status, 'running');
  releaseA();
  const finished = await kernel;
  assert.equal(ctl.count('b'), 1, 'queued steering did not stop b from starting');
  assert.equal(finished.result.status, 'completed', 'unread steering never holds the finish');
  assert.deepEqual(finished.result.handback.unreadSteering.map((entry) => entry.message), ['Mention the release date in every file.']);
  assert.equal(finished.state.planner.awaiting, null);

  const request = revisionFrom(f, runId, (doc) => {
    doc.summary = 'Acknowledge the release-date guidance';
    assert.equal(doc.steeringIds.length, 1);
  }, { rerun: ['b'] });
  const revised = await reviseV2Program({ bullswarmDir: f.bullswarmDir, runId, request, waitMs: 0 });
  assert.equal(revised.status, 'applied');
  assert.equal(revised.reopened.previousStatus, 'completed');
  assert.equal(revised.state.steering.length, 1);
  assert.equal(eventsOf(f, runId, 'steering.delivered')[0].payload.source, 'revision');

  const result = await resume(f, runId, ctl);
  assert.equal(result.result.status, 'completed');
  assert.deepEqual(result.result.handback.unreadSteering, [], 'the revision consumed it');
  assert.equal(ctl.count('b'), 2);
});

test('a stale revision queued for a live kernel is rejected durably and the run carries on', async (t) => {
  const f = fixture(t);
  const ctl = controller();
  const releaseA = ctl.hold('a');
  const runId = 'wf-live8a-abcdef';
  const kernel = start(f, runId, [work('a'), work('b', { dependsOn: ['a'] })], ctl);
  await until(() => ctl.count('a') === 1, { what: 'a started' });
  const request = revisionFrom(f, runId, (doc) => { doc.baseRevision = 7; doc.program.actions.push(work('late')); });
  queueRevisionRequest(runDirOf(f, runId), request);
  await until(() => eventsOf(f, runId, 'program.revision_rejected').length === 1, { what: 'rejection' });
  releaseA();
  const result = await kernel;
  assert.equal(result.result.status, 'completed');
  assert.equal(ctl.count('late'), 0);
  const record = result.state.revisions.find((entry) => entry.id === request.id);
  assert.equal(record.status, 'rejected');
  assert.match(record.issues[0], /plan changed since revision 7/);
  assert.equal(result.state.program.revision, 1);
});

test('state validation: removed steps require an applied revision, and a paused run requires its pause record', async (t) => {
  const f = fixture(t);
  const ctl = controller();
  const done = await start(f, 'wf-valid9-abcdef', [work('a'), work('b')], ctl);
  const forged = structuredClone(done.state);
  forged.actions[1].status = 'removed';
  assert.throws(() => validateV2DurableState(forged), /requires an applied plan revision/);
  const pausedWithoutRecord = structuredClone(done.state);
  Object.assign(pausedWithoutRecord.lifecycle, { status: 'paused', finishedAt: null, resultFile: null });
  assert.throws(() => validateV2DurableState(pausedWithoutRecord), /paused requires state.pause/);
});

test('CLI: plan export writes an editable document; plan revise refuses no-op and unknown rerun ids; pause refuses a finished run', async (t) => {
  const f = fixture(t);
  const ctl = controller();
  const done = await start(f, 'wf-cli10a-abcdef', [work('a'), work('b', { dependsOn: ['a'] })], ctl);
  const token = done.shortId;
  const env = { ...process.env, BULLSWARM_HOME: f.bullswarmDir, BULLSWARM_NO_PACKAGED_PROVIDERS: '1' };
  const cli = (...args) => spawnSync(process.execPath, [BIN, ...args], { env, encoding: 'utf8', cwd: f.workspace });
  const out = join(f.root, 'plan.json');

  const exported = cli('workflow', 'plan', 'export', token, '--out', out, '--json');
  assert.equal(exported.status, 0, exported.stderr);
  const payload = JSON.parse(exported.stdout);
  assert.equal(payload.programRevision, 1);
  assert.deepEqual(payload.actions.map((action) => [action.id, action.status]), [['a', 'succeeded'], ['b', 'succeeded']]);
  const document = JSON.parse(readFileSync(out, 'utf8'));
  assert.equal(document.schemaVersion, 'bullswarm.workflow.revision.v1');
  assert.equal(document.baseRevision, 1);

  const noop = cli('workflow', 'plan', 'revise', token, '--program', out);
  assert.equal(noop.status, 2);
  assert.match(noop.stderr, /changes nothing/);
  const unknown = cli('workflow', 'plan', 'revise', token, '--program', out, '--rerun', 'ghost', '--json');
  assert.equal(unknown.status, 2);
  assert.match(JSON.parse(unknown.stdout).issues.join(' '), /rerun names "ghost"/);
  assert.equal(readState(f, done.runId).lifecycle.status, 'completed', 'a refused revision leaves the run untouched');

  const pause = cli('workflow', 'pause', token);
  assert.equal(pause.status, 1);
  assert.match(pause.stderr, /already terminal/);
  const help = cli('workflow', 'plan', 'revise', '--help');
  assert.equal(help.status, 0);
  assert.match(help.stdout, /--rerun <id,\.\.\.>/);
});

test('a cancelled run reopened by a revision runs the steps the cancellation stopped', async (t) => {
  const f = fixture(t);
  const ctl = controller();
  ctl.hold('a');
  const runId = 'wf-live11-abcdef';
  const kernel = start(f, runId, [work('a'), work('b', { dependsOn: ['a'] })], ctl);
  await until(() => ctl.count('a') === 1, { what: 'a started' });
  writeFileSync(join(runDirOf(f, runId), 'cancellation.json'), JSON.stringify({ requested: true, requestedAt: new Date().toISOString(), reason: 'operator requested stop' }));
  const cancelled = await kernel;
  assert.equal(cancelled.result.status, 'cancelled');
  assert.equal(statusOf(cancelled.state, 'a'), 'cancelled');
  assert.equal(statusOf(cancelled.state, 'b'), 'cancelled');

  const request = revisionFrom(f, runId, (doc) => { doc.program.actions.push(work('c')); });
  const revised = await reviseV2Program({ bullswarmDir: f.bullswarmDir, runId, request, waitMs: 0 });
  assert.equal(revised.status, 'applied');
  assert.equal(revised.reopened.previousStatus, 'cancelled');
  assert.deepEqual([...revised.reopened.requeued].sort(), ['a', 'b']);
  assert.equal(statusOf(revised.state, 'a'), 'pending');
  assert.equal(revised.state.cancellation.requested, false);
  validateV2DurableState(revised.state);

  const result = await resume(f, runId, ctl);
  assert.equal(result.result.status, 'completed');
  assert.equal(ctl.count('a'), 2, 'the stopped step runs again');
  assert.equal(ctl.count('b'), 1);
  assert.equal(ctl.count('c'), 1);
  assert.deepEqual(eventsOf(f, runId, 'workflow.reopened').map((event) => [...event.payload.requeued].sort()), [['a', 'b']]);
  validateV2DurableState(result.state);
});
