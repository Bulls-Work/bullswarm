// Caps fixes from the strict Opus review khtijs (out/caps-review/spec.md):
// failing-first tests for F1-F5. Every test runs in a throwaway bullswarm dir
// with injected workers; the only child processes are plain `node` processes
// running src/lib/caps.js against that temp dir (never a worker CLI, never
// ~/.bullswarm).
//
// New seams these tests need (the implementer adds exactly these):
//
//   acquireCallerSlot({ listSlotsFn })  F1. Injectable option, default
//       `listSlots`, called as `listSlotsFn(bullswarmDir, { now, alive })` for
//       every slot listing acquireCallerSlot makes while it decides. The
//       decide (list, count admitted, find position) and the mark (write
//       `admitted: true`) must run inside one cross-process critical section
//       (a lock in the bullswarm dir). The lock is NOT re-entrant per pid: a
//       second acquirer in the same process waits for it like any other (the
//       deterministic test runs both acquirers in one process), retrying
//       through the injected `sleep`.
//
//   acquireCallerSlot({ noWait: true })  F4. Inside the critical section, a
//       caller with no free slot is refused instead of queued: the call
//       returns `{ refused: true, refusal, group, max }` where `refusal` is the
//       same line noWaitRefusal() prints, leaves no slot file behind, never
//       calls onQueued and never sleeps.
//
//   dispatchV2Action({ noWait: true })  F4. Passes `noWait` to
//       acquireCallerSlot; a refusal ends the dispatch with
//       `{ ok: false, failureKind: 'capped', why: <refusal without "✗ ">,
//       attempts: [] }` and no worker starts. `bullswarm run --no-wait` sets it
//       (the launch check stays as the fast path).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  acquireCallerSlot, callerCap, listSlots, normalizeCaps, writeCaps,
} from '../src/lib/caps.js';
import { registerAssignment, releaseAssignment } from '../src/lib/assignments.js';
import { pickPool } from '../src/lib/route.js';
import { dispatchV2Action } from '../src/workflow/v2-dispatch.js';
import { recordGoalCaller } from '../src/workflow/goal.js';

const CAPS_URL = new URL('../src/lib/caps.js', import.meta.url).href;
const tick = () => new Promise((resolve) => { setTimeout(resolve, 2); });

function home(prefix = 'bs-caps-review-') {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

function caps(callers = {}, pools = {}, extra = {}) {
  return normalizeCaps({ callers, pools, ...extra });
}

/** Env for a child `node`: never nested, never a real home. */
function childEnv(dir, extra = {}) {
  const env = { ...process.env, HOME: dir, BULLSWARM_HOME: dir, NO_COLOR: '1', ...extra };
  delete env.BULLSWARM_DEPTH;
  delete env.BULLSWARM_CALLER;
  return env;
}

/** A child `node` running an ESM snippet; resolves {code, stdout, stderr}. */
function runChild(code, env, { onStdout = null, timeoutMs = 8_000 } = {}) {
  const child = spawn(process.execPath, ['--input-type=module', '-e', code], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; onStdout?.(stdout); });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const done = new Promise((resolve) => {
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('exit', (exitCode, signal) => { clearTimeout(timer); resolve({ code: exitCode, signal, stdout, stderr }); });
  });
  return { child, done };
}

// --- F1: cap of 1 never admits two steps that arrive together ---------------------

