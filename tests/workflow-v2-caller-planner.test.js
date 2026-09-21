// Caller-as-planner: the invoking agent authors the V2 program directly and the
// kernel pauses durably at every later planning boundary instead of
// dispatching a Workflow Planner process. Runtime-level tests use the fake
// dispatcher; CLI-level tests drive the real binary against a local
// deterministic connector so no planner task can ever reach a worker.

import { test } from 'node:test';
import { loadProviders } from '../src/lib/providers.js';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { readEvents } from '../src/workflow/events.js';
import { createV2GoalDocument, deserializeV2DurableState } from '../src/workflow/v2-state.js';
import {
  runV2AutonomousWorkflow, submitCallerPlannerResponse, acceptCallerPlannerResponse, readCallerPlannerRequest,
} from '../src/workflow/v2-runtime.js';
import { requestCancel } from '../src/workflow/dashboard.js';
import { queueSteering } from '../src/workflow/steering.js';
import {
  buildV2PlannerContract, buildV2PlannerPrompt, createV2PlannerContext, normalizeCallerPlannerResponse,
  v2PlannerContractRules, V2PlannerValidationError,
} from '../src/workflow/v2-planner.js';

const REPO = resolve(new URL('..', import.meta.url).pathname);
const BIN = join(REPO, 'bin', 'bullswarm.js');

const requirement = { id: 'report-correct', text: 'report.md exists and contains READY' };
const program = () => ({
  schemaVersion: 'bullswarm.workflow.program.v2',
  actions: [
    { id: 'write-report', purpose: 'Write report', dependsOn: [], affects: ['report-correct'], ownedFiles: ['report.md'], prompt: 'Write READY to report.md.', lane: 'build', effort: 'low', evidenceFor: [], inputs: [], produces: ['report'] },
    { id: 'inspect-report', purpose: 'Inspect report', dependsOn: ['write-report'], affects: [], ownedFiles: [], prompt: 'Inspect report.md.', lane: 'analyze', effort: 'low', evidenceFor: ['report-correct'], inputs: ['report'], produces: [] },
  ],
});
const envelope = () => ({
  schemaVersion: 'bullswarm.workflow.planner-response.v2', kind: 'program',
  summary: 'Write the report and independently inspect it.', program: program(),
});

