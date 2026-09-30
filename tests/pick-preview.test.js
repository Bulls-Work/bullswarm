// `bullswarm run --dry-run` (src/workflow/pick-preview.js) says why no pool
// can take the step in the dispatch's own words: a window at its limit first,
// then a route, then a missing tier model; with the dispatch's failure kind.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { previewStepPick } from '../src/workflow/pick-preview.js';

const NOW = Date.parse('2026-08-31T01:00:00Z');
const RESET = '2026-08-31T04:00:00.000Z';

const connector = (name, extra = {}) => ({
  name, lanes: ['analyze', 'build', 'chore'], enabled: true, spawn: { cmd: ['fake'] },
  modelSelection: { flag: '--model' }, strategyAssignments: { low: { pool: name, model: 'acme-model' } },
  ...extra,
});
const step = (extra = {}) => ({ id: 'task', lane: 'analyze', effort: 'low', ...extra });

function preview(t, pools, action = step()) {
  const home = mkdtempSync(join(tmpdir(), 'bs-preview-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return previewStepPick({ action, pools, bullswarmDir: home, coreState: { decisionLog: [] }, targetDir: home, now: NOW });
}

test('a pool at a spent window is the reason, not a missing tier model, and the kind is quota', async (t) => {
  const pools = [connector('acme-1', { meterSnapshot: { seven_day: { utilization: 100, resets_at: RESET } } })];
  const result = await preview(t, pools);
  assert.equal(result.ok, false);
  assert.equal(result.pick, undefined);
  assert.equal(result.failureKind, 'quota');
  assert.equal(result.why, `no pool with quota to spare: acme-1 at its weekly limit until ${RESET}`);
});

test('a spent window under a route that still allows the pool names the window', async (t) => {
  const pools = [
    connector('acme-1', { meterSnapshot: { seven_day: { utilization: 100, resets_at: RESET } } }),
    connector('initech-1'),
  ];
  const result = await preview(t, pools, step({ route: { pools: { avoid: ['initech-1'] } } }));
  assert.equal(result.failureKind, 'quota');
  assert.equal(result.why, `no pool with quota to spare: acme-1 at its weekly limit until ${RESET}`);
});

test('no pool with a model on the tier stays the tier reason, with kind unavailable', async (t) => {
  const result = await preview(t, [connector('acme-1', { enabled: false })]);
  assert.equal(result.failureKind, 'unavailable');
  assert.equal(result.why, 'no eligible pool: no enabled pool has a model on the low tier for analyze work');
});

test('a pool left with only free models while free models are off is named with that reason', async (t) => {
  const pools = [connector('acme-1', { strategyAssignments: {}, model: 'vendor/model-x:free', strategyFreeModels: 'never' })];
  const result = await preview(t, pools);
  assert.equal(result.failureKind, 'unavailable');
  assert.equal(result.why, 'no eligible pool: no enabled pool has a model on the low tier for analyze work; free models are off for acme-1');
});

test('a route that leaves no pool keeps the route reason, with kind unavailable', async (t) => {
  const result = await preview(t, [connector('acme-1')], step({ route: { pools: { avoid: ['acme-1'] } } }));
  assert.equal(result.failureKind, 'unavailable');
  assert.match(result.why, /avoid acme-1/);
});
