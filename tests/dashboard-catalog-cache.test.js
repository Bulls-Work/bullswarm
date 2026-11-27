import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { catalogRows, dashboardRows } from '../src/workflow/dashboard-rows.js';

// Charlie, 27 Nov: the panel sat at ~76% CPU with 1,067 run directories. On the
// Runs page every catalogue rebuild (every 15 s, and whenever an active run
// changed status) parsed every state.json and events.jsonl again: 147 MB of
// state alone on 28 Nov, for runs that finished days ago and never change.

function writeRun(home, index, { finished = true, goal = `run ${index}`, status = 'completed' } = {}) {
  const runId = `wf-cat-${String(index).padStart(4, '0')}`;
  const dir = join(home, 'workflows', runId);
  mkdirSync(dir, { recursive: true });
  const at = new Date(Date.UTC(2026, 10, 20, index)).toISOString();
  writeFileSync(join(dir, 'state.json'), JSON.stringify({
    schemaVersion: 'bullswarm.workflow.state.v2', runId, shortId: `c${String(index).padStart(5, '0')}`,
    lifecycle: { status, startedAt: at, finishedAt: finished ? at : null },
    intent: { goal, cwd: '/tmp' },
    actions: [], attempts: [], planner: { status: 'completed', turns: 1, attempts: [] },
    presentation: { stages: [] }, ledger: { requirements: {} },
  }));
  if (finished) writeFileSync(join(dir, 'rollup.json'), '{}');
  return { runId, dir };
}

const byId = (rows) => Object.fromEntries(rows.map((row) => [row.runId, row]));

test('the Runs catalogue re-reads only the run directories that changed', () => {
  const home = mkdtempSync(join(tmpdir(), 'bs-catalog-'));
  try {
    const runs = [0, 1, 2].map((index) => writeRun(home, index));
    const cache = new Map();
    const first = byId(catalogRows(home, cache));
    assert.equal(Object.keys(first).length, 3);

    const second = byId(catalogRows(home, cache));
    for (const { runId } of runs) {
      assert.equal(second[runId], first[runId], `${runId} unchanged: its row is reused, not re-read`);
    }

    // Run 1 is rewritten (a resume), run 2 is removed, run 3 appears.
    const statePath = join(runs[1].dir, 'state.json');
    writeRun(home, 1, { goal: 'changed after resume' });
    const later = new Date(Date.now() + 60_000);
    utimesSync(statePath, later, later);
    rmSync(runs[2].dir, { recursive: true, force: true });
    const added = writeRun(home, 3);

    const third = byId(catalogRows(home, cache));
    assert.deepEqual(Object.keys(third).sort(), [runs[0].runId, runs[1].runId, added.runId].sort());
    assert.equal(third[runs[0].runId], first[runs[0].runId], 'an untouched run is still reused');
    assert.notEqual(third[runs[1].runId], first[runs[1].runId], 'a changed run is read again');
    assert.equal(third[runs[1].runId].state.intent.goal, 'changed after resume');
    assert.equal(cache.size, 3, 'a removed run leaves the cache');
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('a run without a finished marker is read again on every rebuild', () => {
  const home = mkdtempSync(join(tmpdir(), 'bs-catalog-'));
  try {
    const { runId } = writeRun(home, 0, { finished: false, status: 'running' });
    const cache = new Map();
    const first = byId(catalogRows(home, cache));
    const second = byId(catalogRows(home, cache));
    assert.ok(first[runId]);
    assert.notEqual(second[runId], first[runId], 'its liveness can change without a file changing');
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('the cached catalogue lists the same runs, in the same order, as dashboardRows', () => {
  const home = mkdtempSync(join(tmpdir(), 'bs-catalog-'));
  try {
    for (let index = 0; index < 5; index += 1) writeRun(home, index, { finished: index !== 2, status: index === 2 ? 'running' : 'completed' });
    const cached = catalogRows(home, new Map()).map((row) => [row.runId, row.status]);
    const plain = dashboardRows(home, { all: true }).map((row) => [row.runId, row.status]);
    assert.deepEqual(cached, plain);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