function setup(settings = {}) {
  const root = mkdtempSync(join(tmpdir(), 'bullswarm-v2-caller-'));
  const bullswarmDir = join(root, 'home');
  const workspace = join(root, 'repo');
  mkdirSync(bullswarmDir); mkdirSync(workspace);
  const goal = createV2GoalDocument({
    goal: 'Deliver a correct report', cwd: workspace, requirements: [requirement],
    settings: { scout: false, concurrency: 2, maxExpansionRounds: 1, plannerMode: 'caller', ...settings },
  });
  return { root, bullswarmDir, workspace, goal, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function fakeDispatch(handler) {
  let calls = 0;
  const seen = [];
  const dispatch = async (options) => {
    calls += 1;
    seen.push(options.action.id);
    const files = typeof options.paths === 'function' ? options.paths(1) : options.paths;
    const startedAt = '2026-09-06T01:00:01.000Z';
    options.onAttempt?.('started', { ordinal: 1, pool: 'relay', model: 'gpt-5.6-luna', status: 'running', startedAt, taskFile: files.taskFile, outFile: files.outFile, routing: {} });
    const value = await handler(options, calls, files);
    const record = {
      ordinal: 1, pool: 'relay', model: 'gpt-5.6-luna', status: value.ok ? 'succeeded' : 'failed',
      startedAt, finishedAt: '2026-09-06T01:00:02.000Z', taskFile: files.taskFile, outFile: files.outFile,
      failureKind: value.failureKind ?? null, why: value.verdict?.why ?? null,
      usage: { tokens: { totalKnown: 10 } }, wallSec: 1, routing: {},
    };
    options.onAttempt?.('finished', record, value.verdict);
    return { attempts: [record], ...value };
  };
  dispatch.calls = () => calls;
  dispatch.seen = () => [...seen];
  return dispatch;
}

function evidenceHandler({ status = 'passed', concerns = [] } = {}) {
  return async (options, _calls, files) => {
    if (options.action.id === 'workflow-planner') throw new Error('caller-planner mode must never dispatch a planner');
    if (options.action.evidenceFor?.length) {
      const candidatePath = options.taskText.match(/exact durable path: '([^']+)'/)?.[1];
      const evidence = { schemaVersion: 'bullswarm.workflow.evidence.v2', requirements: Object.fromEntries(options.action.evidenceFor.map((id) => [id, { status, evidence: [`${id} inspected`], concerns }])) };
      writeFileSync(candidatePath, JSON.stringify(evidence));
      writeFileSync(files.outFile, 'The durable evidence candidate validated.');
      const structured = options.outputValidator('prose');
      return { ok: true, status: 'succeeded', verdict: { ok: true, structured, outFile: files.outFile, meta: { exitCode: 0 } } };
    }
    writeFileSync(join(options.targetDir, 'report.md'), 'READY\n');
    writeFileSync(files.outFile, 'wrote report.md');
    return { ok: true, status: 'succeeded', verdict: { ok: true, why: 'verified', outFile: files.outFile, meta: { exitCode: 0 } } };
  };
}

test('the dispatched planner prompt and the caller contract share one rulebook', () => {
  const f = setup();
  try {
    const contract = buildV2PlannerContract(f.goal, { launchCommand: 'bullswarm workflow goal ...' });
    assert.equal(contract.schemaVersion, 'bullswarm.workflow.planner-contract.v2');
    assert.deepEqual(contract.requirements, [{ id: 'report-correct', text: requirement.text, mandatory: true }]);
    assert.equal(contract.plannerMode, 'caller');
    assert.ok(contract.program.example.program.actions.length >= 2);
    assert.ok(contract.rules.length >= 20);
    const callerRules = v2PlannerContractRules({ workspaceMutation: 'allowed', boundary: 'initial', plannerMode: 'caller' });
    const dispatchedRules = v2PlannerContractRules({ workspaceMutation: 'allowed', boundary: 'initial' });
    assert.deepEqual(contract.rules, callerRules);
    // The two modes share every rule except the scout-unit rule, which is a
    // kernel-enforced requirement for a dispatched planner and advisory for a
    // caller planner (the validator never rejects a caller program for it).
    const differing = callerRules.filter((rule, index) => rule !== dispatchedRules[index]);
    assert.equal(differing.length, 1);
    assert.match(differing[0], /advisory default action boundaries/);
    assert.match(differing[0], /never rejected for a missing unit/);
    assert.ok(dispatchedRules.some((rule) => /kernel-required work action/.test(rule)));
    assert.throws(() => v2PlannerContractRules({ plannerMode: 'robot' }), /plannerMode must be dispatched or caller/);
    const state = { ...JSON.parse(JSON.stringify(f.goal)) };
    const context = { schemaVersion: 'bullswarm.workflow.planner-context.v2', boundary: 'initial', intent: state.intent, targets: {}, execution: {}, knownActions: [], freshPassedRequirements: [], gaps: null, scout: null, scoutUnits: [], steering: [], correction: null };
    const prompt = buildV2PlannerPrompt(context);
    for (const rule of dispatchedRules) assert.ok(prompt.includes(rule), `prompt must contain contract rule: ${rule.slice(0, 40)}`);
  } finally { f.cleanup(); }
});

test('bare programs are wrapped into a planner response; foreign documents are rejected', () => {
  const wrapped = normalizeCallerPlannerResponse(program(), { summary: null });
  assert.equal(wrapped.kind, 'program');
  assert.equal(wrapped.schemaVersion, 'bullswarm.workflow.planner-response.v2');
  assert.match(wrapped.summary, /Write report; Inspect report/);
  assert.deepEqual(wrapped.program, program());
  assert.equal(normalizeCallerPlannerResponse(program(), { summary: 'Named' }).summary, 'Named');
  assert.deepEqual(normalizeCallerPlannerResponse(envelope()), envelope());
  const exhausted = normalizeCallerPlannerResponse({ kind: 'exhausted' }, { exhaustedReason: 'nothing bounded remains' });
  assert.equal(exhausted.kind, 'exhausted');
  assert.equal(exhausted.reason, 'nothing bounded remains');
  assert.throws(() => normalizeCallerPlannerResponse({ schemaVersion: 'bullswarm.workflow.v1', phases: [] }), V2PlannerValidationError);
  assert.throws(() => normalizeCallerPlannerResponse('not an object'), V2PlannerValidationError);
});

test('a caller-supplied initial program runs to a kernel-verified result with zero planner or scout dispatches', async () => {
  const f = setup();
  try {
    const dispatch = fakeDispatch(evidenceHandler());
    const result = await runV2AutonomousWorkflow({
      bullswarmDir: f.bullswarmDir, goalDocument: f.goal, pools: [], runId: 'wf-caller1-abcdef',
      initialPlannerResponse: envelope(), dependencies: { dispatchV2Action: dispatch },
    });
    assert.equal(result.result.status, 'completed');
    assert.equal(result.result.verified, true);
    assert.deepEqual(dispatch.seen(), ['write-report', 'inspect-report']);
    assert.equal(result.state.planner.turns, 1);
    assert.equal(result.state.planner.attempts.length, 0, 'no planner process ran');
    assert.equal(result.state.planner.awaiting, null);
    assert.equal(result.state.preflight.scout.status, 'skipped');
    const events = readEvents(result.runDir);
    const planned = events.find((event) => event.type === 'planner.finished');
    assert.equal(planned.payload.source, 'caller');
    assert.equal(planned.payload.boundary, 'initial');
    assert.ok(existsSync(join(result.runDir, 'candidate-workflow-planner-turn-1.json')));
    assert.equal(events.some((event) => event.type === 'planner.started'), false);
  } finally { f.cleanup(); }
});

test('an invalid initial program finishes at once and hands the issues back without dispatching anything', async () => {
  const f = setup();
  try {
    const dispatch = fakeDispatch(evidenceHandler());
    const bad = envelope();
    bad.program.actions.pop(); // no evidence action for the mandatory requirement
    const result = await runV2AutonomousWorkflow({
      bullswarmDir: f.bullswarmDir, goalDocument: f.goal, pools: [], runId: 'wf-caller2-abcdef',
      initialPlannerResponse: bad, dependencies: { dispatchV2Action: dispatch },
    });
    assert.equal(dispatch.calls(), 0);
    assert.equal(result.awaiting, undefined, 'nothing waits for the caller');
    assert.equal(result.result.status, 'partial');
    assert.match(result.result.reason, /^the supplied program was not accepted, so nothing ran: .*mandatory requirement "report-correct" has no evidence action/);
    assert.match(result.result.reason, /plan revise \S+ --program <file\.json>, or start a new run$/);
    assert.deepEqual(result.result.handback.unfinished, []);
    assert.deepEqual(result.result.handback.unresolvedRequirements.map((entry) => entry.id), ['report-correct']);
    const state = deserializeV2DurableState(readFileSync(join(result.runDir, 'state.json'), 'utf8'));
    assert.equal(state.lifecycle.status, 'partial');
    assert.equal(state.planner.awaiting, null);
    const events = readEvents(result.runDir);
    const handed = events.find((event) => event.type === 'planner.handed_back');
    assert.equal(handed.payload.boundary, 'initial');
    assert.ok(handed.payload.issues.some((issue) => /has no evidence action/.test(issue)));
    assert.equal(events.at(-1).type, 'workflow.finished');
    assert.equal(existsSync(join(result.runDir, 'initial-planner-response.json')), false, 'a rejected program is never replayed by a resume');
  } finally { f.cleanup(); }
});

test('a gap finishes the run and hands it back; resume changes nothing; a run an older version left waiting still takes a submission', async () => {
  const f = setup();
  try {
    // First evidence fails the requirement so the kernel consolidates a gap.
    let evidenceStatus = 'failed';
    const dispatch = fakeDispatch(async (options, calls, files) => evidenceHandler({ status: evidenceStatus })(options, calls, files));
    const finished = await runV2AutonomousWorkflow({
      bullswarmDir: f.bullswarmDir, goalDocument: f.goal, pools: [], runId: 'wf-caller3-abcdef',
      initialPlannerResponse: envelope(), dependencies: { dispatchV2Action: dispatch },
    });
    assert.equal(finished.result.status, 'partial');
    assert.equal(finished.result.verified, false);
    assert.match(finished.result.reason, /^requirements are still open and no step is left to run: .*report-correct=failed/);
    assert.deepEqual(
      finished.result.handback.unresolvedRequirements.map((entry) => [entry.id, entry.status, entry.why]),
      [['report-correct', 'failed', 'report-correct inspected']],
    );
    assert.deepEqual(finished.result.handback.unfinished, []);
    assert.equal(finished.state.planner.awaiting, null);
    assert.deepEqual(dispatch.seen(), ['write-report', 'inspect-report']);
    assert.equal(readEvents(finished.runDir).filter((event) => event.type === 'planner.awaiting_caller').length, 0);

    // Resuming a finished run with nothing to retry returns its result and dispatches nothing.
    const again = await runV2AutonomousWorkflow({ bullswarmDir: f.bullswarmDir, resumeRunId: 'wf-caller3-abcdef', pools: [], dependencies: { dispatchV2Action: dispatch } });
    assert.deepEqual(again.result, finished.result);
    assert.equal(dispatch.calls(), 2);

    // A run an older kernel left waiting at this gap still accepts a program.
    const paused = { runDir: finished.runDir, ...holdLikeOlderVersion(finished.runDir) };
    assert.equal(paused.turn, 2);

    // A submission that re-uses a known action ID is rejected and leaves state unchanged.
    const collision = submitCallerPlannerResponse({ bullswarmDir: f.bullswarmDir, runId: 'wf-caller3-abcdef', response: envelope() });
    assert.equal(collision.ok, false);
    assert.equal(collision.boundary, 'gaps');
    assert.ok(collision.issues.some((issue) => /collides with known action/.test(issue)));
    const untouched = deserializeV2DurableState(readFileSync(join(paused.runDir, 'state.json'), 'utf8'));
    assert.equal(untouched.planner.turns, 1);
    assert.ok(untouched.planner.awaiting);

    // A valid gap-closing program is accepted, recorded, and the resumed kernel completes.
    evidenceStatus = 'passed';
    const fix = {
      schemaVersion: 'bullswarm.workflow.program.v2',
      actions: [
        { id: 'rewrite-report', purpose: 'Rewrite report', dependsOn: ['write-report'], affects: ['report-correct'], ownedFiles: ['report.md'], prompt: 'Rewrite report.md with READY.', lane: 'build', effort: 'low', evidenceFor: [], inputs: [], produces: ['report-2'] },
        { id: 'reinspect-report', purpose: 'Reinspect report', dependsOn: ['rewrite-report'], affects: [], ownedFiles: [], prompt: 'Inspect report.md again.', lane: 'analyze', effort: 'low', evidenceFor: ['report-correct'], inputs: ['report-2'], produces: [] },
      ],
    };
    const submitted = submitCallerPlannerResponse({ bullswarmDir: f.bullswarmDir, runId: 'wf-caller3-abcdef', response: normalizeCallerPlannerResponse(fix, { summary: 'Close the report gap' }) });
    assert.equal(submitted.ok, true);
    assert.equal(submitted.accepted.kind, 'program');
    assert.equal(submitted.state.planner.turns, 2);
    assert.equal(submitted.state.planner.awaiting, null);
    assert.equal(submitted.state.budget.expansions, 1);
    assert.equal(submitted.state.program.revision, 2);
    assert.equal(submitted.state.program.actions.length, 4);
    assert.equal(submitted.state.lifecycle.status, 'running');
    assert.ok(existsSync(submitted.candidatePath));
    const turns = readEvents(paused.runDir).filter((event) => event.type === 'planner.finished');
    assert.equal(turns.length, 2);
    assert.equal(turns[1].payload.source, 'caller');
    assert.equal(turns[1].payload.boundary, 'gaps');

    const resumed = await runV2AutonomousWorkflow({ bullswarmDir: f.bullswarmDir, resumeRunId: 'wf-caller3-abcdef', pools: [], dependencies: { dispatchV2Action: dispatch } });
    assert.equal(resumed.result.status, 'completed');
    assert.equal(resumed.result.verified, true);
    assert.deepEqual(dispatch.seen(), ['write-report', 'inspect-report', 'rewrite-report', 'reinspect-report']);
    assert.equal(resumed.state.planner.attempts.length, 0);
    assert.equal(resumed.result.requirements[0].status, 'passed');
  } finally { f.cleanup(); }
});

test('a run an older version left waiting: a submitted exhausted decision survives resume and finalizes a partial result with gaps', async () => {
  const f = setup();
  try {
    const dispatch = fakeDispatch(evidenceHandler({ status: 'failed' }));
    const finished = await runV2AutonomousWorkflow({
      bullswarmDir: f.bullswarmDir, goalDocument: f.goal, pools: [], runId: 'wf-caller4-abcdef',
      initialPlannerResponse: envelope(), dependencies: { dispatchV2Action: dispatch },
    });
    assert.equal(finished.result.status, 'partial');
    assert.equal(holdLikeOlderVersion(finished.runDir).boundary, 'gaps');
    const submitted = submitCallerPlannerResponse({
      bullswarmDir: f.bullswarmDir, runId: 'wf-caller4-abcdef',
      response: normalizeCallerPlannerResponse({ kind: 'exhausted' }, { exhaustedReason: 'the fixture cannot satisfy READY' }),
    });
    assert.equal(submitted.ok, true);
    assert.equal(submitted.accepted.kind, 'exhausted');
    assert.equal(submitted.state.planner.status, 'completed');
    const resumed = await runV2AutonomousWorkflow({ bullswarmDir: f.bullswarmDir, resumeRunId: 'wf-caller4-abcdef', pools: [], dependencies: { dispatchV2Action: dispatch } });
    assert.equal(resumed.result.status, 'partial');
    assert.equal(resumed.result.reason, 'the fixture cannot satisfy READY');
    assert.match(resumed.result.gaps.summary, /report-correct=failed/);
    assert.equal(dispatch.calls(), 2, 'no extra dispatch after exhausted');
  } finally { f.cleanup(); }
});

test('caller mode without a program scouts first, then finishes and hands the scout report back', async () => {
  const f = setup({ scout: true });
  try {
    const scoutReport = [
      'TREE:\n- report.md', 'MANIFEST:\n- Node.js', 'TEST STATUS:\n- tests pass',
      'UNITS OF WORK:\n- report-unit', 'SHARED FILES:\n- none', 'RISKS:\n- none',
      'Additional repository facts '.repeat(8), '["report-unit"]',
    ].join('\n');
    const dispatch = fakeDispatch(async (options, _calls, files) => {
      if (options.action.id !== 'preflight-scout') throw new Error(`unexpected dispatch ${options.action.id}`);
      writeFileSync(files.outFile, scoutReport);
      const structured = options.outputValidator(scoutReport);
      return { ok: true, status: 'succeeded', verdict: { ok: true, structured, outFile: files.outFile, meta: { exitCode: 0 } } };
    });
    const finished = await runV2AutonomousWorkflow({ bullswarmDir: f.bullswarmDir, goalDocument: f.goal, pools: [], runId: 'wf-caller5-abcdef', dependencies: { dispatchV2Action: dispatch } });
    assert.equal(dispatch.calls(), 1);
    assert.equal(finished.result.status, 'partial');
    assert.equal(finished.state.planner.awaiting, null);
    const scoutFile = finished.state.preflight.scout.outputFile;
    assert.match(readFileSync(scoutFile, 'utf8'), /UNITS OF WORK/);
    assert.ok(finished.result.reason.startsWith(`no program to run (the scout report is at ${scoutFile}). Add steps with bullswarm workflow plan revise `), finished.result.reason);

    // A run an older version left waiting at the initial boundary: plan show
    // composes the request, and a program need not mirror the scout's units.
    holdLikeOlderVersion(finished.runDir, { boundary: 'initial' });
    const request = readCallerPlannerRequest({ bullswarmDir: f.bullswarmDir, runId: 'wf-caller5-abcdef' }).request;
    assert.deepEqual(request.context.scoutUnits, ['report-unit']);
    assert.equal(request.scoutUnitsAdvisory, true);
    assert.match(request.context.scout, /UNITS OF WORK/);
    // The caller's program does not have to mirror the scout's unit IDs.
    const submitted = submitCallerPlannerResponse({ bullswarmDir: f.bullswarmDir, runId: 'wf-caller5-abcdef', response: envelope() });
    assert.equal(submitted.ok, true, JSON.stringify(submitted.issues ?? null));
    assert.equal(submitted.state.program.actions.map((action) => action.id).join(','), 'write-report,inspect-report');
  } finally { f.cleanup(); }
});

test('submit refuses dispatched-planner runs, terminal runs, and runs that are not waiting', async () => {
  const f = setup({ plannerMode: 'dispatched' });
  try {
    const dispatch = fakeDispatch(async (options, _calls, files) => {
      if (options.action.id === 'workflow-planner') {
        const candidatePath = options.taskText.match(/exact durable path: '([^']+)'/)?.[1];
        writeFileSync(candidatePath, JSON.stringify(envelope()));
        const structured = options.outputValidator('x');
        return { ok: true, status: 'succeeded', verdict: { ok: true, structured, outFile: files.outFile, meta: { exitCode: 0 } } };
      }
      return evidenceHandler()(options, _calls, files);
    });
    const result = await runV2AutonomousWorkflow({ bullswarmDir: f.bullswarmDir, goalDocument: f.goal, pools: [], runId: 'wf-caller6-abcdef', dependencies: { dispatchV2Action: dispatch } });
    assert.equal(result.result.status, 'completed');
    assert.throws(() => submitCallerPlannerResponse({ bullswarmDir: f.bullswarmDir, runId: 'wf-caller6-abcdef', response: envelope() }), /dispatched Workflow Planner/);
    assert.throws(() => submitCallerPlannerResponse({ bullswarmDir: f.bullswarmDir, runId: 'wf-missing-abcdef', response: envelope() }), /no durable state/);
  } finally { f.cleanup(); }
  const g = setup();
  try {
    const dispatch = fakeDispatch(evidenceHandler());
    const result = await runV2AutonomousWorkflow({ bullswarmDir: g.bullswarmDir, goalDocument: g.goal, pools: [], runId: 'wf-caller7-abcdef', initialPlannerResponse: envelope(), dependencies: { dispatchV2Action: dispatch } });
    assert.equal(result.result.status, 'completed');
    assert.throws(() => submitCallerPlannerResponse({ bullswarmDir: g.bullswarmDir, runId: 'wf-caller7-abcdef', response: envelope() }), /already terminal/);
  } finally { g.cleanup(); }
});

