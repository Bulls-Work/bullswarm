// Manual, bounded real-provider acceptance matrix for dynamic workflows.
// Not matched by package.json's tests/*.test.js glob; invoke explicitly:
//   node tests/manual-dynamic-real.mjs

import assert from 'node:assert/strict';
import {
  existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync,
  rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runWorkflow } from '../src/workflow/runner.js';
import { requestCancel, dashboardJson } from '../src/workflow/dashboard.js';
import { readEvents } from '../src/workflow/events.js';

const REPO = resolve(fileURLToPath(new URL('..', import.meta.url)));
const opencode = JSON.parse(readFileSync(join(REPO, 'connectors', 'opencode2.json'), 'utf8'));
const realPool = (pace = 0) => ({
  name: opencode.name, connector: opencode, enabled: true,
  costRank: opencode.costRank, lanes: opencode.lanes,
  capabilities: opencode.capabilities, pace,
});

function home(prefix) {
  const root = mkdtempSync(join(tmpdir(), `bullswarm-real-${prefix}-`));
  const bullswarmDir = join(root, '.bullswarm');
  mkdirSync(join(bullswarmDir, 'connectors'), { recursive: true });
  return { root, bullswarmDir, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

const runStep = (id, prompt, extra = {}) => ({
  id, type: 'run', pool: 'opencode2', lane: 'analyze',
  requiresCapabilities: ['code-reading'], addDir: REPO, prompt,
  timeoutSec: 180, ...extra,
});

const decideStep = (prompt, extra = {}) => ({
  id: 'planner', type: 'decide', pool: 'opencode2', lane: 'analyze',
  requiresCapabilities: ['workflow-planning', 'strong-analysis'],
  actionDefaults: {
    pool: 'opencode2', lane: 'analyze', requiresCapabilities: ['code-reading'],
    addDir: REPO, timeoutSec: 180,
  },
  addDir: REPO, prompt, timeoutSec: 180, ...extra,
});

async function caseProceed() {
  const f = home('proceed');
  try {
    const doc = {
      name: 'real-proceed', description: 'real proceed', inputs: {},
      settings: { retryAttempts: 0, maxAgents: 3, maxExpansionRounds: 1, maxActions: 4, maxItemsPerExpansion: 2, maxWorkflowSeconds: 600 },
      phases: [{ name: 'p', steps: [
        runStep('initial', 'Read package.json and report only the package name and Node engine. Do not modify files.'),
        decideStep('Return a valid proceed decision with no actions because this bounded QA must continue to its final static action.'),
        runStep('after-gate', 'Read package.json and explain the test command, what files it covers, and why it remains offline-safe in at least 120 characters. Do not modify files.'),
      ] }],
    };
    const result = await runWorkflow({ bullswarmDir: f.bullswarmDir, doc, pools: [realPool()] });
    assert.equal(result.state.status, 'completed');
    assert.equal(result.state.decisions[0].decision, 'proceed');
    assert.equal(result.state.outputs['after-gate'].ok, true);
    return { runId: result.runId, status: result.state.status };
  } finally { f.cleanup(); }
}

async function caseExpansionFanout() {
  const f = home('expansion-fanout');
  try {
    const doc = {
      name: 'real-expansion-fanout', description: 'real planner-added fanout', inputs: {},
      settings: { retryAttempts: 0, maxAgents: 5, maxExpansionRounds: 1, maxActions: 5, maxItemsPerExpansion: 2, maxWorkflowSeconds: 600 },
      phases: [{ name: 'p', steps: [
        runStep('initial', 'Read package.json and report at least 120 characters of concrete evidence covering the package name, version, Node engine, and test command. Do not modify files.'),
        decideStep('For fanout QA: if inspect-files is succeeded with total 2 and failed 0, return complete. Otherwise return needs_more_work with exactly one action: {"id":"inspect-files","type":"fanout","items":["package.json","README.md"],"stepTemplate":{"prompt":"Read package.json and README.md and return at least 120 characters of concrete evidence. Do not modify files."},"dependsOn":["initial"]}. Never include pool, addDir, or taskFile.'),
      ] }],
    };
    const result = await runWorkflow({ bullswarmDir: f.bullswarmDir, doc, pools: [realPool()] });
    if (result.state.status !== 'completed') {
      throw new Error(`fanout workflow failed: ${JSON.stringify({
        status: result.state.status,
        abortReason: result.state.abortReason,
        planner: result.state.outputs.planner,
        decisions: result.state.decisions,
      })}`);
    }
    assert.deepEqual(result.state.decisions.map((decision) => decision.decision), ['needs_more_work', 'complete']);
    assert.equal(result.state.outputs['inspect-files'].total, 2);
    assert.equal(result.state.outputs['inspect-files'].failed, 0);
    assert.equal(result.state.outputs['inspect-files'].items.every((item) => item.verdict.ok), true);
    return { runId: result.runId, items: result.state.outputs['inspect-files'].total };
  } finally { f.cleanup(); }
}

async function caseRetry() {
  const f = home('retry');
  try {
    const marker = join(f.root, 'retried');
    const wrapper = join(f.root, 'retry-wrapper.mjs');
    writeFileSync(wrapper, [
      'import { existsSync, writeFileSync } from "node:fs";',
      'import { spawnSync } from "node:child_process";',
      `const marker = ${JSON.stringify(marker)};`,
      'if (!existsSync(marker)) { writeFileSync(marker, "1"); process.stdout.write("I will do this later"); process.exit(0); }',
      'const r = spawnSync("opencode", ["run","--auto","--model","relay/gpt-5.6-luna",process.argv[2]], {encoding:"utf8"});',
      'process.stdout.write(r.stdout || r.stderr); process.exit(r.status ?? 1);',
    ].join('\n'));
    const connector = {
      ...opencode, name: 'real-retry',
      spawn: { ...opencode.spawn, cmd: ['node', wrapper, '{taskFile}'] },
    };
    const pool = { name: connector.name, connector, enabled: true, lanes: connector.lanes, capabilities: connector.capabilities, pace: 0 };
    const doc = {
      name: 'real-retry', description: 'real retry', inputs: {},
      settings: { retryAttempts: 1, escalateOnFail: false, maxAgents: 2, maxWorkflowSeconds: 600 },
      phases: [{ name: 'p', steps: [{
        id: 'retry-real', type: 'run', pool: connector.name, lane: 'analyze',
        requiresCapabilities: ['code-reading'], addDir: REPO,
        prompt: 'Read package.json and explain the package name, version, Node engine, and test command with at least 120 characters of exact evidence. Do not modify files.', timeoutSec: 180,
      }] }],
    };
    const result = await runWorkflow({ bullswarmDir: f.bullswarmDir, doc, pools: [pool] });
    assert.equal(result.state.outputs['retry-real'].ok, true);
    assert.deepEqual(result.state.attempts.map((attempt) => attempt.status), ['failed_retryable', 'succeeded']);
    return { runId: result.runId, attempts: result.state.attempts.length };
  } finally { f.cleanup(); }
}

async function caseEscalation() {
  const f = home('escalate');
  try {
    const badWorker = join(f.root, 'bad.mjs');
    writeFileSync(badWorker, 'process.stdout.write("I will investigate this later");\n');
    const bad = {
      name: 'real-bad', spawn: { cmd: ['node', badWorker, '{taskFile}'], cwdMode: 'task-file-dir' },
      authSignatures: [], outputExtraction: { strategy: 'stdout' }, meter: { type: 'none' },
      lanes: ['analyze'], capabilities: ['code-reading'], timeoutSec: 30,
    };
    const doc = {
      name: 'real-escalation', description: 'real alternate', inputs: {},
      settings: { retryAttempts: 0, escalateOnFail: true, maxAgents: 2, maxWorkflowSeconds: 600 },
      phases: [{ name: 'p', steps: [{
        id: 'escalate-real', type: 'run', lane: 'analyze', requiresCapabilities: ['code-reading'],
        addDir: REPO, prompt: 'Read package.json and explain the package name, version, Node engine, and test command with at least 120 characters of exact evidence. Do not modify files.', timeoutSec: 180,
      }] }],
    };
    const pools = [
      { name: bad.name, connector: bad, enabled: true, lanes: bad.lanes, capabilities: bad.capabilities, pace: 10 },
      realPool(0),
    ];
    const result = await runWorkflow({ bullswarmDir: f.bullswarmDir, doc, pools });
    assert.equal(result.state.outputs['escalate-real'].ok, true);
    assert.deepEqual(result.state.attempts.map((attempt) => attempt.pool), ['real-bad', 'opencode2']);
    return { runId: result.runId, pools: result.state.attempts.map((attempt) => attempt.pool) };
  } finally { f.cleanup(); }
}

async function caseBudget() {
  const f = home('budget');
  try {
    const doc = {
      name: 'real-budget', description: 'real expansion budget', inputs: {},
      settings: { retryAttempts: 0, maxAgents: 5, maxExpansionRounds: 1, maxActions: 6, maxItemsPerExpansion: 2, maxWorkflowSeconds: 600 },
      phases: [{ name: 'p', steps: [
        runStep('initial', 'Read package.json and report at least 120 characters of concrete evidence covering the package name, version, Node engine, and test command. Do not modify files.'),
        decideStep('For this advisory-target QA: if budget-one is not succeeded, propose exactly one run action with id budget-one and dependsOn [initial]. If budget-two is not succeeded, propose exactly one essential run action with id budget-two and dependsOn [budget-one], even when the expansion target is reached. After budget-two succeeds, return stop with the useful outcome and no actions. Each action prompt must request at least 120 characters of concrete package.json evidence. Use type, prompt, and dependsOn only; never pool, addDir, or taskFile.'),
      ] }],
    };
    const result = await runWorkflow({ bullswarmDir: f.bullswarmDir, doc, pools: [realPool()] });
    assert.equal(result.state.status, 'completed_with_concerns');
    assert.equal(result.state.outputs['budget-one'].ok, true);
    assert.equal(result.state.outputs['budget-two'].ok, true);
    assert.equal(result.state.budget.expansionOverTargetBy, 1);
    return { runId: result.runId, status: result.state.status };
  } finally { f.cleanup(); }
}

async function caseCancellation() {
  const f = home('cancel');
  try {
    const doc = {
      name: 'real-cancel', description: 'real active cancellation', inputs: {},
      settings: { retryAttempts: 0, maxAgents: 1, maxWorkflowSeconds: 600 },
      phases: [{ name: 'p', steps: [runStep('long-real', 'Inspect every source file and prepare a detailed architecture report. Do not modify files.')] }],
    };
    const promise = runWorkflow({ bullswarmDir: f.bullswarmDir, doc, pools: [realPool()] });
    let runId;
    let active = false;
    for (let i = 0; i < 120 && !active; i++) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
      const workflows = join(f.bullswarmDir, 'workflows');
      if (!existsSync(workflows)) continue;
      runId ??= readdirSync(workflows).find((name) => name.startsWith('wf-'));
      if (!runId) continue;
      try {
        const state = JSON.parse(readFileSync(join(workflows, runId, 'state.json'), 'utf8'));
        active = Object.values(state.activeAgents ?? {}).some((agent) => agent.childPid);
      } catch { /* wait for a complete state write */ }
    }
    assert.equal(active, true);
    requestCancel(f.bullswarmDir, runId);
    const result = await promise;
    assert.equal(result.state.status, 'cancelled');
    assert.equal(result.state.attempts[0].status, 'cancelled');
    assert.ok(result.state.cancellationLatencyMs >= 0);
    return { runId: result.runId, status: result.state.status, latencyMs: result.state.cancellationLatencyMs };
  } finally { f.cleanup(); }
}

async function caseResume() {
  const f = home('resume');
  try {
    const doc = {
      name: 'real-resume', description: 'real partial expansion resume', inputs: {},
      settings: { retryAttempts: 0, maxAgents: 6, maxExpansionRounds: 2, maxActions: 6, maxItemsPerExpansion: 3, maxWorkflowSeconds: 900 },
      phases: [{ name: 'p', steps: [
        runStep('initial', 'Read package.json and report the package name. Do not modify files.'),
        decideStep('For resume QA: if resume-two is succeeded, return complete. Otherwise return needs_more_work with exactly these action shapes, preserving both id fields: [{"id":"resume-one","type":"run","prompt":"Read package.json and return at least 120 characters of exact evidence without modifying files.","dependsOn":["initial"]},{"id":"resume-two","type":"run","prompt":"Read package.json and return at least 120 characters of different exact evidence without modifying files.","dependsOn":["resume-one"]}]. Never omit id. Never include pool, addDir, or taskFile.'),
      ] }],
    };
    const interrupted = await runWorkflow({
      bullswarmDir: f.bullswarmDir, doc, pools: [realPool()],
      onEvent: (event) => {
        if (event.type === 'artifact.published' && event.actionId === 'resume-one') {
          throw new Error('synthetic runner interruption after durable real-provider artifact');
        }
      },
    });
    if (!interrupted.state.outputs['resume-one']) {
      throw new Error(`resume planner did not create resume-one: ${JSON.stringify({
        status: interrupted.state.status,
        planner: interrupted.state.outputs.planner,
        decisions: interrupted.state.decisions,
      })}`);
    }
    assert.equal(interrupted.state.outputs['resume-one'].ok, true);
    assert.equal(interrupted.state.outputs['resume-two'], undefined);
    const resumed = await runWorkflow({
      bullswarmDir: f.bullswarmDir, doc, pools: [realPool()], resumeRunId: interrupted.runId,
    });
    assert.equal(resumed.state.status, 'completed');
    assert.equal(resumed.state.outputs['resume-two'].ok, true);
    assert.equal(resumed.state.attempts.filter((attempt) => attempt.actionId === 'resume-one').length, 1);
    const jsonView = dashboardJson(f.bullswarmDir, { token: resumed.runId });
    assert.deepEqual(jsonView.events, readEvents(resumed.runDir));
    return { runId: resumed.runId, resumed: true, lastEventSequence: resumed.report.lastEventSequence };
  } finally { f.cleanup(); }
}

const results = {};
const selected = new Set(process.argv.slice(2));
for (const [name, fn] of [
  ['proceed', caseProceed],
  ['expansion-fanout', caseExpansionFanout],
  ['retry', caseRetry],
  ['escalation', caseEscalation],
  ['budget', caseBudget],
  ['cancellation', caseCancellation],
  ['resume', caseResume],
]) {
  if (selected.size && !selected.has(name)) continue;
  process.stderr.write(`[real-qa] ${name}\n`);
  results[name] = await fn();
}
process.stdout.write(`${JSON.stringify({ ok: true, provider: 'opencode2', model: 'relay/gpt-5.6-luna', results }, null, 2)}\n`);
