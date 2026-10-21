// The status line's other two reads share one cache like pools does: every
// mod refresh also ran `workflow runs --json` and `assignments --json`, each a
// full CLI load (~280 MB), once per Claude session (2026-10-21).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, unlinkSync, utimesSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { cachePaths, readCache, serveCached, writeCache } from '../src/lib/pools-cache.js';
import { cacheMaxAgeSec, freshDoc } from '../mods/bullswarm/hooks/pools.ts';

const BIN = fileURLToPath(new URL('../bin/bullswarm.js', import.meta.url));

function home() {
  return mkdtempSync(join(tmpdir(), 'bs-status-cache-'));
}

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

const RUNS_DOC = { ongoing: true, historical: false, count: 1, runs: [{ runId: 'wf-a', shortId: 'abc123' }] };
const ASSIGNMENTS = [{ pool: 'grok', lane: 'analyze', startedAt: '2026-10-21T00:00:00Z' }];

for (const name of ['runs', 'assignments']) {
  test(`${name}: eight concurrent callers on a stale cache cost one build`, async () => {
    const h = home();
    writeCache(h, name, { old: true }, 1_000);
    let builds = 0;
    const build = async () => {
      builds += 1;
      await new Promise((r) => setTimeout(r, 150));
      return { fresh: true };
    };
    const served = await Promise.all(Array.from({ length: 8 }, () =>
      serveCached({ home: h, name, maxAgeMs: 60_000, build })));
    assert.equal(builds, 1);
    assert.equal(served.filter((s) => s.source === 'stale').length, 7);
    assert.equal(existsSync(cachePaths(h, name).lock), false);
    assert.deepEqual(readCache(h, name).doc, { fresh: true });
  });
}

test('CLI: eight concurrent `workflow runs --json --max-age 60` on a fresh cache all read it', async () => {
  const h = home();
  writeCache(h, 'runs', RUNS_DOC, Date.now());
  const runs = await Promise.all(Array.from({ length: 8 }, () =>
    cli(h, ['workflow', 'runs', '--json', '--max-age', '60'])));
  for (const r of runs) {
    assert.equal(r.code, 0, r.stderr);
    const doc = JSON.parse(r.stdout);
    assert.deepEqual(doc.runs, RUNS_DOC.runs);
    assert.equal(doc.count, 1);
    assert.equal(doc.cache.source, 'cache');
    assert.equal(doc.cache.file, cachePaths(h, 'runs').file);
  }
});

test('CLI: eight concurrent `assignments --json --max-age 60` on a fresh cache all read it, same array shape', async () => {
  const h = home();
  writeCache(h, 'assignments', { assignments: ASSIGNMENTS }, Date.now());
  const runs = await Promise.all(Array.from({ length: 8 }, () =>
    cli(h, ['assignments', '--json', '--max-age', '60'])));
  for (const r of runs) {
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), ASSIGNMENTS);
  }
});

test('CLI: with no cache, the --max-age forms build, answer and write the file', async () => {
  const h = home();
  const runs = await cli(h, ['workflow', 'runs', '--json', '--max-age', '60']);
  assert.equal(runs.code, 0, runs.stderr);
  const doc = JSON.parse(runs.stdout);
  assert.equal(doc.cache.source, 'built');
  assert.deepEqual(doc.runs, []);
  assert.deepEqual(readCache(h, 'runs').doc.runs, []);

  const a = await cli(h, ['assignments', '--json', '--max-age', '60']);
  assert.equal(a.code, 0, a.stderr);
  assert.deepEqual(JSON.parse(a.stdout), []);
  assert.deepEqual(readCache(h, 'assignments').doc.assignments, []);
});

