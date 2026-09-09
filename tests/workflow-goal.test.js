import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { extractGoalRequirements, extractScoutUnitIds, scoutPrompt } from '../src/workflow/goal.js';
import { extractV2GoalConstraints, shouldAutoWatchGoal } from '../src/workflow/cli.js';

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
