// Gap-closure tests for the bullswarm workflow system. Each test pins
// one of the ten gaps closed in this release:
//   G1 childDepthEnv propagation
//   G2 burstGate exclusion
//   G3 quarantine + decisionLog on auth verdicts
//   G4 global concurrency limiter
//   G5 spend guard (maxAgents + warnAtAgents)
//   G6 verify (skeptic) step type
//   G7 TUI item.skipped + step.blocked + workflow.large events
//   G8 fanout resume by content fingerprint
//   G9 inputs.<k>.required enforcement
//  G10 outputText truncation in state.json

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateWorkflow, WorkflowValidationError } from '../src/workflow/validate.js';
import { runWorkflow } from '../src/workflow/runner.js';
import { Semaphore } from '../src/workflow/semaphore.js';
import { plannerBudgetContext } from '../src/workflow/runtime.js';
import { WorkflowTui } from '../src/workflow/tui.js';
import { loadState, saveState, quarantinePool, DEPTH_ENV } from '../src/lib/state.js';

const REPO = new URL('..', import.meta.url).pathname.replace(/\/$/, '');

test('planner budget includes its in-flight dispatch and exposes true remaining slots', () => {
  const context = plannerBudgetContext({
    dispatchesUsed: 9, dispatchLimit: 12, expansionRound: 2, expansionLimit: 4,
  });
  assert.equal(context.dispatchesUsedBeforePlanner, 9);
  assert.equal(context.dispatchesUsed, 10);
  assert.equal(context.remainingDispatches, 2);
  assert.equal(context.includesCurrentPlannerDispatch, true);
});

function fixtureHome() {
  const dir = mkdtempSync(join(tmpdir(), 'bs-wf-gap-'));
  mkdirSync(join(dir, '.bullswarm', 'connectors'), { recursive: true });
  mkdirSync(join(dir, '.bullswarm', 'workflows'), { recursive: true });
  for (const f of ['echo.json', 'echo-worker.mjs']) {
    writeFileSync(
      join(dir, '.bullswarm', 'connectors', f),
      readFileSync(join(REPO, 'connectors', f)),
    );
  }
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function echoOnlyPools(homeDir, workerPath) {
  const connector = JSON.parse(readFileSync(join(REPO, 'connectors', 'echo.json'), 'utf8'));
  connector.spawn.cmd = [
    'node',
    workerPath ?? join(REPO, 'connectors', 'echo-worker.mjs'),
    '{taskFile}',
  ];
  return [{
    name: 'echo',
    connector,
    enabled: true,
    costRank: 5,
    lanes: ['analyze', 'build', 'chore'],
    meter: { type: 'none' },
    usedPct: null,
    quarantine: null,
    pace: 0,
    burstGate: false,
  }];
}

function twoStepDoc(over = {}) {
  return {
    name: 'gap-test',
    description: 'gap closures',
    inputs: {},
    settings: { concurrency: 2, escalateOnFail: false, ...(over.settings ?? {}) },
    phases: [
      { name: 'first', steps: [{ id: 'one', type: 'run', lane: 'chore', prompt: 'do one', timeoutSec: 60 }] },
      { name: 'second', steps: [{ id: 'two', type: 'run', lane: 'chore', prompt: 'do two', timeoutSec: 60 }] },
    ],
    ...over,
  };
}

// -------------------------------------------------------------------------
// G4: Semaphore enforces concurrency cap
// -------------------------------------------------------------------------

test('G4: Semaphore blocks callers when permits are exhausted', async () => {
  const sem = new Semaphore(2);
  let active = 0;
  let maxActive = 0;
  const work = async (n) => {
    await sem.acquire();
    try {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 30));
      active -= 1;
    } finally {
      sem.release();
    }
    return n;
  };
  const results = await Promise.all([work(1), work(2), work(3), work(4), work(5)]);
  assert.deepEqual(results, [1, 2, 3, 4, 5]);
  assert.equal(maxActive, 2);
  assert.equal(sem.available, 2);
  assert.equal(sem.queueDepth, 0);
});

