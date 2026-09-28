// Program v3, wave A of 0.37.0: the v3 validator and its stored form, the
// optional state keys a v3 run adds, the run marker, the implicit
// requirement, and the answer file. Built from the reviewer probes in the
// design's section 12. Made-up names only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { validateActionProgram } from '../src/workflow/action-validator.js';
import {
  createV2DurableState, createV2GoalDocument, serializeV2DurableState, validateV2DurableState,
} from '../src/workflow/v2-state.js';
import { applyV2PlannerResponse, validateV2PlannerResponse } from '../src/workflow/v2-planner.js';
import { runV2AutonomousWorkflow } from '../src/workflow/v2-runtime.js';
import { dispatchV2Action } from '../src/workflow/v2-dispatch.js';
import { readEvents } from '../src/workflow/events.js';
import { applyV2Revision, exportV2Plan, planV2Revision } from '../src/workflow/v2-revision.js';
import { STAGE3_RUN_FEATURES, readRunFeatures, repairLoopApplies } from '../src/workflow/run-features.js';
import {
  PROGRAM_V3_SCHEMA_VERSION, implicitV3Requirements, isProgramV3, normaliseProgramV3,
} from '../src/workflow/program-v3.js';
import { ANSWER_MAX_BYTES, answerFileFor, answerInstruction, checkAnswer } from '../src/workflow/answers.js';
import { V3_REVISE_REFUSED } from '../src/workflow/revision-v3.js';
import { scheduleV2Actions } from '../src/workflow/v2-scheduler.js';
import { watchOnce } from '../src/lib/watch.js';
import { runWorkflowWatch } from '../src/workflow/watch-cli.js';
import { oneStepV3, section2Example, v2V3Fixtures } from './fixtures/program-v3-fixtures.mjs';

const cli = resolve('bin/bullswarm.js');
const sha = (text) => createHash('sha256').update(text).digest('hex');
const byId = (steps, id) => steps.find((step) => step.id === id);

function issuesOf(fn) {
  try { fn(); } catch (error) { return Array.isArray(error?.issues) ? error.issues : [error.message]; }
  return [];
}

// --- the validator and its stored form -------------------------------------

test('the v3 validator accepts the design example: steps, phases, answers, retry, files, label, gates and loops declared', () => {
  const normal = normaliseProgramV3(section2Example());
  assert.equal(normal.schemaVersion, PROGRAM_V3_SCHEMA_VERSION);
  assert.deepEqual(normal.steps.map((step) => step.id), ['search-a', 'search-b', 'merge', 'critique', 'revise', 'post']);
  assert.equal(normal.defaults, undefined, 'defaults are folded onto each step');
  // Derived fields dispatch reads, never authored by the caller.
  const merge = byId(normal.steps, 'merge');
  assert.equal(merge.purpose, 'merge');
  assert.deepEqual(merge.affects, ['goal']);
  assert.equal(merge.lane, 'build');
  assert.equal(merge.effort, 'medium');
  assert.equal(merge.retry, 1);
  assert.equal(merge.timeBox, 30);
  assert.deepEqual(merge.deliverable, { type: 'files', paths: ['brief.md'] });
  assert.deepEqual(merge.dependsOn, ['search-a', 'search-b']);
  const revise = byId(normal.steps, 'revise');
  assert.deepEqual(revise.files, ['brief.md']);
  assert.deepEqual(revise.ownedFiles, ['brief.md']);
  assert.deepEqual(revise.affects, ['goal']);
  assert.deepEqual(revise.deliverable, { type: 'files' });
  const post = byId(normal.steps, 'post');
  assert.equal(post.role, 'act');
  assert.deepEqual(post.deliverable, { type: 'outward' });
  assert.equal(post.retry, 0);
  assert.equal(post.lane, 'analyze');
  assert.deepEqual(post.dependsOn, ['approve'], 'a step may depend on a gate');
  const critique = byId(normal.steps, 'critique');
  assert.equal(critique.phase, 'quality');
  assert.deepEqual(critique.route, { independentOf: ['merge'] });
  assert.equal(critique.answer.properties.passed.type, 'boolean');
  assert.equal(critique.deliverable, undefined, 'an analyze step with an answer delivers the answer');
  assert.deepEqual(critique.affects, []);
  const searchA = byId(normal.steps, 'search-a');
  assert.equal(searchA.phase, 'research');
  for (const step of normal.steps) {
    assert.deepEqual(step.evidenceFor, []);
    assert.deepEqual(step.inputs, []);
    assert.deepEqual(step.produces, []);
  }
  assert.deepEqual(normal.gates, [{ id: 'approve', dependsOn: ['polish'], note: 'Read brief.md and decide whether to publish' }]);
  assert.deepEqual(normal.loops, [{
    id: 'polish', steps: ['critique', 'revise'], until: { step: 'critique', field: 'passed', equals: true }, maxRounds: 3,
  }]);
  // A label is the display name and the derived purpose.
  const labelled = normaliseProgramV3(oneStepV3({ label: 'Count the files' }));
  assert.equal(labelled.steps[0].label, 'Count the files');
  assert.equal(labelled.steps[0].purpose, 'Count the files');
  assert.equal(isProgramV3(section2Example()), true);
  assert.equal(isProgramV3(v2V3Fixtures().v2Program), false);
});