test('F1: a step whose file lands between another\'s list and mark is not admitted too (deterministic, listSlotsFn seam)', async () => {
  const dir = home();
  try {
    writeCaps(dir, caps({ lead: { max: 1 } }));
    const caller = { name: 'lead', cwd: '/w' };
    // B arrived first (earlier arrival time) but its slot file lands only after
    // A has listed the slots and before A writes its admitted mark.
    let bPromise = null;
    const listSlotsFn = (bullswarmDir, opts) => {
      const seen = listSlots(bullswarmDir, opts);
      if (!bPromise) {
        bPromise = acquireCallerSlot({ bullswarmDir: dir, caller, arrival: () => 1, sleep: tick, pollMs: 1 });
      }
      return seen;
    };
    const a = await acquireCallerSlot({ bullswarmDir: dir, caller, arrival: () => 2, sleep: tick, pollMs: 1, listSlotsFn });
    assert.ok(bPromise, 'acquireCallerSlot lists slots through the injected listSlotsFn seam');
    let bDone = false;
    bPromise.then(() => { bDone = true; });
    for (let i = 0; i < 15; i += 1) await tick();
    const admitted = listSlots(dir).filter((slot) => slot.admitted === true);
    assert.equal(admitted.length, 1, 'cap of 1: exactly one slot is admitted');
    assert.equal(bDone, false, 'the second step waits while the first holds the only slot');
    a.release();
    const b = await bPromise;
    assert.equal(b.group, 'lead');
    assert.equal(b.queued, true, 'the second step started only after the first released');
    b.release();
    assert.equal(listSlots(dir).length, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('F1: 8 node processes at a cap of 1 over several rounds never hold the slot together (stress)', async () => {
  const dir = home('bs-caps-stress-');
  try {
    writeCaps(dir, caps({ lead: { max: 1 } }));
    const PROCS = 8;
    const ROUNDS = 12;
    const ROUND_MS = 180;
    const start = Date.now() + 900;
    const code = `
      import { acquireCallerSlot } from ${JSON.stringify(CAPS_URL)};
      import { closeSync, openSync, unlinkSync } from 'node:fs';
      import { join } from 'node:path';
      const dir = process.env.CAPS_DIR;
      const start = Number(process.env.CAPS_START);
      const rounds = Number(process.env.CAPS_ROUNDS);
      const roundMs = Number(process.env.CAPS_ROUND_MS);
      const holder = join(dir, 'holder');
      const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
      // caps.js sleeps on unref'd timers; keep this process alive while it waits.
      const keepAlive = setInterval(() => {}, 1000);
      let violations = 0; let acquired = 0; let uncapped = 0;
      for (let r = 0; r < rounds; r += 1) {
        const at = start + r * roundMs;
        if (Date.now() < at - 3) await sleep(at - 3 - Date.now());
        while (Date.now() < at) { /* line up the arrivals of every process */ }
        const slot = await acquireCallerSlot({ bullswarmDir: dir, caller: { name: 'lead', cwd: '/w' }, pollMs: 2 });
        if (slot.group !== 'lead') uncapped += 1;
        let mine = false;
        try { closeSync(openSync(holder, 'wx')); mine = true; }
        catch (err) { if (err.code === 'EEXIST') violations += 1; else throw err; }
        acquired += 1;
        await sleep(3);
        if (mine) unlinkSync(holder);
        slot.release();
      }
      clearInterval(keepAlive);
      process.stdout.write(JSON.stringify({ violations, acquired, uncapped }));
    `;
    const env = childEnv(dir, {
      CAPS_DIR: dir, CAPS_START: String(start), CAPS_ROUNDS: String(ROUNDS), CAPS_ROUND_MS: String(ROUND_MS),
    });
    const results = await Promise.all(Array.from({ length: PROCS }, () => runChild(code, env).done));
    let violations = 0; let acquired = 0; let uncapped = 0;
    for (const result of results) {
      assert.equal(result.code, 0, `child exited cleanly: ${result.stderr}`);
      const counts = JSON.parse(result.stdout);
      violations += counts.violations; acquired += counts.acquired; uncapped += counts.uncapped;
    }
    assert.equal(uncapped, 0, 'every child was capped');
    assert.equal(acquired, PROCS * ROUNDS, 'every child got the slot every round');
    assert.equal(violations, 0, 'two processes held the cap-1 slot at the same time');
    assert.equal(listSlots(dir).length, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// --- dispatch helpers (as tests/caps.test.js) -------------------------------------

const action = { id: 'look', lane: 'analyze', effort: 'low' };
const connector = (name) => ({
  name, lanes: ['analyze', 'build', 'chore'], enabled: true, spawn: { cmd: ['fake'] },
  modelSelection: { flag: '--model' }, strategyAssignments: { low: { pool: name, model: 'gpt-5.6-luna' } },
});
const good = { ok: true, why: 'done', meta: { exitCode: 0, wallSec: 1, usage: { totalTokens: 10 } } };

function deps(watchOnce, extra = {}) {
  const core = { config: { depthLimit: 2 }, pools: {}, incumbents: {}, decisionLog: [] };
  return {
    watchOnce,
    loadState: () => structuredClone(core),
    saveState: (_dir, next) => Object.assign(core, structuredClone(next)),
    uuid: () => 'session-fixed',
    sleep: tick,
    capsPollMs: 1,
    ...extra,
  };
}

function runDirFor(root, name, caller) {
  const runDir = join(root, 'workflows', name);
  mkdirSync(runDir, { recursive: true });
  recordGoalCaller(runDir, caller);
  return runDir;
}

function dispatchArgs(root, runDir, id, extra = {}) {
  return {
    action: { ...action, id }, taskText: 'look', targetDir: root,
    paths: { taskFile: join(root, `task-${id}.md`), outFile: join(root, `out-${id}.md`) },
    pools: [connector('luna-1')], bullswarmDir: root, runDir, maxMechanicalRetries: 0, refreshPools: async () => null, ...extra,
  };
}

// --- F2: pool cap waits when the router refuses every open pool --------------------

/** A router that refuses luna-2 (as if off its lane) and routes luna-1 normally. */
const refusesLuna2 = (lane, pools, opts) => (pools.some((p) => p.name === 'luna-1')
  ? pickPool(lane, pools.filter((p) => p.name === 'luna-1'), opts)
  : { pick: null, why: 'refused: luna-2 cannot take this step (test router)', candidates: [] });

test('F2: a step waits when its pool is at cap and the router refuses every other open pool', async () => {
  const root = home('bs-caps-f2-');
  try {
    writeCaps(root, caps({}, { 'luna-1': 1 }));
    const busy = registerAssignment(root, { pool: 'luna-1', lane: 'analyze', effort: 'low', source: 'run' });
    const queued = [];
    let polls = 0;
    const result = await dispatchV2Action({
      ...dispatchArgs(root, null, 'waits', { pools: [connector('luna-1'), connector('luna-2')] }),
      onQueued: (event) => queued.push(event),
      shouldCancel: () => polls > 50,
      dependencies: deps(async () => good, {
        pickPool: refusesLuna2,
        // The busy attempt on luna-1 ends while this step waits.
        sleep: async () => { polls += 1; if (polls === 2) releaseAssignment(root, busy.id); await tick(); },
      }),
    });
    assert.equal(result.ok, true, `waited instead of failing (got failureKind ${result.failureKind}: ${result.why ?? ''})`);
    assert.equal(result.attempts[0].pool, 'luna-1');
    assert.ok(polls >= 2, 'it slept through the injected sleep');
    assert.deepEqual(queued[0], { kind: 'pool', pools: [{ pool: 'luna-1', running: 1, max: 1 }] });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('F2: with no pool cap, a router that refuses every pool still fails at once (no-cap path unchanged)', async () => {
  const root = home('bs-caps-f2-nocap-');
  try {
    let polls = 0;
    let started = false;
    const result = await dispatchV2Action({
      ...dispatchArgs(root, null, 'refused', { pools: [connector('luna-2')] }),
      shouldCancel: () => polls > 50,
      dependencies: deps(async () => { started = true; return good; }, {
        pickPool: refusesLuna2,
        sleep: async () => { polls += 1; await tick(); },
      }),
    });
    assert.equal(result.ok, false);
    assert.equal(started, false);
    assert.equal(polls, 0, 'no wait without a pool cap');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// --- F3: an unlisted name falls through to pane, cwd, then default -----------------

test('F3: a --caller name with no entry falls through to the pane, then the cwd prefix, then the default', () => {
  const c = caps({
    pane: { max: 1, panes: ['w6:p1'] },
    repo: { max: 3, cwdPrefixes: ['/r'] },
    named: { max: 4 },
  }, {}, { default: 2 });
  assert.deepEqual(callerCap(c, { name: 'named', herdrPane: 'w6:p1', cwd: '/r/x' }), { group: 'named', max: 4, source: 'name' },
    'a name with an entry still wins');
  assert.deepEqual(callerCap(c, { name: 'unlisted', herdrPane: 'w6:p1', cwd: '/r/x' }), { group: 'pane', max: 1, source: 'pane' },
    'an unlisted name does not escape its pane cap');
  assert.deepEqual(callerCap(c, { name: 'unlisted', herdrPane: 'w9:p9', cwd: '/r/x' }), { group: 'repo', max: 3, source: 'cwd' },
    'an unlisted name does not escape its directory cap');
  assert.deepEqual(callerCap(c, { name: 'unlisted', cwd: '/elsewhere' }), { group: 'unlisted', max: 2, source: 'default' },
    'only then the default cap, keyed by the name');
  const noDefault = caps({ repo: { max: 3, cwdPrefixes: ['/r'] } });
  assert.deepEqual(callerCap(noDefault, { name: 'unlisted', cwd: '/r/x' }), { group: 'repo', max: 3, source: 'cwd' });
  assert.equal(callerCap(noDefault, { name: 'unlisted', cwd: '/elsewhere' }).max, null, 'no match and no default: uncapped');
});

// --- F4: --no-wait is decided inside slot acquisition -------------------------------

test('F4: acquireCallerSlot with noWait refuses instead of queueing and leaves no slot behind', async () => {
  const dir = home();
  try {
    writeCaps(dir, caps({ lead: { max: 1 } }));
    const caller = { name: 'lead', cwd: '/w' };
    const held = await acquireCallerSlot({ bullswarmDir: dir, caller, sleep: tick, pollMs: 1 });
    const queued = [];
    let polls = 0;
    const refused = await acquireCallerSlot({
      bullswarmDir: dir, caller, noWait: true, pollMs: 1,
      sleep: async () => { polls += 1; await tick(); },
      shouldCancel: () => polls > 5,
      onQueued: (event) => queued.push(event),
    });
    assert.equal(refused.refused, true, 'refused, not queued');
    assert.match(refused.refusal ?? '', /not started \(--no-wait\): caller lead already has 1 step running or queued and its cap is 1/);
    assert.deepEqual(queued, [], 'never reported as queued');
    assert.equal(listSlots(dir).length, 1, 'only the held slot remains');
    held.release();
    const free = await acquireCallerSlot({ bullswarmDir: dir, caller, noWait: true, sleep: tick, pollMs: 1 });
    assert.equal(free.group, 'lead', 'with a free slot noWait takes it');
    assert.notEqual(free.refused, true);
    free.release();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('F4: dispatch with noWait ends capped instead of queueing when the caller is at its cap', async () => {
  const root = home('bs-caps-f4-');
  try {
    writeCaps(root, caps({ lead: { max: 1 } }));
    const caller = { name: 'lead', cwd: '/w' };
    const held = await acquireCallerSlot({ bullswarmDir: root, caller, sleep: tick, pollMs: 1 });
    let started = false;
    let polls = 0;
    const result = await dispatchV2Action({
      ...dispatchArgs(root, runDirFor(root, 'r1', caller), 'nowait'),
      noWait: true,
      shouldCancel: () => polls > 5,
      dependencies: deps(async () => { started = true; return good; }, { sleep: async () => { polls += 1; await tick(); } }),
    });
    assert.equal(result.ok, false);
    assert.equal(result.failureKind, 'capped', `ends capped (got ${result.failureKind})`);
    assert.match(result.why ?? '', /not started \(--no-wait\)/);
    assert.deepEqual(result.attempts, []);
    assert.equal(started, false, 'no worker started');
    assert.equal(listSlots(root).length, 1, 'only the held slot remains');
    held.release();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// --- F5: missing coverage ---------------------------------------------------------

test('F5: a step keeps its caller slot through a mechanical retry and releases it once', async () => {
  const root = home('bs-caps-f5-retry-');
  try {
    writeCaps(root, caps({ lead: { max: 1 } }));
    const caller = { name: 'lead', cwd: '/w' };
    const stalled = { ok: false, failureKind: 'stalled', why: 'stalled: no output', meta: { exitCode: null, wallSec: 2 } };
    let acquires = 0;
    let releases = 0;
    const seen = [];
    const answers = [stalled, good];
    const result = await dispatchV2Action({
      ...dispatchArgs(root, runDirFor(root, 'r1', caller), 'retried', {
        pools: [connector('luna-1'), connector('luna-2')], maxMechanicalRetries: 1,
      }),
      dependencies: deps(async () => {
        seen.push(listSlots(root).filter((slot) => slot.group === 'lead').map((slot) => ({ id: slot.id, admitted: slot.admitted })));
        return answers.shift() ?? good;
      }, {
        acquireCallerSlot: async (args) => {
          acquires += 1;
          const slot = await acquireCallerSlot(args);
          return { ...slot, release() { releases += 1; slot.release(); } };
        },
      }),
    });
    assert.equal(result.ok, true);
    assert.equal(result.attempts.length, 2, 'one stall, one retry');
    assert.equal(seen.length, 2);
    assert.equal(seen[0].length, 1, 'one slot held during the first attempt');
    assert.equal(seen[0][0].admitted, true);
    assert.deepEqual(seen[1], seen[0], 'the same slot held during the retry');
    assert.equal(acquires, 1, 'acquired once');
    assert.equal(releases, 1, 'released once');
    assert.equal(listSlots(root).length, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('F5: a killed holder\'s slot is freed (dead pid pruned) and a waiter starts', async () => {
  const dir = home('bs-caps-f5-kill-');
  try {
    writeCaps(dir, caps({ lead: { max: 1 } }));
    const code = `
      import { acquireCallerSlot } from ${JSON.stringify(CAPS_URL)};
      const slot = await acquireCallerSlot({ bullswarmDir: process.env.CAPS_DIR, caller: { name: 'lead', cwd: '/w' } });
      process.stdout.write(slot.group === 'lead' ? 'held\\n' : 'uncapped\\n');
      setInterval(() => {}, 1000);
    `;
    let heldResolve;
    const heldSeen = new Promise((resolve) => { heldResolve = resolve; });
    const holder = runChild(code, childEnv(dir, { CAPS_DIR: dir }), { onStdout: (out) => { if (out.includes('\n')) heldResolve(out.trim()); } });
    assert.equal(await heldSeen, 'held', 'the child holds the only slot');
    let started = false;
    const waiter = acquireCallerSlot({ bullswarmDir: dir, caller: { name: 'lead', cwd: '/w' }, sleep: tick, pollMs: 1 })
      .then((slot) => { started = true; return slot; });
    for (let i = 0; i < 10; i += 1) await tick();
    assert.equal(started, false, 'the waiter queues behind the live child');
    holder.child.kill('SIGKILL');
    const exit = await holder.done;
    assert.equal(exit.signal, 'SIGKILL');
    const slot = await waiter;
    assert.equal(slot.group, 'lead');
    assert.equal(slot.queued, true, 'it waited, then started once the dead holder was pruned');
    assert.equal(listSlots(dir).length, 1, 'only the waiter\'s slot remains');
    slot.release();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
