// A garbage window utilization must not reach routing through buildPools,
// the refusal-marker path or the registry's window checks (usedPctOf is the
// one rule: tests/meter-used-pct.test.js).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildPools } from '../src/lib/config.js';
import { pickPool } from '../src/lib/route.js';
import { paceSnapshot } from '../src/meters/framework.js';
import { windowUsable, windowHasData, meterHistoryEntry } from '../src/meters/registry.js';

const NOW = Date.parse('2026-10-09T10:00:00Z');
const FIVE_RESET = '2026-10-09T12:30:00Z';
const WEEK_RESET = '2026-10-12T12:00:00Z';

function fixtureHome(names) {
  const home = mkdtempSync(join(tmpdir(), 'bullswarm-used-pct-pools-'));
  mkdirSync(join(home, 'connectors'), { recursive: true });
  for (const name of names) {
    writeFileSync(join(home, 'connectors', `${name}.json`), JSON.stringify({
      name,
      bin: 'node',
      spawn: { cmd: ['node', 'x.mjs', '{taskFile}'], cwdMode: 'task-file-dir' },
      outputExtraction: { strategy: 'stdout' },
      meter: { type: 'none' },
      costRank: 3,
      lanes: ['analyze', 'build', 'chore'],
      capabilities: ['code-reading'],
      model: `${name}-local`,
      flags: { testFixture: true },
    }));
  }
  writeFileSync(join(home, 'state.json'), JSON.stringify({
    version: 1,
    pools: Object.fromEntries(names.map((n) => [n, { enabled: true }])),
    incumbents: {},
    decisionLog: [],
    config: { depthLimit: 2, callerName: 'claude-code', testFixturesMigrated: true },
  }));
  return home;
}

const reading = (snapshot) => ({ source: 'cache', snapshot, ...paceSnapshot(snapshot, NOW) });
const fiveOnly = (utilization) => ({ five_hour: { utilization, resets_at: FIVE_RESET } });

for (const [name, raw] of [['-30', -30], ["'1e2'", '1e2'], ["''", '']]) {
  test(`five_hour ${name} is not a fiveHourUsedPct and does not beat an honest 30% pool`, () => {
    const home = fixtureHome(['alpha', 'beta']);
    try {
      const { pools } = buildPools(home, NOW, {
        alpha: reading(fiveOnly(raw)),
        beta: reading(fiveOnly(30)),
      });
      const alpha = pools.find((p) => p.name === 'alpha');
      assert.equal(alpha.fiveHourUsedPct, null);
      assert.equal(pools.find((p) => p.name === 'beta').fiveHourUsedPct, 30);
      const picked = pickPool('build', pools, { now: NOW });
      assert.equal(picked.pick?.pool, 'beta', picked.why);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
}

test('a flat fiveHourUsedPct of -30 on a reading is not kept either', () => {
  const home = fixtureHome(['alpha']);
  try {
    const { pools } = buildPools(home, NOW, {
      alpha: { source: 'cache', snapshot: fiveOnly(40), fiveHourUsedPct: -30, fiveHourResetsAt: FIVE_RESET },
    });
    assert.notEqual(pools[0].fiveHourUsedPct, -30);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('refusal path: a garbage weekly utilization is treated as spent (100), -20 included', () => {
  const home = fixtureHome(['alpha']);
  try {
    const snapshot = {
      seven_day: { utilization: -20, resets_at: WEEK_RESET },
      quota_refusal: { refusedAt: '2026-10-09T09:55:00Z', resetsAt: WEEK_RESET, window: 'weekly', resetSource: 'named' },
    };
    const { pools } = buildPools(home, NOW, {
      alpha: { source: 'quota-refusal', snapshot, burstGate: false, quotaRefusal: snapshot.quota_refusal },
    });
    assert.equal(pools[0].usedPct, 100);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

for (const [name, raw] of [["''", ''], ["'  '", '  '], ['true', true], ['[]', []]]) {
  test(`registry windowUsable and windowHasData reject ${name}`, () => {
    assert.equal(windowUsable({ utilization: raw, resets_at: WEEK_RESET }, NOW), false);
    assert.equal(windowHasData({ five_hour: { utilization: raw, resets_at: null } }, 'five_hour'), false);
  });
}

test('registry windowUsable and windowHasData keep valid readings', () => {
  assert.equal(windowUsable({ utilization: '20', resets_at: WEEK_RESET }, NOW), true);
  assert.equal(windowHasData({ five_hour: { utilization: 0, resets_at: null } }, 'five_hour'), true);
});

test('history line stores no number for garbage and the same number for a valid value', () => {
  const entry = (u) => meterHistoryEntry({ captured_at: '2026-10-09T10:00:00Z', five_hour: { utilization: u, resets_at: FIVE_RESET } }, { pool: 'alpha' });
  assert.equal(entry(-30), null);
  assert.equal(entry('1e2'), null);
  assert.equal(entry(42).five_hour.utilization, 42);
  assert.equal(entry('42').five_hour.utilization, 42);
});
