// blindTo (0.38.3): a v3 step judges the work of the upstream steps it names
// without their own account of it. Their output file and checked answer are
// left out of its task and of a loop's Previous round block; the dependency
// still orders it. Validation follows route.independentOf. Made-up names only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { validateActionProgram } from '../src/workflow/action-validator.js';
import { createV2GoalDocument } from '../src/workflow/v2-state.js';
import { runV2AutonomousWorkflow } from '../src/workflow/v2-runtime.js';
import { dispatchV2Action } from '../src/workflow/v2-dispatch.js';
import { PROGRAM_V3_SCHEMA_VERSION, implicitV3Requirements, normaliseProgramV3 } from '../src/workflow/program-v3.js';
import { buildV3Contract } from '../src/workflow/contract-v3.js';
import { addV3Steps } from '../src/workflow/cli-steps.js';
import { v2V3Fixtures } from './fixtures/program-v3-fixtures.mjs';

const cli = resolve('bin/bullswarm.js');
const V3 = PROGRAM_V3_SCHEMA_VERSION;
const passedAnswer = { type: 'object', required: ['passed'], properties: { passed: { type: 'boolean' } } };
const summaryAnswer = { type: 'object', required: ['summary'], properties: { summary: { type: 'string' } } };

function issuesOf(fn) {
  try { fn(); } catch (error) { return Array.isArray(error?.issues) ? error.issues : [error.message]; }
  return [];
}

// build, a step after it, and a review two steps down that is blind to build.
const reviewProgram = (review = {}) => ({
  schemaVersion: V3,
  steps: [
    { id: 'build', prompt: 'Write the acme summary.', answer: summaryAnswer },
    { id: 'lint', dependsOn: ['build'], prompt: 'Lint the acme summary.' },
    { id: 'review', dependsOn: ['lint'], blindTo: ['build'], prompt: 'Review the acme summary.', answer: passedAnswer, ...review },
  ],
});

// --- validation ----------------------------------------------------------------

test('a program with blindTo validates, keeps it on the stored step, and normalises to itself', () => {
  const normal = normaliseProgramV3(reviewProgram({ dependsOn: ['lint', 'build'], blindTo: ['lint', 'build'] }));
  const review = normal.steps.find((step) => step.id === 'review');
  assert.deepEqual(review.blindTo, ['build', 'lint']);
  assert.deepEqual(review.dependsOn, ['lint', 'build'], 'dependsOn is unchanged');
  assert.equal(review.route, undefined, 'blindTo implies no route');
  assert.equal(normal.steps.find((step) => step.id === 'build').blindTo, undefined);
  const stored = { schemaVersion: V3, actions: normal.steps, control: { gates: normal.gates, loops: normal.loops } };
  assert.deepEqual(normaliseProgramV3(stored).steps, normal.steps);
  // Upstream through a gate or a loop counts too.
  const throughGate = {
    schemaVersion: V3,
    steps: [
      { id: 'build', prompt: 'Write it.' },
      { id: 'review', dependsOn: ['hold'], blindTo: ['build'], prompt: 'Review it.' },
    ],
    gates: [{ id: 'hold', dependsOn: ['build'] }],
  };
  assert.deepEqual(normaliseProgramV3(throughGate).steps[1].blindTo, ['build']);
  // An empty list says nothing and is dropped.
  assert.equal(normaliseProgramV3(reviewProgram({ blindTo: [] })).steps[2].blindTo, undefined);
});

