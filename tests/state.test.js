import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadState, saveState, updateState, upstreamGroupOf,
  acquireStateLock, releaseStateLock, stateLockPath, STATE_LOCK_STALE_MS,
  assertDepthAllowed, currentDepth, childDepthEnv, DEPTH_ENV,
  migratePoolNameHome,
} from '../src/lib/state.js';
import { buildPools } from '../src/lib/config.js';
import { pickPool } from '../src/lib/route.js';
import { getMeterReading } from '../src/meters/registry.js';

function tmpDir() {
  const d = mkdtempSync(join(tmpdir(), 'bullswarm-state-'));
  return { dir: d, cleanup: () => rmSync(d, { recursive: true, force: true }) };
}

test('state round-trips through disk', () => {
  const { dir, cleanup } = tmpDir();
  try {
    const s = loadState(dir);
    s.pools.grok = { enabled: true };
    saveState(dir, s);
    const s2 = loadState(dir);
    assert.equal(s2.pools.grok.enabled, true);
  } finally {
    cleanup();
  }
});

test('OpenCode pool migration rewrites state, config, snapshots, and history idempotently', () => {
  const { dir, cleanup } = tmpDir();
  try {
    mkdirSync(join(dir, 'meters', 'history'), { recursive: true });
    writeFileSync(join(dir, 'state.json'), `${JSON.stringify({
      version: 1,
      pools: {
        opencode2: { enabled: true },
        'opencode2:orbit-2': { enabled: false },
        // Equal values exercise the safe both-present merge.
        opencode: { enabled: true },
      },
      incumbents: { build: 'opencode2:orbit-2' },
      decisionLog: [{
        picked: 'opencode2',
        routing: { candidates: [{ pool: 'opencode2:orbit-2' }] },
      }],
      config: { depthLimit: 2 },
      strategy: {
        assignments: { high: { pool: 'opencode2' } },
        subscriptions: {
          opencode2: { resetsAt: '2026-09-20T00:00:00.000Z' },
          'opencode2:orbit-3': { quotaWindow: 'monthly' },
        },
        reasoning: { pools: { opencode2: { high: 'default' } } },
        modelTiers: { 'opencode2:orbit-3': { 'orbit-3/gpt-5.6-luna': ['low'] } },
        disabledModels: { opencode2: ['orbit/gpt-5.6-terra'] },
        lastReport: {
          discoveries: { opencode2: { pool: 'opencode2' } },
          providerSuggestions: { 'opencode2:orbit-3': { low: {} } },
          subscriptions: [{ pool: 'opencode2:orbit-3' }],
        },
      },
    }, null, 2)}\n`);
    writeFileSync(join(dir, 'routing.json'), `${JSON.stringify({
      build: { order: ['opencode2', 'opencode', 'opencode2:orbit-3'], fallback: 'caller' },
    }, null, 2)}\n`);
    writeFileSync(join(dir, 'providers.json'), JSON.stringify({ enabled: ['opencode2', 'opencode'] }));
    writeFileSync(join(dir, 'meters', 'opencode2.json'), `${JSON.stringify({ pool: 'opencode2', monthly: {} })}\n`);
    writeFileSync(join(dir, 'meters', 'history', 'opencode2:orbit-3.jsonl'), `${JSON.stringify({
      pool: 'opencode2:orbit-3', monthly: { utilization: 4 },
    })}\n`);

    const migrated = loadState(dir);
    assert.deepEqual(Object.keys(migrated.pools).sort(), ['opencode', 'opencode:orbit-2']);
    assert.equal(migrated.incumbents.build, 'opencode:orbit-2');
    assert.equal(migrated.decisionLog[0].picked, 'opencode');
    assert.equal(migrated.decisionLog[0].routing.candidates[0].pool, 'opencode:orbit-2');
    assert.ok(migrated.strategy.subscriptions.opencode);
    assert.ok(migrated.strategy.subscriptions['opencode:orbit-3']);
    assert.ok(migrated.strategy.reasoning.pools.opencode);
    assert.ok(migrated.strategy.modelTiers['opencode:orbit-3']);
    assert.ok(migrated.strategy.disabledModels.opencode);
    assert.ok(migrated.strategy.lastReport.discoveries.opencode);
    assert.ok(migrated.strategy.lastReport.providerSuggestions['opencode:orbit-3']);
    assert.equal(migrated.strategy.lastReport.subscriptions[0].pool, 'opencode:orbit-3');

    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'routing.json'))).build.order,
      ['opencode', 'opencode:orbit-3']);
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'providers.json'))).enabled, ['opencode']);
    assert.deepEqual(readdirSync(join(dir, 'meters')).sort(), ['history', 'opencode.json']);
    assert.deepEqual(readdirSync(join(dir, 'meters', 'history')).sort(), ['opencode:orbit-3.jsonl']);
    assert.equal(JSON.parse(readFileSync(join(dir, 'meters', 'opencode.json'))).pool, 'opencode');
    assert.equal(JSON.parse(readFileSync(join(dir, 'meters', 'history', 'opencode:orbit-3.jsonl'))).pool,
      'opencode:orbit-3');

    const files = [
      'state.json', 'routing.json', 'providers.json',
      'meters/opencode.json', 'meters/history/opencode:orbit-3.jsonl',
    ];
    const bytes = files.map((file) => readFileSync(join(dir, file)));
    loadState(dir);
    assert.deepEqual(files.map((file) => readFileSync(join(dir, file))), bytes,
      'the second load is byte-identical');
  } finally { cleanup(); }
});