test('acceptCallerPlannerResponse records the same bookkeeping a dispatched planner turn would', async () => {
  const f = setup();
  try {
    const runDir = join(f.bullswarmDir, 'workflows', 'wf-caller8-abcdef');
    mkdirSync(runDir, { recursive: true });
    const { createV2DurableState } = await import('../src/workflow/v2-state.js');
    const state = createV2DurableState(f.goal, { runId: 'wf-caller8-abcdef', shortId: 'abc234' });
    const { state: next, accepted } = acceptCallerPlannerResponse(state, envelope(), { boundary: 'initial', runDir });
    assert.equal(accepted.kind, 'program');
    assert.equal(next.planner.turns, 1);
    assert.equal(next.planner.status, 'waiting');
    assert.equal(next.program.revision, 1);
    assert.deepEqual(next.actions.map((action) => action.status), ['pending', 'pending']);
    assert.deepEqual(next.presentation.stages.map((stage) => stage.label), ['Implementation', 'Evidence']);
    assert.equal(next.budget.expansions, 0);
    assert.equal(readEvents(runDir).at(-1).type, 'planner.finished');
    assert.equal(state.planner.turns, 0, 'input state is not mutated');
  } finally { f.cleanup(); }
});

// --- CLI ------------------------------------------------------------------------