test('G4: Semaphore never leaks permits on exception', async () => {
  const sem = new Semaphore(1);
  await assert.rejects(async () => {
    await sem.runWith(async () => { throw new Error('boom'); });
  }, /boom/);
  assert.equal(sem.available, 1);
  // A second caller can still acquire after the throw.
  const r = await sem.runWith(async () => 42);
  assert.equal(r, 42);
});

// -------------------------------------------------------------------------
// G1: childDepthEnv propagation — verify watchOnce is called with the
// depth env by reading the run state and watching for a recursion-guard
// failure when the env is already at the limit.
// -------------------------------------------------------------------------

test('G1: workflow respects the recursion-guard env at the depth limit', async () => {
  const { dir, cleanup } = fixtureHome();
  try {
    // Set the depth limit to 0 so any workflow dispatch is refused.
    const state = loadState(join(dir, '.bullswarm'));
    state.config.depthLimit = 0;
    saveState(join(dir, '.bullswarm'), state);

    const doc = twoStepDoc();
    const events = [];
    const result = await runWorkflow({
      bullswarmDir: join(dir, '.bullswarm'),
      doc,
      pools: echoOnlyPools(dir),
      inputs: {},
      onEvent: (e) => events.push(e),
      // simulate the CLI spawning the workflow with BULLSWARM_DEPTH=0
      env: { ...process.env, [DEPTH_ENV]: '0' },
    });
    // Both steps must fail with the recursion-guard reason.
    assert.equal(result.state.outputs.one.ok, false);
    assert.equal(result.state.outputs.two.ok, false);
    assert.match(result.state.outputs.one.why, /recursion guard/);
    assert.match(result.state.outputs.two.why, /recursion guard/);
  } finally {
    cleanup();
  }
});

test('G1: workflow increments depth for every dispatched child', async () => {
  const { dir, cleanup } = fixtureHome();
  try {
    const doc = twoStepDoc();
    // ES module exports of `node:child_process` are read-only. We
    // monkey-patch the spawn that's bundled into `src/lib/watch.js` via
    // require interception. Simpler: capture depth by writing a small
    // worker that prints the env it received.
    const newWorker = join(dir, 'depth-worker.mjs');
    writeFileSync(newWorker, [
      'import { readFileSync } from "node:fs";',
      'readFileSync(process.argv[2], "utf8");',
      'const filler = "x".repeat(120);',
      'process.stdout.write(filler + " depth=" + (process.env.BULLSWARM_DEPTH ?? "missing"));',
      'process.exit(0);',
    ].join('\n'));

    const result = await runWorkflow({
      bullswarmDir: join(dir, '.bullswarm'),
      doc,
      pools: echoOnlyPools(dir, newWorker),
      inputs: {},
      onEvent: () => {},
      env: { ...process.env, [DEPTH_ENV]: '1' },
    });
    const a = result.state.outputs.one;
    const b = result.state.outputs.two;
    assert.match(a.outputText, /depth=2/);
    assert.match(b.outputText, /depth=2/);
  } finally {
    cleanup();
  }
});

// -------------------------------------------------------------------------
// G2: burstGate exclusion — a pool with burstGate=true must be skipped.
// -------------------------------------------------------------------------

test('G2: workflow excludes burst-gated pools from dispatch', async () => {
  const { dir, cleanup } = fixtureHome();
  try {
    const pools = echoOnlyPools(dir);
    // Mark echo as burst-gated; no other pool exists → no eligible pool.
    pools[0].burstGate = true;
    const doc = twoStepDoc();
    const result = await runWorkflow({
      bullswarmDir: join(dir, '.bullswarm'),
      doc,
      pools,
      inputs: {},
      onEvent: () => {},
    });
    assert.equal(result.state.outputs.one.ok, false);
    assert.match(result.state.outputs.one.why, /no eligible pool/);
  } finally {
    cleanup();
  }
});

// -------------------------------------------------------------------------
// G3: quarantine + decisionLog on auth verdicts from inside a workflow.
// We seed a connector whose authSignatures match the echo worker's FAIL:auth
// directive, run a workflow step, then assert the pool is quarantined and
// a decisionLog entry was written.
// -------------------------------------------------------------------------

