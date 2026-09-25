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

test('buildPoolsLive polls every enabled pool: an old quarantine or bench record stops no meter read', async () => {
  const f = home({
    alpha: { enabled: true },
    beta: { enabled: true, quarantine: { until: NOW + 30 * 60_000, reason: 'quota', kind: 'quota' } },
    gamma: { enabled: true, bench: { until: NOW + 30 * 60_000, reason: 'provider', count: 2 } },
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
    assert.equal(byName.gamma.enabled, true, 'an old quarantine record keeps nothing out');
    assert.equal(Object.hasOwn(byName.gamma, 'quarantine'), false, 'nor does it reach the pool view');
  } finally { f.cleanup(); }
});

test('buildPools exposes free for the model selected on the requested tier and drops an old bench record', () => {
  const f = home({
    alpha: {
      enabled: true,
      bench: { until: NOW + 10 * 60_000, reason: 'provider', count: 2 },
    },
  }, { names: ['alpha'] });
  try {
    writeFileSync(join(f.dir, 'connectors/alpha.json'), JSON.stringify({
      name: 'alpha', costRank: 1, lanes: ['analyze', 'build', 'chore'],
      capabilities: ['code-reading', 'file-editing'],
      model: 'opencode/gpt-5.6-sol',
      modelSelection: { flag: '--model', mode: 'replace-or-append' },
      modelProfiles: [
        { match: 'union-alpha$', tier: 'medium', qualityRank: 3, free: true },
        { match: 'gpt-5\\.6-sol$', tier: 'high', qualityRank: 6 },
      ],
      meter: { type: 'none' },
    }));
    writeFileSync(join(f.dir, 'state.json'), JSON.stringify({
      version: 1,
      pools: { alpha: { enabled: true, bench: { until: NOW + 10 * 60_000, reason: 'provider', count: 2 } } },
      incumbents: {}, decisionLog: [], config: { depthLimit: 2 },
      strategy: {
        configuredTiers: ['medium'],
        modelTiers: { alpha: { 'opencode/union-alpha': ['medium'] } },
      },
    }));
    const { pools } = buildPools(f.dir, NOW, {}, { effortTier: 'medium' });
    const alpha = pools.find((pool) => pool.name === 'alpha');
    assert.equal(alpha.free, true);
    assert.equal(alpha.freeModel, 'opencode/union-alpha');
    assert.equal(Object.hasOwn(alpha, 'bench'), false);
  } finally { f.cleanup(); }
});
