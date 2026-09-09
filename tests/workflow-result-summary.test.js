import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  deserializeV2ResultEnvelope, summarizeV2Result, validateV2ResultEnvelope,
} from '../src/workflow/v2-outcome.js';

const ROOT = resolve(new URL('..', import.meta.url).pathname);
const BIN = join(ROOT, 'bin', 'bullswarm.js');
const fixture = JSON.parse(readFileSync(join(ROOT, 'tests', 'fixtures', 'real-result-ze5xz2.json'), 'utf8'));

function cli(home, args) {
  return spawnSync(process.execPath, [BIN, ...args], {
    cwd: ROOT,
    env: { ...process.env, BULLSWARM_HOME: home },
    encoding: 'utf8',
  });
}

test('summary is a compact schema-checked status envelope', () => {
  validateV2ResultEnvelope(fixture);
  const summary = summarizeV2Result(fixture);
  const fullBytes = Buffer.byteLength(JSON.stringify(fixture), 'utf8');
  const summaryBytes = Buffer.byteLength(JSON.stringify(summary), 'utf8');
  console.log(`result-summary size: full=${fullBytes} summary=${summaryBytes}`);
  assert.ok(summaryBytes < 4096, `summary ${summaryBytes} bytes must stay below 4096; full envelope is ${fullBytes} bytes`);
  assert.ok(fullBytes > 50_000, `full envelope is only ${fullBytes} bytes`);
  assert.deepEqual(Object.keys(summary).sort(), [
    'actions', 'concerns', 'executionMode', 'finishedAt', 'goal', 'goalBytes',
    'next', 'reason', 'requirements', 'runId', 'schemaVersion', 'shortId',
    'status', 'usage', 'verified',
  ].sort());
  assert.equal(summary.schemaVersion, 'bullswarm.workflow.result-summary.v1');
  assert.equal(summary.goal, fixture.goal.split(/\r?\n/, 1)[0].trim().slice(0, 120));
  assert.equal(summary.goalBytes, Buffer.byteLength(fixture.goal, 'utf8'));
  assert.equal(summary.requirements[0].evidenceCount, 1);
  const whySource = fixture.requirements[0].evidence.at(-1).evidence[0].split(/\r?\n/, 1)[0].trim();
  assert.ok(summary.requirements[0].why === null || whySource.startsWith(summary.requirements[0].why));
  assert.ok((summary.requirements[0].why ?? '').length <= 200);
  assert.equal(summary.concerns.count, fixture.requirements.flatMap((requirement) => requirement.evidence.flatMap((entry) => entry.concerns ?? [])).length);
  assert.ok(summary.concerns.first.length <= 3);
  assert.equal(summary.next.full, `bullswarm workflow runs result ${fixture.shortId} --json`);
  assert.deepEqual(summary.next.outputs, fixture.actions.map((action) => action.outputFile.split('/').at(-1)), 'outputs are basenames');
  assert.equal(summary.next.runDir, fixture.actions[0].outputFile.slice(0, fixture.actions[0].outputFile.lastIndexOf('/')), 'runDir is derived from the output paths when the caller gives none');
  for (const action of summary.actions) assert.ok(!String(action.outFile ?? '').includes('/'), `outFile is a basename: ${action.outFile}`);
});

test('summary fills action routing and attempt fields from durable state', () => {
  const state = {
    program: { actions: [{ id: fixture.actions[0].id, kind: 'implement', lane: 'build', effort: 'medium' }] },
    attempts: [{
      actionId: fixture.actions[0].id,
      pool: 'echo', model: 'fixture-model', wallSec: 7,
      outputFile: '/run/out-attempt.md',
      bytes: { taskFile: 100, authorPrompt: 20, kernel: 80, dependencyInputs: 30, output: 40 },
    }],
  };
  const action = summarizeV2Result(fixture, state).actions[0];
  assert.deepEqual(action, {
    id: fixture.actions[0].id,
    kind: fixture.actions[0].kind,
    lane: 'build', effort: 'medium', status: fixture.actions[0].status,
    pool: 'echo', model: 'fixture-model', reasoning: fixture.actions[0].reasoning.applied,
    wallSec: 7, outFile: 'out-dead-code-attempt-1.md',
    bytes: { taskFile: 100, authorPrompt: 20, kernel: 80, dependencyInputs: 30, output: 40 },
  });
});

test('runs result --summary and --summary --json produce the same completed JSON', () => {
  const home = mkdtempSync(join(tmpdir(), 'bullswarm-result-summary-'));
  const runDir = join(home, 'workflows', fixture.runId);
  mkdirSync(runDir, { recursive: true });
  try {
    writeFileSync(join(runDir, 'state.json'), JSON.stringify({
      schemaVersion: 'bullswarm.workflow.state.v2',
      runId: fixture.runId,
      shortId: fixture.shortId,
      intentId: fixture.intentId,
      intent: { goal: fixture.goal },
      lifecycle: {
        status: fixture.status,
        startedAt: fixture.finishedAt,
        finishedAt: fixture.finishedAt,
        resultFile: join(runDir, 'result.json'),
      },
    }));
    writeFileSync(join(runDir, 'result.json'), JSON.stringify(fixture));
    const implicit = cli(home, ['workflow', 'runs', 'result', fixture.shortId, '--summary']);
    const explicit = cli(home, ['workflow', 'runs', 'result', fixture.shortId, '--summary', '--json']);
    assert.equal(implicit.status, 0, implicit.stderr);
    assert.equal(explicit.status, 0, explicit.stderr);
    assert.equal(implicit.stderr, '');
    assert.equal(explicit.stderr, '');
    assert.equal(implicit.stdout, explicit.stdout);
    assert.equal(JSON.parse(implicit.stdout).schemaVersion, 'bullswarm.workflow.result-summary.v1');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('old result envelopes without byte fields remain valid', () => {
  const old = structuredClone(fixture);
  for (const action of old.actions) delete action.bytes;
  delete old.usage.bytes;
  assert.equal(deserializeV2ResultEnvelope(JSON.stringify(old)).schemaVersion, 'bullswarm.workflow.result.v2');
});