test('OpenCode pool migration keeps conflicting entries and warns once per file', () => {
  const { dir, cleanup } = tmpDir();
  const originalWarn = console.warn;
  const warnings = [];
  console.warn = (message) => warnings.push(String(message));
  try {
    writeFileSync(join(dir, 'state.json'), JSON.stringify({
      pools: { opencode2: { enabled: false }, opencode: { enabled: true } },
    }));
    assert.deepEqual(Object.keys(loadState(dir).pools).sort(), ['opencode', 'opencode2']);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /state\.json/);
    assert.equal(migratePoolNameHome(dir), false);
  } finally {
    console.warn = originalWarn;
    cleanup();
  }
});

test('a meter-only read runs the home migration before opening the cache', async () => {
  const { dir, cleanup } = tmpDir();
  try {
    mkdirSync(join(dir, 'meters'), { recursive: true });
    writeFileSync(join(dir, 'meters', 'opencode2.json'), `${JSON.stringify({
      pool: 'opencode2', captured_at: new Date().toISOString(),
      five_hour: { utilization: null, resets_at: null },
    })}\n`);
    const reading = await getMeterReading('opencode', { bullswarmDir: dir });
    assert.equal(reading.snapshot.pool, 'opencode');
    assert.equal(existsSync(join(dir, 'meters', 'opencode2.json')), false);
    assert.equal(existsSync(join(dir, 'meters', 'opencode.json')), true);
  } finally { cleanup(); }
});

