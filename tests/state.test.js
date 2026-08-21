import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadState, saveState, quarantinePool, sweepQuarantines,
  assertDepthAllowed, currentDepth, childDepthEnv, DEPTH_ENV,
} from '../src/lib/state.js';

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
