import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadState, saveState, updateState, quarantinePool, quarantineUpstreamSiblings,
  sweepQuarantines, upstreamGroupOf,
  recordPoolStrike, clearPoolStrikes, sweepBenches, BENCH_COOLDOWN_MS, BENCH_AFTER_STRIKES,
  acquireStateLock, releaseStateLock, stateLockPath, STATE_LOCK_STALE_MS,
  assertDepthAllowed, currentDepth, childDepthEnv, DEPTH_ENV,
  migratePoolNameHome, resumePool, setPausing, pausingEnabled,
} from '../src/lib/state.js';
import { decideQuotaPause } from '../src/lib/quota.js';
import { buildPools } from '../src/lib/config.js';
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

test('quarantine auto-releases after the probe window (S1)', () => {
  const s = loadState('/nonexistent-bullswarm-test'); // memory-only
  const now = Date.now();
  quarantinePool(s, 'grok', 'auth signature', now);
  assert.equal(sweepQuarantines(s, now + 1000).length, 0); // still benched
  const released = sweepQuarantines(s, now + 11 * 60_000);
  assert.deepEqual(released, ['grok']); // automatic return to service
  assert.equal(s.pools.grok.quarantine, undefined);
});

test('expired quarantine is absent from runtime pool views before persistence catches up', async () => {
  const { dir, cleanup } = tmpDir();
  try {
    const { mkdirSync, writeFileSync } = await import('node:fs');
    mkdirSync(join(dir, 'connectors'), { recursive: true });
    writeFileSync(join(dir, 'connectors', 'grok.json'), JSON.stringify({
      name: 'grok', spawn: { cmd: ['grok'] }, lanes: ['analyze'], costRank: 1,
    }));
    const state = loadState(dir);
    state.pools.grok = { enabled: true, quarantine: { until: 1000, reason: 'old failure' } };
    saveState(dir, state);
    const built = buildPools(dir, 1001);
    assert.equal(built.pools[0].quarantine, null);
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

/** A decideQuotaPause() proof from a provider line that names its reset. */
function spentWindow(now, line = "You've hit your session limit · resets in 2 hours", meter = null) {
  return decideQuotaPause({ text: line, meter, pausing: true, now, timeZone: 'UTC' });
}

const GROUP = 'relay:relay.example';
const relayPools = () => ([
  { name: 'relay', enabled: true, connector: { credentialGroup: GROUP } },
  { name: 'relay:b', enabled: true, connector: { credentialGroup: GROUP } },
  { name: 'relay:c', enabled: true, connector: { credentialGroup: GROUP } },
  { name: 'claude-code', enabled: true, connector: {} },
  { name: 'relay:retired', enabled: false, connector: { credentialGroup: GROUP } },
]);

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

test('an auth failure benches the whole upstream group on one deadline (2026-09-11)', () => {
  const s = loadState('/nonexistent-bullswarm-test');
  const now = Date.parse('2026-09-11T12:24:00Z');
  const until = quarantinePool(s, 'relay:c', 'upstream auth failure', now, { kind: 'auth' });
  const benched = quarantineUpstreamSiblings(s, relayPools(), {
    pool: 'relay:c', group: GROUP, reason: 'upstream auth failure', now, until, kind: 'auth',
  });
  assert.deepEqual(benched, ['relay', 'relay:b']);
  assert.equal(s.pools.relay.quarantine.until, until);
  assert.equal(s.pools.relay.quarantine.kind, 'auth');
  assert.equal(s.pools.relay.quarantine.reason, 'sibling of relay:c: upstream auth failure');
  assert.equal(until - now, 10 * 60_000, 'the flat auth re-probe window');
  assert.equal(s.pools['claude-code']?.quarantine, undefined, 'another credential is untouched');
  assert.equal(s.pools['relay:retired']?.quarantine, undefined, 'a disabled pool is not benched');
  // The whole group returns to service together when the window expires.
  assert.deepEqual(
    sweepQuarantines(s, now + 10 * 60_000).sort(),
    ['relay', 'relay:b', 'relay:c'],
  );
});

test('a quota quarantine never spreads, and a sibling deadline is never shortened', () => {
  const s = loadState('/nonexistent-bullswarm-test');
  const now = Date.parse('2026-09-11T12:24:00Z');
  // A usage limit is one pool's empty window; the siblings still have theirs.
  assert.deepEqual(quarantineUpstreamSiblings(s, relayPools(), {
    pool: 'relay:c', group: GROUP, reason: 'usage limit', now, until: now + 3 * 3600_000, kind: 'quota',
  }), []);
  assert.equal(s.pools.relay?.quarantine, undefined);

  // A sibling already out on its own 3-hour quota reset keeps that deadline:
  // a borrowed 10-minute auth window must not put it back to work early.
  const ownReset = now + 3 * 3600_000;
  quarantinePool(s, 'relay', 'usage limit reached', now, {
    kind: 'quota', evidence: spentWindow(now, 'Error: usage limit reached · resets in 3 hours'),
  });
  assert.equal(s.pools.relay.quarantine.until, ownReset);
  const benched = quarantineUpstreamSiblings(s, relayPools(), {
    pool: 'relay:c', group: GROUP, reason: 'upstream auth failure', now, until: now + 10 * 60_000, kind: 'auth',
  });
  assert.deepEqual(benched, ['relay:b']);
  assert.equal(s.pools.relay.quarantine.until, ownReset);
  assert.equal(s.pools.relay.quarantine.kind, 'quota');
});

test('benching the group is a no-op without a group, a pool, or any members', () => {
  const s = loadState('/nonexistent-bullswarm-test');
  const now = Date.now();
  assert.deepEqual(quarantineUpstreamSiblings(s, relayPools(), { pool: 'relay', group: null, now }), []);
  assert.deepEqual(quarantineUpstreamSiblings(s, relayPools(), { pool: null, group: GROUP, now }), []);
  assert.deepEqual(quarantineUpstreamSiblings(s, null, { pool: 'relay', group: GROUP, now }), []);
  assert.deepEqual(Object.keys(s.pools), []);
});

// --- soft bench (S6) ------------------------------------------------------
// The bench is written by the dispatcher and read by the router out of the one
// shared record, so these are the writers both sides depend on.

test('the first strike is counted without taking the pool out of service', () => {
  const s = loadState('/nonexistent-bullswarm-test');
  const now = Date.UTC(2026, 8, 17, 12, 0, 0);
  assert.equal(recordPoolStrike(s, 'opencode2', 'stall', now), null);
  assert.deepEqual(s.pools.opencode2.bench, { until: null, reason: 'stall', count: 1 });
});

test('the second consecutive strike benches the pool for the cooldown and drops its incumbency', () => {
  const s = loadState('/nonexistent-bullswarm-test');
  s.incumbents = { build: 'opencode2', analyze: 'codex' };
  const now = Date.UTC(2026, 8, 17, 12, 0, 0);
  recordPoolStrike(s, 'opencode2', 'stall', now);
  const until = recordPoolStrike(s, 'opencode2', 'stall', now);
  assert.equal(until, now + BENCH_COOLDOWN_MS);
  assert.deepEqual(s.pools.opencode2.bench, { until, reason: 'stall', count: BENCH_AFTER_STRIKES });
  // A pool that is not serving work cannot hold the lane against its return.
  assert.deepEqual(s.incumbents, { analyze: 'codex' });
});

test('a success clears the strike record entirely', () => {
  const s = loadState('/nonexistent-bullswarm-test');
  const now = Date.UTC(2026, 8, 17, 12, 0, 0);
  recordPoolStrike(s, 'opencode2', 'provider', now);
  recordPoolStrike(s, 'opencode2', 'provider', now);
  clearPoolStrikes(s, 'opencode2');
  assert.equal(s.pools.opencode2.bench, undefined);
  // The next failure starts over at one strike, still in service.
  assert.equal(recordPoolStrike(s, 'opencode2', 'stall', now), null);
  assert.equal(s.pools.opencode2.bench.count, 1);
});

test('sweeping releases an expired bench but keeps the strike count', () => {
  const s = loadState('/nonexistent-bullswarm-test');
  const now = Date.UTC(2026, 8, 17, 12, 0, 0);
  recordPoolStrike(s, 'opencode2', 'stall', now);
  recordPoolStrike(s, 'opencode2', 'stall', now);
  assert.deepEqual(sweepBenches(s, now + BENCH_COOLDOWN_MS - 1), []);
  assert.deepEqual(sweepBenches(s, now + BENCH_COOLDOWN_MS), ['opencode2']);
  assert.deepEqual(s.pools.opencode2.bench, { until: null, reason: 'stall', count: 2 });
  // Still two in a row: a stall right after the cooldown benches it again at once.
  assert.equal(recordPoolStrike(s, 'opencode2', 'stall', now + BENCH_COOLDOWN_MS), now + 2 * BENCH_COOLDOWN_MS);
});

test('a bench is written beside the quarantine and neither touches the other', () => {
  const { dir, cleanup } = tmpDir();
  try {
    const now = Date.UTC(2026, 8, 17, 12, 0, 0);
    const s = loadState(dir);
    s.pools.opencode = { enabled: true };
    quarantinePool(s, 'opencode', 'upstream auth failure', now);
    recordPoolStrike(s, 'opencode', 'stall', now);
    saveState(dir, s);
    const reloaded = loadState(dir);
    assert.equal(reloaded.pools.opencode.quarantine.reason, 'upstream auth failure');
    assert.deepEqual(reloaded.pools.opencode.bench, { until: null, reason: 'stall', count: 1 });
    // Sweeping benches leaves the quarantine deadline alone.
    sweepBenches(reloaded, now + 10 * BENCH_COOLDOWN_MS);
    assert.equal(reloaded.pools.opencode.quarantine.until, now + 10 * 60_000);
    // ...and the router reads the bench back off the pool view it builds.
    saveState(dir, reloaded);
    const { pools } = buildPools(dir, now);
    const pool = pools.find((p) => p.name === 'opencode');
    if (pool) assert.deepEqual(pool.bench, reloaded.pools.opencode.bench);
  } finally { cleanup(); }
});

// --- the quota pause rule (quota.js Q6) and resume --------------------------

const TRANSIENT = 'Error: Rate limit exceeded. Please wait a moment and try again.';

test('a quota pause without proof is refused: nothing written, null returned', () => {
  const s = loadState('/nonexistent-bullswarm-test');
  const now = Date.parse('2026-09-21T06:30:00Z');
  s.incumbents.build = 'claude-code';
  assert.equal(quarantinePool(s, 'claude-code', 'rate limited (transient)', now, {
    until: now + 90 * 60_000, kind: 'quota',
  }), null);
  // The 2026-09-21 case: a transient line, the meter at 78% weekly / 48% 5h.
  const transient = decideQuotaPause({
    text: TRANSIENT,
    meter: {
      captured_at: '2026-09-21T06:20:00Z',
      five_hour: { utilization: 48, resets_at: '2026-09-21T08:00:00Z' },
      seven_day: { utilization: 78, resets_at: '2026-09-24T12:00:00Z' },
    },
    pausing: true,
    now,
  });
  assert.equal(transient.pause, false);
  assert.equal(quarantinePool(s, 'claude-code', transient.why, now, {
    until: now + 90 * 60_000, kind: 'quota', evidence: transient,
  }), null);
  assert.equal(s.pools['claude-code']?.quarantine, undefined);
  assert.equal(s.incumbents.build, 'claude-code', 'a refused pause keeps incumbency');
});

test('a proven quota pause stores the provider line, the meter reading, the rule and the reset', () => {
  const s = loadState('/nonexistent-bullswarm-test');
  const now = Date.parse('2026-09-21T06:30:00Z');
  const meter = {
    captured_at: '2026-09-21T06:20:00Z',
    five_hour: { utilization: 48, resets_at: '2026-09-21T08:00:00Z' },
    seven_day: { utilization: 96, resets_at: '2026-09-24T12:00:00Z' },
  };
  const evidence = decideQuotaPause({ text: TRANSIENT, meter, pausing: true, now, timeZone: 'UTC' });
  const until = quarantinePool(s, 'claude-code', 'ignored when evidence says why', now, {
    until: now + 60_000, kind: 'quota', evidence,
  });
  assert.equal(until, Date.parse('2026-09-24T12:00:00Z'), 'the reset the proof names, not the caller');
  assert.deepEqual(s.pools['claude-code'].quarantine, {
    until,
    reason: evidence.why,
    kind: 'quota',
    rule: 'meter',
    line: TRANSIENT,
    meter: {
      readAt: '2026-09-21T06:20:00.000Z',
      windows: [
        { window: '5h', usedPct: 48, resetsAt: '2026-09-21T08:00:00.000Z' },
        { window: 'weekly', usedPct: 96, resetsAt: '2026-09-24T12:00:00.000Z' },
      ],
    },
    meterWindow: { window: 'weekly', usedPct: 96, resetsAt: '2026-09-24T12:00:00.000Z' },
    resetsAt: '2026-09-24T12:00:00.000Z',
    pausedAt: '2026-09-21T06:30:00.000Z',
  });
  // An explicit spent window with a reset pauses until exactly that reset.
  const message = spentWindow(now);
  assert.equal(quarantinePool(s, 'codex', message.why, now, { kind: 'quota', evidence: message }), now + 2 * 3600_000);
  assert.equal(s.pools.codex.quarantine.rule, 'message');
  // It auto-releases at its reset like every quarantine (S1).
  assert.deepEqual(sweepQuarantines(s, now + 2 * 3600_000), ['codex']);
});

test('automatic pausing off refuses every pause: quota, auth, siblings and the bench', () => {
  const s = loadState('/nonexistent-bullswarm-test');
  const now = Date.parse('2026-09-21T06:30:00Z');
  assert.equal(pausingEnabled(s), true, 'on by default');
  assert.equal(setPausing(s, false), false);
  assert.equal(s.strategy.pausing, 'off');
  // Quota: even a spent window with a reset names no pause.
  assert.equal(quarantinePool(s, 'claude-code', 'x', now, { kind: 'quota', evidence: spentWindow(now) }), null);
  // Auth: a dead credential is not benched either.
  assert.equal(quarantinePool(s, 'grok', 'auth signature', now, { kind: 'auth' }), null);
  // The credential-group siblings of an auth pause are part of the switch.
  assert.equal(quarantinePool(s, 'relay:c', 'upstream auth failure', now, { kind: 'auth' }), null);
  assert.deepEqual(quarantineUpstreamSiblings(s, relayPools(), {
    pool: 'relay:c', group: GROUP, reason: 'upstream auth failure', now, until: now + 10 * 60_000, kind: 'auth',
  }), []);
  // The soft bench takes a pool out of service too, so a strike never benches.
  assert.equal(recordPoolStrike(s, 'codex', 'stall', now), null);
  assert.equal(recordPoolStrike(s, 'codex', 'stall', now), null);
  assert.deepEqual(Object.keys(s.pools), [], 'nothing was written at all');
  assert.equal(setPausing(s, true), true);
  assert.equal('pausing' in s.strategy, false, 'on is the default, stored as absence');
  assert.equal(quarantinePool(s, 'claude-code', 'x', now, { kind: 'quota', evidence: spentWindow(now) }), now + 2 * 3600_000);
  assert.equal(quarantinePool(s, 'grok', 'auth signature', now, { kind: 'auth' }), now + 10 * 60_000);
});

test('a pause in place before the switch was turned off still lifts with resume', () => {
  const s = loadState('/nonexistent-bullswarm-test');
  const now = Date.parse('2026-09-21T06:30:00Z');
  quarantinePool(s, 'grok', 'auth signature', now);
  recordPoolStrike(s, 'grok', 'stall', now);
  recordPoolStrike(s, 'grok', 'stall', now);
  setPausing(s, false);
  // Nothing new is written while off; what was already there is untouched and
  // still liftable (`bullswarm pools resume <pool>` keeps working).
  assert.equal(quarantinePool(s, 'claude-code', 'x', now, { kind: 'quota', evidence: spentWindow(now) }), null);
  assert.equal(s.pools['claude-code'], undefined);
  assert.equal(s.pools.grok.quarantine.kind, 'auth');
  assert.equal(s.pools.grok.bench.count, 2);
  const lifted = resumePool(s, 'grok', now + 60_000);
  assert.equal(lifted.quarantine.kind, 'auth');
  assert.equal(lifted.bench.count, 2);
  assert.deepEqual(s.pools.grok, {});
  assert.equal(s.decisionLog.at(-1).kind, 'pool-resume');
});

test('resume lifts a quota pause at once and logs what it lifted', () => {
  const s = loadState('/nonexistent-bullswarm-test');
  const now = Date.parse('2026-09-21T06:30:00Z');
  const evidence = spentWindow(now);
  quarantinePool(s, 'claude-code', evidence.why, now, { kind: 'quota', evidence });
  const lifted = resumePool(s, 'claude-code', now + 60_000);
  assert.equal(lifted.quarantine.rule, 'message');
  assert.equal(lifted.bench, null);
  assert.equal(s.pools['claude-code'].quarantine, undefined);
  assert.deepEqual(s.decisionLog.at(-1), {
    ts: '2026-09-21T06:31:00.000Z',
    kind: 'pool-resume',
    source: 'pools resume',
    pool: 'claude-code',
    lifted: {
      quarantine: { kind: 'quota', until: '2026-09-21T08:30:00.000Z', reason: evidence.why },
    },
  });
});

test('resume lifts an auth pause and an active bench; an unpaused pool is untouched', () => {
  const s = loadState('/nonexistent-bullswarm-test');
  const now = Date.parse('2026-09-21T06:30:00Z');
  quarantinePool(s, 'grok', 'auth signature', now);
  recordPoolStrike(s, 'grok', 'stall', now);
  recordPoolStrike(s, 'grok', 'stall', now);
  const lifted = resumePool(s, 'grok', now);
  assert.equal(lifted.quarantine.kind, 'auth');
  assert.equal(lifted.bench.count, 2);
  assert.deepEqual(s.pools.grok, {});
  assert.deepEqual(s.decisionLog.at(-1).lifted.bench, { until: '2026-09-21T06:40:00.000Z', reason: 'stall' });
  const before = s.decisionLog.length;
  assert.deepEqual(resumePool(s, 'grok', now), { quarantine: null, bench: null });
  recordPoolStrike(s, 'codex', 'stall', now);
  assert.deepEqual(resumePool(s, 'codex', now), { quarantine: null, bench: null }, 'a counted strike is not a pause');
  assert.equal(s.pools.codex.bench.count, 1);
  assert.equal(s.decisionLog.length, before, 'nothing lifted, nothing logged');
});

// The strike reasons list had no reader; a strike records the
// reason its caller names.
test('the unused bench-reason list stays deleted', async () => {
  const state = await import('../src/lib/state.js');
  assert.equal(Object.hasOwn(state, 'BENCH_REASONS'), false);
});