function cliFixture() {
  const root = mkdtempSync(join(tmpdir(), 'bullswarm-caller-cli-'));
  const home = join(root, '.bullswarm');
  const target = join(root, 'target');
  mkdirSync(join(home, 'connectors'), { recursive: true });
  mkdirSync(target, { recursive: true });
  const worker = join(root, 'caller-worker.mjs');
  writeFileSync(worker, [
    'import { readFileSync, writeFileSync, existsSync } from "node:fs";',
    'const task = readFileSync(process.argv[2], "utf8");',
    'if (task.includes("single logical Workflow Planner for Bullswarm autonomous V2")) {',
    '  process.stderr.write("PLANNER DISPATCHED IN CALLER MODE"); process.exit(9);',
    '} else if (task.includes("read-only SCOUT")) {',
    '  process.stdout.write(["TREE:\\n- target/", "MANIFEST:\\n- fixture repository", "TEST STATUS:\\n- no test command required", "UNITS OF WORK:\\n- create-done: create done.txt and inspect it", "SHARED FILES:\\n- none", "RISKS:\\n- exact byte content must match", "The target is a bounded disposable fixture. ".repeat(8), "[\\\"create-done\\\"]"].join("\\n"));',
    '} else if (task.includes("autonomous V2 evidence action")) {',
    '  const ok = existsSync("done.txt") && readFileSync("done.txt", "utf8") === "caller-complete\\n";',
    '  const candidate = task.match(/exact durable path: \'([^\']+)\'/)?.[1];',
    '  writeFileSync(candidate, JSON.stringify({schemaVersion:"bullswarm.workflow.evidence.v2",requirements:{"requirement-1":{status:ok?"passed":"failed",evidence:[ok?"done.txt has the exact line":"done.txt missing or wrong"],concerns:[]}}}));',
    '  process.stdout.write("The durable evidence candidate validated.");',
    '} else if (/Bullswarm (?:autonomous V2|program) action: skip-work/.test(task)) {',
    '  process.stdout.write("Deliberately did not create the file so the evidence fails and the kernel consolidates a gap. This is the bounded fixture behaviour for the gap test.");',
    '} else {',
    '  writeFileSync("done.txt", "caller-complete\\n");',
    '  process.stdout.write("Implemented the bounded action and wrote done.txt with the exact caller-complete line, then read it back to confirm acceptance.");',
    '}',
  ].join('\n'));
  const connector = {
    name: 'caller-agent', bin: 'node', configDirs: [],
    spawn: { cmd: ['node', worker, '{taskFile}'], cwdMode: 'add-dir' },
    authSignatures: [], outputExtraction: { strategy: 'stdout' },
    meter: { type: 'none' }, costRank: 1, lanes: ['analyze', 'build', 'chore'],
    capabilities: ['strong-analysis', 'workflow-planning', 'code-reading', 'file-editing'],
    knownModels: ['worker-luna'], modelSelection: { flag: '--model', mode: 'replace-or-append' },
    timeoutSec: 30,
  };
  writeFileSync(join(home, 'connectors', 'caller-agent.json'), `${JSON.stringify(connector, null, 2)}\n`);
  // First-class providers load in every home and their pools default to
  // enabled, so disable each one: the goal may only route to the fixture
  // worker, never to a real provider CLI on the developer's machine.
  const pools = { 'caller-agent': { enabled: true } };
  for (const provider of loadProviders(home).providers) {
    for (const name of provider.pools ?? []) pools[name] ??= { enabled: false };
  }
  writeFileSync(join(home, 'state.json'), `${JSON.stringify({
    version: 1, pools, incumbents: {}, decisionLog: [],
    config: { depthLimit: 2, callerName: 'claude-code', worktreeIsolation: 'off' },
  }, null, 2)}\n`);
  return { root, home, target, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function cli(f, args) {
  return spawnSync(process.execPath, [BIN, ...args], {
    cwd: REPO, env: { ...process.env, BULLSWARM_HOME: f.home, BULLSWARM_DEPTH: '0' },
    encoding: 'utf8', timeout: 30_000,
  });
}

const GOAL = '1. Create done.txt containing exactly caller-complete followed by a newline.';

// Runs no longer wait for their caller, but runs an older version left waiting
// are still on disk. Recreate one from a finished run: the held state that
// kernel wrote, with no result yet and no request document (plan show
// composes it).
function holdLikeOlderVersion(runDir, { boundary = 'gaps' } = {}) {
  const statePath = join(runDir, 'state.json');
  const state = JSON.parse(readFileSync(statePath, 'utf8'));
  const turn = state.planner.turns + 1;
  state.lifecycle = { ...state.lifecycle, status: 'waiting', finishedAt: null, resultFile: null };
  state.planner.status = 'waiting';
  state.planner.awaiting = {
    boundary, turn, since: new Date().toISOString(),
    requestPath: join(runDir, `planner-request-turn-${turn}.json`),
    candidatePath: join(runDir, `candidate-workflow-planner-turn-${turn}.json`),
  };
  rmSync(join(runDir, 'result.json'), { force: true });
  writeFileSync(statePath, JSON.stringify(state));
  return { runId: state.runId, shortId: state.shortId, boundary, turn };
}

// Legacy saved requests intentionally omit executionMode. The run finishes
// partial at its gap and is then turned into the held run an older version
// would have left, to exercise the real CLI recovery path.
function launchLegacyGoal(f, programPath, cwd = f.target) {
  const runId = 'wf-legacy-abcdef';
  const requestPath = join(f.root, 'legacy-request.json');
  const document = createV2GoalDocument({
    goal: GOAL, cwd,
    requirements: [{ id: 'requirement-1', text: 'Create done.txt containing exactly caller-complete followed by a newline.' }],
    settings: { scout: false, plannerMode: 'caller', workspaceMode: 'shared', concurrency: 2, maxExpansionRounds: 2 },
  });
  writeFileSync(requestPath, JSON.stringify({
    schemaVersion: 'bullswarm.goal.request.v2', runId, document,
    initialPlannerResponse: normalizeCallerPlannerResponse(JSON.parse(readFileSync(programPath, 'utf8'))),
  }));
  const finished = cli(f, ['workflow', 'goal', '--request', requestPath, '--run-id', runId, '--foreground', '--json']);
  assert.equal(finished.status, 1, finished.stderr || finished.stdout);
  assert.equal(JSON.parse(finished.stdout).status, 'partial');
  return holdLikeOlderVersion(join(f.home, 'workflows', runId));
}

function cliProgram(workId = 'create-done') {
  return {
    schemaVersion: 'bullswarm.workflow.program.v2',
    actions: [
      { id: workId, purpose: 'Create done.txt', dependsOn: [], affects: ['requirement-1'], ownedFiles: ['done.txt'], prompt: 'Create done.txt with the exact line caller-complete.', lane: 'build', effort: 'low', evidenceFor: [], inputs: [], produces: ['done'] },
      { id: `check-${workId}`, purpose: 'Inspect done.txt', dependsOn: [workId], affects: [], ownedFiles: [], prompt: 'Read done.txt and compare bytes.', lane: 'analyze', effort: 'low', evidenceFor: ['requirement-1'], inputs: ['done'], produces: [] },
    ],
  };
}

test('CLI: plan contract exposes requirement IDs, rules, and the example without touching state', () => {
  const f = cliFixture();
  try {
    const result = cli(f, ['workflow', 'plan', 'contract', GOAL, '--cwd', f.target, '--json']);
    assert.equal(result.status, 0, result.stderr);
    const contract = JSON.parse(result.stdout);
    assert.equal(contract.action, 'plan-contract');
    assert.deepEqual(contract.requirements.map((requirement) => requirement.id), ['requirement-1']);
    assert.match(contract.requirements[0].text, /caller-complete/);
    assert.equal(contract.settings.plannerMode, 'caller');
    assert.equal(contract.settings.scout, false);
    assert.equal(contract.settings.executionMode, 'program');
    assert.ok(contract.rules.some((rule) => /integrator/.test(rule)));
    assert.equal(contract.program.schemaVersion, 'bullswarm.workflow.program.v2');
    assert.match(contract.launch.command, /--program plan\.json --json$/);
    // One requirement means one verdict for the whole goal, so the contract
    // says so and explains what numbering buys. It is advice: a goal that
    // already splits into several requirements never carries it.
    assert.match(contract.advice.requirements, /tracked as one requirement/);
    assert.match(contract.advice.requirements, /do not invent clauses to split it/);
    const split = cli(f, ['workflow', 'plan', 'contract', '1. Create done.txt. 2. Keep the suite green.', '--cwd', f.target, '--json']);
    assert.equal(split.status, 0, split.stderr);
    const splitContract = JSON.parse(split.stdout);
    assert.equal(splitContract.requirements.length, 2);
    assert.equal('advice' in splitContract, false);
    assert.equal(existsSync(join(f.home, 'workflows')), false, 'contract must not create a run');
  } finally { f.cleanup(); }
});

test('CLI: goal --program executes a caller-authored program end to end without any planner process', () => {
  const f = cliFixture();
  try {
    const programPath = join(f.root, 'plan.json');
    writeFileSync(programPath, JSON.stringify(cliProgram()));
    const result = cli(f, ['workflow', 'goal', GOAL, '--cwd', f.target, '--program', programPath, '--summary', 'Create and check done.txt', '--foreground', '--json']);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const report = JSON.parse(result.stdout);
    assert.equal(report.schemaVersion, 'bullswarm.workflow.result.v2');
    assert.equal(report.status, 'completed');
    assert.equal(report.verified, true);
    assert.deepEqual(report.actions.map((action) => action.id), ['create-done', 'check-create-done']);
    assert.equal(readFileSync(join(f.target, 'done.txt'), 'utf8'), 'caller-complete\n');
    const state = JSON.parse(readFileSync(join(f.home, 'workflows', report.runId, 'state.json'), 'utf8'));
    assert.equal(state.config.settings.plannerMode, 'caller');
    assert.equal(state.config.settings.scout, false);
    assert.equal(state.preflight.scout.status, 'skipped');
    assert.equal(state.planner.attempts.length, 0);
    assert.equal(state.planner.turns, 1);
    assert.equal(state.planner.lastDecision.summary, 'Create and check done.txt');
    assert.equal(state.config.plannerRouting, null);
    const goal = JSON.parse(readFileSync(join(f.home, 'workflows', report.runId, 'goal.json'), 'utf8'));
    assert.equal(goal.config.settings.plannerMode, 'caller');
    const show = cli(f, ['workflow', 'plan', 'show', report.shortId, '--json']);
    assert.equal(show.status, 1);
    assert.equal(JSON.parse(show.stdout).awaiting, false);
  } finally { f.cleanup(); }
});

test('CLI: an invalid --program is rejected synchronously and nothing is launched', () => {
  const f = cliFixture();
  try {
    const bad = cliProgram();
    bad.actions[0].lane = 'analyze'; // analyze actions may not own files
    const programPath = join(f.root, 'bad.json');
    writeFileSync(programPath, JSON.stringify(bad));
    const result = cli(f, ['workflow', 'goal', GOAL, '--cwd', f.target, '--program', programPath, '--json']);
    assert.equal(result.status, 2);
    const refusal = JSON.parse(result.stdout);
    assert.equal(refusal.error, 'program-invalid');
    assert.match(refusal.message, /caller program invalid \(nothing ran\)/);
    assert.ok(refusal.issues.some((issue) => /analyze actions must not own workspace files/.test(issue)), refusal.issues.join('; '));
    const human = cli(f, ['workflow', 'goal', GOAL, '--cwd', f.target, '--program', programPath]);
    assert.equal(human.status, 2);
    assert.match(human.stderr, /caller program invalid \(nothing ran\)/);
    assert.match(human.stderr, /analyze actions must not own workspace files/);
    assert.equal(existsSync(join(f.home, 'workflows')), false);
    assert.equal(existsSync(join(f.home, 'goals')), false);
    const conflict = cli(f, ['workflow', 'goal', GOAL, '--cwd', f.target, '--program', programPath, '--orchestrator', 'caller-agent', '--json']);
    assert.equal(conflict.status, 2);
    assert.match(conflict.stderr, /--program and --orchestrator are mutually exclusive/);
    const foreign = join(f.root, 'foreign.json');
    writeFileSync(foreign, JSON.stringify({ schemaVersion: 'bullswarm.workflow.v1', phases: [] }));
    const rejected = cli(f, ['workflow', 'goal', GOAL, '--cwd', f.target, '--program', foreign, '--json']);
    assert.equal(rejected.status, 2);
    assert.ok(JSON.parse(rejected.stdout).issues.some((issue) => /schemaVersion must be/.test(issue)), rejected.stdout);
  } finally { f.cleanup(); }
});

test('CLI legacy recovery: a gap pauses the run; plan show explains it; plan submit resumes it to completion', () => {
  const f = cliFixture();
  try {
    const programPath = join(f.root, 'plan.json');
    writeFileSync(programPath, JSON.stringify(cliProgram('skip-work')));
    const awaiting = launchLegacyGoal(f, programPath);
    assert.equal(awaiting.boundary, 'gaps');
    assert.equal(awaiting.turn, 2);
    const token = awaiting.shortId;

    const watch = cli(f, ['workflow', 'watch', token, '--once']);
    assert.equal(watch.status, 0, watch.stderr);
    assert.match(watch.stdout, /waiting for the caller planner \(gaps boundary, turn 2\)/);

    const resultCmd = cli(f, ['workflow', 'runs', 'result', token, '--json']);
    assert.equal(resultCmd.status, 1);
    assert.match(resultCmd.stderr, /left waiting for its caller planner by an older version \(gaps boundary\); bullswarm workflow resume \S+ finishes it/);

    const show = cli(f, ['workflow', 'plan', 'show', token, '--json']);
    assert.equal(show.status, 0, show.stderr);
    const request = JSON.parse(show.stdout);
    assert.equal(request.action, 'plan-request');
    assert.equal(request.boundary, 'gaps');
    assert.match(request.context.gaps.summary, /requirement-1=failed/);
    assert.equal(request.context.knownActions.length, 2);
    assert.equal(request.context.knownActions[0].status, 'succeeded');
    assert.match(request.submit.program, new RegExp(`plan submit ${token}`));
    const human = cli(f, ['workflow', 'plan', 'show', token]);
    assert.equal(human.status, 0);
    assert.match(human.stdout, /waiting for its caller planner · gaps boundary · turn 2/);

    const fixPath = join(f.root, 'plan-2.json');
    writeFileSync(fixPath, JSON.stringify({
      schemaVersion: 'bullswarm.workflow.program.v2',
      actions: [
        { id: 'create-done', purpose: 'Create done.txt for real', dependsOn: ['skip-work'], affects: ['requirement-1'], ownedFiles: ['done.txt'], prompt: 'Create done.txt with the exact line caller-complete.', lane: 'build', effort: 'low', evidenceFor: [], inputs: [], produces: ['done-2'] },
        { id: 'check-create-done', purpose: 'Inspect done.txt', dependsOn: ['create-done'], affects: [], ownedFiles: [], prompt: 'Read done.txt and compare bytes.', lane: 'analyze', effort: 'low', evidenceFor: ['requirement-1'], inputs: ['done-2'], produces: [] },
      ],
    }));
    const rejected = cli(f, ['workflow', 'plan', 'submit', token, '--program', programPath, '--json']);
    assert.equal(rejected.status, 2, rejected.stdout);
    assert.match(rejected.stderr, /rejected at the gaps boundary \(run state unchanged\)/);
    assert.match(rejected.stderr, /collides with known action/);

    const submitted = cli(f, ['workflow', 'plan', 'submit', token, '--program', fixPath, '--summary', 'Close the gap', '--foreground', '--json']);
    assert.equal(submitted.status, 0, submitted.stderr || submitted.stdout);
    const report = JSON.parse(submitted.stdout);
    assert.equal(report.schemaVersion, 'bullswarm.workflow.result.v2');
    assert.equal(report.status, 'completed');
    assert.equal(report.verified, true);
    assert.deepEqual(report.actions.map((action) => action.id), ['skip-work', 'check-skip-work', 'create-done', 'check-create-done']);
    assert.equal(readFileSync(join(f.target, 'done.txt'), 'utf8'), 'caller-complete\n');
    const state = JSON.parse(readFileSync(join(f.home, 'workflows', report.runId, 'state.json'), 'utf8'));
    assert.equal(state.planner.turns, 2);
    assert.equal(state.budget.expansions, 1);
    assert.equal(state.planner.attempts.length, 0);
    const events = readEvents(join(f.home, 'workflows', report.runId));
    assert.equal(events.filter((event) => event.type === 'planner.handed_back').length, 1, 'the first finish handed the gap back');
    assert.equal(events.filter((event) => event.type === 'planner.finished' && event.payload.source === 'caller').length, 2);

    const done = cli(f, ['workflow', 'plan', 'submit', token, '--program', fixPath, '--json']);
    assert.equal(done.status, 1);
    assert.match(done.stderr, /already terminal/);
  } finally { f.cleanup(); }
});

test('CLI legacy recovery: plan submit --exhausted finalizes a partial result', () => {
  const f = cliFixture();
  try {
    const programPath = join(f.root, 'plan.json');
    writeFileSync(programPath, JSON.stringify(cliProgram('skip-work')));
    const token = launchLegacyGoal(f, programPath).shortId;
    const missingReason = cli(f, ['workflow', 'plan', 'submit', token, '--exhausted']);
    assert.equal(missingReason.status, 2);
    const submitted = cli(f, ['workflow', 'plan', 'submit', token, '--exhausted', '--reason', 'fixture cannot produce the file', '--foreground', '--json']);
    assert.equal(submitted.status, 1, submitted.stderr || submitted.stdout);
    const report = JSON.parse(submitted.stdout);
    assert.equal(report.status, 'partial');
    assert.equal(report.reason, 'fixture cannot produce the file');
    assert.match(report.gaps.summary, /requirement-1=failed/);
  } finally { f.cleanup(); }
});

test('CLI: detached program returns negative evidence durably without another planner round', async () => {
  const f = cliFixture();
  try {
    const programPath = join(f.root, 'plan.json');
    writeFileSync(programPath, JSON.stringify({ ...cliProgram('skip-work'), defaults: { verifyRounds: 1 } }));
    const launched = cli(f, ['workflow', 'goal', GOAL, '--cwd', f.target, '--program', programPath, '--json']);
    assert.equal(launched.status, 0, launched.stderr || launched.stdout);
    const launch = JSON.parse(launched.stdout);
    assert.equal(launch.action, 'goal-launched');
    assert.equal(launch.plannerMode, 'caller');
    assert.equal(launch.requestedOrchestrator, 'caller');
    assert.match(launch.observe.plan, /workflow plan export \S+ --out plan\.json/);
    assert.ok(launch.instructions.callerPlanner);
    const statePath = join(f.home, 'workflows', launch.runId, 'state.json');
    let state = null;
    for (let i = 0; i < 200 && !(state?.lifecycle?.resultFile); i += 1) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
      try { state = JSON.parse(readFileSync(statePath, 'utf8')); } catch { /* not yet */ }
    }
    assert.ok(state?.lifecycle?.resultFile, 'detached program must finish even when evidence is negative');
    assert.equal(state.lifecycle.status, 'completed');
    assert.equal(state.planner.awaiting, null);
    assert.equal(state.planner.turns, 1);
    const report = JSON.parse(readFileSync(state.lifecycle.resultFile, 'utf8'));
    assert.equal(report.verified, false);
    assert.equal(report.requirements[0].status, 'failed');
    const request = JSON.parse(readFileSync(join(f.home, 'goals', launch.runId, 'request.json'), 'utf8'));
    assert.equal(request.initialPlannerResponse.kind, 'program');
    const watch = cli(f, ['workflow', 'watch', launch.runId]);
    assert.equal(watch.status, 0, watch.stderr);
    assert.doesNotMatch(watch.stdout, /waiting for the caller planner/);
    assert.match(watch.stdout, /outcome: completed/);
  } finally { f.cleanup(); }
});

// --- review fixes: pause record hygiene, cancellation, steering, durability ---

test('a run an older version left waiting: cancellation refuses submissions; one resume finalizes cancelled and clears the pause record', async () => {
  const f = setup();
  try {
    const dispatch = fakeDispatch(evidenceHandler({ status: 'failed' }));
    const first = await runV2AutonomousWorkflow({
      bullswarmDir: f.bullswarmDir, goalDocument: f.goal, pools: [], runId: 'wf-caller8-abcdef',
      initialPlannerResponse: envelope(), dependencies: { dispatchV2Action: dispatch },
    });
    assert.equal(first.result.status, 'partial');
    const paused = { runDir: first.runDir, ...holdLikeOlderVersion(first.runDir) };
    assert.equal(paused.boundary, 'gaps');
    const cancelled = requestCancel(f.bullswarmDir, 'wf-caller8-abcdef', { source: 'test' });
    assert.equal(cancelled.alreadyFinished, false);
    assert.ok(cancelled.state.planner.awaiting, 'the pause record survives the cancellation request');
    // No program can be accepted once cancellation is pending.
    assert.throws(
      () => submitCallerPlannerResponse({ bullswarmDir: f.bullswarmDir, runId: 'wf-caller8-abcdef', response: envelope() }),
      /pending cancellation .* bullswarm workflow goal --resume/,
    );
    const untouched = deserializeV2DurableState(readFileSync(join(paused.runDir, 'state.json'), 'utf8'));
    assert.equal(untouched.planner.turns, 1);
    assert.ok(untouched.planner.awaiting);
    // The resume finalizes without dispatching and leaves no stale pause.
    const finished = await runV2AutonomousWorkflow({ bullswarmDir: f.bullswarmDir, resumeRunId: 'wf-caller8-abcdef', pools: [], dependencies: { dispatchV2Action: dispatch } });
    assert.equal(finished.result.status, 'cancelled');
    assert.equal(finished.state.planner.awaiting, null);
    assert.equal(finished.state.lifecycle.status, 'cancelled');
    assert.equal(dispatch.calls(), 2);
    assert.throws(() => submitCallerPlannerResponse({ bullswarmDir: f.bullswarmDir, runId: 'wf-caller8-abcdef', response: envelope() }), /already terminal/);
    // A terminal state that still claims to be waiting is rejected by the validator.
    const stale = JSON.parse(readFileSync(join(paused.runDir, 'state.json'), 'utf8'));
    stale.planner.status = 'waiting';
    stale.planner.awaiting = { boundary: 'gaps', turn: 2, requestPath: '/x', candidatePath: '/y', since: '2026-09-06T00:00:00.000Z' };
    assert.throws(() => deserializeV2DurableState(JSON.stringify(stale)), /awaiting must be null once the workflow is terminal/);
    const shown = readCallerPlannerRequest({ bullswarmDir: f.bullswarmDir, runId: 'wf-caller8-abcdef' });
    assert.equal(shown.awaiting, null);
    assert.equal(shown.request, null);
  } finally { f.cleanup(); }
});

test('a run an older version left waiting: plan show surfaces steering queued since, a submission consumes only what was shown, and later steering never holds the run', async () => {
  const f = setup();
  try {
    let evidenceStatus = 'failed';
    const dispatch = fakeDispatch(async (options, calls, files) => evidenceHandler({ status: evidenceStatus })(options, calls, files));
    const first = await runV2AutonomousWorkflow({
      bullswarmDir: f.bullswarmDir, goalDocument: f.goal, pools: [], runId: 'wf-caller9-abcdef',
      initialPlannerResponse: envelope(), dependencies: { dispatchV2Action: dispatch },
    });
    assert.equal(first.result.status, 'partial');
    const paused = { runDir: first.runDir, ...holdLikeOlderVersion(first.runDir) };
    assert.equal(paused.turn, 2);

    // Steering arrives while no kernel runs; plan show's reader composes the
    // request with it and does not consume it.
    queueSteering(f.bullswarmDir, 'wf-caller9-abcdef', 'Prefer a single rewrite action.');
    const composed = readCallerPlannerRequest({ bullswarmDir: f.bullswarmDir, runId: 'wf-caller9-abcdef' });
    assert.equal(composed.refreshed, true);
    assert.equal(composed.request.boundary, 'gaps');
    assert.match(composed.request.context.gaps.summary, /report-correct=failed/, 'gap context is preserved');
    assert.equal(composed.request.pendingSteering.length, 1);
    assert.deepEqual(composed.request.context.steering, ['Prefer a single rewrite action.']);
    assert.equal(composed.state.steering.length, 0, 'steering is peeked, not delivered');
    assert.equal(dispatch.calls(), 2);

    // plan show's reader refreshes the request for steering queued since.
    assert.equal(readCallerPlannerRequest({ bullswarmDir: f.bullswarmDir, runId: 'wf-caller9-abcdef' }).refreshed, false);
    queueSteering(f.bullswarmDir, 'wf-caller9-abcdef', 'Keep the report under ten lines.');
    const shown = readCallerPlannerRequest({ bullswarmDir: f.bullswarmDir, runId: 'wf-caller9-abcdef' });
    assert.equal(shown.refreshed, true);
    assert.equal(shown.request.pendingSteering.length, 2);
    assert.equal(shown.state.steering.length, 0);

    // Steering queued after the request was shown is not consumed by the submission.
    queueSteering(f.bullswarmDir, 'wf-caller9-abcdef', 'Late instruction the caller never saw.');
    evidenceStatus = 'passed';
    const fix = {
      schemaVersion: 'bullswarm.workflow.program.v2',
      actions: [
        { id: 'rewrite-report', purpose: 'Rewrite report', dependsOn: ['write-report'], affects: ['report-correct'], ownedFiles: ['report.md'], prompt: 'Rewrite report.md with READY.', lane: 'build', effort: 'low', evidenceFor: [], inputs: [], produces: ['report-2'] },
        { id: 'reinspect-report', purpose: 'Reinspect report', dependsOn: ['rewrite-report'], affects: [], ownedFiles: [], prompt: 'Inspect report.md again.', lane: 'analyze', effort: 'low', evidenceFor: ['report-correct'], inputs: ['report-2'], produces: [] },
      ],
    };
    const submitted = submitCallerPlannerResponse({ bullswarmDir: f.bullswarmDir, runId: 'wf-caller9-abcdef', response: normalizeCallerPlannerResponse(fix, { summary: 'Close the gap' }) });
    assert.equal(submitted.ok, true, JSON.stringify(submitted.issues ?? null));
    assert.equal(submitted.state.steering.length, 2, 'exactly the surfaced steering is delivered');
    assert.ok(submitted.state.steering.every((entry) => entry.status === 'delivered_to_planner' && entry.decisionSequence === 2));
    const delivered = readEvents(paused.runDir).filter((event) => event.type === 'steering.delivered');
    assert.equal(delivered.length, 2);
    assert.ok(delivered.every((event) => event.payload.source === 'caller'));

    // The resumed kernel runs the new work without stopping for the unseen
    // instruction, and the result hands it back as not acted on.
    const done = await runV2AutonomousWorkflow({ bullswarmDir: f.bullswarmDir, resumeRunId: 'wf-caller9-abcdef', pools: [], dependencies: { dispatchV2Action: dispatch } });
    assert.equal(done.result.status, 'completed');
    assert.equal(done.result.verified, true);
    assert.deepEqual(dispatch.seen(), ['write-report', 'inspect-report', 'rewrite-report', 'reinspect-report']);
    assert.deepEqual(done.result.handback.unreadSteering.map((entry) => entry.message), ['Late instruction the caller never saw.']);
    assert.equal(readEvents(paused.runDir).filter((event) => event.type === 'steering.received').length, 1);
    assert.equal(done.state.planner.awaiting, null);
    assert.equal(done.state.planner.turns, 2, 'no steering boundary was opened');
    assert.equal(done.state.steering.length, 2);
  } finally { f.cleanup(); }
});

test('a caller program supplied at launch survives an interruption before the initial boundary', async () => {
  const f = setup({ scout: true });
  try {
    const scoutReport = [
      'TREE:\n- report.md', 'MANIFEST:\n- Node.js', 'TEST STATUS:\n- tests pass',
      'UNITS OF WORK:\n- report-unit', 'SHARED FILES:\n- none', 'RISKS:\n- none',
      'Additional repository facts '.repeat(8), '["report-unit"]',
    ].join('\n');
    let crashScout = true;
    const dispatch = fakeDispatch(async (options, calls, files) => {
      if (options.action.id === 'preflight-scout') {
        if (crashScout) throw new Error('simulated host interruption during the scout');
        writeFileSync(files.outFile, scoutReport);
        const structured = options.outputValidator(scoutReport);
        return { ok: true, status: 'succeeded', verdict: { ok: true, structured, outFile: files.outFile, meta: { exitCode: 0 } } };
      }
      return evidenceHandler()(options, calls, files);
    });
    await assert.rejects(runV2AutonomousWorkflow({
      bullswarmDir: f.bullswarmDir, goalDocument: f.goal, pools: [], runId: 'wf-callera-abcdef',
      initialPlannerResponse: envelope(), dependencies: { dispatchV2Action: dispatch },
    }), /simulated host interruption/);
    const runDir = join(f.bullswarmDir, 'workflows', 'wf-callera-abcdef');
    assert.ok(existsSync(join(runDir, 'initial-planner-response.json')), 'the unapplied program is kept in the run directory');
    crashScout = false;
    // The resume carries no program; the kernel recovers it instead of pausing.
    const resumed = await runV2AutonomousWorkflow({ bullswarmDir: f.bullswarmDir, resumeRunId: 'wf-callera-abcdef', pools: [], dependencies: { dispatchV2Action: dispatch } });
    assert.equal(resumed.result.status, 'completed');
    assert.equal(resumed.state.planner.turns, 1);
    assert.equal(resumed.state.planner.attempts.length, 0);
    assert.ok(!dispatch.seen().includes('workflow-planner'));
    assert.deepEqual(dispatch.seen().filter((id) => id !== 'preflight-scout'), ['write-report', 'inspect-report']);
    assert.equal(readEvents(runDir).filter((event) => event.type === 'planner.awaiting_caller').length, 0);
  } finally { f.cleanup(); }
});

test('CLI: bare value flags are usage errors, and plan contract rejects flags that describe a different run', () => {
  const f = cliFixture();
  try {
    const programPath = join(f.root, 'plan.json');
    writeFileSync(programPath, JSON.stringify(cliProgram()));
    const bareProgram = cli(f, ['workflow', 'goal', GOAL, '--cwd', f.target, '--program']);
    assert.equal(bareProgram.status, 2, bareProgram.stdout);
    assert.match(bareProgram.stderr, /--program requires a value/);
    assert.ok(!existsSync(join(f.home, 'workflows')), 'nothing was launched');
    const barePlanner = cli(f, ['workflow', 'goal', GOAL, '--cwd', f.target, '--planner', '--program', programPath]);
    assert.equal(barePlanner.status, 2);
    assert.match(barePlanner.stderr, /--planner requires a value/);
    const bareReason = cli(f, ['workflow', 'plan', 'submit', 'abcdef', '--exhausted', '--reason']);
    assert.equal(bareReason.status, 2);
    assert.match(bareReason.stderr, /--reason requires a value/);
    const bareResume = cli(f, ['workflow', 'goal', '--resume']);
    assert.equal(bareResume.status, 2);
    assert.match(bareResume.stderr, /--resume requires a value/);
    const dispatchedContract = cli(f, ['workflow', 'plan', 'contract', GOAL, '--cwd', f.target, '--planner', 'dispatched']);
    assert.equal(dispatchedContract.status, 2);
    assert.match(dispatchedContract.stderr, /--planner was removed/);
    const routedContract = cli(f, ['workflow', 'plan', 'contract', GOAL, '--cwd', f.target, '--orchestrator', 'caller-agent']);
    assert.equal(routedContract.status, 2);
    const missingCwd = cli(f, ['workflow', 'plan', 'contract', GOAL, '--cwd', join(f.root, 'missing')]);
    assert.equal(missingCwd.status, 1);
    assert.match(missingCwd.stderr, /goal cwd is not an existing directory/);
    const settings = cli(f, ['workflow', 'plan', 'contract', GOAL, '--cwd', f.target, '--max-expansion-rounds', '3', '--retry-attempts', '0', '--concurrency', '2']);
    assert.equal(settings.status, 0, settings.stderr);
    const contract = JSON.parse(settings.stdout);
    assert.equal(contract.settings.maxExpansionRounds, 3);
    assert.equal(contract.settings.maxMechanicalRetries, 0);
    assert.equal(contract.settings.concurrency, 2);
  } finally { f.cleanup(); }
});

test('CLI: a run an older version left waiting at the initial boundary gets no exhausted hint, and plan show reports it as not waiting once finished', () => {
  const f = cliFixture();
  try {
    const launched = cli(f, ['workflow', 'goal', GOAL, '--cwd', f.target, '--scout', '--foreground', '--json']);
    assert.equal(launched.status, 1, launched.stderr || launched.stdout);
    const scouted = JSON.parse(launched.stdout);
    assert.equal(scouted.status, 'partial');
    const awaiting = holdLikeOlderVersion(join(f.home, 'workflows', scouted.runId), { boundary: 'initial' });
    const token = awaiting.shortId;
    const show = cli(f, ['workflow', 'plan', 'show', token, '--json']);
    assert.equal(show.status, 0, show.stderr);
    const request = JSON.parse(show.stdout);
    assert.equal(request.submit.exhausted, undefined);
    assert.equal(request.requestRefreshed, true, 'the first show composes the request an older kernel would have written');
    assert.deepEqual(request.pendingSteering, []);
    assert.ok(request.rules.some((rule) => /Scout units and numeric targets are advisory/.test(rule)));
    const human = cli(f, ['workflow', 'plan', 'show', token]);
    assert.ok(!/--exhausted/.test(human.stdout), human.stdout);
    const programPath = join(f.root, 'plan.json');
    writeFileSync(programPath, JSON.stringify(cliProgram()));
    const submitted = cli(f, ['workflow', 'plan', 'submit', token, '--program', programPath, '--foreground', '--json']);
    assert.equal(submitted.status, 0, submitted.stderr || submitted.stdout);
    assert.equal(JSON.parse(submitted.stdout).status, 'completed');
    const finished = cli(f, ['workflow', 'plan', 'show', token, '--json']);
    assert.equal(finished.status, 1);
    const status = JSON.parse(finished.stdout);
    assert.equal(status.action, 'plan-status');
    assert.equal(status.awaiting, false);
    assert.match(status.note, /the run is completed/);
    const watch = cli(f, ['workflow', 'watch', token, '--once']);
    assert.equal(watch.status, 0, watch.stderr);
    assert.ok(!/waiting for the caller planner/.test(watch.stdout), watch.stdout);
  } finally { f.cleanup(); }
});

test('CLI legacy recovery: plan submit refuses a vanished goal directory before touching state', () => {
  const f = cliFixture();
  try {
    const target = join(f.root, 'vanishing');
    mkdirSync(target);
    const programPath = join(f.root, 'plan.json');
    writeFileSync(programPath, JSON.stringify(cliProgram('skip-work')));
    const awaiting = launchLegacyGoal(f, programPath, target);
    assert.equal(awaiting.boundary, 'gaps');
    rmSync(target, { recursive: true, force: true });
    const fixPath = join(f.root, 'plan-2.json');
    writeFileSync(fixPath, JSON.stringify(cliProgram()));
    const submitted = cli(f, ['workflow', 'plan', 'submit', awaiting.shortId, '--program', fixPath, '--json']);
    assert.equal(submitted.status, 1, submitted.stdout);
    assert.match(submitted.stderr, /goal cwd is not an existing directory: .*; nothing was submitted/);
    const state = JSON.parse(readFileSync(join(f.home, 'workflows', awaiting.runId, 'state.json'), 'utf8'));
    assert.equal(state.planner.turns, 1);
    assert.equal(state.planner.awaiting.turn, 2);
    assert.equal(state.program.actions.length, 2);
  } finally { f.cleanup(); }
});

test('CLI legacy recovery: cancelling a paused run refuses submissions, points at the finalizing resume, and leaves no stale pause', () => {
  const f = cliFixture();
  try {
    const programPath = join(f.root, 'plan.json');
    writeFileSync(programPath, JSON.stringify(cliProgram('skip-work')));
    const token = launchLegacyGoal(f, programPath).shortId;
    const cancel = cli(f, ['workflow', 'tui', '--cancel', token, '--json']);
    assert.equal(cancel.status, 0, cancel.stderr);
    const cancelDoc = JSON.parse(cancel.stdout);
    assert.equal(cancelDoc.action, 'cancel');
    assert.equal(cancelDoc.pausedForCaller, true);
    assert.match(cancelDoc.finalize, /workflow cancel/);
    const fixPath = join(f.root, 'plan-2.json');
    writeFileSync(fixPath, JSON.stringify(cliProgram()));
    const refused = cli(f, ['workflow', 'plan', 'submit', token, '--program', fixPath, '--json']);
    assert.equal(refused.status, 1, refused.stdout);
    assert.match(refused.stderr, /pending cancellation/);
    const show = cli(f, ['workflow', 'plan', 'show', token, '--json']);
    assert.equal(show.status, 0, show.stderr);
    const request = JSON.parse(show.stdout);
    assert.equal(request.cancellation.requested, true);
    assert.equal(request.submit, null);
    assert.match(request.finalize, /workflow cancel/);
    const human = cli(f, ['workflow', 'plan', 'show', token]);
    assert.match(human.stdout, /cancel\s+requested/);
    assert.match(human.stdout, /finalize\s+bullswarm workflow cancel/);
    const watchPaused = cli(f, ['workflow', 'watch', token]);
    assert.equal(watchPaused.status, 0, watchPaused.stderr);
    assert.match(watchPaused.stdout, /next: cancellation requested; bullswarm workflow cancel .* finalizes it/);
    const finalized = cli(f, ['workflow', 'goal', '--resume', token, '--json']);
    assert.equal(finalized.status, 1, finalized.stderr || finalized.stdout);
    const result = JSON.parse(finalized.stdout);
    assert.equal(result.schemaVersion, 'bullswarm.workflow.result.v2');
    assert.equal(result.status, 'cancelled');
    const state = JSON.parse(readFileSync(join(f.home, 'workflows', result.runId, 'state.json'), 'utf8'));
    assert.equal(state.planner.awaiting, null);
    assert.equal(state.lifecycle.status, 'cancelled');
    const after = cli(f, ['workflow', 'plan', 'show', token, '--json']);
    assert.equal(after.status, 1);
    assert.match(JSON.parse(after.stdout).note, /the run is cancelled/);
    const watchDone = cli(f, ['workflow', 'watch', token]);
    assert.match(watchDone.stdout, /outcome: cancelled/);
    assert.ok(!/waiting for the caller planner/.test(watchDone.stdout), watchDone.stdout);
    const resultCmd = cli(f, ['workflow', 'runs', 'result', token, '--json']);
    assert.equal(JSON.parse(resultCmd.stdout).status, 'cancelled');
  } finally { f.cleanup(); }
});

test('CLI legacy recovery: steering queued while paused shows in plan show and is consumed by a detached plan submit that runs to completion', async () => {
  const f = cliFixture();
  try {
    const programPath = join(f.root, 'plan.json');
    writeFileSync(programPath, JSON.stringify(cliProgram('skip-work')));
    const { shortId: token, runId } = launchLegacyGoal(f, programPath);
    const steer = cli(f, ['workflow', 'steer', token, '--message', 'Create the file with a single write.']);
    assert.equal(steer.status, 0, steer.stderr);
    const show = cli(f, ['workflow', 'plan', 'show', token, '--json']);
    assert.equal(show.status, 0, show.stderr);
    const request = JSON.parse(show.stdout);
    assert.equal(request.requestRefreshed, true);
    assert.equal(request.boundary, 'gaps');
    assert.equal(request.turn, 2);
    assert.deepEqual(request.pendingSteering.map((entry) => entry.message), ['Create the file with a single write.']);
    assert.deepEqual(request.context.steering, ['Create the file with a single write.']);
    const human = cli(f, ['workflow', 'plan', 'show', token]);
    assert.match(human.stdout, /steering 1 pending instruction/);
    const fixPath = join(f.root, 'plan-2.json');
    writeFileSync(fixPath, JSON.stringify({
      schemaVersion: 'bullswarm.workflow.program.v2',
      actions: [
        { id: 'create-done', purpose: 'Create done.txt for real', dependsOn: ['skip-work'], affects: ['requirement-1'], ownedFiles: ['done.txt'], prompt: 'Create done.txt with the exact line caller-complete.', lane: 'build', effort: 'low', evidenceFor: [], inputs: [], produces: ['done-2'] },
        { id: 'check-create-done', purpose: 'Inspect done.txt', dependsOn: ['create-done'], affects: [], ownedFiles: [], prompt: 'Read done.txt and compare bytes.', lane: 'analyze', effort: 'low', evidenceFor: ['requirement-1'], inputs: ['done-2'], produces: [] },
      ],
    }));
    const submitted = cli(f, ['workflow', 'plan', 'submit', token, '--program', fixPath, '--json']);
    assert.equal(submitted.status, 0, submitted.stderr || submitted.stdout);
    const report = JSON.parse(submitted.stdout);
    assert.equal(report.action, 'plan-submitted');
    assert.equal(report.relaunch.action, 'goal-resumed');
    assert.equal(report.relaunch.runId, runId);
    const launcher = JSON.parse(readFileSync(join(f.home, 'goals', runId, 'launcher.json'), 'utf8'));
    assert.equal(launcher.resume, true);
    assert.equal(launcher.runId, runId);
    const statePath = join(f.home, 'workflows', runId, 'state.json');
    let state = null;
    for (let i = 0; i < 200 && !['completed', 'partial', 'failed', 'cancelled'].includes(state?.lifecycle?.status); i += 1) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
      try { state = JSON.parse(readFileSync(statePath, 'utf8')); } catch { /* atomic write in progress */ }
    }
    assert.equal(state?.lifecycle?.status, 'completed', JSON.stringify(state?.lifecycle));
    assert.equal(state.steering.length, 1, 'the surfaced steering was consumed by the submission');
    assert.equal(state.steering[0].decisionSequence, 2);
    assert.equal(state.planner.turns, 2, 'no extra steering boundary was opened');
    assert.equal(state.planner.awaiting, null);
    assert.equal(readFileSync(join(f.target, 'done.txt'), 'utf8'), 'caller-complete\n');
    const events = readEvents(join(f.home, 'workflows', runId));
    assert.equal(events.filter((event) => event.type === 'steering.delivered').length, 1);
    assert.equal(events.filter((event) => event.type === 'planner.handed_back').length, 1, 'only the first finish handed back');
  } finally { f.cleanup(); }
});

