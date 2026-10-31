// The last readers of a raw window utilization read it through usedPctOf:
// garbage is no reading, exactly as a null/absent value (tests/meter-used-pct.test.js).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildPools } from '../src/lib/config.js';
import { pickPool } from '../src/lib/route.js';
import { windowSpent } from '../src/meters/framework.js';
import { appendMeterHistory } from '../src/meters/registry.js';
import { snapshotPool } from '../src/lib/quota-snapshot.js';
import { spendRateFor } from '../src/lib/spend.js';
import { poolBudget } from '../src/workflow/budget-model.js';
import { readLicencePerDay } from '../src/workflow/dashboard-licence.js';

const NOW = Date.parse('2026-10-09T10:00:00Z');
const FIVE_RESET = '2026-10-09T12:30:00Z';
const WEEK_RESET = '2026-10-12T12:00:00Z';
const GARBAGE = [['-30', -30], ["''", ''], ['true', true], ["'1e2'", '1e2'], ["'0x10'", '0x10']];

function tmp(prefix) { return mkdtempSync(join(tmpdir(), `bullswarm-${prefix}-`)); }

function fixtureHome(meters) {
  const home = tmp('readers');
  mkdirSync(join(home, 'connectors'), { recursive: true });
  for (const [name, meter] of Object.entries(meters)) {
    writeFileSync(join(home, 'connectors', `${name}.json`), JSON.stringify({
      name, bin: 'node',
      spawn: { cmd: ['node', 'x.mjs', '{taskFile}'], cwdMode: 'task-file-dir' },
      outputExtraction: { strategy: 'stdout' },
      meter, costRank: 3, lanes: ['analyze', 'build', 'chore'],
      capabilities: ['code-reading'], model: `${name}-local`, flags: { testFixture: true },
    }));
  }
  writeFileSync(join(home, 'state.json'), JSON.stringify({
    version: 1,
    pools: Object.fromEntries(Object.keys(meters).map((n) => [n, { enabled: true }])),
    incumbents: {}, decisionLog: [],
    config: { depthLimit: 2, callerName: 'claude-code', testFixturesMigrated: true },
  }));
  return home;
}

// R1
for (const [name, raw] of GARBAGE) {
  test(`R1: declared meter usedPct ${name} is no reading: no positive pace, honest pool wins`, () => {
    const home = fixtureHome({
      alpha: { type: 'declared', usedPct: raw },
      beta: { type: 'declared', usedPct: 30 },
    });
    try {
      const { pools } = buildPools(home, NOW, {});
      const alpha = pools.find((p) => p.name === 'alpha');
      const beta = pools.find((p) => p.name === 'beta');
      assert.equal(beta.pace, -30);
      assert.ok(!(alpha.pace > 0), `alpha pace ${alpha.pace}`);
      assert.equal(alpha.meterSource, 'none');
      const pick = pickPool(pools, { lane: 'build' });
      assert.notEqual(pick?.pool?.name ?? pick?.name, 'alpha');
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
}

// R2
for (const [name, raw] of [["''", ''], ['true', true], ['-30', -30]]) {
  test(`R2: windowSpent with burstGate and five_hour ${name} spends like null`, () => {
    const mk = (utilization) => ({
      burstGate: true,
      meterSnapshot: { five_hour: { utilization, resets_at: FIVE_RESET } },
    });
    const viaNull = windowSpent(mk(null), NOW);
    assert.equal(viaNull?.window, '5-hour');
    assert.deepEqual(windowSpent(mk(raw), NOW), viaNull);
  });
}

// R3
for (const [name, raw] of GARBAGE) {
  test(`R3: snapshotPool ignores weekly utilization ${name}`, () => {
    const dir = tmp('snap');
    try {
      mkdirSync(join(dir, 'meters'), { recursive: true });
      writeFileSync(join(dir, 'meters', 'fixture.json'), JSON.stringify({
        captured_at: '2026-10-09T10:00:00.000Z',
        five_hour: { utilization: 30, resets_at: FIVE_RESET },
        seven_day: { utilization: raw, resets_at: WEEK_RESET },
      }));
      const snap = snapshotPool('fixture', { home: dir, now: NOW });
      assert.equal(snap?.window, '5h');
      assert.equal(snap?.usedPct, 30);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}

// R4
for (const [name, raw] of [["''", ''], ['true', true], ['[]', []], ['-30', -30]]) {
  test(`R4: stored history value ${name} gives no interval delta`, () => {
    const dir = tmp('hist');
    try {
      mkdirSync(join(dir, 'history'), { recursive: true });
      writeFileSync(join(dir, 'history', 'fixture.jsonl'), `${JSON.stringify({
        captured_at: '2026-10-09T09:00:00.000Z',
        weekly: { used_pct: raw, resets_at: WEEK_RESET },
      })}\n`);
      const entry = appendMeterHistory('fixture', {
        captured_at: '2026-10-09T10:00:00.000Z',
        seven_day: { utilization: 40, resets_at: WEEK_RESET },
      }, { dir });
      assert.ok(entry);
      assert.equal(entry.weekly.delta_pct, null);
      assert.equal(entry.weekly.delta_reason, 'missing-reading');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}

// R5
for (const [name, raw] of GARBAGE) {
  test(`R5: spendRateFor snapshot weekly utilization ${name} is no reading`, () => {
    const rate = spendRateFor({ name: 'p' }, {
      nowMs: NOW,
      snapshot: { captured_at: '2026-10-09T10:00:00Z', seven_day: { utilization: raw, resets_at: WEEK_RESET } },
    });
    assert.equal(rate.weekly.windowUsedPct ?? null, null);
  });

  test(`R5: poolBudget model window utilization ${name} is absent`, () => {
    const budget = poolBudget({
      name: 'p', meterSnapshot: { seven_day_opus: { utilization: raw, resets_at: WEEK_RESET } },
    }, { now: NOW });
    const windows = budget?.windows ?? [];
    assert.ok(!windows.some((w) => w.key === 'opus'), JSON.stringify(windows.map((w) => w.key)));
  });

  test(`R5: licence per-day reading ${name} is blank`, () => {
    const dir = tmp('licence');
    try {
      mkdirSync(join(dir, 'meters', 'history'), { recursive: true });
      writeFileSync(join(dir, 'meters', 'history', 'p.jsonl'), `${JSON.stringify({
        captured_at: '2026-10-09T09:00:00.000Z',
        weekly: { utilization: raw, resets_at: WEEK_RESET },
      })}\n`);
      const out = readLicencePerDay(dir, [{ name: 'p' }], { period: '7d', now: NOW });
      assert.ok(out.rows.every((r) => r.segments.length === 0), JSON.stringify(out.rows));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}
