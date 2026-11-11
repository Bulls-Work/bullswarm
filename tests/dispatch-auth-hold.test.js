// A sign-in failure at dispatch holds the pool for later runs
// (src/lib/auth-hold.js): real state file in a temp home, fake worker CLIs,
// an injected clock. Each `go` is a separate dispatch over the same home.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dispatchV2Action } from '../src/workflow/v2-dispatch.js';
import { buildPools } from '../src/lib/config.js';
import { loadState } from '../src/lib/state.js';
import { poolStatusText } from '../src/cli.js';

const MIN = 60_000;
const T0 = Date.parse('2026-10-31T13:00:00Z');
const action = { id: 'do-work', lane: 'build', effort: 'low' };

function fixture(pools) {
  const root = mkdtempSync(join(tmpdir(), 'bs-auth-hold-'));
  const home = join(root, 'home');
  mkdirSync(join(home, 'connectors'), { recursive: true });
  const signedOut = (name) => join(root, `${name}.signed-out`);
  for (const [name, extra] of Object.entries(pools)) {
    // The worker signs out while its marker file exists, else answers.
    const script = `if (require('fs').existsSync(${JSON.stringify(signedOut(name))})) {
      process.stderr.write('Error: unauthorized. Please login again.\\n'); process.exit(1);
    } console.log('## Completed\\n\\nMade the change and verified it: all checks passed with no failures.')`;
    writeFileSync(join(home, 'connectors', `${name}.json`), JSON.stringify({
      name, lanes: ['build'], costRank: 2, spawn: { cmd: [process.execPath, '-e', script] },
      authSignatures: ['unauthorized'], outputExtraction: { strategy: 'stdout' }, ...extra,
    }));
  }
  const signOut = (name, out = true) => {
    if (out) writeFileSync(signedOut(name), '');
    else rmSync(signedOut(name), { force: true });
  };
  let runs = 0;
  const go = async (atMs, { strictPool = null, readings = {} } = {}) => {
    const dir = join(root, `run-${++runs}`);
    mkdirSync(dir);
    const { pools } = buildPools(home, atMs, readings);
    return dispatchV2Action({
      action, taskText: 'do it', targetDir: dir,
      paths: { taskFile: join(dir, 'task.md'), outFile: join(dir, 'out.md') },
      pools, bullswarmDir: home, strictPool, maxMechanicalRetries: 0,
      dependencies: { now: () => atMs },
    });
  };
  const hold = (name) => loadState(home).pools?.[name]?.authHold ?? null;
  const view = (name, atMs, readings = {}) => buildPools(home, atMs, readings).pools.find((p) => p.name === name);
  return { root, home, go, signOut, hold, view, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

const picked = (result) => result.attempts.map((attempt) => attempt.pool);

test('a sign-in failure on pool A in one run keeps the next run off A', async () => {
  const f = fixture({ a: { pace: 60 }, b: { pace: 50 } });
  try {
    f.signOut('a');
    const first = await f.go(T0);
    assert.equal(first.attempts[0].pool, 'a');
    assert.equal(first.attempts[0].failureKind, 'auth');
    // A separate dispatch, same home, 7 s later: B, never A.
    const second = await f.go(T0 + 7000);
    assert.equal(second.ok, true);
    assert.deepEqual(picked(second), ['b']);
  } finally { f.cleanup(); }
});

test('with only A eligible the next run does not dispatch and names the hold', async () => {
  const f = fixture({ a: {} });
  try {
    f.signOut('a');
    assert.equal((await f.go(T0)).attempts[0].failureKind, 'auth');
    const second = await f.go(T0 + 5 * MIN);
    assert.equal(second.ok, false);
    assert.deepEqual(second.attempts, []);
    assert.match(second.verdict.why, /sign-in failed at dispatch 5m ago until 2026-10-31T13:15:00\.000Z/);
    assert.match(second.routeCandidates[0].excluded, /sign-in failed at dispatch 5m ago/);
    assert.match(poolStatusText(f.view('a', T0 + 5 * MIN), T0 + 5 * MIN), /^not ready · sign-in failed at dispatch 5m ago/);
  } finally { f.cleanup(); }
});

test('the hold ends after 15 minutes; a second failure holds 30, a third 60, then 60', async () => {
  const f = fixture({ a: {} });
  try {
    f.signOut('a');
    await f.go(T0);
    assert.equal(f.hold('a').level, 0);
    assert.equal((await f.go(T0 + 14 * MIN)).attempts.length, 0, 'still held at 14 minutes');
    let at = T0 + 15 * MIN + 1000;
    for (const [minutes, level] of [[30, 1], [60, 2], [60, 2]]) {
      const run = await f.go(at);
      assert.equal(run.attempts[0].failureKind, 'auth', `eligible again at ${at - T0}ms`);
      const stored = f.hold('a');
      assert.equal(Date.parse(stored.until) - Date.parse(stored.at), minutes * MIN);
      assert.equal(stored.level, level);
      assert.equal((await f.go(at + (minutes - 1) * MIN)).attempts.length, 0, `${minutes}m hold still on`);
      at += minutes * MIN + 1000;
    }
  } finally { f.cleanup(); }
});

test('a successful attempt on the pool resets the hold to 15 minutes', async () => {
  const f = fixture({ a: {} });
  try {
    f.signOut('a');
    await f.go(T0);
    await f.go(T0 + 16 * MIN);
    assert.equal(f.hold('a').level, 1);
    f.signOut('a', false);
    const ok = await f.go(T0 + 50 * MIN);
    assert.equal(ok.ok, true);
    assert.equal(f.hold('a'), null);
    f.signOut('a');
    await f.go(T0 + 60 * MIN);
    const stored = f.hold('a');
    assert.equal(Date.parse(stored.until) - Date.parse(stored.at), 15 * MIN);
  } finally { f.cleanup(); }
});

test('a successful meter read does not clear the hold', async () => {
  const f = fixture({ a: {} });
  try {
    f.signOut('a');
    await f.go(T0);
    const resetsAt = new Date(T0 + 3 * 86400_000).toISOString();
    const readings = { a: { source: 'live', pacingWindow: 'weekly', pacing: { usedPct: 10, elapsedPct: 50, surplus: 40, resetsAt }, burstGate: false } };
    assert.ok(f.view('a', T0 + MIN, readings).authHold, 'the view carries the hold');
    const second = await f.go(T0 + MIN, { readings });
    assert.equal(second.ok, false);
    assert.deepEqual(second.attempts, []);
  } finally { f.cleanup(); }
});

test('a pool in the credential group of A is held too', async () => {
  const f = fixture({ a: { credentialGroup: 'relay', pace: 60 }, a2: { credentialGroup: 'relay', pace: 55 }, c: { pace: 10 } });
  try {
    f.signOut('a');
    const first = await f.go(T0);
    assert.equal(first.attempts[0].pool, 'a');
    assert.equal(f.view('a2', T0 + MIN).authHold.via, 'a');
    const second = await f.go(T0 + MIN);
    assert.deepEqual(picked(second), ['c'], 'never the sibling on the dead credential');
    assert.equal(f.view('c', T0 + MIN).authHold, undefined);
  } finally { f.cleanup(); }
});

test('a pinned pool is still dispatched, and its route reason names the hold', async () => {
  const f = fixture({ a: {}, b: {} });
  try {
    f.signOut('a');
    await f.go(T0, { strictPool: 'a' });
    f.signOut('a', false);
    const pinned = await f.go(T0 + 2 * MIN, { strictPool: 'a' });
    assert.equal(pinned.ok, true);
    assert.deepEqual(picked(pinned), ['a']);
    assert.match(pinned.attempts[0].routeWhy, /a pinned, dispatched despite sign-in failed at dispatch 2m ago/);
  } finally { f.cleanup(); }
});
