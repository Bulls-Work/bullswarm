import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  V2_GOAL_SCHEMA_VERSION, V2_STATE_SCHEMA_VERSION,
  createV2GoalDocument, createV2DurableState, createV2State,
  serializeV2GoalDocument, deserializeV2GoalDocument,
  serializeV2DurableState, deserializeV2DurableState,
  assertV2Resume, validateV2DurableState, attemptOutputSeries,
} from '../src/workflow/v2-state.js';

const input = () => ({ goal: 'Implement the result envelope', cwd: '/tmp/repo', requirements: [{ id: 'result-versioned', text: 'Result is versioned' }, { id: 'tests-pass', text: 'Tests pass', mandatory: false }], settings: { concurrency: 2 }, plannerRouting: { pool: 'planner' }, workerRouting: { preferredPool: 'worker' } });

test('creates intent-only V2 goal and empty durable state', () => {
  const goal = createV2GoalDocument(input());
  assert.equal(goal.schemaVersion, V2_GOAL_SCHEMA_VERSION);
  assert.equal(goal.intent.goal, input().goal);
  assert.equal(goal.config.settings.concurrency, 2);
  assert.ok(!('phases' in goal) && !('actions' in goal));
  const state = createV2DurableState(goal, { runId: 'wf-1', shortId: 'abc234' });
  assert.equal(state.schemaVersion, V2_STATE_SCHEMA_VERSION);
  assert.deepEqual(state.program, { schemaVersion: 'bullswarm.workflow.program.v2', revision: 0, actions: [] });
  assert.deepEqual(state.presentation, { stages: [] });
  assert.deepEqual(state.actions, []);
  assert.deepEqual(state.attempts, []);
  assert.deepEqual(state.lifecycle, { status: 'queued', startedAt: null, finishedAt: null, resultFile: null });
  assert.deepEqual(state.planner, { status: 'pending', turns: 0, lastDecision: null, session: null, attempts: [], awaiting: null });
  assert.deepEqual(state.events, { sequence: 0, last: null });
  assert.deepEqual(state.preflight, { scout: { status: 'pending', startedAt: null, finishedAt: null, outputFile: null, attempts: [], lastFailure: null } });
  assert.equal(state.ledger.requirements['result-versioned'].status, 'pending');
});

test('accepts the documented suggested plan as bounded planner context', () => {
  const goal = createV2GoalDocument({ ...input(), settings: { concurrency: 2, suggestedPlan: 'Inspect, implement, then verify.' } });
  assert.equal(goal.config.settings.suggestedPlan, 'Inspect, implement, then verify.');
  assert.throws(() => createV2GoalDocument({ ...input(), settings: { suggestedPlan: '' } }), /suggestedPlan must be a non-empty string/);
});

test('round trips and defensively clones all boundaries', () => {
  const source = input(); const goal = createV2GoalDocument(source); source.requirements[0].text = 'changed';
  assert.equal(goal.intent.requirements[0].text, 'Result is versioned');
  const state = createV2State(goal, { runId: 'wf-1', shortId: 'abc234' });
  const goalRoundTrip = deserializeV2GoalDocument(serializeV2GoalDocument(goal));
  const stateRoundTrip = deserializeV2DurableState(serializeV2DurableState(state));
  goalRoundTrip.intent.requirements[0].text = 'changed'; stateRoundTrip.intent.goal = 'changed';
  assert.equal(goal.intent.requirements[0].text, 'Result is versioned');
  assert.equal(state.intent.goal, 'Implement the result envelope');
});

test('round trips explicit cancellation provenance for resume and audit', () => {
  const goal = createV2GoalDocument(input());
  const state = createV2State(goal, { runId: 'wf-1', shortId: 'abc234' });
  state.cancellation = {
    requested: true,
    requestedAt: '2026-09-01T00:00:00.000Z',
    reason: 'operator requested stop',
    source: 'cli',
    requesterPid: 1234,
  };
  const restored = deserializeV2DurableState(serializeV2DurableState(state));
  assert.deepEqual(restored.cancellation, state.cancellation);
  assert.doesNotThrow(() => assertV2Resume(goal, restored, { runId: 'wf-1', shortId: 'abc234' }));
});

