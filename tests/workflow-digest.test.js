// The `kind: "digest"` action: its closed-list validation rules, the
// kernel-owned extractive task the runtime writes for it, and the `digestOf`
// drill-down its consumers receive. The end-to-end case runs the real CLI with
// the shipped echo worker under a temporary BULLSWARM_HOME.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  ACTION_KINDS, ActionValidationError, KIND_DEFAULTS, validateActionProgram,
} from '../src/workflow/action-validator.js';
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
    assert.match(rule, /No evidence action may depend on a digest/);
  }
});

// --- end to end -------------------------------------------------------------

// `{bullswarmDir}` in a connector spawn command resolves to the repository root
// (src/lib/watch.js:28), so the shipped echo connector always spawns the
// repository's own deterministic worker. Passing `worker` installs an equally
// deterministic local worker instead — still no real provider.
function echoHome(t, { worker = null } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'bullswarm-digest-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bullswarmDir = join(root, 'home');
  const workspace = join(root, 'repo');
  mkdirSync(join(bullswarmDir, 'connectors'), { recursive: true });
  mkdirSync(workspace);
  const connector = JSON.parse(readFileSync(join(REPO, 'connectors', 'echo.json'), 'utf8'));
  if (worker) {
    const workerPath = join(root, 'worker.mjs');
    writeFileSync(workerPath, worker);
    connector.name = 'local';
    connector.spawn = { cmd: ['node', workerPath, '{taskFile}'], cwdMode: 'task-file-dir' };
  }
  writeFileSync(join(bullswarmDir, 'connectors', `${connector.name}.json`), JSON.stringify(connector));
  writeFileSync(join(bullswarmDir, 'state.json'), `${JSON.stringify({
    version: 1, pools: { [connector.name]: { enabled: true } }, incumbents: {}, decisionLog: [],
    config: { depthLimit: 2, callerName: 'claude-code' },
  }, null, 2)}\n`);
  return { root, bullswarmDir, workspace };
}

const dependencyArtifactsIn = (taskText) => JSON.parse(taskText.match(/Dependency artifacts:\n(\[.*\])/)[1]);

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

