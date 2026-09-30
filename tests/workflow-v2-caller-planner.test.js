// Caller-as-planner: the invoking agent authors the program directly and the
// kernel never dispatches a Workflow Planner process. Runtime-level tests use
// the fake dispatcher on stored v2 programs; CLI-level tests drive the real
// binary against a local deterministic connector with v3 programs (0.38.0
// launches nothing else) so no planner task can ever reach a worker.

import { test } from 'node:test';
import { loadProviders } from '../src/lib/providers.js';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { readEvents } from '../src/workflow/events.js';
import { createV2GoalDocument, deserializeV2DurableState } from '../src/workflow/v2-state.js';
import { runV2AutonomousWorkflow } from '../src/workflow/v2-runtime.js';
import { reviseV2Program } from '../src/workflow/run-control.js';
import { acceptCallerPlannerResponse } from '../src/workflow/caller-planner.js';
import { dispatchV2Action } from '../src/workflow/v2-dispatch.js';
import { removeSettled } from './fixtures/settled-cleanup.mjs';
import { needsYouFacts, needsYouJson, renderNeedsYou } from '../src/workflow/needs-you.js';
import { rerunV2Step } from '../src/workflow/cli-step-verbs.js';
import { createRevisionRequest, exportV2Plan, normalizeRevisionInput } from '../src/workflow/v2-revision.js';
import { viewOnlyRunLine } from '../src/workflow/cli-run-lookup.js';
import { PROGRAM_V2_REFUSAL } from '../src/workflow/cli-program-checks.js';
import {
  buildV2PlannerContract, buildV2PlannerPrompt, normalizeCallerPlannerResponse,
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
  return { root, bullswarmDir, workspace, goal, cleanup: () => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) };
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

