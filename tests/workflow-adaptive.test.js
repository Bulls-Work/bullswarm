import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { completionEvidenceGaps, runWorkflow } from '../src/workflow/runner.js';
import { readEvents } from '../src/workflow/events.js';
import {
  validateDecisionProposal, normalizeDecisionProposal, DecisionValidationError,
} from '../src/workflow/decision.js';
import { requestCancel } from '../src/workflow/dashboard.js';
import { validateWorkflow } from '../src/workflow/validate.js';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'bullswarm-adaptive-'));
  const bullswarmDir = join(root, '.bullswarm');
  mkdirSync(join(bullswarmDir, 'connectors'), { recursive: true });
  const worker = join(root, 'worker.mjs');
  writeFileSync(worker, [
    'import { readFileSync } from "node:fs";',
    'const task = readFileSync(process.argv[2], "utf8");',
    'if (task.includes("BEGIN DURABLE WORKFLOW CONTEXT")) {',
    '  let answer;',
    '  if (task.includes("FORCE_STOP")) {',
    '    answer = {schemaVersion:"bullswarm.workflow.decision.v1",decision:"stop",reason:"A terminal semantic blocker prevents safe completion.",actions:[]};',
    '  } else if (task.includes("FORCE_WAIT")) {',
    '    answer = {schemaVersion:"bullswarm.workflow.decision.v1",decision:"wait_for_approval",reason:"A human must approve the bounded next stage.",actions:[]};',
    '  } else if (task.includes("FORCE_PROCEED")) {',
    '    answer = {schemaVersion:"bullswarm.workflow.decision.v1",decision:"proceed",reason:"The existing evidence is sufficient to proceed to the remaining static action.",actions:[]};',
    '  } else if (task.includes("FORCE_FANOUT")) {',
    '    const done = task.includes("expanded-fanout") && task.includes("succeeded");',
    '    answer = done',
    '      ? {schemaVersion:"bullswarm.workflow.decision.v1",decision:"complete",reason:"The bounded fan-out completed successfully with both item artifacts.",actions:[]}',
    '      : {schemaVersion:"bullswarm.workflow.decision.v1",decision:"needs_more_work",reason:"Two bounded item checks are required before completion.",actions:[{id:"expanded-fanout",type:"fanout",items:["alpha","beta"],stepTemplate:{prompt:"Inspect {{item}} and return concrete evidence for this bounded item."},dependsOn:["initial"]}]};',
    '  } else if (task.includes("FORCE_BUDGET")) {',
    '    const firstDone = task.includes("budget-one") && task.includes("succeeded");',
    '    const id = firstDone ? "budget-two" : "budget-one";',
    '    answer = {schemaVersion:"bullswarm.workflow.decision.v1",decision:"needs_more_work",reason:"Another bounded budget test action is required to prove the expansion ceiling.",actions:[{id,type:"run",prompt:"Perform a concrete bounded budget action with durable evidence.",dependsOn:[firstDone?"budget-one":"initial"]}]};',
    '  } else if (task.includes("CRASH_RESUME")) {',
    '    const done = task.includes("resume-two") && task.includes("succeeded");',
    '    answer = done',
    '      ? {schemaVersion:"bullswarm.workflow.decision.v1",decision:"complete",reason:"Both accepted expansion actions are now durably complete after resume.",actions:[]}',
    '      : {schemaVersion:"bullswarm.workflow.decision.v1",decision:"needs_more_work",reason:"Two ordered bounded actions are required to prove crash-safe expansion resume.",actions:[{id:"resume-one",type:"run",prompt:"Complete first durable resume action with concrete evidence.",dependsOn:["initial"]},{id:"resume-two",type:"run",prompt:"Complete second durable resume action with concrete evidence.",dependsOn:["resume-one"]}]};',
    '  } else {',
    '    const expandedDone = task.includes("expanded-task") && task.includes("succeeded");',
    '    answer = expandedDone',
    '      ? {schemaVersion:"bullswarm.workflow.decision.v1",decision:"complete",reason:"Expanded evidence now proves the requested work is complete and verified.",actions:[]}',
    '      : {schemaVersion:"bullswarm.workflow.decision.v1",decision:"needs_more_work",reason:"The initial result lacks one bounded follow-up investigation needed for sufficient evidence.",actions:[{id:"expanded-task",type:"run",lane:"analyze",prompt:"Perform the bounded expanded investigation and report concrete evidence.",dependsOn:["initial"]}]};',
    '  }',
    '  process.stdout.write(JSON.stringify(answer));',
    '} else {',
    '  process.stdout.write("Completed the bounded action with concrete evidence, file inspection details, and a sufficiently thorough result for downstream verification.");',
    '}',
  ].join('\n'));
  const connector = {
    name: 'adaptive-echo', bin: 'node', configDirs: [],
    spawn: { cmd: ['node', worker, '{taskFile}'], cwdMode: 'task-file-dir' },
    authSignatures: [], outputExtraction: { strategy: 'stdout' },
    meter: { type: 'none' }, costRank: 1, lanes: ['analyze', 'build', 'chore'],
    capabilities: ['strong-analysis', 'workflow-planning', 'code-reading'], timeoutSec: 60,
  };
  return {
    root, bullswarmDir,
    pools: [{ name: connector.name, connector, enabled: true, costRank: 1, lanes: connector.lanes, capabilities: connector.capabilities, pace: 0 }],
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

test('adaptive planner appends a bounded action, executes it, then replans to complete', async () => {
  const f = fixture();
  try {
    let activeDynamicStep = null;
    const doc = {
      name: 'adaptive-loop', description: 'observe plan execute loop', inputs: {},
      settings: { concurrency: 1, retryAttempts: 0, maxAgents: 6, maxExpansionRounds: 2, maxActions: 8, maxItemsPerExpansion: 4 },
      phases: [{ name: 'work', steps: [
        { id: 'initial', type: 'run', lane: 'analyze', prompt: 'Perform the initial bounded investigation.' },
        { id: 'planner', type: 'decide', lane: 'analyze', prompt: 'Judge sufficiency and propose only necessary bounded work.' },
      ] }],
    };
    const result = await runWorkflow({
      bullswarmDir: f.bullswarmDir, doc, pools: f.pools, inputs: {},
      onEvent: (event) => {
        if (event.type !== 'action.started' || event.actionId !== 'expanded-task') return;
        const runId = readdirSync(join(f.bullswarmDir, 'workflows'))[0];
        const live = JSON.parse(readFileSync(join(f.bullswarmDir, 'workflows', runId, 'state.json'), 'utf8'));
        activeDynamicStep = live.currentStep;
      },
    });
    assert.equal(result.state.status, 'completed');
    assert.equal(result.state.outputs['expanded-task'].ok, true);
    assert.deepEqual(result.state.decisions.map((decision) => decision.decision), ['needs_more_work', 'complete']);
    assert.equal(result.state.plan.version, 2);
    assert.equal(result.state.budget.expansionRound, 1);
    assert.ok(result.state.attempts.length >= 4);
    assert.ok(result.state.attempts.every((attempt) => attempt.taskFile && attempt.outFile && attempt.status === 'succeeded'));
    assert.deepEqual(activeDynamicStep, {
      id: 'expanded-task', type: 'run', phase: 'work:adaptive',
    });

    const events = readEvents(result.runDir);
    assert.deepEqual(events.map((event) => event.sequence), events.map((_, index) => index + 1));
    assert.ok(events.some((event) => event.type === 'plan.updated'));
    assert.equal(events.filter((event) => event.type === 'decision.created').length, 2);
    assert.equal(events.at(-1).type, 'run.completed');
    assert.equal(result.report.lastEventSequence, events.at(-1).sequence);

    const plannerTasks = readdirSync(result.runDir)
      .filter((name) => name.startsWith('task-planner-'))
      .map((name) => readFileSync(join(result.runDir, name), 'utf8'));
    assert.ok(plannerTasks.length >= 2);
    assert.ok(plannerTasks.every((task) => task.includes('"actionTimeoutSec": null')));
    assert.ok(plannerTasks.every((task) => task.includes('"verificationDispatchReserve": 0')));
    assert.ok(plannerTasks.every((task) => task.includes('The dispatch budget counts this planner call plus every worker, verifier, retry, and escalation attempt.')));
  } finally { f.cleanup(); }
});

test('adaptive planner can append and complete a bounded fan-out', async () => {
  const f = fixture();
  try {
    const doc = {
      name: 'adaptive-fanout', description: 'planner-added fanout', inputs: {},
      settings: { concurrency: 2, retryAttempts: 0, maxAgents: 5, maxExpansionRounds: 1, maxActions: 5, maxItemsPerExpansion: 2 },
      phases: [{ name: 'work', steps: [
        { id: 'initial', type: 'run', prompt: 'Perform the initial bounded investigation.' },
        { id: 'planner', type: 'decide', prompt: 'FORCE_FANOUT' },
      ] }],
    };
    const result = await runWorkflow({ bullswarmDir: f.bullswarmDir, doc, pools: f.pools, inputs: {} });
    assert.equal(result.state.status, 'completed');
    assert.deepEqual(result.state.decisions.map((decision) => decision.decision), ['needs_more_work', 'complete']);
    assert.equal(result.state.outputs['expanded-fanout'].total, 2);
    assert.equal(result.state.outputs['expanded-fanout'].failed, 0);
    assert.deepEqual(result.state.outputs['expanded-fanout'].items.map((entry) => entry.item), ['alpha', 'beta']);
  } finally { f.cleanup(); }
});

test('malformed or over-budget planner proposals are rejected before dispatch', () => {
  assert.throws(() => validateDecisionProposal({
    schemaVersion: 'bullswarm.workflow.decision.v1',
    decision: 'needs_more_work', reason: 'too much',
    actions: [{ id: 'unsafe', type: 'shell', prompt: 'rm', dependsOn: [] }],
  }, { maxActions: 2, maxItemsPerExpansion: 1 }), DecisionValidationError);

  assert.throws(() => validateDecisionProposal({
    schemaVersion: 'bullswarm.workflow.decision.v1',
    decision: 'needs_more_work', reason: 'too many items',
    actions: [{ id: 'wide', type: 'fanout', items: [1, 2], stepTemplate: { prompt: '{{item}}' } }],
  }, { maxActions: 2, maxItemsPerExpansion: 1 }), /maxItemsPerExpansion/);
});

test('single-dependency verify proposals infer the durable review artifact', () => {
  const normalized = normalizeDecisionProposal({
    schemaVersion: 'bullswarm.workflow.decision.v1',
    decision: 'needs_more_work', reason: 'independent verification is required',
    actions: [{ id: 'verify-fix', type: 'verify', prompt: 'Run the acceptance checks.', dependsOn: ['fix'] }],
  });
  assert.equal(normalized.actions[0].review, 'outputs.fix.outFile');
  assert.doesNotThrow(() => validateDecisionProposal(normalized, {
    knownActionIds: ['fix'], currentActionCount: 1,
  }));
});

test('planner proceed continues to later static work without graph expansion', async () => {
  const f = fixture();
  try {
    const doc = {
      name: 'adaptive-proceed', description: 'proceed', inputs: {},
      settings: { retryAttempts: 0, maxExpansionRounds: 1 },
      phases: [{ name: 'p', steps: [
        { id: 'initial', type: 'run', prompt: 'Initial evidence.' },
        { id: 'planner', type: 'decide', prompt: 'FORCE_PROCEED' },
        { id: 'after-gate', type: 'run', prompt: 'Complete later static work.' },
      ] }],
    };
    const result = await runWorkflow({ bullswarmDir: f.bullswarmDir, doc, pools: f.pools, inputs: {} });
    assert.equal(result.state.status, 'completed');
    assert.equal(result.state.outputs['after-gate'].ok, true);
    assert.equal(result.state.budget.expansionRound, 0);
  } finally { f.cleanup(); }
});

test('planner stop and wait_for_approval produce distinct truthful terminal states', async () => {
  for (const [marker, expected] of [['FORCE_STOP', 'failed'], ['FORCE_WAIT', 'waiting_for_approval']]) {
    const f = fixture();
    try {
      const doc = {
        name: `adaptive-${expected.replaceAll('_', '-')}`, description: 'terminal decisions', inputs: {},
        settings: { retryAttempts: 0, maxExpansionRounds: 1 },
        phases: [{ name: 'p', steps: [
          { id: 'initial', type: 'run', prompt: 'Initial evidence.' },
          { id: 'planner', type: 'decide', prompt: marker },
        ] }],
      };
      const result = await runWorkflow({ bullswarmDir: f.bullswarmDir, doc, pools: f.pools, inputs: {} });
      assert.equal(result.state.status, expected);
      if (expected === 'waiting_for_approval') {
        assert.equal(result.state.finishedAt, undefined);
        assert.equal(result.state.actionLedger.find((action) => action.id === 'planner').status, 'waiting_for_approval');
      }
    } finally { f.cleanup(); }
  }
});

test('expansion-round budget stops a valid second expansion before dispatch', async () => {
  const f = fixture();
  try {
    const doc = {
      name: 'adaptive-budget', description: 'budget', inputs: {},
      settings: { retryAttempts: 0, maxAgents: 8, maxExpansionRounds: 1, maxActions: 8, maxItemsPerExpansion: 4 },
      phases: [{ name: 'p', steps: [
        { id: 'initial', type: 'run', prompt: 'Initial evidence.' },
        { id: 'planner', type: 'decide', prompt: 'FORCE_BUDGET' },
      ] }],
    };
    const result = await runWorkflow({ bullswarmDir: f.bullswarmDir, doc, pools: f.pools, inputs: {} });
    assert.equal(result.state.status, 'budget_exhausted');
    assert.equal(result.state.outputs['budget-one'].ok, true);
    assert.equal(result.state.outputs['budget-two'], undefined);
    assert.match(result.state.outputs.planner.why, /maxExpansionRounds=1/);
  } finally { f.cleanup(); }
});

test('resume executes only unfinished accepted expansion actions, then replans', async () => {
  const f = fixture();
  try {
    const doc = {
      name: 'adaptive-resume', description: 'resume', inputs: {},
      settings: { retryAttempts: 0, maxAgents: 8, maxExpansionRounds: 2, maxActions: 8, maxItemsPerExpansion: 4 },
      phases: [{ name: 'p', steps: [
        { id: 'initial', type: 'run', prompt: 'Initial evidence.' },
        { id: 'planner', type: 'decide', prompt: 'CRASH_RESUME' },
      ] }],
    };
    const interrupted = await runWorkflow({
      bullswarmDir: f.bullswarmDir, doc, pools: f.pools, inputs: {},
      onEvent: (event) => {
        if (event.type === 'artifact.published' && event.actionId === 'resume-one') {
          throw new Error('synthetic runner interruption after first expanded artifact');
        }
      },
    });
    const crashedRunId = interrupted.runId;
    const before = JSON.parse(readFileSync(join(f.bullswarmDir, 'workflows', crashedRunId, 'state.json'), 'utf8'));
    assert.equal(before.outputs['resume-one'].ok, true);
    assert.equal(before.outputs['resume-two'], undefined);

    const resumedPools = f.pools.map((pool) => ({
      ...pool,
      strategyAssignments: { high: { pool: 'adaptive-echo', model: 'adaptive-v2' } },
    }));
    const resumed = await runWorkflow({
      bullswarmDir: f.bullswarmDir, doc, pools: resumedPools, inputs: {}, resumeRunId: crashedRunId,
    });
    assert.equal(resumed.state.status, 'completed');
    assert.equal(resumed.state.outputs['resume-two'].ok, true);
    assert.equal(resumed.state.attempts.filter((attempt) => attempt.actionId === 'resume-one').length, 1);
    assert.equal(resumed.state.decisions.at(-1).decision, 'complete');
    assert.deepEqual(resumed.state.routingStrategy.assignments, {
      high: { pool: 'adaptive-echo', model: 'adaptive-v2' },
    });
    assert.deepEqual(resumed.state.routingStrategy.history.map((entry) => entry.reason), ['run-start', 'resume']);
    assert.deepEqual(resumed.report.routingStrategy, resumed.state.routingStrategy);
  } finally { f.cleanup(); }
});

test('capability requirements fail closed without dispatching a weaker pool', async () => {
  const f = fixture();
  try {
    const doc = {
      name: 'capability-closed', description: 'capability', inputs: {},
      settings: { retryAttempts: 0 },
      phases: [{ name: 'p', steps: [{
        id: 'browser-task', type: 'run', prompt: 'Use a browser.', requiresCapabilities: ['browser-use'],
      }] }],
    };
    const result = await runWorkflow({ bullswarmDir: f.bullswarmDir, doc, pools: f.pools, inputs: {} });
    assert.equal(result.state.outputs['browser-task'].ok, false);
    assert.match(result.state.outputs['browser-task'].why, /no eligible pool.*browser-use/);
    assert.equal(result.state.attempts.length, 0);
  } finally { f.cleanup(); }
});

test('retryAttempts zero still permits exactly one capable alternate-pool escalation', async () => {
  const f = fixture();
  try {
    const badWorker = join(f.root, 'bad.mjs');
    writeFileSync(badWorker, 'process.stdout.write("I will investigate this later");\n');
    const badConnector = {
      name: 'bad', spawn: { cmd: ['node', badWorker, '{taskFile}'], cwdMode: 'task-file-dir' },
      authSignatures: [], outputExtraction: { strategy: 'stdout' }, meter: { type: 'none' },
      lanes: ['analyze'], capabilities: ['code-reading'], timeoutSec: 30,
    };
    const pools = [
      { name: 'bad', connector: badConnector, enabled: true, lanes: ['analyze'], capabilities: ['code-reading'], pace: 10 },
      { ...f.pools[0], pace: 0 },
    ];
    const doc = {
      name: 'capable-escalation', description: 'escalate', inputs: {},
      settings: { retryAttempts: 0, escalateOnFail: true },
      phases: [{ name: 'p', steps: [{
        id: 'inspect', type: 'run', lane: 'analyze', prompt: 'Inspect with evidence.', requiresCapabilities: ['code-reading'],
      }] }],
    };
    const result = await runWorkflow({ bullswarmDir: f.bullswarmDir, doc, pools, inputs: {} });
    assert.equal(result.state.outputs.inspect.ok, true);
    assert.deepEqual(result.state.attempts.map((attempt) => attempt.pool), ['bad', 'adaptive-echo']);
    const action = result.state.actionLedger.find((entry) => entry.id === 'inspect');
    assert.equal(action.status, 'succeeded');
    assert.equal(action.why, undefined);
  } finally { f.cleanup(); }
});

test('decide steps require an explicit positive expansion-round budget', () => {
  assert.throws(() => validateWorkflow({
    name: 'missing-budget', description: 'invalid adaptive workflow', inputs: {},
    phases: [{ name: 'p', steps: [{ id: 'planner', type: 'decide' }] }],
  }), (err) => err.issues?.some((issue) => issue.includes('maxExpansionRounds')));
});

test('maxActions cannot be lower than the initial durable plan', () => {
  assert.throws(() => validateWorkflow({
    name: 'undersized-plan', description: 'invalid action budget', inputs: {}, settings: { maxActions: 1 },
    phases: [{ name: 'p', steps: [
      { id: 'one', type: 'run', prompt: 'one' },
      { id: 'two', type: 'run', prompt: 'two' },
    ] }],
  }), (err) => err.issues?.some((issue) => issue.includes('below the 2 initial actions')));
});

test('completion requires verification of the latest successful worker', () => {
  const actions = [
    { id: 'audit', kind: 'run', status: 'succeeded', dependsOn: [] },
    { id: 'audit-verify', kind: 'verify', status: 'succeeded', dependsOn: ['audit'] },
    { id: 'implementation', kind: 'run', status: 'succeeded', dependsOn: ['audit-verify'] },
  ];
  const policy = { requireSuccessfulWorker: true, requireSuccessfulVerification: true };
  assert.deepEqual(completionEvidenceGaps(actions, policy), [
    'a successful verification of latest worker implementation',
  ]);
  actions.push({ id: 'implementation-verify', kind: 'verify', status: 'succeeded', dependsOn: ['implementation'] });
  assert.deepEqual(completionEvidenceGaps(actions, policy), []);
});

test('events reader returns only records after a sequence cursor', async () => {
  const f = fixture();
  try {
    const doc = {
      name: 'event-static', description: 'events', inputs: {},
      settings: { retryAttempts: 0 },
      phases: [{ name: 'p', steps: [{ id: 'one', type: 'run', prompt: 'Do one bounded task.' }] }],
    };
    const result = await runWorkflow({ bullswarmDir: f.bullswarmDir, doc, pools: f.pools, inputs: {} });
    const all = readEvents(result.runDir);
    const after = readEvents(result.runDir, { after: 3 });
    assert.deepEqual(after, all.filter((event) => event.sequence > 3));
    assert.ok(readFileSync(join(result.runDir, 'events.jsonl'), 'utf8').endsWith('\n'));
  } finally { f.cleanup(); }
});

test('cancellation terminates an active child and leaves a truthful terminal attempt', async () => {
  const root = mkdtempSync(join(tmpdir(), 'bullswarm-cancel-'));
  const bullswarmDir = join(root, '.bullswarm');
  mkdirSync(join(bullswarmDir, 'connectors'), { recursive: true });
  const worker = join(root, 'slow.mjs');
  writeFileSync(worker, 'setTimeout(() => process.stdout.write("This should not finish because cancellation terminates the active child process cleanly."), 10000);\n');
  const connector = {
    name: 'slow', spawn: { cmd: ['node', worker, '{taskFile}'], cwdMode: 'task-file-dir' },
    authSignatures: [], outputExtraction: { strategy: 'stdout' }, meter: { type: 'none' },
    lanes: ['chore'], capabilities: [], timeoutSec: 30,
  };
  try {
    const runPromise = runWorkflow({
      bullswarmDir,
      doc: { name: 'cancel-active', description: 'cancel', inputs: {}, phases: [{ name: 'p', steps: [{ id: 'slow-action', type: 'run', lane: 'chore', prompt: 'Wait.' }] }] },
      pools: [{ name: 'slow', connector, enabled: true, lanes: ['chore'], capabilities: [], pace: 0 }], inputs: {},
    });
    let token = null;
    let active = false;
    for (let i = 0; i < 80 && !active; i++) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      const workflows = join(bullswarmDir, 'workflows');
      try {
        token = readdirSync(workflows).find((name) => name.startsWith('wf-')) ?? null;
        if (token) {
          const state = JSON.parse(readFileSync(join(workflows, token, 'state.json'), 'utf8'));
          active = Object.values(state.activeAgents ?? {}).some((agent) => agent.childPid);
        }
      } catch { /* runner has not created the directory yet */ }
    }
    assert.ok(token);
    assert.equal(active, true);
    requestCancel(bullswarmDir, token);
    const result = await runPromise;
    assert.equal(result.state.status, 'cancelled');
    assert.equal(result.state.attempts[0].status, 'cancelled');
    assert.ok(result.state.attempts[0].childPid);
    assert.ok(result.state.attempts[0].childTerminatedAt);
    assert.ok(readEvents(result.runDir).some((event) => event.type === 'attempt.process_terminated'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
