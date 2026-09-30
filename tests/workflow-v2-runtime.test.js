import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { readEvents } from '../src/workflow/events.js';
import { writeJsonAtomic } from '../src/lib/fsjson.js';
import { createV2GoalDocument, createV2State, deserializeV2DurableState } from '../src/workflow/v2-state.js';
import { runV2AutonomousWorkflow } from '../src/workflow/v2-runtime.js';
import { preferredUsage } from '../src/workflow/usage-preference.js';
import { reopenV2RunForRetry, reviseV2Program } from '../src/workflow/run-control.js';
import { acceptCallerPlannerResponse } from '../src/workflow/caller-planner.js';
import { GATE_RETRY_HANDOFF_LINE, handoffBlock } from '../src/workflow/retry-handoff.js';
import { normalizeAttempt, recordAttemptCapture } from '../src/workflow/attempt-record.js';
import { dispatchV2Action } from '../src/workflow/v2-dispatch.js';
import { needsYouFacts } from '../src/workflow/needs-you.js';
import { summarizeV2Result, v2LimitStoppedDispatch } from '../src/workflow/v2-outcome.js';
import { notableWatchEvents, renderWatchEvent, watchTrouble } from '../src/workflow/watch-cli.js';
import { createRevisionRequest, exportV2Plan, normalizeRevisionInput } from '../src/workflow/v2-revision.js';
import { STAGE3_RUN_FEATURES } from '../src/workflow/run-features.js';
import { readGoalProject } from '../src/workflow/goal.js';
import { readRollup, readRollupIndex, readRollups, rollupIndexPath } from '../src/workflow/rollup.js';
import { implicitV3Requirements } from '../src/workflow/program-v3.js';
import { addV3Steps } from '../src/workflow/cli-steps.js';
import { requestContinue } from '../src/workflow/gates-loops.js';

// What a stage-2 launch wrote to features.json (E23); saved runs keep it.
const STAGE2_RUN_FEATURES = Object.freeze({ deliverableGate: 1, proofLabels: 1 });

const requirement = { id: 'report-correct', text: 'report.md exists and contains READY' };
const programResponse = () => ({
  schemaVersion: 'bullswarm.workflow.planner-response.v2', kind: 'program',
  summary: 'Write the report and independently inspect it.',
  program: { schemaVersion: 'bullswarm.workflow.program.v2', actions: [
    { id: 'write-report', purpose: 'Write report', dependsOn: [], affects: ['report-correct'], ownedFiles: ['report.md'], prompt: 'Write READY to report.md.', lane: 'build', effort: 'low', evidenceFor: [], inputs: [], produces: ['report'] },
    { id: 'inspect-report', purpose: 'Inspect report', dependsOn: ['write-report'], affects: [], ownedFiles: [], prompt: 'Inspect report.md.', lane: 'analyze', effort: 'low', evidenceFor: ['report-correct'], inputs: ['report'], produces: [] },
  ] },
});
const exhausted = {
  schemaVersion: 'bullswarm.workflow.planner-response.v2', kind: 'exhausted',
  summary: 'No safe bounded action remains.', reason: 'The prior worker changed an undeclared path, so its work cannot be trusted.',
};

function setup(settings = {}) {
  const root = mkdtempSync(join(tmpdir(), 'bullswarm-v2-runtime-'));
  const bullswarmDir = join(root, 'home');
  const workspace = join(root, 'repo');
  mkdirSync(bullswarmDir); mkdirSync(workspace);
  const goal = createV2GoalDocument({ goal: 'Deliver a correct report', cwd: workspace, requirements: [requirement], settings: { scout: false, concurrency: 2, maxExpansionRounds: 1, ...settings } });
  return { root, bullswarmDir, workspace, goal };
}

function fakeDispatch(handler, { reasoning = undefined } = {}) {
  let calls = 0;
  const resolved = reasoning === undefined ? {} : { reasoning };
  const dispatch = async (options) => {
    calls += 1;
    const files = typeof options.paths === 'function' ? options.paths(1) : options.paths;
    const startedAt = '2026-08-31T01:00:01.000Z';
    options.onAttempt?.('started', { ordinal: 1, pool: 'relay', model: 'gpt-5.6-luna', status: 'running', startedAt, taskFile: files.taskFile, outFile: files.outFile, routing: {}, ...resolved });
    const value = await handler(options, calls, files);
    const record = {
      ordinal: 1, pool: 'relay', model: 'gpt-5.6-luna', status: value.ok ? 'succeeded' : 'failed',
      startedAt, finishedAt: '2026-08-31T01:00:02.000Z', taskFile: files.taskFile, outFile: files.outFile,
      failureKind: value.failureKind ?? null, why: value.verdict?.why ?? null,
      usage: { tokens: { totalKnown: 10 } }, wallSec: 1, routing: {}, ...resolved,
    };
    options.onAttempt?.('finished', record, value.verdict);
    return { attempts: [record], ...value };
  };
  dispatch.calls = () => calls;
  return dispatch;
}

test('normalizeAttempt retains the provider session record for durable callers', () => {
  const normalized = normalizeAttempt({
    status: 'succeeded', pool: 'claude-code', model: 'claude-opus-5',
    startedAt: '2026-09-18T01:00:00.000Z',
    session: { pool: 'claude-code', model: 'claude-opus-5', sessionId: 'session-roundtrip', generation: 1 },
  }, { id: 'attempt-1', actionId: 'build-report', ordinal: 1 });
  assert.equal(normalized.session.sessionId, 'session-roundtrip');
  assert.equal(normalized.session.generation, 1);
});