test('three writers → digest → integrator: the integrator reads only the digest and can drill down', { timeout: 120_000 }, (t) => {
  const home = echoHome(t);
  const actions = [
    writer('a1'), writer('a2'), writer('a3'),
    digest({ dependsOn: ['a1', 'a2', 'a3'] }),
    writer('integrate', { dependsOn: ['condense'], ownedFiles: [], prompt: 'Apply every request the digest carries and run the repository gates.' }),
  ];
  const programPath = join(home.root, 'program.json');
  writeFileSync(programPath, JSON.stringify(program(actions)));
  const executed = spawnSync(process.execPath, [
    CLI, 'workflow', 'goal', 'Deliver three slices, condense them, then integrate.',
    '--cwd', home.workspace, '--program', programPath, '--concurrency', '3', '--foreground', '--json',
  ], {
    encoding: 'utf8', timeout: 120_000,
    env: { ...process.env, BULLSWARM_HOME: home.bullswarmDir, BULLSWARM_DEPTH: '0' },
  });
  assert.equal(executed.status, 0, executed.stderr || executed.stdout);
  const result = JSON.parse(executed.stdout);
  assert.equal(result.status, 'completed');
  assert.equal(result.actions.find((action) => action.id === 'condense').kind, 'digest');

  const state = JSON.parse(readFileSync(join(home.bullswarmDir, 'workflows', result.runId, 'state.json'), 'utf8'));
  const attemptFor = (id) => state.attempts.findLast((attempt) => attempt.actionId === id);
  const sources = ['a1', 'a2', 'a3'].map(attemptFor);
  const condense = attemptFor('condense');
  const integrate = attemptFor('integrate');

  // The digest read every writer output; the integrator read only the digest.
  const sourceBytes = sources.reduce((total, attempt) => total + statSync(attempt.outputFile).size, 0);
  assert.equal(condense.bytes.dependencyInputs, sourceBytes);
  assert.equal(integrate.bytes.dependencyInputs, statSync(condense.outputFile).size);
  assert.ok(integrate.bytes.dependencyInputs < sourceBytes, 'the integrator must read less than the raw outputs');

  // Its dependency artifact entry still names every digested source.
  const artifacts = dependencyArtifactsIn(readFileSync(integrate.taskFile, 'utf8'));
  assert.equal(artifacts.length, 1);
  assert.equal(artifacts[0].actionId, 'condense');
  assert.equal(artifacts[0].outputFile, condense.outputFile);
  assert.deepEqual(artifacts[0].digestOf, sources.map((attempt) => ({ actionId: attempt.actionId, outputFile: attempt.outputFile })));

  // The kernel owns the digest's task: extractive rules, a byte target derived
  // from the real input size, and the author's prompt as focus guidance only.
  const digestTask = readFileSync(condense.taskFile, 'utf8');
  assert.match(digestTask, /^Bullswarm digest action: condense$/m);
  assert.match(digestTask, /^This action is read-only\. Do not modify workspace files\.$/m);
  assert.match(digestTask, /Read every dependency output above in full/);
  assert.match(digestTask, /Quote verbatim; never paraphrase and never judge/);
  assert.match(digestTask, /No verdicts, no recommendations, no new claims, and no work of your own/);
  assert.match(digestTask, /one section per source, headed by that source's absolute output path/);
  assert.equal(digestTask.includes(`Target at most 8192 bytes in total (a quarter of the ${sourceBytes} bytes of dependency output you were handed, or 8 KB, whichever is larger)`), true, digestTask);
  assert.match(digestTask, /Focus guidance from the program author \(scope only\):\nKeep every acceptance number and every shared-file request\./);
  const digestArtifacts = dependencyArtifactsIn(digestTask);
  assert.deepEqual(digestArtifacts.map((entry) => entry.actionId), ['a1', 'a2', 'a3']);
  for (const entry of digestArtifacts) assert.equal(Object.hasOwn(entry, 'digestOf'), false, 'a plain writer output is not a digest');
  // A digest carries no requirement text, so nothing is deducted from kernel.
  assert.equal(condense.bytes.kernel, condense.bytes.taskFile - condense.bytes.authorPrompt);
});

test('a digest handed more than 32 KB of dependency output targets a quarter of it', { timeout: 120_000 }, (t) => {
  // The shipped echo worker answers with a fixed ~400-byte completion, so the
  // 8 KB floor always wins there. This local worker pads its answer to the size
  // the task file asks for, which is the only way to observe the other branch.
  const home = echoHome(t, {
    worker: [
      "import { readFileSync } from 'node:fs';",
      "const task = readFileSync(process.argv[2], 'utf8');",
      "const pad = Number(task.match(/PAD:(\\d+)/)?.[1] ?? 0);",
      "process.stdout.write('## Completed\\n\\nDelivered the requested slice and validated it.\\n' + 'y'.repeat(pad));",
    ].join('\n'),
  });
  const actions = [writer('a1', { prompt: 'Deliver a1 and report it. PAD:60000' }), digest()];
  const programPath = join(home.root, 'program.json');
  writeFileSync(programPath, JSON.stringify(program(actions)));
  const executed = spawnSync(process.execPath, [
    CLI, 'workflow', 'goal', 'Deliver one large slice, then condense it.',
    '--cwd', home.workspace, '--program', programPath, '--foreground', '--json',
  ], {
    encoding: 'utf8', timeout: 120_000,
    env: { ...process.env, BULLSWARM_HOME: home.bullswarmDir, BULLSWARM_DEPTH: '0' },
  });
  assert.equal(executed.status, 0, executed.stderr || executed.stdout);
  const result = JSON.parse(executed.stdout);
  const state = JSON.parse(readFileSync(join(home.bullswarmDir, 'workflows', result.runId, 'state.json'), 'utf8'));
  const source = state.attempts.findLast((attempt) => attempt.actionId === 'a1');
  const condense = state.attempts.findLast((attempt) => attempt.actionId === 'condense');
  assert.equal(condense.bytes.dependencyInputs, statSync(source.outputFile).size);
  assert.ok(condense.bytes.dependencyInputs > 32_768, `dependency input must clear the 8 KB floor, got ${condense.bytes.dependencyInputs}`);
  const budget = Math.round(condense.bytes.dependencyInputs / 4);
  assert.ok(readFileSync(condense.taskFile, 'utf8').includes(`Target at most ${budget} bytes in total (a quarter of the ${condense.bytes.dependencyInputs} bytes`));
});
