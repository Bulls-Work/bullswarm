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
import { queueSteering } from '../src/workflow/steering.js';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'bullswarm-adaptive-'));
  const bullswarmDir = join(root, '.bullswarm');
  mkdirSync(join(bullswarmDir, 'connectors'), { recursive: true });
  const worker = join(root, 'worker.mjs');
  writeFileSync(worker, [
    'import { readFileSync } from "node:fs";',
    'const task = readFileSync(process.argv[2], "utf8");',
    'const garbagePlanner = process.argv[3] === "always-garbage-planner";',
    'if (task.includes("BEGIN DURABLE WORKFLOW CONTEXT")) {',
    '  let answer;',
    '  if (garbagePlanner || task.includes("FORCE_GARBAGE")) {',
    '    answer = "__GARBAGE__";',
    '  } else if (task.includes("FORCE_INVALID_ONCE")) {',
    '    const corrected = task.includes("CORRECTION REQUIRED");',
    '    const fixedDone = task.includes("corrected-task") && task.includes("succeeded");',
    '    answer = fixedDone',
    '      ? {schemaVersion:"bullswarm.workflow.decision.v1",decision:"complete",reason:"The corrected bounded action completed with durable evidence.",actions:[]}',
    '      : corrected',
    '        ? {schemaVersion:"bullswarm.workflow.decision.v1",decision:"needs_more_work",reason:"Corrected proposal: one bounded run action with every required field.",actions:[{id:"corrected-task",type:"run",phase:"correct",prompt:"Perform the corrected bounded action and report concrete evidence.",dependsOn:["initial"]}]}',
    '        : {schemaVersion:"bullswarm.workflow.decision.v1",decision:"needs_more_work",reason:"A per-item check is required before completion.",actions:[{id:"bad-fanout",type:"fanout",phase:"inspect",items:["alpha"],dependsOn:["initial"]}]};',
    '  } else if (task.includes("FORCE_PARALLEL")) {',
    '    const done = ["fix-a","fix-b","fix-c","check-a","check-b","check-c"].every((id) => task.includes(`"${id}"`) && task.includes("succeeded"));',
    '    answer = done',
    '      ? {schemaVersion:"bullswarm.workflow.decision.v1",decision:"complete",reason:"All three fix/check chains completed with durable evidence.",actions:[]}',
    '      : {schemaVersion:"bullswarm.workflow.decision.v1",decision:"needs_more_work",reason:"Three independent items each need a fix and its own check; the graph is proposed in one decision.",actions:[',
    '          {id:"fix-a",type:"run",phase:"fix",prompt:"SLEEP_300 Fix item a in its own file only and report the concrete evidence and diff summary.",dependsOn:["initial"]},',
    '          {id:"fix-b",type:"run",phase:"fix",prompt:"SLEEP_1200 Fix item b in its own file only and report the concrete evidence and diff summary.",dependsOn:["initial"]},',
    '          {id:"fix-c",type:"run",phase:"fix",prompt:"SLEEP_1200 Fix item c in its own file only and report the concrete evidence and diff summary.",dependsOn:["initial"]},',
    '          {id:"check-a",type:"run",phase:"check",prompt:"SLEEP_100 Re-run the item a tests and report pass or fail with evidence.",dependsOn:["fix-a"]},',
    '          {id:"check-b",type:"run",phase:"check",prompt:"SLEEP_100 Re-run the item b tests and report pass or fail with evidence.",dependsOn:["fix-b"]},',
    '          {id:"check-c",type:"run",phase:"check",prompt:"SLEEP_100 Re-run the item c tests and report pass or fail with evidence.",dependsOn:["fix-c"]}]};',
    '  } else if (task.includes("FORCE_STOP")) {',
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
    '    const secondDone = task.includes("budget-two") && task.includes("succeeded");',
    '    const id = firstDone ? "budget-two" : "budget-one";',
    '    answer = secondDone',
    '      ? {schemaVersion:"bullswarm.workflow.decision.v1",decision:"stop",reason:"The advisory expansion target was exceeded; return the useful bounded outcome now without optional work.",actions:[]}',
    '      : {schemaVersion:"bullswarm.workflow.decision.v1",decision:"needs_more_work",reason:"Another bounded budget test action is essential to avoid discarding useful work.",actions:[{id,type:"run",prompt:"Perform a concrete bounded budget action with durable evidence.",dependsOn:[firstDone?"budget-one":"initial"]}]};',
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
    '  process.stdout.write(answer === "__GARBAGE__"',
    '    ? "I believe the next step should be to run the full test suite and inspect the failing modules, but I cannot express that as the requested decision object right now; please advise on the expected shape."',
    '    : JSON.stringify(answer));',
    '} else {',
    '  const sleep = /SLEEP_(\\d+)/.exec(task);',
    '  if (sleep) await new Promise((resolve) => setTimeout(resolve, Number(sleep[1])));',
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
  const garbageConnector = {
    ...connector,
    name: 'adaptive-garbage',
    spawn: { cmd: ['node', worker, '{taskFile}', 'always-garbage-planner'], cwdMode: 'task-file-dir' },
  };
  return {
    root, bullswarmDir,
    pools: [{ name: connector.name, connector, enabled: true, costRank: 1, lanes: connector.lanes, capabilities: connector.capabilities, pace: 0 }],
    garbagePool: { name: garbageConnector.name, connector: garbageConnector, enabled: true, costRank: 1, lanes: connector.lanes, capabilities: connector.capabilities, pace: 0 },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function adaptiveDoc(marker, settings = {}) {
  return {
    name: 'adaptive-correction', description: 'planner correction loop', inputs: {},
    settings: { concurrency: 1, retryAttempts: 0, maxAgents: 12, maxExpansionRounds: 3, maxActions: 8, maxItemsPerExpansion: 4, ...settings },
    phases: [{ name: 'work', steps: [
      { id: 'initial', type: 'run', lane: 'analyze', prompt: 'Perform the initial bounded investigation.' },
      { id: 'planner', type: 'decide', lane: 'analyze', prompt: `Judge sufficiency and propose only necessary bounded work. ${marker}` },
    ] }],
  };
}

function plannerTasks(runDir) {
  return readdirSync(runDir)
    .filter((name) => name.startsWith('task-planner-'))
    .sort()
    .map((name) => readFileSync(join(runDir, name), 'utf8'));
}

test('dependency-ready sibling actions run concurrently and dependents start as soon as their own inputs finish', async () => {
  const f = fixture();
  try {
    const started = {};
    const finished = {};
    const result = await runWorkflow({
      bullswarmDir: f.bullswarmDir, doc: adaptiveDoc('FORCE_PARALLEL', { concurrency: 3 }), pools: f.pools, inputs: {},
      onEvent: (event) => {
        if (event.type === 'action.started') started[event.actionId] = Date.now();
        if (event.type === 'action.completed') finished[event.actionId] = Date.now();
      },
    });
    assert.equal(result.state.status, 'completed');
    assert.deepEqual(result.state.decisions.map((decision) => decision.decision), ['needs_more_work', 'complete']);
    for (const id of ['fix-a', 'fix-b', 'fix-c', 'check-a', 'check-b', 'check-c']) {
      assert.equal(result.state.outputs[id].ok, true, id);
      assert.ok(started[id] && finished[id], `${id} observed`);
    }
    // All three fixes were in flight together (the limiter allows 3).
    const fixesInFlightAt = (t) => ['fix-a', 'fix-b', 'fix-c'].filter((id) => started[id] <= t && finished[id] >= t).length;
    assert.equal(fixesInFlightAt(Math.max(started['fix-a'], started['fix-b'], started['fix-c'])), 3);
    // check-a (depends only on fix-a, 300 ms) started before the slow fixes (1200 ms) finished:
    // no wave barrier between dependency levels.
    assert.ok(started['check-a'] < Math.min(finished['fix-b'], finished['fix-c']),
      `check-a started at +${started['check-a'] - started['fix-a']}ms; fix-b finished at +${finished['fix-b'] - started['fix-a']}ms`);
    assert.ok(result.state.attempts.every((attempt) => attempt.status === 'succeeded'));
    const [firstPlannerTask] = plannerTasks(result.runDir);
    assert.match(firstPlannerTask, /PLANNING DOCTRINE/);
    assert.match(firstPlannerTask, /"concurrency": 3/);
    assert.match(firstPlannerTask, /"readySiblingsRunConcurrently": true/);
    assert.match(firstPlannerTask, /concurrent workers editing DISJOINT files in the same tree is the normal, expected mode/);
    assert.doesNotMatch(firstPlannerTask, /must not modify or stash the shared target/);
  } finally { f.cleanup(); }
});

test('planner prompt shows full run, fanout, and verify skeletons', async () => {
  const f = fixture();
  try {
    const result = await runWorkflow({ bullswarmDir: f.bullswarmDir, doc: adaptiveDoc('FORCE_PROCEED'), pools: f.pools, inputs: {} });
    assert.equal(result.state.status, 'completed');
    const [task] = plannerTasks(result.runDir);
    assert.match(task, /"type":"run","phase":"implement","prompt"/);
    assert.match(task, /"type":"fanout","phase":"inspect","items":\["alpha","beta"\],"stepTemplate":\{"prompt":"Inspect \{\{item\}\}/);
    assert.match(task, /"type":"verify","phase":"verify","prompt":/);
    assert.match(task, /review is never instructions or a filesystem path/);
    assert.match(task, /fanout\.stepTemplate MUST be an object/);
    assert.match(task, /"validationFeedback": null/);
    assert.doesNotMatch(task, /CORRECTION REQUIRED/);
  } finally { f.cleanup(); }
});

test('invalid planner proposal gets one corrective turn with the exact validator issues, then the run completes', async () => {
  const f = fixture();
  try {
    const result = await runWorkflow({ bullswarmDir: f.bullswarmDir, doc: adaptiveDoc('FORCE_INVALID_ONCE'), pools: f.pools, inputs: {} });
    assert.equal(result.state.status, 'completed');
    assert.equal(result.state.outputs['corrected-task'].ok, true);
    assert.deepEqual(result.state.decisions.map((decision) => decision.decision), ['needs_more_work', 'complete']);

    const events = readEvents(result.runDir);
    const rejected = events.filter((event) => event.type === 'decision.rejected');
    assert.equal(rejected.length, 1);
    assert.ok(rejected[0].payload.issues.includes('actions[0].stepTemplate is required'), JSON.stringify(rejected[0]));
    const corrections = events.filter((event) => event.type === 'decision.correction_requested');
    assert.equal(corrections.length, 1);
    assert.equal(corrections[0].payload.attempt, 1);
    assert.equal(corrections[0].payload.maxAttempts, 2);
    assert.equal(corrections[0].payload.pool, 'adaptive-echo');
    assert.ok(!events.some((event) => event.type === 'decision.orchestrator_escalated'));

    const tasks = plannerTasks(result.runDir);
    // Planner task files are stamped per decision loop turn; the corrective
    // turn is the one carrying the validator feedback.
    const correction = tasks.find((task) => task.includes('CORRECTION REQUIRED (attempt 1 of 2)'));
    assert.ok(correction, 'corrective planner task was written');
    assert.match(correction, /"actions\[0\]\.stepTemplate is required"/);
    assert.match(correction, /"rejectedProposal": \{/);
    assert.match(correction, /"id": "bad-fanout"/);
    assert.match(correction, /"rejectedResponseExcerpt": "/);

    const gate = result.state.actionLedger.find((action) => action.id === 'planner');
    assert.equal(gate.status, 'succeeded');
    assert.equal(result.state.attempts.filter((attempt) => attempt.actionId === 'planner').length, 3);
  } finally { f.cleanup(); }
});

test('exhausted planner corrections settle on a qualified outcome instead of a failed run', async () => {
  const f = fixture();
  try {
    const result = await runWorkflow({ bullswarmDir: f.bullswarmDir, doc: adaptiveDoc('FORCE_GARBAGE'), pools: f.pools, inputs: {} });
    assert.equal(result.state.status, 'completed_with_concerns');
    assert.equal(result.state.outcome.status, 'completed_with_concerns');
    assert.equal(result.state.outcome.deliveryActionId, 'initial');
    assert.match(result.state.outcome.reason, /could not produce a valid decision after 2 correction turn\(s\): planner response invalid/);

    const events = readEvents(result.runDir);
    assert.equal(events.filter((event) => event.type === 'decision.rejected').length, 3);
    assert.deepEqual(events.filter((event) => event.type === 'decision.correction_requested').map((event) => event.payload.attempt), [1, 2]);
    assert.ok(!events.some((event) => event.type === 'decision.orchestrator_escalated'), 'single pool cannot escalate');
    assert.equal(events.filter((event) => event.type === 'action.failed' && event.payload.actionId === 'planner').length, 1);

    const gate = result.state.actionLedger.find((action) => action.id === 'planner');
    assert.equal(gate.status, 'failed_terminal');
    assert.equal(result.state.attempts.filter((attempt) => attempt.actionId === 'planner').length, 3);
    assert.ok(plannerTasks(result.runDir).some((task) => task.includes('CORRECTION REQUIRED (attempt 2 of 2)')));
  } finally { f.cleanup(); }
});

test('planner corrections can be disabled and a bounded budget is honoured', async () => {
  const f = fixture();
  try {
    const result = await runWorkflow({
      bullswarmDir: f.bullswarmDir, doc: adaptiveDoc('FORCE_GARBAGE', { maxPlannerCorrections: 0 }), pools: f.pools, inputs: {},
    });
    assert.equal(result.state.status, 'completed_with_concerns');
    assert.match(result.state.outcome.reason, /after 0 correction turn\(s\)/);
    assert.equal(result.state.attempts.filter((attempt) => attempt.actionId === 'planner').length, 1);
    assert.throws(() => validateWorkflow(adaptiveDoc('x', { maxPlannerCorrections: -1 })),
      (err) => /maxPlannerCorrections must be an integer >= 0/.test([...(err.issues ?? []), err.message].join('\n')));
  } finally { f.cleanup(); }
});

test('after corrections are exhausted the orchestrator escalates to another eligible pool', async () => {
  const f = fixture();
  try {
    const pools = [{ ...f.garbagePool, pace: 10 }, { ...f.pools[0], pace: 0 }];
    const result = await runWorkflow({ bullswarmDir: f.bullswarmDir, doc: adaptiveDoc('FORCE_ESCALATE'), pools, inputs: {} });
    assert.equal(result.state.status, 'completed');
    assert.deepEqual(result.state.decisions.map((decision) => decision.decision), ['needs_more_work', 'complete']);

    const events = readEvents(result.runDir);
    const escalations = events.filter((event) => event.type === 'decision.orchestrator_escalated');
    assert.equal(escalations.length, 1);
    assert.equal(escalations[0].payload.from, 'adaptive-garbage');
    assert.deepEqual(escalations[0].payload.to, ['adaptive-echo']);
    assert.deepEqual(result.state.orchestratorAvoidPools, ['adaptive-garbage']);
    assert.equal(events.filter((event) => event.type === 'decision.correction_requested').length, 2);

    const plannerPools = result.state.attempts.filter((attempt) => attempt.actionId === 'planner').map((attempt) => attempt.pool);
    assert.deepEqual(plannerPools, ['adaptive-garbage', 'adaptive-garbage', 'adaptive-garbage', 'adaptive-echo', 'adaptive-echo']);
    const gate = result.state.actionLedger.find((action) => action.id === 'planner');
    assert.equal(gate.status, 'succeeded');
    assert.ok(plannerTasks(result.runDir).some((task) => task.includes('CORRECTION REQUIRED (attempt 1 of 3)')));
  } finally { f.cleanup(); }
});

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
    assert.ok(plannerTasks.every((task) => task.includes('Every action MUST include a forward-only kebab-case "phase"')));
    assert.ok(plannerTasks.every((task) => task.includes('"closedPhases"')));
    assert.ok(plannerTasks.every((task) => task.includes('The dispatch budget counts this planner call plus every worker, verifier, retry, and escalation attempt.')));
  } finally { f.cleanup(); }
});

test('autonomous planner checkpoints reuse one durable connector conversation', async () => {
  const f = fixture();
  try {
    f.pools[0].connector.conversation = {
      newArgs: ['--session-id', '{sessionId}'],
      resumeArgs: ['--resume', '{sessionId}'],
    };
    const doc = {
      name: 'autonomous-conversation', description: 'one planner thread', inputs: {},
      intent: { goal: 'Inspect, follow up, and complete.', autonomous: true },
      orchestration: { mode: 'autonomous' },
      settings: { concurrency: 1, retryAttempts: 0, maxAgents: 6, maxExpansionRounds: 2, maxActions: 8, maxItemsPerExpansion: 4 },
      phases: [{ name: 'autonomous-delivery', steps: [
        { id: 'initial', type: 'run', lane: 'analyze', prompt: 'Perform the initial bounded investigation.' },
        { id: 'orchestrator', type: 'decide', lane: 'analyze', prompt: 'Judge sufficiency and propose only necessary bounded work.' },
      ] }],
    };
    const result = await runWorkflow({ bullswarmDir: f.bullswarmDir, doc, pools: f.pools, inputs: {} });
    const turns = result.state.attempts.filter((attempt) => attempt.actionId === 'orchestrator');
    assert.equal(result.state.status, 'completed');
    assert.equal(turns.length, 2);
    assert.equal(turns[0].conversation.continued, false);
    assert.equal(turns[1].conversation.continued, true);
    assert.equal(turns[0].conversation.sessionId, turns[1].conversation.sessionId);
    assert.equal(result.state.orchestration.conversations['adaptive-echo'].started, true);
  } finally { f.cleanup(); }
});

test('queued steering is delivered to the next planner prompt without changing the active worker', async () => {
  const f = fixture();
  try {
    const guidance = 'Prefer a focused regression check before any additional full-suite run.';
    let queuedDuring = null;
    const doc = {
      name: 'adaptive-steering', description: 'deliver guidance at planner boundary', inputs: {},
      settings: { concurrency: 1, retryAttempts: 0, maxAgents: 6, maxExpansionRounds: 2, maxActions: 8, maxItemsPerExpansion: 4 },
      phases: [{ name: 'work', steps: [
        { id: 'initial', type: 'run', lane: 'analyze', prompt: 'Perform the initial bounded investigation.' },
        { id: 'planner', type: 'decide', lane: 'analyze', prompt: 'Judge sufficiency and propose only necessary bounded work.' },
      ] }],
    };
    const result = await runWorkflow({
      bullswarmDir: f.bullswarmDir, doc, pools: f.pools, inputs: {},
      onEvent: (event) => {
        if (event.type !== 'step.started' || event.stepId !== 'initial' || queuedDuring) return;
        const runId = readdirSync(join(f.bullswarmDir, 'workflows'))[0];
        const live = JSON.parse(readFileSync(join(f.bullswarmDir, 'workflows', runId, 'state.json'), 'utf8'));
        queuedDuring = live.currentStep;
        queueSteering(f.bullswarmDir, runId, guidance);
      },
    });
    assert.equal(queuedDuring.id, 'initial');
    assert.equal(result.state.status, 'completed');
    assert.equal(result.state.steering.length, 1);
    assert.equal(result.state.steering[0].message, guidance);
    assert.equal(result.state.steering[0].status, 'delivered_to_planner');
    assert.ok(readEvents(result.runDir).some((event) => event.type === 'steering.delivered'));
    const plannerTasks = readdirSync(result.runDir).filter((name) => name.startsWith('task-planner-'));
    assert.ok(plannerTasks.length >= 1);
    assert.ok(plannerTasks.some((name) => readFileSync(join(result.runDir, name), 'utf8').includes(guidance)));
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

test('verify review instructions are recovered into prompt and bad review paths are rejected before dispatch', () => {
  const base = { schemaVersion: 'bullswarm.workflow.decision.v1', decision: 'needs_more_work', reason: 'independent verification is required' };
  const prose = normalizeDecisionProposal({ ...base, actions: [{
    id: 'verify-fix', type: 'verify', dependsOn: ['fix'],
    review: 'Independently confirm hello.txt contains exactly one line and report pass or fail.',
  }] });
  assert.equal(prose.actions[0].review, 'outputs.fix.outFile');
  assert.match(prose.actions[0].prompt, /^Independently confirm hello\.txt/);
  assert.doesNotThrow(() => validateDecisionProposal(prose, { knownActionIds: ['fix'], currentActionCount: 1 }));

  const path = normalizeDecisionProposal({ ...base, actions: [{
    id: 'verify-fix', type: 'verify', dependsOn: ['fix'], prompt: 'Check it.', review: '/abs/repo/hello.txt',
  }] });
  assert.equal(path.actions[0].review, 'outputs.fix.outFile');
  assert.equal(path.actions[0].prompt, 'Check it.');
  assert.equal(path.actions[0].reviewNormalizedFrom, '/abs/repo/hello.txt');

  assert.throws(() => validateDecisionProposal(normalizeDecisionProposal({ ...base, actions: [{
    id: 'verify-all', type: 'verify', dependsOn: ['fix-a', 'fix-b'], review: 'Run the whole suite and report.',
  }] }), { knownActionIds: ['fix-a', 'fix-b'], currentActionCount: 2 }),
  (err) => err instanceof DecisionValidationError && err.issues.some((issue) => /review must be a dotted artifact path/.test(issue)));
  assert.throws(() => validateDecisionProposal(normalizeDecisionProposal({ ...base, actions: [{
    id: 'verify-all', type: 'verify', dependsOn: ['fix-a', 'fix-b'],
  }] }), { knownActionIds: ['fix-a', 'fix-b'], currentActionCount: 2 }),
  (err) => err instanceof DecisionValidationError && err.issues.some((issue) => /review is required: a verify with one dependsOn/.test(issue)));
  assert.throws(() => validateDecisionProposal({ ...base, actions: [{
    id: 'verify-all', type: 'verify', dependsOn: ['fix-a'], review: 'outputs.ghost.outFile',
  }] }, { knownActionIds: ['fix-a'], currentActionCount: 1 }),
  (err) => err instanceof DecisionValidationError && err.issues.some((issue) => /review references unknown action "ghost"/.test(issue)));
  assert.doesNotThrow(() => validateDecisionProposal({ ...base, actions: [{
    id: 'verify-all', type: 'verify', dependsOn: ['fix-a', 'fix-b'], prompt: 'Run npm test.', review: 'outputs.fix-b.outFile',
  }] }, { knownActionIds: ['fix-a', 'fix-b'], currentActionCount: 2 }));
  // A verify may be listed before the action it reviews within the same proposal.
  assert.doesNotThrow(() => validateDecisionProposal({ ...base, actions: [
    { id: 'verify-later', type: 'verify', dependsOn: ['fix-later'], review: 'outputs.fix-later.outFile', prompt: 'Check.' },
    { id: 'fix-later', type: 'run', prompt: 'Fix it.' },
  ] }, { knownActionIds: [], currentActionCount: 0 }));
});

test('planner phases are named and forward-only once their actions have executed', () => {
  const proposal = {
    schemaVersion: 'bullswarm.workflow.decision.v1',
    decision: 'needs_more_work',
    reason: 'Implement the bounded correction.',
    actions: [{ id: 'fix', type: 'run', phase: 'implement', prompt: 'Apply and test the correction.' }],
  };
  assert.equal(validateDecisionProposal(proposal).actions[0].phase, 'implement');
  assert.throws(() => validateDecisionProposal(proposal, { closedPhases: ['implement'] }), /forward-only/);
  assert.throws(() => validateDecisionProposal({
    ...proposal,
    actions: [{ ...proposal.actions[0], phase: 'Phase 2' }],
  }), /phase must be kebab-case/);
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

test('planner stop returns a qualified useful outcome while wait_for_approval remains resumable', async () => {
  for (const [marker, expected] of [['FORCE_STOP', 'completed_with_concerns'], ['FORCE_WAIT', 'waiting_for_approval']]) {
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
      if (expected === 'completed_with_concerns') {
        assert.equal(result.state.outcome.bestEffort, true);
        assert.equal(result.state.outcome.deliveryActionId, 'initial');
      }
      if (expected === 'waiting_for_approval') {
        assert.equal(result.state.finishedAt, undefined);
        assert.equal(result.state.actionLedger.find((action) => action.id === 'planner').status, 'waiting_for_approval');
      }
    } finally { f.cleanup(); }
  }
});

test('expansion-round target advises convergence but permits essential completion work', async () => {
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
    assert.equal(result.state.status, 'completed_with_concerns');
    assert.equal(result.state.outputs['budget-one'].ok, true);
    assert.equal(result.state.outputs['budget-two'].ok, true);
    assert.equal(result.state.budget.expansionRound, 2);
    assert.equal(result.state.budget.expansionOverTargetBy, 1);
    assert.equal(result.state.budget.expansionAdvisoryOnly, true);
    assert.ok(readEvents(result.runDir).some((event) => event.type === 'workflow.expansion_target_exceeded'));
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
  assert.deepEqual(completionEvidenceGaps(actions, policy, {
    audit: { ok: true },
    'audit-verify': { ok: true },
    implementation: { ok: true },
    'implementation-verify': { ok: false },
  }), ['a successful verification of latest worker implementation']);
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
