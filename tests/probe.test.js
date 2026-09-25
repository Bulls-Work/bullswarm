import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  FREE_MODEL_PROBE_PROMPT, FREE_MODEL_PROBE_TTL_MS, probeFreeModel,
} from '../src/lib/probe.js';
import { dispatchV2Action } from '../src/workflow/v2-dispatch.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function fixture(model, source = 'tier-selection') {
  return {
    name: 'opencode',
    modelPolicy: { model, source },
    connector: {
      name: 'opencode',
      model,
      modelProfiles: [{ id: 'zen/union-free', free: true }, { id: 'paid/model', free: false }],
    },
  };
}

function home() {
  const dir = mkdtempSync(join(tmpdir(), 'bullswarm-probe-test-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function realRunnerFixture(name, script) {
  const base = fixture('zen/union-free');
  return {
    ...base,
    name,
    connector: {
      ...base.connector,
      spawn: { cmd: [process.execPath, join(REPO_ROOT, 'tests', 'fixtures', script), '{taskFile}'] },
    },
  };
}

test('free-model probe skips the connector default and paid model', async () => {
  const f = home();
  let calls = 0;
  try {
    const runner = async () => { calls += 1; return { ok: true }; };
    const defaultRung = await probeFreeModel({
      pool: fixture('zen/union-free', 'connector-default'),
      model: 'zen/union-free', home: f.dir, runner,
    });
    const paid = await probeFreeModel({
      pool: fixture('paid/model'), model: 'paid/model', home: f.dir, runner,
    });
    const staleFreeView = await probeFreeModel({
      pool: { ...fixture('paid/model'), free: true, freeModel: 'zen/union-free' },
      model: 'paid/model', home: f.dir, runner,
    });
    const unlabelledFreeView = await probeFreeModel({
      pool: { ...fixture('paid/model'), free: true },
      model: 'paid/model', home: f.dir, runner,
    });
    assert.equal(defaultRung.ok, true);
    assert.equal(defaultRung.skipped, true);
    assert.equal(paid.ok, true);
    assert.equal(paid.skipped, true);
    assert.equal(staleFreeView.skipped, true);
    assert.equal(unlabelledFreeView.skipped, true);
    assert.equal(calls, 0);
  } finally { f.cleanup(); }
});

test('free-model probe caches its answer per pool and model for 15 minutes', async () => {
  const f = home();
  let calls = 0;
  const runner = async ({ prompt }) => {
    calls += 1;
    assert.equal(prompt, FREE_MODEL_PROBE_PROMPT);
    return { ok: true };
  };
  try {
    const first = await probeFreeModel({
      pool: fixture('zen/union-free'), model: 'zen/union-free', home: f.dir,
      now: 1_000_000, runner,
    });
    const cached = await probeFreeModel({
      pool: fixture('zen/union-free'), model: 'zen/union-free', home: f.dir,
      now: 1_000_000 + FREE_MODEL_PROBE_TTL_MS - 1, runner,
    });
    const refreshed = await probeFreeModel({
      pool: fixture('zen/union-free'), model: 'zen/union-free', home: f.dir,
      now: 1_000_000 + FREE_MODEL_PROBE_TTL_MS, runner,
    });
    assert.equal(first.ok, true);
    assert.equal(cached.cached, true);
    assert.equal(refreshed.cached, undefined);
    assert.equal(calls, 2);
    const cache = JSON.parse(readFileSync(join(f.dir, 'cache', 'free-model-probes.json'), 'utf8'));
    assert.equal(Object.keys(cache.entries).length, 1);
  } finally { f.cleanup(); }
});

test('free-model probe reports timeout, 404 and provider errors distinctly', async () => {
  const f = home();
  try {
    const timeout = await probeFreeModel({
      pool: fixture('zen/union-free'), model: 'zen/union-free', home: f.dir,
      now: 2_000_000, runner: async () => ({ ok: false, meta: { timedOut: true } }),
    });
    const missing = await probeFreeModel({
      pool: { ...fixture('zen/union-free'), name: 'opencode-404' }, model: 'zen/union-free', home: f.dir,
      now: 2_000_001,
      runner: async () => ({
        ok: false,
        why: 'API error: 404 model not found',
        meta: { exitCode: 1, timedOut: false, stalled: false },
      }),
    });
    const provider = await probeFreeModel({
      pool: { ...fixture('zen/union-free'), name: 'opencode-provider-error' }, model: 'zen/union-free', home: f.dir,
      now: 2_000_002,
      runner: async () => ({
        ok: false,
        why: 'upstream service unavailable',
        stderr: 'provider returned an invalid response',
        meta: { exitCode: 1, timedOut: false, stalled: false },
      }),
    });
    assert.deepEqual(timeout.reason, 'timeout');
    assert.deepEqual(missing.reason, '404');
    assert.deepEqual(provider.reason, 'provider error');
  } finally { f.cleanup(); }
});

test('the real default runner classifies stderr 404 and provider errors', async () => {
  const f = home();
  try {
    const missing = await probeFreeModel({
      pool: realRunnerFixture('opencode-real-404', 'probe-404-connector.mjs'),
      model: 'zen/union-free',
      home: f.dir,
      now: 2_100_000,
    });
    const provider = await probeFreeModel({
      pool: realRunnerFixture('opencode-real-provider-error', 'probe-provider-error-connector.mjs'),
      model: 'zen/union-free',
      home: f.dir,
      now: 2_100_001,
    });
    assert.equal(missing.ok, false);
    assert.equal(missing.reason, '404');
    assert.equal(provider.ok, false);
    assert.equal(provider.reason, 'provider error');
  } finally { f.cleanup(); }
});

test('a failed dispatch probe falls through to a metered pool, says why, and stores no strike', async () => {
  const f = home();
  const core = { config: { depthLimit: 2 }, pools: {}, incumbents: {}, decisionLog: [] };
  const free = {
    name: 'free', lanes: ['build'], enabled: true, costRank: 1,
    model: 'zen/union-free', modelProfiles: [{ id: 'zen/union-free', free: true }],
    modelSelection: { flag: '--model' },
    strategyAssignments: { low: { pool: 'free', model: 'zen/union-free' } },
    spawn: { cmd: ['fake'] },
  };
  const paid = {
    name: 'paid', lanes: ['build'], enabled: true, costRank: 2,
    strategyAssignments: { low: { pool: 'paid', model: 'paid/model' } },
    spawn: { cmd: ['fake'] },
  };
  let clock = 1_000_000;
  try {
    const result = await dispatchV2Action({
      action: { id: 'probe-fallback', lane: 'build', effort: 'low' },
      taskText: 'do it', targetDir: f.dir,
      paths: { taskFile: join(f.dir, 'task.md'), outFile: join(f.dir, 'out.md') },
      pools: [free, paid], bullswarmDir: f.dir,
      dependencies: {
        now: () => { clock += 1_000; return clock; },
        loadState: () => structuredClone(core),
        saveState: (_home, next) => Object.assign(core, structuredClone(next)),
        probeFreeModel: async ({ pool }) => pool.name === 'free'
          ? { ok: false, reason: '404', at: new Date(clock).toISOString() }
          : { ok: true, reason: null, at: new Date(clock).toISOString() },
        watchOnce: async () => ({ ok: true, why: 'verified', meta: { exitCode: 0, wallSec: 1 } }),
      },
    });
    assert.equal(result.ok, true);
    assert.deepEqual(result.attempts.map((attempt) => attempt.pool), ['paid']);
    assert.match(result.attempts[0].routeWhy, /probe: 404/);
    assert.deepEqual(core.pools, {}, 'the next dispatch probes the free pool afresh');
  } finally { f.cleanup(); }
});
