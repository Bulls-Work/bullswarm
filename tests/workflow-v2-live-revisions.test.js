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
import { readRollupIndex } from '../src/workflow/rollup.js';
import { createV2GoalDocument, deserializeV2DurableState, validateV2DurableState } from '../src/workflow/v2-state.js';
import { pauseV2Run, reviseV2Program, runV2AutonomousWorkflow, unpauseV2Run } from '../src/workflow/v2-runtime.js';
import {
  createRevisionRequest, exportV2Plan, normalizeRevisionInput, planV2Revision, queueRevisionRequest, V2RevisionError,
} from '../src/workflow/v2-revision.js';
import { peekSteering, queueSteering } from '../src/workflow/steering.js';
import { projectV2DependencyStages } from '../src/workflow/v2-presentation.js';
import { ACTION_KINDS, KIND_ROLES } from '../src/workflow/action-validator.js';
import { validateV2PlannerResponse } from '../src/workflow/v2-planner.js';

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

function start(f, runId, actions, ctl, extra = {}) {
  return runV2AutonomousWorkflow({
    bullswarmDir: f.bullswarmDir, goalDocument: f.goalDocument, pools: [], runId,
    initialPlannerResponse: initial(actions),
    dependencies: { dispatchV2Action: ctl.dispatch, controlPollMs: 10, ...extra },
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
  // Reopening must stop the run looking finished on disk: the dashboard's
  // fast path skips any run dir holding rollup.json, and the Home card reads
  // the history index row, which said completed until the run finished again.
  assert.equal(existsSync(join(runDirOf(f, runId), 'rollup.json')), false);
  assert.equal(existsSync(join(runDirOf(f, runId), 'rollup-before-revision-2.json')), true);
  assert.equal(readRollupIndex(f.bullswarmDir).find((record) => record.runId === runId)?.status, 'running');

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

// Step vocabulary and revise: an untouched export of any plan shape changes
// nothing; annotating a kind step with the role its kind belongs to changes
// nothing (the stored step keeps the kind); replacing a kind with a role is a
// real amendment.
const kindStep = (id, kind, options = {}) => {
  const { lane, effort, ...rest } = work(id, { kind, ...options });
  return rest;
};
const kindPlan = () => [
  kindStep('a', 'implement'),
  kindStep('fmt', 'mechanical', { ownedFiles: ['fmt.txt'] }),
  kindStep('design', 'architecture', { affects: [], ownedFiles: [] }),
  kindStep('scan', 'io-read', { affects: [], ownedFiles: [] }),
  kindStep('sum', 'digest', { dependsOn: ['a', 'fmt'], affects: [], ownedFiles: [] }),
  kindStep('merge', 'integration', { dependsOn: ['a', 'fmt', 'sum'], ownedFiles: [] }),
  kindStep('look', 'io-read', { dependsOn: ['merge'], affects: [], ownedFiles: [], evidenceFor: ['deliver'] }),
  kindStep('gate', 'check', { dependsOn: ['merge'], affects: [], ownedFiles: [], evidenceFor: ['deliver'] }),
  kindStep('judge', 'adversarial-acceptance', { dependsOn: ['merge'], affects: [], ownedFiles: [], evidenceFor: ['deliver'] }),
];
const roleStep = (id, role, options = {}) => {
  const { lane, effort, ...rest } = work(id, { role, ...options });
  return rest;
};
const rolePlan = () => [
  roleStep('p', 'produce'),
  roleStep('data', 'produce', { ownedFiles: ['out/data.json'], deliverable: { type: 'data', paths: ['out/data.json'] } }),
  roleStep('survey', 'investigate', { affects: [], ownedFiles: [] }),
  roleStep('join', 'combine', { dependsOn: ['p', 'data'], ownedFiles: [], deliverable: 'files' }),
  roleStep('compare', 'combine', { dependsOn: ['survey', 'join'], affects: [], ownedFiles: [], deliverable: 'report' }),
  roleStep('notify', 'act', { dependsOn: ['join'], affects: [], ownedFiles: [] }),
  roleStep('gate', 'check', { dependsOn: ['join'], affects: [], ownedFiles: [], evidenceFor: ['deliver'] }),
];
const mixedPlan = () => [
  work('lane-writer'),
  kindStep('a', 'implement'),
  roleStep('p', 'produce'),
  roleStep('merge', 'combine', { dependsOn: ['lane-writer', 'a', 'p'], ownedFiles: [], deliverable: 'files' }),
  check('check', ['merge']),
];
const unchangedBy = (state, document) => {
  const planned = planV2Revision(state, normalizeRevisionInput(document));
  assert.equal(planned.ok, false, JSON.stringify(planned.changes));
  assert.match(planned.issues[0], /changes nothing/);
};

test('revise: an untouched export of a kind, lane-only, role or mixed plan changes nothing', async (t) => {
  for (const [name, actions] of [['kind', kindPlan()], ['lane', [work('a'), work('b', { dependsOn: ['a'] }), check('check', ['a', 'b'])]], ['role', rolePlan()], ['mixed', mixedPlan()]]) {
    const f = fixture(t);
    const done = await start(f, `wf-vocab${name.slice(0, 1)}-abcdef`, actions, controller());
    assert.equal(done.result.status, 'completed', name);
    const document = exportV2Plan(done.state);
    // Export is verbatim: kind steps carry no role or deliverable, role steps
    // keep their role and the written-back deliverable.
    for (const action of document.program.actions) {
      if (action.kind) assert.equal('role' in action || 'deliverable' in action, false, `${name}/${action.id}`);
      if (action.role) assert.equal(typeof action.deliverable?.type, 'string', `${name}/${action.id}`);
    }
    unchangedBy(done.state, document);
  }
});

test('revise: evidence is part of the step definition and untouched evidence exports change nothing', async (t) => {
  const f = fixture(t);
  const action = work('a', { evidence: [{ type: 'command', cmd: 'node --test tests/a.test.js' }] });
  const done = await start(f, 'wf-evrev-abcdef', [action], controller());
  const document = exportV2Plan(done.state);
  unchangedBy(done.state, document);

  for (const changed of [
    [{ type: 'command', cmd: 'node --test tests/b.test.js' }],
    [{ type: 'command', cmd: 'node --test tests/a.test.js', timeoutSec: 30 }],
    [{ type: 'schema', file: 'out/a.json', schema: 'schemas/a.json' }],
    undefined,
  ]) {
    const edited = structuredClone(document);
    const target = edited.program.actions.find((entry) => entry.id === 'a');
    if (changed === undefined) delete target.evidence;
    else target.evidence = changed;
    const planned = planV2Revision(done.state, normalizeRevisionInput(edited));
    assert.equal(planned.ok, true, JSON.stringify(planned.issues));
    assert.deepEqual(planned.changes.amended, ['a']);
  }
});

// E29: only a dispatched planner's own program may not carry evidence. A plan
// revision is always the caller's, so `plan revise` of an --orchestrator
// (dispatched) run accepts the same evidence program.
test('CLI: plan revise of a dispatched-planner (--orchestrator) run accepts evidence the caller adds', async (t) => {
  const f = fixture(t, { plannerMode: 'dispatched' });
  const ctl = controller();
  // The kernel dispatches its own planner; this one answers with the plan.
  const dispatch = async (options) => {
    if (options.action.id !== 'workflow-planner') return ctl.dispatch(options);
    const files = options.paths(1);
    writeFileSync(options.taskText.match(/exact durable path: '([^']+)'/)[1], JSON.stringify(initial([work('a')])));
    const structured = options.outputValidator('prose');
    return { ok: true, status: 'succeeded', verdict: { ok: true, structured, outFile: files.outFile, meta: { exitCode: 0 } } };
  };
  const done = await runV2AutonomousWorkflow({
    bullswarmDir: f.bullswarmDir, goalDocument: f.goalDocument, pools: [], runId: 'wf-evdsp-abcdef',
    dependencies: { dispatchV2Action: dispatch, controlPollMs: 10 },
  });
  assert.equal(done.result.status, 'completed');
  assert.equal(readState(f, done.runId).config.settings.plannerMode, 'dispatched');
  const evidence = [{ type: 'command', cmd: 'node --test tests/a.test.js' }];

  // The dispatched planner itself may not declare it.
  const withEvidence = structuredClone(initial([work('a', { evidence })]));
  assert.throws(() => validateV2PlannerResponse(withEvidence, done.state, { boundary: 'steering', workspacePaths: false }),
    (error) => error.issues.some((issue) => issue.includes("evidence is the caller's to declare")));

  const env = { ...process.env, BULLSWARM_HOME: f.bullswarmDir, BULLSWARM_NO_PACKAGED_PROVIDERS: '1' };
  const cli = (...args) => spawnSync(process.execPath, [BIN, ...args], { env, encoding: 'utf8', cwd: f.workspace });
  const out = join(f.root, 'plan.json');
  assert.equal(cli('workflow', 'plan', 'export', done.shortId, '--out', out).status, 0);
  const document = JSON.parse(readFileSync(out, 'utf8'));
  document.program.actions.find((action) => action.id === 'a').evidence = evidence;
  writeFileSync(out, JSON.stringify(document));
  const revised = cli('workflow', 'plan', 'revise', done.shortId, '--program', out, '--json');
  assert.equal(revised.status, 0, revised.stdout || revised.stderr);
  const payload = JSON.parse(revised.stdout);
  assert.equal(payload.status, 'applied', revised.stdout);
  const state = readState(f, done.runId);
  assert.deepEqual(state.program.actions.find((action) => action.id === 'a').evidence, evidence);
  assert.equal(state.config.settings.plannerMode, 'dispatched');
});

test('revise: adding the matching role to a kind step changes nothing, for every kind; replacing the kind with it is an amendment', async (t) => {
  const f = fixture(t);
  const done = await start(f, 'wf-vocabk-abcdef', kindPlan(), controller());
  assert.equal(done.result.status, 'completed');
  const document = exportV2Plan(done.state);
  assert.deepEqual([...new Set(document.program.actions.map((action) => action.kind))].sort(), [...ACTION_KINDS].sort());
  // One step at a time (so a failure names the kind), then all at once.
  for (const action of document.program.actions) {
    const annotated = structuredClone(document);
    annotated.program.actions.find((entry) => entry.id === action.id).role = KIND_ROLES[action.kind];
    unchangedBy(done.state, annotated);
  }
  const all = structuredClone(document);
  for (const action of all.program.actions) action.role = KIND_ROLES[action.kind];
  unchangedBy(done.state, all);
  for (const id of ['merge', 'sum', 'look']) assert.ok(all.program.actions.some((action) => action.id === id && action.role), id);

  const replaced = structuredClone(document);
  const target = replaced.program.actions.find((action) => action.id === 'a');
  delete target.kind;
  target.role = 'produce';
  const planned = planV2Revision(done.state, normalizeRevisionInput(replaced));
  assert.equal(planned.ok, true, JSON.stringify(planned.issues));
  assert.deepEqual(planned.changes.amended, ['a']);
  assert.deepEqual(planned.changes.added, []);
  assert.deepEqual(planned.changes.removed, []);
  const stored = planned.desired.find((action) => action.id === 'a');
  assert.equal(stored.role, 'produce');
  assert.equal('kind' in stored, false);
  assert.deepEqual(stored.deliverable, { type: 'files' });
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

// --- Stage 3: route amendments, step accept, and verifyRounds read through the marker ---

// A dispatcher whose listed steps fail (a process failure) and whose checks
// fail the requirement when `failRequirement` is set; everything else
// finishes at once, like controller().
function scripted({ fail = [], failRequirement = false } = {}) {
  const calls = [];
  const dispatch = async (options) => {
    const files = options.paths(1);
    calls.push(options.action.id);
    const record = {
      ordinal: 1, pool: 'pool-a', model: 'fixture', status: 'running',
      startedAt: new Date().toISOString(), taskFile: files.taskFile, outFile: files.outFile,
    };
    writeFileSync(files.taskFile, options.taskText);
    options.onAttempt?.('started', record);
    if (fail.includes(options.action.id)) {
      writeFileSync(files.outFile, `half of ${options.action.id}`);
      Object.assign(record, { status: 'failed', finishedAt: new Date().toISOString(), failureKind: 'process', why: 'worker exited 1' });
      options.onAttempt?.('finished', record, { ok: false, why: 'worker exited 1' });
      return { ok: false, status: 'failed', failureKind: 'process', attempts: [record], verdict: { ok: false, why: 'worker exited 1', outFile: files.outFile } };
    }
    if (options.action.evidenceFor?.length) {
      const candidatePath = options.taskText.match(/exact durable path: '([^']+)'/)?.[1];
      const status = failRequirement ? 'failed' : 'passed';
      writeFileSync(candidatePath, JSON.stringify({
        schemaVersion: 'bullswarm.workflow.evidence.v2',
        requirements: Object.fromEntries(options.action.evidenceFor.map((id) => [id, { status, evidence: [`inspected: ${status}`], concerns: [] }])),
      }));
      writeFileSync(files.outFile, 'evidence recorded');
      const verdict = { ok: true, structured: options.outputValidator('prose'), outFile: files.outFile };
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
  return { dispatch, calls, count: (id) => calls.filter((call) => call === id).length };
}

const acceptRequest = (state, accept, { source = 'step-accept' } = {}) => createRevisionRequest({
  ...normalizeRevisionInput(exportV2Plan(state)), summary: `accept ${accept[0].step}: "${accept[0].reason}"`, accept,
}, { source });

test('revise: an untouched export with a route changes nothing, adding a route amends, and a step-rerun source is recorded', async (t) => {
  const f = fixture(t);
  const routed = work('a', { route: { pools: { avoid: ['pool-b', 'pool-a'] } } });
  const done = await start(f, 'wf-route1-abcdef', [routed, work('b', { dependsOn: ['a'] })], controller());
  assert.equal(done.result.status, 'completed');
  const document = exportV2Plan(done.state);
  assert.deepEqual(document.program.actions[0].route, { pools: { avoid: ['pool-a', 'pool-b'] } }, 'normalised: sorted');
  const unchanged = planV2Revision(done.state, normalizeRevisionInput(document));
  assert.equal(unchanged.ok, false);
  assert.match(unchanged.issues[0], /changes nothing/);

  const edited = structuredClone(document);
  edited.program.actions.find((action) => action.id === 'b').route = { providers: { avoid: ['grok'] } };
  const amended = planV2Revision(done.state, normalizeRevisionInput(edited));
  assert.equal(amended.ok, true, JSON.stringify(amended.issues));
  assert.deepEqual(amended.changes, { added: [], amended: ['b'], restored: [], removed: [], rerun: [], invalidated: [] }, 'no accepted key when nothing is accepted');

  // What step rerun --avoid builds: route.pools.avoid grows, the step reruns, source step-rerun.
  const rerunDoc = structuredClone(document);
  rerunDoc.program.actions.find((action) => action.id === 'a').route.pools.avoid.push('pool-c');
  const request = createRevisionRequest(normalizeRevisionInput(rerunDoc, { rerun: ['a'], summary: 'step rerun a avoiding pool-c (last attempt: process on pool-a)' }), { source: 'step-rerun' });
  const revised = await reviseV2Program({ bullswarmDir: f.bullswarmDir, runId: 'wf-route1-abcdef', request, waitMs: 0 });
  assert.equal(revised.status, 'applied');
  const record = revised.state.revisions.at(-1);
  assert.deepEqual([record.source, record.changes.amended, record.changes.invalidated], ['step-rerun', ['a'], ['b']]);
  assert.deepEqual(revised.state.program.actions[0].route, { pools: { avoid: ['pool-a', 'pool-b', 'pool-c'] } });
  validateV2DurableState(revised.state);
});

test('step accept: an accept-only revision is a change; the failed step succeeds by choice and its blocked dependents run', async (t) => {
  const f = fixture(t);
  const runId = 'wf-accpt1-abcdef';
  const ctl = scripted({ fail: ['a'] });
  const done = await start(f, runId, [work('a', { produces: [] }), work('b', { dependsOn: ['a'] }), work('c')], ctl);
  assert.equal(statusOf(done.state, 'a'), 'failed');
  assert.notEqual(statusOf(done.state, 'b'), 'succeeded');

  const request = acceptRequest(done.state, [{ step: 'a', reason: 'the half file is enough', requirements: null }]);
  assert.deepEqual(request.accept, [{ step: 'a', reason: 'the half file is enough', requirements: null }]);
  const planned = planV2Revision(done.state, request);
  assert.equal(planned.ok, true, JSON.stringify(planned.issues));
  assert.deepEqual(planned.changes, { added: [], amended: [], restored: [], removed: [], rerun: [], invalidated: ['b'], accepted: ['a'] });

  const revised = await reviseV2Program({ bullswarmDir: f.bullswarmDir, runId, request, waitMs: 0 });
  assert.equal(revised.status, 'applied');
  const a = revised.state.actions.find((action) => action.id === 'a');
  assert.equal(a.status, 'succeeded');
  assert.equal(a.lastFailure, null);
  assert.ok(a.outputFile && existsSync(a.outputFile), 'the accepted attempt\'s output');
  assert.deepEqual(a.artifactIds, []);
  assert.deepEqual({ ...a.acceptance, at: 'x' }, {
    evidence: 'choice', reason: 'the half file is enough', attemptId: 'a-1', failureKind: 'process', at: 'x', revision: revised.state.program.revision,
  });
  assert.equal(statusOf(revised.state, 'b'), 'pending');
  assert.deepEqual(revised.state.revisions.at(-1).changes.accepted, ['a']);
  assert.equal(revised.state.revisions.at(-1).source, 'step-accept');
  validateV2DurableState(revised.state);

  const resumed = await resume(f, runId, ctl);
  assert.equal(statusOf(resumed.state, 'b'), 'succeeded', 'the dependent ran');
  assert.equal(ctl.count('a'), 1, 'an accepted step never runs again on its own');
  assert.equal(resumed.state.actions.find((action) => action.id === 'a').acceptance.reason, 'the half file is enough');

  // Rerunning it clears the acceptance (D23).
  const rerun = planV2Revision(resumed.state, normalizeRevisionInput(exportV2Plan(resumed.state), { rerun: ['a'] }));
  assert.equal(rerun.ok, true, JSON.stringify(rerun.issues));
  const again = await reviseV2Program({ bullswarmDir: f.bullswarmDir, runId, request: createRevisionRequest(normalizeRevisionInput(exportV2Plan(resumed.state), { rerun: ['a'] }), { source: 'step-rerun' }), waitMs: 0 });
  const cleared = again.state.actions.find((action) => action.id === 'a');
  assert.equal(cleared.status, 'pending');
  assert.equal(cleared.acceptance, undefined);
  assert.equal(again.state.actions.find((action) => action.id === 'b').acceptance, undefined);
  validateV2DurableState(again.state);
});

test('step accept: the §2.8 refusals', async (t) => {
  const f = fixture(t);
  const done = await start(f, 'wf-accpt2-abcdef', [work('a'), work('b', { dependsOn: ['a'] }), work('c', { dependsOn: ['b'] }), work('ok')], scripted({ fail: ['a'] }));
  assert.deepEqual(done.state.actions.map((action) => action.status), ['failed', 'blocked', 'blocked', 'succeeded']);
  const token = done.state.shortId;
  const checked = await start(fixture(t), 'wf-accpt4-abcdef', [work('a'), check('check', ['a'])], scripted());
  const refused = (entry, pattern, state = done.state) => {
    const planned = planV2Revision(state, acceptRequest(state, [{ requirements: null, ...entry }]));
    assert.equal(planned.ok, false, `expected a refusal for ${JSON.stringify(entry)}`);
    assert.match(planned.issues.join('\n'), pattern);
  };
  refused({ step: 'a', reason: '' }, /^--reason is required: say why you accept it \(it is recorded as evidence "choice"\)$/);
  refused({ step: 'a', reason: 'two\nlines' }, /^--reason must be one line of at most 500 characters$/);
  refused({ step: 'a', reason: 'x'.repeat(501) }, /^--reason must be one line of at most 500 characters$/);
  refused({ step: 'ok', reason: 'fine' }, /^step ok succeeded and no requirement it checks is failing; nothing to accept$/);
  refused({ step: 'check', reason: 'fine' }, /^step check succeeded and no requirement it checks is failing; nothing to accept$/, checked.state);
  refused({ step: 'b', reason: 'fine' }, /^step b is blocked by a; accept or rerun a first$/);
  refused({ step: 'c', reason: 'fine' }, /^step c is blocked by a; accept or rerun a first$/);
  refused({ step: 'ghost', reason: 'fine' }, new RegExp(`^run ${token} has no step "ghost"$`));
  refused({ step: 'a', reason: 'fine', requirements: ['deliver'] }, /^step a does not check deliver$/);
  refused({ step: 'check', reason: 'fine', requirements: ['deliver'] }, /^requirement deliver is not failing \(passed\); nothing to accept$/, checked.state);
  refused({ step: 'check', reason: 'fine', requirements: ['other'] }, /^step check does not check other$/, checked.state);

  const running = structuredClone(done.state);
  running.actions.find((action) => action.id === 'ok').status = 'waiting';
  refused({ step: 'ok', reason: 'fine' }, /^step ok is still running; wait for it to finish or restart it$/, running);
  const pending = structuredClone(done.state);
  Object.assign(pending.actions.find((action) => action.id === 'ok'), { status: 'pending' });
  refused({ step: 'ok', reason: 'fine' }, /^step ok has not run yet; nothing to accept$/, pending);
  const interrupted = structuredClone(done.state);
  interrupted.actions.find((action) => action.id === 'a').status = 'interrupted';
  refused({ step: 'a', reason: 'fine' }, new RegExp(`^step a did not finish \\(interrupted\\); run it again with bullswarm workflow resume ${token} or bullswarm workflow step rerun ${token} a$`), interrupted);
  const isolated = structuredClone(done.state);
  isolated.config.settings.workspaceMode = 'isolated';
  isolated.attempts.find((attempt) => attempt.actionId === 'a').cwd = '/tmp/acme-private-a';
  refused({ step: 'a', reason: 'fine' }, new RegExp(`^run ${token} is isolated: a's work is in a retained workspace that was never merged back \\(/tmp/acme-private-a\\); merge it yourself, then accept$`), isolated);
  // A revision that also changes the step it accepts.
  const both = acceptRequest(done.state, [{ step: 'a', reason: 'fine', requirements: null }]);
  both.program.actions.find((action) => action.id === 'a').prompt = 'Write a.txt differently.';
  assert.match(planV2Revision(done.state, both).issues.join('\n'), /^step a is changed by this revision; accept it on its own$/);
  // A file cannot carry accept: only the verb builds it.
  assert.throws(() => normalizeRevisionInput({ ...exportV2Plan(done.state), accept: [{ step: 'a', reason: 'x' }] }),
    (error) => error instanceof V2RevisionError && error.issues.includes('revision.accept is not allowed'));
});

test('step accept: a check\'s failing requirement is accepted by choice, never verified, and rerunning the check clears it', async (t) => {
  const f = fixture(t);
  const runId = 'wf-accpt3-abcdef';
  const done = await start(f, runId, [work('a'), check('check', ['a'])], scripted({ failRequirement: true }));
  assert.equal(done.state.ledger.requirements.deliver.status, 'failed');
  const request = acceptRequest(done.state, [{ step: 'check', reason: 'known flake', requirements: null }]);
  const planned = planV2Revision(done.state, request);
  assert.equal(planned.ok, true, JSON.stringify(planned.issues));
  assert.deepEqual(planned.changes.accepted, ['check']);
  assert.deepEqual(planned.changes.invalidated, [], 'no dependents change');
  const revised = await reviseV2Program({ bullswarmDir: f.bullswarmDir, runId, request, waitMs: 0 });
  const runtime = revised.state.actions.find((action) => action.id === 'check');
  assert.equal(runtime.status, 'succeeded');
  assert.deepEqual({ ...runtime.acceptance, at: 'x' }, {
    evidence: 'choice', reason: 'known flake', attemptId: 'check-1', failureKind: null, at: 'x', revision: revised.state.program.revision,
    requirements: [{ id: 'deliver', workRevision: revised.state.ledger.requirements.deliver.workRevision }],
  });
  assert.equal(revised.state.ledger.requirements.deliver.status, 'failed', 'a choice is not proof');
  validateV2DurableState(revised.state);
  // Accepting it again: nothing is failing any more.
  const twice = planV2Revision(revised.state, acceptRequest(revised.state, [{ step: 'check', reason: 'again', requirements: ['deliver'] }]));
  assert.match(twice.issues.join('\n'), /^requirement deliver is not failing \(accepted\); nothing to accept$/);
  // Rerunning the check clears it.
  const rerun = planV2Revision(revised.state, normalizeRevisionInput(exportV2Plan(revised.state), { rerun: ['check'] }));
  assert.equal(rerun.ok, true, JSON.stringify(rerun.issues));
  const copy = structuredClone(revised.state);
  const { applyV2Revision } = await import('../src/workflow/v2-revision.js');
  applyV2Revision(copy, rerun, { request: { id: 'rev-test-abcdef', source: 'cli' }, at: new Date().toISOString() });
  assert.equal(copy.actions.find((action) => action.id === 'check').acceptance, undefined);
});

test('revise: defaults.verifyRounds is read through the run\'s marker (fix cycles with failureRule, total rounds without)', async (t) => {
  const f = fixture(t);
  // Launched as a stage-2 run, so the loop starts with the saved-run default.
  const done = await start(f, 'wf-vrmark-abcdef', [work('a'), check('check', ['a'])], controller(), { runFeatures: { deliverableGate: 1, proofLabels: 1 } });
  assert.equal(done.result.status, 'completed');
  assert.equal(done.state.verifyLoop.max, 3, 'this kernel started the loop with the saved-run default');
  const withRounds = (value) => {
    const document = exportV2Plan(done.state);
    document.program.defaults = { verifyRounds: value };
    return normalizeRevisionInput(document);
  };
  const marked = { features: { deliverableGate: true, proofLabels: true, failureRule: true, reviewPlacement: 'caller' } };
  // As total rounds, 3 is the stored max: nothing changes. As fix cycles, 3 is four rounds.
  assert.match(planV2Revision(done.state, withRounds(3)).issues.join(' '), /changes nothing/);
  assert.equal(planV2Revision(done.state, withRounds(3), marked).ok, true);
  // As fix cycles, 2 is exactly three rounds: nothing changes. As total rounds, 2 lowers the budget.
  assert.match(planV2Revision(done.state, withRounds(2), marked).issues.join(' '), /changes nothing/);
  assert.equal(planV2Revision(done.state, withRounds(2)).ok, true);
  assert.equal(planV2Revision(done.state, withRounds(2), { features: { failureRule: false } }).ok, true, 'failureRule false reads rounds');
  // 0 is valid only as fix cycles (review only, one round); a saved run clamps it to 1.
  assert.equal(planV2Revision(done.state, withRounds(0), marked).ok, true);
  assert.equal(planV2Revision(done.state, withRounds(0)).ok, true);
});
