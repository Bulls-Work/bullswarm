// Every state.json writer goes through the lock (doctrine S5, audit finding
// D5) — not just `run` and `set-provider`.
//
// The reproduction this file guards: two operator commands issued at the same
// time against one home. Before 0.27.1 each one loaded state.json, mutated its
// own copy and wrote it back, so whichever finished last erased the other's
// change. These cases drive the REAL CLI, because the point is that the
// command surface is locked, not that `updateState` is.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { acquireStateLock, releaseStateLock, stateLockPath } from '../src/lib/state.js';

const REPO = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const BIN = join(REPO, 'bin', 'bullswarm.js');

/** A home whose only pool is the echo fixture, explicitly enabled. */
function echoHome() {
  const home = mkdtempSync(join(tmpdir(), 'bs-lock-sites-'));
  mkdirSync(join(home, 'connectors'), { recursive: true });
  for (const file of ['echo.json', 'echo-worker.mjs']) {
    writeFileSync(join(home, 'connectors', file), readFileSync(join(REPO, 'connectors', file)));
  }
  writeFileSync(join(home, 'state.json'), `${JSON.stringify({
    version: 1,
    pools: { echo: { enabled: true } },
    incumbents: {},
    decisionLog: [],
    // Already migrated: these tests are about the strategy writers, not the
    // fixture migration (which is locked and tested in setup.test.js).
    config: { depthLimit: 2, callerName: 'claude-code', testFixturesMigrated: true },
  }, null, 2)}\n`);
  return { home, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

function readState(home) {
  return JSON.parse(readFileSync(join(home, 'state.json'), 'utf8'));
}

/** One real `bullswarm strategy …` process against `home`. */
function strategy(home, args) {
  const child = spawn(process.execPath, [BIN, 'strategy', ...args], {
    env: { ...process.env, BULLSWARM_HOME: home }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const proc = { child, args, output: '' };
  child.stdout.on('data', (chunk) => { proc.output += chunk; });
  child.stderr.on('data', (chunk) => { proc.output += chunk; });
  proc.exit = new Promise((resolve) => child.on('exit', resolve));
  return proc;
}

test('concurrent strategy writers wait for state.lock instead of overwriting each other', async () => {
  const f = echoHome();
  // Held for the whole overlap, so the interleaving is deterministic rather
  // than a hope that two processes collide.
  const lock = acquireStateLock(f.home);
  let released = false;
  try {
    const rung = strategy(f.home, ['set-rung', 'echo', 'high', '--model', 'echo-local']);
    const exclude = strategy(f.home, ['exclude-model', 'something']);
    // Long enough for both to boot and reach their write.
    await new Promise((resolve) => setTimeout(resolve, 1500));
    // The discriminator: an unlocked writer would already have finished here.
    // Both are still running, so both are queued behind the lock.
    assert.equal(rung.child.exitCode, null, `set-rung did not wait for the lock: ${rung.output}`);
    assert.equal(exclude.child.exitCode, null, `exclude-model did not wait for the lock: ${exclude.output}`);

    releaseStateLock(lock);
    released = true;
    assert.equal(await rung.exit, 0, rung.output);
    assert.equal(await exclude.exit, 0, exclude.output);

    const state = readState(f.home);
    assert.deepEqual(
      state.strategy.modelTiers.echo['echo-local'], ['high'],
      'the set-rung write landed',
    );
    assert.deepEqual(
      state.strategy.excludedModels, ['something'],
      'and the exclude-model write landed too, on top of it',
    );
    assert.equal(existsSync(stateLockPath(f.home)), false, 'the lock is always released');
  } finally {
    if (!released) releaseStateLock(lock);
    f.cleanup();
  }
});

test('four different strategy mutations issued at once all survive', async () => {
  const f = echoHome();
  try {
    // One writer per converted code path: set-rung, exclude-model, assign and
    // set-subscription each used to be an unlocked load-mutate-save.
    const procs = [
      strategy(f.home, ['set-rung', 'echo', 'low', '--model', 'echo-local']),
      strategy(f.home, ['exclude-model', 'gpt-nope']),
      strategy(f.home, ['assign', 'high', '--pool', 'echo', '--model', 'echo-local']),
      strategy(f.home, ['set-subscription', 'echo', '--plan', 'Fixture', '--monthly-usd', '0']),
    ];
    for (const proc of procs) assert.equal(await proc.exit, 0, `${proc.args.join(' ')}: ${proc.output}`);

    const { strategy: written } = readState(f.home);
    assert.deepEqual(written.modelTiers.echo['echo-local'], ['low']);
    assert.deepEqual(written.excludedModels, ['gpt-nope']);
    assert.deepEqual(written.assignments.high, { pool: 'echo', model: 'echo-local' });
    assert.deepEqual(written.subscriptions.echo, { plan: 'Fixture', monthlyPriceUsd: 0 });
    assert.equal(existsSync(stateLockPath(f.home)), false);
  } finally { f.cleanup(); }
});

test('a strategy configure document that fails half way writes nothing and frees the lock', async () => {
  const f = echoHome();
  const seeded = JSON.parse(readFileSync(join(f.home, 'state.json'), 'utf8'));
  // A cached report, so `configure` reads the persisted inventory instead of
  // running discovery against installed CLIs.
  seeded.strategy = {
    lastReport: {
      capturedAt: new Date().toISOString(),
      subscriptions: [],
      suggestions: {},
      discoveries: { echo: { models: [{ id: 'echo-local', tier: 'low', qualityRank: 1 }] } },
    },
  };
  writeFileSync(join(f.home, 'state.json'), `${JSON.stringify(seeded, null, 2)}\n`);

  const document = join(f.home, 'strategy.json');
  // First key valid, second unknown: the mutator disables echo and then throws
  // — mid-mutation, while it holds the lock.
  writeFileSync(document, JSON.stringify({ providers: { echo: false, 'not-a-pool': true } }));

  const before = readFileSync(join(f.home, 'state.json'));
  const { cmdStrategy } = await import('../src/strategy-cli.js');
  const originalLog = console.log;
  const originalError = console.error;
  console.log = () => {};
  console.error = () => {};
  try {
    assert.equal(
      await cmdStrategy(['configure', '--file', document, '--yes'], { bullswarmDir: f.home }),
      2,
      'unknown pool is a usage error',
    );
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
  try {
    assert.deepEqual(readFileSync(join(f.home, 'state.json')), before, 'state.json is byte-identical');
    assert.equal(readState(f.home).pools.echo.enabled, true, 'the valid half of the document did not land');
    assert.equal(existsSync(stateLockPath(f.home)), false, 'a throw inside the mutator still releases the lock');
  } finally { f.cleanup(); }
});
