import test from 'node:test';
import { renderTemplate } from '../src/workflow/template.js';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildGoalWorkflow, extractGoalRequirements, AUTONOMOUS_ORCHESTRATOR_PROMPT } from '../src/workflow/goal.js';
import {
  applyResumeModelOverrides, applyResumeOrchestratorOverride, shouldAutoWatchGoal,
} from '../src/workflow/cli.js';
import { normalizeLegacyGeneratedGoalTimeouts } from '../src/workflow/runner.js';
import { validateWorkflow } from '../src/workflow/validate.js';

const REPO = resolve(new URL('..', import.meta.url).pathname);
const BIN = join(REPO, 'bin', 'bullswarm.js');

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'bullswarm-goal-'));
  const home = join(root, '.bullswarm');
  const target = join(root, 'target');
  mkdirSync(join(home, 'connectors'), { recursive: true });
  mkdirSync(target, { recursive: true });
  const worker = join(root, 'goal-worker.mjs');
  writeFileSync(worker, [
    'import { readFileSync, writeFileSync } from "node:fs";',
    'const task = readFileSync(process.argv[2], "utf8");',
    'if (task.includes("read-only SCOUT") && task.includes("SCOUT_FAIL")) {',
    '  process.stderr.write("scout could not read the repository\\n");',
    '  process.exit(3);',
    '} else if (task.includes("BEGIN DURABLE WORKFLOW CONTEXT")) {',
    '  const done = task.includes("goal-verify") && task.includes("succeeded");',
    '  const premature = task.includes("PREMATURE_COMPLETION") && !task.includes("goal-work") && !task.includes("CORRECTION REQUIRED");',
    '  const answer = premature',
    '    ? {schemaVersion:"bullswarm.workflow.decision.v1",decision:"complete",reason:"Claiming completion before any evidence for policy testing.",actions:[]}',
    '    : done',
    '      ? {schemaVersion:"bullswarm.workflow.decision.v1",decision:"complete",reason:"The worker artifact and concrete acceptance evidence prove the autonomous goal is complete.",actions:[]}',
    '      : {schemaVersion:"bullswarm.workflow.decision.v1",decision:"needs_more_work",reason:"One bounded implementation action and an independent verification are required.",actions:[{id:"goal-work",type:"run",phase:"implement",prompt:"Create done.txt containing autonomous-complete, then read it back and report the exact path and contents as verification evidence.",dependsOn:[]},{id:"goal-verify",type:"verify",phase:"verify",covers:["R1"],prompt:"Independently verify done.txt exists with the exact expected contents.",dependsOn:["goal-work"]}]};',
    '  process.stdout.write(JSON.stringify(answer));',
    '} else if (task.includes("RETURN ONLY a single JSON object")) {',
    '  const ok = readFileSync("done.txt", "utf8") === "autonomous-complete\\n";',
    '  process.stdout.write(JSON.stringify({ok,concerns:ok?[]:["wrong contents"],summary:ok?"Independent verification read done.txt from the target directory, compared every byte with the expected autonomous-complete line, and confirmed the durable artifact exactly satisfies acceptance.":"Independent verification found that done.txt does not contain the exact expected autonomous-complete line, so acceptance is not satisfied.",requirements:{R1:{ok,evidence:ok?"done.txt contains exactly autonomous-complete followed by a newline":"done.txt content mismatch"}}}));',
    '} else {',
    '  writeFileSync("done.txt", "autonomous-complete\\n");',
    '  process.stdout.write("Implemented the bounded goal and verified the durable artifact at done.txt. Exact contents: autonomous-complete. The file was read back successfully and acceptance is satisfied.");',
    '}',
  ].join('\n'));
  const connector = {
    name: 'goal-agent', bin: 'node', configDirs: [],
    spawn: { cmd: ['node', worker, '{taskFile}'], cwdMode: 'add-dir' },
    authSignatures: [], outputExtraction: { strategy: 'stdout' },
    meter: { type: 'none' }, costRank: 1, lanes: ['analyze', 'build', 'chore'],
    capabilities: ['strong-analysis', 'workflow-planning', 'code-reading', 'file-editing'],
    knownModels: ['planner-sol', 'worker-luna'],
    modelSelection: { flag: '--model', mode: 'replace-or-append' },
    timeoutSec: 30,
  };
  writeFileSync(join(home, 'connectors', 'goal-agent.json'), `${JSON.stringify(connector, null, 2)}\n`);
  writeFileSync(join(home, 'state.json'), `${JSON.stringify({
    version: 1,
    pools: { 'goal-agent': { enabled: true } },
    incumbents: {},
    decisionLog: [],
    config: { depthLimit: 2, callerName: 'claude-code' },
  }, null, 2)}\n`);
  return {
    root, home, target,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function cli(f, args) {
  return spawnSync(process.execPath, [BIN, ...args], {
    cwd: REPO,
    env: { ...process.env, BULLSWARM_HOME: f.home, BULLSWARM_DEPTH: '0' },
    encoding: 'utf8',
    timeout: 20_000,
  });
}

test('goal builder internalizes orchestration without requiring an initial graph', () => {
  const doc = buildGoalWorkflow({
    goal: 'Implement and verify the requested repository change.',
    suggestedPlan: 'Discover the owned surface, implement the change, then independently verify it.',
    cwd: REPO,
    name: 'autonomous-test',
  });
  assert.equal(doc.intent.autonomous, true);
  assert.equal(doc.intent.suggestedPlan, 'Discover the owned surface, implement the change, then independently verify it.');
  assert.deepEqual(doc.intent.requirements, [{ id: 'R1', text: 'Implement and verify the requested repository change.' }]);
  assert.equal(doc.intent.requestedOrchestrator, 'auto');
  assert.equal(doc.phases.length, 1);
  // A read-only scout surveys the repository before the orchestrator compiles its first program.
  assert.equal(doc.phases[0].steps.length, 2);
  assert.equal(doc.phases[0].steps[0].id, 'scout');
  assert.equal(doc.phases[0].steps[0].type, 'run');
  assert.equal(doc.phases[0].steps[0].addDir, REPO);
  assert.match(doc.phases[0].steps[0].prompt, /Do NOT modify, create, or delete any file/);
  assert.match(doc.phases[0].steps[0].prompt, /UNITS OF WORK/);
  assert.match(doc.phases[0].steps[0].prompt, /END your output with a JSON array/);
  assert.equal(doc.phases[0].steps[1].type, 'decide');
  assert.equal(doc.phases[0].steps[1].id, 'orchestrator');
  assert.equal(doc.phases[0].steps[1].pool, undefined);
  assert.equal(doc.phases[0].steps[1].prompt, `${AUTONOMOUS_ORCHESTRATOR_PROMPT}\n\nWorktree isolation policy: agent decides whether isolation is useful; do not introduce a worktree for routine sequential work.`);
  assert.match(doc.phases[0].steps[1].prompt, /control-plane decision thread/);
  assert.match(doc.phases[0].steps[1].prompt, /Do not invoke Bullswarm, run shell commands, call tools, modify files/);
  assert.match(doc.phases[0].steps[1].prompt, /Compile the goal into a complete workflow program/);
  assert.equal(doc.settings.maxItemsPerExpansion, 24);
  // The goal is user text: a goal that quotes something shaped like a template
  // ref must validate and reach the scout verbatim. (Observed 2026-08-29: a
  // goal quoting `{{outputs.x.data.field}}` failed the run at validation.)
  const meta = buildGoalWorkflow({
    goal: 'Make {{outputs.x.data.field}} render; keep `{{maxLength?: number}}` literal.',
    cwd: REPO, name: 'meta-goal',
  });
  assert.equal(meta.inputs.goal.default, meta.intent.goal);
  assert.doesNotThrow(() => validateWorkflow(meta, { poolNames: ['goal-agent'] }));
  const scoutStep = meta.phases[0].steps[0];
  assert.equal(scoutStep.id, 'scout');
  assert.match(scoutStep.prompt, /Goal: \{\{inputs\.goal\}\}/);
  assert.doesNotMatch(scoutStep.prompt, /outputs\.x\.data/);
  const renderedScout = renderTemplate(scoutStep.prompt, { inputs: { goal: meta.inputs.goal.default } });
  assert.match(renderedScout, /Goal: Make \{\{outputs\.x\.data\.field\}\} render; keep `\{\{maxLength\?: number\}\}` literal\./);

  const noScout = buildGoalWorkflow({ goal: 'Implement it.', cwd: REPO, name: 'no-scout', scout: false });
  assert.equal(noScout.phases[0].steps.length, 1);
  assert.equal(noScout.phases[0].steps[0].id, 'orchestrator');
  assert.doesNotThrow(() => validateWorkflow(noScout, { poolNames: ['goal-agent'] }));
  assert.equal(doc.intent.worktreeIsolation, 'agent-decides');
  assert.deepEqual(doc.orchestration.completionPolicy, {
    requireSuccessfulWorker: true,
    requireSuccessfulVerification: true,
  });
  assert.doesNotThrow(() => validateWorkflow(doc, { poolNames: ['goal-agent'] }));
});

test('goal requirements preserve numbered deliverables and explicit completion criteria', () => {
  assert.deepEqual(extractGoalRequirements(`Update the workflow engine.\n1. Add outputSchema validation and schemaOk.\n2) Emit retry events and preserve resume state.\nFinish with focused tests and documentation.`), [
    { id: 'R1', text: 'Add outputSchema validation and schemaOk.' },
    { id: 'R2', text: 'Emit retry events and preserve resume state.' },
    { id: 'R3', text: 'Finish with focused tests and documentation.' },
  ]);

  assert.deepEqual(extractGoalRequirements('Release acceptance. 1. Inspect the entry point. 2. Exercise read-only classification. 3. Confirm integration and package dry-run evidence.'), [
    { id: 'R1', text: 'Inspect the entry point.' },
    { id: 'R2', text: 'Exercise read-only classification.' },
    { id: 'R3', text: 'Confirm integration and package dry-run evidence.' },
  ]);
});

test('resume can prefer an orchestrator with fallback or strictly pin one for QA', () => {
  const doc = buildGoalWorkflow({ goal: 'Verify the change.', cwd: REPO, name: 'resume-route' });
  assert.equal(doc.orchestration.requestedPool, null);
  applyResumeOrchestratorOverride(doc, 'grok');
  assert.equal(doc.intent.requestedOrchestrator, 'grok');
  assert.equal(doc.orchestration.requestedPool, 'grok');
  assert.equal(doc.orchestration.selection, 'user-preferred-with-fallback');
  assert.equal(doc.phases[0].steps[1].preferredPool, 'grok');
  assert.equal(doc.phases[0].steps[1].pool, undefined);
  applyResumeOrchestratorOverride(doc, null, 'claude-code');
  assert.equal(doc.orchestration.selection, 'user-strict-for-testing');
  assert.equal(doc.orchestration.strictPool, 'claude-code');
  assert.equal(doc.phases[0].steps[1].pool, 'claude-code');
  assert.equal(doc.phases[0].steps[1].preferredPool, undefined);
  applyResumeOrchestratorOverride(doc, 'auto');
  assert.equal(doc.intent.requestedOrchestrator, 'auto');
  assert.equal(doc.orchestration.requestedPool, null);
  assert.equal(doc.phases[0].steps[1].pool, undefined);
  assert.equal(doc.phases[0].steps[1].preferredPool, undefined);
  assert.throws(
    () => applyResumeOrchestratorOverride(doc, 'grok', 'claude-code'),
    /mutually exclusive/,
  );
});

test('new goals encode ordinary orchestrator choice as a preference and strict QA as a pin', () => {
  const preferred = buildGoalWorkflow({
    goal: 'Inspect it.', cwd: REPO, name: 'preferred-route', orchestrator: 'grok',
  });
  assert.equal(preferred.phases[0].steps[1].preferredPool, 'grok');
  assert.equal(preferred.phases[0].steps[1].pool, undefined);
  assert.equal(preferred.orchestration.selection, 'user-preferred-with-fallback');

  const strict = buildGoalWorkflow({
    goal: 'Inspect it.', cwd: REPO, name: 'strict-route', orchestrator: 'grok', strictOrchestrator: true,
  });
  assert.equal(strict.phases[0].steps[1].pool, 'grok');
  assert.equal(strict.phases[0].steps[1].preferredPool, undefined);
  assert.equal(strict.orchestration.selection, 'user-strict-for-testing');
});

test('goal model locks cover the planner, scout, future workers, and resume overrides', () => {
  const doc = buildGoalWorkflow({
    goal: 'Inspect it.', cwd: REPO, name: 'model-locked-route',
    orchestrator: 'goal-agent', strictOrchestrator: true,
    orchestratorModel: 'planner-sol', workerPool: 'goal-agent', workerModel: 'worker-luna',
  });
  const [scout, planner] = doc.phases[0].steps;
  assert.equal(scout.pool, 'goal-agent');
  assert.equal(scout.model, 'worker-luna');
  assert.equal(planner.pool, 'goal-agent');
  assert.equal(planner.model, 'planner-sol');
  assert.equal(planner.actionDefaults.pool, 'goal-agent');
  assert.equal(planner.actionDefaults.model, 'worker-luna');
  assert.equal(doc.orchestration.requestedModel, 'planner-sol');
  assert.equal(doc.orchestration.workerModel, 'worker-luna');
  assert.doesNotThrow(() => validateWorkflow(doc, { poolNames: ['goal-agent'] }));

  applyResumeModelOverrides(doc, {
    orchestratorModel: 'planner-sol-2', workerPool: 'goal-agent-2', workerModel: 'worker-luna-2',
  });
  assert.equal(planner.model, 'planner-sol-2');
  assert.equal(planner.actionDefaults.pool, 'goal-agent-2');
  assert.equal(planner.actionDefaults.model, 'worker-luna-2');
  assert.equal(scout.pool, 'goal-agent-2');
  assert.equal(scout.model, 'worker-luna-2');

  applyResumeModelOverrides(doc, {
    orchestratorModel: 'auto', workerPool: 'auto', workerModel: 'auto',
  });
  assert.equal(planner.model, undefined);
  assert.equal(planner.actionDefaults.pool, undefined);
  assert.equal(planner.actionDefaults.model, undefined);
  assert.equal(scout.pool, undefined);
  assert.equal(scout.model, undefined);
});

test('CLI exact model locks are preserved on every planner and worker attempt', () => {
  const f = fixture();
  try {
    const result = cli(f, [
      'workflow', 'goal', 'Create and verify done.txt with exact route locks.',
      '--cwd', f.target, '--foreground', '--json',
      '--strict-orchestrator', 'goal-agent', '--orchestrator-model', 'planner-sol',
      '--worker-pool', 'goal-agent', '--worker-model', 'worker-luna',
    ]);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const report = JSON.parse(result.stdout);
    assert.ok(report.attempts.length >= 4);
    for (const attempt of report.attempts) {
      assert.equal(attempt.pool, 'goal-agent');
      assert.equal(attempt.model, attempt.actionId === 'orchestrator' ? 'planner-sol' : 'worker-luna');
      assert.equal(attempt.routing.modelPolicy.source, 'step-model-lock');
    }
  } finally { f.cleanup(); }
});

test('legacy generated goals drop Bullswarm-owned 900s timeouts without touching authored workflows', () => {
  const legacy = buildGoalWorkflow({
    goal: 'Finish the durable goal.', cwd: REPO, name: 'legacy-goal',
  });
  const gate = legacy.phases[0].steps.find((step) => step.type === 'decide');
  gate.timeoutSec = 900;
  gate.actionDefaults.timeoutSec = 900;
  const migrated = normalizeLegacyGeneratedGoalTimeouts(legacy);
  const migratedGate = migrated.phases[0].steps.find((step) => step.type === 'decide');
  assert.equal(migratedGate.timeoutSec, undefined);
  assert.equal(migratedGate.actionDefaults.timeoutSec, undefined);
  assert.equal(gate.timeoutSec, 900, 'migration must not mutate the durable source document');

  const authored = structuredClone(legacy);
  authored.description = 'User-authored workflow with an explicit timeout.';
  const preserved = normalizeLegacyGeneratedGoalTimeouts(authored);
  const preservedGate = preserved.phases[0].steps.find((step) => step.type === 'decide');
  assert.equal(preservedGate.timeoutSec, 900);
  assert.equal(preservedGate.actionDefaults.timeoutSec, 900);
});

test('goal watching is explicit and incompatible launch modes do not auto-watch', () => {
  assert.equal(shouldAutoWatchGoal({}), false);
  assert.equal(shouldAutoWatchGoal({ watch: true }), true);
  assert.equal(shouldAutoWatchGoal({ watch: true, detach: true }), false);
  assert.equal(shouldAutoWatchGoal({ watch: true, foreground: true }), false);
  assert.equal(shouldAutoWatchGoal({ watch: true, json: true }), false);
  assert.equal(shouldAutoWatchGoal({ watch: true, resume: 'abc234' }), false);
});

test('--watch prints the operating handoff and follows the independent run to terminal', () => {
  const f = fixture();
  try {
    const result = cli(f, [
      'workflow', 'goal', 'Create and verify done.txt while the caller watches.',
      '--cwd', f.target, '--watch', '--max-agents', '6', '--max-expansion-rounds', '2',
    ]);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /workflow [a-z2-9]{6} continues independently; next commands:/);
    assert.match(result.stdout, /agentInspect\s+bullswarm workflow tui --json/);
    assert.match(result.stdout, /humanTui\s+bullswarm workflow tui/);
    assert.match(result.stdout, /result\s+bullswarm workflow runs result/);
    assert.match(result.stdout, /completed/);
    assert.equal(readFileSync(join(f.target, 'done.txt'), 'utf8'), 'autonomous-complete\n');
  } finally { f.cleanup(); }
});

