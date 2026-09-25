import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  extractGoalRequirements, extractScoutUnitIds, goalProjectPath, readGoalProject,
  recordGoalProject, scoutPrompt,
} from '../src/workflow/goal.js';
import { extractV2GoalConstraints, shouldAutoWatchGoal } from '../src/workflow/cli.js';
import { createV2GoalDocument } from '../src/workflow/v2-state.js';
import { runV2AutonomousWorkflow } from '../src/workflow/v2-runtime.js';

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
    'if (task.includes("read-only SCOUT")) {',
    '  process.stdout.write(["TREE:\\n- target/", "MANIFEST:\\n- fixture repository", "TEST STATUS:\\n- no test command required", "UNITS OF WORK:\\n- goal-work: create done.txt and inspect it", "SHARED FILES:\\n- none", "RISKS:\\n- exact byte content must match", "The target is a bounded disposable fixture. ".repeat(8), "[\\\"goal-work\\\"]"].join("\\n"));',
    '} else if (task.includes("single logical Workflow Planner for Bullswarm autonomous V2")) {',
    '  const candidate = task.match(/exact durable path: \'([^\']+)\'/)?.[1];',
    '  if (!candidate) throw new Error("missing durable planner candidate path");',
    '  writeFileSync(candidate, JSON.stringify({schemaVersion:"bullswarm.workflow.planner-response.v2",kind:"program",summary:"Create the bounded artifact and inspect it independently.",program:{schemaVersion:"bullswarm.workflow.program.v2",actions:[{id:"goal-work",purpose:"Create done artifact",dependsOn:[],affects:["requirement-1"],ownedFiles:["done.txt"],prompt:"Create done.txt containing exactly autonomous-complete followed by a newline, then read it back.",lane:"build",effort:"low",evidenceFor:[],inputs:[],produces:["done-artifact"]},{id:"goal-evidence",purpose:"Inspect done artifact",dependsOn:["goal-work"],affects:[],ownedFiles:[],prompt:"Read done.txt and compare every byte with the required content.",lane:"analyze",effort:"low",evidenceFor:["requirement-1"],inputs:["done-artifact"],produces:[]}]}}));',
    '  process.stdout.write("The durable planner candidate validated.");',
    '} else if (task.includes("autonomous V2 evidence action")) {',
    '  const ok = readFileSync("done.txt", "utf8") === "autonomous-complete\\n";',
    '  const candidate = task.match(/exact durable path: \'([^\']+)\'/)?.[1];',
    '  if (!candidate) throw new Error("missing durable evidence candidate path");',
    '  writeFileSync(candidate, JSON.stringify({schemaVersion:"bullswarm.workflow.evidence.v2",requirements:{"requirement-1":{status:ok?"passed":"failed",evidence:[ok?"done.txt contains the exact autonomous-complete line":"done.txt content mismatch"],concerns:[]}}}));',
    '  process.stdout.write("The durable evidence candidate validated.");',
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

  const decisiveSuffix = 'The same action must use exactly one label everywhere, including q exit and q detach.';
  const longClause = `${'Preserve this acceptance context without loss. '.repeat(20)}${decisiveSuffix}`;
  const [longRequirement] = extractGoalRequirements(`1. ${longClause}`);
  assert.equal(longRequirement.text, longClause);
  assert.ok(longRequirement.text.length > 600);
  assert.match(longRequirement.text, /including q exit and q detach\.$/);

  // The documented one-line form ("1. A. 2. B.") is one numbered line to the
  // line pass; it must still yield one requirement per clause, exactly like
  // the newline-separated form, or plan contract advertises the wrong IDs.
  assert.deepEqual(extractGoalRequirements('1. Fix the parser. 2. Update the docs.'), [
    { id: 'R1', text: 'Fix the parser.' },
    { id: 'R2', text: 'Update the docs.' },
  ]);
  assert.deepEqual(extractGoalRequirements('1. Add a --version flag to bin/demo.js. 2. Document it in README.md. 3. Add a test.').map((r) => r.text), [
    'Add a --version flag to bin/demo.js.', 'Document it in README.md.', 'Add a test.',
  ]);
  assert.deepEqual(extractGoalRequirements('1) One 2) Two 3) Three').map((r) => r.text), ['One', 'Two', 'Three']);
  // A prose goal that merely mentions a number is not a list.
  assert.deepEqual(extractGoalRequirements('Ship version 2. Then rest.'), [{ id: 'R1', text: 'Ship version 2. Then rest.' }]);
  assert.deepEqual(extractGoalRequirements('1. Bump to version 2 and keep tests green.'), [{ id: 'R1', text: 'Bump to version 2 and keep tests green.' }]);
});

test('goal CLI extracts only explicit workspace read-only constraints', () => {
  assert.deepEqual(extractV2GoalConstraints('Read-only: inspect this repository.'), { workspaceMutation: 'forbidden' });
  assert.deepEqual(extractV2GoalConstraints('Audit this repo. Do not modify repository files.'), { workspaceMutation: 'forbidden' });
  assert.equal(extractV2GoalConstraints('Change the read-only label into an editable control.'), null);
  assert.equal(extractV2GoalConstraints('Implement and verify the requested feature.'), null);
});

test('scout treats shared files as ordered acceptance slices instead of a forced monolith', () => {
  const prompt = scoutPrompt('Implement three related dashboard behaviors.', '/tmp/repo');
  assert.match(prompt, /each focused regression belongs with that behavior implementation/i);
  assert.match(prompt, /one numbered requirement contains several independently testable clauses/i);
  assert.match(prompt, /avoid an umbrella unit named after the whole requirement/i);
  assert.match(prompt, /quote the decisive acceptance qualifiers it owns/i);
  assert.match(prompt, /existing implementation or tests that contradict the goal are migration work/i);
  assert.match(prompt, /final cross-cutting acceptance slice/i);
  assert.match(prompt, /tests-only regression slice is not a valid final owner/i);
  assert.match(prompt, /does not require one monolithic action/i);
  assert.match(prompt, /small ordered sequence that reuses the same owned files/i);
});

