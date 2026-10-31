// A run's pools bound its refresh: a refreshed list keeps only the pools the
// caller started with. Every test injects a fake live builder; none may reach
// the real buildPoolsLive, which discovers every login on the machine.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createPoolRefresher } from '../src/workflow/pool-refresh.js';
import { runOneStep } from '../src/workflow/run-one-step.js';
import { runStepRequest } from '../src/lib/run-step.js';

const DIR = '/tmp/bullswarm-pool-refresh-bounds-fixture';
const pool = (name, pace = 0) => ({
  name, enabled: true, costRank: 2, lanes: ['analyze', 'build', 'chore'],
  pace, fiveHourUsedPct: null, nearFiveHourLimit: false,
});
const fakeLive = (pools) => async () => ({ state: {}, connectors: {}, pools });
const names = (pools) => pools.map((p) => p.name);

test('refresh keeps only the pools the run started with, with their fresh readings', async () => {
  const refresh = createPoolRefresher({
    bullswarmDir: DIR, initialPools: [pool('b', 0)],
    buildPoolsLive: fakeLive([pool('a', 5), pool('b', 9), pool('c', 7)]),
    getReadings: async () => ({}), now: () => 1,
  });
  const out = await refresh({ force: true });
  assert.deepEqual(names(out), ['b']);
  assert.equal(out[0].pace, 9);
});

test('an unforced refresh obeys the same bound', async () => {
  const refresh = createPoolRefresher({
    bullswarmDir: DIR, initialPools: [pool('b')],
    buildPoolsLive: fakeLive([pool('a'), pool('b', 4), pool('c')]),
    getReadings: async () => ({}), now: () => 1,
  });
  assert.deepEqual(names(await refresh()), ['b']);
});

test('a pool that disappears stays out', async () => {
  const refresh = createPoolRefresher({
    bullswarmDir: DIR, initialPools: [pool('a'), pool('b')],
    buildPoolsLive: fakeLive([pool('b')]), getReadings: async () => ({}), now: () => 1,
  });
  assert.deepEqual(names(await refresh({ force: true })), ['b']);
});

test('with no initial pools the refresh returns the whole live set', async () => {
  const refresh = createPoolRefresher({
    bullswarmDir: DIR, initialPools: [],
    buildPoolsLive: fakeLive([pool('a'), pool('b'), pool('c')]), getReadings: async () => ({}), now: () => 1,
  });
  assert.deepEqual(names(await refresh({ force: true })), ['a', 'b', 'c']);
});

test('runOneStep never dispatches to a pool outside the caller\'s list', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'bs-refresh-bounds-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  const repo = join(root, 'repo');
  mkdirSync(home, { recursive: true });
  mkdirSync(repo);
  writeFileSync(join(home, 'state.json'), `${JSON.stringify({
    version: 1, pools: {}, incumbents: {}, decisionLog: [],
    config: { depthLimit: 2, callerName: 'claude-code', testFixturesMigrated: true },
  })}\n`);
  execFileSync('git', ['init', '-q', repo]);
  writeFileSync(join(repo, 'README.md'), 'x\n');
  execFileSync('git', ['-C', repo, 'add', '.']);
  execFileSync('git', ['-C', repo, '-c', 'user.name=T', '-c', 'user.email=t@example.com', 'commit', '-qm', 'seed']);

  const parsed = runStepRequest({ lane: 'build', prompt: 'noop', rest: [] }, { cwd: repo });
  assert.equal(parsed.error, undefined);
  const seen = [];
  const dispatchV2Action = async (options) => {
    for (const p of options.pools ?? []) seen.push(p.name);
    const refreshed = await options.refreshPools?.({ force: true });
    for (const p of refreshed ?? []) seen.push(p.name);
    return { ok: false, status: 'failed', verdict: 'failed', attempts: [], reason: 'fake' };
  };
  await runOneStep({
    bullswarmDir: home, request: parsed.request, pools: [pool('fake-one')],
    dependencies: {
      dispatchV2Action,
      poolRefresher: { buildPoolsLive: fakeLive([pool('fake-one'), pool('claude-code:real')]), getReadings: async () => ({}) },
    },
  }).catch(() => {});
  assert.ok(seen.length > 0, 'the recorder must have been called');
  assert.deepEqual([...new Set(seen)], ['fake-one']);
});
