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
import { runV2AutonomousWorkflow } from '../src/workflow/v2-runtime.js';
import { pauseV2Run, reviseV2Program, unpauseV2Run } from '../src/workflow/run-control.js';
import {
  createRevisionRequest, exportV2Plan, normalizeRevisionInput, planV2Revision, queueRevisionRequest, V2RevisionError,
} from '../src/workflow/v2-revision.js';
import { peekSteering, queueSteering } from '../src/workflow/steering.js';
import { projectV2DependencyStages } from '../src/workflow/v2-presentation.js';
import { ACTION_KINDS, KIND_ROLES } from '../src/workflow/action-validator.js';
import { validateV2PlannerResponse } from '../src/workflow/v2-planner.js';
import { viewOnlyRunLine } from '../src/workflow/cli-run-lookup.js';

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

test('CLI: plan export and plan revise (removed in 0.38.0) and pause answer a v2 run as view-only', async (t) => {
  const f = fixture(t);
  const ctl = controller();
  const done = await start(f, 'wf-cli10a-abcdef', [work('a'), work('b', { dependsOn: ['a'] })], ctl);
  const token = done.shortId;
  const env = { ...process.env, BULLSWARM_HOME: f.bullswarmDir, BULLSWARM_NO_PACKAGED_PROVIDERS: '1' };
  const cli = (...args) => spawnSync(process.execPath, [BIN, ...args], { env, encoding: 'utf8', cwd: f.workspace });
  const out = join(f.root, 'plan.json');

  // 0.38.0 (D8): the removed verbs answer a run an earlier Bullswarm started
  // with the view-only sentence, and write nothing.
  const before = readFileSync(join(f.bullswarmDir, 'workflows', done.runId, 'state.json'), 'utf8');
  const exported = cli('workflow', 'plan', 'export', token, '--out', out, '--json');
  assert.equal(exported.status, 2, exported.stderr);
  assert.deepEqual(JSON.parse(exported.stdout), { viewOnly: true, verb: 'plan export', runId: done.runId, shortId: token, dir: join(f.bullswarmDir, 'workflows', done.runId), message: viewOnlyRunLine(token) });
  assert.equal(existsSync(out), false, 'plan export writes no file');
  const revised = cli('workflow', 'plan', 'revise', token, '--program', out, '--rerun', 'ghost');
  assert.deepEqual([revised.status, revised.stdout, revised.stderr], [2, '', `${viewOnlyRunLine(token)}\n`]);
  assert.equal(readFileSync(join(f.bullswarmDir, 'workflows', done.runId, 'state.json'), 'utf8'), before, 'the run is untouched');

  // 0.38.0 (D1): a v2 run is view-only, so pause refuses it before it reads its status.
  const pause = cli('workflow', 'pause', token);
  assert.deepEqual([pause.status, pause.stdout, pause.stderr], [2, '', `${viewOnlyRunLine(token)}\n`]);
  const help = cli('workflow', 'plan', 'revise', '--help');
  assert.equal(help.status, 0);
  assert.match(help.stdout, /Removed in 0\.38\.0\. plan revise exits 2 with one sentence/);
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
