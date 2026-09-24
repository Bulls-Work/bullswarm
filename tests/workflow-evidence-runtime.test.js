// The kernel side of stage-2 evidence (E5, E14, E16, E18, E22, E23, E31):
// runtime wiring through the real dispatch and the real runner, with a fake
// worker (watchOnce), temp git repos and made-up names only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { writeJsonAtomic } from '../src/lib/fsjson.js';
import { readEvents } from '../src/workflow/events.js';
import { createV2GoalDocument, createV2State } from '../src/workflow/v2-state.js';
import {
  acceptCallerPlannerResponse, handoffBlock, pauseV2Run, runV2AutonomousWorkflow,
} from '../src/workflow/v2-runtime.js';
import { dispatchV2Action } from '../src/workflow/v2-dispatch.js';
import { readRunFeatures } from '../src/workflow/run-features.js';
import { formatV2ProofLabel } from '../src/workflow/v2-outcome.js';
import { staleScore } from '../src/lib/stale.js';

const REQUIREMENT = { id: 'deliver', text: 'Deliver the requested files and validate them.' };

const connector = (name) => ({
  name, lanes: ['analyze', 'build', 'chore'], enabled: true, spawn: { cmd: ['fake'] },
  modelSelection: { flag: '--model' },
  strategyAssignments: Object.fromEntries(['low', 'medium', 'high'].map((tier) => [tier, { pool: name, model: 'gpt-5.6-luna' }])),
});

function gitRepo(workspace) {
  execFileSync('git', ['init', '-q', workspace]);
  writeFileSync(join(workspace, 'README.md'), 'acme\n');
  execFileSync('git', ['-C', workspace, 'add', '.']);
  execFileSync('git', ['-C', workspace, '-c', 'user.name=Acme Dev', '-c', 'user.email=dev@example.com', 'commit', '-qm', 'seed']);
}