test('normalizeAttempt copies evidenceResults only when the checks ran', () => {
  const evidenceResults = [{ type: 'command', cmd: 'true', timeoutSec: 120, status: 'passed', exit: 0, durationMs: 4, tail: '', why: null }];
  const base = { status: 'succeeded', pool: 'relay', model: 'gpt-5.6-luna', startedAt: '2026-09-24T01:00:00.000Z' };
  const withChecks = normalizeAttempt({ ...base, evidenceResults }, { id: 'build-1', actionId: 'build', ordinal: 1 });
  assert.deepEqual(withChecks.evidenceResults, evidenceResults);
  assert.notEqual(withChecks.evidenceResults, evidenceResults, 'a copy, not the dispatch record');
  const without = normalizeAttempt(base, { id: 'build-1', actionId: 'build', ordinal: 1 });
  assert.equal(Object.hasOwn(without, 'evidenceResults'), false);
});

test('normalizeAttempt copies the retry fact only when the attempt has one', () => {
  const base = { status: 'running', pool: 'relay', model: 'gpt-5.6-luna', startedAt: '2026-09-24T01:00:00.000Z' };
  const retryOf = { attempt: 'build-1', how: 'same-pool' };
  const retried = normalizeAttempt({ ...base, retryOf }, { id: 'build-2', actionId: 'build', ordinal: 2 });
  assert.deepEqual(retried.retryOf, retryOf);
  assert.notEqual(retried.retryOf, retryOf, 'a copy, not the dispatch record');
  assert.equal(Object.hasOwn(normalizeAttempt(base, { id: 'build-1', actionId: 'build', ordinal: 1 }), 'retryOf'), false);
});

// --- the dashboard's data floor ----------------------------------------
//
// The finish path writes one rollup record per run and appends it to the
// history index, so Home, Stats and History never have to parse every
// state.json (293 directories, 22 MB, ~100 ms measured on this machine) on
// the dashboard's 1 s refresh timer. Goal time stamps the project.

// ── attempt.capture ─────────────────────────────────────────────────────────

const CAPTURED_TOKENS = {
  standardRead: 2, cacheRead: 3, cacheWrite5m: null, cacheWrite1h: null, cacheWrite: null,
  output: 5, reasoning: 4, totalKnown: 14,
};
const capturedUsage = (sessionId) => ({
  model: 'gpt-5.6-luna', sessionId, tokens: { ...CAPTURED_TOKENS }, tokenSource: 'provider-reported',
});
const captureBlock = (sessionId, overrides = {}) => ({
  capturedAt: '2026-08-31T01:00:01.500Z', source: 'event-stream',
  providerSessionId: sessionId, sessionSource: 'provider-stream', model: 'gpt-5.6-luna',
  tokens: { ...CAPTURED_TOKENS }, tokenSource: 'provider-reported', providerCostUsd: 0.5,
  exitCode: 0, signal: null, ...overrides,
});

// Every attempt reports a provider capture at worker exit, then finishes with a
// weaker (estimated) usage and a different capture that must not win.
function captureDispatch(f, onDisk) {
  return async (options) => {
    const files = options.paths(1);
    const runDir = dirname(files.taskFile);
    const startedAt = '2026-08-31T01:00:01.000Z';
    const base = {
      ordinal: 1, pool: 'relay', model: 'gpt-5.6-luna', startedAt, taskFile: files.taskFile, outFile: files.outFile, routing: {},
      session: { pool: 'relay', model: 'gpt-5.6-luna', sessionId: `generated-${options.action.id}`, generation: 1 },
    };
    options.onAttempt?.('started', { ...base, status: 'running' });
    const sessionId = `provider-${options.action.id}`;
    options.onAttempt?.('captured', { ...base, status: 'running', capture: captureBlock(sessionId), usage: capturedUsage(sessionId) });
    // The capture is on disk before the verdict exists: a kernel that dies
    // now still has what the provider reported.
    onDisk.set(options.action.id, deserializeV2DurableState(readFileSync(join(runDir, 'state.json'), 'utf8')));
    // A second capture of the same attempt is ignored: the first is immutable.
    options.onAttempt?.('captured', { ...base, status: 'running', capture: captureBlock('rewritten', { exitCode: 7 }), usage: null });
    let verdict;
    if (options.action.id === 'preflight-scout') {
      const report = [
        'TREE:\n- report.md', 'MANIFEST:\n- Node.js', 'TEST STATUS:\n- tests pass',
        'UNITS OF WORK:\n- report', 'SHARED FILES:\n- none', 'RISKS:\n- none',
        'Additional repository facts '.repeat(8),
      ].join('\n');
      writeFileSync(files.outFile, report);
      verdict = { ok: true, structured: { value: report }, outFile: files.outFile, meta: { exitCode: 0 } };
    } else if (options.action.id === 'workflow-planner') {
      const candidatePath = options.taskText.match(/exact durable path: '([^']+)'/)?.[1];
      writeFileSync(candidatePath, JSON.stringify(programResponse()));
      verdict = { ok: true, structured: options.outputValidator(''), outFile: files.outFile, meta: { exitCode: 0 } };
    } else if (options.action.id === 'write-report') {
      writeFileSync(join(f.workspace, 'report.md'), 'READY\n');
      writeFileSync(files.outFile, 'wrote report.md');
      verdict = { ok: true, why: 'verified', outFile: files.outFile, meta: { exitCode: 0 } };
    } else {
      const evidence = { schemaVersion: 'bullswarm.workflow.evidence.v2', requirements: { 'report-correct': { status: 'passed', evidence: ['report.md contains READY'], concerns: [] } } };
      writeFileSync(options.taskText.match(/exact durable path: '([^']+)'/)?.[1], JSON.stringify(evidence));
      writeFileSync(files.outFile, 'inspected');
      verdict = { ok: true, structured: options.outputValidator(''), outFile: files.outFile, meta: { exitCode: 0 } };
    }
    // The finished record carries a weaker (estimated) usage and a different
    // capture; neither may replace what the provider reported.
    const record = {
      ...base, status: 'succeeded', finishedAt: '2026-08-31T01:00:02.000Z', failureKind: null, why: null, wallSec: 1,
      capture: captureBlock('finished-copy', { exitCode: 9 }),
      usage: {
        model: 'gpt-5.6-luna', sessionId: null, tokenSource: 'estimated:utf8-bytes/4',
        tokens: { ...CAPTURED_TOKENS, standardRead: 90, totalKnown: 99 },
        subscription: { pool: 'relay', window: 'weekly', deltaPct: null, usd: null, basis: 'unknown:no-meter' },
      },
    };
    options.onAttempt?.('finished', record, verdict);
    return { ok: true, status: 'succeeded', attempts: [record], verdict };
  };
}