// --- caller-first CLI: the program is required, and every refusal guides ------

test('CLI: workflow goal without a program refuses, launches nothing, and names every next command', () => {
  const f = cliFixture();
  try {
    const human = cli(f, ['workflow', 'goal', GOAL, '--cwd', f.target]);
    assert.equal(human.status, 2, human.stdout);
    assert.match(human.stderr, /needs a program: you are the Workflow Planner/);
    for (const fragment of ['plan contract', 'plan validate', '--program plan.json', '--scout', '--orchestrator auto']) {
      assert.ok(human.stderr.includes(fragment), `guidance must name ${fragment}: ${human.stderr}`);
    }
    assert.equal(existsSync(join(f.home, 'workflows')), false, 'nothing may be launched');
    assert.equal(existsSync(join(f.home, 'goals')), false, 'no launch request may be written');

    const json = cli(f, ['workflow', 'goal', GOAL, '--cwd', f.target, '--json']);
    assert.equal(json.status, 2);
    const doc = JSON.parse(json.stdout);
    assert.equal(doc.error, 'program-required');
    assert.deepEqual(Object.keys(doc.next).sort(), ['contract', 'launch', 'orchestrator', 'scout', 'validate']);
    assert.match(doc.next.contract, /^bullswarm workflow plan contract /);
    assert.match(doc.next.launch, /--program plan\.json --json$/);
    assert.match(doc.next.orchestrator, /--orchestrator auto$/);

    // The refusal's own contract command must run and describe this goal.
    const contractArgs = ['workflow', 'plan', 'contract', GOAL, '--cwd', f.target, '--json'];
    const contract = cli(f, contractArgs);
    assert.equal(contract.status, 0, contract.stderr);
    assert.equal(JSON.parse(contract.stdout).requirements.length, 1);
  } finally { f.cleanup(); }
});

