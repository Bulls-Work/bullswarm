import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPools, buildPoolsLive } from '../src/lib/config.js';

const NOW = Date.parse('2026-09-09T12:00:00Z');

/**
 * A fixture home with three connectors and the pool state the caller asks
 * for. `pools` is written verbatim into state.json.
 */
function home(pools, { names = ['alpha', 'beta', 'gamma'] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'bs-config-'));
  mkdirSync(join(dir, 'connectors'), { recursive: true });
  for (const name of names) {
    writeFileSync(join(dir, `connectors/${name}.json`), JSON.stringify({
      name, costRank: 2, lanes: ['analyze', 'build', 'chore'],
      capabilities: ['code-reading', 'file-editing'],
      meter: { type: 'reader', window: 'weekly' },
    }));
  }
  writeFileSync(join(dir, 'state.json'), JSON.stringify({
    version: 1, pools, incumbents: {}, decisionLog: [], config: { depthLimit: 2 },
  }));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** Records the name list every poll was asked for. */
function spy() {
  const asked = [];
  const getReadings = async (names) => {
    asked.push([...names]);
    return {};
  };
  return { asked, getReadings };
}

// --- D6: never poll a pool whose reading would be discarded -----------------

test('buildPoolsLive does not poll a disabled pool', async () => {
  const f = home({
    alpha: { enabled: true },
    beta: { enabled: false },
    gamma: { enabled: true },
  });
  try {
    const poll = spy();
    const { pools } = await buildPoolsLive(f.dir, NOW, { getReadings: poll.getReadings });
    assert.deepEqual(poll.asked, [['alpha', 'gamma']]);
    assert.ok(!poll.asked[0].includes('beta'), 'a disabled pool must never be polled');
    // The pool itself is still built and still reported as disabled.
    const byName = Object.fromEntries(pools.map((pool) => [pool.name, pool]));
    assert.equal(byName.beta.enabled, false);
    assert.equal(byName.beta.meterSource, 'none');
  } finally { f.cleanup(); }
});

test('buildPoolsLive does not poll a pool inside its quarantine window', async () => {
  const f = home({
    alpha: { enabled: true },
    beta: { enabled: true, quarantine: { until: NOW + 30 * 60_000, reason: 'quota' } },
    gamma: { enabled: true },
  });
  try {
    const poll = spy();
    await buildPoolsLive(f.dir, NOW, { getReadings: poll.getReadings });
    assert.deepEqual(poll.asked, [['alpha', 'gamma']]);
  } finally { f.cleanup(); }
});

test('buildPoolsLive polls again once the quarantine has expired', async () => {
  const f = home({
    alpha: { enabled: true },
    beta: { enabled: true, quarantine: { until: NOW - 1, reason: 'quota' } },
    gamma: { enabled: true },
  });
  try {
    const poll = spy();
    await buildPoolsLive(f.dir, NOW, { getReadings: poll.getReadings });
    assert.deepEqual(poll.asked, [['alpha', 'beta', 'gamma']]);
  } finally { f.cleanup(); }
});

test('a test-fixture pool is polled only when it is explicitly enabled', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bs-config-fx-'));
  try {
    mkdirSync(join(dir, 'connectors'), { recursive: true });
    for (const name of ['echo-on', 'echo-off']) {
      writeFileSync(join(dir, `connectors/${name}.json`), JSON.stringify({
        name, costRank: 1, lanes: ['chore'], flags: { testFixture: true },
        meter: { type: 'reader', window: 'weekly' },
      }));
    }
    writeFileSync(join(dir, 'state.json'), JSON.stringify({
      version: 1,
      // A test-fixture pool is opt-IN: 'echo-off' says nothing, so it is off.
      pools: { 'echo-on': { enabled: true }, 'echo-off': {} },
      incumbents: {}, decisionLog: [], config: { depthLimit: 2 },
    }));
    const poll = spy();
    await buildPoolsLive(dir, NOW, { getReadings: poll.getReadings });
    assert.deepEqual(poll.asked, [['echo-on']]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('buildPools itself is unchanged: every connector still gets a pool view', () => {
  const f = home({
    alpha: { enabled: true },
    beta: { enabled: false },
    gamma: { enabled: true, quarantine: { until: NOW + 60_000 } },
  });
  try {
    const { pools } = buildPools(f.dir, NOW, {});
    assert.deepEqual(pools.map((pool) => pool.name).sort(), ['alpha', 'beta', 'gamma']);
    const byName = Object.fromEntries(pools.map((pool) => [pool.name, pool]));
    assert.equal(byName.alpha.enabled, true);
    assert.equal(byName.beta.enabled, false);
    assert.equal(byName.gamma.quarantine.until, NOW + 60_000);
  } finally { f.cleanup(); }
});
