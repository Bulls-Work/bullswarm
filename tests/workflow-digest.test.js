// The `kind: "digest"` action: its closed-list validation rules, which still
// read saved runs, and the kind list `workflow capabilities` reports. 0.38.0
// removed the kernel-written digest task; a caller writes a digest-style step
// as an ordinary v3 step. The CLI cases run under a temporary BULLSWARM_HOME.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  ACTION_KINDS, ActionValidationError, DELIVERABLE_TYPES, KIND_DEFAULTS, KIND_ROLES, ROLES, validateActionProgram,
} from '../src/workflow/action-validator.js';
import { EVIDENCE_TYPES } from '../src/workflow/step-vocabulary.js';
import { v2PlannerContractRules } from '../src/workflow/v2-planner.js';

const REPO = resolve('.');
const CLI = join(REPO, 'bin', 'bullswarm.js');

const writer = (id, over = {}) => ({
  id, purpose: `Deliver ${id}`, dependsOn: [], affects: ['requirement-1'], ownedFiles: [`${id}.txt`],
  prompt: `Implement ${id} and report the focused checks you ran.`, lane: 'build', effort: 'low',
  evidenceFor: [], inputs: [], produces: [], ...over,
});
const digest = (over = {}) => ({
  id: 'condense', purpose: 'Condense the writer outputs', kind: 'digest', dependsOn: ['a1'],
  affects: [], ownedFiles: [], prompt: 'Keep every acceptance number and every shared-file request.',
  evidenceFor: [], inputs: [], produces: [], ...over,
});
const program = (actions) => ({ schemaVersion: 'bullswarm.workflow.program.v2', actions });
const runtime = { requirements: [{ id: 'requirement-1', mandatory: false }] };
const issuesOf = (actions, options = runtime) => {
  try {
    validateActionProgram(program(actions), options);
    return null;
  } catch (error) {
    assert.ok(error instanceof ActionValidationError);
    return error.issues;
  }
};

// --- validation -------------------------------------------------------------

test('digest is a closed-list kind that routes to analyze at low effort', () => {
  assert.deepEqual(KIND_DEFAULTS.digest, { lane: 'analyze', effort: 'low' });
  assert.ok(ACTION_KINDS.includes('digest'));
  const accepted = validateActionProgram(program([writer('a1'), digest()]), runtime);
  const condensed = accepted.actions.find((action) => action.id === 'condense');
  assert.equal(condensed.lane, 'analyze');
  assert.equal(condensed.effort, 'low');
  // A digest delivers no acceptance slice of its own, so empty affects is legal
  // where an ordinary writer would be rejected.
  assert.deepEqual(condensed.affects, []);
  assert.equal(issuesOf([writer('a1', { kind: 'implement', affects: [] })])?.some((issue) => /must affect a requirement/.test(issue)), true);
});

test('a digest must depend on at least one action', () => {
  const issues = issuesOf([writer('a1'), digest({ dependsOn: [] })]);
  assert.ok(issues.some((issue) => /digest actions must depend on at least one action/.test(issue)), issues?.join(' | '));
});

test('a digest must have empty evidenceFor', () => {
  const issues = issuesOf([writer('a1'), digest({ evidenceFor: ['requirement-1'] })]);
  assert.ok(issues.some((issue) => /digest actions must have empty evidenceFor; evidence reads the real artifacts/.test(issue)), issues?.join(' | '));
});

test('a digest is read-only and owns no files', () => {
  const issues = issuesOf([writer('a1'), digest({ ownedFiles: ['notes.md'] })]);
  assert.ok(issues.some((issue) => /digest actions are read-only and must have empty ownedFiles/.test(issue)), issues?.join(' | '));
});

test('no evidence action may depend on a digest', () => {
  const evidence = {
    id: 'judge', purpose: 'Judge the requirement', dependsOn: ['condense', 'a1'], affects: [], ownedFiles: [],
    prompt: 'Inspect the delivered files.', lane: 'analyze', effort: 'low',
    evidenceFor: ['requirement-1'], inputs: [], produces: [],
  };
  const issues = issuesOf([writer('a1'), digest(), evidence]);
  assert.ok(issues.some((issue) => issue === 'evidence action judge must not depend on digest condense; evidence reads the real artifacts'), issues?.join(' | '));
  // The same graph without the digest dependency is accepted.
  assert.equal(issuesOf([writer('a1'), digest(), { ...evidence, dependsOn: ['a1'] }]), null);
});