test('round trips a progressed durable state', () => {
  const goal = createV2GoalDocument(input());
  const state = createV2State(goal, { runId: 'wf-1', shortId: 'abc234' });
  state.planner = {
    status: 'waiting', turns: 1,
    lastDecision: { kind: 'program-created', summary: 'Inspect the result.' },
    session: {
      pool: 'relay', model: 'gpt-5.6-luna', sessionId: 'session-1', generation: 1,
      startedAt: '2026-08-31T00:59:00.000Z', lastUsedAt: '2026-08-31T01:00:00.000Z',
    },
    attempts: [{
      ordinal: 1, turn: 1, status: 'succeeded', pool: 'relay', model: 'gpt-5.6-luna',
      startedAt: '2026-08-31T00:59:00.000Z', finishedAt: '2026-08-31T01:00:00.000Z',
      taskFile: '/tmp/task.json', outputFile: '/tmp/out.json', usage: { totalTokens: 100 }, continued: false,
    }],
  };
  state.lifecycle = { status: 'running', startedAt: '2026-08-31T00:59:00.000Z', finishedAt: null, resultFile: null };
  state.program = {
    schemaVersion: 'bullswarm.workflow.program.v2',
    revision: 1,
    actions: [{
      id: 'inspect-result', purpose: 'Inspect the result envelope', dependsOn: [],
      affects: [], ownedFiles: [], prompt: 'Inspect the result envelope and return evidence.',
      lane: 'analyze', effort: 'low', evidenceFor: ['result-versioned'], inputs: [], produces: [],
    }],
  };
  state.actions = [{ id: 'inspect-result', status: 'running', attempts: 1, programRevision: 1, startedAt: '2026-08-31T01:00:00.000Z', artifactIds: [] }];
  state.presentation = { stages: [{ id: 'r1-evidence', label: 'Evidence', revision: 1, actionIds: ['inspect-result'], startedAt: '2026-08-31T01:00:00.000Z', completedAt: null }] };
  state.attempts = [{ id: 'inspect-result-1', actionId: 'inspect-result', ordinal: 1, status: 'running', pool: 'relay', model: 'gpt-5.6-luna', startedAt: '2026-08-31T01:00:00.000Z' }];
  state.budget.agents = 1;
  state.usage = { total: 1234, byPool: { relay: 1234 } };
  state.events = { sequence: 1, last: { sequence: 1, type: 'action.started', committedAt: '2026-08-31T01:00:00.000Z' } };
  assert.deepEqual(deserializeV2DurableState(serializeV2DurableState(state)), state);
});

test('rejects malformed, legacy, mismatched, and old-run data before mutation', () => {
  const goal = createV2GoalDocument(input()); const state = createV2DurableState(goal, { runId: 'wf-1', shortId: 'abc234' });
  const before = JSON.stringify(state);
  assert.throws(() => createV2GoalDocument({ ...input(), requirements: [{ id: 'r1', text: 'x' }, { id: 'r1', text: 'y' }] }), /duplicate requirement/);
  assert.throws(() => createV2GoalDocument({ ...input(), requirements: [{ id: 'R1', text: 'x' }] }), /lowercase kebab-case/);
  for (const [key, value] of [
    ['concurrency', 0], ['maxAgents', 0], ['maxActions', 1.5],
    ['maxExpansionRounds', -1], ['maxManifestFiles', 0], ['maxMechanicalRetries', -1],
  ]) {
    assert.throws(() => createV2GoalDocument({ ...input(), settings: { [key]: value } }), new RegExp(key));
  }
  assert.throws(() => createV2GoalDocument({ ...input(), settings: { workspaceMode: 'bogus' } }), /workspaceMode must be shared or isolated/);
  assert.throws(() => createV2GoalDocument({ ...input(), settings: { scout: 'yes' } }), /scout must be a boolean/);
  assert.throws(() => createV2GoalDocument({ ...input(), settings: { surprise: true } }), /surprise is not allowed/);
  assert.throws(() => serializeV2GoalDocument({ ...goal, phases: [] }), /legacy autonomous field/);
  assert.throws(() => serializeV2DurableState({ ...state, repair: {} }), /legacy autonomous field/);
  assert.throws(() => deserializeV2DurableState(JSON.stringify({ ...state, ledger: { schemaVersion: 'bad' } })), /Invalid requirement ledger/);
  assert.throws(() => assertV2Resume({ ...goal, schemaVersion: undefined }, state, { runId: 'wf-1' }), /unsupported old autonomous run/);
  assert.throws(() => assertV2Resume(goal, state, { runId: 'wf-other' }), /runId does not match/);
  assert.throws(() => assertV2Resume({ ...goal, intentId: 'other' }, state), /intentId/);
  assert.throws(() => serializeV2GoalDocument({ ...goal, intent: { ...goal.intent, goal: 'Mutated goal' } }), /intentId does not match/);
  assert.equal(JSON.stringify(state), before);
  assert.equal(validateV2DurableState(state), true);
});