// S1: no pool is paused, benched or struck out. A home written by an earlier
// version can still hold those records (the owner's held a bench for
// opencode); they are read by nothing and route as if absent.
test('a state.json holding old quarantine and bench records routes normally (S1)', () => {
  const { dir, cleanup } = tmpDir();
  try {
    mkdirSync(join(dir, 'connectors'), { recursive: true });
    for (const name of ['grok', 'relay']) {
      writeFileSync(join(dir, 'connectors', `${name}.json`), JSON.stringify({
        name, spawn: { cmd: [name] }, lanes: ['analyze', 'build', 'chore'], costRank: 1,
      }));
    }
    const now = Date.parse('2026-09-25T10:00:00Z');
    const state = loadState(dir);
    state.strategy = { pausing: 'off' };
    state.pools.grok = {
      enabled: true,
      quarantine: { until: now + 7 * 24 * 3600_000, reason: 'usage limit', kind: 'quota', rule: 'message' },
      bench: { until: now + 600_000, reason: 'stall', count: 2 },
    };
    // A quarantine with no end (null used to mean forever) and a first strike.
    state.pools.relay = { enabled: true, quarantine: { until: null, reason: 'auth', kind: 'auth' }, bench: { until: null, reason: 'provider', count: 1 } };
    saveState(dir, state);
    const before = readFileSync(join(dir, 'state.json'), 'utf8');
    const { pools } = buildPools(dir, now);
    assert.deepEqual(pools.map((pool) => pool.name).sort(), ['grok', 'relay']);
    for (const pool of pools) {
      assert.equal(pool.enabled, true, pool.name);
      assert.equal(Object.hasOwn(pool, 'quarantine'), false, `${pool.name}: no pause on the view`);
      assert.equal(Object.hasOwn(pool, 'bench'), false, `${pool.name}: no bench on the view`);
    }
    // Both pools are offered: the old records keep nothing out.
    const route = pickPool('build', pools, { now, callerEligible: false });
    assert.ok(route.pick, route.why);
    assert.deepEqual(route.candidates.map((candidate) => candidate.pool).sort(), ['grok', 'relay']);
    assert.doesNotMatch(route.why, /bench|paus|quarantin/i);
    // Reading never rewrites the file.
    assert.equal(readFileSync(join(dir, 'state.json'), 'utf8'), before);
  } finally {
    cleanup();
  }
});

// --- locked read-modify-write (S5 / audit finding D5) ----------------------

test('saveState is atomic: a reader never sees a truncated state.json', async () => {
  const { dir, cleanup } = tmpDir();
  try {
    const { readdirSync } = await import('node:fs');
    const state = loadState(dir);
    // Big enough that a non-atomic write would be visibly torn mid-flight.
    state.decisionLog = Array.from({ length: 5000 }, (_, i) => ({ ts: String(i), why: 'x'.repeat(200) }));
    saveState(dir, state);
    assert.equal(loadState(dir).decisionLog.length, 5000);
    // temp+rename leaves no debris behind.
    assert.deepEqual(readdirSync(dir), ['state.json']);
  } finally { cleanup(); }
});

test('updateState always writes a FRESH load, so a stale copy cannot undo a concurrent write', () => {
  const { dir, cleanup } = tmpDir();
  try {
    const state = loadState(dir);
    state.pools.beta = { enabled: true };
    saveState(dir, state);

    // What a long-running `run` holds: the copy it loaded before dispatching.
    const stale = loadState(dir);
    // What an operator does meanwhile (`strategy set-provider beta off --yes`).
    updateState(dir, (fresh) => { fresh.pools.beta.enabled = false; });
    // The run's own change, applied the new way.
    stale.incumbents.build = 'beta';
    updateState(dir, (fresh) => { fresh.incumbents.build = 'beta'; });

    const final = loadState(dir);
    assert.equal(final.pools.beta.enabled, false, 'the operator write survived');
    assert.equal(final.incumbents.build, 'beta', 'the run write landed too');
  } finally { cleanup(); }
});

