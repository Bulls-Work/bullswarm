// Concurrency caps (src/lib/caps.js, pace-caps-1120): per-caller caps that
// queue a step over the cap, a per-pool backstop, and the `bullswarm caps`
// CLI. Every test runs in a throwaway BULLSWARM_HOME with injected workers:
// nothing here spawns a real CLI or reads a live meter.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  acquireCallerSlot, callerCap, listSlots, noWaitRefusal, normalizeCaps, poolsAtCap, readCaps, slotsDir, writeCaps,
} from '../src/lib/caps.js';
import { callerIdentity, normalizeCaller } from '../src/lib/caller.js';
import { registerAssignment, releaseAssignment } from '../src/lib/assignments.js';
import { dispatchV2Action } from '../src/workflow/v2-dispatch.js';
import { recordGoalCaller } from '../src/workflow/goal.js';
import { cmdCaps } from '../src/caps-cli.js';

const BIN = fileURLToPath(new URL('../bin/bullswarm.js', import.meta.url));
const tick = () => new Promise((resolve) => { setTimeout(resolve, 2); });

function home(prefix = 'bs-caps-') {
  return mkdtempSync(join(tmpdir(), prefix));
}

function caps(callers = {}, pools = {}, extra = {}) {
  return normalizeCaps({ callers, pools, ...extra });
}

// --- the rules -----------------------------------------------------------------

test('a caller is matched by name first, then pane, then the longest cwd prefix (C2)', () => {
  const c = caps({
    repo: { max: 3, cwdPrefixes: ['/r'] },
    wati: { max: 2, cwdPrefixes: ['/r/wati'] },
    pane: { max: 1, panes: ['w6:p1'] },
    named: { max: 4 },
  });
  assert.deepEqual(callerCap(c, { cwd: '/r/wati/src' }), { group: 'wati', max: 2, source: 'cwd' });
  assert.deepEqual(callerCap(c, { cwd: '/r/other' }), { group: 'repo', max: 3, source: 'cwd' });
  assert.equal(callerCap(c, { cwd: '/r/watiX' }).group, 'repo', 'a prefix matches whole directories only');
  assert.deepEqual(callerCap(c, { herdrPane: 'w6:p1', cwd: '/r/wati' }), { group: 'pane', max: 1, source: 'pane' });
  assert.deepEqual(callerCap(c, { name: 'named', herdrPane: 'w6:p1', cwd: '/r/wati' }), { group: 'named', max: 4, source: 'name' });
  assert.deepEqual(callerCap(c, { cwd: '/elsewhere' }), { group: null, max: null, source: 'default' }, 'no match and no default: uncapped');
});

test('the default cap applies to each unmatched caller alone, and nested work is never capped (C2, C5)', () => {
  const c = caps({}, {}, { default: 2 });
  assert.deepEqual(callerCap(c, { herdrPane: 'w1:p2', cwd: '/x' }), { group: 'pane:w1:p2', max: 2, source: 'default' });
  assert.deepEqual(callerCap(c, { herdrPane: null, cwd: '/x' }), { group: 'cwd:/x', max: 2, source: 'default' });
  assert.equal(callerCap(c, { name: 'solo', cwd: '/x' }).group, 'solo', 'a name with no entry is its own group under the default');
  assert.equal(callerCap(c, { herdrPane: 'w1:p2', cwd: '/x', nested: true }).max, null);
  assert.equal(callerCap(c, null).max, null);
});