test('G3: workflow auth verdicts quarantine the pool and log to decisionLog', async () => {
  const { dir, cleanup } = fixtureHome();
  try {
    // Patch the echo connector to advertise the FAIL:auth signature.
    const connectorsDir = join(dir, '.bullswarm', 'connectors');
    const echo = JSON.parse(readFileSync(join(connectorsDir, 'echo.json'), 'utf8'));
    echo.authSignatures = ['Authentication failed', 'unauthorized'];
    writeFileSync(join(connectorsDir, 'echo.json'), JSON.stringify(echo, null, 2));

    const pools = [{
      name: 'echo',
      connector: {
        ...echo,
        spawn: { cmd: ['node', join(REPO, 'connectors', 'echo-worker.mjs'), '{taskFile}'], cwdMode: 'task-file-dir' },
      },
      enabled: true,
      costRank: 5,
      lanes: ['analyze', 'build', 'chore'],
      meter: { type: 'none' },
      usedPct: null,
      quarantine: null,
      pace: 0,
      burstGate: false,
    }];
    const doc = {
      name: 'g3-quarantine',
      description: 'g',
      inputs: {},
      settings: { concurrency: 1, escalateOnFail: false },
      phases: [
        { name: 'p', steps: [{ id: 'k', type: 'run', lane: 'chore', prompt: 'FAIL:auth please', timeoutSec: 60 }] },
      ],
    };
    const result = await runWorkflow({
      bullswarmDir: join(dir, '.bullswarm'),
      doc,
      pools,
      inputs: {},
      onEvent: () => {},
    });
    // Step failed AND pool was quarantined.
    assert.equal(result.state.outputs.k.ok, false);
    assert.match(result.state.outputs.k.why, /auth\/throttle signature/);
    const coreState = loadState(join(dir, '.bullswarm'));
    assert.ok(coreState.pools.echo?.quarantine, 'pool was not quarantined');
    // decisionLog was appended for this workflow dispatch.
    const last = coreState.decisionLog[coreState.decisionLog.length - 1];
    assert.equal(last.source, 'workflow');
    assert.equal(last.picked, 'echo');
    assert.equal(last.ok, false);
    assert.equal(last.stepId, 'k');
    assert.ok(last.outFile && existsSync(last.outFile));
  } finally {
    cleanup();
  }
});

// -------------------------------------------------------------------------
// G5: spend guard — maxAgents hard cap and warnAtAgents event.
// -------------------------------------------------------------------------

test('G5: maxAgents=2 stops the third step from dispatching', async () => {
  const { dir, cleanup } = fixtureHome();
  try {
    const doc = {
      name: 'g5-cap',
      description: 'g',
      inputs: {},
      settings: { concurrency: 1, escalateOnFail: false, maxAgents: 2 },
      phases: [
        { name: 'p', steps: [
          { id: 'a', type: 'run', lane: 'chore', prompt: 'a', timeoutSec: 60 },
          { id: 'b', type: 'run', lane: 'chore', prompt: 'b', timeoutSec: 60 },
          { id: 'c', type: 'run', lane: 'chore', prompt: 'c', timeoutSec: 60 },
        ] },
      ],
    };
    const result = await runWorkflow({
      bullswarmDir: join(dir, '.bullswarm'),
      doc,
      pools: echoOnlyPools(dir),
      inputs: {},
      onEvent: () => {},
    });
    // a and b succeed; c is blocked by the cap.
    assert.equal(result.state.outputs.a.ok, true);
    assert.equal(result.state.outputs.b.ok, true);
    assert.equal(result.state.outputs.c.ok, false);
    assert.match(result.state.outputs.c.why, /spend guard/);
    assert.equal(result.state.status, 'budget_exhausted');
  } finally {
    cleanup();
  }
});