test('rejects schema mismatch and graph-shaped state fields', () => {
  const goal = createV2GoalDocument(input()); const state = createV2DurableState(goal, { runId: 'wf-1', shortId: 'abc234' });
  assert.throws(() => serializeV2GoalDocument({ ...goal, schemaVersion: 'bullswarm.workflow.v1' }), /schemaVersion/);
  assert.throws(() => serializeV2DurableState({ ...state, schemaVersion: 'bullswarm.workflow.state.v1' }), /schemaVersion/);
  assert.throws(() => serializeV2DurableState({ ...state, program: { schemaVersion: 'bullswarm.workflow.program.v2', revision: 1, actions: [] } }), /empty state.program/);
  assert.throws(() => serializeV2DurableState({ ...state, actions: [{ id: 'unknown', status: 'running', attempts: 1 }] }), /unknown program action/);
  assert.throws(() => serializeV2DurableState({ ...state, lifecycle: { status: 'running', startedAt: null, finishedAt: '2026-08-31T01:00:00Z', resultFile: null } }), /terminal status/);
  assert.throws(() => serializeV2DurableState({ ...state, planner: { ...state.planner, session: { pool: 'relay', model: 'luna', sessionId: '', generation: 0, startedAt: null, lastUsedAt: null } } }), /non-empty string/);
  assert.throws(() => serializeV2DurableState({ ...state, events: { sequence: 1, last: null } }), /last is required/);
  const progressed = createV2State(goal, { runId: 'wf-1', shortId: 'abc234' });
  progressed.program = { schemaVersion: 'bullswarm.workflow.program.v2', revision: 1, actions: [{ id: 'inspect', purpose: 'Inspect', dependsOn: [], affects: [], ownedFiles: [], prompt: 'Inspect.', lane: 'analyze', effort: 'low', evidenceFor: ['result-versioned'], inputs: [], produces: [] }] };
  assert.throws(() => serializeV2DurableState(progressed), /missing program action inspect/);
  progressed.actions = [{ id: 'inspect', status: 'pending', attempts: 1, programRevision: 1 }];
  progressed.presentation = { stages: [{ id: 'r1-evidence', label: 'Evidence', revision: 1, actionIds: ['inspect'], startedAt: null, completedAt: null }] };
  assert.throws(() => serializeV2DurableState(progressed), /does not match durable attempt records/);
});

test('durable state carries program advisories, validates their shape, and tolerates their absence', () => {
  const goal = createV2GoalDocument(input());
  const state = createV2DurableState(goal, { runId: 'wf-adv', shortId: 'adv234' });
  assert.deepEqual(state.advisories, []);
  state.advisories = [
    { code: 'all-writers-high', actionId: null, message: 'all 3 build/chore actions run at high effort' },
    { code: 'docs-at-high', actionId: 'write-docs', message: 'owns only markdown files at high effort' },
  ];
  assert.equal(validateV2DurableState(state), true);
  assert.deepEqual(deserializeV2DurableState(serializeV2DurableState(state)).advisories, state.advisories);
  for (const [bad, message] of [
    [{ code: 'made-up', actionId: null, message: 'x' }, /code must be all-writers-high\|docs-at-high/],
    [{ code: 'docs-at-high', actionId: null, message: '' }, /message must be a non-empty string/],
    [{ code: 'docs-at-high', actionId: 7, message: 'x' }, /actionId must be null or a non-empty string/],
    [{ code: 'docs-at-high', actionId: null, message: 'x', extra: 1 }, /extra is not allowed/],
  ]) {
    assert.throws(() => validateV2DurableState({ ...state, advisories: [bad] }), message, JSON.stringify(bad));
  }
  assert.throws(() => validateV2DurableState({ ...state, advisories: 'none' }), /state.advisories must be an array/);
  // Runs written before advisories existed have no field at all and must
  // still load rather than fail schema validation on resume.
  const legacy = { ...state };
  delete legacy.advisories;
  assert.equal(validateV2DurableState(legacy), true);
});