test('a broken or missing caps file means no caps; invalid entries are dropped (C1)', () => {
  const dir = home();
  try {
    assert.deepEqual(readCaps(dir).callers, {});
    writeFileSync(join(dir, 'caps.json'), '{not json');
    assert.deepEqual(readCaps(dir).pools, {});
    const c = normalizeCaps({
      callers: { ok: { max: 2, cwdPrefixes: ['/a/', 'relative'], panes: ['w1:p1', 'bad'] }, 'bad name!': { max: 1 }, neg: { max: -1 }, default: { max: 1 } },
      pools: { 'claude-code:w': 8, broken: 'x' },
    });
    assert.deepEqual(c.callers, { ok: { max: 2, cwdPrefixes: ['/a'], panes: ['w1:p1'] } });
    assert.deepEqual(c.pools, { 'claude-code:w': 8 });
    // Writing caps with no default must not turn "no default" into a cap of 0,
    // which would hold back every caller no group names.
    writeCaps(dir, caps({ lead: { max: 1 } }));
    assert.equal(readCaps(dir).default, null);
    assert.equal(callerCap(readCaps(dir), { cwd: '/elsewhere' }).max, null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('caller identity carries an explicit name and the nested mark only when set', () => {
  assert.deepEqual(callerIdentity({ env: {}, cwd: '/w' }), { herdrPane: null, claudeSession: null, cwd: '/w' });
  assert.deepEqual(callerIdentity({ env: { BULLSWARM_CALLER: 'wati-lead' }, cwd: '/w' }), { herdrPane: null, claudeSession: null, cwd: '/w', name: 'wati-lead' });
  assert.deepEqual(callerIdentity({ env: { BULLSWARM_DEPTH: '1' }, cwd: '/w' }).nested, true);
  assert.equal('nested' in callerIdentity({ env: { BULLSWARM_DEPTH: '0' }, cwd: '/w' }), false);
  assert.equal('name' in callerIdentity({ env: { BULLSWARM_CALLER: 'bad name' }, cwd: '/w' }), false, 'a malformed name is never recorded');
  assert.deepEqual(normalizeCaller({ herdrPane: 'w1:p1', cwd: '/w', name: 'x', nested: true, extra: 1 }), { herdrPane: 'w1:p1', claudeSession: null, cwd: '/w', name: 'x', nested: true });
});

// --- slots ---------------------------------------------------------------------

test('slots run in arrival order: over the cap a step waits and starts when a slot frees (C3)', async () => {
  const dir = home();
  try {
    writeCaps(dir, caps({ lead: { max: 2 } }));
    const caller = { name: 'lead', cwd: '/w' };
    let clock = 1000;
    const now = () => clock++;
    const a = await acquireCallerSlot({ bullswarmDir: dir, caller, now, sleep: tick, pollMs: 1 });
    const b = await acquireCallerSlot({ bullswarmDir: dir, caller, now, sleep: tick, pollMs: 1 });
    const queued = [];
    let cStarted = false;
    const cPromise = acquireCallerSlot({ bullswarmDir: dir, caller, now, sleep: tick, pollMs: 1, onQueued: (e) => queued.push(e) })
      .then((slot) => { cStarted = true; return slot; });
    for (let i = 0; i < 10; i += 1) await tick();
    assert.equal(cStarted, false, 'the third step waits at a cap of 2');
    assert.deepEqual(queued[0], { group: 'lead', max: 2, ahead: 0, running: 2 });
    a.release();
    const c = await cPromise;
    assert.equal(c.queued, true);
    assert.equal(listSlots(dir).length, 2, 'b and c hold the two slots');
    b.release(); c.release(); c.release();
    assert.equal(listSlots(dir).length, 0, 'release is idempotent');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a cancelled wait gives up its place; a raised cap admits waiting steps; dead holders are pruned (C3, C4)', async () => {
  const dir = home();
  try {
    writeCaps(dir, caps({ lead: { max: 1 } }));
    const caller = { name: 'lead', cwd: '/w' };
    const held = await acquireCallerSlot({ bullswarmDir: dir, caller, sleep: tick, pollMs: 1 });
    let cancel = false;
    const cancelled = acquireCallerSlot({ bullswarmDir: dir, caller, sleep: tick, pollMs: 1, shouldCancel: () => cancel });
    await tick(); await tick();
    cancel = true;
    assert.equal((await cancelled).cancelled, true);
    assert.equal(listSlots(dir).length, 1, 'the cancelled step left the queue');

    const raised = acquireCallerSlot({ bullswarmDir: dir, caller, sleep: tick, pollMs: 1 });
    await tick(); await tick();
    writeCaps(dir, caps({ lead: { max: 2 } }));
    const second = await raised;
    assert.equal(second.max, 2, 'the Pacer raising the cap lets the waiting step start');
    held.release(); second.release();

    // A slot whose kernel died holds nothing.
    mkdirSync(slotsDir(dir), { recursive: true });
    writeFileSync(join(slotsDir(dir), 'ghost.json'), JSON.stringify({ id: 'ghost', group: 'lead', pid: 999999, at: 1 }));
    writeCaps(dir, caps({ lead: { max: 1 } }));
    const after = await acquireCallerSlot({ bullswarmDir: dir, caller, sleep: tick, pollMs: 1, alive: () => false });
    assert.equal(after.queued, false, 'the dead holder was pruned, not waited on');
    assert.equal(existsSync(join(slotsDir(dir), 'ghost.json')), false);
    after.release();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('an uncapped caller holds no slot at all', async () => {
  const dir = home();
  try {
    const slot = await acquireCallerSlot({ bullswarmDir: dir, caller: { cwd: '/w' } });
    assert.equal(slot.group, null);
    assert.equal(existsSync(slotsDir(dir)), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('poolsAtCap names each capped pool at or over its cap', () => {
  const full = poolsAtCap(caps({}, { a: 2, b: 3 }), new Map([['a', 2], ['b', 1], ['c', 9]]));
  assert.deepEqual([...full], [['a', { count: 2, max: 2 }]]);
});

// --- dispatch --------------------------------------------------------------------

const action = { id: 'look', lane: 'analyze', effort: 'low' };
const connector = (name) => ({
  name, lanes: ['analyze', 'build', 'chore'], enabled: true, spawn: { cmd: ['fake'] },
  modelSelection: { flag: '--model' }, strategyAssignments: { low: { pool: name, model: 'gpt-5.6-luna' } },
});
const good = { ok: true, why: 'done', meta: { exitCode: 0, wallSec: 1, usage: { totalTokens: 10 } } };

function deps(watchOnce) {
  const core = { config: { depthLimit: 2 }, pools: {}, incumbents: {}, decisionLog: [] };
  return {
    watchOnce,
    loadState: () => structuredClone(core),
    saveState: (_dir, next) => Object.assign(core, structuredClone(next)),
    uuid: () => 'session-fixed',
    sleep: tick,
    capsPollMs: 1,
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
    pools: [connector('luna-1')], bullswarmDir: root, runDir, maxMechanicalRetries: 0, ...extra,
  };
}

test('dispatch: a second step from a caller at its cap of 1 waits for the first, then runs (queue over cap)', async () => {
  const root = realpathSync(home('bs-caps-dispatch-'));
  try {
    writeCaps(root, caps({ 'lead-a': { max: 1, cwdPrefixes: ['/work/a'] } }));
    const caller = { herdrPane: null, claudeSession: null, cwd: '/work/a/repo' };
    const order = [];
    let finishFirst;
    const firstDone = new Promise((resolve) => { finishFirst = resolve; });
    const queued = [];
    const first = dispatchV2Action({
      ...dispatchArgs(root, runDirFor(root, 'r1', caller), 'one'),
      dependencies: deps(async () => { order.push('one started'); await firstDone; order.push('one finished'); return good; }),
    });
    for (let i = 0; i < 5; i += 1) await tick();
    const second = dispatchV2Action({
      ...dispatchArgs(root, runDirFor(root, 'r2', caller), 'two'),
      onQueued: (event) => queued.push(event),
      dependencies: deps(async () => { order.push('two started'); return good; }),
    });
    for (let i = 0; i < 10; i += 1) await tick();
    assert.deepEqual(order, ['one started'], 'the second step has not started');
    assert.equal(queued[0]?.kind, 'caller');
    assert.equal(queued[0]?.group, 'lead-a');
    finishFirst();
    const [r1, r2] = await Promise.all([first, second]);
    assert.equal(r1.ok, true);
    assert.equal(r2.ok, true);
    assert.deepEqual(order, ['one started', 'one finished', 'two started']);
    assert.equal(queued.at(-1)?.kind, 'admitted');
    assert.equal(listSlots(root).length, 0, 'both slots released');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('dispatch: another caller is not held back by a full caller, and no caps file changes nothing', async () => {
  const root = realpathSync(home('bs-caps-other-'));
  try {
    writeCaps(root, caps({ 'lead-a': { max: 1, cwdPrefixes: ['/work/a'] } }));
    let release;
    const held = new Promise((resolve) => { release = resolve; });
    const first = dispatchV2Action({
      ...dispatchArgs(root, runDirFor(root, 'r1', { cwd: '/work/a' }), 'one'),
      dependencies: deps(async () => { await held; return good; }),
    });
    await tick();
    const other = await dispatchV2Action({
      ...dispatchArgs(root, runDirFor(root, 'r2', { cwd: '/work/b' }), 'two'),
      dependencies: deps(async () => good),
    });
    assert.equal(other.ok, true, 'lead-b ran while lead-a was at its cap');
    release();
    await first;
    rmSync(join(root, 'caps.json'));
    const plain = await dispatchV2Action({ ...dispatchArgs(root, runDirFor(root, 'r3', { cwd: '/work/a' }), 'three'), dependencies: deps(async () => good) });
    assert.equal(plain.ok, true);
    assert.equal(existsSync(slotsDir(root)) ? readdirSync(slotsDir(root)).filter((f) => f.endsWith('.json')).length : 0, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('dispatch: a pool at its cap sits out the pick; with no other pool the step waits until it frees (C6)', async () => {
  const root = realpathSync(home('bs-caps-pool-'));
  try {
    writeCaps(root, caps({}, { 'luna-1': 1 }));
    // Another process's attempt already running on luna-1.
    const busy = registerAssignment(root, { pool: 'luna-1', lane: 'analyze', effort: 'low', source: 'run' });
    const moved = await dispatchV2Action({
      ...dispatchArgs(root, null, 'moves', { pools: [connector('luna-1'), connector('luna-2')] }),
      dependencies: deps(async () => good),
    });
    assert.equal(moved.ok, true);
    assert.equal(moved.attempts[0].pool, 'luna-2', 'the full pool sat out');
    assert.match(moved.attempts[0].routeWhy, /at pool cap, sat out: luna-1 1\/1/);

    const queued = [];
    let polls = 0;
    const waited = await dispatchV2Action({
      ...dispatchArgs(root, null, 'waits'),
      onQueued: (event) => queued.push(event),
      dependencies: {
        ...deps(async () => good),
        // The busy attempt ends while this step waits.
        sleep: async () => { polls += 1; if (polls === 2) releaseAssignment(root, busy.id); await tick(); },
      },
    });
    assert.equal(waited.ok, true);
    assert.equal(waited.attempts[0].pool, 'luna-1');
    assert.ok(polls >= 2, 'it waited instead of failing');
    assert.deepEqual(queued[0], { kind: 'pool', pools: [{ pool: 'luna-1', running: 1, max: 1 }] });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// bs-provider-kill-1124: a rate-limited attempt backs off, and by the time
// its same-pool retry picks, other runs fill the pool's cap. The retry must
// wait for a slot on that pool, as any step does (C6), not lose its backoff
// and fail with "no pool can take it now" (slice 3ntn9i, 2026-11-24 10:44Z).
test('dispatch: a rate-limit backoff whose pool is at its cap waits for a slot, then retries on that pool', async () => {
  const root = realpathSync(home('bs-caps-throttle-'));
  try {
    writeCaps(root, caps({}, { 'luna-1': 1 }));
    const throttled = {
      ok: false, failureKind: 'throttle', throttleWaitMs: null, throttleRetrySamePool: true,
      usageLimit: { rule: 'transient', limit: 'throttle', line: 'Too Many Requests: rate limiting: inference request per min rate reached', until: null },
      why: 'rate limited (transient): "…inference request per min rate reached" · meter not read',
      meta: { exitCode: 1, wallSec: 1 },
    };
    const verdicts = [throttled, good];
    let busy = null;
    let sleeps = 0;
    const queued = [];
    const result = await dispatchV2Action({
      ...dispatchArgs(root, null, 'look-throttled', { maxMechanicalRetries: 1 }),
      onQueued: (event) => queued.push(event),
      dependencies: {
        ...deps(async () => verdicts.shift()),
        random: () => 0,
        sleep: async () => {
          sleeps += 1;
          // The backoff: another run takes luna-1's only slot meanwhile.
          if (sleeps === 1) busy = registerAssignment(root, { pool: 'luna-1', lane: 'analyze', effort: 'low', source: 'run' });
          // The second cap poll: that run ends.
          if (sleeps === 3) releaseAssignment(root, busy.id);
          await tick();
        },
      },
    });
    assert.equal(result.ok, true, result.verdict?.why ?? result.why);
    assert.deepEqual(result.attempts.map((attempt) => attempt.pool), ['luna-1', 'luna-1']);
    assert.deepEqual(result.attempts.map((attempt) => attempt.failureKind ?? null), ['throttle', null]);
    assert.equal(result.attempts[1].retryOf?.how, 'wait', 'the retry is the backoff, not a counted retry');
    assert.ok(queued.some((event) => event.kind === 'pool'), 'it waited at the pool cap');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('dispatch: a step cancelled while queued returns cancelled and never starts a worker', async () => {
  const root = realpathSync(home('bs-caps-cancel-'));
  try {
    writeCaps(root, caps({ lead: { max: 0 } }));
    let started = false;
    let polls = 0;
    const result = await dispatchV2Action({
      ...dispatchArgs(root, runDirFor(root, 'r1', { name: 'lead', cwd: '/w' }), 'held'),
      shouldCancel: () => polls >= 3,
      dependencies: { ...deps(async () => { started = true; return good; }), sleep: async () => { polls += 1; await tick(); } },
    });
    assert.equal(result.status, 'cancelled');
    assert.equal(started, false);
    assert.equal(listSlots(root).length, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// --- CLI -------------------------------------------------------------------------

function cli(dir, args, env = {}) {
  const out = spawnSync(process.execPath, [BIN, ...args], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: dir, BULLSWARM_HOME: dir, NO_COLOR: '1', ...env },
  });
  return { code: out.status, stdout: out.stdout, stderr: out.stderr };
}

// In-process: one CLI start costs about 2.5 s in a fresh home, so only the
// wiring checks below spawn the real binary.
async function caps_(dir, args) {
  const out = []; const err = [];
  const log = console.log; const error = console.error;
  console.log = (...a) => out.push(a.join(' '));
  console.error = (...a) => err.push(a.join(' '));
  try { return { code: await cmdCaps(args, { bullswarmDir: dir }), stdout: out.join('\n'), stderr: err.join('\n') }; }
  finally { console.log = log; console.error = error; }
}

test('bullswarm caps sets, shows and clears caps; bad input exits 2', async () => {
  const dir = home('bs-caps-cli-');
  try {
    assert.match((await caps_(dir, [])).stdout, /no caps set/);
    assert.equal((await caps_(dir, ['set', 'lead-a', '2', '--cwd', dir, '--pane', 'w6:p1'])).code, 0);
    assert.equal((await caps_(dir, ['set-pool', 'claude-code:w', '8'])).code, 0);
    assert.equal((await caps_(dir, ['set-default', '3'])).code, 0);
    const view = JSON.parse((await caps_(dir, ['show', '--json'])).stdout);
    assert.deepEqual(view.callers, [{ group: 'lead-a', max: 2, cwdPrefixes: [realpathSync(dir)], panes: ['w6:p1'], running: 0, waiting: 0 }]);
    assert.deepEqual(view.pools, [{ pool: 'claude-code:w', max: 8, running: 0 }]);
    assert.equal(view.default, 3);
    assert.equal((await caps_(dir, ['set', 'lead-a', '1'])).code, 0);
    assert.deepEqual(readCaps(dir).callers['lead-a'], { max: 1, cwdPrefixes: [realpathSync(dir)], panes: ['w6:p1'] }, 'no matchers given keeps them');
    assert.equal((await caps_(dir, ['set', 'bad name', '2'])).code, 2);
    assert.equal((await caps_(dir, ['set', 'x', '-1'])).code, 2);
    assert.equal((await caps_(dir, ['set', 'x', '2', '--cwd', 'relative'])).code, 2);
    assert.equal((await caps_(dir, ['set-default', 'off'])).code, 0);
    assert.equal(readCaps(dir).default, null);
    assert.equal((await caps_(dir, ['clear', '--pool', 'claude-code:w'])).code, 0);
    assert.equal((await caps_(dir, ['clear', 'lead-a'])).code, 0);
    assert.equal((await caps_(dir, ['clear', 'lead-a'])).code, 1);
    assert.deepEqual(readCaps(dir).callers, {});
    // The real binary routes `caps` and rejects an unknown flag.
    const bogus = cli(dir, ['caps', '--bogus']);
    assert.equal(bogus.code, 2);
    assert.match(bogus.stderr, /unknown flag --bogus/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('run --no-wait refuses while the caller is at its cap; --caller names the caller and is validated', async () => {
  const dir = home('bs-caps-nowait-');
  try {
    writeCaps(dir, caps({ 'lead-a': { max: 1 } }));
    const held = await acquireCallerSlot({ bullswarmDir: dir, caller: { name: 'lead-a', cwd: '/w' } });
    assert.match(noWaitRefusal(dir, { name: 'lead-a', cwd: '/w' }), /caller lead-a already has 1 step running or queued and its cap is 1/);
    assert.equal(noWaitRefusal(dir, { name: 'lead-b', cwd: '/w' }), null);
    const refused = cli(dir, ['run', '--lane', 'analyze', '--add-dir', dir, '--prompt', 'x', '--caller', 'lead-a', '--no-wait', '--json']);
    assert.equal(refused.code, 1);
    assert.equal(JSON.parse(refused.stdout).failureKind, 'capped');
    const bad = cli(dir, ['run', '--lane', 'analyze', '--add-dir', dir, '--prompt', 'x', '--caller', 'bad name']);
    assert.equal(bad.code, 2);
    assert.match(bad.stderr, /--caller takes a name/);
    const goal = cli(dir, ['workflow', 'goal', 'x', '--cwd', dir, '--program', join(dir, 'none.json'), '--caller', 'lead-a', '--no-wait']);
    assert.equal(goal.code, 1);
    assert.match(goal.stderr, /not started \(--no-wait\)/);
    held.release();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('herdr pane ids may end in letters (w6:p5Z, w12:pA): recorded, settable and matched', async () => {
  // The Pacer plan of 20 Nov names panes w6:p5Z, w12:pA and w6:p5X.
  assert.equal(callerIdentity({ env: { HERDR_PANE_ID: 'w12:pA' }, cwd: '/w' }).herdrPane, 'w12:pA');
  assert.equal(callerIdentity({ env: { HERDR_PANE_ID: 'w6:p5Z' }, cwd: '/w' }).herdrPane, 'w6:p5Z');
  assert.equal(callerIdentity({ env: { HERDR_PANE_ID: 'w6:p5Z; rm' }, cwd: '/w' }).herdrPane, null, 'still validated');
  const c = caps({ kipwise: { max: 2, panes: ['w12:pA'] } });
  assert.deepEqual(c.callers.kipwise.panes, ['w12:pA'], 'kept by normalizeCaps');
  assert.equal(callerCap(c, { herdrPane: 'w12:pA', cwd: '/w' }).group, 'kipwise');
  const dir = home('bs-caps-pane-');
  try {
    assert.equal((await caps_(dir, ['set', 'wr', '3', '--pane', 'w6:p5Z'])).code, 0);
    assert.deepEqual(readCaps(dir).callers.wr.panes, ['w6:p5Z']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a step that arrives in the same instant never overtakes one already admitted (CI race, 20 Nov)', async () => {
  const dir = home();
  try {
    writeCaps(dir, caps({ lead: { max: 1 } }));
    const caller = { name: 'lead', cwd: '/w' };
    // Every slot gets the same arrival time; ids then decide the waiting order.
    const arrival = () => 42;
    for (let i = 0; i < 20; i += 1) {
      const held = await acquireCallerSlot({ bullswarmDir: dir, caller, arrival, sleep: tick, pollMs: 1 });
      let cancel = false;
      const second = acquireCallerSlot({ bullswarmDir: dir, caller, arrival, sleep: tick, pollMs: 1, shouldCancel: () => cancel });
      await tick(); await tick();
      cancel = true;
      assert.equal((await second).cancelled, true, `round ${i}: the newcomer waited behind the admitted step`);
      held.release();
    }
    assert.equal(listSlots(dir).length, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