test('a later revision still sees that a known action was a digest', () => {
  const issues = issuesOf([{
    id: 'judge', purpose: 'Judge the requirement', dependsOn: ['condense'], affects: [], ownedFiles: [],
    prompt: 'Inspect the delivered files.', lane: 'analyze', effort: 'low',
    evidenceFor: ['requirement-1'], inputs: [], produces: [],
  }], {
    ...runtime,
    knownActions: [
      { id: 'a1', dependsOn: [], affects: ['requirement-1'], ownedFiles: ['a1.txt'], evidenceFor: [], produces: [] },
      { id: 'condense', kind: 'digest', dependsOn: ['a1'], affects: [], ownedFiles: [], evidenceFor: [], produces: [] },
    ],
  });
  assert.ok(issues.some((issue) => issue === 'evidence action judge must not depend on digest condense; evidence reads the real artifacts'), issues?.join(' | '));
});

test('the planning contract describes the digest kind in both execution modes', () => {
  for (const executionMode of ['program', 'verified']) {
    const rules = v2PlannerContractRules({ executionMode, plannerMode: 'caller' });
    assert.ok(rules.some((rule) => /digest=analyze\/low/.test(rule)), `${executionMode} kind table must list digest`);
    const rule = rules.find((entry) => /^A `kind: "digest"` action/.test(entry));
    assert.ok(rule, `${executionMode} contract must carry the digest rule`);
    assert.match(rule, /three or more writers feed a single integrator/);
    assert.match(rule, /20 KB/);
    assert.match(rule, /No review step may depend on a digest/);
  }
});

// --- the CLI ----------------------------------------------------------------

// `{bullswarmDir}` in a connector spawn command resolves to the repository root
// (src/lib/watch.js:28), so the shipped echo connector always spawns the
// repository's own deterministic worker; no real provider runs.
function echoHome(t) {
  const root = mkdtempSync(join(tmpdir(), 'bullswarm-digest-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bullswarmDir = join(root, 'home');
  const workspace = join(root, 'repo');
  mkdirSync(join(bullswarmDir, 'connectors'), { recursive: true });
  mkdirSync(workspace);
  const connector = JSON.parse(readFileSync(join(REPO, 'src', 'providers', 'echo', 'connector.json'), 'utf8'));
  writeFileSync(join(bullswarmDir, 'connectors', `${connector.name}.json`), JSON.stringify(connector));
  writeFileSync(join(bullswarmDir, 'state.json'), `${JSON.stringify({
    version: 1, pools: { [connector.name]: { enabled: true } }, incumbents: {}, decisionLog: [],
    config: { depthLimit: 2, callerName: 'claude-code' },
  }, null, 2)}\n`);
  return { root, bullswarmDir, workspace };
}

test('workflow capabilities reports the closed kind list, so digest is discoverable', { timeout: 60_000 }, (t) => {
  const home = echoHome(t);
  const executed = spawnSync(process.execPath, [CLI, 'workflow', 'capabilities'], {
    encoding: 'utf8', timeout: 60_000,
    env: { ...process.env, BULLSWARM_HOME: home.bullswarmDir, BULLSWARM_DEPTH: '0' },
  });
  assert.equal(executed.status, 0, executed.stderr || executed.stdout);
  const kinds = JSON.parse(executed.stdout).engines.autonomousV2.actionKinds;
  // Reported from the validator table, so a future kind needs no edit here.
  assert.deepEqual(kinds, JSON.parse(JSON.stringify(KIND_DEFAULTS)));
  assert.deepEqual(kinds.digest, { lane: 'analyze', effort: 'low' });
});

test('workflow capabilities reports the unchanged kind list; 0.38.0 dropped the role catalog', { timeout: 60_000 }, (t) => {
  const home = echoHome(t);
  const executed = spawnSync(process.execPath, [CLI, 'workflow', 'capabilities'], {
    encoding: 'utf8', timeout: 60_000,
    env: { ...process.env, BULLSWARM_HOME: home.bullswarmDir, BULLSWARM_DEPTH: '0' },
  });
  assert.equal(executed.status, 0, executed.stderr || executed.stdout);
  const engine = JSON.parse(executed.stdout).engines.autonomousV2;
  assert.deepEqual(engine.actionKinds, JSON.parse(JSON.stringify(KIND_DEFAULTS)));
  assert.equal(Object.hasOwn(engine, 'actionRoles'), false);
  assert.deepEqual(engine.deliverableTypes, [...DELIVERABLE_TYPES]);
  assert.deepEqual(engine.evidenceTypes, { types: [...EVIDENCE_TYPES], usable: ['command', 'schema', 'review'], note: 'choice is recorded by bullswarm workflow step accept (never proof)' });
});
