// `bullswarm workflow step accept` (stage 3 §2.8, D22, D23, D34): a CLI-built
// plan revision that records a failed step, or a check's failing
// requirements, as the caller's choice. The runs are real program runs driven
// by the real kernel; only the worker dispatch is scripted.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { acceptV2Step, rerunV2Step } from '../src/workflow/cli.js';
import { createV2GoalDocument } from '../src/workflow/v2-state.js';
import { runV2AutonomousWorkflow } from '../src/workflow/v2-runtime.js';
import { callerDecision } from '../src/workflow/verify-rounds.js';
import { formatV2ProofLine, stepProof, summarizeV2Result } from '../src/workflow/v2-outcome.js';
import { readEvents } from '../src/workflow/events.js';
import { notableWatchEvents, renderWatchEvent, watchTrouble } from '../src/workflow/watch-cli.js';

const BIN = resolve(new URL('..', import.meta.url).pathname, 'bin', 'bullswarm.js');
const LANES = ['analyze', 'build', 'chore'];
const POOLS = ['pool-a', 'pool-b'].map((name) => ({ name, enabled: true, lanes: LANES, connector: { name, lanes: LANES } }));
const REASON = 'the failing check is a known flaky upstream test';

const work = (id, options = {}) => ({
  id, purpose: `Deliver ${id}`, dependsOn: [], affects: ['deliver'], ownedFiles: [`${id}.txt`],
  prompt: `Write ${id}.txt.`, lane: 'build', effort: 'low', evidenceFor: [], inputs: [], produces: [], ...options,
});
const check = (id, dependsOn, evidenceFor = ['deliver']) => ({
  id, purpose: `Check ${id}`, dependsOn, affects: [], ownedFiles: [], prompt: 'Inspect the delivered files.',
  lane: 'analyze', effort: 'low', evidenceFor, inputs: [], produces: [],
});
const initial = (actions, defaults = null) => ({
  schemaVersion: 'bullswarm.workflow.planner-response.v2', kind: 'program', summary: 'Initial plan.',
  program: { schemaVersion: 'bullswarm.workflow.program.v2', ...(defaults ? { defaults } : {}), actions },
});