test('two concurrent updateState calls both land, in lock order', async () => {
  const { dir, cleanup } = tmpDir();
  try {
    const { spawn } = await import('node:child_process');
    saveState(dir, { ...loadState(dir), decisionLog: [] });
    const stateModule = new URL('../src/lib/state.js', import.meta.url).href;

    // Deterministic interleaving, not a hope that two processes collide: this
    // process takes the lock and holds it across a slow load-mutate-write
    // while a second REAL process tries the same update. Without the lock the
    // second process would load before the first one's write and drop it —
    // exactly the D5 shape (a long `run` versus an operator's command).
    const lock = acquireStateLock(dir);
    const mine = loadState(dir); // the "stale" copy, read before the other process runs
    const child = spawn(process.execPath, ['--input-type=module', '-e', `
      const { updateState } = await import(${JSON.stringify(stateModule)});
      updateState(${JSON.stringify(dir)}, (s) => { s.decisionLog.push({ who: 'operator' }); });
    `], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    // Give the child time to reach the lock and start waiting on it.
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(child.exitCode, null, 'the second process is still blocked on the lock');

    mine.decisionLog.push({ who: 'run' });
    saveState(dir, mine);
    releaseStateLock(lock);

    const code = await new Promise((resolve) => child.on('exit', resolve));
    assert.equal(code, 0, stderr);

    const log = loadState(dir).decisionLog;
    assert.deepEqual(log.map((e) => e.who), ['run', 'operator'], 'both writes survived');
    assert.equal(existsSync(stateLockPath(dir)), false, 'the lock is always released');
  } finally { cleanup(); }
});

test('a held lock makes a waiter fail loudly instead of writing over the holder', () => {
  const { dir, cleanup } = tmpDir();
  try {
    saveState(dir, loadState(dir));
    const lock = acquireStateLock(dir);
    try {
      assert.throws(
        () => updateState(dir, (s) => { s.pools.x = { enabled: true }; }, { waitMs: 120, pollMs: 10 }),
        /locked by another bullswarm process/,
      );
      assert.equal(loadState(dir).pools.x, undefined, 'the blocked write did not land');
    } finally { releaseStateLock(lock); }
    // Released: the same update now succeeds.
    updateState(dir, (s) => { s.pools.x = { enabled: true }; });
    assert.equal(loadState(dir).pools.x.enabled, true);
  } finally { cleanup(); }
});

test('a lock left behind by a dead process is taken over after the stale timeout', () => {
  const { dir, cleanup } = tmpDir();
  try {
    saveState(dir, loadState(dir));
    assert.equal(STATE_LOCK_STALE_MS, 30_000, 'documented takeover window');
    acquireStateLock(dir); // never released: the holder "crashed"
    // staleMs: 0 treats it as already stale rather than sleeping 30 s here.
    updateState(dir, (s) => { s.incumbents.chore = 'grok'; }, { staleMs: 0, waitMs: 1000, pollMs: 10 });
    assert.equal(loadState(dir).incumbents.chore, 'grok');
    assert.equal(existsSync(stateLockPath(dir)), false);
  } finally { cleanup(); }
});

test('a mutator that returns false leaves state.json byte-identical', () => {
  const { dir, cleanup } = tmpDir();
  try {
    saveState(dir, loadState(dir));
    const before = readFileSync(join(dir, 'state.json'));
    updateState(dir, () => false);
    assert.deepEqual(readFileSync(join(dir, 'state.json')), before);
  } finally { cleanup(); }
});

test('recursion guard: core-owned depth limit refuses deep chains', () => {
  const s = loadState('/nonexistent-bullswarm-test');
  s.config.depthLimit = 2;
  const env = { [DEPTH_ENV]: '2' };
  assert.equal(currentDepth(env), 2);
  assert.throws(() => assertDepthAllowed(s, env), /recursion guard/);
  assert.doesNotThrow(() => assertDepthAllowed(s, { [DEPTH_ENV]: '1' }));
});

test('child depth env increments exactly once', () => {
  const parent = { [DEPTH_ENV]: '1' };
  const child = childDepthEnv(parent);
  assert.equal(child[DEPTH_ENV], '2');
  assert.equal(parent[DEPTH_ENV], '1'); // untouched
});

test('top-level CLI uses BULLSWARM_HOME at invocation time', async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const home = mkdtempSync(join(tmpdir(), 'bullswarm-home-'));
  const previous = process.env.BULLSWARM_HOME;
  try {
    mkdirSync(join(home, 'connectors'), { recursive: true });
    writeFileSync(join(home, 'state.json'), JSON.stringify({
      version: 1, pools: {}, incumbents: {}, decisionLog: [],
      config: { depthLimit: 2, callerName: 'claude-code' },
    }));
    const { getBullswarmDir } = await import('../src/cli.js');
    process.env.BULLSWARM_HOME = home;
    assert.equal(getBullswarmDir(), home);
    // Change it after module import; the resolver must follow it.
    const second = `${home}-second`;
    mkdirSync(join(second, 'connectors'), { recursive: true });
    process.env.BULLSWARM_HOME = second;
    assert.equal(getBullswarmDir(), second);
    rmSync(second, { recursive: true, force: true });
  } finally {
    if (previous === undefined) delete process.env.BULLSWARM_HOME;
    else process.env.BULLSWARM_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  }
});