test('CLI: the plain --json forms refresh the cache too', async () => {
  const h = home();
  writeCache(h, 'runs', RUNS_DOC, 1_000);
  writeCache(h, 'assignments', { assignments: ASSIGNMENTS }, 1_000);
  assert.equal((await cli(h, ['workflow', 'runs', '--json'])).code, 0);
  assert.equal((await cli(h, ['assignments', '--json'])).code, 0);
  assert.ok(readCache(h, 'runs').savedAt > 1_000);
  assert.deepEqual(readCache(h, 'runs').doc.runs, []);
  assert.ok(readCache(h, 'assignments').savedAt > 1_000);
  // A filtered list is not the shared answer and leaves the file alone.
  writeCache(h, 'runs', RUNS_DOC, 2_000);
  assert.equal((await cli(h, ['workflow', 'runs', '--json', '--all'])).code, 0);
  assert.equal(readCache(h, 'runs').savedAt, 2_000);
});

test('CLI: --max-age refuses forms that are not the shared answer', async () => {
  const h = home();
  for (const args of [
    ['workflow', 'runs', '--json', '--all', '--max-age', '60'],
    ['workflow', 'runs', '--max-age', '60'],
    ['assignments', '--max-age', '60'],
    ['assignments', '--json', '--max-age', 'soon'],
  ]) {
    const r = await cli(h, args);
    assert.equal(r.code, 2, `${args.join(' ')}: ${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /max-age/);
  }
});

test('cache files carry their own schema, so one is never read as another', () => {
  const h = home();
  writeCache(h, 'runs', RUNS_DOC, 5);
  const text = readFileSync(cachePaths(h, 'runs').file, 'utf8');
  assert.equal(JSON.parse(text).schema, 'bullswarm.runs-cache.v1');
  assert.deepEqual(freshDoc(text, 'runs', 10, 60_000)?.runs, RUNS_DOC.runs);
  assert.equal(freshDoc(text, 'assignments', 10, 60_000), null);
  assert.equal(freshDoc(text, 'runs', 70_000, 60_000), null);
});

test('mod: the max age tightens while work is in flight', () => {
  assert.equal(cacheMaxAgeSec({ stepOpen: false, busy: false }), 60);
  assert.equal(cacheMaxAgeSec({ stepOpen: false, busy: true }), 15);
  assert.equal(cacheMaxAgeSec({ stepOpen: true, busy: true }), 3);
});

// Hardening from an independent review of the lock (grok run qnkeas, 2026-10-21).
test('a lock older than two minutes whose holder is still alive is not broken', async () => {
  const h = home();
  writeCache(h, 'runs', { old: true }, 1_000);
  const { lock } = cachePaths(h, 'runs');
  writeFileSync(lock, `${process.pid} 1000 live-token\n`);
  const old = new Date(Date.now() - 180_000);
  utimesSync(lock, old, old);
  let builds = 0;
  const served = await serveCached({ home: h, name: 'runs', maxAgeMs: 60_000, build: async () => { builds += 1; return {}; } });
  assert.equal(builds, 0);
  assert.equal(served.source, 'stale');
  assert.equal(existsSync(lock), true, 'the live holder keeps its lock');
});

test('releasing never removes a lock another caller has taken since', async () => {
  const h = home();
  const { lock } = cachePaths(h, 'runs');
  const served = serveCached({
    home: h, name: 'runs', maxAgeMs: 60_000,
    build: async () => {
      // Someone broke our lock and took the path while we built.
      unlinkSync(lock);
      writeFileSync(lock, '99999 1 their-token\n');
      return { runs: [] };
    },
  });
  await served;
  assert.equal(readFileSync(lock, 'utf8'), '99999 1 their-token\n');
});

test('a waiter that gives up on another build stores what it built', async () => {
  const h = home();
  const { lock } = cachePaths(h, 'runs');
  mkdirSync(cachePaths(h, 'runs').dir, { recursive: true });
  writeFileSync(lock, `${process.pid} ${Date.now()} live-token\n`);
  const served = await serveCached({
    home: h, name: 'runs', maxAgeMs: 60_000, waitMs: 60, waitStepMs: 20, build: async () => ({ runs: ['mine'] }),
  });
  assert.equal(served.source, 'built');
  assert.deepEqual(readCache(h, 'runs')?.doc.runs, ['mine']);
});
