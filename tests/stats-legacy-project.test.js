// Project identity for the pre-project single-task decision-log shape.
// The base object below is a trimmed record copied from the real home at
// /tmp/bsw-fixproj/state.json (the 2026-09-11 grok run). It intentionally
// keeps the old `picked`/`outFile` discriminator and omits the newer fields.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { listTasks } from '../src/lib/tasks.js';
import { historyDays } from '../src/workflow/history.js';
import { projectsModel } from '../src/workflow/stats-model.js';

const REPO = resolve(new URL('..', import.meta.url).pathname);
const NOW = Date.parse('2026-09-20T12:00:00.000Z');

// Real legacy record, trimmed to the fields the reader needs. Do not replace
// this with a synthetic id/kind/project: the regression is the old shape.
const REAL_LEGACY_RECORD = Object.freeze({
  ts: '2026-09-11T18:35:25.795Z',
  picked: 'grok',
  outFile: '/home/dev/.bullswarm/runs/out-1789150600535-beqp0.md',
});

function homeFor(decisionLog) {
  const home = mkdtempSync(join(tmpdir(), 'bullswarm-stats-legacy-project-'));
  mkdirSync(join(home, 'assignments'), { recursive: true });
  writeFileSync(join(home, 'state.json'), `${JSON.stringify({ decisionLog }, null, 2)}\n`);
  return home;
}

test('a legacy task with cwd derives its Stats project, while the real no-cwd shape stays unknown', () => {
  const withCwd = { ...REAL_LEGACY_RECORD, cwd: REPO };
  const withoutCwd = { ...REAL_LEGACY_RECORD };
  const home = homeFor([withCwd, withoutCwd]);
  try {
    const tasks = listTasks({ home, now: NOW });
    assert.equal(tasks.finished.length, 2);
    assert.equal(tasks.finished.find((row) => row.project === 'bullswarm')?.project, 'bullswarm');
    assert.equal(tasks.finished.find((row) => row.project == null)?.project, null);

    const history = historyDays(home, { days: 10, now: NOW, tasks: tasks.finished });
    const historyRows = history.flatMap((day) => day.rows).filter((row) => row.kind === 'task');
    assert.equal(historyRows.length, 2);
    assert.ok(historyRows.some((row) => row.project === 'bullswarm'));
    assert.ok(historyRows.some((row) => row.project == null));

    const rollupShape = {
      ...withCwd,
      kind: 'run',
      runId: 'legacy-task-with-cwd',
      project: null,
      startedAt: withCwd.ts,
      finishedAt: withCwd.ts,
      status: 'completed',
      verified: false,
      minutes: { wall: null, agent: null },
      pools: {},
      models: {},
    };
    const noCwdRollup = { ...rollupShape, runId: 'legacy-task-no-cwd', cwd: null };
    const stats = projectsModel([rollupShape, noCwdRollup], { period: 'all', now: NOW });
    assert.equal(stats.rows.find((row) => row.name === 'bullswarm')?.runs, 1);
    assert.equal(stats.rows.find((row) => row.name === 'unknown')?.runs, 1);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