test('G5: warnAtAgents emits a workflow.large event once', async () => {
  const { dir, cleanup } = fixtureHome();
  try {
    const doc = {
      name: 'g5-warn',
      description: 'g',
      inputs: {},
      settings: { concurrency: 1, escalateOnFail: false, warnAtAgents: 2 },
      phases: [
        { name: 'p', steps: [
          { id: 'a', type: 'run', lane: 'chore', prompt: 'a', timeoutSec: 60 },
          { id: 'b', type: 'run', lane: 'chore', prompt: 'b', timeoutSec: 60 },
          { id: 'c', type: 'run', lane: 'chore', prompt: 'c', timeoutSec: 60 },
        ] },
      ],
    };
    const events = [];
    await runWorkflow({
      bullswarmDir: join(dir, '.bullswarm'),
      doc,
      pools: echoOnlyPools(dir),
      inputs: {},
      onEvent: (e) => events.push(e),
    });
    const warns = events.filter((e) => e.type === 'workflow.large');
    assert.equal(warns.length, 1);
    assert.equal(warns[0].threshold, 2);
    assert.ok(warns[0].dispatchCount >= 2);
  } finally {
    cleanup();
  }
});

test('retryAttempts repeats a pinned pool invocation up to the configured bound', async () => {
  const { dir, cleanup } = fixtureHome();
  try {
    const worker = join(dir, 'retry-worker.mjs');
    writeFileSync(worker, [
      'import { existsSync, writeFileSync } from "node:fs";',
      'const marker = process.argv[2] + ".attempt";',
      'const first = !existsSync(marker);',
      'writeFileSync(marker, "seen");',
      'process.stdout.write(first ? "I will try again" : "The retry succeeded with a concrete report containing enough detail to pass verification.");',
    ].join('\n'));
    const connector = JSON.parse(readFileSync(join(REPO, 'connectors', 'echo.json'), 'utf8'));
    connector.spawn.cmd = ['node', worker, '{taskFile}'];
    const result = await runWorkflow({
      bullswarmDir: join(dir, '.bullswarm'),
      doc: {
        name: 'retry-bound', description: 'retry', inputs: {},
        settings: { concurrency: 1, escalateOnFail: true, retryAttempts: 1 },
        phases: [{ name: 'p', steps: [{ id: 'r', type: 'run', pool: 'echo', lane: 'chore', prompt: 'retry', timeoutSec: 60 }] }],
      },
      pools: [{ name: 'echo', connector, enabled: true, costRank: 1, lanes: ['chore'], meter: { type: 'none' }, pace: 0 }],
      inputs: {}, onEvent: () => {},
    });
    assert.equal(result.state.outputs.r.ok, true);
  } finally { cleanup(); }
});

// -------------------------------------------------------------------------
// G6: verify (skeptic) step type — validation + runtime.
// -------------------------------------------------------------------------

test('G6: verify step validates (missing review is a hard error)', () => {
  assert.throws(
    () => validateWorkflow({
      name: 'v', description: 'x', inputs: {}, settings: {},
      phases: [{ name: 'p', steps: [{ id: 's', type: 'verify', prompt: 'go' }] }],
    }, { poolNames: ['echo'] }),
    (err) => err instanceof WorkflowValidationError
      && err.issues.some((i) => i.includes('review')),
  );
});

test('G6: verify step accepts a known prior outFile reference', () => {
  const r = validateWorkflow({
    name: 'v', description: 'x', inputs: {}, settings: {},
    phases: [
      { name: 'p1', steps: [{ id: 'a', type: 'run', lane: 'chore', prompt: 'a' }] },
      { name: 'p2', steps: [{
        id: 'v', type: 'verify', lane: 'analyze', review: 'outputs.a.outFile', prompt: 'check it',
      }] },
    ],
  }, { poolNames: ['echo'] });
  assert.equal(r.name, 'v');
});

test('G6: verify step accepts an inputs.<declaredInput> reference', () => {
  const r = validateWorkflow({
    name: 'v', description: 'x',
    inputs: { target: { default: '/tmp/x' } },
    settings: {},
    phases: [{
      name: 'p', steps: [{
        id: 'v', type: 'verify', lane: 'analyze', review: 'inputs.target', prompt: 'check it',
      }],
    }],
  }, { poolNames: ['echo'] });
  assert.equal(r.name, 'v');
});