function fixture(t, settings = {}) {
  const root = mkdtempSync(join(tmpdir(), 'bullswarm-evidence-runtime-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const workspace = join(root, 'repo');
  const bullswarmDir = join(root, 'home');
  mkdirSync(workspace, { recursive: true });
  mkdirSync(bullswarmDir, { recursive: true });
  gitRepo(workspace);
  const goalDocument = createV2GoalDocument({
    goal: 'Deliver the requested files', cwd: workspace, requirements: [REQUIREMENT],
    settings: { executionMode: 'program', workspaceMode: 'shared', scout: false, plannerMode: 'caller', concurrency: 1, ...settings },
  });
  return { root, workspace, bullswarmDir, goalDocument };
}

const step = (over = {}) => ({
  id: 'write', purpose: 'Deliver write', dependsOn: [], affects: ['deliver'], ownedFiles: ['write.txt'],
  prompt: 'Write write.txt.', lane: 'build', effort: 'low', evidenceFor: [], inputs: [], produces: [],
  ...over,
});

const program = (actions) => ({
  schemaVersion: 'bullswarm.workflow.planner-response.v2', kind: 'program', summary: 'Write and check.',
  program: { schemaVersion: 'bullswarm.workflow.program.v2', actions },
});

// The real dispatch with a fake worker. `worker` edits the workspace it is
// handed; `runStepEvidence` replaces the real runner only where a test needs
// to stage a moment (a kernel signal mid-check).
function realDispatch({ worker = null, runStepEvidence = null, seen = [] } = {}) {
  const core = { config: { depthLimit: 2 }, pools: {}, incumbents: {}, decisionLog: [] };
  return (options) => {
    seen.push(options);
    return dispatchV2Action({
      ...options,
      pools: [connector('codex')],
      dependencies: {
        watchOnce: async (_pool, task, targetDir, files) => {
          writeFileSync(files.taskFile, task);
          await worker?.({ targetDir, files, task, options });
          if (!existsSync(files.outFile)) writeFileSync(files.outFile, 'done\n');
          return { ok: true, why: 'ok', meta: { exitCode: 0, wallSec: 1 } };
        },
        loadState: () => structuredClone(core),
        saveState: (_dir, next) => Object.assign(core, structuredClone(next)),
        now: () => Date.now(),
        uuid: () => 'session-fixed',
        ...(runStepEvidence ? { runStepEvidence } : {}),
      },
    });
  };
}

function launch(f, { runId, actions, dispatch, dependencies = {} }) {
  return runV2AutonomousWorkflow({
    bullswarmDir: f.bullswarmDir, goalDocument: f.goalDocument, pools: [], runId, parentEnv: {},
    initialPlannerResponse: program(actions),
    dependencies: { refreshPools: async () => null, dispatchV2Action: dispatch, ...dependencies },
  });
}

const eventsOf = (runDir, type) => readEvents(runDir).filter((event) => event.type === type);

// Only the kernel's own SIGTERM listener, never the test runner's.
function kernelSignalFrom(before) {
  return () => {
    for (const listener of process.listeners('SIGTERM')) if (!before.has(listener)) listener('SIGTERM');
  };
}

test('handoffBlock renders the evidence lines only when the attempt ran its checks', () => {
  const facts = {
    pool: 'codex', model: 'gpt-5.6-luna',
    startedAt: '2026-09-24T10:00:00.000Z', finishedAt: '2026-09-24T10:01:00.000Z',
    failureKind: 'failed-evidence', why: 'node scripts/fail-once.mjs → exit 1: first run: marker missing',
    diffStatText: ' write.txt | 1 +', diffFile: '/tmp/acme-run/diff-write-attempt-1.txt', changedFiles: ['write.txt'],
    outputFile: '/tmp/acme-run/out-write-attempt-1.md', outputBytes: 5, streamFile: '/tmp/acme-run/stream-write-attempt-1.jsonl',
    lastEvents: [],
  };
  const plain = handoffBlock(facts);
  assert.equal(handoffBlock({ ...facts, evidenceResults: [] }), plain, 'an empty list changes nothing');
  assert.doesNotMatch(plain, /Evidence Bullswarm ran/);
  const tail = [...Array.from({ length: 12 }, (_, index) => `line ${index + 1}`), `long ${'x'.repeat(300)}`].join('\n');
  const block = handoffBlock({
    ...facts,
    evidenceResults: [
      { type: 'command', cmd: 'node scripts/fail-once.mjs', timeoutSec: 120, status: 'failed', exit: 1, durationMs: 400, tail, log: '/tmp/acme-run/evidence-write-attempt-1-1.log', why: 'exit 1', touched: ['junit.xml'], headMoved: true },
      { type: 'schema', file: 'out/events.json', schema: 'schemas/event.json', timeoutSec: 120, status: 'passed', exit: 0, durationMs: 1600, tail: '', log: '/tmp/acme-run/evidence-write-attempt-1-2.log', why: null },
      { type: 'schema', file: '$output', schema: 'schemas/report.json', timeoutSec: 120, status: 'failed', exit: 1, durationMs: 90, errorCount: 2, errors: ['$.claims[0] is missing required property "source"'], tail: '{"ok":false}', log: '/tmp/acme-run/evidence-write-attempt-1-3.log', why: 'not valid: 2 errors' },
      { type: 'command', cmd: 'npm test', timeoutSec: 600, status: 'not-run', exit: null, durationMs: 0, tail: '', why: 'stopped' },
      { type: 'command', cmd: 'npm run lint', timeoutSec: 600, status: 'not-run', exit: null, durationMs: 0, tail: '', why: 'not run: an earlier item changed the deliverable' },
    ],
  });
  const lines = block.split('\n');
  const start = lines.indexOf('- Evidence Bullswarm ran after that attempt:');
  assert.equal(lines[start - 1], '- Stream file: /tmp/acme-run/stream-write-attempt-1.jsonl');
  assert.deepEqual(lines.slice(start), [
    '- Evidence Bullswarm ran after that attempt:',
    '  - command `node scripts/fail-once.mjs`: failed · exit 1 · 0s',
    '    output: /tmp/acme-run/evidence-write-attempt-1-1.log',
    '    last lines:',
    ...Array.from({ length: 9 }, (_, index) => `      line ${index + 4}`),
    `      long ${'x'.repeat(194)}…`,
    '    also: touched junit.xml',
    '    also: HEAD moved while it ran (another step may have committed)',
    '  - schema out/events.json against schemas/event.json: passed · 2s',
    '  - schema your final response against schemas/report.json: failed · not valid: 2 errors · 0s',
    '    output: /tmp/acme-run/evidence-write-attempt-1-3.log',
    '    errors:',
    '      $.claims[0] is missing required property "source"',
    '  - command `npm test`: not run · stopped',
    '  - command `npm run lint`: not run · an earlier item changed the deliverable',
    '- Fix the work so every evidence item passes. Do not change what the checks test to make them pass.',
    '- Those edits are unverified. You decide whether to keep, fix or revert them, and you must report which.',
  ]);
  assert.equal(block.startsWith(plain.split('\n- Those edits')[0]), true);
});

test('a passing check: results on the attempt, the receipt and the result; events, outcome and proof', async (t) => {
  const f = fixture(t);
  const runId = 'wf-evpass-abcdef';
  const run = await launch(f, {
    runId,
    actions: [
      step({ evidence: [{ type: 'command', cmd: 'test -s write.txt' }] }),
      step({ id: 'notes', purpose: 'Write notes', ownedFiles: ['notes.txt'], prompt: 'Write notes.txt.' }),
    ],
    dispatch: realDispatch({
      worker: ({ targetDir, options }) => writeFileSync(join(targetDir, `${options.action.id === 'write' ? 'write' : 'notes'}.txt`), 'ok\n'),
    }),
  });
  assert.equal(run.result.status, 'completed');
  const attempt = run.state.attempts.find((entry) => entry.actionId === 'write');
  assert.equal(attempt.status, 'succeeded');
  assert.deepEqual(attempt.evidenceResults.map((item) => [item.type, item.cmd, item.status, item.exit]), [['command', 'test -s write.txt', 'passed', 0]]);
  assert.equal(Object.hasOwn(run.state.attempts.find((entry) => entry.actionId === 'notes'), 'evidenceResults'), false);

  const runDir = run.runDir;
  assert.deepEqual(readRunFeatures(runDir), { deliverableGate: 1, proofLabels: 1 });
  const receipt = JSON.parse(readFileSync(join(runDir, 'completion-write.json'), 'utf8'));
  assert.deepEqual(receipt.verdict.evidenceResults, attempt.evidenceResults, 'E31: the receipt carries the results');

  const items = eventsOf(runDir, 'attempt.evidence_item').map((event) => event.payload);
  assert.deepEqual(items.map((item) => item.stage), ['started', 'finished'], 'no running events');
  assert.deepEqual(items[0], { actionId: 'write', attemptId: 'write-1', stage: 'started', index: 1, of: 1, type: 'command', label: 'test -s write.txt' });
  assert.equal(items[1].status, 'passed');
  assert.equal(items[1].why, null);
  assert.equal(Number.isInteger(items[1].durationMs), true);

  const finished = eventsOf(runDir, 'attempt.finished').map((event) => event.payload);
  assert.deepEqual(finished.find((payload) => payload.actionId === 'write').evidenceOutcome, { passed: 1, failed: 0, notRun: 0, why: null });
  assert.equal(Object.hasOwn(finished.find((payload) => payload.actionId === 'notes'), 'evidenceOutcome'), false);

  const actionFinished = Object.fromEntries(eventsOf(runDir, 'action.finished').map((event) => [event.payload.actionId, event.payload]));
  assert.deepEqual(actionFinished.write.proof, { by: ['command'], reviewPending: false });
  // A new run carries the marker, so a step without evidence is labelled too.
  assert.deepEqual(actionFinished.notes.proof, { by: [], reviewPending: false });

  const result = JSON.parse(readFileSync(join(runDir, 'result.json'), 'utf8'));
  const rows = Object.fromEntries(result.actions.map((row) => [row.id, row]));
  assert.deepEqual(rows.write.evidenceResults, attempt.evidenceResults);
  assert.equal(Object.hasOwn(rows.notes, 'evidenceResults'), false);
});

test('a failing check retries once on the same pool with the check output, then fails the step', async (t) => {
  const f = fixture(t);
  const run = await launch(f, {
    runId: 'wf-evfail-abcdef',
    actions: [step({ evidence: [{ type: 'command', cmd: 'echo "acme check: write.txt says nope" && grep -q ready write.txt' }] })],
    dispatch: realDispatch({ worker: ({ targetDir }) => writeFileSync(join(targetDir, 'write.txt'), 'nope\n') }),
  });
  const [first, second] = run.state.attempts;
  assert.equal(run.state.attempts.length, 2);
  assert.equal(first.status, 'interrupted');
  assert.equal(first.failureKind, 'failed-evidence');
  assert.equal(second.status, 'failed');
  assert.equal(second.failureKind, 'failed-evidence');
  assert.equal(second.pool, first.pool);
  assert.match(second.routeWhy, /^retry on the same pool after failed evidence/);
  const task = readFileSync(second.taskFile, 'utf8');
  assert.match(task, /## Prior attempt on this step/);
  assert.match(task, /- Failure: failed-evidence — echo "acme check: write\.txt says nope" && grep -q ready write\.txt → exit 1: acme check: write\.txt says nope/);
  assert.match(task, /- Evidence Bullswarm ran after that attempt:\n {2}- command `echo "acme check: write\.txt says nope" && grep -q ready write\.txt`: failed · exit 1 · \d+s\n {4}output: .*evidence-write-attempt-1-1\.log\n {4}last lines:\n {6}acme check: write\.txt says nope/);
  const action = run.state.actions[0];
  assert.equal(action.status, 'failed');
  assert.equal(action.lastFailure.kind, 'failed-evidence');
  const outcomes = eventsOf(run.runDir, 'attempt.finished').map((event) => [event.payload.willRetry, event.payload.evidenceOutcome]);
  assert.deepEqual(outcomes.map(([willRetry, outcome]) => [willRetry, outcome.failed, outcome.passed]), [[true, 1, 0], [false, 1, 0]]);
  assert.equal(outcomes[1][1].why, second.why);
  const finished = eventsOf(run.runDir, 'action.finished').at(-1).payload;
  assert.equal(finished.failureKind, 'failed-evidence');
  assert.equal(Object.hasOwn(finished, 'proof'), false);
});

async function resumeWithAttempts(t, { runId, attempts, actionState, marker = null, evidence = [{ type: 'command', cmd: 'true' }] }) {
  const f = fixture(t);
  const runDir = join(f.bullswarmDir, 'workflows', runId);
  mkdirSync(runDir, { recursive: true });
  let state = createV2State(f.goalDocument, { runId, shortId: runId.slice(3, 9) });
  state = acceptCallerPlannerResponse(state, program([step({ ...(evidence ? { evidence } : {}) })]), { boundary: 'initial', runDir }).state;
  Object.assign(state.actions[0], { status: 'interrupted', attempts: attempts.length, startedAt: '2026-09-24T10:00:00.000Z', ...actionState });
  state.attempts = attempts;
  state.lifecycle.status = 'interrupted';
  writeFileSync(join(runDir, 'goal.json'), JSON.stringify(f.goalDocument));
  writeFileSync(join(runDir, 'state.json'), JSON.stringify(state));
  if (marker) writeFileSync(join(runDir, 'features.json'), marker);
  return { f, runDir };
}

const priorAttempt = (over = {}) => ({
  id: 'write-1', actionId: 'write', ordinal: 1, status: 'interrupted', pool: 'codex', model: 'gpt-5.6-luna',
  startedAt: '2026-09-24T10:00:00.000Z', finishedAt: '2026-09-24T10:01:00.000Z',
  failureKind: 'failed-evidence', why: 'true → exit 1', changedFileCount: 1, changedFiles: ['write.txt'],
  ...over,
});

test('evidenceRetryAvailable follows supersededAttempts: a kernel resume keeps the spent retry, a rerun grants a fresh one', async (t) => {
  for (const [label, actionState, expected] of [['kernel resume', {}, false], ['rerun', { supersededAttempts: 1 }, true]]) {
    const runId = expected ? 'wf-evrrun-abcdef' : 'wf-evkres-abcdef';
    const { f } = await resumeWithAttempts(t, { runId, attempts: [priorAttempt()], actionState });
    const seen = [];
    await runV2AutonomousWorkflow({
      bullswarmDir: f.bullswarmDir, resumeRunId: runId, pools: [], parentEnv: {},
      dependencies: {
        refreshPools: async () => null,
        dispatchV2Action: realDispatch({ seen, worker: ({ targetDir }) => writeFileSync(join(targetDir, 'write.txt'), 'ok\n') }),
      },
    });
    assert.equal(seen[0].evidenceRetryAvailable, expected, label);
  }
});

test('a resumed run keeps its marker: no proof on a step without evidence, and an extra key survives', async (t) => {
  const marker = `${JSON.stringify({ deliverableGate: 1, acmeFutureKey: 'kept' }, null, 2)}\n`;
  const { f, runDir } = await resumeWithAttempts(t, { runId: 'wf-evmark-abcdef', attempts: [], marker, evidence: null });
  const seen = [];
  const run = await runV2AutonomousWorkflow({
    bullswarmDir: f.bullswarmDir, resumeRunId: 'wf-evmark-abcdef', pools: [], parentEnv: {},
    dependencies: {
      refreshPools: async () => null,
      dispatchV2Action: realDispatch({ seen, worker: ({ targetDir }) => writeFileSync(join(targetDir, 'write.txt'), 'ok\n') }),
    },
  });
  assert.equal(run.state.actions[0].status, 'succeeded');
  assert.equal(seen[0].legacyGate, true);
  assert.equal(readFileSync(join(runDir, 'features.json'), 'utf8'), marker, 'never rewritten');
  assert.deepEqual(readRunFeatures(runDir), { deliverableGate: 1, acmeFutureKey: 'kept' });
  const finished = eventsOf(runDir, 'action.finished').at(-1).payload;
  assert.equal(finished.status, 'succeeded');
  assert.equal(Object.hasOwn(finished, 'proof'), false);

  // The same unmarked run with a step that declares evidence is labelled.
  const { f: g, runDir: evidenceDir } = await resumeWithAttempts(t, { runId: 'wf-evmrk2-abcdef', attempts: [] });
  await runV2AutonomousWorkflow({
    bullswarmDir: g.bullswarmDir, resumeRunId: 'wf-evmrk2-abcdef', pools: [], parentEnv: {},
    dependencies: {
      refreshPools: async () => null,
      dispatchV2Action: realDispatch({ worker: ({ targetDir }) => writeFileSync(join(targetDir, 'write.txt'), 'ok\n') }),
    },
  });
  assert.equal(existsSync(join(evidenceDir, 'features.json')), false);
  assert.deepEqual(eventsOf(evidenceDir, 'action.finished').at(-1).payload.proof, { by: ['command'], reviewPending: false });
});

test('an isolated run checks the copy before integration and rewrites the workspace path in cmd', async (t) => {
  const f = fixture(t, { workspaceMode: 'isolated' });
  const seen = [];
  const cmd = `test -s ${f.workspace}/write.txt && echo '<testsuite/>' > junit.xml`;
  const run = await launch(f, {
    runId: 'wf-evisol-abcdef',
    actions: [step({ evidence: [{ type: 'command', cmd }] })],
    dispatch: realDispatch({ seen, worker: ({ targetDir }) => writeFileSync(join(targetDir, 'write.txt'), 'ok\n') }),
  });
  const options = seen[0];
  assert.equal(options.privateWorkspace, true);
  assert.notEqual(options.targetDir, f.workspace);
  assert.equal(options.action.evidence[0].cmd, `test -s ${options.targetDir}/write.txt && echo '<testsuite/>' > junit.xml`);
  assert.match(options.taskText, new RegExp(`- command: \`test -s ${options.targetDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/write\\.txt`));
  assert.match(options.taskText, /Only your territory files are merged back\./);
  assert.equal(options.taskText.includes(`${f.workspace}/write.txt`), false);
  assert.equal(run.state.program.actions[0].evidence[0].cmd, cmd, 'the stored definition keeps the caller path');

  assert.equal(run.state.actions[0].status, 'succeeded', JSON.stringify(run.state.actions[0].lastFailure));
  const [item] = run.state.attempts[0].evidenceResults;
  assert.equal(item.status, 'passed');
  assert.deepEqual(item.touched, ['junit.xml']);
  assert.equal(readFileSync(join(f.workspace, 'write.txt'), 'utf8'), 'ok\n');
  assert.equal(existsSync(join(f.workspace, 'junit.xml')), false);
  const integrated = eventsOf(run.runDir, 'action.workspace_integrated').at(-1).payload.files;
  assert.equal(integrated.some((file) => String(file).includes('junit.xml')), false);
  assert.equal(integrated.some((file) => String(file).includes('write.txt')), true);
});

test('an isolated run whose check fails never integrates', async (t) => {
  const f = fixture(t, { workspaceMode: 'isolated' });
  const run = await launch(f, {
    runId: 'wf-evisof-abcdef',
    actions: [step({ evidence: [{ type: 'command', cmd: 'grep -q ready write.txt' }] })],
    dispatch: realDispatch({ worker: ({ targetDir }) => writeFileSync(join(targetDir, 'write.txt'), 'nope\n') }),
  });
  assert.equal(run.state.actions[0].status, 'failed');
  assert.equal(run.state.actions[0].lastFailure.kind, 'failed-evidence');
  assert.equal(existsSync(join(f.workspace, 'write.txt')), false, 'the main workspace is unchanged');
  assert.equal(eventsOf(run.runDir, 'action.workspace_integrated').length, 0);
  assert.equal(eventsOf(run.runDir, 'action.workspace_retained').length > 0, true);
});

test('a kernel signal during a check stores the attempt interrupted, and resume hands it on', async (t) => {
  const f = fixture(t);
  const runId = 'wf-evsig1-abcdef';
  const before = new Set(process.listeners('SIGTERM'));
  const signalKernel = kernelSignalFrom(before);
  const stubRunner = async (items, { shouldCancel, onEvidence }) => {
    onEvidence?.({ stage: 'started', index: 1, of: items.length, type: 'command', label: items[0].cmd });
    signalKernel();
    assert.equal(shouldCancel(), true, 'every kernel-ordered stop sets shouldCancel first');
    const results = items.map((item) => ({ type: 'command', cmd: item.cmd, timeoutSec: 120, status: 'not-run', exit: null, durationMs: 0, tail: '', why: 'stopped' }));
    onEvidence?.({ stage: 'finished', index: 1, of: items.length, type: 'command', label: items[0].cmd, status: 'not-run', why: 'stopped', durationMs: 0 });
    return { results, failed: false, stopped: true, checkFault: false, why: 'evidence stopped', createdOutOfScope: [] };
  };
  const first = await launch(f, {
    runId,
    actions: [step({ evidence: [{ type: 'command', cmd: 'node --test tests/write.test.js' }] })],
    dispatch: realDispatch({ runStepEvidence: stubRunner, worker: ({ targetDir }) => writeFileSync(join(targetDir, 'write.txt'), 'ok\n') }),
  });
  assert.equal(first.state.lifecycle.status, 'interrupted');
  const [attempt] = first.state.attempts;
  assert.equal(attempt.status, 'interrupted');
  assert.equal(attempt.failureKind, 'interrupted');
  assert.equal(attempt.why, 'kernel stopped during evidence; the attempt runs again on resume');
  assert.deepEqual(attempt.evidenceResults.map((item) => [item.status, item.why]), [['not-run', 'stopped']]);
  assert.equal(first.state.actions[0].status, 'interrupted');
  const finished = eventsOf(first.runDir, 'attempt.finished').at(-1).payload;
  assert.equal(finished.status, 'interrupted');
  assert.deepEqual(finished.evidenceOutcome, { passed: 0, failed: 0, notRun: 1, why: 'evidence stopped' });

  const seen = [];
  const resumed = await runV2AutonomousWorkflow({
    bullswarmDir: f.bullswarmDir, resumeRunId: runId, pools: [], parentEnv: {},
    dependencies: {
      refreshPools: async () => null,
      dispatchV2Action: realDispatch({
        seen,
        runStepEvidence: async (items) => ({
          results: items.map((item) => ({ type: 'command', cmd: item.cmd, timeoutSec: 120, status: 'passed', exit: 0, durationMs: 5, tail: '', why: null })),
          failed: false, stopped: false, checkFault: false, why: null, createdOutOfScope: [],
        }),
      }),
    },
  });
  assert.match(seen[0].taskText, /## Prior attempt on this step/);
  assert.match(seen[0].taskText, /- Failure: interrupted — kernel stopped during evidence; the attempt runs again on resume/);
  assert.match(seen[0].taskText, /\n {2}- command `node --test tests\/write\.test\.js`: not run · stopped\n/);
  assert.equal(seen[0].evidenceRetryAvailable, true, 'a stop never spends the evidence retry');
  assert.equal(resumed.state.actions[0].status, 'succeeded');
  assert.equal(resumed.state.attempts[1].status, 'succeeded');
});

test('pause --now during a check stores the attempt cancelled / paused, as for a worker', async (t) => {
  const f = fixture(t);
  const runId = 'wf-evpaus-abcdef';
  const stubRunner = async (items, { shouldCancel }) => {
    await pauseV2Run({ bullswarmDir: f.bullswarmDir, runId, mode: 'now' });
    const deadline = Date.now() + 5000;
    while (!shouldCancel() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(shouldCancel(), true);
    const results = items.map((item) => ({ type: 'command', cmd: item.cmd, timeoutSec: 120, status: 'not-run', exit: null, durationMs: 0, tail: '', why: 'stopped' }));
    return { results, failed: false, stopped: true, checkFault: false, why: 'evidence stopped', createdOutOfScope: [] };
  };
  const run = await launch(f, {
    runId,
    actions: [step({ evidence: [{ type: 'command', cmd: 'sleep 1' }] })],
    dispatch: realDispatch({ runStepEvidence: stubRunner, worker: ({ targetDir }) => writeFileSync(join(targetDir, 'write.txt'), 'ok\n') }),
    dependencies: { controlPollMs: 20 },
  });
  const [attempt] = run.state.attempts;
  assert.equal(attempt.status, 'cancelled');
  assert.equal(attempt.failureKind, 'paused');
  assert.equal(run.state.lifecycle.status, 'paused');
});

test("onAttempt('corrected') stores failed and the new why, emits corrected, and adds no usage", async (t) => {
  const f = fixture(t);
  let usageAfterFinish = null;
  let usageAfterCorrect = null;
  let receiptAfterCorrect = null;
  const dispatch = async (options) => {
    const files = options.paths(1);
    const startedAt = new Date().toISOString();
    const record = {
      ordinal: 1, pool: 'codex', model: 'gpt-5.6-luna', status: 'running', startedAt,
      taskFile: files.taskFile, outFile: files.outFile, routing: {},
    };
    options.onAttempt('started', { ...record });
    const evidenceResults = [{ type: 'command', cmd: 'false', timeoutSec: 120, status: 'failed', exit: 1, durationMs: 3, tail: '', why: 'exit 1' }];
    const failed = {
      ...record, status: 'interrupted', willRetry: true, failureKind: 'failed-evidence', why: 'false → exit 1',
      finishedAt: new Date().toISOString(), usage: { tokens: { totalKnown: 40 } }, evidenceResults,
    };
    options.onAttempt('finished', { ...failed }, { ok: false, failureKind: 'failed-evidence', why: failed.why, evidenceResults });
    usageAfterFinish = JSON.parse(readFileSync(join(options.runDir, 'state.json'), 'utf8')).usage;
    const why = 'false → exit 1 · no retry: codex is no longer eligible';
    options.onAttempt('corrected', { ...failed, status: 'failed', willRetry: false, why });
    const state = JSON.parse(readFileSync(join(options.runDir, 'state.json'), 'utf8'));
    usageAfterCorrect = state.usage;
    receiptAfterCorrect = existsSync(join(options.runDir, 'completion-write.json'));
    return { ok: false, status: 'failed', failureKind: 'failed-evidence', attempts: [failed], verdict: { ok: false, failureKind: 'failed-evidence', why } };
  };
  const run = await launch(f, { runId: 'wf-evcorr-abcdef', actions: [step({ evidence: [{ type: 'command', cmd: 'false' }] })], dispatch });
  const [attempt] = run.state.attempts;
  assert.equal(attempt.status, 'failed');
  assert.equal(attempt.why, 'false → exit 1 · no retry: codex is no longer eligible');
  assert.deepEqual(usageAfterCorrect, usageAfterFinish);
  assert.equal(usageAfterFinish.total, 40);
  assert.equal(receiptAfterCorrect, false);
  const finished = eventsOf(run.runDir, 'attempt.finished').map((event) => event.payload);
  assert.equal(finished.length, 2);
  assert.equal(finished[0].willRetry, true);
  assert.equal(Object.hasOwn(finished[0], 'corrected'), false);
  assert.equal(finished[1].corrected, true);
  assert.equal(finished[1].attemptId, 'write-1');
  assert.equal(finished[1].status, 'failed');
  assert.equal(finished[1].willRetry, false);
  assert.equal(finished[1].why, attempt.why);
  assert.equal(finished[1].evidenceOutcome.failed, 1);
  assert.equal(run.state.actions[0].lastFailure.kind, 'failed-evidence');
});

test('a kernel that dies after the receipt recovers the check results on resume (E31)', async (t) => {
  const f = fixture(t);
  const runId = 'wf-evrcpt-abcdef';
  const runDir = join(f.bullswarmDir, 'workflows', runId);
  const snapshot = join(f.root, 'snapshot');
  // The run directory exactly as a kernel killed right after the receipt write
  // leaves it: the receipt is on disk, the attempt is still stored running.
  const writeThenDie = (path, value) => {
    writeJsonAtomic(path, value);
    cpSync(runDir, snapshot, { recursive: true, filter: (source) => basename(source) !== 'kernel.lock' });
  };
  await launch(f, {
    runId,
    actions: [step({ evidence: [{ type: 'command', cmd: 'test -s write.txt' }] })],
    dispatch: realDispatch({ worker: ({ targetDir }) => writeFileSync(join(targetDir, 'write.txt'), 'ok\n') }),
    dependencies: { writeCompletionReceipt: writeThenDie },
  });
  rmSync(runDir, { recursive: true, force: true });
  renameSync(snapshot, runDir);
  const stored = JSON.parse(readFileSync(join(runDir, 'state.json'), 'utf8'));
  assert.equal(stored.attempts[0].status, 'running');
  assert.equal(Object.hasOwn(stored.attempts[0], 'evidenceResults'), false, 'the attempt was never stored finished');
  const receipt = JSON.parse(readFileSync(join(runDir, 'completion-write.json'), 'utf8'));
  assert.equal(receipt.verdict.evidenceResults[0].status, 'passed');

  let dispatched = 0;
  const resumed = await runV2AutonomousWorkflow({
    bullswarmDir: f.bullswarmDir, resumeRunId: runId, pools: [], parentEnv: {},
    dependencies: { refreshPools: async () => null, dispatchV2Action: async () => { dispatched += 1; throw new Error('must not redispatch'); } },
  });
  assert.equal(dispatched, 0);
  const [attempt] = resumed.state.attempts;
  assert.equal(attempt.status, 'succeeded');
  assert.deepEqual(attempt.evidenceResults, receipt.verdict.evidenceResults);
  assert.equal(resumed.state.actions[0].status, 'succeeded');
  const proof = eventsOf(runDir, 'action.finished').at(-1).payload.proof;
  assert.equal(formatV2ProofLabel(proof), 'proven by command');
});

test('onEvidence refreshes lastActivityAt on each heartbeat and persists it; no event per heartbeat', async (t) => {
  const f = fixture(t);
  const runId = 'wf-evbeat-abcdef';
  let clock = Date.parse('2026-09-24T10:00:00.000Z');
  const now = () => new Date(clock).toISOString();
  let onDisk = null;
  let score = null;
  const stubRunner = async (items, { onEvidence }) => {
    const position = { index: 1, of: 1, type: 'command', label: items[0].cmd };
    clock += 60_000;
    onEvidence({ stage: 'started', ...position });
    // Eleven silent minutes of check, one heartbeat every 30 s.
    for (let beat = 0; beat < 22; beat += 1) {
      clock += 30_000;
      onEvidence({ stage: 'running', ...position });
    }
    // Past the one-second persist throttle, one more heartbeat reaches disk.
    await new Promise((resolve) => setTimeout(resolve, 1100));
    clock += 30_000;
    onEvidence({ stage: 'running', ...position });
    const state = JSON.parse(readFileSync(join(f.bullswarmDir, 'workflows', runId, 'state.json'), 'utf8'));
    onDisk = state.attempts[0];
    score = staleScore({ attempt: onDisk, nowMs: clock + 15_000 });
    onEvidence({ stage: 'finished', ...position, status: 'passed', why: null, durationMs: 11 * 60_000 });
    return {
      results: [{ type: 'command', cmd: items[0].cmd, timeoutSec: 600, status: 'passed', exit: 0, durationMs: 11 * 60_000, tail: '', why: null }],
      failed: false, stopped: false, checkFault: false, why: null, createdOutOfScope: [],
    };
  };
  await launch(f, {
    runId,
    actions: [step({ evidence: [{ type: 'command', cmd: 'npm test', timeoutSec: 600 }] })],
    dispatch: realDispatch({ runStepEvidence: stubRunner, worker: ({ targetDir }) => writeFileSync(join(targetDir, 'write.txt'), 'ok\n') }),
    dependencies: { now },
  });
  assert.equal(onDisk.status, 'running');
  assert.equal(onDisk.lastActivityAt, new Date(clock).toISOString());
  assert.equal(score.signals.some((signal) => signal.id === 'quiet'), false, JSON.stringify(score));
  const items = eventsOf(join(f.bullswarmDir, 'workflows', runId), 'attempt.evidence_item');
  assert.deepEqual(items.map((event) => event.payload.stage), ['started', 'finished']);
});

test('the evidence log files live beside the task in the run directory', async (t) => {
  const f = fixture(t);
  const run = await launch(f, {
    runId: 'wf-evlogs-abcdef',
    actions: [step({ evidence: [{ type: 'command', cmd: 'echo acme-log-line' }, { type: 'command', cmd: 'true' }] })],
    dispatch: realDispatch({ worker: ({ targetDir }) => writeFileSync(join(targetDir, 'write.txt'), 'ok\n') }),
  });
  const logs = readdirSync(run.runDir).filter((name) => name.startsWith('evidence-')).sort();
  assert.deepEqual(logs, ['evidence-write-attempt-1-1.log', 'evidence-write-attempt-1-2.log']);
  assert.match(readFileSync(join(run.runDir, logs[0]), 'utf8'), /acme-log-line/);
  assert.deepEqual(run.state.attempts[0].evidenceResults.map((item) => item.log), logs.map((name) => join(run.runDir, name)));
});
