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
import {
  PLANNER_RULES_SECTION, PLANNER_EXAMPLES_SECTION, AUTONOMOUS_ORCHESTRATOR_PROMPT,
} from '../src/workflow/goal.js';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'bullswarm-adaptive-'));
  const bullswarmDir = join(root, '.bullswarm');
  mkdirSync(join(bullswarmDir, 'connectors'), { recursive: true });
  const worker = join(root, 'worker.mjs');
  writeFileSync(worker, [
    'import { readFileSync, writeFileSync } from "node:fs";',
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
    '  } else if (task.includes("FORCE_PROGRAM")) {',
    '    const prose = task.includes("FORCE_PROGRAM_PROSE");',
    '    const done = prose ? task.includes(`"per-item-items"`) : task.includes(`"check-repair-1"`);',
    '    answer = done',
    '      ? {schemaVersion:"bullswarm.workflow.decision.v1",decision:"complete",reason:"The compiled program ran to its boundary with durable evidence for every item and a passing verify.",actions:[]}',
    '      : {schemaVersion:"bullswarm.workflow.decision.v1",decision:"needs_more_work",reason:"Compile the whole program: discover the items, handle each one, verify with a repair policy.",actions:[',
    '          {id:"discover",type:"run",phase:"discover",prompt:(prose ? "RETURN_PROSE" : "RETURN_ITEMS") + " List the items that need handling. RETURN ONLY a JSON array of item names.",dependsOn:["initial"]},',
    '          {id:"per-item",type:"fanout",phase:"handle",itemsFrom:"outputs.discover.outFile",stepTemplate:{prompt:"Handle {{item}} in its own file only and report concrete evidence."}},',
    '          {id:"check",type:"verify",phase:"verify",prompt:(prose ? "VERIFY_OK" : "VERIFY_FLAKY") + " Confirm every handled item has evidence.",dependsOn:["per-item"],repair:{prompt:"Fix the handled items the verifier rejected, editing only their files.",maxRounds:2}}]};',
    '  } else if (task.includes("FORCE_SELF_COMPLETE")) {',
    '    const failing = task.includes("FORCE_SELF_COMPLETE_FAIL");',
    '    const boundary = task.includes(`"final-check"`);',
    '    answer = boundary',
    '      ? {schemaVersion:"bullswarm.workflow.decision.v1",decision:"stop",reason:"The self-completing program did not pass its final check; stopping with the qualified outcome.",actions:[]}',
    '      : {schemaVersion:"bullswarm.workflow.decision.v1",decision:"needs_more_work",reason:"Compile a self-completing program: two items, one final check.",completion:{when:"all-actions-ok",reason:"Both items were handled and the final check passed, which is exactly what the goal asked for."},actions:[',
    '          {id:"work-a",type:"run",phase:"work",prompt:"Handle item a in its own file only and report concrete evidence.",dependsOn:["initial"]},',
    '          {id:"work-b",type:"run",phase:"work",prompt:"Handle item b in its own file only and report concrete evidence.",dependsOn:["initial"]},',
    '          {id:"final-check",type:"verify",phase:"verify",prompt:(task.includes("VERDICT_GARBLE") ? "VERIFY_GARBLED" : failing ? "VERIFY_FAIL" : "VERIFY_OK") + " Confirm both items have evidence.",dependsOn:["work-a","work-b"],review:"outputs.work-b.outFile"}]};',
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
    '    const slow = task.includes("CRASH_RESUME_SLOW") ? "SLEEP_1500 " : "";',
    '    const done = task.includes("resume-two") && task.includes("succeeded");',
    '    answer = done',
    '      ? {schemaVersion:"bullswarm.workflow.decision.v1",decision:"complete",reason:"Both accepted expansion actions are now durably complete after resume.",actions:[]}',
    '      : {schemaVersion:"bullswarm.workflow.decision.v1",decision:"needs_more_work",reason:"Two ordered bounded actions are required to prove crash-safe expansion resume.",actions:[{id:"resume-one",type:"run",prompt:slow + "Complete first durable resume action with concrete evidence.",dependsOn:["initial"]},{id:"resume-two",type:"run",prompt:"Complete second durable resume action with concrete evidence.",dependsOn:["resume-one"]}]};',
    '  } else {',
    '    const expandedDone = task.includes("expanded-task") && task.includes("succeeded");',
    '    answer = expandedDone',
    '      ? {schemaVersion:"bullswarm.workflow.decision.v1",decision:"complete",reason:"Expanded evidence now proves the requested work is complete and verified.",actions:[]}',
    '      : {schemaVersion:"bullswarm.workflow.decision.v1",decision:"needs_more_work",reason:"The initial result lacks one bounded follow-up investigation needed for sufficient evidence.",actions:[{id:"expanded-task",type:"run",lane:"analyze",prompt:"Perform the bounded expanded investigation and report concrete evidence.",dependsOn:["initial"]}]};',
    '  }',
    '  process.stdout.write(answer === "__GARBAGE__"',
    '    ? "I believe the next step should be to run the full test suite and inspect the failing modules, but I cannot express that as the requested decision object right now; please advise on the expected shape."',
    '    : JSON.stringify(answer));',
    '} else if (task.includes("RETURN_ITEMS")) {',
    '  process.stdout.write("Found three items [see below] that need handling.\\n[\\"alpha\\", \\"beta\\", \\"gamma\\"]\\n");',
    '} else if (task.includes("RETURN_PROSE")) {',
    '  process.stdout.write("The items that need handling are x and y. Both were found by comparing the module list against the failing test names in the fixture; every other module already passes, so nothing else qualifies.");',
    '} else if (task.includes("BEGIN STEP OUTPUT")) {',
    '  process.stdout.write("[\\"x\\", \\"y\\"]");',
    '} else if (task.includes("VERIFY_FLAKY")) {',
    '  const counter = new URL("./verify-count.txt", import.meta.url);',
    '  let n = 0; try { n = Number(readFileSync(counter, "utf8")) || 0; } catch {}',
    '  writeFileSync(counter, String(n + 1));',
    '  process.stdout.write(JSON.stringify(n === 0',
    '    ? {ok:false, concerns:["item beta lacks evidence of the handled result"], summary:"beta is unproven"}',
    '    : {ok:true, concerns:[], summary:"every item has evidence"}));',
    '} else if (task.includes("VERIFY_GARBLED")) {',
    '  const gcounter = new URL("./verify-garbled-count.txt", import.meta.url);',
    '  let g = 0; try { g = Number(readFileSync(gcounter, "utf8")) || 0; } catch {}',
    '  writeFileSync(gcounter, String(g + 1));',
    '  process.stdout.write(g === 0',
    '    ? "The artifact looks correct overall and both items carry the required evidence, so I would accept it, though I could not produce the object form you asked about here."',
    '    : JSON.stringify({ok:true, concerns:[], summary:"every item has evidence"}));',
    '} else if (task.includes("VERIFY_FAIL")) {',
    '  process.stdout.write(JSON.stringify({ok:false, concerns:["item b has no evidence of the handled result"], summary:"b is unproven"}));',
    '} else if (task.includes("VERIFY_OK")) {',
    '  process.stdout.write(JSON.stringify({ok:true, concerns:[], summary:"every item has evidence"}));',
    '} else {',
    '  if (task.includes("LONG_EXCERPT")) process.stdout.write("LONG_EXCERPT_OUTPUT_" + "x".repeat(400));',
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
         { id: 'planner', type: 'decide', lane: 'analyze', prompt: `Judge sufficiency and propose only necessary bounded work. ${marker}\n${AUTONOMOUS_ORCHESTRATOR_PROMPT}` },
    ] }],
  };
}