test('G6: verify step parses a JSON {ok:bool, concerns, summary} response', async () => {
  const { dir, cleanup } = fixtureHome();
  try {
    // A schema-valid verifier JSON object is substantive even when it is
    // shorter than the generic prose gate's minimum length.
    const newWorker = join(dir, 'verify-worker.mjs');
    writeFileSync(newWorker, [
      'import { readFileSync } from "node:fs";',
      'const task = readFileSync(process.argv[2], "utf8");',
      'const out = task.includes("RETURN ONLY a single JSON object")',
      '  ? JSON.stringify({ ok: true, concerns: [], summary: "echo verifier" })',
      '  : "Completed the bounded source task with concrete inspection evidence and a durable artifact for independent downstream verification.";',
      'process.stdout.write(out);',
      'process.exit(0);',
    ].join('\n'));

    const doc = {
      name: 'g6-runtime',
      description: 'g',
      inputs: {},
      settings: { concurrency: 1, escalateOnFail: false },
      phases: [
        { name: 'p', steps: [
          { id: 'a', type: 'run', lane: 'chore', prompt: 'thing to review', timeoutSec: 60 },
          { id: 'v', type: 'verify', lane: 'analyze', review: 'outputs.a.outFile', prompt: 'judge it', timeoutSec: 60 },
        ] },
      ],
    };
    const result = await runWorkflow({
      bullswarmDir: join(dir, '.bullswarm'),
      doc,
      pools: echoOnlyPools(dir, newWorker),
      inputs: {},
      onEvent: () => {},
    });
    assert.equal(result.state.outputs.a.ok, true);
    assert.equal(result.state.outputs.v.ok, true);
    assert.equal(result.state.outputs.v.verify.ok, true);
    assert.equal(result.state.outputs.v.verify.summary, 'echo verifier');
  } finally {
    cleanup();
  }
});

test('G6: verify step fails the run when the JSON response says ok:false', async () => {
  const { dir, cleanup } = fixtureHome();
  try {
    const newWorker = join(dir, 'verify-fail-worker.mjs');
    writeFileSync(newWorker, [
      'import { readFileSync } from "node:fs";',
      'readFileSync(process.argv[2], "utf8");',
      'const filler = "x".repeat(120);',
      'const out = filler + " VERDICT: " + JSON.stringify({ ok: false, concerns: ["nope"], summary: "rejected" });',
      'process.stdout.write(out);',
      'process.exit(0);',
    ].join('\n'));
    const doc = {
      name: 'g6-fail',
      description: 'g',
      inputs: {},
      settings: { concurrency: 1, escalateOnFail: false },
      phases: [
        { name: 'p', steps: [
          { id: 'a', type: 'run', lane: 'chore', prompt: 'a', timeoutSec: 60 },
          { id: 'v', type: 'verify', lane: 'analyze', review: 'outputs.a.outFile', prompt: 'judge', timeoutSec: 60 },
        ] },
      ],
    };
    const result = await runWorkflow({
      bullswarmDir: join(dir, '.bullswarm'),
      doc,
      pools: echoOnlyPools(dir, newWorker),
      inputs: {},
      onEvent: () => {},
    });
    assert.equal(result.state.outputs.v.ok, false);
    assert.ok(result.state.outputs.v.verify);
    assert.equal(result.state.outputs.v.verify.ok, false);
  } finally {
    cleanup();
  }
});

