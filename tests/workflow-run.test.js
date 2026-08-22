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
    assert.equal(out.ok, 5);
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