function plannerTasks(runDir) {
  return readdirSync(runDir)
    .filter((name) => name.startsWith('task-planner-'))
    .sort()
    .map((name) => readFileSync(join(runDir, name), 'utf8'));
}

function plannerContext(task) {
  const match = task.match(/---- BEGIN DURABLE WORKFLOW CONTEXT ----\n([\s\S]*?)\n---- END DURABLE WORKFLOW CONTEXT ----/);
  assert.ok(match, 'planner task contains durable context');
  return JSON.parse(match[1]);
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
    assert.match(firstPlannerTask, /Ordered planning contract:/);
    assert.match(firstPlannerTask, /"concurrency": 3/);
    assert.match(firstPlannerTask, /"readySiblingsRunConcurrently": true/);
    const context = plannerContext(firstPlannerTask);
    assert.equal(context.completedActions[0].attempts, 1);
    assert.equal(Array.isArray(context.completedActions[0].attempts), false);
    assert.equal(context.completedActions[0].pool, 'adaptive-echo');
    assert.equal(context.completedActions[0].routing, undefined);
    assert.doesNotMatch(firstPlannerTask, /PLANNING DOCTRINE|Graph skeleton|Program skeleton/);
  } finally { f.cleanup(); }
});

test('planner prompt shows full run, fanout, and verify skeletons', async () => {
  const f = fixture();
  try {
    const result = await runWorkflow({ bullswarmDir: f.bullswarmDir, doc: adaptiveDoc('FORCE_PROCEED'), pools: f.pools, inputs: {} });
    assert.equal(result.state.status, 'completed');
    const [task] = plannerTasks(result.runDir);
    assert.match(task, /"type":"run","phase":"implement","prompt"/);
    assert.match(task, /"type":"fanout","phase":"fix","items":\["alpha"\]/);
    assert.match(task, /"type":"verify","phase":"verify","prompt":/);
    assert.match(task, /"itemsFrom":"outputs\.discover\.outFile"/);
    assert.match(task, /"repair":\{"prompt":/);
    assert.match(task, /"completion":\{"when":"all-actions-ok"/);
    assert.match(task, /"outputSchema":\{"type":"object"\}/);
    assert.match(task, /"outputExcerpt": "Completed the bounded action with concrete evidence/);
    assert.match(task, /fanout has stepTemplate and either items or itemsFrom/);
    assert.match(task, /\{\{item\}\}/);
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
    assert.ok(plannerTasks.every((task) => task.includes('Treat agent-count, workflow-duration, and expansion-round budgets as advisory planning targets')));
  } finally { f.cleanup(); }
});

test('planner context uses compact rows, last-attempt routing, and emits context size metadata', async () => {
  const f = fixture();
  try {
    const retryWorker = join(f.root, 'planner-context-retry.mjs');
    const retryCount = join(f.root, 'planner-context-retry.count');
    writeFileSync(retryWorker, [
      'import { readFileSync, writeFileSync } from "node:fs";',
      `const countFile = ${JSON.stringify(retryCount)};`,
      'let count = 0; try { count = Number(readFileSync(countFile, "utf8")) || 0; } catch {}',
      'writeFileSync(countFile, String(count + 1));',
      'if (count === 0) process.exit(1);',
      'process.stdout.write("Completed the bounded action with concrete evidence.");',
    ].join('\n'));
    const badConnector = {
      ...f.pools[0].connector,
      name: 'context-bad',
      spawn: { cmd: ['node', retryWorker, '{taskFile}'], cwdMode: 'task-file-dir' },
    };
    const pools = [
      { ...f.pools[0], name: 'context-bad', connector: badConnector, pace: 0 },
    ];
    const result = await runWorkflow({
      bullswarmDir: f.bullswarmDir,
      doc: {
        name: 'planner-context-shape', description: 'context', inputs: {},
        settings: { retryAttempts: 1, escalateOnFail: false, maxExpansionRounds: 1 },
        phases: [{ name: 'p', steps: [
          { id: 'two-attempts', type: 'run', lane: 'analyze', prompt: 'Complete the bounded action.' },
          { id: 'planner', type: 'decide', lane: 'analyze', prompt: `FORCE_PROCEED\n${AUTONOMOUS_ORCHESTRATOR_PROMPT}`, dependsOn: ['two-attempts'] },
        ] }],
      },
      pools: [pools[0]], inputs: {},
    });
    const task = plannerTasks(result.runDir)[0];
    const context = plannerContext(task);
    const row = context.completedActions.find((entry) => entry.id === 'two-attempts');
    assert.equal(row.attempts, 2);
    assert.equal(Array.isArray(row.attempts), false);
    assert.equal(row.pool, 'context-bad');
    assert.equal(row.model, null);
    assert.equal(typeof row.durationSec, 'number');
    assert.equal(Math.round(row.durationSec * 10) / 10, row.durationSec);
    assert.equal('routing' in row, false);
    assert.equal('usage' in row, false);

    const event = readEvents(result.runDir).find((entry) => entry.type === 'decision.context_built');
    assert.equal(event.payload.sequence, 1);
    assert.equal(event.payload.chars, JSON.stringify(context).length);
    for (const [key, size] of Object.entries(event.payload.keys)) {
      assert.equal(size, JSON.stringify(context[key]).length, key);
    }
  } finally { f.cleanup(); }
});

test('planner context applies full excerpt rules and keeps failure reasons with id-only failures', async () => {
  const f = fixture();
  try {
    const result = await runWorkflow({
      bullswarmDir: f.bullswarmDir,
      doc: adaptiveDoc('FORCE_SELF_COMPLETE_FAIL', { concurrency: 3, maxActions: 12, maxAgents: 20 }),
      pools: f.pools, inputs: {},
    });
    const context = plannerContext(plannerTasks(result.runDir).at(-1));
    const failedVerify = context.outputs['final-check'];
    assert.equal(failedVerify.verify.ok, false);
    assert.equal(failedVerify.outputExcerpt.length, failedVerify.outputChars);
    assert.ok(failedVerify.outputExcerpt.length > 0);

    const scoutRun = await runWorkflow({
      bullswarmDir: f.bullswarmDir,
      doc: {
        name: 'scout-full-excerpt', description: 'scout', inputs: {},
        settings: { retryAttempts: 0, maxExpansionRounds: 1 },
        phases: [{ name: 'p', steps: [
          { id: 'scout', type: 'run', prompt: 'LONG_EXCERPT' },
          { id: 'planner', type: 'decide', prompt: `FORCE_PROCEED\n${AUTONOMOUS_ORCHESTRATOR_PROMPT}` },
        ] }],
      },
      pools: f.pools, inputs: {},
    });
    const scout = plannerContext(plannerTasks(scoutRun.runDir)[0]).outputs.scout;
    assert.equal(scout.outputExcerpt.length, scout.outputChars);
    assert.ok(scout.outputChars > 200);

    const stale = await runWorkflow({
      bullswarmDir: f.bullswarmDir,
      doc: {
        ...adaptiveDoc('FORCE_DEFAULT', { maxExpansionRounds: 2 }),
        phases: [{ name: 'work', steps: [
          { id: 'initial', type: 'run', prompt: 'LONG_EXCERPT' },
          { id: 'planner', type: 'decide', prompt: 'Judge sufficiency.' },
        ] }],
      },
      pools: f.pools, inputs: {},
    });
    const staleContext = plannerContext(plannerTasks(stale.runDir).at(-1));
    assert.equal(staleContext.outputs.initial.outputExcerpt.length, 200);
    assert.ok(staleContext.outputs.initial.outputChars > 200);

    const badWorker = join(f.root, 'planner-context-failure.mjs');
    writeFileSync(badWorker, 'process.stdout.write("concrete failure reason");\n');
    const badConnector = {
      ...f.pools[0].connector,
      name: 'failure-pool',
      authSignatures: ['concrete failure reason'],
      spawn: { cmd: ['node', badWorker, '{taskFile}'], cwdMode: 'task-file-dir' },
    };
    const failureResult = await runWorkflow({
      bullswarmDir: f.bullswarmDir,
      doc: {
        name: 'planner-failure-context', description: 'failure', inputs: {},
        settings: { retryAttempts: 0, escalateOnFail: false, maxExpansionRounds: 1 },
        phases: [{ name: 'p', steps: [
          { id: 'failed-action', type: 'run', lane: 'chore', prompt: 'Fail.' },
          { id: 'planner', type: 'decide', lane: 'analyze', prompt: 'FORCE_STOP', dependsOn: ['failed-action'] },
        ] }],
      },
      pools: [
        { name: 'failure-pool', connector: badConnector, enabled: true, lanes: ['chore'], capabilities: [], pace: 0 },
        f.pools[0],
      ],
      inputs: {},
    });
    const failureContext = plannerContext(plannerTasks(failureResult.runDir)[0]);
    assert.deepEqual(failureContext.failures, ['failed-action']);
    const failedRow = failureContext.completedActions.find((entry) => entry.id === 'failed-action');
    assert.equal(typeof failedRow.why, 'string');
    assert.match(failedRow.why, /concrete failure reason/);
    assert.ok(failureContext.failures.every((id) => typeof id === 'string'));
  } finally { f.cleanup(); }
});

test('exported planner prompt sections contain the bounded contract and literal item template', () => {
  assert.ok(PLANNER_RULES_SECTION.length <= 4000);
  assert.ok(PLANNER_EXAMPLES_SECTION.length <= 3000);
  for (const keyword of ['completion', 'repair', 'itemsFrom', 'outputSchema', 'dependsOn', 'phase', 'pool']) {
    assert.match(PLANNER_RULES_SECTION, new RegExp(keyword));
  }
  assert.match(PLANNER_EXAMPLES_SECTION, /Action shapes:/);
  assert.match(PLANNER_EXAMPLES_SECTION, /Complete program:/);
  assert.match(PLANNER_EXAMPLES_SECTION, /\{\{item\}\}/);
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

test('a self-completing program ends without a second planner turn when every action is ok', async () => {
  const f = fixture();
  try {
    const events = [];
    const result = await runWorkflow({
      bullswarmDir: f.bullswarmDir, doc: adaptiveDoc('FORCE_SELF_COMPLETE', { concurrency: 3, maxActions: 12, maxAgents: 20 }),
      pools: f.pools, inputs: {}, onEvent: (event) => events.push(event),
    });
    assert.equal(result.state.status, 'completed');
    assert.deepEqual(result.state.decisions.map((decision) => decision.decision), ['needs_more_work', 'complete']);
    assert.equal(result.state.decisions[1].source, 'program-completion');
    assert.equal(result.state.decisions[1].programSequence, 1);
    // ONE planner consultation: the program compiled itself to completion.
    assert.equal(plannerTasks(result.runDir).length, 1);
    assert.equal(result.state.outcome.verified, true);
    assert.equal(result.state.outcome.source, 'program-completion');
    assert.match(result.state.outcome.reason, /^Both items were handled and the final check passed/);
    assert.equal(result.state.outputs[result.state.decisions[1].gateId].autoCompleted, true);
    const auto = events.find((event) => event.type === 'decision.auto_completed');
    assert.ok(auto, 'decision.auto_completed emitted');
    assert.deepEqual(auto.actions, ['work-a', 'work-b', 'final-check']);
    assert.ok(!events.some((event) => event.type === 'decision.completion_predicate_unmet'));
  } finally { f.cleanup(); }
});

test('an unparseable verify verdict is re-asked once, not sent to the planner', async () => {
  const f = fixture();
  try {
    const events = [];
    const result = await runWorkflow({
      bullswarmDir: f.bullswarmDir, doc: adaptiveDoc('FORCE_SELF_COMPLETE VERDICT_GARBLE', { concurrency: 3, maxActions: 12, maxAgents: 20 }),
      pools: f.pools, inputs: {}, onEvent: (event) => events.push(event),
    });
    assert.equal(result.state.status, 'completed');
    // Still ONE planner consultation: the garbled verdict was re-asked by the
    // runtime, never surfaced as a boundary.
    assert.deepEqual(result.state.decisions.map((decision) => decision.decision), ['needs_more_work', 'complete']);
    assert.equal(result.state.decisions[1].source, 'program-completion');
    assert.equal(plannerTasks(result.runDir).length, 1);
    const retries = events.filter((event) => event.type === 'verify.verdict_retry');
    assert.equal(retries.length, 1);
    assert.equal(retries[0].actionId, 'final-check');
    assert.equal(result.state.outputs['final-check'].ok, true);
    assert.match(result.state.outputs['final-check'].why, /verify ok/);
  } finally { f.cleanup(); }
});

test('a self-completing program whose check fails comes back to the planner with the failing actions named', async () => {
  const f = fixture();
  try {
    const events = [];
    const result = await runWorkflow({
      bullswarmDir: f.bullswarmDir, doc: adaptiveDoc('FORCE_SELF_COMPLETE_FAIL', { concurrency: 3, maxActions: 12, maxAgents: 20 }),
      pools: f.pools, inputs: {}, onEvent: (event) => events.push(event),
    });
    assert.deepEqual(result.state.decisions.map((decision) => decision.decision), ['needs_more_work', 'stop']);
    assert.equal(plannerTasks(result.runDir).length, 2);
    const unmet = events.find((event) => event.type === 'decision.completion_predicate_unmet');
    assert.ok(unmet, 'decision.completion_predicate_unmet emitted');
    assert.deepEqual(unmet.failing, ['final-check']);
    assert.ok(!events.some((event) => event.type === 'decision.auto_completed'));
    assert.notEqual(result.state.status, 'completed');
  } finally { f.cleanup(); }
});

test('completion predicates are validated: needs_more_work only, with a verify, known predicate', () => {
  const base = { schemaVersion: 'bullswarm.workflow.decision.v1', decision: 'needs_more_work', reason: 'program' };
  const run = { id: 'w', type: 'run', phase: 'work', prompt: 'do it', dependsOn: [] };
  const verify = { id: 'v', type: 'verify', phase: 'verify', prompt: 'check it', dependsOn: ['w'] };
  assert.doesNotThrow(() => validateDecisionProposal(normalizeDecisionProposal({
    ...base, completion: { when: 'all-actions-ok', reason: 'clean run is the goal' }, actions: [run, verify],
  })));
  assert.throws(() => validateDecisionProposal(normalizeDecisionProposal({
    ...base, completion: { when: 'all-actions-ok' }, actions: [run],
  })), /self-completing program must include at least one verify action/);
  assert.throws(() => validateDecisionProposal(normalizeDecisionProposal({
    ...base, completion: { when: 'whenever' }, actions: [run, verify],
  })), /completion\.when must be one of: all-actions-ok/);
  assert.throws(() => validateDecisionProposal(normalizeDecisionProposal({
    ...base, decision: 'complete', completion: { when: 'all-actions-ok' }, actions: [],
  })), /only meaningful on a needs_more_work decision/);
  assert.throws(() => validateDecisionProposal(normalizeDecisionProposal({
    ...base, completion: { when: 'all-actions-ok', reason: 'x', mode: 'strict' }, actions: [run, verify],
  })), /completion\.mode is not a planner field/);
});

test('one decision carries a whole program: discovery, data-driven fan-out, and verify with repair run to the boundary without further planner turns', async () => {
  const f = fixture();
  try {
    const events = [];
    const result = await runWorkflow({
      bullswarmDir: f.bullswarmDir, doc: adaptiveDoc('FORCE_PROGRAM', { concurrency: 3, maxActions: 12, maxAgents: 20 }),
      pools: f.pools, inputs: {}, onEvent: (event) => events.push(event),
    });
    assert.equal(result.state.status, 'completed');
    // Exactly two consultations: compile the program, then judge its boundary.
    assert.deepEqual(result.state.decisions.map((decision) => decision.decision), ['needs_more_work', 'complete']);
    assert.equal(plannerTasks(result.runDir).length, 2);

    const accepted = result.state.plan.actions.find((entry) => entry.id === 'per-item');
    assert.deepEqual(accepted.definition.dependsOn, ['discover'], 'itemsFrom producer becomes an implicit dependency');
    const fanout = result.state.outputs['per-item'];
    assert.equal(fanout.total, 3);
    assert.equal(fanout.failed, 0);
    assert.equal(fanout.itemsFrom, 'outputs.discover.outFile');
    assert.deepEqual(fanout.items.map((entry) => entry.item), ['alpha', 'beta', 'gamma']);
    assert.match(readFileSync(fanout.outFile, 'utf8'), /^# fanout per-item: 3\/3 items ok/);

    // The verify rejected once, the repair policy fixed and re-checked inside the executor.
    const check = result.state.outputs.check;
    assert.equal(check.ok, true);
    assert.equal(check.verify.ok, true);
    assert.equal(result.state.actionLedger.find((entry) => entry.id === 'check').attempts.length, 2);
    const repair = result.state.plan.actions.find((entry) => entry.id === 'check-repair-1');
    assert.equal(repair.source, 'repair-policy');
    assert.deepEqual(repair.dependsOn, ['check']);
    assert.match(repair.definition.prompt, /^Fix the handled items the verifier rejected/);
    assert.match(repair.definition.prompt, /- item beta lacks evidence of the handled result/);
    assert.match(repair.definition.prompt, /Repair round 1 of 2/);
    assert.equal(result.state.outputs['check-repair-1'].ok, true);
    assert.ok(!result.state.plan.actions.some((entry) => entry.id === 'check-repair-2'));

    const types = events.map((event) => event.type);
    for (const type of ['action.items_resolved', 'action.repair_started', 'action.reverify_started', 'action.repaired']) {
      assert.ok(types.includes(type), `${type} emitted`);
    }
    assert.ok(!types.includes('action.items_extraction_requested'));
    const resolved = events.find((event) => event.type === 'action.items_resolved');
    assert.equal(resolved.count, 3);
    assert.ok(result.state.attempts.every((attempt) => attempt.status === 'succeeded'));
  } finally { f.cleanup(); }
});

test('a discovery step that answers in prose gets one bounded read-only extraction action before the fan-out proceeds', async () => {
  const f = fixture();
  try {
    const events = [];
    const result = await runWorkflow({
      bullswarmDir: f.bullswarmDir, doc: adaptiveDoc('FORCE_PROGRAM_PROSE', { concurrency: 2, maxActions: 12, maxAgents: 20 }),
      pools: f.pools, inputs: {}, onEvent: (event) => events.push(event),
    });
    assert.equal(result.state.status, 'completed');
    assert.deepEqual(result.state.decisions.map((decision) => decision.decision), ['needs_more_work', 'complete']);
    const extraction = result.state.plan.actions.find((entry) => entry.id === 'per-item-items');
    assert.equal(extraction.source, 'runtime-extraction');
    assert.deepEqual(extraction.dependsOn, ['discover']);
    assert.match(extraction.definition.prompt, /RETURN ONLY a JSON array/);
    assert.match(extraction.definition.prompt, /The items that need handling are x and y/);
    assert.match(extraction.definition.prompt, /read-only extraction/);
    assert.equal(result.state.outputs['per-item-items'].ok, true);
    const fanout = result.state.outputs['per-item'];
    assert.equal(fanout.total, 2);
    assert.deepEqual(fanout.items.map((entry) => entry.item), ['x', 'y']);
    const types = events.map((event) => event.type);
    assert.ok(types.includes('action.items_extraction_requested'));
    const extracted = events.find((event) => event.type === 'action.items_extracted');
    assert.equal(extracted.count, 2);
    assert.equal(result.state.outputs.check.ok, true);
    assert.equal(result.state.actionLedger.find((entry) => entry.id === 'check').attempts.length, 1, 'passing verify needs no repair');
  } finally { f.cleanup(); }
});

test('data-driven fanout and repair proposals are normalized and validated before dispatch', () => {
  const base = { schemaVersion: 'bullswarm.workflow.decision.v1', decision: 'needs_more_work', reason: 'compile the program' };
  const program = normalizeDecisionProposal({ ...base, actions: [
    // The fanout may be listed before its producer within the same proposal.
    { id: 'fix-module', type: 'fanout', phase: 'fix', itemsFrom: ' outputs.discover-modules.outFile ', stepTemplate: { prompt: 'Fix {{item}}.' } },
    { id: 'discover-modules', type: 'run', phase: 'discover', prompt: 'List failing modules. RETURN ONLY a JSON array.', dependsOn: ['initial'] },
    { id: 'verify-modules', type: 'verify', phase: 'verify', prompt: 'Re-run.', dependsOn: ['fix-module'], repair: { prompt: 'Fix them.', maxRounds: 2, effort: 'low' } },
  ] });
  assert.equal(program.actions[0].itemsFrom, 'outputs.discover-modules.outFile');
  assert.deepEqual(program.actions[0].dependsOn, ['discover-modules']);
  assert.equal(program.actions[2].review, 'outputs.fix-module.outFile');
  assert.doesNotThrow(() => validateDecisionProposal(program, { knownActionIds: ['initial'], currentActionCount: 2 }));
  // An explicit dependsOn that already names the producer is left alone.
  const explicit = normalizeDecisionProposal({ ...base, actions: [
    { id: 'f', type: 'fanout', itemsFrom: 'outputs.initial', dependsOn: ['initial'], stepTemplate: { prompt: '{{item}}' } },
  ] });
  assert.deepEqual(explicit.actions[0].dependsOn, ['initial']);
  assert.doesNotThrow(() => validateDecisionProposal(explicit, { knownActionIds: ['initial'], currentActionCount: 1 }));

  const rejects = (actions, pattern) => assert.throws(
    () => validateDecisionProposal(normalizeDecisionProposal({ ...base, actions }), { knownActionIds: ['initial'], currentActionCount: 1 }),
    (err) => err instanceof DecisionValidationError && err.issues.some((issue) => pattern.test(issue)),
    `expected an issue matching ${pattern}`,
  );
  rejects([{ id: 'f', type: 'fanout', stepTemplate: { prompt: '{{item}}' } }], /items must be an inline array, or actions\[0\]\.itemsFrom must be/);
  rejects([{ id: 'f', type: 'fanout', itemsFrom: '/abs/list.json', stepTemplate: { prompt: '{{item}}' } }], /itemsFrom must be a dotted artifact path/);
  rejects([{ id: 'f', type: 'fanout', itemsFrom: 'outputs.ghost.outFile', stepTemplate: { prompt: '{{item}}' } }], /itemsFrom references unknown action "ghost"/);
  rejects([{ id: 'f', type: 'fanout', itemsFrom: 'outputs.f.outFile', stepTemplate: { prompt: '{{item}}' } }], /itemsFrom cannot reference the fanout itself/);
  rejects([{ id: 'f', type: 'fanout', items: ['a'], itemsFrom: 'outputs.initial.outFile', stepTemplate: { prompt: '{{item}}' } }], /either items or itemsFrom, not both/);
  rejects([{ id: 'v', type: 'verify', dependsOn: ['initial'], prompt: 'x', repair: { maxRounds: 1 } }], /repair\.prompt must be a non-empty string/);
  rejects([{ id: 'v', type: 'verify', dependsOn: ['initial'], prompt: 'x', repair: { prompt: 'fix', maxRounds: 9 } }], /repair\.maxRounds must be an integer from 1 to 3/);
  rejects([{ id: 'v', type: 'verify', dependsOn: ['initial'], prompt: 'x', repair: { prompt: 'fix', addDir: '/x' } }], /repair\.addDir is runtime-owned/);
  rejects([{ id: 'v', type: 'verify', dependsOn: ['initial'], prompt: 'x', repair: 'just fix it' }], /repair must be an object/);
  rejects([{ id: 'r', type: 'run', prompt: 'x', repair: { prompt: 'fix' } }], /repair is only valid on verify actions/);
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
  // A multi-dependency verify without review is not rejected: it reviews the
  // most downstream dependency's artifact (the planner's obvious intent).
  const multi = normalizeDecisionProposal({ ...base, actions: [{
    id: 'verify-all', type: 'verify', dependsOn: ['fix-a', 'fix-b'], prompt: 'Run the whole suite.',
  }] });
  assert.equal(multi.actions[0].review, 'outputs.fix-b.outFile');
  assert.equal(multi.actions[0].reviewDefaultedFrom, 'last-dependency');
  assert.doesNotThrow(() => validateDecisionProposal(multi, { knownActionIds: ['fix-a', 'fix-b'], currentActionCount: 2 }));
  // A zero-dependency verify is a repository audit with no artifact to review.
  const audit = normalizeDecisionProposal({ ...base, actions: [{
    id: 'audit-unaffected', type: 'verify', phase: 'audit', prompt: 'Probe every export of the untouched modules.',
  }] });
  assert.equal(audit.actions[0].review, undefined);
  assert.equal(audit.actions[0].reviewScope, 'repository');
  assert.doesNotThrow(() => validateDecisionProposal(audit, { knownActionIds: ['initial'], currentActionCount: 1 }));
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

test('a verify that re-ran ok after its own repair round is evidence for that repair', () => {
  // Shape produced by the executor's repair loop: the repair depends on the
  // verify (reverse edge), then the same verify runs again and passes.
  const actions = [
    { id: 'build', kind: 'run', status: 'succeeded', dependsOn: [] },
    { id: 'verify-suite', kind: 'verify', status: 'succeeded', dependsOn: ['build'] },
    { id: 'verify-suite-repair-1', kind: 'run', status: 'succeeded', dependsOn: ['verify-suite'] },
  ];
  const policy = { requireSuccessfulWorker: true, requireSuccessfulVerification: true };
  assert.deepEqual(completionEvidenceGaps(actions, policy, {
    build: { ok: true }, 'verify-suite': { ok: true }, 'verify-suite-repair-1': { ok: true },
  }), []);
  // The re-verify rejected the repair: no evidence.
  assert.deepEqual(completionEvidenceGaps(actions, policy, {
    build: { ok: true }, 'verify-suite': { ok: false }, 'verify-suite-repair-1': { ok: true },
  }), ['a successful verification of latest worker verify-suite-repair-1']);
  // An unrelated worker that merely depends on a verify is not its repair.
  assert.deepEqual(completionEvidenceGaps([
    ...actions.slice(0, 2),
    { id: 'followup', kind: 'run', status: 'succeeded', dependsOn: ['verify-suite'] },
  ], policy, { build: { ok: true }, 'verify-suite': { ok: true }, followup: { ok: true } }),
  ['a successful verification of latest worker followup']);
  // Verify ids with regex metacharacters are matched literally.
  assert.deepEqual(completionEvidenceGaps([
    { id: 'v.1', kind: 'verify', status: 'succeeded', dependsOn: [] },
    { id: 'v.1-repair-1', kind: 'run', status: 'succeeded', dependsOn: ['v.1'] },
  ], policy, { 'v.1': { ok: true }, 'v.1-repair-1': { ok: true } }), []);
  assert.deepEqual(completionEvidenceGaps([
    { id: 'v.1', kind: 'verify', status: 'succeeded', dependsOn: [] },
    { id: 'vx1-repair-1', kind: 'run', status: 'succeeded', dependsOn: ['v.1'] },
  ], policy, { 'v.1': { ok: true }, 'vx1-repair-1': { ok: true } }),
  ['a successful verification of latest worker vx1-repair-1']);
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

function schemaFixture(mode) {
  const f = fixture();
  const countFile = join(f.root, `${mode}-dispatch-count.txt`);
  const worker = join(f.root, `${mode}-schema-worker.mjs`);
  writeFileSync(worker, [
    'import { readFileSync, writeFileSync } from "node:fs";',
    `const countFile = ${JSON.stringify(countFile)};`,
    'let count = 0; try { count = Number(readFileSync(countFile, "utf8")) || 0; } catch {}',
    'count += 1; writeFileSync(countFile, String(count));',
    mode === 'missing-first'
      ? `process.stdout.write(count === 1 ? ${JSON.stringify('The first answer contains a detailed investigation, concrete file inspection evidence, and a complete explanation, but no structured report.')} : ${JSON.stringify('The corrected answer includes the requested item count, the inspected item name, and durable evidence from the bounded action. The worker checked the bounded input, recorded the resulting item, and reports the exact structured values below so downstream work can consume the evidence without guessing.\n{"items":["alpha"],"count":1}')});`
      : 'process.stdout.write("{\\"items\\":\\"not-an-array\\",\\"count\\":\\"not-a-number\\"}");',
  ].join('\n'));
  const connector = {
    ...f.pools[0].connector,
    name: `${mode}-schema`,
    spawn: { cmd: ['node', worker, '{taskFile}'], cwdMode: 'task-file-dir' },
  };
  f.pools = [{
    name: connector.name, connector, enabled: true, costRank: 1,
    lanes: connector.lanes, capabilities: connector.capabilities, pace: 0,
  }];
  return { ...f, countFile };
}

const structuredOutputSchema = {
  type: 'object',
  properties: {
    items: { type: 'array', items: { type: 'string' } },
    count: { type: 'integer' },
  },
  required: ['items', 'count'],
  additionalProperties: false,
};

test('outputSchema retries a missing trailing JSON object once and records validated data', async () => {
  const f = schemaFixture('missing-first');
  try {
    const events = [];
    const result = await runWorkflow({
      bullswarmDir: f.bullswarmDir,
      doc: {
        name: 'schema-retry-success', description: 'schema retry', inputs: {},
        settings: { retryAttempts: 0, escalateOnFail: false },
        phases: [{ name: 'p', steps: [{
          id: 'structured', type: 'run', lane: 'chore', prompt: 'Return the structured result.',
          outputSchema: structuredOutputSchema,
        }] }],
      },
      pools: f.pools, inputs: {}, onEvent: (event) => events.push(event),
    });
    assert.equal(result.state.outputs.structured.ok, true);
    assert.deepEqual(result.state.outputs.structured.data, { items: ['alpha'], count: 1 });
    assert.equal(result.state.outputs.structured.schemaOk, true);
    assert.equal(Number(readFileSync(f.countFile, 'utf8')), 2);
    assert.equal(events.filter((event) => event.type === 'action.output_schema_retry').length, 1);
    assert.equal(events.filter((event) => event.type === 'action.output_validated').length, 1);
    assert.equal(result.state.attempts.filter((attempt) => attempt.actionId === 'structured').length, 2);
  } finally { f.cleanup(); }
});

test('outputSchema records schema errors and output after exactly two failed dispatches', async () => {
  const f = schemaFixture('always-invalid');
  try {
    const result = await runWorkflow({
      bullswarmDir: f.bullswarmDir,
      doc: {
        name: 'schema-retry-failure', description: 'schema retry failure', inputs: {},
        settings: { retryAttempts: 0, escalateOnFail: false },
        phases: [{ name: 'p', steps: [{
          id: 'structured', type: 'run', lane: 'chore', prompt: 'Return the structured result.',
          outputSchema: structuredOutputSchema,
        }] }],
      },
      pools: f.pools, inputs: {},
    });
    assert.equal(result.state.outputs.structured.ok, false);
    assert.match(result.state.outputs.structured.why, /^output did not match outputSchema:/);
    assert.equal(result.state.outputs.structured.schemaOk, false);
    assert.ok(result.state.outputs.structured.schemaErrors.length > 0);
    assert.match(result.state.outputs.structured.outputText, /not-an-array/);
    assert.equal(Number(readFileSync(f.countFile, 'utf8')), 2);
    assert.equal(result.state.attempts.filter((attempt) => attempt.actionId === 'structured').length, 2);
  } finally { f.cleanup(); }
});

test('resume redispatches a run action whose persisted output is schema-incomplete', async () => {
  const f = schemaFixture('missing-first');
  try {
    const doc = {
      name: 'schema-resume', description: 'schema resume', inputs: {},
      settings: { retryAttempts: 0, escalateOnFail: false },
      phases: [{ name: 'p', steps: [{
        id: 'structured', type: 'run', lane: 'chore', prompt: 'Return the structured result.',
        outputSchema: structuredOutputSchema,
      }] }],
    };
    const initial = await runWorkflow({ bullswarmDir: f.bullswarmDir, doc, pools: f.pools, inputs: {} });
    assert.equal(initial.state.outputs.structured.schemaOk, true);
    const statePath = join(f.bullswarmDir, 'workflows', initial.runId, 'state.json');
    const persisted = JSON.parse(readFileSync(statePath, 'utf8'));
    persisted.outputs.structured = {
      ...persisted.outputs.structured,
      ok: true,
      schemaOk: false,
      data: { items: 'not-an-array', count: 'not-a-number' },
      schemaErrors: ['items must be array'],
    };
    writeFileSync(statePath, `${JSON.stringify(persisted, null, 2)}\n`);
    writeFileSync(f.countFile, '0');
    const resumed = await runWorkflow({
      bullswarmDir: f.bullswarmDir, doc, pools: f.pools, inputs: {}, resumeRunId: initial.runId,
    });
    assert.equal(resumed.state.outputs.structured.schemaOk, true);
    assert.deepEqual(resumed.state.outputs.structured.data, { items: ['alpha'], count: 1 });
    assert.equal(Number(readFileSync(f.countFile, 'utf8')), 2);
    assert.equal(resumed.state.attempts.filter((attempt) => attempt.actionId === 'structured').length, 4);
    assert.ok(!readEvents(resumed.runDir).some((event) => event.type === 'step.skipped' && event.payload.stepId === 'structured'));

    writeFileSync(f.countFile, '0');
    const skipped = await runWorkflow({
      bullswarmDir: f.bullswarmDir, doc, pools: f.pools, inputs: {}, resumeRunId: resumed.runId,
    });
    assert.equal(Number(readFileSync(f.countFile, 'utf8')), 0);
    assert.equal(skipped.state.attempts.filter((attempt) => attempt.actionId === 'structured').length, 4);
    assert.ok(readEvents(skipped.runDir).some((event) => event.type === 'step.skipped' && event.payload.stepId === 'structured'));
  } finally { f.cleanup(); }
});

test('pending operator steering defers self-completion to the planner instead of being discarded', async () => {
  const f = fixture();
  try {
    const events = [];
    const guidance = 'Converge now: accept informational concerns, do not add polish actions.';
    let queued = false;
    const result = await runWorkflow({
      bullswarmDir: f.bullswarmDir, doc: adaptiveDoc('FORCE_SELF_COMPLETE', { concurrency: 3, maxActions: 12, maxAgents: 20 }),
      pools: f.pools, inputs: {},
      onEvent: (event) => {
        events.push(event);
        // Queue the steer while the accepted self-completing program is
        // executing — after the gate delivered (nothing), before the boundary.
        if (event.type === 'kernel.checkpointed' && event.stage === 'executing' && !queued) {
          queued = true;
          const runId = readdirSync(join(f.bullswarmDir, 'workflows'))[0];
          queueSteering(f.bullswarmDir, runId, guidance);
        }
      },
    });
    assert.equal(queued, true);
    // The clean program did NOT self-complete: the boundary was deferred to
    // the planner gate, which is the only place steering may be delivered.
    const deferred = events.find((event) => event.type === 'decision.completion_deferred');
    assert.ok(deferred, 'decision.completion_deferred emitted');
    assert.equal(deferred.reason, 'operator steering pending');
    assert.equal(deferred.steeringIds.length, 1);
    assert.ok(!events.some((event) => event.type === 'decision.auto_completed'));
    assert.equal(plannerTasks(result.runDir).length, 2);
    assert.equal(result.state.steering.length, 1);
    assert.equal(result.state.steering[0].status, 'delivered_to_planner');
    assert.ok(events.some((event) => event.type === 'steering.delivered'));
    const secondTask = plannerTasks(result.runDir).at(-1);
    assert.ok(secondTask.includes(guidance), 'second planner task carries the delivered guidance');
  } finally { f.cleanup(); }
});

test('steering that can no longer reach a gate is marked expired at the terminal transition', async () => {
  const f = fixture();
  try {
    const events = [];
    let queued = false;
    const result = await runWorkflow({
      bullswarmDir: f.bullswarmDir, doc: adaptiveDoc('FORCE_STOP'),
      pools: f.pools, inputs: {},
      onEvent: (event) => {
        events.push(event);
        // Queue AFTER the final planner decision is recorded: no gate remains.
        if (event.type === 'decision.created' && event.decision === 'stop' && !queued) {
          queued = true;
          const runId = readdirSync(join(f.bullswarmDir, 'workflows'))[0];
          queueSteering(f.bullswarmDir, runId, 'guidance that arrives too late');
        }
      },
    });
    assert.equal(queued, true);
    assert.ok(result.state.finishedAt);
    assert.equal(result.state.steering.length, 1);
    assert.equal(result.state.steering[0].status, 'expired_undelivered');
    assert.ok(result.state.steering[0].expiredAt);
    const expired = events.find((event) => event.type === 'steering.expired');
    assert.ok(expired, 'steering.expired emitted');
    assert.equal(expired.steeringIds.length, 1);
  } finally { f.cleanup(); }
});

test('resume re-runs an action the interruption cancelled instead of re-planning around a phantom failure', async () => {
  const f = fixture();
  try {
    const doc = {
      name: 'adaptive-resume-cancelled', description: 'resume after cancel', inputs: {},
      settings: { retryAttempts: 0, maxAgents: 8, maxExpansionRounds: 2, maxActions: 8, maxItemsPerExpansion: 4 },
      phases: [{ name: 'p', steps: [
        { id: 'initial', type: 'run', prompt: 'Initial evidence.' },
        { id: 'planner', type: 'decide', prompt: 'CRASH_RESUME_SLOW' },
      ] }],
    };
    // Simulate the operator/harness SIGTERM path: while resume-one is running,
    // request cancellation the way the dashboard does. The runtime records the
    // attempt as `cancelled` and the run ends `cancelled`, resumable.
    let cancelledOnce = false;
    const interrupted = await runWorkflow({
      bullswarmDir: f.bullswarmDir, doc, pools: f.pools, inputs: {},
      onEvent: (event) => {
        if (event.type === 'action.started' && event.actionId === 'resume-one' && !cancelledOnce) {
          cancelledOnce = true;
          const runId = readdirSync(join(f.bullswarmDir, 'workflows'))[0];
          const statePath = join(f.bullswarmDir, 'workflows', runId, 'state.json');
          const live = JSON.parse(readFileSync(statePath, 'utf8'));
          live.cancelRequested = true;
          live.cancelRequestedAt = new Date().toISOString();
          writeFileSync(statePath, JSON.stringify(live));
        }
      },
    });
    assert.equal(cancelledOnce, true);
    const crashedRunId = interrupted.runId;
    const before = JSON.parse(readFileSync(join(f.bullswarmDir, 'workflows', crashedRunId, 'state.json'), 'utf8'));
    const cancelledEntry = before.actionLedger.find((entry) => entry.id === 'resume-one');
    assert.equal(cancelledEntry.status, 'cancelled', 'the in-flight action is recorded cancelled');
    assert.equal(before.outputs['resume-one'].ok, false);
    const plannerTurnsBefore = before.attempts.filter((attempt) => attempt.actionId === 'planner').length;

    const events = [];
    const resumed = await runWorkflow({
      bullswarmDir: f.bullswarmDir, doc, pools: f.pools, inputs: {}, resumeRunId: crashedRunId,
      onEvent: (event) => events.push(event),
    });
    assert.equal(resumed.state.status, 'completed');
    const reopened = events.filter((event) => event.type === 'action.reopened').map((event) => event.actionId);
    assert.ok(reopened.includes('resume-one'), 'the cancelled action is reopened');
    assert.equal(resumed.state.outputs['resume-one'].ok, true);
    assert.equal(resumed.state.outputs['resume-two'].ok, true);
    // No phantom-failure boundary: the program finished from where it stopped
    // and the planner was consulted exactly once more (its completion turn).
    assert.ok(!events.some((event) => event.type === 'action.failed' && /blocked by failed or unresolved/.test(event.why ?? '')));
    const plannerTurnsAfter = resumed.state.attempts.filter((attempt) => attempt.actionId === 'planner').length;
    assert.equal(plannerTurnsAfter - plannerTurnsBefore, 1);
    assert.equal(resumed.state.decisions.at(-1).decision, 'complete');
  } finally { f.cleanup(); }
});
