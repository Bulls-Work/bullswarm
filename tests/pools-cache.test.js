// The shared pools cache: N Claude sessions asking for `pools --json` at once
// cost one meter build, not N (measured 2026-10-20: 11 concurrent builds at
// 260-345 MB each from the mod's status line).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, existsSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  cachePaths, readCache, serveCached, writePoolsCache,
} from '../src/lib/pools-cache.js';
import { freshPools } from '../mods/bullswarm/hooks/pools.ts';

const POOLS_CACHE_SCHEMA = 'bullswarm.pools-cache.v1';
const poolsCachePaths = (h) => cachePaths(h, 'pools');
function readPoolsCache(h) {
  const cached = readCache(h, 'pools');
  return cached && { savedAt: cached.savedAt, pools: cached.doc.pools };
}
async function servePools({ build, ...rest }) {
  const served = await serveCached({ ...rest, name: 'pools', build: async () => ({ pools: await build() }) });
  return { savedAt: served.savedAt, pools: served.doc.pools, source: served.source };
}

const BIN = fileURLToPath(new URL('../bin/bullswarm.js', import.meta.url));
const POOLS = [{ name: 'grok', enabled: true, usedPct: 10, elapsedPct: 40, pace: 30 }];

function home() {
  return mkdtempSync(join(tmpdir(), 'bs-pools-cache-'));
}

function counter(pools = POOLS, delayMs = 50) {
  const c = { builds: 0 };
  c.build = async () => {
    c.builds += 1;
    await new Promise((r) => setTimeout(r, delayMs));
    return pools;
  };
  return c;
}

test('a fresh cache is served without a build', async () => {
  const h = home();
  writePoolsCache(h, POOLS, 1_000_000);
  const c = counter();
  const served = await servePools({ home: h, maxAgeMs: 60_000, now: () => 1_030_000, build: c.build });
  assert.equal(c.builds, 0);
  assert.equal(served.source, 'cache');
  assert.deepEqual(served.pools, POOLS);
  assert.equal(served.savedAt, 1_000_000);
});

test('eight concurrent callers on a stale cache cost one build', async () => {
  const h = home();
  writePoolsCache(h, [{ name: 'old' }], 1_000_000);
  const c = counter([{ name: 'new' }], 200);
  const served = await Promise.all(Array.from({ length: 8 }, () =>
    servePools({ home: h, maxAgeMs: 60_000, now: () => 2_000_000, build: c.build })));
  assert.equal(c.builds, 1);
  assert.equal(served.filter((s) => s.source === 'built').length, 1);
  // The others answer at once with the last good result rather than queue a build.
  assert.equal(served.filter((s) => s.source === 'stale').length, 7);
  assert.equal(existsSync(poolsCachePaths(h).lock), false, 'the lock is released');
  assert.deepEqual(readPoolsCache(h).pools, [{ name: 'new' }]);
  assert.equal(readPoolsCache(h).savedAt, 2_000_000);
});

test('with no cache yet, concurrent callers wait for the one build', async () => {
  const h = home();
  const c = counter([{ name: 'first' }], 300);
  const served = await Promise.all(Array.from({ length: 5 }, () =>
    servePools({ home: h, maxAgeMs: 60_000, build: c.build, waitStepMs: 20 })));
  assert.equal(c.builds, 1);
  for (const s of served) assert.deepEqual(s.pools, [{ name: 'first' }]);
});

test('a lock left by a dead refresher is broken after two minutes', async () => {
  const h = home();
  writePoolsCache(h, [{ name: 'old' }], 1_000);
  const { lock } = poolsCachePaths(h);
  writeFileSync(lock, '99999 1000\n');
  const old = new Date(Date.now() - 180_000);
  utimesSync(lock, old, old);
  const c = counter([{ name: 'new' }]);
  const served = await servePools({ home: h, maxAgeMs: 60_000, build: c.build });
  assert.equal(c.builds, 1);
  assert.equal(served.source, 'built');
  assert.equal(existsSync(lock), false);
});

test('a live lock with a stale cache answers stale without building', async () => {
  const h = home();
  writePoolsCache(h, [{ name: 'old' }], 1_000);
  writeFileSync(poolsCachePaths(h).lock, `${process.pid} ${Date.now()}\n`);
  const c = counter();
  const served = await servePools({ home: h, maxAgeMs: 60_000, build: c.build });
  assert.equal(c.builds, 0);
  assert.equal(served.source, 'stale');
  assert.deepEqual(served.pools, [{ name: 'old' }]);
});

test('a failed build releases the lock and keeps the old cache', async () => {
  const h = home();
  writePoolsCache(h, [{ name: 'old' }], 1_000);
  await assert.rejects(servePools({
    home: h, maxAgeMs: 60_000, build: async () => { throw new Error('meter down'); },
  }), /meter down/);
  assert.equal(existsSync(poolsCachePaths(h).lock), false);
  assert.deepEqual(readPoolsCache(h).pools, [{ name: 'old' }]);
});

test('the cache file is the pools --json shape plus its schema and time', () => {
  const h = home();
  writePoolsCache(h, POOLS, 5);
  const doc = JSON.parse(readFileSync(poolsCachePaths(h).file, 'utf8'));
  assert.equal(doc.schema, POOLS_CACHE_SCHEMA);
  assert.equal(doc.savedAt, 5);
  assert.deepEqual(doc.pools, POOLS);
});

function cli(h, args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, ...args], {
      env: { ...process.env, BULLSWARM_HOME: h, BULLSWARM_DEPTH: '' },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

test('CLI: eight concurrent `pools --json --max-age 60` on a fresh cache all read it', async () => {
  const h = home();
  mkdirSync(join(h, 'cache'), { recursive: true });
  writePoolsCache(h, POOLS, Date.now());
  const runs = await Promise.all(Array.from({ length: 8 }, () => cli(h, ['pools', '--json', '--max-age', '60'])));
  for (const r of runs) {
    assert.equal(r.code, 0, r.stderr);
    const doc = JSON.parse(r.stdout);
    assert.deepEqual(doc.pools, POOLS);
    assert.equal(doc.cache.source, 'cache');
    assert.equal(doc.cache.file, poolsCachePaths(h).file);
  }
});

test('CLI: --max-age refuses --pool and --force, which are not the shared answer', async () => {
  const h = home();
  for (const extra of [['--pool', 'grok'], ['--force']]) {
    const r = await cli(h, ['pools', '--json', '--max-age', '60', ...extra]);
    assert.equal(r.code, 2, `${extra.join(' ')}: ${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /--max-age/);
  }
  const bad = await cli(h, ['pools', '--json', '--max-age', 'soon']);
  assert.equal(bad.code, 2);
});

test('mod: freshPools takes a cache file only while it is young enough', () => {
  const text = JSON.stringify({ schema: POOLS_CACHE_SCHEMA, savedAt: 1_000_000, pools: POOLS });
  assert.equal(freshPools(text, 1_059_000, 60_000)?.[0]?.name, 'grok');
  assert.equal(freshPools(text, 1_061_000, 60_000), null);
  assert.equal(freshPools('{"pools":[]}', 1_000_000, 60_000), null, 'no schema, no trust');
  assert.equal(freshPools('not json', 1_000_000, 60_000), null);
  // A clock a little behind the writer's still counts as fresh; far ahead of it does not.
  assert.equal(freshPools(text, 995_000, 60_000)?.length, 1);
  assert.equal(freshPools(text, 900_000, 60_000), null);
});