test('a failed scout is non-fatal: the planner still runs and sees outputs.scout.ok=false', () => {
  const f = fixture();
  try {
    const result = cli(f, [
      'workflow', 'goal', 'SCOUT_FAIL: create and verify done.txt even though the survey fails.',
      '--cwd', f.target, '--foreground', '--json', '--max-agents', '6', '--max-expansion-rounds', '2',
    ]);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const report = JSON.parse(result.stdout);
    assert.equal(report.status, 'completed');
    const scout = report.actionLedger.find((action) => action.id === 'scout');
    assert.equal(scout.status, 'failed_terminal');
    assert.equal(readFileSync(join(f.target, 'done.txt'), 'utf8'), 'autonomous-complete\n');
    // The planner was consulted after the (retried) scout failure and told about it.
    const plannerTasks = report.attempts
      .map((attempt) => readFileSync(attempt.taskFile, 'utf8'))
      .filter((task) => task.includes('BEGIN DURABLE WORKFLOW CONTEXT'));
    assert.ok(plannerTasks.length >= 1, 'planner must still be consulted after a failed scout');
    assert.match(plannerTasks[0], /"scout": \{[^}]*"ok": false/);
    // The real worker and its independent verification still ran and succeeded.
    assert.equal(report.actionLedger.find((action) => action.id === 'goal-work').status, 'succeeded');
    assert.equal(report.actionLedger.find((action) => action.id === 'goal-verify').status, 'succeeded');
  } finally { f.cleanup(); }
});