test('a normalised v3 program normalises to itself, so add never reads a step as amended', () => {
  const variants = [
    section2Example(),
    oneStepV3(),
    oneStepV3({ label: 'Count', phase: 'survey', effort: 'low', reasoning: 'high', timeBox: 0, retry: 0 }),
    {
      schemaVersion: PROGRAM_V3_SCHEMA_VERSION,
      defaults: { lane: 'build', effort: 'high', reasoning: 'medium' },
      steps: [
        { id: 'fix', prompt: 'Fix the failing test.', files: ['./src/acme.js', 'src/acme.test.js'], evidence: [{ type: 'command', cmd: 'npm test' }] },
        { id: 'tidy', prompt: 'Tidy imports.', lane: 'chore', effort: 'low', dependsOn: ['fix'], route: { providers: { avoid: ['acme-cloud'] } } },
        {
          id: 'check', prompt: 'Check the fix.', lane: 'analyze', dependsOn: ['tidy'], route: { independentOf: ['tidy', 'fix'] },
          evidence: [{ type: 'command', cmd: 'npm test', timeoutSec: 60 }],
        },
      ],
      gates: [{ id: 'ship-it', dependsOn: ['check'], when: { step: 'check', evidence: 'passed' } }],
    },
  ];
  for (const program of variants) {
    const once = normaliseProgramV3(program);
    const twice = normaliseProgramV3(once);
    assert.deepEqual(twice, once);
    assert.equal(JSON.stringify(twice), JSON.stringify(once), 'the same keys in the same order');
  }
});

