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
  assert.deepEqual(state.actions, []);
  assert.deepEqual(state.attempts, []);
  assert.equal(state.ledger.requirements['result-versioned'].status, 'pending');
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

test('round trips a progressed durable state', () => {
  const goal = createV2GoalDocument(input());
  const state = createV2State(goal, { runId: 'wf-1', shortId: 'abc234' });
  state.planner = { status: 'waiting', turns: 1, lastDecision: { kind: 'program-created', summary: 'Inspect the result.' } };
  state.program = {
    schemaVersion: 'bullswarm.workflow.program.v2',
    revision: 1,
    actions: [{
      id: 'inspect-result', purpose: 'Inspect the result envelope', dependsOn: [],
      affects: [], ownedFiles: [], prompt: 'Inspect the result envelope and return evidence.',
      lane: 'analyze', effort: 'low', evidenceFor: ['result-versioned'], inputs: [], produces: [],
    }],
  };
  state.actions = [{ id: 'inspect-result', status: 'running', attempts: 1, startedAt: '2026-08-31T01:00:00.000Z', artifactIds: [] }];
  state.attempts = [{ id: 'inspect-result-1', actionId: 'inspect-result', ordinal: 1, status: 'running', pool: 'relay', model: 'gpt-5.6-luna', startedAt: '2026-08-31T01:00:00.000Z' }];
  state.budget.agents = 1;
  state.usage = { total: 1234, byPool: { relay: 1234 } };
  assert.deepEqual(deserializeV2DurableState(serializeV2DurableState(state)), state);
});

test('rejects malformed, legacy, mismatched, and old-run data before mutation', () => {
  const goal = createV2GoalDocument(input()); const state = createV2DurableState(goal, { runId: 'wf-1', shortId: 'abc234' });
  const before = JSON.stringify(state);
  assert.throws(() => createV2GoalDocument({ ...input(), requirements: [{ id: 'r1', text: 'x' }, { id: 'r1', text: 'y' }] }), /duplicate requirement/);
  assert.throws(() => createV2GoalDocument({ ...input(), requirements: [{ id: 'R1', text: 'x' }] }), /lowercase kebab-case/);
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
});
