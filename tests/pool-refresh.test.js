import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPoolRefresher, DEFAULT_REFRESH_INTERVAL_MS } from '../src/workflow/pool-refresh.js';

const DIR = '/tmp/bullswarm-pool-refresh-fixture';

function clock(startMs = 1_000_000) {
  let at = startMs;
  return { now: () => at, advance: (ms) => { at += ms; } };
}

/** Records every buildPoolsLive call and returns a scripted pool list. */
function recorder(lists) {
  const calls = [];
  let index = 0;
  const buildPoolsLive = async (bullswarmDir, now, opts) => {
    calls.push({ bullswarmDir, now, force: opts?.force === true, getReadings: opts?.getReadings });
    const next = lists[Math.min(index, lists.length - 1)];
    index += 1;
    if (next instanceof Error) throw next;
    return { state: {}, connectors: {}, pools: next };
  };
  buildPoolsLive.calls = calls;
  return buildPoolsLive;
}

const pool = (name, over = {}) => ({
  name, enabled: true, costRank: 2, lanes: ['analyze', 'build', 'chore'],
  pace: 0, fiveHourUsedPct: null, nearFiveHourLimit: false, ...over,
});

test('default throttle interval is 15s', () => {
  assert.equal(DEFAULT_REFRESH_INTERVAL_MS, 15_000);
});

test('bullswarmDir is required — no silent no-op refresher', () => {
  assert.throws(() => createPoolRefresher({}), /bullswarmDir is required/);
});

test('returns the rebuilt pools, not the launch-time list', async () => {
  const time = clock();
  const rebuilt = [pool('codex', { fiveHourUsedPct: 3 }), pool('claude-code:wati', { fiveHourUsedPct: 82, nearFiveHourLimit: true })];
  const buildPoolsLive = recorder([rebuilt]);
  const getReadings = async () => ({});
  const refreshPools = createPoolRefresher({
    bullswarmDir: DIR, initialPools: [pool('stale-launch-pool')],
    now: time.now, buildPoolsLive, getReadings,
  });

  const pools = await refreshPools();
  assert.deepEqual(pools.map((p) => p.name), ['codex', 'claude-code:wati']);
  assert.equal(pools[1].nearFiveHourLimit, true);
  assert.equal(buildPoolsLive.calls.length, 1);
  assert.deepEqual(buildPoolsLive.calls[0], {
    bullswarmDir: DIR, now: time.now(), force: false, getReadings,
  });
});

test('unforced calls inside minIntervalMs reuse the last list', async () => {
  const time = clock();
  const buildPoolsLive = recorder([[pool('first')], [pool('second')]]);
  const refreshPools = createPoolRefresher({
    bullswarmDir: DIR, now: time.now, buildPoolsLive, getReadings: async () => ({}),
    minIntervalMs: 15_000,
  });

  assert.deepEqual((await refreshPools()).map((p) => p.name), ['first']);
  time.advance(14_999);
  assert.deepEqual((await refreshPools()).map((p) => p.name), ['first']);
  assert.equal(buildPoolsLive.calls.length, 1, 'throttled call must not rebuild');

  time.advance(1);
  assert.deepEqual((await refreshPools()).map((p) => p.name), ['second']);
  assert.equal(buildPoolsLive.calls.length, 2);
});

test('a forced call bypasses the throttle and polls live', async () => {
  const time = clock();
  const buildPoolsLive = recorder([[pool('cached')], [pool('live')]]);
  const refreshPools = createPoolRefresher({
    bullswarmDir: DIR, now: time.now, buildPoolsLive, getReadings: async () => ({}),
    minIntervalMs: 15_000,
  });

  await refreshPools();
  assert.equal(buildPoolsLive.calls[0].force, false);
  // Same instant, well inside the throttle window: the post-quota-failure
  // retry still gets a live rebuild.
  const forced = await refreshPools({ force: true });
  assert.deepEqual(forced.map((p) => p.name), ['live']);
  assert.equal(buildPoolsLive.calls.length, 2);
  assert.equal(buildPoolsLive.calls[1].force, true);
});

test('an error keeps the last good list and never throws', async () => {
  const time = clock();
  const buildPoolsLive = recorder([[pool('good')], new Error('meter cache unreadable'), [pool('recovered')]]);
  const refreshPools = createPoolRefresher({
    bullswarmDir: DIR, now: time.now, buildPoolsLive, getReadings: async () => ({}),
    minIntervalMs: 1_000,
  });

  assert.deepEqual((await refreshPools()).map((p) => p.name), ['good']);
  time.advance(2_000);
  const afterError = await refreshPools();
  assert.deepEqual(afterError.map((p) => p.name), ['good'], 'last good list survives a failed rebuild');
  assert.equal(buildPoolsLive.calls.length, 2, 'the failing rebuild really was attempted');
  time.advance(2_000);
  assert.deepEqual((await refreshPools()).map((p) => p.name), ['recovered']);
});

test('the very first call failing yields the launch list instead of throwing', async () => {
  const time = clock();
  const buildPoolsLive = recorder([new Error('state.json corrupt')]);
  const refreshPools = createPoolRefresher({
    bullswarmDir: DIR, initialPools: [pool('launch')],
    now: time.now, buildPoolsLive, getReadings: async () => ({}),
  });
  assert.deepEqual((await refreshPools()).map((p) => p.name), ['launch']);
});

test('an empty initial list still builds a real list', async () => {
  const time = clock();
  const buildPoolsLive = recorder([[pool('codex'), pool('grok')]]);
  const refreshPools = createPoolRefresher({
    bullswarmDir: DIR, initialPools: [], now: time.now, buildPoolsLive, getReadings: async () => ({}),
  });
  assert.deepEqual((await refreshPools()).map((p) => p.name), ['codex', 'grok']);
});

test('concurrent unforced calls share one rebuild', async () => {
  const time = clock();
  const buildPoolsLive = recorder([[pool('shared')]]);
  const refreshPools = createPoolRefresher({
    bullswarmDir: DIR, now: time.now, buildPoolsLive, getReadings: async () => ({}),
  });
  const [a, b] = await Promise.all([refreshPools(), refreshPools()]);
  assert.equal(buildPoolsLive.calls.length, 1);
  assert.equal(a, b);
});