test('preferredUsage upgrades an estimate but never downgrades provider-reported counters', () => {
  const estimated = { tokenSource: 'estimated:utf8-bytes/4', tokens: { totalKnown: 99 } };
  const summed = { tokenSource: 'transcript-summed', tokens: { totalKnown: 20 }, subscription: { basis: 'observed:meter-delta' } };
  const reported = capturedUsage('s1');
  assert.deepEqual(preferredUsage(estimated, summed), summed);
  assert.deepEqual(preferredUsage(null, estimated), estimated);
  assert.deepEqual(preferredUsage(reported, null), reported);
  const kept = preferredUsage(reported, summed);
  assert.equal(kept.tokenSource, 'provider-reported');
  assert.deepEqual(kept.tokens, CAPTURED_TOKENS);
  assert.deepEqual(kept.subscription, { basis: 'observed:meter-delta' });
  const attempt = { status: 'running' };
  assert.equal(recordAttemptCapture(attempt, { capture: captureBlock('s1'), usage: reported }), true);
  assert.equal(recordAttemptCapture(attempt, { capture: captureBlock('s2'), usage: estimated }), false);
  assert.equal(attempt.capture.providerSessionId, 's1');
  assert.equal(attempt.usage.tokenSource, 'provider-reported');
});

// --- Stage 3: the failure rule's kernel side (marker, placement, route,
// no free pool, retry facts, who reviewed). Fake dispatches drive the options
// the kernel hands the dispatcher, exactly as the real one calls them.

const WORK_REQ = { id: 'work-done', text: 'work.md exists and says done' };
const NOTES_REQ = { id: 'notes-done', text: 'notes.md exists' };