function fixture(t, requirements) {
  const root = mkdtempSync(join(tmpdir(), 'bullswarm-accept-'));
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

// Work steps fail as `failed-evidence` the times the script says; a check
// step judges its requirements with the verdict `judge` gives (default passed).
function scripted(script = {}, judge = () => 'passed') {
  const calls = [];
  const dispatch = async (options) => {
    const id = options.action.id;
    calls.push({ actionId: id, taskText: options.taskText });
    const files = options.paths(1);
    const record = {
      ordinal: 1, pool: 'pool-a', model: 'model-a', status: 'running',
      startedAt: new Date().toISOString(), taskFile: files.taskFile, outFile: files.outFile,
    };
    writeFileSync(files.taskFile, options.taskText);
    options.onAttempt?.('started', record);
    if (options.action.evidenceFor?.length) {
      const candidatePath = options.taskText.match(/exact durable path: '([^']+)'/)?.[1];
      writeFileSync(candidatePath, JSON.stringify({
        schemaVersion: 'bullswarm.workflow.evidence.v2',
        requirements: Object.fromEntries(options.action.evidenceFor.map((requirement) => {
          const status = judge(id, requirement);
          return [requirement, { status, evidence: [`judged ${requirement} ${status}`], concerns: status === 'passed' ? [] : [`${requirement} is not done`] }];
        })),
      }));
      writeFileSync(files.outFile, 'evidence recorded');
      const verdict = { ok: true, structured: options.outputValidator('prose'), outFile: files.outFile };
      Object.assign(record, { status: 'succeeded', finishedAt: new Date().toISOString() });
      options.onAttempt?.('finished', record, verdict);
      return { ok: true, status: 'succeeded', attempts: [record], verdict };
    }
    if ((script[id] ?? []).shift() === 'fail') {
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
  return { dispatch, calls, count: (id) => calls.filter((call) => call.actionId === id).length };
}

const runDirOf = (f, runId) => join(f.bullswarmDir, 'workflows', runId);
const readState = (f, runId) => JSON.parse(readFileSync(join(runDirOf(f, runId), 'state.json'), 'utf8'));
const statusOf = (state, id) => state.actions.find((action) => action.id === id)?.status;
const runtimeOf = (state, id) => state.actions.find((action) => action.id === id);

function start(f, runId, response, ctl) {
  return runV2AutonomousWorkflow({
    bullswarmDir: f.bullswarmDir, goalDocument: f.goalDocument, pools: [], runId,
    initialPlannerResponse: response,
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

// `build` failed its evidence; `docs` (depends on build) is blocked; `side`
// succeeded; `check-side` passed its requirement.
async function failedRun(t) {
  const f = fixture(t, [{ id: 'deliver', text: 'Deliver the requested files.' }, { id: 'side-ok', text: 'The side file exists.' }]);
  const ctl = scripted({ build: ['fail'] });
  const runId = 'wf-accept-aaaaaa';
  await start(f, runId, initial([
    work('build'), work('docs', { dependsOn: ['build'] }), work('side', { affects: ['side-ok'] }), check('check-side', ['side'], ['side-ok']),
  ]), ctl);
  const state = readState(f, runId);
  assert.deepEqual(['build', 'docs', 'side', 'check-side'].map((id) => statusOf(state, id)), ['failed', 'blocked', 'succeeded', 'succeeded']);
  return { f, ctl, runId, token: state.shortId };
}

test('accept refuses with the §2.8 texts and exit codes, and writes nothing', async (t) => {
  const { f, runId, token } = await failedRun(t);
  const call = (options) => acceptV2Step({ bullswarmDir: f.bullswarmDir, token, reason: REASON, waitMs: 0, ...options });
  const cases = [
    [{ stepId: 'build', reason: undefined }, 2, '--reason is required: say why you accept it (it is recorded as evidence "choice")'],
    [{ stepId: 'build', reason: '   ' }, 2, '--reason is required: say why you accept it (it is recorded as evidence "choice")'],
    [{ stepId: 'build', reason: 'two\nlines' }, 2, '--reason must be one line of at most 500 characters'],
    [{ stepId: 'build', reason: 'x'.repeat(501) }, 2, '--reason must be one line of at most 500 characters'],
    [{ token: 'nosuch', stepId: 'build' }, 1, 'no run found for "nosuch"'],
    [{ stepId: 'nope' }, 1, `run ${token} has no step "nope"`],
    [{ stepId: 'side' }, 1, 'step side succeeded and no requirement it checks is failing; nothing to accept'],
    [{ stepId: 'check-side' }, 1, 'step check-side succeeded and no requirement it checks is failing; nothing to accept'],
    [{ stepId: 'docs' }, 1, 'step docs is blocked by build; accept or rerun build first'],
    [{ stepId: 'check-side', requirements: ['deliver'] }, 2, 'step check-side does not check deliver'],
    [{ stepId: 'check-side', requirements: ['side-ok'] }, 2, 'requirement side-ok is not failing (passed); nothing to accept'],
  ];
  for (const [options, code, why] of cases) {
    const result = await call(options);
    assert.deepEqual([result.code, result.status, result.why], [code, 'error', why], JSON.stringify(options).slice(0, 80));
  }
  const path = join(runDirOf(f, runId), 'state.json');
  const saved = readFileSync(path, 'utf8');
  for (const [status, why] of [
    ['running', 'step side is still running; wait for it to finish or restart it'],
    ['waiting', 'step side is still running; wait for it to finish or restart it'],
    ['cancelled', `step side did not finish (cancelled); run it again with bullswarm workflow resume ${token} or bullswarm workflow step rerun ${token} side`],
    ['interrupted', `step side did not finish (interrupted); run it again with bullswarm workflow resume ${token} or bullswarm workflow step rerun ${token} side`],
    ['pending', 'step side has not run yet; nothing to accept'],
  ]) {
    const state = JSON.parse(saved);
    Object.assign(runtimeOf(state, 'side'), { status, finishedAt: null });
    writeFileSync(path, JSON.stringify(state));
    const result = await call({ stepId: 'side' });
    assert.deepEqual([result.code, result.why], [1, why], status);
  }
  // An isolated run's writer was never merged back.
  const isolated = JSON.parse(saved);
  isolated.config.settings.workspaceMode = 'isolated';
  writeFileSync(path, JSON.stringify(isolated));
  const refused = await call({ stepId: 'build' });
  assert.equal(refused.code, 1);
  assert.match(refused.why, new RegExp(`^run ${token} is isolated: build's work is in a retained workspace that was never merged back \\(.+\\); merge it yourself, then accept$`));
  writeFileSync(path, saved);
  assert.equal(readState(f, runId).revisions?.length ?? 0, 0, 'a refusal writes no revision');
});

test('accepting a failed step makes it succeeded by choice, its dependents run, and a rerun undoes it', async (t) => {
  const { f, ctl, runId, token } = await failedRun(t);
  const result = await acceptV2Step({ bullswarmDir: f.bullswarmDir, token, stepId: 'build', reason: REASON, waitMs: 0, relaunch: resumer(f, ctl) });
  assert.equal(result.code, 0, JSON.stringify(result));
  assert.deepEqual([result.status, result.kind, result.appliedBy, result.attemptId, result.failureKind], ['applied', 'step', 'offline', 'build-1', 'failed-evidence']);
  assert.deepEqual(result.changes.accepted, ['build']);
  assert.deepEqual(result.dependents, ['docs']);

  const state = readState(f, runId);
  const build = runtimeOf(state, 'build');
  assert.equal(build.status, 'succeeded');
  assert.equal(build.lastFailure, null);
  assert.equal(build.outputFile, join(runDirOf(f, runId), 'out-build-attempt-1.md'));
  assert.deepEqual({ ...build.acceptance, at: undefined }, {
    evidence: 'choice', reason: REASON, attemptId: 'build-1', failureKind: 'failed-evidence', at: undefined, revision: 2,
  });
  const record = state.revisions.at(-1);
  assert.deepEqual([record.source, record.summary, record.changes.accepted], ['step-accept', `accept build: "${REASON}"`, ['build']]);
  // The dependent ran after the relaunch; the accepted step itself did not.
  assert.equal(statusOf(state, 'docs'), 'succeeded');
  assert.equal(ctl.count('build'), 1);
  assert.equal(ctl.count('docs'), 1);
  // A choice is never proof.
  assert.deepEqual(stepProof(state, state.program.actions.find((action) => action.id === 'build')), { by: ['choice'], reviewPending: false });
  assert.deepEqual(stepProof(state, state.program.actions.find((action) => action.id === 'build'), { features: {} }), { by: ['choice'], reviewPending: false });
  assert.equal(formatV2ProofLine({ proof: { proven: 0, byType: { choice: 1 }, accepted: 1, acceptedSteps: ['build'], unproven: 0 } }), 'proof: 1 accepted by choice: build');
  const resultFile = JSON.parse(readFileSync(join(runDirOf(f, runId), 'result.json'), 'utf8'));
  assert.equal(resultFile.verified, false, 'deliver was never judged: accepting a step verifies nothing');
  assert.equal(resultFile.actions.find((action) => action.id === 'build').acceptance?.evidence, 'choice');

  // Rerunning the step undoes the accept (D23).
  const undo = await rerunV2Step({ bullswarmDir: f.bullswarmDir, token, stepId: 'build', pools: POOLS, waitMs: 0, relaunch: resumer(f, ctl) });
  assert.equal(undo.status, 'applied', JSON.stringify(undo));
  assert.equal(undo.handoffFrom, 'build-1', 'the accepted attempt had failed: its handoff goes along');
  const after = readState(f, runId);
  assert.equal('acceptance' in runtimeOf(after, 'build'), false);
  assert.equal(statusOf(after, 'build'), 'succeeded');
  assert.equal(ctl.count('build'), 2);
});

test('accepting a review\'s failing requirement records it on the check and on verify-round-2, and it lapses when the work moves', async (t) => {
  const f = fixture(t, [{ id: 'deliver', text: 'Deliver the requested files.' }]);
  const ctl = scripted({}, () => 'failed');
  const runId = 'wf-acceptr-bbbbbb';
  await start(f, runId, initial([work('build'), check('check-build', ['build'])], { verifyRounds: 2 }), ctl);
  let state = readState(f, runId);
  const token = state.shortId;
  assert.equal(state.ledger.requirements.deliver.status, 'failed');
  assert.ok(callerDecision(state)?.requirements.some((entry) => entry.id === 'deliver'), 'the loop hands deliver to the caller');
  const verifySteps = state.program.actions.filter((action) => action.evidenceFor.length).map((action) => action.id);
  assert.ok(verifySteps.includes('verify-round-2'), verifySteps.join(', '));

  for (const stepId of ['check-build', 'verify-round-2']) {
    const result = await acceptV2Step({ bullswarmDir: f.bullswarmDir, token, stepId, reason: REASON, waitMs: 0, relaunch: async () => null });
    assert.equal(result.code, 0, JSON.stringify(result));
    assert.deepEqual([result.status, result.kind, result.requirements, result.changes.accepted], ['applied', 'requirements', ['deliver'], [stepId]]);
    state = readState(f, runId);
    const runtime = runtimeOf(state, stepId);
    assert.equal(runtime.status, 'succeeded');
    assert.deepEqual(runtime.acceptance.requirements, [{ id: 'deliver', workRevision: state.ledger.requirements.deliver.workRevision }]);
    assert.equal(runtime.acceptance.failureKind, null);
    // No dependents change and verified never moves: a choice is not proof.
    assert.deepEqual(result.dependents, []);
    assert.equal(state.ledger.requirements.deliver.status, 'failed');
    assert.equal(stepProof(state, state.program.actions.find((action) => action.id === 'build'))?.by?.includes('choice') ?? false, false, 'a requirement acceptance labels no step');
    // Accepting it again on the same step has nothing left to accept.
    const again = await acceptV2Step({ bullswarmDir: f.bullswarmDir, token, stepId, reason: REASON, requirements: ['deliver'], waitMs: 0 });
    assert.deepEqual([again.code, again.why], [2, 'requirement deliver is not failing (accepted); nothing to accept']);
  }
  assert.equal(callerDecision(state), null, 'callerDecision omits an accepted requirement');
  // The acceptance lapses once the requirement's work revision moves.
  const moved = JSON.parse(JSON.stringify(state));
  moved.ledger.requirements.deliver.workRevision = 'work-9-99-build';
  assert.ok(callerDecision(moved)?.requirements.some((entry) => entry.id === 'deliver'));
});

test('what the caller sees after an accept: the watch line, the result row and requirement field, and the summary', async (t) => {
  const { f, ctl, runId, token } = await failedRun(t);
  const accepted = await acceptV2Step({ bullswarmDir: f.bullswarmDir, token, stepId: 'build', reason: REASON, waitMs: 0, relaunch: resumer(f, ctl) });
  assert.equal(accepted.status, 'applied', JSON.stringify(accepted));
  const runDir = runDirOf(f, runId);
  const state = readState(f, runId);

  // The watch: the kernel's step.accepted event reads as a choice, and is not trouble.
  const events = readEvents(runDir);
  const { notable } = notableWatchEvents({ events: events.filter((event) => event.type === 'step.accepted'), state });
  assert.deepEqual(notable.map((event) => renderWatchEvent(event)), [`✓ build accepted by choice · "${REASON}"`]);
  assert.equal(watchTrouble(notable[0], { program: true }), null);

  // The result the relaunch wrote: the action row, the reason line, and no verified claim.
  const result = JSON.parse(readFileSync(join(runDir, 'result.json'), 'utf8'));
  const row = result.actions.find((action) => action.id === 'build');
  assert.equal(row.status, 'succeeded');
  assert.deepEqual([row.acceptance.evidence, row.acceptance.reason, row.acceptance.attemptId, row.acceptance.failureKind], ['choice', REASON, 'build-1', 'failed-evidence']);
  assert.match(result.reason, / · 1 step accepted by choice$/);
  assert.equal(result.verified, false);

  // The summary: a choice counted apart from what is proven. (Its per-step
  // `accepted` row is fitted to the size budget; the summary tests pin it.)
  const summary = summarizeV2Result(result, state, { runDir });
  assert.equal(summary.proof.byType.choice, 1);
  assert.deepEqual([summary.proof.accepted, summary.proof.acceptedSteps], [1, ['build']]);
  assert.equal(summary.proof.proven, 1, 'only check-side is proven (by its review); build is a choice');
  assert.match(formatV2ProofLine(summary), /1 accepted by choice: build/);
});

test('an accepted requirement shows on the result\'s requirement and never verifies it', async (t) => {
  const f = fixture(t, [{ id: 'deliver', text: 'Deliver the requested files.' }]);
  const ctl = scripted({}, () => 'failed');
  const runId = 'wf-acceptq-cccccc';
  await start(f, runId, initial([work('build'), check('check-build', ['build'])], { verifyRounds: 0 }), ctl);
  const token = readState(f, runId).shortId;
  const accepted = await acceptV2Step({ bullswarmDir: f.bullswarmDir, token, stepId: 'check-build', reason: REASON, waitMs: 0, relaunch: resumer(f, ctl) });
  assert.equal(accepted.status, 'applied', JSON.stringify(accepted));
  const runDir = runDirOf(f, runId);
  const result = JSON.parse(readFileSync(join(runDir, 'result.json'), 'utf8'));
  const deliver = result.requirements.find((requirement) => requirement.id === 'deliver');
  assert.equal(deliver.status, 'failed');
  assert.deepEqual({ ...deliver.accepted, at: typeof deliver.accepted.at }, { step: 'check-build', reason: REASON, at: 'string' });
  assert.equal(result.verified, false, 'a choice is not proof');
  assert.equal(result.callerDecision, null, 'callerDecision omits the accepted requirement');
  const rendered = notableWatchEvents({ events: readEvents(runDir).filter((event) => event.type === 'step.accepted'), state: readState(f, runId) })
    .notable.map((event) => renderWatchEvent(event));
  assert.deepEqual(rendered, [`✓ deliver accepted by choice on check-build · "${REASON}"`]);
});

test('the CLI prints the accept, and --json carries its shape', async (t) => {
  const { f, runId, token } = await failedRun(t);
  // A paused run is revised directly and not relaunched, so the binary can run it.
  const path = join(runDirOf(f, runId), 'state.json');
  const state = readState(f, runId);
  state.lifecycle = { ...state.lifecycle, status: 'paused', finishedAt: null, resultFile: null };
  state.pause = { requestedAt: new Date().toISOString(), mode: 'drain', source: 'cli', pausedAt: new Date().toISOString() };
  writeFileSync(path, JSON.stringify(state));
  const env = { ...process.env, BULLSWARM_HOME: f.bullswarmDir, BULLSWARM_DISABLE_CLAUDE_PROFILES: '1' };
  const refused = spawnSync(process.execPath, [BIN, 'workflow', 'step', 'accept', token, 'docs', '--reason', REASON], { env, encoding: 'utf8' });
  assert.equal(refused.status, 1);
  assert.equal(refused.stderr.trim(), '✗ step docs is blocked by build; accept or rerun build first');
  const text = spawnSync(process.execPath, [BIN, 'workflow', 'step', 'accept', token, 'build', '--reason', REASON], { env, encoding: 'utf8' });
  assert.equal(text.status, 0, text.stderr);
  assert.deepEqual(text.stdout.trim().split('\n'), [
    `✓ build of ${token} accepted by your choice · "${REASON}" · revision 2`,
    '  evidence   choice (not proof; the run is verified only by its checks)',
    '  dependents docs run now',
    `  resume     bullswarm workflow resume ${token}`,
    `  undo       bullswarm workflow step rerun ${token} build`,
  ]);
  const json = spawnSync(process.execPath, [BIN, 'workflow', 'step', 'accept', token, 'build', '--reason', REASON, '--json'], { env, encoding: 'utf8' });
  assert.equal(json.status, 1, 'build is now succeeded with nothing failing');
  assert.equal(JSON.parse(json.stdout).why, 'step build succeeded and no requirement it checks is failing; nothing to accept');
});