test('CLI: an invalid program is refused the same way by plan validate and by goal', () => {
  const f = cliFixture();
  try {
    const badPath = join(f.root, 'bad.json');
    // A dependency on an unknown action must still be refused before dispatch.
    writeFileSync(badPath, JSON.stringify({
      schemaVersion: 'bullswarm.workflow.program.v2',
      actions: [{ id: 'create-done', purpose: 'Create done.txt', dependsOn: ['missing-action'], affects: ['requirement-1'], ownedFiles: ['done.txt'], prompt: 'Create done.txt with the exact line caller-complete.', lane: 'build', effort: 'low', evidenceFor: [], inputs: [], produces: [] }],
    }));
    const validated = cli(f, ['workflow', 'plan', 'validate', GOAL, '--cwd', f.target, '--program', badPath, '--json']);
    assert.equal(validated.status, 2, validated.stdout);
    const refusal = JSON.parse(validated.stdout);
    assert.equal(refusal.error, 'program-invalid');
    assert.ok(refusal.issues.length >= 1);
    assert.deepEqual(Object.keys(refusal.next).sort(), ['contract', 'validate']);
    assert.equal(existsSync(join(f.home, 'workflows')), false);

    const launched = cli(f, ['workflow', 'goal', GOAL, '--cwd', f.target, '--program', badPath, '--json']);
    assert.equal(launched.status, 2);
    assert.deepEqual(JSON.parse(launched.stdout).issues, refusal.issues, 'validate and goal must agree exactly');
    assert.equal(existsSync(join(f.home, 'workflows')), false, 'an invalid program launches nothing');
  } finally { f.cleanup(); }
});