test('round trips attempt handoff fields and rejects unknown ones', () => {
  const goal = createV2GoalDocument(input());
  const state = createV2DurableState(goal, { runId: 'wf-handoff', shortId: 'hnd234' });
  state.program = {
    schemaVersion: 'bullswarm.workflow.program.v2', revision: 1,
    actions: [{
      id: 'do-work', purpose: 'Do the thing', dependsOn: [], affects: ['result-versioned'], ownedFiles: ['owned.txt'],
      prompt: 'Do the thing.', lane: 'build', effort: 'low', evidenceFor: [], inputs: [], produces: [],
    }],
  };
  state.actions = [{ id: 'do-work', status: 'succeeded', attempts: 2, programRevision: 1 }];
  state.presentation = { stages: [{ id: 'r1-evidence', label: 'Evidence', revision: 1, actionIds: ['do-work'], startedAt: null, completedAt: null }] };
  state.attempts = [{
    id: 'do-work-1', actionId: 'do-work', ordinal: 1, status: 'interrupted',
    pool: 'staller', model: 'zen/union-free', startedAt: '2026-09-17T02:30:20.000Z',
    finishedAt: '2026-09-17T02:30:28.000Z', failureKind: 'stalled',
    why: 'stalled: the worker wrote nothing for 8 s and was stopped',
    outputFile: '/tmp/out-do-work-attempt-1.md', outputBytes: 88,
    streamFile: '/tmp/stream-do-work-attempt-1.jsonl',
    diffFile: '/tmp/diff-do-work-attempt-1.txt', changedFileCount: 1,
    lastResponse: 'Read the task file and enumerated 3 candidate files.',
    notes: [{ at: '2026-09-17T02:30:28.000Z', kind: 'recovered-stream-error', text: 'provider stream reported error' }],
    outputSamples: [[1726540220000, 64], [1726540228000, 88]],
    stalled: true, partialOutput: '/tmp/out-do-work-attempt-1.md', silentSec: 8,
  }, {
    id: 'do-work-2', actionId: 'do-work', ordinal: 2, status: 'succeeded',
    pool: 'answerer', model: 'paid/answerer', startedAt: '2026-09-17T02:30:29.000Z',
    finishedAt: '2026-09-17T02:30:30.000Z',
    handoff: { from: 'do-work-1', bytes: 512 },
  }];
  const loaded = deserializeV2DurableState(JSON.stringify(state));
  assert.equal(loaded.attempts[0].outputBytes, 88);
  assert.equal(loaded.attempts[0].streamFile, '/tmp/stream-do-work-attempt-1.jsonl');
  assert.equal(loaded.attempts[0].diffFile, '/tmp/diff-do-work-attempt-1.txt');
  assert.equal(loaded.attempts[0].changedFileCount, 1);
  assert.equal(loaded.attempts[0].lastResponse, 'Read the task file and enumerated 3 candidate files.');
  assert.equal(loaded.attempts[0].notes[0].kind, 'recovered-stream-error');
  assert.deepEqual(loaded.attempts[0].outputSamples, [[1726540220000, 64], [1726540228000, 88]]);
  assert.deepEqual(loaded.attempts[1].handoff, { from: 'do-work-1', bytes: 512 });
  assert.throws(
    () => deserializeV2DurableState(JSON.stringify({
      ...state,
      attempts: [
        state.attempts[0],
        { ...state.attempts[1], handoff: { from: 'do-work-1', bytes: 512, extra: true } },
      ],
    })),
    /handoff.extra is not allowed/,
  );
});

