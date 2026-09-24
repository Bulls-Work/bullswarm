// Stage 1 presentation for steps that store a role (spec section 4,
// "Presentation"; tests per section 6). Every change applies only when the
// stored action has a role, so kind-only steps read exactly as before.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { applyEvidence } from '../src/workflow/ledger.js';
import { createV2GoalDocument, createV2State } from '../src/workflow/v2-state.js';
import {
  createV2ResultEnvelope, deserializeV2ResultEnvelope, serializeV2ResultEnvelope, summarizeV2Result,
} from '../src/workflow/v2-outcome.js';
import { runTimelineFacts } from '../src/workflow/run-model.js';
import { deriveV2DependencyStages } from '../src/workflow/v2-presentation.js';
import { actionRoleLabel } from '../src/workflow/dashboard.js';
import { stepPageModel } from '../src/workflow/step-model.js';
import { renderStepPage } from '../src/workflow/step-view.js';

const ROOT = resolve(new URL('..', import.meta.url).pathname);
const BIN = join(ROOT, 'bin', 'bullswarm.js');

const goal = () => createV2GoalDocument({
  goal: 'Draft and send the acme release note', cwd: '/tmp/acme', settings: { concurrency: 2, workspaceMode: 'shared', executionMode: 'program' },
  requirements: [{ id: 'note-sent', text: 'The release note reached the acme list' }],
});

// Three levels: a role-only produce step, a role-only act step, then a
// kind-only check step with evidence.
function roleState() {
  const state = createV2State(goal(), { runId: 'wf-acme-roles', shortId: 'rol234' });
  state.lifecycle = { status: 'completed', startedAt: '2026-09-24T01:00:00Z', finishedAt: '2026-09-24T01:10:00Z', resultFile: null };
  state.planner = { status: 'waiting', turns: 1, lastDecision: { kind: 'program-created' }, session: null, attempts: [] };
  state.program = {
    schemaVersion: 'bullswarm.workflow.program.v2', revision: 1,
    actions: [
      { id: 'draft-note', purpose: 'Draft the note', dependsOn: [], affects: ['note-sent'], ownedFiles: ['note.md'], prompt: 'Write note.md.', role: 'produce', lane: 'build', effort: 'medium', deliverable: { type: 'files' }, evidenceFor: [], inputs: [], produces: [] },
      { id: 'send-note', purpose: 'Send the note', dependsOn: ['draft-note'], affects: ['note-sent'], ownedFiles: [], prompt: 'Send note.md to the list at example.com.', role: 'act', lane: 'analyze', effort: 'medium', deliverable: { type: 'outward' }, evidenceFor: [], inputs: [], produces: [] },
      { id: 'check-note', purpose: 'Check the send', dependsOn: ['send-note'], affects: [], ownedFiles: [], prompt: 'Check the note was sent.', kind: 'check', lane: 'analyze', effort: 'medium', evidenceFor: ['note-sent'], inputs: [], produces: [] },
    ],
  };
  state.actions = ['draft-note', 'send-note', 'check-note'].map((id) => ({
    id, status: 'succeeded', attempts: 0, programRevision: 1, workRevision: 'initial', startedAt: null, finishedAt: null, outputFile: null, artifactIds: [], lastFailure: null,
  }));
  state.presentation = { stages: deriveV2DependencyStages(state.program.actions, 1) };
  state.ledger = applyEvidence(state.ledger, {
    actionId: 'check-note', evidenceFor: ['note-sent'], inspectedRevision: 'initial', eventSequence: 1,
  }, { requirements: { 'note-sent': { status: 'passed', evidence: ['the list archive shows the note'], concerns: [] } } });
  return state;
}

test('phase names read the role for a role-only step: Produce, Act, then the kind name for a kind step', () => {
  const state = roleState();
  const row = { runId: state.runId, shortId: state.shortId, state, status: 'completed' };
  assert.deepEqual(runTimelineFacts(row).phases.map((phase) => phase.kindName), ['Produce', 'Act', 'Check']);
});

test('actionRoleLabel reads kind, then role, then the existing fallbacks', () => {
  assert.equal(actionRoleLabel({ id: 'send-note', role: 'act', lane: 'analyze' }), 'act');
  assert.equal(actionRoleLabel({ id: 'build', kind: 'implement', role: 'produce', lane: 'build' }), 'implement');
  assert.equal(actionRoleLabel({ id: 'evidence', evidenceFor: ['note-sent'] }), 'evidence');
  assert.equal(actionRoleLabel({ id: 'lane-only', lane: 'build' }), 'work');
  assert.equal(actionRoleLabel({ id: 'bare' }), 'action');
});