test('CLI: plan validate accepts a good program without creating a run', () => {
  const f = cliFixture();
  try {
    const programPath = join(f.root, 'plan.json');
    writeFileSync(programPath, JSON.stringify(cliProgram()));
    const json = cli(f, ['workflow', 'plan', 'validate', GOAL, '--cwd', f.target, '--program', programPath, '--json']);
    assert.equal(json.status, 0, json.stderr);
    const doc = JSON.parse(json.stdout);
    assert.equal(doc.action, 'plan-valid');
    assert.deepEqual(doc.program.actions.map((a) => a.id), ['create-done', 'check-create-done']);
    assert.deepEqual(doc.program.actions[1].evidenceFor, ['requirement-1']);
    assert.match(doc.next.launch, /--program plan\.json --json$/);
    assert.equal(existsSync(join(f.home, 'workflows')), false, 'validation must not create a run');

    const human = cli(f, ['workflow', 'plan', 'validate', GOAL, '--cwd', f.target, '--program', programPath]);
    assert.equal(human.status, 0, human.stderr);
    assert.match(human.stdout, /program valid against the contract: 2 actions for 1 requirement \(nothing launched\)/);
    assert.match(human.stdout, /launch\s+bullswarm workflow goal/);

    const missingProgram = cli(f, ['workflow', 'plan', 'validate', GOAL, '--cwd', f.target]);
    assert.equal(missingProgram.status, 2);
    assert.match(missingProgram.stderr, /usage: bullswarm workflow plan validate/);
  } finally { f.cleanup(); }
});

test('CLI: --scout alone surveys first, then finishes and hands the scout report back with the options', () => {
  const f = cliFixture();
  try {
    const launched = cli(f, ['workflow', 'goal', GOAL, '--cwd', f.target, '--scout', '--foreground', '--json']);
    assert.equal(launched.status, 1, launched.stderr || launched.stdout);
    const result = JSON.parse(launched.stdout);
    assert.equal(result.status, 'partial');
    const state = JSON.parse(readFileSync(join(f.home, 'workflows', result.runId, 'state.json'), 'utf8'));
    assert.equal(state.preflight.scout.status, 'succeeded', 'the kernel scout must have run');
    assert.equal(state.planner.attempts.length, 0, 'no planner process may be dispatched');
    assert.equal(state.planner.awaiting, null);
    assert.ok(result.reason.includes(`the scout report is at ${state.preflight.scout.outputFile}`), result.reason);
    assert.ok(readFileSync(state.preflight.scout.outputFile, 'utf8').includes('UNITS OF WORK'));
    const watch = cli(f, ['workflow', 'watch', result.shortId]);
    assert.match(watch.stdout, /outcome: partial · not verified\n/);
    assert.match(watch.stdout, /reason: no program to run/);
    assert.match(watch.stdout, /your call:\n\s+continue\s+bullswarm workflow plan export \S+ --out plan\.json/);
    assert.match(watch.stdout, /\n\s+restart\s+start a new run/);
    assert.doesNotMatch(watch.stdout, /\n\s+retry\s/, 'nothing failed, so there is nothing to retry');
  } finally { f.cleanup(); }
});

test('CLI: planning flags are rejected in the combinations that would plan behind the caller', () => {
  const f = cliFixture();
  try {
    const programPath = join(f.root, 'plan.json');
    writeFileSync(programPath, JSON.stringify(cliProgram()));
    const cases = [
      [['--program', programPath, '--orchestrator', 'auto'], /--program and --orchestrator are mutually exclusive/],
      [['--planner', 'caller', '--program', programPath], /--planner was removed/],
      [['--program', programPath, '--suggested-plan', 'do it'], /--suggested-plan.*only with --orchestrator/],
      [['--program', programPath, '--no-scout'], /--no-scout.*only with --orchestrator/],
      [['--program', programPath, '--orchestrator-model', 'worker-luna'], /--orchestrator-model.*only with --orchestrator/],
      [['--orchestrator', 'auto', '--orchestrator-strict'], /--orchestrator-strict needs a named pool/],
      [['--orchestrator', 'caller-agent', '--strict-orchestrator', 'caller-agent'], /mutually exclusive/],
    ];
    for (const [args, pattern] of cases) {
      const result = cli(f, ['workflow', 'goal', GOAL, '--cwd', f.target, ...args]);
      assert.equal(result.status, 2, `${args.join(' ')}: ${result.stdout}`);
      assert.match(result.stderr, pattern);
    }
    assert.equal(existsSync(join(f.home, 'workflows')), false, 'no rejected combination may launch');
    // The deprecated alias still works on its own.
    const contract = cli(f, ['workflow', 'plan', 'contract', GOAL, '--cwd', f.target, '--orchestrator', 'auto']);
    assert.equal(contract.status, 2);
    assert.match(contract.stderr, /--orchestrator.*do not apply/);
  } finally { f.cleanup(); }
});

test('CLI legacy recovery: workflow cancel finalizes a paused caller run and is idempotent afterwards', () => {
  const f = cliFixture();
  try {
    const programPath = join(f.root, 'plan.json');
    writeFileSync(programPath, JSON.stringify(cliProgram('skip-work')));
    const { shortId: token, runId } = launchLegacyGoal(f, programPath);

    const cancelled = cli(f, ['workflow', 'cancel', token, '--json']);
    assert.equal(cancelled.status, 0, cancelled.stderr);
    const doc = JSON.parse(cancelled.stdout);
    assert.equal(doc.action, 'cancel');
    assert.equal(doc.finalized, true);
    assert.equal(doc.status, 'cancelled');
    const state = JSON.parse(readFileSync(join(f.home, 'workflows', runId, 'state.json'), 'utf8'));
    assert.equal(state.lifecycle.status, 'cancelled');
    assert.equal(state.planner.awaiting, null);
    const result = cli(f, ['workflow', 'runs', 'result', token, '--json']);
    assert.equal(JSON.parse(result.stdout).status, 'cancelled');

    const again = cli(f, ['workflow', 'cancel', token, '--json']);
    assert.equal(again.status, 0);
    assert.equal(JSON.parse(again.stdout).alreadyFinished, true);
    const submit = cli(f, ['workflow', 'plan', 'submit', token, '--program', programPath, '--json']);
    assert.equal(submit.status, 1);
    assert.match(submit.stderr, /already terminal/);
  } finally { f.cleanup(); }
});