test('scout unit handoff accepts only a trailing unique kebab-case JSON array', () => {
  assert.deepEqual(extractScoutUnitIds('UNITS OF WORK:\n- alpha\n["alpha","beta-two"]'), ['alpha', 'beta-two']);
  assert.deepEqual(extractScoutUnitIds('UNITS OF WORK:\n- alpha\n["Alpha"]'), []);
  assert.deepEqual(extractScoutUnitIds('UNITS OF WORK:\n- alpha\n["alpha","alpha"]'), []);
  assert.deepEqual(extractScoutUnitIds('UNITS OF WORK:\n- alpha'), []);
});

test('retired authored-graph verbs and V1 runs fail closed before dispatch', () => {
  const f = fixture();
  try {
    const legacyPath = join(f.root, 'retired-autonomous-v1.json');
    writeFileSync(legacyPath, JSON.stringify({
      schemaVersion: 'bullswarm.workflow.v1',
      name: 'retired-autonomous-v1',
      description: 'Autonomous goal-driven workflow generated by Bullswarm.',
      intent: { autonomous: true, goal: 'Do not dispatch this old run.' },
      orchestration: { mode: 'autonomous' },
      inputs: {}, settings: {}, phases: [],
    }));
    // 0.27.0 removed the authored-graph executor: every one of its verbs is
    // now an unknown workflow subcommand. A V1 document is not rejected on its
    // content any more — there is no verb left that would read it.
    for (const argv of [
      ['workflow', 'run', legacyPath, '--json'],
      ['workflow', 'validate', legacyPath],
      ['workflow', 'list'],
      ['workflow', 'inspect', legacyPath],
      ['workflow', 'draft', 'list'],
      ['workflow', 'approval', 'approve', 'abc234'],
    ]) {
      const retired = cli(f, argv);
      assert.equal(retired.status, 2, `${argv.join(' ')}: ${retired.stdout}${retired.stderr}`);
      assert.match(retired.stderr, /bullswarm workflow/);
      assert.equal(existsSync(join(f.home, 'workflows')), false, `${argv.join(' ')} must not create a run`);
    }

    const oldRunDir = join(f.home, 'workflows', 'wf-retired-v1');
    mkdirSync(oldRunDir, { recursive: true });
    writeFileSync(join(oldRunDir, 'state.json'), JSON.stringify({
      runId: 'wf-retired-v1', shortId: 'abc234', status: 'interrupted',
      intent: { autonomous: true, goal: 'Old autonomous state.' },
    }));
    const resumed = cli(f, ['workflow', 'goal', '--resume', 'abc234', '--json']);
    assert.equal(resumed.status, 1);
    assert.match(resumed.stderr, /unsupported V1 autonomous run; start a new V2 goal/);
  } finally { f.cleanup(); }
});

test('capabilities report one live engine and the authored graphs as retired', () => {
  const f = fixture();
  try {
    const result = cli(f, ['workflow', 'capabilities']);
    assert.equal(result.status, 0, result.stderr);
    const capabilities = JSON.parse(result.stdout);
    assert.equal(capabilities.engines.autonomousV2.stateSchema, 'bullswarm.workflow.state.v2');
    assert.equal(capabilities.engines.autonomousV2.completionAuthority, 'kernel action results; requirement evidence is reported separately');
    assert.equal(capabilities.engines.autonomousV2.defaults.workspaceMode, 'shared');
    assert.equal(capabilities.engines.autonomousV2.features.enforcedFileOwnership, false);
    assert.equal(capabilities.engines.autonomousV2.features.semanticRepairLoops, false);
    assert.deepEqual(capabilities.engines.autonomousV2.compatibility, {
      resumesAutonomousV1: false, migratesAutonomousV1: false, preservesSavedV2Semantics: true,
    });
    assert.equal(capabilities.engines.authoredGraphs.retired, '0.27.0');
    assert.equal(capabilities.engines.authoredGraphs.command, null);
    assert.deepEqual(capabilities.engines.authoredGraphs.stepTypes, []);
    assert.match(capabilities.engines.authoredGraphs.legacyRuns, /rows marked legacy/);
    assert.equal(capabilities.worktreeIsolation.authoredGraphs, undefined);
  } finally { f.cleanup(); }
});

test('CLI exact model locks are preserved on every planner and worker attempt', () => {
  const f = fixture();
  try {
    const result = cli(f, [
      'workflow', 'goal', 'Create and verify done.txt with exact route locks.',
      '--cwd', f.target, '--foreground', '--json',
      '--orchestrator', 'goal-agent', '--orchestrator-strict', '--orchestrator-model', 'planner-sol',
      '--worker-pool', 'goal-agent', '--worker-model', 'worker-luna',
    ]);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const report = JSON.parse(result.stdout);
    const state = JSON.parse(readFileSync(join(f.home, 'workflows', report.runId, 'state.json'), 'utf8'));
    assert.deepEqual(state.config.workerRouting, {
      pool: 'goal-agent', preferredModel: 'worker-luna', strictPool: 'goal-agent',
    });
    const attempts = [...state.preflight.scout.attempts, ...state.planner.attempts, ...state.attempts];
    assert.ok(attempts.length >= 4);
    for (const attempt of attempts) {
      assert.equal(attempt.pool, 'goal-agent');
      assert.equal(attempt.model, state.planner.attempts.includes(attempt) ? 'planner-sol' : 'worker-luna');
    }
  } finally { f.cleanup(); }
});

