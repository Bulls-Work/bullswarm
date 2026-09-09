import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadState, saveState, updateState, quarantinePool, sweepQuarantines,
  acquireStateLock, releaseStateLock, stateLockPath, STATE_LOCK_STALE_MS,
  assertDepthAllowed, currentDepth, childDepthEnv, DEPTH_ENV,
} from '../src/lib/state.js';
import { buildPools } from '../src/lib/config.js';

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
  const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { spawnSync } = await import('node:child_process');
  const repo = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
  const home = mkdtempSync(join(tmpdir(), 'bullswarm-cli-home-'));
  try {
    mkdirSync(join(home, 'connectors'), { recursive: true });
    for (const file of ['echo.json', 'echo-worker.mjs']) {
      writeFileSync(join(home, 'connectors', file), readFileSync(join(repo, 'connectors', file)));
    }
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
    assert.equal(doctor.status, 1, doctor.stderr);
    const doctorJson = JSON.parse(doctor.stdout);
    assert.equal(doctorJson.configured, true);
    assert.equal(doctorJson.ok, false);
    assert.equal(doctorJson.checks.find((check) => check.id === 'offload-capable').ok, false);
    assert.match(doctorJson.checks[0].detail, new RegExp(home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

    const pools = spawnSync('node', [join(repo, 'bin/bullswarm.js'), 'pools', '--json'], {
      env, encoding: 'utf8',
    });
    assert.equal(pools.status, 0, pools.stderr);
    const poolsJson = JSON.parse(pools.stdout);
    assert.deepEqual(poolsJson.pools.map((p) => p.name), ['echo']);
    assert.equal(poolsJson.pools[0].enabled, false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