test('top-level doctor and pools honor BULLSWARM_HOME in subprocesses', async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { spawnSync } = await import('node:child_process');
  const repo = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
  const home = mkdtempSync(join(tmpdir(), 'bullswarm-cli-home-'));
  try {
    mkdirSync(join(home, 'connectors'), { recursive: true });
    // echo ships first-class (src/providers/echo), so the home needs no copy.
    // No explicit `enabled` for echo: the fixture migration owns that legacy
    // default and disables it, which is what `pools --json` reports below.
    writeFileSync(join(home, 'state.json'), JSON.stringify({
      version: 1, pools: { echo: {} }, incumbents: {},
      decisionLog: [], config: { depthLimit: 2, callerName: 'claude-code' },
    }));
    const env = { ...process.env, BULLSWARM_HOME: home };
    const doctor = spawnSync('node', [join(repo, 'bin/bullswarm.js'), 'doctor', '--json'], {
      env, encoding: 'utf8',
    });
    const doctorJson = JSON.parse(doctor.stdout);
    assert.equal(doctorJson.configured, true);
    // First-class providers load in every home, so whether one is offload
    // capable depends on the host's installed CLIs; the exit code must agree.
    assert.equal(doctor.status, doctorJson.ok ? 0 : 1, doctor.stderr);
    assert.equal(typeof doctorJson.checks.find((check) => check.id === 'offload-capable').ok, 'boolean');
    assert.match(doctorJson.checks[0].detail, new RegExp(home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

    const pools = spawnSync('node', [join(repo, 'bin/bullswarm.js'), 'pools', '--json'], {
      env, encoding: 'utf8',
    });
    assert.equal(pools.status, 0, pools.stderr);
    const poolsJson = JSON.parse(pools.stdout);
    const echo = poolsJson.pools.find((p) => p.name === 'echo');
    assert.ok(echo, `echo is listed: ${poolsJson.pools.map((p) => p.name).join(', ')}`);
    assert.equal(echo.enabled, false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// --- upstream siblings ------------------------------------------------------

const GROUP = 'relay:relay.example';

test('an upstream group is read from a pool view or a bare connector', () => {
  assert.equal(upstreamGroupOf({ name: 'x', connector: { credentialGroup: GROUP } }), GROUP);
  assert.equal(upstreamGroupOf({ name: 'x', credentialGroup: GROUP }), GROUP);
  // `upstreamGroup` is the accepted legacy spelling; the contract name wins.
  assert.equal(upstreamGroupOf({ name: 'x', connector: { upstreamGroup: GROUP } }), GROUP);
  assert.equal(upstreamGroupOf({ name: 'x', credentialGroup: GROUP, upstreamGroup: 'other' }), GROUP);
  assert.equal(upstreamGroupOf({ name: 'x', upstreamGroup: GROUP }), GROUP);
  assert.equal(upstreamGroupOf({ name: 'x' }), null);
  assert.equal(upstreamGroupOf({ name: 'x', upstreamGroup: '' }), null);
  assert.equal(upstreamGroupOf(null), null);
});

// The pause machinery (owner decision 2026-09-25, state.js S1): a sign-in
// failure's credential group is skipped inside the dispatch that saw it
// (v2-dispatch.js), and nothing about it is stored.
test('the pause, bench and strike helpers stay deleted', async () => {
  const state = await import('../src/lib/state.js');
  for (const name of [
    'quarantinePool', 'quarantineUpstreamSiblings', 'releaseIfProbeDue', 'sweepQuarantines', 'resumePool',
    'setPausing', 'pausingEnabled', 'recordPoolStrike', 'clearPoolStrikes', 'sweepBenches',
    'BENCH_COOLDOWN_MS', 'BENCH_AFTER_STRIKES', 'BENCH_REASONS',
  ]) {
    assert.equal(Object.hasOwn(state, name), false, name);
  }
  const route = await import('../src/lib/route.js');
  for (const name of ['isQuarantined', 'isBenched']) assert.equal(Object.hasOwn(route, name), false, name);
});