test('each invalid blindTo is refused with an issue that names the step', () => {
  const cases = [
    [{ blindTo: 'build' }, 'steps[2].blindTo must be an array of step ids'],
    [{ blindTo: [3] }, 'steps[2].blindTo must be an array of step ids'],
    [{ blindTo: ['build', 'build'] }, 'steps[2].blindTo names "build" twice'],
    [{ blindTo: ['nowhere'] }, 'steps[2].blindTo names "nowhere", which is not a step in this program'],
    [{ blindTo: ['review'] }, 'steps[2].blindTo cannot name the step itself'],
  ];
  for (const [over, issue] of cases) {
    const issues = issuesOf(() => normaliseProgramV3(reviewProgram(over)));
    assert.ok(issues.includes(issue), `${issue} not in ${JSON.stringify(issues)}`);
  }
  // A step that does not run before it: a sibling, and a step after it.
  const sibling = {
    schemaVersion: V3,
    steps: [
      { id: 'build', prompt: 'Write it.' },
      { id: 'other', prompt: 'Write something else.' },
      { id: 'review', dependsOn: ['build'], blindTo: ['other'], prompt: 'Review it.' },
      { id: 'after', dependsOn: ['review'], prompt: 'Publish it.' },
    ],
  };
  assert.ok(issuesOf(() => normaliseProgramV3(sibling)).includes(
    'steps[2].blindTo names "other", which does not run before this step; add it to dependsOn (directly or through another step)'));
  const later = structuredClone(sibling);
  later.steps[2].blindTo = ['after'];
  assert.ok(issuesOf(() => normaliseProgramV3(later)).some((issue) => /^steps\[2\]\.blindTo names "after", which does not run before this step/.test(issue)));
  // A gate is not a step.
  const gate = {
    schemaVersion: V3,
    steps: [{ id: 'build', prompt: 'Write it.' }, { id: 'review', dependsOn: ['hold'], blindTo: ['hold'], prompt: 'Review it.' }],
    gates: [{ id: 'hold', dependsOn: ['build'] }],
  };
  assert.ok(issuesOf(() => normaliseProgramV3(gate)).includes('steps[1].blindTo names "hold", which is not a step in this program'));
});

test('a v2 program keeps refusing blindTo as an unknown key', () => {
  const f = v2V3Fixtures();
  const program = structuredClone(f.v2Program);
  program.actions[0].blindTo = [];
  assert.ok(issuesOf(() => validateActionProgram(program, f.runtime)).includes('actions[0].blindTo is not allowed'));
});

test('plan validate prints "blind to" on the step line, and the contract documents blindTo beside route', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'bullswarm-blind-validate-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  const workspace = join(root, 'repo');
  mkdirSync(home); mkdirSync(workspace);
  const file = join(root, 'plan.json');
  writeFileSync(file, JSON.stringify(reviewProgram()));
  const env = { ...process.env, BULLSWARM_HOME: home };
  delete env.BULLSWARM_DEPTH;
  const out = spawnSync(process.execPath, [cli, 'workflow', 'plan', 'validate', 'Review acme', `--program=${file}`, `--cwd=${workspace}`], { encoding: 'utf8', env });
  assert.equal(out.status, 0, out.stdout + out.stderr);
  assert.match(out.stdout, /^ {2}review {19}analyze\/medium answer after lint blind to build$/m, out.stdout);
  assert.doesNotMatch(out.stdout.split('\n').find((line) => line.startsWith('  lint')), /blind/);
  const json = JSON.parse(spawnSync(process.execPath, [cli, 'workflow', 'plan', 'validate', 'Review acme', `--program=${file}`, `--cwd=${workspace}`, '--json'], { encoding: 'utf8', env }).stdout);
  assert.deepEqual(json.program.actions.find((action) => action.id === 'review').blindTo, ['build']);
  writeFileSync(file, JSON.stringify(reviewProgram({ blindTo: ['nowhere'] })));
  const refused = spawnSync(process.execPath, [cli, 'workflow', 'plan', 'validate', 'Review acme', `--program=${file}`, `--cwd=${workspace}`], { encoding: 'utf8', env });
  assert.equal(refused.status, 2);
  assert.match(refused.stderr + refused.stdout, /steps\[2\]\.blindTo names "nowhere", which is not a step in this program/);
  const fields = buildV3Contract({ goal: 'g', cwd: '/abs/workspace', next: {} }).program.stepFields;
  assert.match(fields.blindTo, /output file and checked answer/);
  assert.match(fields.blindTo, /review of a build step/);
  assert.match(fields.blindTo, /find, then check/);
});

// --- the task file and the previous round -----------------------------------------

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'bullswarm-blind-run-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const workspace = join(root, 'repo');
  const bullswarmDir = join(root, 'home');
  mkdirSync(workspace); mkdirSync(bullswarmDir);
  execFileSync('git', ['init', '-q', workspace]);
  writeFileSync(join(workspace, 'README.md'), 'acme\n');
  execFileSync('git', ['-C', workspace, 'add', '.']);
  execFileSync('git', ['-C', workspace, '-c', 'user.name=Acme Dev', '-c', 'user.email=dev@example.com', 'commit', '-qm', 'seed']);
  const goal = 'Review the acme summary';
  const goalDocument = createV2GoalDocument({
    goal, cwd: workspace, requirements: implicitV3Requirements(goal),
    settings: { executionMode: 'program', workspaceMode: 'shared', scout: false, plannerMode: 'caller', concurrency: 1 },
  });
  return { workspace, bullswarmDir, goalDocument };
}

