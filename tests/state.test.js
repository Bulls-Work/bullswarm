import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadState, saveState, quarantinePool, sweepQuarantines,
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
    writeFileSync(join(home, 'state.json'), JSON.stringify({
      version: 1, pools: { echo: { enabled: true } }, incumbents: {},
      decisionLog: [], config: { depthLimit: 2, callerName: 'claude-code' },
    }));
    const env = { ...process.env, BULLSWARM_HOME: home };
    const doctor = spawnSync('node', [join(repo, 'bin/bullswarm.js'), 'doctor', '--json'], {
      env, encoding: 'utf8',
    });
    assert.equal(doctor.status, 0, doctor.stderr);
    const doctorJson = JSON.parse(doctor.stdout);
    assert.equal(doctorJson.configured, true);
    assert.match(doctorJson.checks[0].detail, new RegExp(home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

    const pools = spawnSync('node', [join(repo, 'bin/bullswarm.js'), 'pools', '--json'], {
      env, encoding: 'utf8',
    });
    assert.equal(pools.status, 0, pools.stderr);
    const poolsJson = JSON.parse(pools.stdout);
    assert.deepEqual(poolsJson.pools.map((p) => p.name), ['echo']);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