test('attempt output series prefers timestamped stream sizes and falls back to durable samples', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bullswarm-output-series-'));
  try {
    const streamFile = join(dir, 'stream.jsonl');
    writeFileSync(streamFile, [
      { at: '2026-09-18T00:00:00.000Z', bytes: 12 },
      { at: '2026-09-18T00:00:05.000Z', bytes: 48 },
    ].map((row) => JSON.stringify(row)).join('\n') + '\n');
    assert.deepEqual(attemptOutputSeries({ streamFile, outputSamples: [[1, 2]] }, dir), [
      [Date.parse('2026-09-18T00:00:00.000Z'), 12],
      [Date.parse('2026-09-18T00:00:05.000Z'), 48],
    ]);
    rmSync(streamFile);
    assert.deepEqual(attemptOutputSeries({ streamFile, outputSamples: [[1, 2], [5, 8]] }, dir), [[1, 2], [5, 8]]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('round trips the attempt provider session and rejects a malformed one', () => {
  const goal = createV2GoalDocument(input());
  const state = createV2DurableState(goal, { runId: 'wf-session', shortId: 'ses234' });
  state.program = {
    schemaVersion: 'bullswarm.workflow.program.v2', revision: 1,
    actions: [{
      id: 'do-work', purpose: 'Do the thing', dependsOn: [], affects: ['result-versioned'], ownedFiles: ['owned.txt'],
      prompt: 'Do the thing.', lane: 'build', effort: 'low', evidenceFor: [], inputs: [], produces: [],
    }],
  };
  state.actions = [{ id: 'do-work', status: 'succeeded', attempts: 2, programRevision: 1 }];
  state.presentation = { stages: [{ id: 'r1-build', label: 'Build', revision: 1, actionIds: ['do-work'], startedAt: null, completedAt: null }] };
  state.attempts = [{
    id: 'do-work-1', actionId: 'do-work', ordinal: 1, status: 'succeeded',
    pool: 'claude-code', model: 'claude-opus-5',
    startedAt: '2026-09-18T02:30:20.000Z', finishedAt: '2026-09-18T02:34:05.000Z',
    session: {
      pool: 'claude-code', model: 'claude-opus-5',
      sessionId: '0f6a4f2e-9c3b-4d1a-9f21-5c8e7b6a4d33', generation: 1,
      startedAt: '2026-09-18T02:30:20.000Z', lastUsedAt: '2026-09-18T02:34:05.000Z',
    },
  }, {
    id: 'do-work-2', actionId: 'do-work', ordinal: 2, status: 'succeeded',
    pool: 'codex', model: 'gpt-5.4-codex',
    startedAt: '2026-09-18T02:34:06.000Z', finishedAt: '2026-09-18T02:36:00.000Z',
    session: null,
  }];
  const loaded = deserializeV2DurableState(serializeV2DurableState(state));
  assert.deepEqual(loaded.attempts[0].session, state.attempts[0].session);
  assert.equal(loaded.attempts[1].session, null);
  // An attempt recorded before measured usage capture carries no session at all.
  const legacy = { ...state, attempts: state.attempts.map(({ session, ...rest }) => rest) };
  assert.equal(validateV2DurableState(legacy), true);
  assert.throws(
    () => deserializeV2DurableState(JSON.stringify({
      ...state,
      attempts: [{ ...state.attempts[0], session: { ...state.attempts[0].session, extra: true } }, state.attempts[1]],
    })),
    /session.extra is not allowed/,
  );
  assert.throws(
    () => deserializeV2DurableState(JSON.stringify({
      ...state,
      attempts: [{ ...state.attempts[0], session: { ...state.attempts[0].session, sessionId: 42 } }, state.attempts[1]],
    })),
    /session.sessionId must be a non-empty string/,
  );
  assert.throws(
    () => deserializeV2DurableState(JSON.stringify({
      ...state,
      attempts: [{ ...state.attempts[0], session: { ...state.attempts[0].session, generation: 0 } }, state.attempts[1]],
    })),
    /session.generation must be a positive integer/,
  );
});