test('the v3 validator names what is wrong', () => {
  const cases = [
    [{ ...oneStepV3(), schemaVersion: 'bullswarm.workflow.program.v2' }, /schemaVersion must be "bullswarm\.workflow\.program\.v3"/],
    [{ ...oneStepV3(), actions: [] }, /program\.actions is not allowed/],
    [{ schemaVersion: PROGRAM_V3_SCHEMA_VERSION, steps: [] }, /steps must be a non-empty array/],
    [oneStepV3({ retry: 2 }), /steps\[0\]\.retry must be 0 or 1/],
    [oneStepV3({ kind: 'check' }), /steps\[0\]\.kind is not a v3 field/],
    [oneStepV3({ evidenceFor: ['goal'] }), /steps\[0\]\.evidenceFor is not a v3 field/],
    [oneStepV3({ purpose: 'Something else' }), /steps\[0\]\.purpose is derived/],
    [oneStepV3({ answer: { type: 'object', properties: { n: { type: 'integer', format: 'int32', frobnicate: true } } } }), /steps\[0\]\.answer/],
    [oneStepV3({ answer: 'yes' }), /steps\[0\]\.answer must be a JSON schema object/],
    [oneStepV3({ dependsOn: ['nowhere'] }), /count\.dependsOn references unknown step, gate or loop "nowhere"/],
    [oneStepV3({ files: ['src/'] }), /steps\[0\]\.files\[0\] must name one exact file/],
    [oneStepV3({ lane: 'build', files: ['a.txt'], deliverable: 'outward' }), /outward/],
    [{ ...oneStepV3(), defaults: { lane: 'build', verifyRounds: 1 } }, /defaults\.verifyRounds is not allowed/],
    [{ ...oneStepV3(), gates: [{ id: 'count', dependsOn: [] }] }, /id "count" is used twice/],
    [{ ...oneStepV3(), loops: [{ id: 'again', steps: ['count'], until: { step: 'count', field: 'count' }, maxRounds: 2 }] }, /until\.field "count" must be a boolean in the answer schema of step count/],
    // A condition reads a field every valid answer has: an object root that lists it in `required`.
    [{ ...oneStepV3({ answer: { type: 'array', properties: { passed: { type: 'boolean' } } } }), loops: [{ id: 'again', steps: ['count'], until: { step: 'count', field: 'passed' }, maxRounds: 2 }] }, /until: the answer schema of step count must have type "object"/],
    [{ ...oneStepV3({ answer: { type: 'object', properties: { passed: { type: 'boolean' } } } }), loops: [{ id: 'again', steps: ['count'], until: { step: 'count', field: 'passed' }, maxRounds: 2 }] }, /until\.field "passed" must be listed in the required fields of step count's answer schema/],
    [{ ...oneStepV3({ answer: { type: 'object', required: ['n'], properties: { n: { type: 'integer' }, passed: { type: 'boolean' } } } }), gates: [{ id: 'hold', dependsOn: ['count'], when: { step: 'count', field: 'passed' } }] }, /when\.field "passed" must be listed in the required fields/],
    [{ ...oneStepV3(), loops: [{ id: 'again', steps: ['count'], until: { step: 'count', evidence: 'passed' }, maxRounds: 2 }] }, /step count declares no evidence/],
    [{ ...oneStepV3(), loops: [{ id: 'again', steps: ['count'], until: { step: 'count', evidence: 'passed' }, maxRounds: 6 }] }, /maxRounds must be a whole number from 1 to 5/],
    [{ ...section2Example(), loops: [{ id: 'polish', steps: ['critique', 'revise'], until: { step: 'merge', field: 'passed' }, maxRounds: 3 }] }, /until\.step must be one of the loop's steps/],
    [{ ...section2Example(), gates: [{ id: 'approve', dependsOn: ['polish'], when: { step: 'post', field: 'passed' } }] }, /when\.step must run before gate approve/],
    [{ ...section2Example(), steps: section2Example().steps.map((step) => (step.id === 'post' ? { ...step, dependsOn: ['revise'] } : step)) }, /post depends on revise inside loop polish; depend on the loop/],
    [{ ...oneStepV3(), gates: [{ id: 'hold', dependsOn: ['hold'] }] }, /cycle/],
  ];
  for (const [program, pattern] of cases) {
    const issues = issuesOf(() => normaliseProgramV3(program));
    assert.ok(issues.some((issue) => pattern.test(issue)), `${pattern} not in ${JSON.stringify(issues)}`);
  }
});

// --- the implicit requirement ------------------------------------------------

function v3Goal(cwd, goal = 'Count the markdown files') {
  return createV2GoalDocument({
    goal, cwd, requirements: implicitV3Requirements(goal),
    settings: { executionMode: 'program', workspaceMode: 'shared', scout: false, plannerMode: 'caller', concurrency: 2 },
  });
}

test('the implicit requirement of a v3 goal is mandatory:false', (t) => {
  assert.deepEqual(implicitV3Requirements('Count the markdown files'), [{ id: 'goal', text: 'Count the markdown files', mandatory: false }]);
  const state = createV2DurableState(v3Goal('/tmp/acme-repo'), { runId: 'wf-acme-000002', shortId: 'acme02' });
  assert.equal(state.intent.requirements[0].mandatory, false);
  assert.equal(state.ledger.requirements.goal.mandatory, false);
  // What plan validate reports for a v3 program.
  const root = mkdtempSync(join(tmpdir(), 'bullswarm-v3-requirement-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  const workspace = join(root, 'repo');
  mkdirSync(home); mkdirSync(workspace);
  const programFile = join(root, 'plan.json');
  writeFileSync(programFile, JSON.stringify(oneStepV3()));
  const out = execFileSync(process.execPath, [cli, 'workflow', 'plan', 'validate', 'Count the markdown files', '--program', programFile, '--cwd', workspace, '--json'], {
    encoding: 'utf8', env: { ...process.env, BULLSWARM_HOME: home },
  });
  const payload = JSON.parse(out);
  assert.deepEqual(payload.requirements, [{ id: 'goal', text: 'Count the markdown files', mandatory: false }]);
  assert.equal(payload.program.schemaVersion, PROGRAM_V3_SCHEMA_VERSION);
});

// --- the stored state --------------------------------------------------------

function acceptedV3State(program = section2Example(), goal = v3Goal('/tmp/acme-repo'), ids = { runId: 'wf-acme-000003', shortId: 'acme03' }) {
  const state = createV2DurableState(goal, ids);
  return applyV2PlannerResponse(state, {
    schemaVersion: 'bullswarm.workflow.planner-response.v2', kind: 'program', summary: 'Research, polish and publish.', program,
  }, { boundary: 'initial', workspacePaths: false });
}

test('a stored v3 state with program.control, lifecycle.waitingFor and answers on attempts and actions validates', () => {
  const state = acceptedV3State();
  assert.equal(state.program.schemaVersion, PROGRAM_V3_SCHEMA_VERSION);
  assert.equal(state.program.revision, 1);
  assert.deepEqual(state.program.control.gates.map((gate) => gate.id), ['approve']);
  assert.deepEqual(state.program.control.loops.map((loop) => loop.id), ['polish']);
  assert.equal(validateV2DurableState(state), true);
  const answered = structuredClone(state);
  const at = '2026-09-28T08:00:00.000Z';
  answered.lifecycle.status = 'waiting';
  answered.lifecycle.startedAt = at;
  answered.lifecycle.waitingFor = [{ id: 'approve', type: 'gate', since: at, note: 'Read brief.md and decide whether to publish' }];
  const step = answered.actions.find((action) => action.id === 'search-a');
  Object.assign(step, { status: 'succeeded', attempts: 1, startedAt: at, finishedAt: at, answer: { attemptId: 'search-a-1', value: { claims: ['acme ships in May'] } } });
  answered.attempts.push({
    id: 'search-a-1', actionId: 'search-a', ordinal: 1, status: 'succeeded', pool: 'acme-pool', model: 'acme-model',
    startedAt: at, finishedAt: at, taskFile: '/tmp/task.md', outputFile: '/tmp/out.md', failureKind: null, why: null, usage: null,
    answer: { file: '/tmp/answer-search-a-attempt-1.json', ok: true, value: { claims: ['acme ships in May'] }, errors: [] },
  });
  assert.equal(validateV2DurableState(answered), true);
  assert.equal(JSON.parse(serializeV2DurableState(answered)).lifecycle.waitingFor[0].id, 'approve');
  // A failed answer keeps what the worker wrote beside the errors.
  const failed = structuredClone(answered);
  failed.attempts[0].answer = { file: '/tmp/answer-search-a-attempt-1.json', ok: false, value: { claims: 3 }, errors: ['$.claims: expected array'] };
  assert.equal(validateV2DurableState(failed), true);

  const refused = (mutate, pattern) => {
    const copy = structuredClone(answered);
    mutate(copy);
    assert.throws(() => validateV2DurableState(copy), pattern);
  };
  refused((s) => { s.lifecycle.waitingFor[0].id = 'nowhere'; }, /waitingFor\[0\]\.id/);
  refused((s) => { s.lifecycle.waitingFor[0].type = 'step'; }, /waitingFor\[0\]\.type must be gate\|loop/);
  refused((s) => { s.lifecycle.waitingFor[0].extra = 1; }, /waitingFor\[0\]\.extra is not allowed/);
  refused((s) => { s.attempts[0].answer.ok = 'yes'; }, /answer\.ok must be a boolean/);
  refused((s) => { s.actions.find((action) => action.id === 'search-a').answer = { value: 1 }; }, /answer\.attemptId/);
  refused((s) => { s.program.control.loops[0].maxRounds = 9; }, /state\.program is invalid/);
});

test('the v3 keys stay refused on a v2 program', () => {
  const f = v2V3Fixtures();
  const state = createV2DurableState(createV2GoalDocument(f.goal), { runId: 'wf-acme-000004', shortId: 'acme04' });
  const accepted = applyV2PlannerResponse(state, f.response);
  const withControl = structuredClone(accepted);
  withControl.program.control = { gates: [], loops: [] };
  assert.throws(() => validateV2DurableState(withControl), /state\.program\.control is not allowed/);
  const waiting = structuredClone(accepted);
  waiting.lifecycle.status = 'waiting';
  waiting.lifecycle.waitingFor = [];
  assert.throws(() => validateV2DurableState(waiting), /waitingFor needs a v3 program/);
});

test('v2 programs and states validate byte-identically (hashes captured at v0.36.0)', () => {
  const f = v2V3Fixtures();
  assert.equal(sha(JSON.stringify(validateActionProgram(f.v2Program, f.runtime))), '50dfcf0e85afd49ed943245503d46497cbdd92cd284ee3c8c407c96498308701');
  assert.deepEqual(issuesOf(() => validateActionProgram(f.v2WithV3Fields, f.runtime)), [
    'actions[0].phase is not allowed',
    'actions[0].answer is not allowed',
    'actions[0].retry is not allowed',
    'actions[0].files is not allowed',
    'actions[0].label is not allowed',
    'actions[0].phase is not allowed in V2',
  ]);
  const state = createV2DurableState(createV2GoalDocument(f.goal), { runId: 'wf-acme-000001', shortId: 'acme01' });
  assert.equal(sha(serializeV2DurableState(state)), 'f92fdfe2a91fe7e715fa3a5242d4b0807c6615152f50e81784af7182677a4332');
  assert.equal(sha(serializeV2DurableState(applyV2PlannerResponse(state, f.response))), 'aa427b961b9808e71c4323f62b4eee4984410cae0c22b478b8ec532ba042179f');
  assert.equal(sha(JSON.stringify(validateV2PlannerResponse(f.response, state))), '03a5bf51e954a565c3a5aacc335a5233fc25431df66f639b3d262efeb03342b3');
});

// --- the run marker and the repair loop --------------------------------------

function v3Fixture(t, goal = 'Count the markdown files') {
  const root = mkdtempSync(join(tmpdir(), 'bullswarm-v3-run-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const workspace = join(root, 'repo');
  const bullswarmDir = join(root, 'home');
  mkdirSync(workspace); mkdirSync(bullswarmDir);
  execFileSync('git', ['init', '-q', workspace]);
  writeFileSync(join(workspace, 'README.md'), 'acme\n');
  execFileSync('git', ['-C', workspace, 'add', '.']);
  execFileSync('git', ['-C', workspace, '-c', 'user.name=Acme Dev', '-c', 'user.email=dev@example.com', 'commit', '-qm', 'seed']);
  return { root, workspace, bullswarmDir, goalDocument: v3Goal(workspace, goal) };
}

const v3Response = (program) => ({
  schemaVersion: 'bullswarm.workflow.planner-response.v2', kind: 'program', summary: 'Count the files.', program,
});

// The runtime's dispatcher with a scripted outcome and no worker.
function scriptedDispatch(reply = 'Counted.') {
  return async (options) => {
    const files = options.paths(1);
    const record = {
      ordinal: 1, pool: 'acme-pool', model: 'acme-model', status: 'running',
      startedAt: new Date().toISOString(), taskFile: files.taskFile, outFile: files.outFile,
    };
    writeFileSync(files.taskFile, options.taskText);
    options.onAttempt?.('started', record);
    writeFileSync(files.outFile, reply);
    Object.assign(record, { status: 'succeeded', finishedAt: new Date().toISOString(), failureKind: null });
    options.onAttempt?.('finished', record);
    return { ok: true, status: 'succeeded', attempts: [record], verdict: { ok: true, outFile: files.outFile } };
  };
}

test('the repair loop never runs for a v3 run: features.json says programFormat 3 and advanceVerifyLoop returns at once', async (t) => {
  assert.equal(repairLoopApplies({ ...STAGE3_RUN_FEATURES, programFormat: 3 }), false);
  assert.equal(repairLoopApplies(STAGE3_RUN_FEATURES), true);
  assert.equal(repairLoopApplies({}), true, 'a saved run keeps its loop');
  const f = v3Fixture(t);
  const run = await runV2AutonomousWorkflow({
    bullswarmDir: f.bullswarmDir, goalDocument: f.goalDocument, pools: [], parentEnv: {},
    initialPlannerResponse: v3Response(oneStepV3({ answer: undefined })),
    dependencies: { refreshPools: async () => null, dispatchV2Action: scriptedDispatch() },
  });
  assert.equal(run.result.status, 'completed', run.result.reason);
  assert.equal(run.result.reason, 'all 1 step succeeded', 'facts per step, never "not verified"');
  assert.deepEqual(readRunFeatures(run.runDir), { ...STAGE3_RUN_FEATURES, programFormat: 3 });
  assert.equal(run.state.verifyLoop, undefined, 'no repair-loop record on a v3 run');
  assert.equal(run.state.program.schemaVersion, PROGRAM_V3_SCHEMA_VERSION);
  assert.equal(readEvents(run.runDir).filter((event) => ['workflow.verify-round', 'workflow.repair'].includes(event.type)).length, 0);
  // A v2 launch writes the marker it always wrote.
  const v2 = v3Fixture(t, 'Deliver the requested files');
  const v2Goal = createV2GoalDocument({ ...v2V3Fixtures().goal, cwd: v2.workspace });
  const v2Run = await runV2AutonomousWorkflow({
    bullswarmDir: v2.bullswarmDir, goalDocument: v2Goal, pools: [], parentEnv: {},
    initialPlannerResponse: {
      schemaVersion: 'bullswarm.workflow.planner-response.v2', kind: 'program', summary: 'Write.',
      program: { schemaVersion: 'bullswarm.workflow.program.v2', actions: [v2V3Fixtures().v2Program.actions[0]] },
    },
    dependencies: { refreshPools: async () => null, dispatchV2Action: scriptedDispatch() },
  });
  assert.deepEqual(readRunFeatures(v2Run.runDir), { ...STAGE3_RUN_FEATURES });
});

// --- the answer file ---------------------------------------------------------

test('answers: the file sits next to the output and checkAnswer reads, checks and dates it', (t) => {
  assert.equal(answerFileFor('/runs/wf-x/out-count-attempt-2.md'), '/runs/wf-x/answer-count-attempt-2.json');
  const dir = mkdtempSync(join(tmpdir(), 'bullswarm-answer-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const schemaFile = join(dir, 'schema.json');
  writeFileSync(schemaFile, JSON.stringify({ type: 'object', required: ['n'], properties: { n: { type: 'integer' } } }));
  const file = join(dir, 'answer.json');
  writeFileSync(file, '{"n": 3}');
  const ok = checkAnswer({ answerFile: file, schemaFile });
  assert.deepEqual(ok.answer, { n: 3 });
  assert.equal(ok.answerCheck.ok, true);
  writeFileSync(file, '{"n": "three"}');
  const bad = checkAnswer({ answerFile: file, schemaFile });
  assert.equal(bad.answerCheck.ok, false);
  assert.deepEqual(bad.answer, { n: 'three' }, 'the caller still sees what the worker wrote');
  const missing = checkAnswer({ answerFile: join(dir, 'none.json'), schemaFile });
  assert.equal(missing.answer, null);
  assert.match(missing.answerCheck.why, /file missing/);
  writeFileSync(file, '```json\n{"n": 1}\n```\n');
  assert.deepEqual(checkAnswer({ answerFile: file, schemaFile }).answer, { n: 1 });
  const stale = checkAnswer({ answerFile: file, schemaFile, mtimeBefore: statSync(file).mtimeMs });
  assert.equal(stale.answerCheck.why, 'answer file not rewritten by this run');
  assert.equal(stale.answer, null);
  assert.match(answerInstruction('{"type":"object"}', '/x/answer.json'), /\/x\/answer\.json[\s\S]*"type":"object"/);
});

const connector = (name) => ({
  name, lanes: ['analyze', 'build', 'chore'], enabled: true, spawn: { cmd: ['fake'] },
  modelSelection: { flag: '--model' },
  strategyAssignments: Object.fromEntries(['low', 'medium', 'high'].map((tier) => [tier, { pool: name, model: 'acme-model' }])),
});

// The real dispatch with a fake worker that behaves as watchOnce does with an
// outputValidator: the validator, not the prose, decides the verdict.
function answeringDispatch({ answers, replies = [], seen = [] }) {
  const core = { config: { depthLimit: 2 }, pools: {}, incumbents: {}, decisionLog: [] };
  let turn = 0;
  return (options) => dispatchV2Action({
    ...options,
    pools: [connector('acme-pool')],
    dependencies: {
      watchOnce: async (_pool, task, _targetDir, files, opts) => {
        const index = turn;
        turn += 1;
        seen.push({ task, files, validator: typeof opts?.outputValidator === 'function' });
        writeFileSync(files.taskFile, task);
        const named = /to this file: (\S+)/.exec(task)?.[1] ?? null;
        if (named && answers[index] !== undefined) writeFileSync(named, typeof answers[index] === 'string' ? answers[index] : JSON.stringify(answers[index]));
        const reply = replies[index] ?? '';
        writeFileSync(files.outFile, reply);
        if (typeof opts?.outputValidator !== 'function') return { ok: true, why: 'ok', meta: { exitCode: 0, wallSec: 1 } };
        const checked = opts.outputValidator(reply);
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

function launchV3(f, program, dispatch) {
  return runV2AutonomousWorkflow({
    bullswarmDir: f.bullswarmDir, goalDocument: f.goalDocument, pools: [], parentEnv: {},
    initialPlannerResponse: v3Response(program),
    dependencies: { refreshPools: async () => null, dispatchV2Action: dispatch },
  });
}

test('a v3 step with an answer: the brief names answer-<attempt>.json and the checked answer is stored on the attempt and the step', async (t) => {
  const f = v3Fixture(t);
  const seen = [];
  const run = await launchV3(f, oneStepV3(), answeringDispatch({ answers: [{ count: 1 }], seen }));
  assert.equal(run.result.status, 'completed', run.result.reason);
  const answerFile = join(run.runDir, 'answer-count-attempt-1.json');
  assert.match(seen[0].task, new RegExp(`write your final answer as a single JSON value to this file: ${answerFile.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.equal(seen[0].validator, true);
  const attempt = run.state.attempts.find((item) => item.actionId === 'count');
  assert.deepEqual(attempt.answer, { file: answerFile, ok: true, value: { count: 1 }, errors: [] });
  assert.deepEqual(run.state.actions.find((item) => item.id === 'count').answer, { attemptId: 'count-1', value: { count: 1 } });
  assert.deepEqual(run.result.actions[0].answer, { attemptId: 'count-1', value: { count: 1 } }, 'the result carries the checked answer');
  // watch reports the outcome without a verified verdict for a v3 run.
  let watched = '';
  assert.equal(await runWorkflowWatch(f.bullswarmDir, run.state.shortId, { once: true, classic: true, output: { write: (text) => { watched += text; } } }), 0);
  assert.match(watched, /^outcome: completed$/m, watched);
  assert.doesNotMatch(watched, /verified/);
  // An empty reply beside a valid answer is a note, never the verdict.
  assert.ok(attempt.notes?.some((note) => note.kind === 'no-output'), JSON.stringify(attempt.notes));
});

test('an answer that breaks its schema gets one same-pool correction worded for the answer, sharing the step\'s one retry', async (t) => {
  const f = v3Fixture(t);
  const seen = [];
  const run = await launchV3(f, oneStepV3(), answeringDispatch({ answers: [{ count: 'one' }, { count: 1 }], seen }));
  assert.equal(run.result.status, 'completed', run.result.reason);
  assert.equal(seen.length, 2);
  assert.match(seen[1].task, /Your answer file failed its schema check/);
  assert.match(seen[1].task, /answer-count-attempt-2\.json/);
  assert.doesNotMatch(seen[1].task, /answer-count-attempt-1\.json/, 'the new attempt writes its own file');
  const attempts = run.state.attempts.filter((item) => item.actionId === 'count');
  assert.equal(attempts[0].status, 'interrupted', 'an attempt the dispatcher retries reads interrupted, as today');
  assert.equal(attempts[0].failureKind, 'schema');
  assert.equal(attempts[0].answer.ok, false);
  assert.deepEqual(attempts[0].answer.value, { count: 'one' });
  assert.equal(attempts[1].retryOf.how, 'same-pool');
  assert.equal(attempts[1].answer.ok, true);

  const g = v3Fixture(t);
  const once = [];
  const refused = await launchV3(g, oneStepV3({ retry: 0 }), answeringDispatch({ answers: [{ count: 'one' }, { count: 1 }], seen: once }));
  assert.equal(once.length, 1, 'retry 0: one attempt, then the caller');
  assert.equal(refused.result.status, 'partial');
  assert.equal(refused.state.attempts[0].failureKind, 'schema');
  assert.equal(refused.state.actions[0].answer, undefined);
  assert.equal(refused.result.actions[0].answer, null, 'a step with no valid answer reads null in the result');
});

test('a v3 step with no answer passes by facts: a short reply is not judged by the prose gate', async (t) => {
  const f = v3Fixture(t);
  const seen = [];
  const run = await launchV3(f, oneStepV3({ answer: undefined }), answeringDispatch({ answers: [], replies: ['ok'], seen }));
  assert.equal(seen[0].validator, true, 'an accept-all validator keeps judgeContent out');
  assert.equal(run.result.status, 'completed', run.result.reason);
  assert.equal(run.state.attempts[0].answer, undefined);
  assert.equal(Object.hasOwn(run.result.actions[0], 'answer'), false, 'no answer declared, no key');
});

// --- recovery after a provider stream error ----------------------------------

test('a valid fresh answer file counts as usable output when the stream errors with an empty reply', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'bullswarm-answer-recover-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const answerFile = join(dir, 'answer.json');
  const rows = [{ type: 'error', error: { message: 'stream disconnected after the answer was written' } }];
  const streamed = {
    name: 'fixture-events',
    spawn: { cmd: [process.execPath, '-e', `require('fs').writeFileSync(${JSON.stringify(answerFile)}, '{"count":2}'); for (const row of ${JSON.stringify(rows)}) console.log(JSON.stringify(row))`] },
    authSignatures: [],
    outputExtraction: { strategy: 'event-stream' },
    eventStream: {
      format: 'jsonl', failureTypes: ['error'],
      rules: [{ rootMatch: { path: 'type', equals: 'response' }, idPaths: ['id'], kind: 'response', summaryPaths: ['text'], status: 'completed' }],
      output: [{ match: { path: 'type', equals: 'response' }, path: 'text', mode: 'last' }],
    },
  };
  const paths = { taskFile: join(dir, 'task.md'), outFile: join(dir, 'out.md') };
  const fileValidator = () => (existsSync(answerFile) ? { ok: true, errors: [], value: JSON.parse(readFileSync(answerFile, 'utf8')) } : { ok: false, errors: ['no answer'] });
  fileValidator.readsFile = true;
  const recovered = await watchOnce(streamed, 'Count.', dir, paths, { outputValidator: fileValidator });
  assert.equal(recovered.ok, true, recovered.why);
  assert.equal(recovered.notes?.[0]?.kind, 'recovered-stream-error');
  // No valid answer file: the stream error stands.
  const noAnswer = () => ({ ok: false, errors: ['file missing'] });
  noAnswer.readsFile = true;
  const failed = await watchOnce(streamed, 'Count.', dir, paths, { outputValidator: noAnswer });
  assert.equal(failed.ok, false);
  assert.equal(failed.failureKind, 'provider');
});

// --- the CLI -----------------------------------------------------------------

test('plan validate accepts a v3 program with gates and loops', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'bullswarm-v3-cli-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  const workspace = join(root, 'repo');
  mkdirSync(home); mkdirSync(workspace);
  const programFile = join(root, 'plan.json');
  // No route: an empty home has no pool a route could name.
  const example = section2Example();
  delete example.steps.find((step) => step.id === 'critique').route;
  writeFileSync(programFile, JSON.stringify(example));
  const env = { ...process.env, BULLSWARM_HOME: home };
  delete env.BULLSWARM_DEPTH;
  const validate = spawnSync(process.execPath, [cli, 'workflow', 'plan', 'validate', 'Research and publish the brief', '--program', programFile, '--cwd', workspace, '--json'], { encoding: 'utf8', env });
  assert.equal(validate.status, 0, validate.stderr + validate.stdout);
  const payload = JSON.parse(validate.stdout);
  assert.deepEqual(payload.program.gates.map((gate) => gate.id), ['approve']);
  assert.deepEqual(payload.program.loops.map((loop) => loop.id), ['polish']);
  assert.equal(dirname(programFile), root);
});

// --- revisions of a v3 run (step rerun and step accept use this path) --------

test('a v3 run exports as v3; a revision may rerun or accept its steps, never add, change or remove one', async (t) => {
  const f = v3Fixture(t);
  const run = await launchV3(f, oneStepV3(), answeringDispatch({ answers: [{ count: 1 }] }));
  assert.equal(run.result.status, 'completed', run.result.reason);
  const state = structuredClone(run.state);
  const exported = exportV2Plan(state);
  assert.equal(exported.program.schemaVersion, PROGRAM_V3_SCHEMA_VERSION);
  assert.deepEqual(exported.program.actions, state.program.actions);
  assert.deepEqual(exported.program.control, { gates: [], loops: [] });

  const unchanged = planV2Revision(state, { ...exported });
  assert.equal(unchanged.ok, false);
  assert.match(unchanged.issues[0], /changes nothing/);

  const rerun = planV2Revision(state, { ...exported, rerun: ['count'] });
  assert.equal(rerun.ok, true, JSON.stringify(rerun.issues));
  assert.deepEqual(rerun.changes.rerun, ['count']);
  applyV2Revision(state, rerun, { request: { id: 'rev-v3rerun-000001', source: 'step-rerun', summary: 'step rerun count' }, at: new Date().toISOString() });
  const runtime = state.actions.find((item) => item.id === 'count');
  assert.equal(runtime.status, 'pending');
  assert.equal(runtime.answer, undefined, 'a rerun clears the superseded answer');
  assert.equal(state.program.schemaVersion, PROGRAM_V3_SCHEMA_VERSION);
  assert.deepEqual(state.program.control, { gates: [], loops: [] });
  validateV2DurableState(state);

  const fresh = structuredClone(run.state);
  const edits = [
    { ...exported, program: { ...exported.program, actions: [{ ...exported.program.actions[0], prompt: 'Count again.' }] } },
    { ...exported, program: { ...exported.program, actions: [...exported.program.actions, { ...exported.program.actions[0], id: 'more', purpose: 'more' }] } },
    { ...exported, program: { schemaVersion: 'bullswarm.workflow.program.v2', actions: exported.program.actions } },
  ];
  for (const request of edits) {
    const refused = planV2Revision(fresh, request);
    assert.equal(refused.ok, false);
    assert.ok(refused.issues.some((issue) => /plan revise|schemaVersion/.test(issue)), JSON.stringify(refused.issues));
  }
});

// --- review fixes (wave A review) --------------------------------------------

test('plan validate reads a v3 program piped through /dev/stdin (the file is read once)', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'bullswarm-v3-stdin-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  const workspace = join(root, 'repo');
  mkdirSync(home); mkdirSync(workspace);
  const env = { ...process.env, BULLSWARM_HOME: home };
  delete env.BULLSWARM_DEPTH;
  const validate = spawnSync(process.execPath, [cli, 'workflow', 'plan', 'validate', 'Count the markdown files', '--program', '/dev/stdin', '--cwd', workspace, '--json'], {
    encoding: 'utf8', env, input: JSON.stringify(oneStepV3()),
  });
  assert.equal(validate.status, 0, validate.stderr + validate.stdout);
  const payload = JSON.parse(validate.stdout);
  assert.equal(payload.program.schemaVersion, PROGRAM_V3_SCHEMA_VERSION);
  assert.deepEqual(payload.requirements, [{ id: 'goal', text: 'Count the markdown files', mandatory: false }], 'the v3 requirement, so the program was read as v3');
});

test('a v3 revision that changes only gates or loops is refused, never applied as a no-op', () => {
  const state = acceptedV3State();
  const at = '2026-09-28T08:00:00.000Z';
  const step = state.actions.find((action) => action.id === 'search-a');
  Object.assign(step, { status: 'succeeded', attempts: 1, startedAt: at, finishedAt: at });
  state.attempts.push({
    id: 'search-a-1', actionId: 'search-a', ordinal: 1, status: 'succeeded', pool: 'acme-pool', model: 'acme-model',
    startedAt: at, finishedAt: at, taskFile: '/tmp/task.md', outputFile: '/tmp/out.md', failureKind: null, why: null, usage: null,
  });
  validateV2DurableState(state);
  const exported = exportV2Plan(state);
  // The unchanged export with a rerun is accepted: the control nodes match.
  assert.equal(planV2Revision(state, { ...exported, rerun: ['search-a'] }).ok, true);
  const edits = [
    (control) => { control.loops[0].maxRounds = 5; },
    (control) => { control.gates[0].note = 'Publish without reading'; },
    (control) => { control.gates = []; },
    (control) => { control.loops = []; },
  ];
  for (const edit of edits) {
    const request = structuredClone({ ...exported, rerun: ['search-a'] });
    edit(request.program.control);
    const refused = planV2Revision(state, request);
    assert.equal(refused.ok, false, `accepted a control edit: ${JSON.stringify(request.program.control)}`);
    assert.deepEqual(refused.issues, [V3_REVISE_REFUSED]);
  }
  const dropped = structuredClone({ ...exported, rerun: ['search-a'] });
  delete dropped.program.control;
  assert.deepEqual(planV2Revision(state, dropped).issues, [V3_REVISE_REFUSED], 'a request without control would drop the gates and loops');
});

test('an answer above the size cap is refused: nothing large is stored on the attempt, the step or the result', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'bullswarm-answer-cap-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const schemaFile = join(dir, 'schema.json');
  writeFileSync(schemaFile, JSON.stringify({ type: 'object', required: ['n'], properties: { n: { type: 'integer' } } }));
  const file = join(dir, 'answer.json');
  const big = (bytes) => JSON.stringify({ n: 1, pad: 'x'.repeat(bytes) });
  writeFileSync(file, big(ANSWER_MAX_BYTES + 1));
  const refused = checkAnswer({ answerFile: file, schemaFile });
  assert.equal(refused.answerCheck.ok, false);
  assert.equal(refused.answer, null, 'the value is not kept');
  assert.match(refused.answerCheck.why, /answer file too large: .* \(limit 256 KiB\)/);
  writeFileSync(file, big(ANSWER_MAX_BYTES - 100));
  assert.equal(checkAnswer({ answerFile: file, schemaFile }).answerCheck.ok, true, 'just under the cap passes');
  assert.match(answerInstruction('{}', '/x/answer.json'), /at most 256 KiB/);

  const f = v3Fixture(t);
  const huge = { count: 1, pad: 'x'.repeat(ANSWER_MAX_BYTES) };
  const run = await launchV3(f, oneStepV3({ retry: 0 }), answeringDispatch({ answers: [huge] }));
  assert.equal(run.result.status, 'partial', run.result.reason);
  const attempt = run.state.attempts.find((item) => item.actionId === 'count');
  assert.equal(attempt.failureKind, 'schema');
  assert.equal(attempt.answer.ok, false);
  assert.equal(attempt.answer.value, null);
  assert.equal(run.state.actions[0].answer, undefined);
  assert.equal(run.result.actions[0].answer, null);
  assert.ok(statSync(join(run.runDir, 'state.json')).size < ANSWER_MAX_BYTES, 'state.json does not carry the answer');
});

test('a dependent step is handed its dependency\'s checked answer file beside its output file', async (t) => {
  const f = v3Fixture(t);
  const seen = [];
  const program = {
    schemaVersion: PROGRAM_V3_SCHEMA_VERSION,
    steps: [
      oneStepV3().steps[0],
      { id: 'report', dependsOn: ['count'], prompt: 'Report the count.' },
      { id: 'note', dependsOn: ['report'], prompt: 'Write a note about the report.' },
    ],
  };
  const run = await launchV3(f, program, answeringDispatch({ answers: [{ count: 1 }], replies: ['Counted.', 'Reported.', 'Noted.'], seen }));
  assert.equal(run.result.status, 'completed', run.result.reason);
  const artifactsOf = (task) => JSON.parse(/Dependency artifacts:\n(.*)/.exec(task)[1]);
  const [countDep] = artifactsOf(seen[1].task);
  assert.equal(countDep.actionId, 'count');
  assert.deepEqual(countDep.answer, { attemptId: 'count-1', file: join(run.runDir, 'answer-count-attempt-1.json') });
  assert.deepEqual(JSON.parse(readFileSync(countDep.answer.file, 'utf8')), { count: 1 });
  const [reportDep] = artifactsOf(seen[2].task);
  assert.equal(reportDep.actionId, 'report');
  assert.equal(Object.hasOwn(reportDep, 'answer'), false, 'a dependency that declares no answer adds no key');
});

// --- wave B red tests (design section 12): control nodes ---------------------

// The stored v3 shape as the kernel will hand it over: the steps, plus the
// run's gates and loops as control nodes {id, type, dependsOn} (design
// section 4). Wave B builds this; until then the scheduler refuses a step
// that depends on a gate id.
function controlNodes(state) {
  const { gates, loops } = state.program.control;
  return [
    ...loops.map((loop) => ({ id: loop.id, type: 'loop', dependsOn: [...loop.steps], ownedFiles: [] })),
    ...gates.map((gate) => ({ id: gate.id, type: 'gate', dependsOn: [...gate.dependsOn], ownedFiles: [] })),
  ];
}

test('the scheduler holds dependents behind a waiting gate', () => {
  const state = acceptedV3State();
  const statuses = Object.fromEntries(state.actions.map((action) => [action.id, action.id === 'post' ? 'pending' : 'succeeded']));
  statuses.polish = 'passed';
  statuses.approve = 'waiting';
  const schedule = scheduleV2Actions([...state.program.actions, ...controlNodes(state)], statuses);
  assert.deepEqual(schedule.selected, []);
  assert.deepEqual(schedule.blocked, []);
  assert.deepEqual(schedule.waiting.map((entry) => entry.id), ['post']);
});

test('resume leaves control nodes alone', async (t) => {
  const f = v3Fixture(t);
  const runId = 'wf-acme01-a1b2c3';
  const runDir = join(f.bullswarmDir, 'workflows', runId);
  mkdirSync(runDir, { recursive: true });
  const state = acceptedV3State(section2Example(), f.goalDocument, { runId, shortId: 'acme01' });
  const at = '2026-09-28T08:00:00.000Z';
  for (const action of state.actions) if (action.id !== 'post') {
    Object.assign(action, { status: 'succeeded', attempts: 1, startedAt: at, finishedAt: at });
    state.attempts.push({
      id: `${action.id}-1`, actionId: action.id, ordinal: 1, status: 'succeeded', pool: 'acme-pool', model: 'acme-model',
      startedAt: at, finishedAt: at, taskFile: join(runDir, `task-${action.id}.md`), outputFile: join(runDir, `out-${action.id}.md`), failureKind: null, why: null, usage: null,
    });
  }
  Object.assign(state.lifecycle, { status: 'waiting', startedAt: at, waitingFor: [{ id: 'approve', type: 'gate', since: at, note: 'Read brief.md and decide whether to publish' }] });
  // The loop passed and the gate waits, as the kernel stored them.
  state.controlNodes = [
    { id: 'polish', type: 'loop', status: 'passed', at, round: 1, maxRounds: 3 },
    { id: 'approve', type: 'gate', status: 'waiting', at },
  ];
  writeFileSync(join(runDir, 'goal.json'), JSON.stringify(f.goalDocument));
  writeFileSync(join(runDir, 'state.json'), serializeV2DurableState(state));
  writeFileSync(join(runDir, 'features.json'), JSON.stringify({ ...STAGE3_RUN_FEATURES, programFormat: 3 }));
  const dispatched = [];
  const resumed = await runV2AutonomousWorkflow({
    bullswarmDir: f.bullswarmDir, resumeRunId: runId, pools: [], parentEnv: {},
    dependencies: { refreshPools: async () => null, dispatchV2Action: (options) => { dispatched.push(options.action?.id); return scriptedDispatch()(options); } },
  });
  assert.deepEqual(dispatched, [], 'nothing behind the waiting gate runs');
  assert.deepEqual(resumed.state.lifecycle.waitingFor.map((entry) => entry.id), ['approve']);
  assert.deepEqual(resumed.waiting?.map((entry) => entry.id), ['approve']);
  assert.deepEqual(resumed.state.controlNodes.map((record) => [record.id, record.status]), [['polish', 'passed'], ['approve', 'waiting']]);
  assert.equal(resumed.state.actions.find((action) => action.id === 'post').status, 'pending');
});
