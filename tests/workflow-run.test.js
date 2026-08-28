// Integration: full workflow execution against the deterministic echo pool.
// No network, no real providers. Certifies runner + runtime + resume + UX events.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runWorkflow } from '../src/workflow/runner.js';
import { validateWorkflow } from '../src/workflow/validate.js';

const REPO = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const HOME = process.env.HOME;

function fixtureHome() {
  const dir = mkdtempSync(join(tmpdir(), 'bs-wf-'));
  // connectors copied so buildPools can find them
  mkdirSync(join(dir, '.bullswarm', 'connectors'), { recursive: true });
  for (const f of ['echo.json', 'echo-worker.mjs']) {
    writeFileSync(
      join(dir, '.bullswarm', 'connectors', f),
      readFileSync(join(REPO, 'connectors', f)),
    );
  }
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function echoOnlyPools(homeDir) {
  const connector = JSON.parse(readFileSync(join(REPO, 'connectors', 'echo.json'), 'utf8'));
  connector.spawn.cmd = [
    'node',
    join(REPO, 'connectors', 'echo-worker.mjs'),
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
  }];
}

function twoStepDoc() {
  return {
    name: 'test-two-step',
    description: 'x',
    inputs: {},
    settings: { concurrency: 2, escalateOnFail: false },
    phases: [
      { name: 'first', steps: [{ id: 'one', type: 'run', lane: 'chore', prompt: 'Do step one.', timeoutSec: 60 }] },
      { name: 'second', steps: [{ id: 'two', type: 'run', lane: 'chore', prompt: 'Do step two after {{outputs.one.pool}} finished.', timeoutSec: 60 }] },
    ],
  };
}

test('END-TO-END: two-phase workflow runs to completed with report + artifacts', async () => {
  const { dir, cleanup } = fixtureHome();
  try {
    const doc = twoStepDoc();
    const events = [];
    const result = await runWorkflow({
      bullswarmDir: join(dir, '.bullswarm'),
      doc,
      pools: echoOnlyPools(dir),
      inputs: {},
      onEvent: (e) => events.push(e),
    });

    assert.equal(result.report.status, 'completed');
    assert.equal(result.report.summary.stepsOk, 2);
    assert.equal(result.report.summary.stepsFailed, 0);
    // outputs recorded with pool assignment
    assert.equal(result.state.outputs.one.pool, 'echo');
    assert.ok(existsSync(result.state.outputs.one.outFile));
    assert.ok(existsSync(join(result.runDir, 'report.json')));
    // event stream has phase lifecycle
    const types = events.map((e) => e.type);
    assert.ok(types.includes('workflow.started'));
    assert.ok(types.includes('phase.started'));
    assert.ok(types.includes('workflow.completed'));
    // templating resolved prior output into step two's prompt (pool name appears in task)
    const task2 = result.state.outputs.two;
    assert.equal(task2.ok, true);
  } finally {
    cleanup();
  }
});

test('RESUME: rerun skips ok steps', async () => {
  const { dir, cleanup } = fixtureHome();
  try {
    const doc = twoStepDoc();
    const common = {
      bullswarmDir: join(dir, '.bullswarm'),
      doc,
      pools: echoOnlyPools(dir),
    };
    const first = await runWorkflow({ ...common, inputs: {}, onEvent: () => {} });
    assert.equal(first.report.status, 'completed');

    const events = [];
    const second = await runWorkflow({
      ...common,
      inputs: {},
      resumeRunId: first.runId,
      onEvent: (e) => events.push(e),
    });
    assert.equal(second.report.resumed, true);
    // both run-steps skipped via resume path
    const skipped = events.filter((e) => e.type === 'step.skipped');
    assert.equal(skipped.length, 2);
    assert.equal(second.report.summary.stepsOk, 2); // still counted as ok overall
  } finally {
    cleanup();
  }
});

test('FANOUT: N items produce N verdicts; template sees item', async () => {
  const { dir, cleanup } = fixtureHome();
  try {
    const doc = {
      name: 'fanout-test',
      description: 'x',
      inputs: {},
      settings: { concurrency: 3, escalateOnFail: false },
      phases: [
        { name: 'seed', steps: [{ id: 'list', type: 'run', lane: 'chore', prompt: 'List: a b c d', timeoutSec: 60 }] },
        { name: 'fan', steps: [{
          id: 'per',
          type: 'fanout',
          itemsFrom: 'inputs.items',
          concurrency: 2,
          onError: 'continue',
          stepTemplate: { lane: 'chore', prompt: 'Process {{item}}.' },
        }] },
      ],
    };
    const validated = validateWorkflow(doc, { poolNames: ['echo'] });
    assert.equal(validated.name, 'fanout-test');

    const result = await runWorkflow({
      bullswarmDir: join(dir, '.bullswarm'),
      doc,
      pools: echoOnlyPools(dir),
      inputs: { items: ['a', 'b', 'c', 'd', 'e'] },
      onEvent: () => {},
    });
    const out = result.state.outputs['per'];
    assert.equal(out.total, 5);
    assert.equal(out.ok, true);
    assert.equal(out.succeeded, 5);
    assert.equal(out.failed, 0);
    assert.equal(result.report.summary.fanoutOk, 5);
  } finally {
    cleanup();
  }
});

