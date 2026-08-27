import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildGoalWorkflow, AUTONOMOUS_ORCHESTRATOR_PROMPT } from '../src/workflow/goal.js';
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
    'if (task.includes("BEGIN DURABLE WORKFLOW CONTEXT")) {',
    '  const done = task.includes("goal-verify") && task.includes("succeeded");',
    '  const premature = task.includes("PREMATURE_COMPLETION") && !task.includes("goal-work") && !task.includes("autonomous completion rejected");',
    '  const answer = premature',
    '    ? {schemaVersion:"bullswarm.workflow.decision.v1",decision:"complete",reason:"Claiming completion before any evidence for policy testing.",actions:[]}',
    '    : done',
    '      ? {schemaVersion:"bullswarm.workflow.decision.v1",decision:"complete",reason:"The worker artifact and concrete acceptance evidence prove the autonomous goal is complete.",actions:[]}',
    '      : {schemaVersion:"bullswarm.workflow.decision.v1",decision:"needs_more_work",reason:"One bounded implementation action and an independent verification are required.",actions:[{id:"goal-work",type:"run",prompt:"Create done.txt containing autonomous-complete, then read it back and report the exact path and contents as verification evidence.",dependsOn:[]},{id:"goal-verify",type:"verify",prompt:"Independently verify done.txt exists with the exact expected contents.",dependsOn:["goal-work"]}]};',
    '  process.stdout.write(JSON.stringify(answer));',
    '} else if (task.includes("RETURN ONLY a single JSON object")) {',
    '  const ok = readFileSync("done.txt", "utf8") === "autonomous-complete\\n";',
    '  process.stdout.write(JSON.stringify({ok,concerns:ok?[]:["wrong contents"],summary:ok?"Independent verification read done.txt from the target directory, compared every byte with the expected autonomous-complete line, and confirmed the durable artifact exactly satisfies acceptance.":"Independent verification found that done.txt does not contain the exact expected autonomous-complete line, so acceptance is not satisfied."}));',
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
    cwd: REPO,
    name: 'autonomous-test',
  });
  assert.equal(doc.intent.autonomous, true);
  assert.equal(doc.intent.requestedOrchestrator, 'auto');
  assert.equal(doc.phases.length, 1);
  assert.equal(doc.phases[0].steps.length, 1);
  assert.equal(doc.phases[0].steps[0].type, 'decide');
  assert.equal(doc.phases[0].steps[0].pool, undefined);
  assert.equal(doc.phases[0].steps[0].prompt, `${AUTONOMOUS_ORCHESTRATOR_PROMPT}\n\nWorktree isolation policy: agent decides whether isolation is useful; do not introduce a worktree for routine sequential work.`);
  assert.equal(doc.intent.worktreeIsolation, 'agent-decides');
  assert.deepEqual(doc.orchestration.completionPolicy, {
    requireSuccessfulWorker: true,
    requireSuccessfulVerification: true,
  });
  assert.doesNotThrow(() => validateWorkflow(doc, { poolNames: ['goal-agent'] }));
});

test('one foreground CLI goal autonomously plans, routes, executes, verifies, and completes', () => {
  const f = fixture();
  try {
    const result = cli(f, [
      'workflow', 'goal', 'Create and verify done.txt without asking for a workflow document.',
      '--cwd', f.target, '--json', '--max-agents', '6', '--max-expansion-rounds', '2',
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
    const firstPlannerTask = readFileSync(report.attempts[0].taskFile, 'utf8');
    assert.match(firstPlannerTask, /"actionTimeoutSec": 900/);
    assert.match(firstPlannerTask, /"verificationDispatchReserve": 1/);
    assert.match(firstPlannerTask, /Do not consume executionConstraints\.verificationDispatchReserve with implementation work/);

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
      '--cwd', f.target, '--json', '--max-agents', '8', '--max-expansion-rounds', '2',
    ]);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const report = JSON.parse(result.stdout);
    assert.equal(report.status, 'completed');
    assert.deepEqual(report.decisions.map((decision) => decision.decision), ['complete', 'needs_more_work', 'complete']);
    assert.equal(report.decisions[0].accepted, false);
    assert.match(report.decisions[0].rejectionReason, /successful worker action.*successful verification action/);
    assert.equal(report.decisions.at(-1).accepted, true);
  } finally { f.cleanup(); }
});

test('detached CLI goal survives the initiating CLI and remains observable', async () => {
  const f = fixture();
  try {
    const launchResult = cli(f, [
      'workflow', 'goal', 'Create and verify done.txt in a detached autonomous run.',
      '--cwd', f.target, '--detach', '--json', '--max-agents', '6', '--max-expansion-rounds', '2',
    ]);
    assert.equal(launchResult.status, 0, launchResult.stderr || launchResult.stdout);
    const launch = JSON.parse(launchResult.stdout);
    assert.equal(launch.action, 'goal-launched');
    assert.match(launch.runId, /^wf-/);

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