const connector = (name) => ({
  name, lanes: ['analyze', 'build', 'chore'], enabled: true, spawn: { cmd: ['fake'] },
  modelSelection: { flag: '--model' },
  strategyAssignments: Object.fromEntries(['low', 'medium', 'high'].map((tier) => [tier, { pool: name, model: 'acme-model' }])),
});

// The real dispatch with a fake worker; `script(stepId, turn)` returns the answer it writes.
function fakeDispatch(script, seen) {
  const core = { config: { depthLimit: 2 }, pools: {}, incumbents: {}, decisionLog: [] };
  const turns = new Map();
  return (options) => dispatchV2Action({
    ...options,
    pools: [connector('acme-pool')],
    dependencies: {
      watchOnce: async (_pool, task, _targetDir, files, opts) => {
        const turn = (turns.get(options.action.id) ?? 0) + 1;
        turns.set(options.action.id, turn);
        seen.push({ id: options.action.id, turn, task });
        writeFileSync(files.taskFile, task);
        const named = /to this file: (\S+)/.exec(task)?.[1] ?? null;
        const answer = script(options.action.id, turn);
        if (named && answer !== undefined) writeFileSync(named, JSON.stringify(answer));
        writeFileSync(files.outFile, `done ${options.action.id} turn ${turn}`);
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
}

const launch = (f, program, dispatch) => runV2AutonomousWorkflow({
  bullswarmDir: f.bullswarmDir, goalDocument: f.goalDocument, pools: [], parentEnv: {},
  initialPlannerResponse: { schemaVersion: 'bullswarm.workflow.planner-response.v2', kind: 'program', summary: 'Review.', program },
  dependencies: { refreshPools: async () => null, dispatchV2Action: dispatch, controlPollMs: 20 },
});

const artifactsOf = (task) => JSON.parse(/Dependency artifacts:\n(.*)/.exec(task)[1]);

test('a blind step\'s task lists the dependency without its output file or answer; a sibling that is not blind gets both', async (t) => {
  const f = fixture(t);
  const seen = [];
  const program = {
    schemaVersion: V3,
    steps: [
      { id: 'build', prompt: 'Write the acme summary.', answer: summaryAnswer },
      { id: 'review', dependsOn: ['build'], blindTo: ['build'], prompt: 'Review the acme summary.', answer: passedAnswer },
      { id: 'note', dependsOn: ['build'], prompt: 'Note what the acme summary says.' },
    ],
  };
  const script = (id) => (id === 'build' ? { summary: 'I left out the initech section on purpose; it is not needed.' } : id === 'review' ? { passed: true } : undefined);
  const run = await launch(f, program, fakeDispatch(script, seen));
  assert.equal(run.result.status, 'completed', run.result.reason);
  const taskOf = (id) => seen.find((entry) => entry.id === id).task;
  const buildAnswerFile = join(run.runDir, 'answer-build-attempt-1.json');
  const buildOutput = run.state.actions.find((action) => action.id === 'build').outputFile;
  assert.ok(buildOutput, 'build has an output file');

  const [blind] = artifactsOf(taskOf('review'));
  assert.equal(blind.actionId, 'build', 'the dependency is still listed');
  assert.equal(blind.blind, true);
  assert.equal(Object.hasOwn(blind, 'outputFile'), false);
  assert.equal(Object.hasOwn(blind, 'answer'), false);
  assert.ok(!taskOf('review').includes(buildAnswerFile), 'the answer file is named nowhere in the blind task');
  assert.ok(!taskOf('review').includes(buildOutput), 'the output file is named nowhere in the blind task');
  assert.ok(!taskOf('review').includes('initech section'), 'the builder\'s justification never reaches the reviewer');
  assert.match(taskOf('review'), /You judge the work of build without its own account of it/);

  const [open] = artifactsOf(taskOf('note'));
  assert.equal(open.actionId, 'build');
  assert.equal(open.outputFile, buildOutput);
  assert.deepEqual(open.answer, { attemptId: 'build-1', file: buildAnswerFile });
  assert.equal(Object.hasOwn(open, 'blind'), false);
  assert.doesNotMatch(taskOf('note'), /You judge the work of/);
  // The dependency still orders the blind step.
  assert.ok(seen.findIndex((entry) => entry.id === 'build') < seen.findIndex((entry) => entry.id === 'review'));
});

test('in a loop, a blind step\'s Previous round block leaves out the named step\'s answer and output, and keeps its status', async (t) => {
  const f = fixture(t);
  const seen = [];
  const program = {
    schemaVersion: V3,
    steps: [
      { id: 'build', prompt: 'Write the acme summary; fix what the last review found.', answer: summaryAnswer },
      { id: 'review', dependsOn: ['build'], blindTo: ['build'], prompt: 'Review the acme summary.', answer: { ...passedAnswer, required: ['passed', 'problems'], properties: { ...passedAnswer.properties, problems: { type: 'array', items: { type: 'string' } } } } },
    ],
    loops: [{ id: 'polish', steps: ['build', 'review'], until: { step: 'review', field: 'passed' }, maxRounds: 2 }],
  };
  const script = (id, turn) => (id === 'build'
    ? { summary: `round ${turn}: the initech section is left out on purpose` }
    : { passed: turn > 1, problems: turn > 1 ? [] : ['the initech section is missing'] });
  const run = await launch(f, program, fakeDispatch(script, seen));
  assert.equal(run.result.status, 'completed', run.result.reason);
  const roundTwo = (id) => seen.find((entry) => entry.id === id && entry.turn === 2).task;
  const block = (task) => task.slice(task.indexOf('## Previous round'));

  const blind = block(roundTwo('review'));
  assert.match(blind, /^## Previous round \(loop polish, now round 2 of 2\)/);
  assert.match(blind, /^- build \(attempt build-1, succeeded\)$/m, 'it still says build ran, and its status');
  assert.doesNotMatch(blind, /initech section is left out/, 'no build answer');
  assert.doesNotMatch(blind, /out-build-attempt-1/, 'no build output line');
  assert.match(blind, /^- review \(attempt review-1, succeeded\)\n {2}- answer: .*the initech section is missing/m, 'its own round stays');
  assert.doesNotMatch(artifactsOf(roundTwo('review')).map((entry) => JSON.stringify(entry)).join(), /answer-build|out-build/);

  const open = block(roundTwo('build'));
  assert.match(open, /^ {2}- answer: .*initech section is left out on purpose/m, 'build is not blind: it sees its own answer');
  assert.match(open, /^ {2}- answer: .*the initech section is missing/m, 'and the review');
  assert.match(open, /^ {2}- output: .*out-build-attempt-1/m);
});

// --- workflow add -----------------------------------------------------------------

test('workflow add accepts blindTo in a fragment and validates it against the run', async (t) => {
  const f = fixture(t);
  const seen = [];
  const program = {
    schemaVersion: V3,
    steps: [
      { id: 'build', prompt: 'Write the acme summary.', answer: summaryAnswer },
      { id: 'report', dependsOn: ['hold'], prompt: 'Report on the acme summary.' },
    ],
    gates: [{ id: 'hold', dependsOn: ['build'], note: 'Add a review, then continue' }],
  };
  const run = await launch(f, program, fakeDispatch((id) => (id === 'build' ? { summary: 'done' } : undefined), seen));
  assert.deepEqual(run.waiting.map((entry) => entry.id), ['hold']);
  const add = (fragment) => addV3Steps({
    bullswarmDir: f.bullswarmDir, token: run.shortId, fragment, waitMs: 0,
    relaunch: async (runId) => ({ action: 'goal-resumed', runId }),
  });
  const refused = await add({ steps: [{ id: 'review', dependsOn: ['build'], blindTo: ['report'], prompt: 'Review it.' }] });
  assert.equal(refused.status, 'rejected', JSON.stringify(refused));
  assert.ok(refused.issues.some((issue) => /^fragment steps\[0\]\.blindTo names "report", which does not run before this step/.test(issue)), JSON.stringify(refused.issues));
  const unknown = await add({ steps: [{ id: 'review', dependsOn: ['build'], blindTo: 'build', prompt: 'Review it.' }] });
  assert.equal(unknown.status, 'rejected');
  assert.ok(unknown.issues.includes('fragment steps[0].blindTo must be an array of step ids'), JSON.stringify(unknown.issues));

  const added = await add({ steps: [{ id: 'review', dependsOn: ['build'], blindTo: ['build'], prompt: 'Review it.', answer: passedAnswer }] });
  assert.equal(added.status, 'applied', JSON.stringify(added));
  assert.deepEqual(added.steps, ['review']);
  const state = JSON.parse(readFileSync(join(run.runDir, 'state.json'), 'utf8'));
  const stored = state.program.actions.find((action) => action.id === 'review');
  assert.deepEqual(stored.blindTo, ['build']);
  assert.deepEqual(stored.dependsOn, ['build']);
});