function stage3Setup(t, settings = {}) {
  const root = mkdtempSync(join(tmpdir(), 'bullswarm-v2-stage3-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bullswarmDir = join(root, 'home');
  const workspace = join(root, 'repo');
  mkdirSync(bullswarmDir); mkdirSync(workspace);
  const goal = createV2GoalDocument({
    goal: 'Deliver the work', cwd: workspace, requirements: [WORK_REQ, NOTES_REQ],
    settings: { executionMode: 'program', plannerMode: 'caller', workspaceMode: 'shared', scout: false, concurrency: 2, ...settings },
  });
  return { root, bullswarmDir, workspace, goal };
}

const step3 = (id, over = {}) => ({
  id, purpose: `Run ${id}`, dependsOn: [], affects: ['notes-done'], ownedFiles: [`${id}.md`], prompt: `Do ${id}.`,
  lane: 'build', effort: 'low', evidenceFor: [], inputs: [], produces: [], ...over,
});
const programOf = (actions) => ({
  schemaVersion: 'bullswarm.workflow.planner-response.v2', kind: 'program', summary: 'Stage-3 kernel test.',
  program: { schemaVersion: 'bullswarm.workflow.program.v2', actions },
});

// One attempt through the kernel's onAttempt, as the dispatcher reports it.
function reportAttempt(options, ordinal, { pool = 'relay', ok = true, failureKind = null, why = null, retryOf = null, willRetry = false, changedFileCount = 1 } = {}) {
  const files = options.paths(ordinal);
  const startedAt = new Date().toISOString();
  const started = {
    ordinal, pool, model: 'gpt-5.6-luna', status: 'running', startedAt, taskFile: files.taskFile, outFile: files.outFile,
    routing: {}, ...(retryOf ? { retryOf } : {}),
  };
  options.onAttempt('started', { ...started });
  writeFileSync(files.taskFile, options.taskText);
  writeFileSync(files.outFile, ok ? 'done' : 'it failed');
  const record = {
    ...started, status: ok ? 'succeeded' : willRetry ? 'interrupted' : 'failed', finishedAt: new Date().toISOString(),
    failureKind, why, willRetry, usage: { tokens: { totalKnown: 1 } }, wallSec: 1, changedFileCount,
  };
  options.onAttempt('finished', { ...record }, ok ? { ok: true, outFile: files.outFile } : { ok: false, why, failureKind, outFile: files.outFile });
  return record;
}

function succeedEvidence(options, requirements, ordinal = 1, attemptOptions = {}) {
  const candidatePath = options.taskText.match(/exact durable path: '([^']+)'/)?.[1];
  writeFileSync(candidatePath, JSON.stringify({ schemaVersion: 'bullswarm.workflow.evidence.v2', requirements }));
  const record = reportAttempt(options, ordinal, attemptOptions);
  const structured = options.outputValidator('prose');
  return { ok: true, status: 'succeeded', attempts: [record], verdict: { ok: true, structured, outFile: record.outFile } };
}

const succeed = (options, ordinal = 1, attemptOptions = {}) => {
  const record = reportAttempt(options, ordinal, attemptOptions);
  return { ok: true, status: 'succeeded', attempts: [record], verdict: { ok: true, why: 'ok', outFile: record.outFile } };
};

function launch3(f, { runId, actions, dispatch, dependencies = {}, onEvent = null }) {
  return runV2AutonomousWorkflow({
    bullswarmDir: f.bullswarmDir, goalDocument: f.goal, pools: [], runId, parentEnv: {},
    initialPlannerResponse: programOf(actions), ...(onEvent ? { onEvent } : {}),
    dependencies: { refreshPools: async () => null, dispatchV2Action: dispatch, ...dependencies },
  });
}

// A run dir the way a kernel left it, for resume tests.
function savedRun(f, { runId, actions, marker, edit }) {
  const runDir = join(f.bullswarmDir, 'workflows', runId);
  mkdirSync(runDir, { recursive: true });
  if (marker) writeFileSync(join(runDir, 'features.json'), marker);
  let state = createV2State(f.goal, { runId, shortId: runId.slice(3, 9) });
  state = acceptCallerPlannerResponse(state, programOf(actions), { boundary: 'initial', runDir }).state;
  state.lifecycle.status = 'interrupted';
  edit(state);
  writeFileSync(join(runDir, 'goal.json'), JSON.stringify(f.goal));
  writeFileSync(join(runDir, 'state.json'), JSON.stringify(state));
  return runDir;
}

const eventsOfType = (runDir, type) => readEvents(runDir).filter((event) => event.type === type);
const readState = (runDir) => JSON.parse(readFileSync(join(runDir, 'state.json'), 'utf8'));

test('handoffBlock adds the gate line only for a gate retry, just before the unverified-edits line', () => {
  const facts = { pool: 'relay', startedAt: '2026-09-24T10:00:00.000Z', finishedAt: '2026-09-24T10:01:00.000Z', failureKind: 'not-produced', why: 'no file changed' };
  const plain = handoffBlock(facts);
  assert.equal(handoffBlock({ ...facts, gate: false }), plain);
  assert.doesNotMatch(plain, /automatic retry/);
  const gated = handoffBlock({ ...facts, gate: true }).split('\n');
  assert.equal(GATE_RETRY_HANDOFF_LINE, '- This is the step\'s one automatic retry: the failure above closed its gate. Fix what it names; your earlier edits are still in the workspace.');
  assert.deepEqual(gated.slice(-2), [GATE_RETRY_HANDOFF_LINE, '- Those edits are unverified. You decide whether to keep, fix or revert them, and you must report which.']);
  assert.equal(gated.filter((line) => line !== GATE_RETRY_HANDOFF_LINE).join('\n'), plain);
});

test('marked: a step no pool can take now goes to the caller with each pool\'s return, never waits, and the rest of the run goes on', async (t) => {
  const f = stage3Setup(t);
  // A pool whose meter reads its 5-hour window at the limit until its reset.
  const soonMs = Date.now() + 2 * 3600_000;
  const laterMs = Date.now() + 4 * 3600_000;
  const [soon, later] = [soonMs, laterMs].map((ms) => new Date(ms).toISOString());
  const pausedPool = (name, until) => ({
    name, lanes: ['analyze', 'build', 'chore'], enabled: true, spawn: { cmd: ['fake'] },
    modelSelection: { flag: '--model' }, strategyAssignments: { low: { pool: name, model: 'gpt-5.6-luna' } },
    fiveHourUsedPct: 100, fiveHourResetsAt: new Date(until).toISOString(),
  });
  const slept = [];
  // `write` goes through the real dispatcher, with seams that would show a
  // worker start or a wait; `notes` is faked so the rest of the run can finish.
  const dispatch = (options) => (options.action.id === 'write'
    ? dispatchV2Action({ ...options, dependencies: {
      watchOnce: async () => { throw new Error('no worker may start'); },
      sleep: async (ms) => { slept.push(ms); throw new Error('the step waited for a pool'); },
    } })
    : succeed(options));
  const run = await runV2AutonomousWorkflow({
    bullswarmDir: f.bullswarmDir, goalDocument: f.goal, pools: [pausedPool('luna-1', soonMs), pausedPool('luna-2', laterMs)],
    runId: 'wf-s3nofree-abcdef', parentEnv: {}, initialPlannerResponse: programOf([step3('write', { affects: ['work-done'] }), step3('notes')]),
    dependencies: { refreshPools: async () => null, dispatchV2Action: dispatch },
  });
  const why = `no pool with quota to spare: luna-1 at its 5-hour limit until ${soon}; luna-2 at its 5-hour limit until ${later}`;
  const write = run.state.actions.find((action) => action.id === 'write');
  assert.equal(write.status, 'failed');
  // A step no pool took records what ruled each pool out (QA37).
  assert.deepEqual(write.lastFailure, {
    kind: 'quota', message: why, retryAfter: soon,
    route: { why, candidates: [
      { pool: 'luna-1', provider: 'luna-1', excluded: `luna-1 at its 5-hour limit until ${soon}` },
      { pool: 'luna-2', provider: 'luna-2', excluded: `luna-2 at its 5-hour limit until ${later}` },
    ] },
  });
  assert.equal(run.state.actions.find((action) => action.id === 'notes').status, 'succeeded');
  assert.deepEqual(slept, [], 'no wait');
  assert.deepEqual(eventsOfType(run.runDir, 'action.waiting'), []);
  assert.deepEqual(eventsOfType(run.runDir, 'attempt.started').map((event) => event.payload.actionId), ['notes']);
  const finished = eventsOfType(run.runDir, 'action.finished').find((event) => event.payload.actionId === 'write');
  assert.deepEqual([finished.payload.status, finished.payload.failureKind, finished.payload.why, finished.payload.retryAfter], ['failed', 'quota', why, soon]);
  // The caller's block says when a rerun can get through; nothing waits for it.
  const facts = needsYouFacts(run.state, finished, { runDir: run.runDir });
  assert.equal(facts.backAt, soon);
  assert.equal(facts.options.waitForIt, `after ${soon}: bullswarm workflow step rerun ${run.shortId} write`);
});

test('the failed action.finished names the current attempts and, in a marked run, the counted retries', async (t) => {
  for (const [label, features, runId] of [['marked', STAGE3_RUN_FEATURES, 'wf-s3fail-abcdef'], ['unmarked', STAGE2_RUN_FEATURES, 'wf-s2fail-abcdef']]) {
    const f = stage3Setup(t);
    const dispatch = async (options) => {
      const first = reportAttempt(options, 1, { pool: 'codex', ok: false, failureKind: 'process', why: 'exit 1', willRetry: true });
      const second = reportAttempt(options, 2, { pool: 'relay', ok: false, failureKind: 'process', why: 'exit 2', retryOf: { attempt: 'write-1', how: 'other-pool' } });
      return { ok: false, status: 'failed', failureKind: 'process', attempts: [first, second], verdict: { ok: false, why: 'exit 2', failureKind: 'process' } };
    };
    const run = await launch3(f, { runId, dispatch, actions: [step3('write')], dependencies: { runFeatures: features } });
    const finished = eventsOfType(run.runDir, 'action.finished').at(-1).payload;
    assert.equal(finished.status, 'failed', label);
    assert.deepEqual(finished.attemptIds, ['write-1', 'write-2'], label);
    if (label === 'marked') assert.equal(finished.retries, 1);
    else assert.equal(Object.hasOwn(finished, 'retries'), false, 'a saved run counts attempts minus one in the watcher');
  }
});

test('attempt.finished carries the dispatcher\'s backoff decision for a transient rate limit (F23)', async (t) => {
  const f = stage3Setup(t);
  const dispatch = async (options) => {
    const files = options.paths(1);
    const started = { ordinal: 1, pool: 'relay', model: 'gpt-5.6-luna', status: 'running', startedAt: new Date().toISOString(), taskFile: files.taskFile, outFile: files.outFile, routing: {} };
    options.onAttempt('started', { ...started });
    writeFileSync(files.outFile, 'too many requests');
    // A throttle backs off on the same pool; a usage limit records no
    // decision (it goes to the caller).
    options.onAttempt('finished', { ...started, status: 'interrupted', finishedAt: new Date().toISOString(), failureKind: 'throttle', why: 'too many requests', willRetry: true, quotaNext: 'wait' }, { ok: false, why: 'too many requests' });
    const second = reportAttempt(options, 2, { pool: 'relay', retryOf: { attempt: 'write-1', how: 'wait' } });
    return { ok: true, status: 'succeeded', attempts: [second], verdict: { ok: true, outFile: second.outFile } };
  };
  const run = await launch3(f, { runId: 'wf-s3qnext-abcdef', dispatch, actions: [step3('write')] });
  assert.equal(run.result.status, 'completed');
  const finished = eventsOfType(run.runDir, 'attempt.finished').map((event) => [event.payload.attemptId, event.payload.quotaNext ?? null]);
  assert.deepEqual(finished, [['write-1', 'wait'], ['write-2', null]]);
});

// --- stage 3: the Workflow Planner and preflight scout of a marked run -------
// A usage limit, a rate limit that did not clear, or no free pool stops them
// and goes to the caller; the dispatcher never moves them to another pool
// (usageLimitsToCaller, owner decision 2026-09-25).

const LIMIT_RESET = '2026-08-31T02:20:00.000Z';
const LIMIT_WHY = `usage limit: "You've hit your session limit" · pool paused until ${LIMIT_RESET}`;
const BENCH_UNTIL = '2026-08-31T01:20:00.000Z';
const THROTTLE_WHY = 'rate limited (transient): "Error: 429 Too Many Requests" · pool not paused';

// A dispatch that stopped on a limit, as the dispatcher returns it: one
// failed attempt reported through onAttempt, or none when no pool was free.
function limitStopped(options, { failureKind = 'quota', retryAfter = LIMIT_RESET, why = LIMIT_WHY, attempt = true } = {}) {
  const attempts = attempt ? [reportAttempt(options, 1, { ok: false, failureKind, why })] : [];
  return {
    ok: false, status: 'failed', failureKind, ...(retryAfter ? { retryAfter } : {}), attempts,
    verdict: { ok: false, why, failureKind, meta: { exitCode: attempt ? 1 : null } },
  };
}
// The caller's options (owner decision 2026-09-25): resume runs the stopped
// planner or scout again, after its return when one is known.
const yourCall = (token, retryAfter) => ` · your call: ${retryAfter ? `resume after ${retryAfter} with bullswarm workflow resume ${token}` : `bullswarm workflow resume ${token} once a pool is free`}`
  + `, plan it yourself with bullswarm workflow plan revise ${token} --program <file.json>, or start a new run`;
// A dispatched planner turn that returns `actions` as its program.
const planned = (options, actions) => {
  const record = reportAttempt(options, 1);
  return { ok: true, status: 'succeeded', attempts: [record], verdict: { ok: true, structured: { value: programOf(actions) }, outFile: record.outFile } };
};
const SCOUT_REPORT = [
  'TREE:\n- work.md', 'MANIFEST:\n- Node.js', 'TEST STATUS:\n- no tests',
  'UNITS OF WORK:\n- write', 'SHARED FILES:\n- none', 'RISKS:\n- none',
  'Additional repository facts '.repeat(8), '["write"]',
].join('\n');
const scouted = (options) => {
  const record = reportAttempt(options, 1);
  writeFileSync(record.outFile, SCOUT_REPORT);
  return { ok: true, status: 'succeeded', attempts: [record], verdict: { ok: true, structured: { value: SCOUT_REPORT }, outFile: record.outFile } };
};
const resumeRun = (f, runId, dispatch) => runV2AutonomousWorkflow({
  bullswarmDir: f.bullswarmDir, resumeRunId: runId, pools: [], parentEnv: {},
  dependencies: { refreshPools: async () => null, dispatchV2Action: dispatch },
});
const recordingDispatch = (handler) => {
  const seen = [];
  const dispatch = async (options) => {
    seen.push({ id: options.action.id, usageLimitsToCaller: options.usageLimitsToCaller });
    return handler(options);
  };
  dispatch.seen = seen;
  return dispatch;
};
const launchPlanned = (f, runId, dispatch, dependencies = {}) => runV2AutonomousWorkflow({
  bullswarmDir: f.bullswarmDir, goalDocument: f.goal, pools: [], runId, parentEnv: {},
  dependencies: { refreshPools: async () => null, dispatchV2Action: dispatch, ...dependencies },
});

// --- 0.38.0: the kernel drives program v3 runs only -------------------------
// The scout, the dispatched planner, the review task and the repair loop are
// gone; a v3 program is the one live program. These runs go through the real
// dispatcher with a fake worker (`script(actionId, turn)` returns
// {answer?, fail?, why?, write?, signal?}).

const V3 = 'bullswarm.workflow.program.v3';
const v3Response = (program) => ({ schemaVersion: 'bullswarm.workflow.planner-response.v2', kind: 'program', summary: 'A v3 program.', program });

function v3Setup(t) {
  const root = mkdtempSync(join(tmpdir(), 'bullswarm-v3-kernel-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bullswarmDir = join(root, 'home');
  const workspace = join(root, 'repo');
  mkdirSync(bullswarmDir); mkdirSync(workspace);
  const goal = 'Deliver the acme notes';
  const goalDocument = createV2GoalDocument({
    goal, cwd: workspace, requirements: implicitV3Requirements(goal),
    settings: { executionMode: 'program', workspaceMode: 'shared', scout: false, plannerMode: 'caller', concurrency: 2 },
  });
  return { root, bullswarmDir, workspace, goalDocument };
}

const acmePool = {
  name: 'acme-pool', lanes: ['analyze', 'build', 'chore'], enabled: true, spawn: { cmd: ['fake'] },
  modelSelection: { flag: '--model' },
  strategyAssignments: Object.fromEntries(['low', 'medium', 'high'].map((tier) => [tier, { pool: 'acme-pool', model: 'acme-model' }])),
};

function v3Dispatch(script = () => ({}), seen = []) {
  const core = { config: { depthLimit: 2 }, pools: {}, incumbents: {}, decisionLog: [] };
  const turns = new Map();
  return (options) => {
    seen.push(options.action.id);
    return dispatchV2Action({
      ...options,
      pools: [acmePool],
      dependencies: {
        watchOnce: async (_pool, task, targetDir, files, opts) => {
          const turn = (turns.get(options.action.id) ?? 0) + 1;
          turns.set(options.action.id, turn);
          const plan = script(options.action.id, turn) ?? {};
          for (const [path, body] of Object.entries(plan.write ?? {})) writeFileSync(join(targetDir, path), body);
          writeFileSync(files.taskFile, task);
          const named = /to this file: (\S+)/.exec(task)?.[1] ?? null;
          if (named && plan.answer !== undefined) writeFileSync(named, JSON.stringify(plan.answer));
          writeFileSync(files.outFile, `done ${options.action.id} turn ${turn}`);
          if (plan.signal) process.emit('SIGTERM');
          if (plan.fail) return { ok: false, why: plan.why ?? 'the acme worker crashed', failureKind: plan.fail, meta: { exitCode: 1, wallSec: 1 } };
          const checked = opts.outputValidator ? opts.outputValidator('') : { ok: true };
          const structured = { ok: checked.ok, errors: checked.errors ?? [], ...(checked.value !== undefined ? { value: checked.value } : {}) };
          return checked.ok
            ? { ok: true, why: 'structured output validated', structured, meta: { exitCode: 0, wallSec: 1 } }
            : { ok: false, why: `structured output invalid: ${structured.errors.join('; ')}`, failureKind: 'schema', structured, meta: { exitCode: 0, wallSec: 1 } };
        },
        loadState: () => structuredClone(core),
        saveState: (_dir, next) => Object.assign(core, structuredClone(next)),
        now: () => Date.now(),
        uuid: () => 'session-fixed',
      },
    });
  };
}

const v3Launch = (f, program, dispatch, extra = {}) => runV2AutonomousWorkflow({
  bullswarmDir: f.bullswarmDir, goalDocument: f.goalDocument, pools: [], parentEnv: {},
  initialPlannerResponse: v3Response(program),
  dependencies: { refreshPools: async () => null, dispatchV2Action: dispatch, controlPollMs: 20 }, ...extra,
});
const v3Resume = (f, runId, dispatch) => runV2AutonomousWorkflow({
  bullswarmDir: f.bullswarmDir, resumeRunId: runId, pools: [], parentEnv: {},
  dependencies: { refreshPools: async () => null, dispatchV2Action: dispatch, controlPollMs: 20 },
});
const statusOf = (run, id) => run.state.actions.find((action) => action.id === id)?.status;
const typesOf = (run) => readEvents(run.runDir).map((event) => event.type);
const passedAnswer = { type: 'object', required: ['passed'], properties: { passed: { type: 'boolean' } } };

test('v3, one step: its answer decides it; no scout, planner or review runs, and the run is rolled up', async (t) => {
  const f = v3Setup(t);
  const seen = [];
  const program = { schemaVersion: V3, steps: [{ id: 'count', prompt: 'Count the acme notes.', answer: { type: 'object', required: ['count'], properties: { count: { type: 'integer' } } } }] };
  const run = await v3Launch(f, program, v3Dispatch(() => ({ answer: { count: 3 } }), seen));
  assert.equal(run.result.status, 'completed', run.result.reason);
  assert.deepEqual(seen, ['count']);
  assert.deepEqual(run.state.actions.find((action) => action.id === 'count').answer.value, { count: 3 });
  assert.equal(run.state.preflight.scout.status, 'skipped');
  assert.equal(run.state.planner.attempts.length, 0);
  assert.equal(run.state.verifyLoop ?? null, null, 'a v3 run never opens the repair loop');
  const types = typesOf(run);
  for (const gone of ['preflight.scout_started', 'planner.started', 'workflow.verify-round', 'workflow.repair', 'evidence.recorded']) assert.ok(!types.includes(gone), gone);
  assert.equal(JSON.parse(readFileSync(join(run.runDir, 'features.json'), 'utf8')).programFormat, 3);
  assert.equal(readRollup(run.runDir)?.status, 'completed');
});

test('v3, several steps: dependents run after their dependencies and read their answers', async (t) => {
  const f = v3Setup(t);
  const seen = [];
  const program = {
    schemaVersion: V3,
    steps: [
      { id: 'a', prompt: 'Read the acme notes.', answer: passedAnswer },
      { id: 'b', prompt: 'Read the initech notes.', answer: passedAnswer },
      { id: 'merge', dependsOn: ['a', 'b'], lane: 'build', deliverable: { type: 'files', paths: ['brief.md'] }, prompt: 'Merge both into brief.md.' },
    ],
  };
  const run = await v3Launch(f, program, v3Dispatch((id) => (id === 'merge' ? { write: { 'brief.md': 'acme\n' } } : { answer: { passed: true } }), seen));
  assert.equal(run.result.status, 'completed', run.result.reason);
  assert.deepEqual(seen.slice(0, 2).sort(), ['a', 'b']);
  assert.equal(seen[2], 'merge');
  const task = readFileSync(run.state.attempts.find((attempt) => attempt.actionId === 'merge').taskFile, 'utf8');
  assert.match(task, /Dependency artifacts:/);
  assert.match(task, /"actionId":"a","outputFile":"[^"]+","artifactIds":\[\],"answer":\{"attemptId":"a-1"/);
});

test('v3, add: a step appended to a finished run reopens it and runs in the same run', async (t) => {
  const f = v3Setup(t);
  const seen = [];
  const run = await v3Launch(f, { schemaVersion: V3, steps: [{ id: 'first', prompt: 'Write the acme notes.' }] }, v3Dispatch(() => ({}), seen));
  assert.equal(run.result.status, 'completed', run.result.reason);
  const added = await addV3Steps({
    bullswarmDir: f.bullswarmDir, token: run.runId, fragment: { steps: [{ id: 'second', dependsOn: ['first'], prompt: 'Summarise the acme notes.' }] },
    waitMs: 0, pollMs: 20, relaunch: async () => null,
  });
  assert.equal(added.status, 'applied', JSON.stringify(added));
  const done = await v3Resume(f, run.runId, v3Dispatch(() => ({}), seen));
  assert.equal(done.result.status, 'completed', done.result.reason);
  assert.deepEqual(seen, ['first', 'second']);
});

test('v3, gate plus continue: the run parks at the gate, and continue runs what is behind it', async (t) => {
  const f = v3Setup(t);
  const seen = [];
  const program = {
    schemaVersion: V3,
    steps: [{ id: 'draft', prompt: 'Draft the acme post.' }, { id: 'publish', dependsOn: ['approve'], prompt: 'Publish the acme post.' }],
    gates: [{ id: 'approve', dependsOn: ['draft'], note: 'Read the draft and decide' }],
  };
  const run = await v3Launch(f, program, v3Dispatch(() => ({}), seen));
  assert.equal(run.result, null);
  assert.deepEqual(run.waiting.map((entry) => entry.id), ['approve']);
  assert.equal(statusOf(run, 'publish'), 'pending');
  requestContinue(run.runDir, { nodeId: 'approve' });
  const done = await v3Resume(f, run.runId, v3Dispatch(() => ({}), seen));
  assert.equal(done.result.status, 'completed', done.result.reason);
  assert.deepEqual(seen, ['draft', 'publish']);
});

test('v3, loop: round 2 reruns the loop steps under the same ids until `until` holds', async (t) => {
  const f = v3Setup(t);
  const seen = [];
  const program = {
    schemaVersion: V3,
    steps: [
      { id: 'fix', prompt: 'Fix the acme notes.' },
      { id: 'check', dependsOn: ['fix'], prompt: 'Check the acme notes.', answer: passedAnswer },
    ],
    loops: [{ id: 'polish', steps: ['fix', 'check'], until: { step: 'check', field: 'passed' }, maxRounds: 3 }],
  };
  const run = await v3Launch(f, program, v3Dispatch((id, turn) => (id === 'check' ? { answer: { passed: turn >= 2 } } : {}), seen));
  assert.equal(run.result.status, 'completed', run.result.reason);
  assert.deepEqual(seen, ['fix', 'check', 'fix', 'check']);
  const loop = run.state.controlNodes.find((record) => record.id === 'polish');
  assert.deepEqual([loop.status, loop.round], ['passed', 2]);
});

test('v3, usage limit: the step goes to the caller at once, on no other pool and with no retry', async (t) => {
  const f = v3Setup(t);
  const seen = [];
  const program = { schemaVersion: V3, steps: [{ id: 'work', prompt: 'Write the acme notes.' }, { id: 'side', prompt: 'Write the initech notes.' }] };
  const run = await v3Launch(f, program, v3Dispatch((id) => (id === 'work' ? { fail: 'quota', why: 'usage limit reached' } : {}), seen));
  assert.equal(run.result.status, 'partial');
  assert.equal(statusOf(run, 'work'), 'failed');
  assert.equal(statusOf(run, 'side'), 'succeeded', 'a step that does not depend on it still runs');
  assert.equal(run.state.actions.find((action) => action.id === 'work').lastFailure.kind, 'quota');
  assert.equal(seen.filter((id) => id === 'work').length, 1, 'no retry');
  assert.equal(run.state.attempts.filter((attempt) => attempt.actionId === 'work').length, 1);
});

test('v3, kernel restart: a signalled kernel leaves the run interrupted, and resume runs only what did not finish', async (t) => {
  const f = v3Setup(t);
  const seen = [];
  const program = { schemaVersion: V3, steps: [{ id: 'a', prompt: 'Write the acme notes.' }, { id: 'b', dependsOn: ['a'], prompt: 'Summarise the acme notes.' }] };
  const run = await v3Launch(f, program, v3Dispatch((id) => (id === 'b' ? { signal: true, fail: 'process' } : {}), seen));
  assert.equal(run.result, null);
  assert.equal(run.state.lifecycle.status, 'interrupted');
  assert.equal(statusOf(run, 'a'), 'succeeded');
  const done = await v3Resume(f, run.runId, v3Dispatch(() => ({}), seen));
  assert.equal(done.result.status, 'completed', done.result.reason);
  assert.deepEqual(seen, ['a', 'b', 'b'], 'the finished step is never run again');
  assert.ok(typesOf(done).includes('workflow.resumed'));
});

test('the kernel refuses to resume a run that is not v3: it is view-only, and nothing is written', async (t) => {
  const f = setup();
  t.after(() => rmSync(f.root, { recursive: true, force: true }));
  const v2Program = {
    schemaVersion: 'bullswarm.workflow.planner-response.v2', kind: 'program', summary: 'Write the report.',
    program: { schemaVersion: 'bullswarm.workflow.program.v2', actions: [
      { id: 'write-report', purpose: 'Write report', dependsOn: [], affects: ['report-correct'], ownedFiles: ['report.md'], prompt: 'Write READY to report.md.', lane: 'build', effort: 'low', evidenceFor: [], inputs: [], produces: [] },
    ] },
  };
  const goal = createV2GoalDocument({ goal: 'Deliver a correct report', cwd: f.workspace, requirements: [requirement], settings: { scout: false, plannerMode: 'caller', executionMode: 'program' } });
  const dispatch = fakeDispatch(async (_options, _calls, files) => {
    writeFileSync(join(f.workspace, 'report.md'), 'READY\n');
    writeFileSync(files.outFile, 'wrote report.md');
    return { ok: true, status: 'succeeded', verdict: { ok: true, why: 'verified', outFile: files.outFile, meta: { exitCode: 0 } } };
  });
  const run = await runV2AutonomousWorkflow({ bullswarmDir: f.bullswarmDir, goalDocument: goal, initialPlannerResponse: v2Program, pools: [], runId: 'wf-v2only-abcdef', dependencies: { dispatchV2Action: dispatch, refreshPools: async () => null } });
  assert.equal(JSON.parse(readFileSync(join(run.runDir, 'features.json'), 'utf8')).programFormat, undefined);
  const before = readFileSync(join(run.runDir, 'state.json'), 'utf8');
  const events = readEvents(run.runDir).length;
  await assert.rejects(
    runV2AutonomousWorkflow({ bullswarmDir: f.bullswarmDir, resumeRunId: run.runId, pools: [], dependencies: { dispatchV2Action: dispatch, refreshPools: async () => null } }),
    { message: `run ${run.shortId} was started by an earlier Bullswarm and is view-only; start a new run: bullswarm workflow goal "<goal>" --cwd <run folder> --program <file.json>` },
  );
  assert.equal(readFileSync(join(run.runDir, 'state.json'), 'utf8'), before, 'the refused run is not rewritten');
  assert.equal(readEvents(run.runDir).length, events);
});

test('a requested cancellation still lets the kernel finalize a run that is not v3, and nothing is dispatched', async (t) => {
  const f = setup();
  t.after(() => rmSync(f.root, { recursive: true, force: true }));
  const goal = createV2GoalDocument({ goal: 'Deliver a correct report', cwd: f.workspace, requirements: [requirement], settings: { scout: false, plannerMode: 'caller', executionMode: 'program' } });
  const v2Program = {
    schemaVersion: 'bullswarm.workflow.planner-response.v2', kind: 'program', summary: 'Two steps.',
    program: { schemaVersion: 'bullswarm.workflow.program.v2', actions: ['one', 'two'].map((id, index) => ({
      id, purpose: `Write ${id}`, dependsOn: index ? ['one'] : [], affects: ['report-correct'], ownedFiles: [`${id}.md`], prompt: `Write ${id}.md.`, lane: 'build', effort: 'low', evidenceFor: [], inputs: [], produces: [],
    })) },
  };
  const first = fakeDispatch(async (options, _calls, files) => {
    writeFileSync(join(f.workspace, `${options.action.id}.md`), 'READY\n');
    writeFileSync(files.outFile, 'done');
    if (options.action.id === 'one') process.emit('SIGTERM');
    return { ok: true, status: 'succeeded', verdict: { ok: true, why: 'verified', outFile: files.outFile, meta: { exitCode: 0 } } };
  });
  const run = await runV2AutonomousWorkflow({ bullswarmDir: f.bullswarmDir, goalDocument: goal, initialPlannerResponse: v2Program, pools: [], runId: 'wf-v2canc-abcdef', dependencies: { dispatchV2Action: first, refreshPools: async () => null } });
  assert.equal(run.state.lifecycle.status, 'interrupted');
  writeJsonAtomic(join(run.runDir, 'cancellation.json'), { requested: true, requestedAt: '2026-09-30T01:00:00.000Z', reason: 'the caller cancelled it' });
  const never = fakeDispatch(async () => { throw new Error('a cancelled earlier run dispatches nothing'); });
  const finished = await runV2AutonomousWorkflow({ bullswarmDir: f.bullswarmDir, resumeRunId: run.runId, pools: [], dependencies: { dispatchV2Action: never, refreshPools: async () => null } });
  assert.equal(finished.result.status, 'cancelled');
  assert.equal(never.calls(), 0);
  assert.equal(existsSync(join(run.runDir, 'result.json')), true);
});