test('one foreground CLI goal autonomously plans, routes, executes, verifies, and completes', () => {
  const f = fixture();
  try {
    const result = cli(f, [
      'workflow', 'goal', 'Create and verify done.txt without asking for a workflow document.',
      '--cwd', f.target, '--foreground', '--json', '--max-agents', '6', '--max-expansion-rounds', '2',
    ]);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const report = JSON.parse(result.stdout);
    assert.equal(report.status, 'completed');
    assert.equal(report.intent.goal, 'Create and verify done.txt without asking for a workflow document.');
    assert.equal(report.orchestration.selectedPool, 'goal-agent');
    assert.deepEqual(report.decisions.map((decision) => decision.decision), ['needs_more_work', 'complete']);
    assert.equal(report.actionLedger.find((action) => action.id === 'goal-verify').status, 'succeeded');
    assert.equal(report.usage.attempts, report.attempts.length);
    assert.ok(report.usage.tokens.standardRead > 0);
    assert.ok(report.usage.tokens.output > 0);
    assert.equal(report.attempts.every((attempt) => attempt.usage?.tokenSource), true);
    assert.equal(readFileSync(join(f.target, 'done.txt'), 'utf8'), 'autonomous-complete\n');
    assert.equal(existsSync(join(report.artifactsDir, 'workflow.json')), true);
    // The scout runs first (attempt 0); the planner is the first decide attempt.
    assert.equal(report.actionLedger.find((action) => action.id === 'scout').status, 'succeeded');
    const scoutTask = readFileSync(report.attempts[0].taskFile, 'utf8');
    assert.match(scoutTask, /read-only SCOUT/);
    const firstPlannerTask = readFileSync(report.attempts[1].taskFile, 'utf8');
    assert.match(firstPlannerTask, /BEGIN DURABLE WORKFLOW CONTEXT/);
    assert.match(firstPlannerTask, /"scout": \{[^}]*"ok": true/);
    assert.match(firstPlannerTask, /"outputExcerpt": "/);
    assert.match(firstPlannerTask, /"actionTimeoutSec": null/);
    assert.match(firstPlannerTask, /"actionTimeoutIsExplicitOptIn": false/);
    assert.match(firstPlannerTask, /"dispatchTarget": 6/);
    assert.match(firstPlannerTask, /"remainingDispatches": 4/);
    assert.match(firstPlannerTask, /"advisoryOnly": true/);
    assert.match(firstPlannerTask, /"verificationDispatchReserve": 1/);
    assert.match(firstPlannerTask, /Budgets \(agents, duration, expansion rounds\) are advisory targets/);
    assert.match(firstPlannerTask, /Converge as targets approach/);

    const shown = cli(f, ['workflow', 'tui', '--json', report.shortId]);
    assert.equal(shown.status, 0, shown.stderr);
    const dashboard = JSON.parse(shown.stdout);
    assert.equal(dashboard.state.runId, report.runId);
    assert.deepEqual(dashboard.state.attempts, report.attempts);
    assert.equal(dashboard.events.at(-1).type, 'run.completed');
  } finally { f.cleanup(); }
});

test('autonomous completion is rejected until worker and verification evidence exist', () => {
  const f = fixture();
  try {
    const result = cli(f, [
      'workflow', 'goal', 'PREMATURE_COMPLETION then create and verify done.txt.',
      '--cwd', f.target, '--foreground', '--json', '--max-agents', '8', '--max-expansion-rounds', '2',
    ]);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const report = JSON.parse(result.stdout);
    assert.equal(report.status, 'completed');
    assert.deepEqual(report.decisions.map((decision) => decision.decision), ['needs_more_work', 'complete']);
    assert.ok(report.attempts.filter((attempt) => attempt.actionId === 'orchestrator').length >= 2,
      'premature completion is corrected before it becomes an accepted durable decision');
    assert.equal(report.decisions.at(-1).accepted, true);
  } finally { f.cleanup(); }
});

test('detached CLI goal survives the initiating CLI and remains observable', async () => {
  const f = fixture();
  try {
    const launchResult = cli(f, [
      'workflow', 'goal', 'Create and verify done.txt in a detached autonomous run.',
      '--cwd', f.target, '--json', '--max-agents', '6', '--max-expansion-rounds', '2',
    ]);
    assert.equal(launchResult.status, 0, launchResult.stderr || launchResult.stdout);
    const launch = JSON.parse(launchResult.stdout);
    assert.equal(launch.action, 'goal-launched');
    assert.match(launch.runId, /^wf-/);
    assert.match(launch.instructions.agentInspect.command, /workflow tui --json/);
    assert.match(launch.instructions.watch.command, /workflow watch/);
    assert.match(launch.instructions.humanTui.command, /workflow tui [^\n]+$/);
    assert.match(launch.instructions.result.command, /workflow runs result .* --json/);

    const statePath = join(f.home, 'workflows', launch.runId, 'state.json');
    let state;
    for (let i = 0; i < 200; i++) {
      if (existsSync(statePath)) {
        try { state = JSON.parse(readFileSync(statePath, 'utf8')); } catch { /* write in progress */ }
      }
      if (state?.status === 'completed') break;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
    }
    assert.equal(state?.status, 'completed');
    assert.equal(readFileSync(join(f.target, 'done.txt'), 'utf8'), 'autonomous-complete\n');

    const events = cli(f, ['workflow', 'events', '--json', launch.runId, '--after', '0']);
    assert.equal(events.status, 0, events.stderr);
    const eventDoc = JSON.parse(events.stdout);
    assert.equal(eventDoc.events.at(-1).type, 'run.completed');
    assert.ok(eventDoc.events.some((event) => event.type === 'orchestrator.selected'));
    assert.equal(readdirSync(join(f.home, 'goals', launch.runId)).includes('launcher.json'), true);

    const resumed = cli(f, ['workflow', 'goal', '--resume', state.shortId, '--json']);
    assert.equal(resumed.status, 0, resumed.stderr || resumed.stdout);
    const resumedReport = JSON.parse(resumed.stdout);
    assert.equal(resumedReport.resumed, true);
    assert.equal(resumedReport.status, 'completed');
    assert.equal(resumedReport.attempts.filter((attempt) => attempt.actionId === 'goal-work').length, 1);
  } finally { f.cleanup(); }
});