test('G6: custom verify prompt still includes the reviewed artifact', async () => {
  const { dir, cleanup } = fixtureHome();
  try {
    const newWorker = join(dir, 'verify-target-worker.mjs');
    writeFileSync(newWorker, [
      'import { readFileSync } from "node:fs";',
      'const task = readFileSync(process.argv[2], "utf8");',
      'const ok = task.includes("BEGIN REVIEW TARGET") && task.includes("END REVIEW TARGET") && task.includes("RETURN ONLY a single JSON object");',
      'const out = "x".repeat(120) + JSON.stringify({ ok, concerns: [], summary: ok ? "target supplied" : "target missing" });',
      'process.stdout.write(out);',
      'process.exit(0);',
    ].join('\n'));
    const doc = {
      name: 'g6-custom-prompt', description: 'g', inputs: {},
      settings: { concurrency: 1, escalateOnFail: false },
      phases: [{ name: 'p', steps: [
        { id: 'a', type: 'run', lane: 'chore', prompt: 'thing to review', timeoutSec: 60 },
        { id: 'v', type: 'verify', lane: 'analyze', review: 'outputs.a.outFile', prompt: 'Use the supplied artifact and return JSON.', timeoutSec: 60 },
      ] }],
    };
    const result = await runWorkflow({
      bullswarmDir: join(dir, '.bullswarm'), doc, pools: echoOnlyPools(dir, newWorker), inputs: {}, onEvent: () => {},
    });
    assert.equal(result.state.outputs.v.ok, true);
    assert.equal(result.state.outputs.v.verify.summary, 'target supplied');
  } finally { cleanup(); }
});

// -------------------------------------------------------------------------
// G7: TUI handles item.skipped, step.blocked, workflow.large
// -------------------------------------------------------------------------

test('G7: TUI renders item.skipped, step.blocked, workflow.large (json mode)', () => {
  const lines = [];
  const oldLog = console.log;
  console.log = (...a) => lines.push(a.join(' '));
  try {
    const tui = new WorkflowTui({ json: true, quiet: false });
    tui.handle({ type: 'item.skipped', stepId: 'fan', index: 2, item: 'foo' });
    tui.handle({ type: 'step.blocked', stepId: 'fan', queued: 7 });
    tui.handle({ type: 'workflow.large', threshold: 25, dispatchCount: 26 });
  } finally {
    console.log = oldLog;
  }
  const evTypes = lines.map((l) => JSON.parse(l).ev);
  assert.ok(evTypes.includes('item.skipped'));
  assert.ok(evTypes.includes('step.blocked'));
  assert.ok(evTypes.includes('workflow.large'));
});

// -------------------------------------------------------------------------
// G8: fanout resume is content-fingerprint aligned
// -------------------------------------------------------------------------

test('G8: fanout resume skips by item fingerprint even when order changes', async () => {
  const { dir, cleanup } = fixtureHome();
  try {
    const common = {
      bullswarmDir: join(dir, '.bullswarm'),
      pools: echoOnlyPools(dir),
    };
    // First run: process items in order [a, b, c].
    const doc1 = {
      name: 'g8', description: 'g', inputs: {},
      settings: { concurrency: 2, escalateOnFail: false },
      phases: [
        { name: 'seed', steps: [{ id: 's', type: 'run', lane: 'chore', prompt: 'seed', timeoutSec: 60 }] },
        { name: 'fan', steps: [{
          id: 'fan', type: 'fanout', itemsFrom: 'inputs.items',
          concurrency: 2, onError: 'continue',
          stepTemplate: { lane: 'chore', prompt: 'Process {{item}}.' },
        }] },
      ],
    };
    const first = await runWorkflow({
      ...common, doc: doc1, inputs: { items: ['a', 'b', 'c'] }, onEvent: () => {},
    });
    assert.equal(first.state.outputs.fan.total, 3);
    assert.equal(first.state.outputs.fan.ok, 3);

    // Second run: same doc, items in a different order with one extra.
    const events = [];
    const second = await runWorkflow({
      ...common, doc: doc1, inputs: { items: ['c', 'a', 'b', 'd'] },
      resumeRunId: first.runId, onEvent: (e) => events.push(e),
    });
    // 3 items were skipped via fingerprint; 1 ('d') ran fresh.
    const skipped = events.filter((e) => e.type === 'item.skipped');
    assert.equal(skipped.length, 3);
    // The new item 'd' must be in the final outputs.
    const items = second.state.outputs.fan.items.map((r) => r.item);
    assert.ok(items.includes('d'));
    assert.equal(second.state.outputs.fan.ok, 4);
    assert.equal(second.state.outputs.fan.failed, 0);
  } finally {
    cleanup();
  }
});

// -------------------------------------------------------------------------
// G9: inputs.<k>.required enforced at validate and runtime.
// -------------------------------------------------------------------------

