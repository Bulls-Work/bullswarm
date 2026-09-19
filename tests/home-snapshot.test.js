import test from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { snapshotHome } from '../src/home-cli.js';

function fixtureRun(home, runId, shortId, startedAt, { streams = false } = {}) {
  const dir = join(home, 'workflows', runId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'state.json'), JSON.stringify({
    schemaVersion: 'bullswarm.workflow.state.v2',
    runId,
    shortId,
    intent: { goal: `goal for ${runId}`, cwd: home },
    lifecycle: {
      status: 'completed',
      startedAt,
      finishedAt: new Date(Date.parse(startedAt) + 60_000).toISOString(),
    },
    actions: [],
    attempts: [],
    ledger: { requirements: {} },
  }));
  writeFileSync(join(dir, 'result.json'), JSON.stringify({ status: 'completed' }));
  writeFileSync(join(dir, 'out-step.md'), 'durable output');
  if (streams) {
    writeFileSync(join(dir, 'stream-step.jsonl'), '{"kind":"response"}\n');
    writeFileSync(join(dir, 'stdout-step.log'), 'worker stdout\n');
    writeFileSync(join(dir, 'events.jsonl'), '{"seq":1}\n');
  }
}

function fixtureHome() {
  const home = mkdtempSync(join(tmpdir(), 'bullswarm-home-source-'));
  writeFileSync(join(home, 'state.json'), JSON.stringify({
    version: 1,
    pools: {},
    decisionLog: [{ kind: 'run', id: 'task-1', startedAt: '2026-09-18T00:00:00.000Z' }],
    strategy: { subscriptions: { demo: { monthlyPriceUsd: 20 } } },
  }));
  writeFileSync(join(home, 'routing.json'), '{"build":["demo"]}');
  writeFileSync(join(home, 'providers.json'), '{"enabled":["demo"]}');
  mkdirSync(join(home, 'meters', 'history'), { recursive: true });
  writeFileSync(join(home, 'meters', 'demo.json'), '{"weekly":{"usedPct":4}}');
  writeFileSync(join(home, 'meters', 'history', 'demo.jsonl'), '{"weekly":{"usedPct":3}}\n');
  mkdirSync(join(home, 'connectors'), { recursive: true });
  writeFileSync(join(home, 'connectors', 'demo.json'), '{"name":"demo"}');
  mkdirSync(join(home, 'calibration'), { recursive: true });
  writeFileSync(join(home, 'calibration', 'demo.json'), '{"sampleCount":3}');
  mkdirSync(join(home, 'assignments'), { recursive: true });
  writeFileSync(join(home, 'assignments', 'task.json'), '{"source":"run"}');
  mkdirSync(join(home, 'runs'), { recursive: true });
  writeFileSync(join(home, 'runs', 'task-1.md'), 'task prompt');
  writeFileSync(join(home, 'runs', 'out-1.md'), 'task output');
  fixtureRun(home, 'wf-old-run', 'abc234', '2026-09-15T00:00:00.000Z');
  fixtureRun(home, 'wf-mid-run', 'def345', '2026-09-17T00:00:00.000Z');
  fixtureRun(home, 'wf-new-run', 'ghi456', '2026-09-19T00:00:00.000Z', { streams: true });
  fixtureRun(home, 'wf-newest-run', 'jkm567', '2026-09-20T00:00:00.000Z');
  return home;
}

test('snapshot keeps the newest workflow slice, task surfaces, and a rebuilt index', () => {
  const source = fixtureHome();
  const destination = join(mkdtempSync(join(tmpdir(), 'bullswarm-home-dest-')), 'snapshot');
  try {
    const result = snapshotHome(destination, { source, recent: 3, noStreams: true });
    assert.deepEqual(result.runIds, ['wf-newest-run', 'wf-new-run', 'wf-mid-run']);
    assert.equal(result.count, 3);
    assert.equal(existsSync(join(destination, 'state.json')), true);
    assert.equal(existsSync(join(destination, 'runs', 'task-1.md')), true);
    assert.equal(existsSync(join(destination, 'meters', 'history', 'demo.jsonl')), true);
    assert.equal(existsSync(join(destination, 'calibration', 'demo.json')), true);
    assert.equal(existsSync(join(destination, 'workflows', 'wf-old-run')), false);
    assert.equal(JSON.parse(readFileSync(join(destination, '.snapshot.json'), 'utf8')).kind, 'bullswarm-home-snapshot');
    assert.equal(existsSync(join(destination, 'workflows', 'wf-new-run', 'stream-step.jsonl')), false);
    assert.equal(existsSync(join(destination, 'workflows', 'wf-new-run', 'stdout-step.log')), false);
    assert.equal(existsSync(join(destination, 'workflows', 'wf-new-run', 'events.jsonl')), true);
    const indexLines = readFileSync(join(destination, 'history', 'runs.jsonl'), 'utf8')
      .trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
    assert.deepEqual(indexLines.map((line) => line.runId).sort(), result.runIds.slice().sort());
    assert.equal(readFileSync(join(source, 'state.json'), 'utf8'), readFileSync(join(destination, 'state.json'), 'utf8'));
  } finally {
    rmSync(source, { recursive: true, force: true });
    rmSync(destination, { recursive: true, force: true });
  }
});

test('explicit run ids and since bounds select only matching directories', () => {
  const source = fixtureHome();
  const destination = join(mkdtempSync(join(tmpdir(), 'bullswarm-home-dest-')), 'snapshot');
  try {
    const result = snapshotHome(destination, {
      source,
      runs: 'abc234,ghi456,jkm567',
      since: '2026-09-18',
    });
    assert.deepEqual(result.runIds, ['wf-newest-run', 'wf-new-run']);
    assert.equal(existsSync(join(destination, 'workflows', 'wf-old-run')), false);
    assert.equal(existsSync(join(destination, 'workflows', 'wf-mid-run')), false);
    assert.equal(readdirSync(join(destination, 'workflows')).length, 2);
  } finally {
    rmSync(source, { recursive: true, force: true });
    rmSync(destination, { recursive: true, force: true });
  }
});

test('snapshot refuses live-home descendants and non-empty destinations', () => {
  const source = fixtureHome();
  const nested = join(source, 'nested-snapshot');
  const nestedDeep = join(source, 'nested', 'deep', 'snapshot');
  const nonEmpty = mkdtempSync(join(tmpdir(), 'bullswarm-home-nonempty-'));
  try {
    assert.throws(() => snapshotHome(nested, { source }), /inside live Bullswarm home/);
    assert.throws(() => snapshotHome(nestedDeep, { source }), /inside live Bullswarm home/);
    writeFileSync(join(nonEmpty, 'keep.txt'), 'keep');
    assert.throws(() => snapshotHome(nonEmpty, { source }), /destination is not empty/);
  } finally {
    rmSync(source, { recursive: true, force: true });
    rmSync(nonEmpty, { recursive: true, force: true });
  }
});
