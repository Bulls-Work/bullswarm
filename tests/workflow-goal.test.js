import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { extractGoalRequirements, scoutPrompt } from '../src/workflow/goal.js';
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
    '  process.stdout.write(["TREE:\\n- target/", "MANIFEST:\\n- fixture repository", "TEST STATUS:\\n- no test command required", "UNITS OF WORK:\\n- create done.txt and inspect it", "SHARED FILES:\\n- none", "RISKS:\\n- exact byte content must match", "The target is a bounded disposable fixture. ".repeat(8)].join("\\n"));',
    '} else if (task.includes("single logical Workflow Planner for Bullswarm autonomous V2")) {',
    '  process.stdout.write(JSON.stringify({schemaVersion:"bullswarm.workflow.planner-response.v2",kind:"program",summary:"Create the bounded artifact and inspect it independently.",program:{schemaVersion:"bullswarm.workflow.program.v2",actions:[{id:"goal-work",purpose:"Create done artifact",dependsOn:[],affects:["requirement-1"],ownedFiles:["done.txt"],prompt:"Create done.txt containing exactly autonomous-complete followed by a newline, then read it back.",lane:"build",effort:"low",evidenceFor:[],inputs:[],produces:["done-artifact"]},{id:"goal-evidence",purpose:"Inspect done artifact",dependsOn:["goal-work"],affects:[],ownedFiles:[],prompt:"Read done.txt and compare every byte with the required content.",lane:"analyze",effort:"low",evidenceFor:["requirement-1"],inputs:["done-artifact"],produces:[]}]}}));',
    '} else if (task.includes("autonomous V2 evidence action")) {',
    '  const ok = readFileSync("done.txt", "utf8") === "autonomous-complete\\n";',
    '  process.stdout.write(JSON.stringify({schemaVersion:"bullswarm.workflow.evidence.v2",requirements:{"requirement-1":{status:ok?"passed":"failed",evidence:[ok?"done.txt contains the exact autonomous-complete line":"done.txt content mismatch"],concerns:[]}}}));',
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
  assert.match(prompt, /does not require one monolithic action/i);
  assert.match(prompt, /small ordered sequence that reuses the same owned files/i);
});

test('retired autonomous V1 documents and runs fail closed before dispatch', () => {
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
    const direct = cli(f, ['workflow', 'run', legacyPath, '--json']);
    assert.equal(direct.status, 1);
    assert.match(direct.stderr, /retired autonomous V1 workflow documents cannot run/);
    assert.equal(existsSync(join(f.home, 'workflows')), false, 'rejection must not create a paid run');

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

test('capabilities separate autonomous V2 from fixed authored graphs', () => {
  const f = fixture();
  try {
    const result = cli(f, ['workflow', 'capabilities']);
    assert.equal(result.status, 0, result.stderr);
    const capabilities = JSON.parse(result.stdout);
    assert.equal(capabilities.engines.autonomousV2.stateSchema, 'bullswarm.workflow.state.v2');
    assert.equal(capabilities.engines.autonomousV2.completionAuthority, 'kernel requirement ledger');
    assert.equal(capabilities.engines.autonomousV2.features.semanticRepairLoops, false);
    assert.deepEqual(capabilities.engines.autonomousV2.compatibility, {
      resumesAutonomousV1: false, migratesAutonomousV1: false,
    });
    assert.deepEqual(capabilities.engines.authoredGraphs.stepTypes, ['run', 'fanout', 'verify', 'decide']);
  } finally { f.cleanup(); }
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
    const state = JSON.parse(readFileSync(join(f.home, 'workflows', report.runId, 'state.json'), 'utf8'));
    const attempts = [...state.preflight.scout.attempts, ...state.planner.attempts, ...state.attempts];
    assert.ok(attempts.length >= 4);
    for (const attempt of attempts) {
      assert.equal(attempt.pool, 'goal-agent');
      assert.equal(attempt.model, state.planner.attempts.includes(attempt) ? 'planner-sol' : 'worker-luna');
    }
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

test('--no-scout deterministically skips preflight without weakening evidence completion', () => {
  const f = fixture();
  try {
    const result = cli(f, [
      'workflow', 'goal', 'Create and verify done.txt without repository reconnaissance.',
      '--cwd', f.target, '--foreground', '--json', '--no-scout', '--max-agents', '6', '--max-expansion-rounds', '2',
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
      '--cwd', f.target, '--foreground', '--json', '--max-agents', '6', '--max-expansion-rounds', '2',
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
      '--cwd', f.target, '--foreground', '--json', '--max-agents', '8', '--max-expansion-rounds', '2',
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