test('CLI legacy recovery: workflow resume is the verb form of goal --resume and refuses planning flags', () => {
  const f = cliFixture();
  try {
    const programPath = join(f.root, 'plan.json');
    writeFileSync(programPath, JSON.stringify(cliProgram('skip-work')));
    const { shortId: token, runId } = launchLegacyGoal(f, programPath);

    for (const args of [['--program', programPath], ['--orchestrator', 'auto'], ['--scout']]) {
      const refused = cli(f, ['workflow', 'resume', token, ...args]);
      assert.equal(refused.status, 2, `${args.join(' ')}: ${refused.stdout}`);
      assert.match(refused.stderr, /keeps its durable planner mode/);
    }
    const missing = cli(f, ['workflow', 'resume', 'zzzzzz', '--json']);
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /no run found/);

    // Resuming a run an older version left waiting finishes it and hands the
    // decision back, dispatching nothing new.
    const resumed = cli(f, ['workflow', 'resume', token, '--foreground', '--json']);
    assert.equal(resumed.status, 1, resumed.stderr || resumed.stdout);
    const result = JSON.parse(resumed.stdout);
    assert.equal(result.status, 'partial');
    assert.match(result.reason, /^requirements are still open and no step is left to run/);
    assert.deepEqual(result.handback.unresolvedRequirements.map((entry) => entry.id), ['requirement-1']);
    const state = JSON.parse(readFileSync(join(f.home, 'workflows', runId, 'state.json'), 'utf8'));
    assert.equal(state.planner.turns, 1);
    assert.equal(state.planner.awaiting, null);
    assert.equal(state.attempts.length, 2, 'finishing a held run dispatches nothing');
    // Resume on the finished run has nothing a retry fixes: it says so and relaunches nothing.
    const retry = cli(f, ['workflow', 'resume', token]);
    assert.equal(retry.status, 1, retry.stdout);
    assert.match(retry.stderr, /nothing to retry in \S+ \(partial\)/);
    assert.equal(JSON.parse(readFileSync(join(f.home, 'workflows', runId, 'state.json'), 'utf8')).lifecycle.status, 'partial');
  } finally { f.cleanup(); }
});

test('CLI: capabilities and launch instructions advertise the caller-first contract', async () => {
  const f = cliFixture();
  try {
    const capabilities = JSON.parse(cli(f, ['workflow', 'capabilities']).stdout).engines.autonomousV2;
    assert.equal(capabilities.defaults.plannerMode, 'caller');
    assert.equal(capabilities.features.programRequired, true);
    assert.match(capabilities.plannerModes.caller, /^default:/);
    assert.match(capabilities.plannerModes.dispatched, /^explicit --orchestrator/);

    const programPath = join(f.root, 'plan.json');
    writeFileSync(programPath, JSON.stringify(cliProgram('skip-work')));
    const launch = JSON.parse(cli(f, ['workflow', 'goal', GOAL, '--cwd', f.target, '--program', programPath, '--json']).stdout);
    assert.match(launch.observe.cancel, /workflow cancel .* --json/);
    assert.match(launch.observe.steer, /workflow steer /);
    assert.ok(launch.instructions.cancel, 'the launch handoff must name the cancel verb');
    // The launched detached kernel owns this fixture until it finishes.
    const deadline = Date.now() + 5000;
    while (!existsSync(join(f.home, 'workflows', launch.runId, 'result.json'))) {
      assert.ok(Date.now() < deadline, 'detached fixture kernel must finish before cleanup');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    while (existsSync(join(f.home, 'workflows', launch.runId, 'kernel.lock'))) {
      assert.ok(Date.now() < deadline, 'detached fixture kernel must release its lease');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  } finally { f.cleanup(); }
});

test('CLI: refusal guidance is copy-pasteable — shell-safe quoting, and a placeholder for a long goal', () => {
  const f = cliFixture();
  try {
    // A goal containing an apostrophe must round-trip through a real shell,
    // so the printed command reproduces the same requirement text.
    const quoted = cli(f, ['workflow', 'goal', "Fix the parser's bug", '--cwd', f.target, '--json']);
    assert.equal(quoted.status, 2);
    const command = JSON.parse(quoted.stdout).next.contract;
    assert.ok(command.includes(`'Fix the parser'\\''s bug'`), command);
    const viaShell = spawnSync('/bin/sh', ['-c', command.replace(/^bullswarm/, `${process.execPath} ${BIN}`)], {
      cwd: REPO, env: { ...process.env, BULLSWARM_HOME: f.home, BULLSWARM_DEPTH: '0' }, encoding: 'utf8', timeout: 30_000,
    });
    assert.equal(viaShell.status, 0, viaShell.stderr);
    assert.equal(JSON.parse(viaShell.stdout).requirements[0].text, "Fix the parser's bug");

    // A multi-line goal is not inlined: JSON escapes would not survive shell
    // double quotes, and the guidance would bury the commands.
    const long = cli(f, ['workflow', 'goal', '1. First thing.\n2. Second thing.', '--cwd', f.target, '--json']);
    assert.equal(long.status, 2);
    for (const value of Object.values(JSON.parse(long.stdout).next)) {
      assert.ok(value.includes('"<goal>"'), value);
      assert.ok(!value.includes('\\n'), `a multi-line goal must not be inlined: ${value}`);
    }
  } finally { f.cleanup(); }
});

// A program that states only the nature of each action: no lane, no effort.
// `write-notes` owns a markdown file at the high effort `integration` derives,
// which is exactly the docs-at-high advisory.
function kindProgram() {
  return {
    schemaVersion: 'bullswarm.workflow.program.v2',
    defaults: { reasoning: 'low' },
    actions: [
      { id: 'create-done', purpose: 'Create done.txt', dependsOn: [], affects: ['requirement-1'], ownedFiles: ['done.txt'], prompt: 'Create done.txt with the exact line caller-complete.', kind: 'mechanical', evidenceFor: [], inputs: [], produces: ['done'] },
      { id: 'write-notes', purpose: 'Record the change in notes.md', dependsOn: ['create-done'], affects: ['requirement-1'], ownedFiles: ['notes.md'], prompt: 'Summarise the done.txt change in notes.md.', kind: 'integration', evidenceFor: [], inputs: ['done'], produces: [] },
      { id: 'check-create-done', purpose: 'Inspect done.txt', dependsOn: ['create-done', 'write-notes'], affects: [], ownedFiles: [], prompt: 'Read done.txt and compare bytes.', kind: 'check', evidenceFor: ['requirement-1'], inputs: ['done'], produces: [] },
    ],
  };
}

test('CLI: plan validate resolves lane and effort from kind and reports advisories at exit 0', () => {
  const f = cliFixture();
  try {
    const programPath = join(f.root, 'kinds.json');
    writeFileSync(programPath, JSON.stringify(kindProgram()));
    const result = cli(f, ['workflow', 'plan', 'validate', GOAL, '--cwd', f.target, '--program', programPath, '--json']);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.action, 'plan-valid');
    assert.deepEqual(payload.program.actions.map((action) => [action.id, action.kind, action.lane, action.effort, action.reasoning]), [
      ['create-done', 'mechanical', 'chore', 'low', 'low'],
      ['write-notes', 'integration', 'build', 'high', 'low'],
      ['check-create-done', 'check', 'analyze', 'medium', 'low'],
    ]);
    assert.deepEqual(payload.advisories, [{
      code: 'docs-at-high', actionId: 'write-notes',
      message: 'owns only markdown files (notes.md) at high effort; documentation edits rarely need the high tier',
    }]);
    // Human output prints one advisory line and still exits 0.
    const human = cli(f, ['workflow', 'plan', 'validate', GOAL, '--cwd', f.target, '--program', programPath]);
    assert.equal(human.status, 0, human.stderr);
    assert.match(human.stdout, /create-done\s+chore\/low kind=mechanical reasoning=low/);
    assert.match(human.stdout, /advisory: docs-at-high write-notes — owns only markdown files/);
    // An unknown kind is a typo in the program, so validate refuses with exit 2.
    const typo = kindProgram();
    typo.actions[0].kind = 'mechanicals';
    const typoPath = join(f.root, 'typo.json');
    writeFileSync(typoPath, JSON.stringify(typo));
    const rejected = cli(f, ['workflow', 'plan', 'validate', GOAL, '--cwd', f.target, '--program', typoPath, '--json']);
    assert.equal(rejected.status, 2);
    const refusal = JSON.parse(rejected.stdout);
    assert.equal(refusal.error, 'program-invalid');
    assert.ok(
      refusal.issues.some((issue) => issue.includes('kind must be mechanical|io-read|digest|check|implement|integration|architecture|adversarial-acceptance')),
      refusal.issues.join('; '),
    );
    assert.equal(existsSync(join(f.home, 'workflows')), false, 'validate must not create a run');
  } finally { f.cleanup(); }
});

test('CLI: a kind-only program dispatches on the derived lane and effort and reports kind everywhere', () => {
  const f = cliFixture();
  try {
    const programPath = join(f.root, 'kinds.json');
    writeFileSync(programPath, JSON.stringify(kindProgram()));
    const result = cli(f, ['workflow', 'goal', GOAL, '--cwd', f.target, '--program', programPath, '--summary', 'Kind-driven program', '--foreground', '--json']);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const report = JSON.parse(result.stdout);
    assert.equal(report.status, 'completed');
    assert.equal(report.verified, true);
    // The launch prints the same advisory line plan validate printed.
    assert.match(result.stderr, /advisory: docs-at-high write-notes — owns only markdown files \(notes\.md\) at high effort/);
    const state = JSON.parse(readFileSync(join(f.home, 'workflows', report.runId, 'state.json'), 'utf8'));
    assert.deepEqual(state.program.actions.map((action) => [action.id, action.kind, action.lane, action.effort, action.reasoning]), [
      ['create-done', 'mechanical', 'chore', 'low', 'low'],
      ['write-notes', 'integration', 'build', 'high', 'low'],
      ['check-create-done', 'check', 'analyze', 'medium', 'low'],
    ]);
    assert.deepEqual(state.advisories, [{
      code: 'docs-at-high', actionId: 'write-notes',
      message: 'owns only markdown files (notes.md) at high effort; documentation edits rarely need the high tier',
    }]);
    // The proof that kind reached routing: the mechanical action was actually
    // dispatched on lane chore at effort low.
    const routed = state.attempts.map((attempt) => [attempt.actionId, attempt.routing?.lane, attempt.routing?.effort]);
    assert.deepEqual(routed, [
      ['create-done', 'chore', 'low'],
      ['write-notes', 'build', 'high'],
      ['check-create-done', 'analyze', 'medium'],
    ]);
    const token = report.shortId ?? report.runId;
    const show = cli(f, ['workflow', 'runs', 'show', token]);
    assert.equal(show.status, 0, show.stderr);
    assert.match(show.stdout, /create-done\s+chore\/low\s+kind mechanical\s+succeeded/);
    assert.match(show.stdout, /# advisories {2}1/);
    assert.match(show.stdout, /advisory: docs-at-high write-notes — owns only markdown files/);
    const resultText = cli(f, ['workflow', 'runs', 'result', token]);
    assert.equal(resultText.status, 0, resultText.stderr);
    assert.match(resultText.stdout, /create-done\s+chore\/low\s+kind mechanical/);
    assert.match(resultText.stdout, /advisory: docs-at-high/);
    const actionShow = cli(f, ['workflow', 'action', 'show', token, 'create-done']);
    assert.equal(actionShow.status, 0, actionShow.stderr);
    const shown = JSON.parse(actionShow.stdout);
    assert.equal(shown.actionRecord.kind, 'mechanical');
    assert.equal(shown.actionRecord.lane, 'chore');
    assert.equal(shown.actionRecord.effort, 'low');
    assert.equal(shown.actionRecord.status, 'succeeded');
    assert.deepEqual(shown.attempts.map((attempt) => attempt.actionId), ['create-done']);
    const missing = cli(f, ['workflow', 'action', 'show', token, 'no-such-action']);
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /has no action "no-such-action"/);
  } finally { f.cleanup(); }
});