test('the envelope and the summary rows carry role only for role steps', () => {
  const state = roleState();
  const result = createV2ResultEnvelope(state, { finishedAt: '2026-09-24T01:10:00Z' });
  assert.deepEqual(deserializeV2ResultEnvelope(serializeV2ResultEnvelope(result)), result);
  const byId = Object.fromEntries(result.actions.map((action) => [action.id, action]));
  assert.equal(byId['draft-note'].role, 'produce');
  assert.equal(byId['send-note'].role, 'act');
  assert.equal(Object.hasOwn(byId['check-note'], 'role'), false);
  assert.equal(byId['check-note'].kind, 'check');
  // Role sits right after kind, so a kind-only row keeps its key order.
  assert.deepEqual(Object.keys(byId['draft-note']).slice(3, 7), ['outputFile', 'artifactIds', 'reasoning', 'kind']);
  assert.equal(Object.keys(byId['draft-note'])[7], 'role');

  const summary = summarizeV2Result(result, state);
  const rows = Object.fromEntries(summary.actions.map((action) => [action.id, action]));
  assert.equal(rows['draft-note'].role, 'produce');
  assert.equal(rows['send-note'].role, 'act');
  assert.equal(Object.hasOwn(rows['check-note'], 'role'), false);
  // The summary also reads the role from state when an older envelope lacks it.
  const stripped = structuredClone(result);
  for (const action of stripped.actions) delete action.role;
  assert.equal(summarizeV2Result(stripped, state).actions.find((action) => action.id === 'send-note').role, 'act');
  assert.equal(summarizeV2Result(stripped).actions.some((action) => Object.hasOwn(action, 'role')), false);

  const bad = structuredClone(result);
  bad.actions[0].role = '';
  assert.throws(() => serializeV2ResultEnvelope(bad), /actions\[0\]\.role must be a non-empty string/);
});

test('verifyRounds accepts act-step as a stop reason', () => {
  const state = roleState();
  const result = createV2ResultEnvelope(state, { finishedAt: '2026-09-24T01:10:00Z' });
  const withLoop = {
    ...result,
    verifyRounds: { max: 3, used: 1, stoppedBy: 'act-step', phases: [] },
    callerDecision: null,
  };
  assert.throws(() => serializeV2ResultEnvelope({ ...withLoop, verifyRounds: { ...withLoop.verifyRounds, stoppedBy: 'acme' } }), /verifyRounds\.stoppedBy is invalid/);
  assert.doesNotThrow(() => serializeV2ResultEnvelope(withLoop));
});

test('runs show prints "role act" beside a role step and nothing new beside a kind step', (t) => {
  const home = mkdtempSync(join(tmpdir(), 'bullswarm-role-views-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const state = roleState();
  const runDir = join(home, 'workflows', state.runId);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, 'state.json'), `${JSON.stringify(state, null, 2)}\n`);
  const run = spawnSync(process.execPath, [BIN, 'workflow', 'runs', 'show', state.runId], {
    cwd: ROOT, env: { ...process.env, BULLSWARM_HOME: home }, encoding: 'utf8',
  });
  assert.equal(run.status, 0, run.stderr);
  const lines = run.stdout.split('\n');
  assert.ok(lines.includes(`  ${'draft-note'.padEnd(24)} build/medium  role produce  succeeded`), run.stdout);
  assert.ok(lines.includes(`  ${'send-note'.padEnd(24)} analyze/medium  role act  succeeded`), run.stdout);
  assert.ok(lines.includes(`  ${'check-note'.padEnd(24)} analyze/medium  kind check  succeeded`), run.stdout);
});

test('the step page task card names the role only when the step has no kind', () => {
  const state = roleState();
  const row = { runId: state.runId, shortId: state.shortId, state, status: 'completed' };
  const taskRule = (actionId) => {
    const step = stepPageModel({ row, assignments: [], pools: [] }, { actionId, nowMs: Date.parse('2026-09-24T01:20:00Z') });
    const body = [];
    renderStepPage(step, { width: 120 }, body);
    return { task: step.presentation.task, rule: body.map(String).find((line) => line.includes('task ·')) ?? '' };
  };
  const act = taskRule('send-note');
  assert.equal(act.task.role, 'act');
  assert.match(act.rule, /task · act · analyze lane/);
  const check = taskRule('check-note');
  assert.equal(Object.hasOwn(check.task, 'role'), false);
  assert.match(check.rule, /task · check · analyze lane/);
});
