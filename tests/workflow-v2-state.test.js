import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  V2_GOAL_SCHEMA_VERSION, V2_STATE_SCHEMA_VERSION,
  createV2GoalDocument, createV2DurableState, createV2State,
  serializeV2GoalDocument, deserializeV2GoalDocument,
  serializeV2DurableState, deserializeV2DurableState,
  assertV2Resume, validateV2DurableState,
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
  assert.deepEqual(state.planner, { status: 'pending', turns: 0, lastDecision: null, session: null, attempts: [] });
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