test('G9: required input declared, template does not reference it → no warning', () => {
  // The validator only warns when a template refs an UNDECLARED input.
  // Declared-but-required inputs are silent at validate time; the
  // runtime refuses to dispatch if the value is missing.
  const r = validateWorkflow({
    name: 'g9v', description: 'g',
    inputs: { where: { required: true } },
    settings: {},
    phases: [{ name: 'p', steps: [{ id: 's', type: 'run', lane: 'chore', prompt: 'x' }] }],
  }, { poolNames: ['echo'] });
  assert.equal(r.name, 'g9v');
  // declared + used → no warning; declared + unused → also no warning.
  assert.deepEqual(r.warnings, []);
});

test('G9: undeclared required input usage is a warning at validate', () => {
  // Even required-flagged, the warning logic is about declaration.
  const r = validateWorkflow({
    name: 'g9v2', description: 'g',
    inputs: { where: { required: true } },
    settings: {},
    phases: [{ name: 'p', steps: [{
      id: 's', type: 'run', lane: 'chore', prompt: 'go to {{inputs.elsewhere}}',
    }] }],
  }, { poolNames: ['echo'] });
  assert.ok(r.warnings.some((w) => w.includes('elsewhere')));
});

test('G9: required input missing → runWorkflow throws before any dispatch', async () => {
  const { dir, cleanup } = fixtureHome();
  try {
    const doc = {
      name: 'g9r', description: 'g',
      inputs: { where: { required: true } },
      settings: { concurrency: 1, escalateOnFail: false },
      phases: [{ name: 'p', steps: [{ id: 's', type: 'run', lane: 'chore', prompt: 'x' }] }],
    };
    await assert.rejects(
      runWorkflow({
        bullswarmDir: join(dir, '.bullswarm'), doc, pools: echoOnlyPools(dir),
        inputs: {}, onEvent: () => {},
      }),
      /required input "where" missing/,
    );
  } finally {
    cleanup();
  }
});

test('G9: required input with --input value → runWorkflow proceeds', async () => {
  const { dir, cleanup } = fixtureHome();
  try {
    const doc = {
      name: 'g9p', description: 'g',
      inputs: { where: { required: true } },
      settings: { concurrency: 1, escalateOnFail: false },
      phases: [{ name: 'p', steps: [{ id: 's', type: 'run', lane: 'chore', prompt: 'go to {{inputs.where}}' }] }],
    };
    const result = await runWorkflow({
      bullswarmDir: join(dir, '.bullswarm'), doc, pools: echoOnlyPools(dir),
      inputs: { where: '/tmp' }, onEvent: () => {},
    });
    assert.equal(result.state.outputs.s.ok, true);
  } finally {
    cleanup();
  }
});

// -------------------------------------------------------------------------
// G10: outputText persisted in state.json is truncated above the cap.
// -------------------------------------------------------------------------