test('a gap finishes the run and hands it back; resume changes nothing', async () => {
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

  } finally { f.cleanup(); }
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
    '} else if (/Bullswarm program action: (?:survey-done|notify-done)\\n/.test(task)) {',
    '  process.stdout.write("Read-only fixture step: reported on done.txt and changed no workspace file. The outbox line was recorded as fixture-outbox-1.");',
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
  // A detached kernel still writes after its run is terminal (the rollup index,
  // its lease): cleanup waits for the kernels the home names to exit.
  return { root, home, target, cleanup: () => removeSettled(root, { homes: [home] }) };
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

// The stored v2 form an older version launched; launchLegacyGoal runs it.
function cliProgram(workId = 'create-done') {
  return {
    schemaVersion: 'bullswarm.workflow.program.v2',
    actions: [
      { id: workId, purpose: 'Create done.txt', dependsOn: [], affects: ['requirement-1'], ownedFiles: ['done.txt'], prompt: 'Create done.txt with the exact line caller-complete.', lane: 'build', effort: 'low', evidenceFor: [], inputs: [], produces: ['done'] },
      { id: `check-${workId}`, purpose: 'Inspect done.txt', dependsOn: [workId], affects: [], ownedFiles: [], prompt: 'Read done.txt and compare bytes.', lane: 'analyze', effort: 'low', evidenceFor: ['requirement-1'], inputs: ['done'], produces: [] },
    ],
  };
}

// What a caller launches in 0.38.0: a v3 program, the work then a read-only check.
function cliV3Program(workId = 'create-done') {
  return {
    schemaVersion: 'bullswarm.workflow.program.v3',
    steps: [
      { id: workId, lane: 'build', effort: 'low', files: ['done.txt'], prompt: 'Create done.txt with the exact line caller-complete.' },
      { id: `check-${workId}`, lane: 'analyze', effort: 'low', dependsOn: [workId], prompt: 'Read done.txt and compare bytes.' },
    ],
  };
}

test('CLI: plan contract prints the v3 format without touching state; --v2 is removed', () => {
  const f = cliFixture();
  try {
    const result = cli(f, ['workflow', 'plan', 'contract', GOAL, '--cwd', f.target, '--json']);
    assert.equal(result.status, 0, result.stderr);
    const contract = JSON.parse(result.stdout);
    assert.equal(contract.schemaVersion, 'bullswarm.workflow.contract.v3');
    assert.equal(contract.goal, GOAL);
    assert.match(contract.next.launch, /--program plan\.json --json$/);
    const v2 = cli(f, ['workflow', 'plan', 'contract', GOAL, '--cwd', f.target, '--json', '--v2']);
    assert.equal(v2.status, 2, v2.stdout);
    assert.equal(JSON.parse(v2.stdout).flag, '--v2');
    assert.equal(existsSync(join(f.home, 'workflows')), false, 'contract must not create a run');
  } finally { f.cleanup(); }
});

test('CLI: goal --program executes a caller-authored program end to end without any planner process', () => {
  const f = cliFixture();
  try {
    const programPath = join(f.root, 'plan.json');
    writeFileSync(programPath, JSON.stringify(cliV3Program()));
    const result = cli(f, ['workflow', 'goal', GOAL, '--cwd', f.target, '--program', programPath, '--summary', 'Create and check done.txt', '--foreground', '--json']);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const report = JSON.parse(result.stdout);
    assert.equal(report.schemaVersion, 'bullswarm.workflow.result.v2');
    assert.equal(report.status, 'completed');
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
    // plan show was removed in 0.38.0: no run waits for its caller.
    const show = cli(f, ['workflow', 'plan', 'show', report.shortId]);
    assert.equal(show.status, 2);
    assert.match(show.stderr, /^✗ plan show was removed in 0\.38\.0: runs no longer wait for a caller program; append steps with bullswarm workflow add <runId> --steps <file\.json>$/m);
  } finally { f.cleanup(); }
});

test('CLI: an invalid --program is rejected synchronously and nothing is launched', () => {
  const f = cliFixture();
  try {
    const bad = cliV3Program();
    bad.steps[0].lane = 'analyze'; // analyze steps may not own files
    const programPath = join(f.root, 'bad.json');
    writeFileSync(programPath, JSON.stringify(bad));
    const result = cli(f, ['workflow', 'goal', GOAL, '--cwd', f.target, '--program', programPath, '--json']);
    assert.equal(result.status, 2);
    const refusal = JSON.parse(result.stdout);
    assert.equal(refusal.error, 'program-invalid');
    assert.match(refusal.message, /caller program invalid \(nothing ran\)/);
    assert.ok(refusal.issues.some((issue) => /analyze steps must have empty files/.test(issue)), refusal.issues.join('; '));
    const human = cli(f, ['workflow', 'goal', GOAL, '--cwd', f.target, '--program', programPath]);
    assert.equal(human.status, 2);
    assert.match(human.stderr, /caller program invalid \(nothing ran\)/);
    assert.match(human.stderr, /analyze steps must have empty files/);
    assert.equal(existsSync(join(f.home, 'workflows')), false);
    assert.equal(existsSync(join(f.home, 'goals')), false);
    const conflict = cli(f, ['workflow', 'goal', GOAL, '--cwd', f.target, '--program', programPath, '--orchestrator', 'caller-agent', '--json']);
    assert.equal(conflict.status, 2);
    assert.equal(JSON.parse(conflict.stdout).flag, '--orchestrator');
    const foreign = join(f.root, 'foreign.json');
    writeFileSync(foreign, JSON.stringify({ schemaVersion: 'bullswarm.workflow.v1', phases: [] }));
    const rejected = cli(f, ['workflow', 'goal', GOAL, '--cwd', f.target, '--program', foreign, '--json']);
    assert.equal(rejected.status, 2);
    assert.ok(JSON.parse(rejected.stdout).issues.some((issue) => /schemaVersion must be/.test(issue)), rejected.stdout);
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
    writeFileSync(programPath, JSON.stringify(cliV3Program()));
    const bareProgram = cli(f, ['workflow', 'goal', GOAL, '--cwd', f.target, '--program']);
    assert.equal(bareProgram.status, 2, bareProgram.stdout);
    assert.match(bareProgram.stderr, /--program requires a value/);
    assert.ok(!existsSync(join(f.home, 'workflows')), 'nothing was launched');
    const barePlanner = cli(f, ['workflow', 'goal', GOAL, '--cwd', f.target, '--planner', '--program', programPath]);
    assert.equal(barePlanner.status, 2);
    assert.match(barePlanner.stderr, /--planner requires a value/);
    // A removed verb answers with its sentence before its flags are read.
    const bareReason = cli(f, ['workflow', 'plan', 'submit', 'abcdef', '--exhausted', '--reason']);
    assert.equal(bareReason.status, 2);
    assert.match(bareReason.stderr, /^✗ plan submit was removed in 0\.38\.0: /m);
    const bareResume = cli(f, ['workflow', 'goal', '--resume']);
    assert.equal(bareResume.status, 2);
    assert.match(bareResume.stderr, /--resume requires a value/);
    const dispatchedContract = cli(f, ['workflow', 'plan', 'contract', GOAL, '--cwd', f.target, '--planner', 'dispatched']);
    assert.equal(dispatchedContract.status, 2);
    assert.match(dispatchedContract.stderr, /--planner was removed/);
    const routedContract = cli(f, ['workflow', 'plan', 'contract', GOAL, '--cwd', f.target, '--orchestrator', 'caller-agent']);
    assert.equal(routedContract.status, 2);
    assert.match(routedContract.stderr, /^✗ --orchestrator was removed in 0\.38\.0/m);
    const missingCwd = cli(f, ['workflow', 'plan', 'contract', GOAL, '--cwd', join(f.root, 'missing')]);
    assert.equal(missingCwd.status, 1);
    assert.match(missingCwd.stderr, /goal cwd is not an existing directory/);
  } finally { f.cleanup(); }
});

test('CLI: workflow goal without a program refuses, launches nothing, and names every next command', () => {
  const f = cliFixture();
  try {
    const human = cli(f, ['workflow', 'goal', GOAL, '--cwd', f.target]);
    assert.equal(human.status, 2, human.stdout);
    assert.match(human.stderr, /needs a program: you are the Workflow Planner/);
    for (const fragment of ['plan contract', 'plan validate', '--program plan.json']) {
      assert.ok(human.stderr.includes(fragment), `guidance must name ${fragment}: ${human.stderr}`);
    }
    assert.equal(existsSync(join(f.home, 'workflows')), false, 'nothing may be launched');
    assert.equal(existsSync(join(f.home, 'goals')), false, 'no launch request may be written');

    const json = cli(f, ['workflow', 'goal', GOAL, '--cwd', f.target, '--json']);
    assert.equal(json.status, 2);
    const doc = JSON.parse(json.stdout);
    assert.equal(doc.error, 'program-required');
    assert.deepEqual(Object.keys(doc.next).sort(), ['contract', 'launch', 'validate']);
    assert.match(doc.next.contract, /^bullswarm workflow plan contract /);
    assert.match(doc.next.launch, /--program plan\.json --json$/);
    assert.ok(!/--scout|--orchestrator/.test(human.stderr), human.stderr);

    // The refusal's own contract command must run and describe this goal.
    const contractArgs = ['workflow', 'plan', 'contract', GOAL, '--cwd', f.target, '--json'];
    const contract = cli(f, contractArgs);
    assert.equal(contract.status, 0, contract.stderr);
    assert.equal(JSON.parse(contract.stdout).goal, GOAL);
  } finally { f.cleanup(); }
});

test('CLI: an invalid program is refused the same way by plan validate and by goal', () => {
  const f = cliFixture();
  try {
    const badPath = join(f.root, 'bad.json');
    // A dependency on an unknown action must still be refused before dispatch.
    writeFileSync(badPath, JSON.stringify({
      schemaVersion: 'bullswarm.workflow.program.v3',
      steps: [{ id: 'create-done', dependsOn: ['missing-action'], files: ['done.txt'], prompt: 'Create done.txt with the exact line caller-complete.', lane: 'build', effort: 'low' }],
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

// 0.38.0 (D2): a v2 program is refused, not translated, before a run folder
// exists; validate gives the same answer. A bare v2 program and one inside a
// planner response envelope are the same program.
test('CLI: a v2 program is refused by goal and plan validate with the v3 pointer, and nothing is launched', () => {
  const f = cliFixture();
  try {
    const bare = join(f.root, 'v2.json');
    writeFileSync(bare, JSON.stringify(cliProgram()));
    const wrapped = join(f.root, 'v2-envelope.json');
    writeFileSync(wrapped, JSON.stringify({ schemaVersion: 'bullswarm.workflow.planner-response.v2', kind: 'program', summary: 'Old program.', program: cliProgram() }));
    assert.equal(PROGRAM_V2_REFUSAL, 'bullswarm.workflow.program.v2 is no longer accepted for a new run; write a program.v3 (bullswarm workflow plan contract) and check it (bullswarm workflow plan validate --program <file.json>)');
    for (const programPath of [bare, wrapped]) {
      for (const verb of [['workflow', 'goal', GOAL], ['workflow', 'plan', 'validate', GOAL]]) {
        const human = cli(f, [...verb, '--cwd', f.target, '--program', programPath]);
        assert.deepEqual([human.status, human.stdout, human.stderr], [2, '', `✗ ${PROGRAM_V2_REFUSAL}\n`], verb.join(' '));
        const json = cli(f, [...verb, '--cwd', f.target, '--program', programPath, '--json']);
        assert.equal(json.status, 2);
        assert.deepEqual(JSON.parse(json.stdout), { error: 'program-v2-refused', message: PROGRAM_V2_REFUSAL });
      }
    }
    const detached = cli(f, ['workflow', 'goal', GOAL, '--cwd', f.target, '--program', bare, '--watch']);
    assert.equal(detached.status, 2);
    assert.equal(existsSync(join(f.home, 'workflows')), false, 'a refused v2 program creates no run folder');
    assert.equal(existsSync(join(f.home, 'goals')), false, 'and writes no launch request');
  } finally { f.cleanup(); }
});

test('CLI: plan validate accepts a good program without creating a run', () => {
  const f = cliFixture();
  try {
    const programPath = join(f.root, 'plan.json');
    writeFileSync(programPath, JSON.stringify(cliV3Program()));
    const json = cli(f, ['workflow', 'plan', 'validate', GOAL, '--cwd', f.target, '--program', programPath, '--json']);
    assert.equal(json.status, 0, json.stderr);
    const doc = JSON.parse(json.stdout);
    assert.equal(doc.action, 'plan-valid');
    assert.deepEqual(doc.program.actions.map((a) => a.id), ['create-done', 'check-create-done']);
    assert.deepEqual(doc.program.actions[1].dependsOn, ['create-done']);
    assert.ok(doc.next.launch.endsWith(`--program ${programPath} --json`), doc.next.launch);
    assert.equal(existsSync(join(f.home, 'workflows')), false, 'validation must not create a run');

    const human = cli(f, ['workflow', 'plan', 'validate', GOAL, '--cwd', f.target, '--program', programPath]);
    assert.equal(human.status, 0, human.stderr);
    assert.match(human.stdout, /program v3 valid: 2 steps, 0 gates, 0 loops \(nothing launched\)/);
    assert.match(human.stdout, /launch\s+bullswarm workflow goal/);

    const missingProgram = cli(f, ['workflow', 'plan', 'validate', GOAL, '--cwd', f.target]);
    assert.equal(missingProgram.status, 2);
    assert.match(missingProgram.stderr, /usage: bullswarm workflow plan validate/);
  } finally { f.cleanup(); }
});

test('CLI: the removed planning flags answer with the D8 sentence, and --planner stays removed', () => {
  const f = cliFixture();
  try {
    const programPath = join(f.root, 'plan.json');
    writeFileSync(programPath, JSON.stringify(cliV3Program()));
    const cases = [
      [['--program', programPath, '--orchestrator', 'auto'], /^✗ --orchestrator was removed in 0\.38\.0/m],
      [['--planner', 'caller', '--program', programPath], /--planner was removed/],
      [['--program', programPath, '--suggested-plan', 'do it'], /^✗ --suggested-plan was removed in 0\.38\.0/m],
      [['--program', programPath, '--no-scout'], /^✗ --no-scout was removed in 0\.38\.0/m],
      [['--program', programPath, '--orchestrator-model', 'worker-luna'], /^✗ --orchestrator-model was removed in 0\.38\.0/m],
      [['--orchestrator', 'caller-agent', '--strict-orchestrator', 'caller-agent'], /^✗ --orchestrator was removed in 0\.38\.0/m],
    ];
    for (const [args, pattern] of cases) {
      const result = cli(f, ['workflow', 'goal', GOAL, '--cwd', f.target, ...args]);
      assert.equal(result.status, 2, `${args.join(' ')}: ${result.stdout}`);
      assert.match(result.stderr, pattern);
    }
    assert.equal(existsSync(join(f.home, 'workflows')), false, 'no removed flag may launch');
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
    // plan submit was removed; on this v2 run it prints the view-only sentence.
    const submit = cli(f, ['workflow', 'plan', 'submit', token, '--program', programPath]);
    assert.deepEqual([submit.status, submit.stderr], [2, `${viewOnlyRunLine(token)}\n`]);
  } finally { f.cleanup(); }
});

test('CLI legacy recovery: workflow resume refuses planning flags, and refuses a run an older version left waiting as view-only', () => {
  const f = cliFixture();
  try {
    const programPath = join(f.root, 'plan.json');
    writeFileSync(programPath, JSON.stringify(cliProgram('skip-work')));
    const { shortId: token, runId } = launchLegacyGoal(f, programPath);

    for (const args of [['--program', programPath], ['--orchestrator', 'auto'], ['--scout']]) {
      const refused = cli(f, ['workflow', 'resume', token, ...args]);
      assert.equal(refused.status, 2, `${args.join(' ')}: ${refused.stdout}`);
      assert.match(refused.stderr, /keeps its durable planner mode and routing; to add steps use: bullswarm workflow add /);
    }
    const missing = cli(f, ['workflow', 'resume', 'zzzzzz', '--json']);
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /no run found/);

    // 0.38.0 (D1): a run an older version left waiting is view-only. resume
    // refuses it and writes nothing; workflow cancel is what finishes it.
    const runDir = join(f.home, 'workflows', runId);
    const before = readFileSync(join(runDir, 'state.json'), 'utf8');
    const resumed = cli(f, ['workflow', 'resume', token, '--foreground', '--json']);
    assert.equal(resumed.status, 2, resumed.stderr || resumed.stdout);
    assert.deepEqual(JSON.parse(resumed.stdout), { viewOnly: true, verb: 'resume', runId, shortId: token, dir: runDir, message: viewOnlyRunLine(token) });
    const retry = cli(f, ['workflow', 'resume', token]);
    assert.deepEqual([retry.status, retry.stdout, retry.stderr], [2, '', `${viewOnlyRunLine(token)}\n`]);
    assert.equal(readFileSync(join(runDir, 'state.json'), 'utf8'), before, 'a refused resume writes nothing');
    assert.equal(JSON.parse(before).lifecycle.status, 'waiting');
  } finally { f.cleanup(); }
});

test('CLI: capabilities and launch instructions advertise the caller-first contract', async () => {
  const f = cliFixture();
  try {
    const capabilities = JSON.parse(cli(f, ['workflow', 'capabilities']).stdout).engines.autonomousV2;
    assert.equal(capabilities.defaults.plannerMode, 'caller');
    assert.equal(capabilities.features.programRequired, true);
    assert.match(capabilities.plannerModes.caller, /^the only mode:/);
    assert.deepEqual(Object.keys(capabilities.plannerModes), ['caller']);
    assert.equal(Object.hasOwn(capabilities, 'actionRoles'), false);

    const programPath = join(f.root, 'plan.json');
    writeFileSync(programPath, JSON.stringify(cliV3Program('skip-work')));
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
    assert.equal(JSON.parse(viaShell.stdout).goal, "Fix the parser's bug");

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

const EVIDENCE_SCHEMA = {
  type: 'object', required: ['files', 'ok'], additionalProperties: false,
  properties: { files: { type: 'array', minItems: 1, items: { type: 'string' } }, ok: { const: true } },
};

const EVIDENCE_GOAL = [
  '1. Create done.txt containing exactly caller-complete followed by a newline.',
  '2. Write retry.txt containing the single line fixed.',
  '3. Append one line to log.md.',
].join('\n');

function evidenceProgram() {
  return {
    schemaVersion: 'bullswarm.workflow.program.v3',
    defaults: { reasoning: 'low' },
    steps: [
      {
        id: 'create-done', lane: 'build', files: ['done.txt'],
        prompt: 'Create done.txt with the exact line caller-complete.',
        evidence: [{ type: 'command', cmd: 'grep -qx caller-complete done.txt' }],
      },
      {
        id: 'retry-once', lane: 'build', files: ['retry.txt'],
        prompt: 'Write retry.txt with the single line fixed.',
        evidence: [{ type: 'command', cmd: 'grep -qx fixed retry.txt || (echo "retry.txt says $(cat retry.txt)"; exit 1)', timeoutSec: 30 }],
      },
      {
        id: 'summarize', lane: 'analyze', dependsOn: ['create-done'],
        prompt: 'Answer with only JSON: {"files": [...], "ok": true}.',
        evidence: [
          { type: 'command', cmd: 'test "$BULLSWARM_EVIDENCE" = 1 && grep -q done.txt "$BULLSWARM_STEP_OUTPUT"' },
          { type: 'schema', file: '$output', schema: 'schemas/summary.json' },
        ],
      },
      {
        id: 'always-fails', lane: 'build', files: ['log.md'],
        prompt: 'Append one line to log.md.',
        evidence: [{ type: 'command', cmd: 'echo "acme check failed" && exit 3' }],
      },
      {
        id: 'survey-done', lane: 'analyze', dependsOn: ['create-done'],
        prompt: 'Read done.txt and report its bytes. Do not modify any file.',
      },
    ],
  };
}

function writeEvidenceWorker(f) {
  writeFileSync(join(f.root, 'caller-worker.mjs'), [
    'import { appendFileSync, readFileSync, writeFileSync, existsSync } from "node:fs";',
    'const task = readFileSync(process.argv[2], "utf8");',
    'const id = task.match(/^Bullswarm (?:autonomous V2 evidence action|program action): ([\\w-]+)$/m)?.[1];',
    'if (task.includes("autonomous V2 evidence action")) {',
    '  const ok = existsSync("done.txt") && readFileSync("done.txt", "utf8") === "caller-complete\\n";',
    '  const candidate = task.match(/exact durable path: \'([^\']+)\'/)?.[1];',
    '  writeFileSync(candidate, JSON.stringify({schemaVersion:"bullswarm.workflow.evidence.v2",requirements:{"requirement-1":{status:ok?"passed":"failed",evidence:[ok?"done.txt has the exact line":"done.txt missing or wrong"],concerns:[]}}}));',
    '  process.stdout.write("The durable evidence candidate validated.");',
    '} else if (id === "create-done") {',
    '  writeFileSync("done.txt", "caller-complete\\n");',
    '  process.stdout.write("Wrote done.txt with the exact caller-complete line and read it back to confirm acceptance.");',
    '} else if (id === "retry-once") {',
    // The first attempt writes the wrong line; the retry sees the failed check in its brief and fixes it.
    '  const fixed = task.includes("Evidence Bullswarm ran after that attempt");',
    '  writeFileSync("retry.txt", fixed ? "fixed\\n" : "broken\\n");',
    '  process.stdout.write(fixed ? "Rewrote retry.txt with the line fixed after reading the failed check output." : "Wrote retry.txt with a first draft of its single line.");',
    '} else if (id === "summarize") {',
    '  process.stdout.write("```json\\n" + JSON.stringify({ files: ["done.txt"], ok: true }) + "\\n```\\n");',
    '} else if (id === "always-fails") {',
    '  appendFileSync("log.md", "- appended by the fixture worker\\n");',
    '  process.stdout.write("Appended one line to log.md and confirmed the file ends with it.");',
    '} else {',
    '  process.stdout.write("Read-only fixture step: reported on done.txt and changed no workspace file. It holds one line.");',
    '}',
  ].join('\n'));
}

test('CLI: evidence end to end — a passing check, a same-pool retry after a failed check, a schema check on the final response, and a step that fails twice', () => {
  const f = cliFixture();
  try {
    writeEvidenceWorker(f);
    mkdirSync(join(f.target, 'schemas'));
    writeFileSync(join(f.target, 'schemas', 'summary.json'), JSON.stringify(EVIDENCE_SCHEMA));
    writeFileSync(join(f.target, 'log.md'), '# Log\n');
    const programPath = join(f.root, 'evidence.json');
    writeFileSync(programPath, JSON.stringify(evidenceProgram()));

    // Validate: each step with checks names their types.
    const validated = cli(f, ['workflow', 'plan', 'validate', EVIDENCE_GOAL, '--cwd', f.target, '--program', programPath]);
    assert.equal(validated.status, 0, validated.stderr || validated.stdout);
    assert.match(validated.stdout, /create-done\s.* evidence=command reasoning=low$/m);
    assert.match(validated.stdout, /summarize\s.* evidence=command,schema reasoning=low after create-done$/m);
    assert.doesNotMatch(validated.stdout, /survey-done\s.*evidence=/);
    assert.equal(existsSync(join(f.home, 'workflows')), false, 'validate must not create a run');

    // Launch in the foreground: one step fails, so the run is partial.
    const launched = cli(f, ['workflow', 'goal', EVIDENCE_GOAL, '--cwd', f.target, '--program', programPath, '--summary', 'Evidence program', '--foreground']);
    assert.equal(launched.status, 1, launched.stderr || launched.stdout);
    const lines = launched.stdout.split('\n');
    const proofAt = lines.indexOf('proof: 3 steps proven (command 3, schema 1) · 1 finished · unproven: survey-done');
    assert.equal(lines[proofAt - 1], 'reason: 1 of 5 steps did not succeed: always-fails failed (failed-evidence)', launched.stdout);

    const [runId] = readdirSync(join(f.home, 'workflows'));
    const runDir = join(f.home, 'workflows', runId);
    assert.deepEqual(JSON.parse(readFileSync(join(runDir, 'features.json'), 'utf8')), { deliverableGate: 1, proofLabels: 1, failureRule: 1, reviewPlacement: 'caller', programFormat: 3 });
    const state = JSON.parse(readFileSync(join(runDir, 'state.json'), 'utf8'));
    const attemptsOf = (id) => state.attempts.filter((attempt) => attempt.actionId === id);

    // A passing check.
    const [created] = attemptsOf('create-done');
    assert.equal(attemptsOf('create-done').length, 1);
    assert.equal(created.status, 'succeeded');
    assert.deepEqual(created.evidenceResults.map((item) => [item.type, item.status, item.exit]), [['command', 'passed', 0]]);
    assert.equal(created.evidenceResults[0].log, join(runDir, 'evidence-create-done-attempt-1-1.log'));
    assert.match(readFileSync(created.evidenceResults[0].log, 'utf8'), /^\$ grep -qx caller-complete done\.txt\n/);

    // A failed check, then one retry pinned to the same pool with the check's output attached.
    const [first, second] = attemptsOf('retry-once');
    assert.equal(attemptsOf('retry-once').length, 2);
    assert.deepEqual([first.status, first.failureKind], ['failed', 'failed-evidence']);
    const events = readEvents(runDir);
    const attemptFinished = (attempt) => events.find((event) => event.type === 'attempt.finished' && event.payload.attemptId === attempt.id).payload;
    assert.equal(attemptFinished(first).willRetry, true);
    assert.deepEqual(attemptFinished(first).evidenceOutcome, { passed: 0, failed: 1, notRun: 0, why: first.why });
    assert.equal(first.evidenceResults[0].tail, 'retry.txt says broken');
    assert.equal(second.status, 'succeeded');
    assert.equal(second.pool, first.pool);
    // Stage 3 (D5, D30): the failed check is the step's one gate retry, forced
    // onto the same pool; the successor records it (D3), the failed attempt does not.
    assert.match(second.routeWhy, /^pinned to \S+ \(the same pool \(gate retry\)\) · /);
    assert.deepEqual(second.retryOf, { attempt: first.id, how: 'same-pool' });
    assert.equal(Object.hasOwn(first, 'retryOf'), false);
    assert.equal(second.evidenceResults[0].status, 'passed');
    const retryTask = readFileSync(second.taskFile, 'utf8');
    assert.match(retryTask, /## Prior attempt on this step/);
    assert.match(retryTask, /- Failure: failed-evidence — grep -qx fixed retry\.txt .* → exit 1: retry\.txt says broken/);
    assert.match(retryTask, /- Evidence Bullswarm ran after that attempt:\n {2}- command `grep -qx fixed retry\.txt [^\n]*`: failed · exit 1 · \d+s\n/);
    assert.match(retryTask, /\n {6}retry\.txt says broken\n/);
    assert.match(retryTask, /\n- This is the step's one automatic retry: the failure above closed its gate\. Fix what it names; your earlier edits are still in the workspace\.\n- Those edits are unverified\./);
    assert.equal(readFileSync(join(f.target, 'retry.txt'), 'utf8'), 'fixed\n');

    // A schema check on the step's own final response (one fenced block, unwrapped).
    const [summarized] = attemptsOf('summarize');
    assert.equal(summarized.status, 'succeeded');
    assert.deepEqual(summarized.evidenceResults.map((item) => [item.type, item.status]), [['command', 'passed'], ['schema', 'passed']]);
    assert.equal(summarized.evidenceResults[1].file, '$output');
    assert.deepEqual(summarized.evidenceResults[1].notes, ['unwrapped one fenced code block']);
    assert.match(readFileSync(summarized.taskFile, 'utf8'), /- schema: your final response must be only JSON that matches the JSON schema schemas\/summary\.json; Bullswarm checks the saved response/);

    // A check that fails twice: the step fails on the same pool and waits for the caller.
    const failing = attemptsOf('always-fails');
    assert.deepEqual(failing.map((attempt) => [attempt.status, attempt.failureKind]), [['failed', 'failed-evidence'], ['failed', 'failed-evidence']]);
    assert.equal(failing[1].pool, failing[0].pool);
    assert.equal(state.actions.find((action) => action.id === 'always-fails').lastFailure.kind, 'failed-evidence');

    // The result envelope carries the latest attempt's results, only on steps that declare evidence.
    const envelope = JSON.parse(readFileSync(join(runDir, 'result.json'), 'utf8'));
    assert.equal(envelope.status, 'partial');
    // The handback names the failed check (§2.7) and does not offer a plain retry.
    assert.deepEqual(envelope.handback.unfinished, [{
      id: 'always-fails', status: 'failed', failureKind: 'failed-evidence', retryable: false,
      why: 'echo "acme check failed" && exit 3 → exit 3: acme check failed', retries: 1,
    }]);
    const row = (id) => envelope.actions.find((action) => action.id === id);
    assert.deepEqual(row('retry-once').evidenceResults, second.evidenceResults);
    assert.deepEqual(row('always-fails').evidenceResults, failing[1].evidenceResults);
    assert.equal(Object.hasOwn(row('survey-done'), 'evidenceResults'), false);
    const finished = events.filter((event) => event.type === 'action.finished' && event.payload.status === 'succeeded');
    assert.deepEqual(Object.fromEntries(finished.map((event) => [event.payload.actionId, event.payload.proof ?? null])), {
      'create-done': { by: ['command'], reviewPending: false },
      'retry-once': { by: ['command'], reviewPending: false },
      summarize: { by: ['command', 'schema'], reviewPending: false },
      'survey-done': { by: [], reviewPending: false },
    });

    // runs result prints the same proof line; resume has nothing to retry,
    // because a failed check is about the work, and relaunches nothing.
    const token = envelope.shortId ?? runId;
    const resultText = cli(f, ['workflow', 'runs', 'result', token]);
    assert.equal(resultText.status, 1, resultText.stderr); // a partial result exits 1
    assert.match(resultText.stdout, /^# proof {2}3 steps proven \(command 3, schema 1\) · 1 finished · unproven: survey-done$/m);
    const resumed = cli(f, ['workflow', 'resume', token, '--json']);
    assert.equal(resumed.status, 1, resumed.stderr || resumed.stdout);
    assert.equal(JSON.parse(readFileSync(join(runDir, 'state.json'), 'utf8')).attempts.length, state.attempts.length, 'resume relaunched nothing');
  } finally { f.cleanup(); }
});


// --- Stage 3 end to end: the failure rule through the real kernel and the
// real dispatcher, with fake workers (watchOnce) and made-up pools. One run:
// a gate failure gets its one retry on the same pool and then goes to the
// caller; a process failure gets its one retry on another pool; a step whose
// only pool spent its usage window goes to the caller at once, with the time
// it is back, and holds no slot (owner decision, 2026-09-25: no waits); and
// the caller's accept unblocks the failed step's dependent.

test('stage 3 end to end: gate retry then the caller, process retry elsewhere, a usage limit that goes to the caller and holds no slot, and an accept that unblocks a dependent', async () => {
  const root = mkdtempSync(join(tmpdir(), 'bullswarm-stage3-e2e-'));
  try {
    const bullswarmDir = join(root, 'home');
    const workspace = join(root, 'repo');
    mkdirSync(bullswarmDir); mkdirSync(workspace);
    spawnSync('git', ['init', '-q', workspace]);
    writeFileSync(join(workspace, 'README.md'), 'acme\n');
    spawnSync('git', ['-C', workspace, 'add', '.']);
    spawnSync('git', ['-C', workspace, '-c', 'user.name=Acme Dev', '-c', 'user.email=dev@example.com', 'commit', '-qm', 'seed']);
    const ids = ['slow', 'crash', 'gate', 'after'];
    const goal = createV2GoalDocument({
      goal: 'Deliver four files', cwd: workspace,
      requirements: ids.map((id) => ({ id: `${id}-done`, text: `${id}.txt is delivered` })),
      settings: { executionMode: 'program', plannerMode: 'caller', workspaceMode: 'shared', scout: false, concurrency: 1 },
    });
    const stepOf = (id, over = {}) => ({
      id, purpose: `Deliver ${id}.txt`, dependsOn: [], affects: [`${id}-done`], ownedFiles: [`${id}.txt`],
      prompt: `Write ${id}.txt.`, lane: 'build', effort: 'low', evidenceFor: [], inputs: [], produces: [], ...over,
    });
    const actions = [
      stepOf('slow', { route: { pools: { use: ['pool-a'] } } }),
      stepOf('crash'),
      stepOf('gate', { evidence: [{ type: 'command', cmd: 'grep -q fixed gate.txt' }] }),
      stepOf('after', { dependsOn: ['gate'] }),
    ];
    const connector = (name) => ({
      name, lanes: ['analyze', 'build', 'chore'], enabled: true, spawn: { cmd: ['fake'] },
      modelSelection: { flag: '--model' },
      strategyAssignments: Object.fromEntries(['low', 'medium', 'high'].map((tier) => [tier, { pool: name, model: 'acme-model' }])),
    });
    const core = { config: { depthLimit: 2 }, pools: {}, incumbents: {}, decisionLog: [] };
    const calls = {};
    // The fake provider: slow's first attempt hits a spent usage window with
    // a named reset ten minutes out (the watcher files it as quota, with that
    // reset as retryAfter; nothing is stored on the pool); crash's first
    // worker exits 1; gate always writes what its check refuses.
    const slowBackAt = new Date(Date.now() + 10 * 60_000).toISOString();
    const worker = async (pool, task, targetDir, files, opts) => {
      const id = opts.attemptId.replace(/-\d+$/, '');
      calls[id] = (calls[id] ?? 0) + 1;
      writeFileSync(files.taskFile, task);
      if (id === 'slow' && calls[id] === 1) {
        writeFileSync(files.outFile, 'usage limit reached');
        return {
          ok: false, failureKind: 'quota', why: 'usage limit reached until the window resets', retryAfter: slowBackAt,
          usageLimit: { rule: 'message', limit: 'window', until: Date.parse(slowBackAt), line: 'usage limit reached' },
          meta: { exitCode: 1, wallSec: 1 },
        };
      }
      if (id === 'crash' && calls[id] === 1) {
        writeFileSync(files.outFile, 'boom');
        return { ok: false, why: 'worker exited 1', meta: { exitCode: 1, wallSec: 1 } };
      }
      writeFileSync(join(targetDir, `${id}.txt`), id === 'gate' ? `broken ${calls[id]}\n` : `${id} done\n`);
      writeFileSync(files.outFile, `## Done\n- ${id}.txt (${pool.name})`);
      return { ok: true, why: 'ok', meta: { exitCode: 0, wallSec: 1 } };
    };
    const dependencies = {
      refreshPools: async () => null, controlPollMs: 20,
      dispatchV2Action: (options) => dispatchV2Action({
        ...options, pools: [connector('pool-a'), connector('pool-b')],
        dependencies: {
          watchOnce: worker, loadState: () => structuredClone(core),
          saveState: (_dir, next) => Object.assign(core, structuredClone(next)), uuid: () => 'session-fixed',
        },
      }),
    };
    const runId = 'wf-s3e2e-abcdef';
    const first = await runV2AutonomousWorkflow({
      bullswarmDir, goalDocument: goal, pools: [], runId, parentEnv: {},
      initialPlannerResponse: { schemaVersion: 'bullswarm.workflow.planner-response.v2', kind: 'program', summary: 'Four files.', program: { schemaVersion: 'bullswarm.workflow.program.v2', actions } },
      dependencies,
    });
    const runDir = first.runDir;
    assert.deepEqual(JSON.parse(readFileSync(join(runDir, 'features.json'), 'utf8')), { deliverableGate: 1, proofLabels: 1, failureRule: 1, reviewPlacement: 'caller' });
    assert.equal(first.result.status, 'partial');
    const attemptsOf = (state, id) => state.attempts.filter((attempt) => attempt.actionId === id);
    const events = readEvents(runDir);
    const seq = (predicate) => events.find(predicate)?.sequence ?? Infinity;

    // The usage limit: a spent window (filed as quota) ends the step at once. No wait, no move, no retry: it goes to
    // the caller with the time its pool is back, and the only slot runs the
    // rest of the run.
    const [slow1, ...slowMore] = attemptsOf(first.state, 'slow');
    assert.deepEqual([slow1.pool, slow1.status, slow1.failureKind, slowMore.length], ['pool-a', 'failed', 'quota', 0]);
    const slowFinished = events.find((event) => event.type === 'attempt.finished' && event.payload.attemptId === 'slow-1').payload;
    assert.equal(slowFinished.willRetry, false, 'no retry is promised');
    const slowFailed = events.find((event) => event.type === 'action.finished' && event.payload.actionId === 'slow');
    assert.deepEqual([slowFailed.payload.status, slowFailed.payload.failureKind, slowFailed.payload.retryAfter], ['failed', 'quota', slowBackAt]);
    const slowRuntime = first.state.actions.find((action) => action.id === 'slow');
    assert.deepEqual([slowRuntime.status, slowRuntime.lastFailure.kind, slowRuntime.lastFailure.retryAfter], ['failed', 'quota', slowBackAt]);
    assert.equal(events.some((event) => event.type === 'action.waiting'), false, 'no quiet wait');
    const crashStarted = seq((event) => event.type === 'attempt.started' && event.payload.attemptId === 'crash-1');
    assert.ok(slowFailed.sequence < crashStarted, 'with concurrency 1, crash ran once slow went to the caller: it held no slot');
    assert.ok(Date.now() < Date.parse(slowBackAt), 'the run finished long before the pool is back: nothing waited for it');
    const slowEntry = first.result.handback.unfinished.find((entry) => entry.id === 'slow');
    assert.deepEqual([slowEntry.status, slowEntry.failureKind, slowEntry.retryAfter], ['failed', 'quota', slowBackAt]);
    // The needs-you block names the return and offers to wait for it.
    const token = first.state.shortId;
    const facts = needsYouFacts(first.state, slowFailed, { runDir });
    assert.equal(facts.backAt, slowBackAt);
    assert.equal(facts.options.waitForIt, `after ${slowBackAt}: bullswarm workflow step rerun ${token} slow`);
    assert.equal(needsYouJson(facts).backAt, slowBackAt);
    const block = renderNeedsYou(facts);
    assert.ok(block.includes(`  back at   ${slowBackAt}`), block.join('\n'));
    assert.ok(block.some((line) => /wait for it/.test(line) && line.includes(facts.options.waitForIt)), block.join('\n'));

    // The process failure: one retry, on the other pool.
    const [crash1, crash2] = attemptsOf(first.state, 'crash');
    assert.equal(attemptsOf(first.state, 'crash').length, 2);
    assert.deepEqual([crash1.failureKind, crash2.status], ['process', 'succeeded']);
    assert.notEqual(crash2.pool, crash1.pool);
    assert.deepEqual(crash2.retryOf, { attempt: 'crash-1', how: 'other-pool' });

    // The gate failure: one retry forced onto the same pool with the failure
    // attached, then the caller, whose dependent is blocked.
    const gateAttempts = attemptsOf(first.state, 'gate');
    assert.deepEqual(gateAttempts.map((attempt) => [attempt.status, attempt.failureKind]), [['failed', 'failed-evidence'], ['failed', 'failed-evidence']]);
    assert.equal(gateAttempts[1].pool, gateAttempts[0].pool);
    assert.deepEqual(gateAttempts[1].retryOf, { attempt: 'gate-1', how: 'same-pool' });
    assert.match(gateAttempts[1].routeWhy, /\(the same pool \(gate retry\)\)/);
    assert.match(readFileSync(gateAttempts[1].taskFile, 'utf8'), /- This is the step's one automatic retry: the failure above closed its gate\./);
    const gateFailed = events.findLast((event) => event.type === 'action.finished' && event.payload.actionId === 'gate').payload;
    assert.deepEqual([gateFailed.status, gateFailed.retries, gateFailed.attemptIds], ['failed', 1, ['gate-1', 'gate-2']]);
    assert.equal(first.state.actions.find((action) => action.id === 'after').status, 'blocked');
    assert.equal(calls.after, undefined);
    assert.equal(first.result.handback.unfinished.find((entry) => entry.id === 'gate').retries, 1);

    // The caller accepts the failed gate: its dependent runs, and the run completes.
    const state = JSON.parse(readFileSync(join(runDir, 'state.json'), 'utf8'));
    const request = createRevisionRequest({
      ...normalizeRevisionInput(exportV2Plan(state)), baseRevision: state.program.revision,
      accept: [{ step: 'gate', reason: 'broken is what this demo ships', requirements: null }],
    }, { source: 'step-accept' });
    const accepted = await reviseV2Program({ bullswarmDir, runId, request, waitMs: 0 });
    assert.deepEqual([accepted.status, accepted.appliedBy, accepted.record.changes.accepted], ['applied', 'offline', ['gate']]);
    assert.equal(accepted.state.actions.find((action) => action.id === 'after').status, 'pending');
    // The caller's call on slow: rerun it now rather than wait. A usage limit
    // leaves no pool behind, so the rerun may go back to pool-a, its only pool.
    const rerun = await rerunV2Step({ bullswarmDir, token, stepId: 'slow', pools: [connector('pool-a'), connector('pool-b')], waitMs: 0 });
    assert.deepEqual([rerun.status, rerun.appliedBy, rerun.changes.rerun, rerun.leaves], ['applied', 'offline', ['slow'], []], JSON.stringify(rerun));
    const second = await runV2AutonomousWorkflow({ bullswarmDir, resumeRunId: runId, pools: [], parentEnv: {}, dependencies });
    assert.equal(second.result.status, 'completed');
    assert.equal(calls.after, 1);
    const slowRerun = attemptsOf(second.state, 'slow').at(-1);
    assert.deepEqual([calls.slow, slowRerun.pool, slowRerun.status], [2, 'pool-a', 'succeeded']);
    const gate = second.state.actions.find((action) => action.id === 'gate');
    assert.deepEqual([gate.status, gate.acceptance.evidence, gate.acceptance.attemptId, gate.acceptance.failureKind], ['succeeded', 'choice', 'gate-2', 'failed-evidence']);
    assert.equal(readFileSync(join(workspace, 'after.txt'), 'utf8'), 'after done\n');
    assert.ok(readEvents(runDir).some((event) => event.type === 'step.accepted' && event.payload.actionId === 'gate'));
    assert.equal(attemptsOf(second.state, 'gate').length, 2, 'accepting never reruns the step');
  } finally { rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});

// A finished run a kernel leaves when its dispatched planner or scout hit a
// usage limit (the dispatcher's usage-limit rules, faked here). That kernel
// runs in its own process, which exits, as a real one does: a relaunched
// kernel refuses a run whose recorded kernel is still alive.
function stopInChildKernel(f, { runId, scout, stoppedId, reset, why }) {
  const goal = createV2GoalDocument({
    goal: GOAL, cwd: f.target,
    requirements: [{ id: 'requirement-1', text: 'Create done.txt containing exactly caller-complete followed by a newline.' }],
    settings: { executionMode: 'program', workspaceMode: 'shared', scout, concurrency: 1 },
  });
  const kernel = [
    `const { runV2AutonomousWorkflow } = await import(${JSON.stringify(join(REPO, 'src', 'workflow', 'v2-runtime.js'))});`,
    'const seen = [];',
    `const stopped = await runV2AutonomousWorkflow({ bullswarmDir: ${JSON.stringify(f.home)}, goalDocument: ${JSON.stringify(goal)}, pools: [], runId: ${JSON.stringify(runId)}, parentEnv: {},`,
    '  dependencies: { refreshPools: async () => null, dispatchV2Action: async (options) => {',
    '    seen.push([options.action.id, options.usageLimitsToCaller]);',
    `    return { ok: false, status: 'failed', failureKind: 'quota', retryAfter: ${JSON.stringify(reset)}, attempts: [], verdict: { ok: false, why: ${JSON.stringify(why)}, meta: { exitCode: null } } };`,
    '  } } });',
    'process.stdout.write(JSON.stringify({ seen, token: stopped.state.shortId, status: stopped.result.status, reason: stopped.result.reason }));',
  ].join('\n');
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', kernel], { cwd: REPO, encoding: 'utf8', timeout: 30_000 });
  assert.equal(child.status, 0, child.stderr);
  const stopped = JSON.parse(child.stdout);
  assert.deepEqual(stopped.seen, [[stoppedId, true]]);
  assert.equal(stopped.status, 'partial');
  return stopped;
}

test('CLI, marked: after the Workflow Planner stopped on a usage limit, the saved reason still names resume, and resume refuses the run as view-only', async () => {
  const f = cliFixture();
  try {
    // A reset still ahead, so resume says the planner can stop the same way.
    const reset = '2099-01-01T00:00:00.000Z';
    const why = `no pool with quota to spare: caller-agent paused for quota until ${reset}`;
    const { token, reason } = stopInChildKernel(f, { runId: 'wf-plstop-abcdef', scout: false, stoppedId: 'workflow-planner', reset, why });
    assert.equal(reason, `the workflow planner stopped on a usage limit: ${why} · back at ${reset} · your call: `
      + `resume after ${reset} with bullswarm workflow resume ${token}, plan it yourself with bullswarm workflow plan revise ${token} --program <file.json>, or start a new run`);

    // 0.38.0 (D1): the run is v2, so it is view-only. The saved reason above
    // stays as it was written; resume refuses and writes nothing.
    const statePath = join(f.home, 'workflows', 'wf-plstop-abcdef', 'state.json');
    const before = readFileSync(statePath, 'utf8');
    const resumed = cli(f, ['workflow', 'resume', token]);
    assert.deepEqual([resumed.status, resumed.stdout, resumed.stderr], [2, '', `${viewOnlyRunLine(token)}\n`]);
    assert.equal(readFileSync(statePath, 'utf8'), before, 'a refused resume writes nothing');
    assert.equal(existsSync(join(f.target, 'done.txt')), false, 'no planner or step ran');
  } finally { f.cleanup(); }
});

test('CLI, marked: after the preflight scout stopped on a usage limit, resume --json refuses the run as view-only', async () => {
  const f = cliFixture();
  try {
    // A reset already passed: no note, only what runs again.
    const reset = '2026-01-01T00:00:00.000Z';
    const why = `usage limit: "You've hit your session limit" · pool paused until ${reset}`;
    const { token, reason } = stopInChildKernel(f, { runId: 'wf-scstop-abcdef', scout: true, stoppedId: 'preflight-scout', reset, why });
    assert.ok(reason.startsWith(`the preflight scout stopped on a usage limit: ${why} · back at ${reset} · your call: resume after ${reset} with bullswarm workflow resume ${token}, `), reason);

    // 0.38.0 (D1): the run is v2, so it is view-only: resume refuses and writes nothing.
    const runDir = join(f.home, 'workflows', 'wf-scstop-abcdef');
    const before = readFileSync(join(runDir, 'state.json'), 'utf8');
    const resumed = cli(f, ['workflow', 'resume', token, '--json']);
    assert.equal(resumed.status, 2, resumed.stderr || resumed.stdout);
    assert.deepEqual(JSON.parse(resumed.stdout), { viewOnly: true, verb: 'resume', runId: 'wf-scstop-abcdef', shortId: token, dir: runDir, message: viewOnlyRunLine(token) });
    assert.equal(readFileSync(join(runDir, 'state.json'), 'utf8'), before, 'a refused resume writes nothing');
    assert.equal(JSON.parse(before).preflight.scout.status, 'failed');
  } finally { f.cleanup(); }
});