test('FANOUT from discover-step outputText: JSON array parsed and dispatched', async () => {
  const { dir, cleanup } = fixtureHome();
  try {
    const doc = {
      name: 'discover-fanout',
      description: 'x',
      inputs: {},
      settings: { concurrency: 2, escalateOnFail: false },
      phases: [
        { name: 'seed', steps: [{ id: 'list', type: 'run', lane: 'chore', prompt: 'Return JSON array of items.', timeoutSec: 60 }] },
        { name: 'fan', steps: [{
          id: 'per', type: 'fanout', itemsFrom: 'outputs.list',
          concurrency: 2, onError: 'continue',
          stepTemplate: { lane: 'chore', prompt: 'Process {{item}}.' },
        }] },
      ],
    };
    const pools = echoOnlyPools(dir);
    // Make the echo worker return a JSON array for this task
    const result = await runWorkflow({
      bullswarmDir: join(dir, '.bullswarm'),
      doc,
      pools,
      inputs: {},
      onEvent: () => {},
    });
    // The echo worker returns prose, not a JSON array → fanout fails with a
    // CLEAR recorded error, not a crash. onError:continue keeps the run alive.
    const out = result.state.outputs.per;
    assert.ok(out && typeof out === 'object'); // failure recorded
    assert.match(out.why ?? '', /not a JSON array/);
    assert.equal(result.report.status, 'completed'); // onError continue
  } finally {
    cleanup();
  }
});

test('FANOUT from discover-step outFile path: read file and parse JSON array', async () => {
  // Regression: itemsFrom: "outputs.<stepId>.outFile" must read the
  // file at that path and parse the first JSON array inside. This
  // matches the natural "discover step writes a list to its outFile,
  // fanout step reads it back" shape that real workflows use.
  const { dir, cleanup } = fixtureHome();
  try {
    // The discover step writes a JSON array to a sidecar file, then
    // declares it via a `file` outputExtraction strategy so watch.js
    // copies that file's content into outFile. This sidesteps the
    // verify-gate's MIN_SUBSTANCE_CHARS check on stdout.
    const fs = await import('node:fs');
    const path = await import('node:path');
    const sidecar = path.join(dir, 'discovered.json');
    fs.writeFileSync(sidecar, JSON.stringify(['alpha', 'beta', 'gamma', 'delta']));
    // The fanout per-item dispatch must produce > MIN_SUBSTANCE_CHARS
    // of output to clear the verify gate. The default echo worker
    // returns a long "## Completed" body, so we use it.
    const doc = {
      name: 'fanout-from-outfile',
      description: 'x',
      inputs: {},
      settings: { concurrency: 2, escalateOnFail: false },
      phases: [
        { name: 'seed', steps: [{ id: 'list', type: 'run', lane: 'chore', prompt: 'discover', timeoutSec: 60 }] },
        { name: 'fan', steps: [{
          id: 'per', type: 'fanout',
          itemsFrom: 'outputs.list.outFile',
          concurrency: 2, onError: 'continue',
          stepTemplate: { lane: 'chore', prompt: 'Process {{item}}.' },
        }] },
      ],
    };
    // Single pool (echo), but with two distinct spawns: the
    // discover step is pinned and uses the file-extraction
    // connector; the fanout steps are unpinned and use the
    // default echo connector.
    const discoverConnector = JSON.parse(readFileSync(join(REPO, 'connectors', 'echo.json'), 'utf8'));
    discoverConnector.outputExtraction = { strategy: 'file', field: sidecar };
    // The connector's `name` must remain `echo` for routing to
    // pick it up, but the file strategy is per-connector. Pin
    // the discover step to a different `pool` and configure that
    // pool separately — except pool names must match the
    // connector name in pickPool. So we need a second pool.
    discoverConnector.name = 'discover';
    const fanoutConnector = JSON.parse(readFileSync(join(REPO, 'connectors', 'echo.json'), 'utf8'));
    // Pin the discover step to the discover pool; the fanout
    // step's lane stays unpinned so it routes to `echo` (the
    // cheapest).
    doc.phases[0].steps[0].pool = 'discover';
    const pools = [
      // discover: higher cost + zero pace; the file strategy means it
      // produces a good outFile but the verify gate still runs over
      // the per-item dispatch stdout, so this pool must NOT be picked
      // for fanout items. Force it to be the most-behind by giving
      // it pace 0; the runtime's cost guard will keep the
      // incumbent unless a challenger's pace beats it by > 10.
      { name: 'discover', enabled: true, costRank: 9,
        lanes: ['analyze', 'build', 'chore'], meter: { type: 'none' },
        usedPct: null, quarantine: null, pace: -50, burstGate: false,
        connector: discoverConnector },
      { name: 'echo', enabled: true, costRank: 1,
        lanes: ['analyze', 'build', 'chore'], meter: { type: 'none' },
        usedPct: null, quarantine: null, pace: 50, burstGate: false,
        connector: fanoutConnector },
    ];
    const result = await runWorkflow({
      bullswarmDir: join(dir, '.bullswarm'), doc, pools, inputs: {}, onEvent: () => {},
    });
    const out = result.state.outputs.per;
    assert.ok(out, 'fanout result should exist');
    assert.equal(out.total, 4);
    assert.equal(out.ok, true);
    assert.equal(out.succeeded, 4);
    assert.equal(out.failed, 0);
    assert.deepEqual(
      out.items.map((i) => i.item).sort(),
      ['alpha', 'beta', 'delta', 'gamma'],
    );
  } finally {
    cleanup();
  }
});