test('CLI suggested plan is validated, persisted, and supplied to the planner', () => {
  const f = fixture();
  try {
    const suggestedPlan = 'Inspect the fixture, create the bounded artifact, then verify exact bytes.';
    const result = cli(f, [
      'workflow', 'goal', 'Create and verify done.txt using bounded planner context.',
      '--cwd', f.target, '--foreground', '--json', '--suggested-plan', suggestedPlan,
      '--orchestrator', 'goal-agent', '--orchestrator-strict', '--orchestrator-model', 'planner-sol',
      '--worker-pool', 'goal-agent', '--worker-model', 'worker-luna',
    ]);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const report = JSON.parse(result.stdout);
    const runDir = join(f.home, 'workflows', report.runId);
    const goal = JSON.parse(readFileSync(join(runDir, 'goal.json'), 'utf8'));
    const state = JSON.parse(readFileSync(join(runDir, 'state.json'), 'utf8'));
    assert.equal(goal.config.settings.suggestedPlan, suggestedPlan);
    assert.equal(state.config.settings.suggestedPlan, suggestedPlan);
    const plannerTask = readFileSync(state.planner.attempts[0].taskFile, 'utf8');
    assert.match(plannerTask, new RegExp(suggestedPlan.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  } finally { f.cleanup(); }
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
      '--cwd', f.target, '--orchestrator', 'auto', '--watch', '--max-agents', '6', '--max-expansion-rounds', '2',
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

test('--no-scout deterministically skips preflight without weakening evidence completion', () => {
  const f = fixture();
  try {
    const result = cli(f, [
      'workflow', 'goal', 'Create and verify done.txt without repository reconnaissance.',
      '--cwd', f.target, '--orchestrator', 'auto', '--foreground', '--json', '--no-scout', '--max-agents', '6', '--max-expansion-rounds', '2',
    ]);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const report = JSON.parse(result.stdout);
    assert.equal(report.status, 'completed');
    const state = JSON.parse(readFileSync(join(f.home, 'workflows', report.runId, 'state.json'), 'utf8'));
    assert.equal(state.preflight.scout.status, 'skipped');
    assert.equal(state.preflight.scout.attempts.length, 0);
    assert.equal(readFileSync(join(f.target, 'done.txt'), 'utf8'), 'autonomous-complete\n');
    assert.equal(report.requirements[0].status, 'passed');
  } finally { f.cleanup(); }
});

test('one foreground CLI goal autonomously plans, routes, executes, verifies, and completes', () => {
  const f = fixture();
  try {
    const result = cli(f, [
      'workflow', 'goal', 'Create and verify done.txt without asking for a workflow document.',
      '--cwd', f.target, '--orchestrator', 'auto', '--foreground', '--json', '--max-agents', '6', '--max-expansion-rounds', '2',
    ]);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const report = JSON.parse(result.stdout);
    assert.equal(report.status, 'completed');
    assert.equal(report.schemaVersion, 'bullswarm.workflow.result.v2');
    assert.equal(report.goal, 'Create and verify done.txt without asking for a workflow document.');
    assert.equal(report.verified, true);
    assert.deepEqual(report.actions.map((action) => action.id), ['goal-work', 'goal-evidence']);
    assert.equal(report.requirements[0].status, 'passed');
    assert.equal(readFileSync(join(f.target, 'done.txt'), 'utf8'), 'autonomous-complete\n');
    const state = JSON.parse(readFileSync(join(f.home, 'workflows', report.runId, 'state.json'), 'utf8'));
    assert.equal(state.preflight.scout.status, 'succeeded');
    const scoutTask = readFileSync(state.preflight.scout.attempts[0].taskFile, 'utf8');
    assert.match(scoutTask, /read-only SCOUT/);
    const firstPlannerTask = readFileSync(state.planner.attempts[0].taskFile, 'utf8');
    assert.match(firstPlannerTask, /single logical Workflow Planner for Bullswarm autonomous V2/);
    assert.match(firstPlannerTask, /fixture repository/);
    assert.equal(state.planner.turns, 1);
    assert.equal(state.lifecycle.status, 'completed');
  } finally { f.cleanup(); }
});

test('kernel completion requires fresh requirement-scoped evidence', () => {
  const f = fixture();
  try {
    const result = cli(f, [
      'workflow', 'goal', 'PREMATURE_COMPLETION then create and verify done.txt.',
      '--cwd', f.target, '--orchestrator', 'auto', '--foreground', '--json', '--max-agents', '8', '--max-expansion-rounds', '2',
    ]);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const report = JSON.parse(result.stdout);
    assert.equal(report.status, 'completed');
    assert.equal(report.verified, true);
    assert.equal(report.requirements[0].status, 'passed');
    assert.equal(report.actions.find((action) => action.id === 'goal-evidence').status, 'succeeded');
  } finally { f.cleanup(); }
});

test('detached CLI goal survives the initiating CLI and remains observable', async () => {
  const f = fixture();
  try {
    const launchResult = cli(f, [
      'workflow', 'goal', 'Create and verify done.txt in a detached autonomous run.',
      '--cwd', f.target, '--orchestrator', 'auto', '--json', '--max-agents', '6', '--max-expansion-rounds', '2',
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
      if (state?.lifecycle?.status === 'completed') break;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
    }
    assert.equal(state?.lifecycle?.status, 'completed');
    assert.equal(readFileSync(join(f.target, 'done.txt'), 'utf8'), 'autonomous-complete\n');

    const events = cli(f, ['workflow', 'events', '--json', launch.runId, '--after', '0']);
    assert.equal(events.status, 0, events.stderr);
    const eventDoc = JSON.parse(events.stdout);
    assert.equal(eventDoc.events.at(-1).type, 'workflow.finished');
    assert.ok(eventDoc.events.some((event) => event.type === 'planner.started'));
    assert.equal(readdirSync(join(f.home, 'goals', launch.runId)).includes('launcher.json'), true);

    const resumed = cli(f, ['workflow', 'goal', '--resume', state.shortId, '--json']);
    assert.equal(resumed.status, 0, resumed.stderr || resumed.stdout);
    const resumedReport = JSON.parse(resumed.stdout);
    assert.equal(resumedReport.status, 'completed');
    const resumedState = JSON.parse(readFileSync(statePath, 'utf8'));
    assert.equal(resumedState.attempts.filter((attempt) => attempt.actionId === 'goal-work').length, 1);
  } finally { f.cleanup(); }
});

test('run-wide reasoning flags are validated and land in the durable routing contract', () => {
  const f = fixture();
  try {
    const bad = cli(f, [
      'workflow', 'goal', 'Create and verify done.txt at an invented reasoning level.',
      '--cwd', f.target, '--foreground', '--json', '--orchestrator', 'goal-agent',
      '--worker-reasoning', 'ultra',
    ]);
    assert.equal(bad.status, 2, bad.stdout || bad.stderr);
    assert.match(bad.stderr, /--worker-reasoning must be low\|medium\|high\|xhigh\|max\|default/);
    const runsDir = join(f.home, 'workflows');
    assert.equal(existsSync(runsDir) ? readdirSync(runsDir).length : 0, 0, 'a rejected flag must not create a run');

    const missing = cli(f, [
      'workflow', 'goal', 'Create and verify done.txt.', '--cwd', f.target, '--foreground',
      '--orchestrator', 'goal-agent', '--worker-reasoning',
    ]);
    assert.equal(missing.status, 2, missing.stdout || missing.stderr);
    assert.match(missing.stderr, /--worker-reasoning requires a value/);

    const result = cli(f, [
      'workflow', 'goal', 'Create and verify done.txt with run-wide reasoning depth.',
      '--cwd', f.target, '--foreground', '--json',
      '--orchestrator', 'goal-agent', '--orchestrator-strict', '--orchestrator-model', 'planner-sol',
      '--worker-pool', 'goal-agent', '--worker-model', 'worker-luna',
      '--worker-reasoning', 'xhigh', '--planner-reasoning', 'default',
    ]);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const report = JSON.parse(result.stdout);
    const runDir = join(f.home, 'workflows', report.runId);
    const goal = JSON.parse(readFileSync(join(runDir, 'goal.json'), 'utf8'));
    const state = JSON.parse(readFileSync(join(runDir, 'state.json'), 'utf8'));
    assert.deepEqual(goal.config.workerRouting, {
      pool: 'goal-agent', preferredModel: 'worker-luna', strictPool: 'goal-agent', reasoning: 'xhigh',
    });
    assert.deepEqual(goal.config.plannerRouting, {
      pool: 'goal-agent', preferredModel: 'planner-sol', strictPool: 'goal-agent', reasoning: 'default',
    });
    assert.equal(state.config.workerRouting.reasoning, 'xhigh');
    assert.equal(state.config.plannerRouting.reasoning, 'default');
    // Resume keeps the durable contract instead of accepting a new level.
    const resumed = cli(f, ['workflow', 'goal', '--resume', report.runId, '--worker-reasoning', 'low']);
    assert.equal(resumed.status, 2, resumed.stdout || resumed.stderr);
    assert.match(resumed.stderr, /routing overrides are valid only when starting a new goal/);
  } finally { f.cleanup(); }
});

test('plan contract echoes the run-wide reasoning levels a launch will apply', () => {
  const f = fixture();
  try {
    const result = cli(f, [
      'workflow', 'plan', 'contract', 'Create done.txt and verify it.',
      '--cwd', f.target, '--worker-reasoning', 'high', '--json',
    ]);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const contract = JSON.parse(result.stdout);
    assert.equal(contract.reasoning.worker, 'high');
    assert.equal(contract.reasoning.planner, null);
    assert.match(contract.program.actionFields.reasoning, /how hard the picked model thinks on this one action/);
  } finally { f.cleanup(); }
});

test('--planner-reasoning is refused where there is no dispatched planner to apply it to', () => {
  const f = fixture();
  try {
    // Caller-planner mode never builds a plannerRouting, so accepting the flag
    // would silently discard a level the caller believes it set.
    const caller = cli(f, [
      'workflow', 'goal', 'Create and verify done.txt.', '--cwd', f.target, '--foreground',
      '--scout', '--planner-reasoning', 'high',
    ]);
    assert.equal(caller.status, 2, caller.stdout || caller.stderr);
    assert.match(caller.stderr, /--planner-reasoning appl(?:ies|y) only with --orchestrator/);
    const runsDir = join(f.home, 'workflows');
    assert.equal(existsSync(runsDir) ? readdirSync(runsDir).length : 0, 0, 'a rejected flag must not create a run');

    // The planning commands always describe caller-planner mode.
    const contract = cli(f, [
      'workflow', 'plan', 'contract', 'Create done.txt and verify it.',
      '--cwd', f.target, '--planner-reasoning', 'high', '--json',
    ]);
    assert.equal(contract.status, 2, contract.stdout || contract.stderr);
    assert.match(contract.stderr, /--planner-reasoning applies only to a dispatched planner/);

    // --worker-reasoning stays accepted in exactly the same place.
    const worker = cli(f, [
      'workflow', 'plan', 'contract', 'Create done.txt and verify it.',
      '--cwd', f.target, '--worker-reasoning', 'high', '--json',
    ]);
    assert.equal(worker.status, 0, worker.stderr || worker.stdout);
    assert.equal(JSON.parse(worker.stdout).reasoning.worker, 'high');
  } finally { f.cleanup(); }
});

test('a goal already progressing in the same cwd is refused as a duplicate until --again', () => {
  const f = fixture();
  try {
    // The observed failure: a caller whose JSON parser failed on the first
    // launch's output retried the same command five seconds later and two
    // identical workflows ran side by side in one directory. The fixture run
    // stands in for the first launch, carrying exactly the fields listRuns()
    // reads to call a V2 run ongoing.
    const goal = 'Create and verify done.txt in a duplicated autonomous run.';
    const startedAt = new Date().toISOString();
    const runDir = join(f.home, 'workflows', 'wf-fixture-ongoing');
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, 'state.json'), `${JSON.stringify({
      schemaVersion: 'bullswarm.workflow.state.v2',
      runId: 'wf-fixture-ongoing',
      shortId: 'dupe23',
      intent: { goal, cwd: f.target, requirements: [] },
      lifecycle: { status: 'running', startedAt, finishedAt: null },
      runner: { pid: process.pid, startedAt, lastHeartbeatAt: startedAt },
    }, null, 2)}\n`);

    const duplicate = cli(f, ['workflow', 'goal', goal, '--cwd', f.target, '--json']);
    assert.equal(duplicate.status, 2, duplicate.stdout || duplicate.stderr);
    const doc = JSON.parse(duplicate.stdout);
    assert.equal(doc.error, 'duplicate-goal');
    assert.equal(doc.shortId, 'dupe23');
    assert.equal(doc.runId, 'wf-fixture-ongoing');
    assert.equal(doc.startedAt, startedAt);
    assert.equal(doc.next.watch, 'bullswarm workflow watch dupe23 --next');
    assert.match(doc.next.again, /^bullswarm workflow goal .* --cwd .* --again$/);

    // The same refusal in the human form, with the age and the way past it.
    const human = cli(f, ['workflow', 'goal', goal, '--cwd', f.target]);
    assert.equal(human.status, 2, human.stdout || human.stderr);
    assert.match(
      human.stderr,
      /✗ this goal is already running as dupe23 \(started \d+s ago in \S+\); watch it with: bullswarm workflow watch dupe23 --next · to launch another copy anyway pass --again/,
    );

    // Both escapes clear the check and reach the next refusal (a new goal with
    // no program), and neither touched the run that is already going.
    for (const argv of [
      ['workflow', 'goal', goal, '--cwd', f.target, '--again', '--json'],
      ['workflow', 'goal', goal, '--cwd', f.root, '--json'],
    ]) {
      const escaped = cli(f, argv);
      assert.equal(escaped.status, 2, `${argv.join(' ')}: ${escaped.stdout}${escaped.stderr}`);
      assert.equal(JSON.parse(escaped.stdout).error, 'program-required', `${argv.join(' ')} must get past the duplicate check`);
    }
    assert.equal(readdirSync(join(f.home, 'workflows')).length, 1, 'a duplicate refusal must not create a run');
  } finally { f.cleanup(); }
});

// --- project identity at goal time -------------------------------------
//
// The rollup groups runs by project, and a cwd is not a project: three git
// worktrees of one repository are three directories and one project. The
// identity is stamped when the run is launched, because by the time it
// finishes the branch worktree may be gone.

test('a launch records the project beside its goal document, and reads it back', () => {
  const root = mkdtempSync(join(tmpdir(), 'bullswarm-goal-project-'));
  try {
    const checkout = join(root, 'a-branch-worktree');
    mkdirSync(checkout);
    const git = (args) => spawnSync('git', args, {
      cwd: checkout, encoding: 'utf8',
      env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
    });
    git(['init', '--quiet']);
    git(['remote', 'add', 'origin', 'https://github.com/Bulls-Work/bullswarm.git']);

    const runDir = join(root, 'wf-goal-project');
    mkdirSync(runDir);
    const recorded = recordGoalProject(runDir, checkout, { now: () => '2026-09-16T12:00:00.000Z' });
    assert.equal(recorded.schemaVersion, 'bullswarm.workflow.project.v1');
    assert.equal(recorded.name, 'bullswarm', 'the origin remote names the project, not the worktree directory');
    assert.equal(recorded.remote, 'https://github.com/Bulls-Work/bullswarm.git');
    assert.equal(recorded.cwd, checkout);
    assert.equal(recorded.recordedAt, '2026-09-16T12:00:00.000Z');
    assert.equal(goalProjectPath(runDir), join(runDir, 'project.json'));
    assert.deepEqual(readGoalProject(runDir), recorded);

    // The checkout can go; the run still knows which project it belonged to.
    rmSync(checkout, { recursive: true, force: true });
    assert.equal(readGoalProject(runDir).name, 'bullswarm');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('recording the project never throws, and a run with no record reads back null', () => {
  const root = mkdtempSync(join(tmpdir(), 'bullswarm-goal-project-none-'));
  try {
    assert.equal(readGoalProject(root), null, 'no record yet');
    // An unwritable destination must not cost a launch its run.
    assert.doesNotThrow(() => recordGoalProject(join(root, 'no', 'such', '\0bad'), root));
    assert.equal(recordGoalProject(join(root, 'no', 'such', '\0bad'), root), null);

    const runDir = join(root, 'plain-run');
    mkdirSync(runDir);
    assert.equal(recordGoalProject(runDir, null).name, null, 'no cwd is a null name, not a throw');

    writeFileSync(join(runDir, 'project.json'), JSON.stringify({ schemaVersion: 'something.else.v9', name: 'nope' }));
    assert.equal(readGoalProject(runDir), null, 'a foreign schema is not a project record');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// --- stage 3: route checks, --retry-attempts range, the verifyRounds note -----

function routedFixture() {
  const f = fixture();
  // A second provider, and a display label for the first pool.
  const beta = JSON.parse(readFileSync(join(f.home, 'connectors', 'goal-agent.json'), 'utf8'));
  writeFileSync(join(f.home, 'connectors', 'beta-agent.json'), `${JSON.stringify({ ...beta, name: 'beta-agent' }, null, 2)}\n`);
  const core = JSON.parse(readFileSync(join(f.home, 'state.json'), 'utf8'));
  core.pools['beta-agent'] = { enabled: true };
  writeFileSync(join(f.home, 'state.json'), `${JSON.stringify(core, null, 2)}\n`);
  writeFileSync(join(f.home, 'pool-labels.json'), `${JSON.stringify({ labels: { 'goal-agent': 'alpha' } })}\n`);
  return f;
}

function callerProgram({ route = null, defaults = null } = {}) {
  return {
    schemaVersion: 'bullswarm.workflow.planner-response.v2', kind: 'program',
    summary: 'Create the bounded artifact and inspect it independently.',
    program: {
      schemaVersion: 'bullswarm.workflow.program.v2',
      ...(defaults ? { defaults } : {}),
      actions: [
        {
          id: 'goal-work', purpose: 'Create done artifact', dependsOn: [], affects: ['requirement-1'], ownedFiles: ['done.txt'],
          prompt: 'Create done.txt containing exactly autonomous-complete followed by a newline, then read it back.',
          lane: 'build', effort: 'low', evidenceFor: [], inputs: [], produces: ['done-artifact'], ...(route ? { route } : {}),
        },
        {
          id: 'goal-evidence', purpose: 'Inspect done artifact', dependsOn: ['goal-work'], affects: [], ownedFiles: [],
          prompt: 'Read done.txt and compare every byte with the required content.',
          lane: 'analyze', effort: 'low', evidenceFor: ['requirement-1'], inputs: ['done-artifact'], produces: [],
        },
      ],
    },
  };
}

const GOAL_TEXT = 'Create and verify done.txt.';

test('route checks need the configured pools: validate and launch refuse unknown pools, labels, providers and empty routes', () => {
  const f = routedFixture();
  try {
    const cases = [
      [{ pools: { use: ['nope'] } }, [], /step goal-work route\.pools\.use names "nope", which is not a configured pool \(configured: (beta-agent, goal-agent|goal-agent, beta-agent)\)/],
      [{ pools: { avoid: ['alpha'] } }, [], /step goal-work route\.pools\.avoid names "alpha", which is a pool label; use its id "goal-agent"/],
      [{ providers: { use: ['nope'] } }, [], /step goal-work route\.providers\.use names "nope", which no configured pool uses \(providers: beta-agent, goal-agent\)/],
      [{ pools: { avoid: ['beta-agent', 'goal-agent'] } }, [], /step goal-work: no enabled pool can run it under its route \(build\/low work; route: avoid beta-agent, goal-agent\)/],
      [{ pools: { avoid: ['goal-agent'] } }, ['--worker-pool', 'goal-agent'], /step goal-work: its route leaves nothing of the run's pinned pool goal-agent \(--worker-pool\)/],
    ];
    for (const [index, [route, extra, message]] of cases.entries()) {
      const file = join(f.root, `routed-${index}.json`);
      writeFileSync(file, JSON.stringify(callerProgram({ route })));
      const validated = cli(f, ['workflow', 'plan', 'validate', GOAL_TEXT, '--cwd', f.target, '--program', file, ...extra]);
      assert.equal(validated.status, 2, `validate ${index}: ${validated.stderr || validated.stdout}`);
      assert.match(validated.stderr, message, `validate ${index}`);
      const launched = cli(f, ['workflow', 'goal', GOAL_TEXT, '--cwd', f.target, '--program', file, '--json', ...extra]);
      assert.equal(launched.status, 2, `launch ${index}: ${launched.stderr || launched.stdout}`);
      const refusal = JSON.parse(launched.stdout);
      assert.equal(refusal.error, 'program-invalid');
      assert.ok(refusal.issues.some((issue) => message.test(issue)), `launch ${index}: ${refusal.issues.join(' | ')}`);
    }
    assert.equal(existsSync(join(f.home, 'workflows')), false, 'nothing launched');
    // A route every check accepts validates and is echoed back.
    const good = join(f.root, 'routed-ok.json');
    writeFileSync(good, JSON.stringify(callerProgram({ route: { pools: { avoid: ['beta-agent'] } } })));
    const ok = cli(f, ['workflow', 'plan', 'validate', GOAL_TEXT, '--cwd', f.target, '--program', good, '--json']);
    assert.equal(ok.status, 0, ok.stderr);
    assert.deepEqual(JSON.parse(ok.stdout).program.actions[0].route, { pools: { avoid: ['beta-agent'] } });
    const text = cli(f, ['workflow', 'plan', 'validate', GOAL_TEXT, '--cwd', f.target, '--program', good]);
    assert.equal(text.status, 0, text.stderr);
    assert.match(text.stdout, /goal-work .* route: avoid beta-agent/);
  } finally { f.cleanup(); }
});

// F8: the revise precheck checks the routes of every step the revision
// (re)starts, the dependents an amendment invalidates included.
test('plan revise refuses an amendment whose invalidated dependent has a route the pools cannot serve', async () => {
  const f = fixture();
  try {
    const work = (id, options = {}) => ({
      id, purpose: `Deliver ${id}`, dependsOn: [], affects: ['requirement-1'], ownedFiles: [`${id}.txt`],
      prompt: `Write ${id}.txt.`, lane: 'build', effort: 'low', evidenceFor: [], inputs: [], produces: [], ...options,
    });
    const goalDocument = createV2GoalDocument({
      goal: GOAL_TEXT, cwd: f.target, requirements: [{ id: 'requirement-1', text: 'Deliver the files.' }],
      settings: { executionMode: 'program', workspaceMode: 'shared', scout: false, plannerMode: 'caller', concurrency: 2 },
    });
    // The kernel runs no CLI route check, so b's unknown pool gets in.
    const dispatch = async (options) => {
      const files = options.paths(1);
      const record = { ordinal: 1, pool: 'goal-agent', model: 'worker-luna', status: 'running', startedAt: new Date().toISOString(), taskFile: files.taskFile, outFile: files.outFile };
      writeFileSync(files.taskFile, options.taskText);
      options.onAttempt?.('started', record);
      writeFileSync(join(options.targetDir, `${options.action.id}.txt`), 'x');
      writeFileSync(files.outFile, 'done');
      Object.assign(record, { status: 'succeeded', finishedAt: new Date().toISOString(), changedFileCount: 1 });
      options.onAttempt?.('finished', record);
      return { ok: true, status: 'succeeded', attempts: [record], verdict: { ok: true, outFile: files.outFile } };
    };
    const runId = 'wf-revrte-abcdef';
    await runV2AutonomousWorkflow({
      bullswarmDir: f.home, goalDocument, pools: [], runId,
      initialPlannerResponse: {
        schemaVersion: 'bullswarm.workflow.planner-response.v2', kind: 'program', summary: 'Two steps.',
        program: { schemaVersion: 'bullswarm.workflow.program.v2', actions: [work('a'), work('b', { dependsOn: ['a'], route: { pools: { use: ['nope'] } } })] },
      },
      dependencies: { dispatchV2Action: dispatch, controlPollMs: 10 },
    });
    const statePath = join(f.home, 'workflows', runId, 'state.json');
    const before = readFileSync(statePath, 'utf8');
    assert.equal(JSON.parse(before).lifecycle.status, 'completed');
    const plan = join(f.root, 'plan.json');
    const exported = cli(f, ['workflow', 'plan', 'export', runId, '--out', plan]);
    assert.equal(exported.status, 0, exported.stderr);
    const document = JSON.parse(readFileSync(plan, 'utf8'));
    document.program.actions.find((action) => action.id === 'a').prompt = 'Write a.txt again.';
    writeFileSync(plan, JSON.stringify(document));
    const revised = cli(f, ['workflow', 'plan', 'revise', runId, '--program', plan, '--json', '--wait', '0']);
    assert.equal(revised.status, 2, revised.stderr || revised.stdout);
    const refusal = JSON.parse(revised.stdout);
    assert.equal(refusal.status, 'rejected');
    assert.deepEqual(refusal.issues, ['step b route.pools.use names "nope", which is not a configured pool (configured: goal-agent)']);
    assert.equal(readFileSync(statePath, 'utf8'), before, 'the run is unchanged');
  } finally { f.cleanup(); }
});

test('plan revise under a --worker-pool pin checks an added check\'s "writers" against the work the run already did', async () => {
  const f = fixture();
  try {
    const goalDocument = createV2GoalDocument({
      goal: GOAL_TEXT, cwd: f.target, requirements: [{ id: 'requirement-1', text: 'Deliver the files.' }],
      settings: { executionMode: 'program', workspaceMode: 'shared', scout: false, plannerMode: 'caller', concurrency: 1 },
    });
    const dispatch = async (options) => {
      const files = options.paths(1);
      const record = { ordinal: 1, pool: 'goal-agent', model: 'worker-luna', status: 'running', startedAt: new Date().toISOString(), taskFile: files.taskFile, outFile: files.outFile };
      writeFileSync(files.taskFile, options.taskText);
      options.onAttempt?.('started', record);
      writeFileSync(join(options.targetDir, `${options.action.id}.txt`), 'x');
      writeFileSync(files.outFile, 'done');
      Object.assign(record, { status: 'succeeded', finishedAt: new Date().toISOString(), changedFileCount: 1 });
      options.onAttempt?.('finished', record);
      return { ok: true, status: 'succeeded', attempts: [record], verdict: { ok: true, outFile: files.outFile } };
    };
    const runId = 'wf-revpin-abcdef';
    await runV2AutonomousWorkflow({
      bullswarmDir: f.home, goalDocument, pools: [], runId,
      initialPlannerResponse: {
        schemaVersion: 'bullswarm.workflow.planner-response.v2', kind: 'program', summary: 'One writer.',
        program: { schemaVersion: 'bullswarm.workflow.program.v2', actions: [{
          id: 'a', purpose: 'Deliver a', dependsOn: [], affects: ['requirement-1'], ownedFiles: ['a.txt'],
          prompt: 'Write a.txt.', lane: 'build', effort: 'low', evidenceFor: [], inputs: [], produces: [],
        }] },
      },
      dependencies: { dispatchV2Action: dispatch, controlPollMs: 10 },
    });
    const runDir = join(f.home, 'workflows', runId);
    const statePath = join(runDir, 'state.json');
    // The run is pinned to the pool its writer did its work on.
    const goalPath = join(runDir, 'goal.json');
    const doc = JSON.parse(readFileSync(goalPath, 'utf8'));
    doc.config = { ...(doc.config ?? {}), workerRouting: { ...(doc.config?.workerRouting ?? {}), strictPool: 'goal-agent' } };
    writeFileSync(goalPath, JSON.stringify(doc));
    const before = readFileSync(statePath, 'utf8');
    const plan = join(f.root, 'plan.json');
    const exported = cli(f, ['workflow', 'plan', 'export', runId, '--out', plan]);
    assert.equal(exported.status, 0, exported.stderr);
    const document = JSON.parse(readFileSync(plan, 'utf8'));
    // A check the revision adds: its writer `a` is finished and not in the revision.
    document.program.actions.push({
      id: 'check', purpose: 'Check a', dependsOn: ['a'], affects: [], ownedFiles: [], prompt: 'Read a.txt and judge it.',
      lane: 'analyze', effort: 'low', evidenceFor: ['requirement-1'], inputs: [], produces: [], route: { independentOf: 'writers' },
    });
    writeFileSync(plan, JSON.stringify(document));
    const revised = cli(f, ['workflow', 'plan', 'revise', runId, '--program', plan, '--json', '--wait', '0']);
    assert.equal(revised.status, 2, revised.stderr || revised.stdout);
    const refusal = JSON.parse(revised.stdout);
    assert.equal(refusal.status, 'rejected');
    assert.equal(refusal.issues.length, 1, JSON.stringify(refusal.issues));
    assert.match(refusal.issues[0], /^step check: its route is independent of writers \(a\), which runs on the run's pinned pool goal-agent \(--worker-pool, provider [^)]+\), so no pool is left for it; drop independentOf or run without --worker-pool$/);
    assert.equal(readFileSync(statePath, 'utf8'), before, 'the run is unchanged');
  } finally { f.cleanup(); }
});

test('--retry-attempts is 0 to 3: 4 is a usage error at launch and validate', () => {
  const f = fixture();
  try {
    const file = join(f.root, 'plan.json');
    writeFileSync(file, JSON.stringify(callerProgram()));
    for (const argv of [
      ['workflow', 'goal', GOAL_TEXT, '--cwd', f.target, '--program', file, '--retry-attempts', '4'],
      ['workflow', 'plan', 'validate', GOAL_TEXT, '--cwd', f.target, '--program', file, '--retry-attempts', '4'],
    ]) {
      const result = cli(f, argv);
      assert.equal(result.status, 2, `${argv[1]}: ${result.stderr || result.stdout}`);
      assert.match(result.stderr, /--retry-attempts must be 0, 1, 2 or 3/);
    }
    const zero = cli(f, ['workflow', 'plan', 'validate', GOAL_TEXT, '--cwd', f.target, '--program', file, '--retry-attempts', '0']);
    assert.equal(zero.status, 0, zero.stderr);
    assert.equal(existsSync(join(f.home, 'workflows')), false);
  } finally { f.cleanup(); }
});

const VERIFY_NOTE = 'note: defaults.verifyRounds counts fix cycles since this version (1 = one fix and one re-review, 0 = review only); it counted review rounds before';

async function waitTerminal(f, runId) {
  const statePath = join(f.home, 'workflows', runId, 'state.json');
  let state = null;
  for (let i = 0; i < 400; i++) {
    try { state = JSON.parse(readFileSync(statePath, 'utf8')); } catch { /* write in progress */ }
    if (['completed', 'partial', 'failed', 'cancelled'].includes(state?.lifecycle?.status) && !state?.runner?.pid) break;
    if (['completed', 'partial', 'failed', 'cancelled'].includes(state?.lifecycle?.status) && i > 40) break;
    await new Promise((done) => setTimeout(done, 25));
  }
  return state;
}

test('the verifyRounds note: validate and launch say it when the program sets it, and only then', async () => {
  const f = fixture();
  try {
    const plain = join(f.root, 'plain.json');
    const counted = join(f.root, 'counted.json');
    writeFileSync(plain, JSON.stringify(callerProgram()));
    writeFileSync(counted, JSON.stringify(callerProgram({ defaults: { verifyRounds: 1 } })));

    const text = cli(f, ['workflow', 'plan', 'validate', GOAL_TEXT, '--cwd', f.target, '--program', counted]);
    assert.equal(text.status, 0, text.stderr);
    assert.ok(text.stdout.includes(VERIFY_NOTE), text.stdout);
    const json = cli(f, ['workflow', 'plan', 'validate', GOAL_TEXT, '--cwd', f.target, '--program', counted, '--json']);
    assert.equal(json.status, 0, json.stderr);
    assert.equal(JSON.parse(json.stdout).verifyRoundsMeaning, 'fix cycles');
    const none = cli(f, ['workflow', 'plan', 'validate', GOAL_TEXT, '--cwd', f.target, '--program', plain, '--json']);
    assert.equal('verifyRoundsMeaning' in JSON.parse(none.stdout), false);
    const noneText = cli(f, ['workflow', 'plan', 'validate', GOAL_TEXT, '--cwd', f.target, '--program', plain]);
    assert.ok(!noneText.stdout.includes('verifyRounds counts fix cycles') && !noneText.stderr.includes('verifyRounds counts fix cycles'));

    const launched = cli(f, ['workflow', 'goal', GOAL_TEXT, '--cwd', f.target, '--program', counted, '--json']);
    assert.equal(launched.status, 0, launched.stderr);
    assert.ok(launched.stderr.includes(VERIFY_NOTE), launched.stderr);
    const launch = JSON.parse(launched.stdout);
    assert.equal(launch.verifyRoundsMeaning, 'fix cycles');
    await waitTerminal(f, launch.runId);
    const quiet = cli(f, ['workflow', 'goal', 'Create and verify done.txt again.', '--cwd', f.target, '--program', plain, '--json']);
    assert.equal(quiet.status, 0, quiet.stderr);
    assert.ok(!quiet.stderr.includes('verifyRounds counts fix cycles'), quiet.stderr);
    assert.equal('verifyRoundsMeaning' in JSON.parse(quiet.stdout), false);
    await waitTerminal(f, JSON.parse(quiet.stdout).runId);
  } finally { f.cleanup(); }
});

test('plan revise prints the verifyRounds note for a marked run, never for a saved one', async () => {
  const f = fixture();
  try {
    const counted = join(f.root, 'counted.json');
    writeFileSync(counted, JSON.stringify(callerProgram({ defaults: { verifyRounds: 1 } })));
    const run = cli(f, ['workflow', 'goal', GOAL_TEXT, '--cwd', f.target, '--program', counted, '--foreground', '--json']);
    assert.equal(run.status, 0, run.stderr || run.stdout);
    const { runId } = JSON.parse(run.stdout);
    const runDir = join(f.home, 'workflows', runId);
    for (const [marker, expected, rounds] of [
      [{ deliverableGate: 1, proofLabels: 1 }, false, 3],
      [{ deliverableGate: 1, proofLabels: 1, failureRule: 1, reviewPlacement: 'caller' }, true, 3],
    ]) {
      writeFileSync(join(runDir, 'features.json'), `${JSON.stringify(marker)}\n`);
      const plan = join(f.root, `plan-${rounds}.json`);
      const exported = cli(f, ['workflow', 'plan', 'export', runId, '--out', plan]);
      assert.equal(exported.status, 0, exported.stderr);
      const document = JSON.parse(readFileSync(plan, 'utf8'));
      document.program.defaults = { ...(document.program.defaults ?? {}), verifyRounds: rounds };
      delete document.program.verifyRounds;
      writeFileSync(plan, JSON.stringify(document));
      const revised = cli(f, ['workflow', 'plan', 'revise', runId, '--program', plan, '--json']);
      assert.equal(revised.status, 0, revised.stderr || revised.stdout);
      const payload = JSON.parse(revised.stdout);
      assert.equal(payload.status, 'applied', revised.stdout);
      assert.equal(payload.verifyRoundsMeaning === 'fix cycles', expected, JSON.stringify(marker));
      await waitTerminal(f, runId);
    }
  } finally { f.cleanup(); }
});