test('G10: long step output is truncated in state.json; full file on disk', async () => {
  const { dir, cleanup } = fixtureHome();
  try {
    // The connector's `outputExtraction.strategy: "file"` reads its
    // payload from a path the worker writes to directly. This
    // sidesteps the 64 KB spawn-pipe limit on macOS, which is
    // non-deterministic and can't be relied on for a CI test.
    const hugeFile = join(dir, 'huge-payload.md');
    writeFileSync(hugeFile, 'X'.repeat(80_000));

    const newWorker = join(dir, 'huge-worker.mjs');
    writeFileSync(newWorker, [
      'import { readFileSync } from "node:fs";',
      'readFileSync(process.argv[2], "utf8");',
      // Worker just touches the test-prepared file path to mark the
      // run done. Crucially, it does NOT clear or modify the file —
      // the test pre-wrote the 80 KB payload there and we want
      // `extractOutput`'s `file` strategy to read that exact content.
      'process.exit(0);',
    ].join('\n'));

    const connector = JSON.parse(readFileSync(join(REPO, 'connectors', 'echo.json'), 'utf8'));
    connector.spawn.cmd = ['node', newWorker, '{taskFile}'];
    connector.outputExtraction = { strategy: 'file', field: hugeFile };
    const pools = [{
      name: 'echo', connector, enabled: true, costRank: 5,
      lanes: ['analyze', 'build', 'chore'], meter: { type: 'none' },
      usedPct: null, quarantine: null, pace: 0, burstGate: false,
    }];

    const doc = {
      name: 'g10', description: 'g', inputs: {},
      settings: { concurrency: 1, escalateOnFail: false },
      phases: [{ name: 'p', steps: [{ id: 'a', type: 'run', lane: 'chore', prompt: 'big', timeoutSec: 60 }] }],
    };
    const result = await runWorkflow({
      bullswarmDir: join(dir, '.bullswarm'),
      doc,
      pools,
      inputs: {},
      onEvent: () => {},
    });
    // The persisted state.json must show truncation.
    const persisted = JSON.parse(readFileSync(
      join(result.runDir, 'state.json'), 'utf8',
    ));
    assert.equal(persisted.outputs.a.ok, true, `step failed: ${persisted.outputs.a.why}`);
    assert.equal(persisted.outputs.a.outputTruncated, true);
    assert.equal(persisted.outputs.a.outputText.length, 64 * 1024);
    // The on-disk outFile must still hold the full 80 KB body.
    const onDisk = readFileSync(persisted.outputs.a.outFile, 'utf8');
    assert.equal(onDisk.length, 80_000);
  } finally {
    cleanup();
  }
});

// -------------------------------------------------------------------------
// Misc: validate new settings (maxAgents, concurrency cap) + invalid inputs
// -------------------------------------------------------------------------

test('validate: rejects non-integer maxAgents', () => {
  assert.throws(
    () => validateWorkflow({
      name: 'v', description: 'x', inputs: {},
      settings: { maxAgents: 1.5 },
      phases: [{ name: 'p', steps: [{ id: 's', type: 'run', lane: 'chore', prompt: 'x' }] }],
    }, { poolNames: ['echo'] }),
    (err) => err.issues.some((i) => i.includes('maxAgents')),
  );
});

test('validate: rejects concurrency > 16', () => {
  assert.throws(
    () => validateWorkflow({
      name: 'v', description: 'x', inputs: {},
      settings: { concurrency: 32 },
      phases: [{ name: 'p', steps: [{ id: 's', type: 'run', lane: 'chore', prompt: 'x' }] }],
    }, { poolNames: ['echo'] }),
    (err) => err.issues.some((i) => i.includes('concurrency')),
  );
});

test('validate: required input must be boolean', () => {
  assert.throws(
    () => validateWorkflow({
      name: 'v', description: 'x',
      inputs: { x: { required: 'yes' } },
      settings: {},
      phases: [{ name: 'p', steps: [{ id: 's', type: 'run', lane: 'chore', prompt: 'x' }] }],
    }, { poolNames: ['echo'] }),
    (err) => err.issues.some((i) => i.includes('required must be a boolean')),
  );
});

test('watch: outputExtraction.file reads from a file path declared in field', async () => {
  const { watchOnce } = await import('../src/lib/watch.js');
  const fs = await import('node:fs');
  const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join((await import('node:os')).tmpdir(), 'bs-file-'));
  const payload = 'X'.repeat(100);
  const payloadFile = path.join(dir, 'payload.md');
  fs.writeFileSync(payloadFile, payload);
  const worker = path.join(dir, 'writer.mjs');
  fs.writeFileSync(worker, 'process.argv[2]; process.exit(0);');
  const connector = {
    name: 'file-conn',
    spawn: { cmd: ['node', worker, '{taskFile}'], cwdMode: 'task-file-dir' },
    outputExtraction: { strategy: 'file', field: payloadFile },
    authSignatures: [],
    timeoutSec: 30,
  };
  try {
    const v = await watchOnce(
      connector,
      'x',
      dir,
      { taskFile: path.join(dir, 'task.md'), outFile: path.join(dir, 'out.md') },
      { timeoutSec: 30 },
    );
    assert.equal(v.ok, true);
    assert.match(fs.readFileSync(path.join(dir, 'out.md'), 'utf8'), new RegExp(`^X{100}$`));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
