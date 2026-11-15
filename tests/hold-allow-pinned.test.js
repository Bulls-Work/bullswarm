// `strategy hold <pool> --allow-pinned`: the pool is out of every pick routing
// makes on its own, but a caller who pins it on purpose may still use it
// (pool-limits.js holdPins / poolIsPinned, route.js R14). What counts as a
// pin: the run or step pin (strictPool, --worker-pool), or a route whose
// pools.use names the pool or whose providers.use names its provider
// (`bullswarm run --use-provider command-code`). An avoid list never pins.
//
// Nothing here reads a live meter or starts a worker: the router tests use
// hand-built pools, the dispatch tests inject watchOnce and the state, and
// the spawned CLI runs in a temp home with packaged providers and Claude
// profiles off, on unmetered copies of the echo connector.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { pickPool } from '../src/lib/route.js';
import { activeHold } from '../src/lib/pool-limits.js';
import { resolveRouteFilter } from '../src/workflow/step-route.js';
import { previewStepPick } from '../src/workflow/pick-preview.js';
import { dispatchV2Action } from '../src/workflow/v2-dispatch.js';
import { pinnedPoolIssues, routePoolIssues } from '../src/workflow/cli-pool-checks.js';
import { poolStatusText } from '../src/cli.js';

const NOW = Date.parse('2026-11-16T10:00:00Z');
const UNTIL = '2026-11-17T10:00:00.000Z';
const HELD = 'command-code';

const hold = (extra = {}) => ({ reason: 'fleet review', until: UNTIL, setAt: '2026-11-16T09:00:00.000Z', ...extra });

const connector = (name, extra = {}) => ({
  name, lanes: ['analyze', 'build', 'chore'], enabled: true, spawn: { cmd: ['fake'] },
  modelSelection: { flag: '--model' },
  strategyAssignments: Object.fromEntries(['low', 'medium', 'high'].map((tier) => [tier, { pool: name, model: 'acme-model' }])),
  ...extra,
});

// command-code is ahead on pace, so routing would take it were it not held.
const pools = (holdRecord) => [
  connector(HELD, { pace: 60, hold: holdRecord }),
  connector('acme', { pace: 10 }),
];
const routeOf = (route) => resolveRouteFilter({ attempts: [] }, { id: 'task', route }, pools(null));

test('activeHold reports allowPinned, false for a plain hold', () => {
  assert.equal(activeHold({ name: HELD, hold: hold({ allowPinned: true }) }, NOW).allowPinned, true);
  assert.equal(activeHold({ name: HELD, hold: hold() }, NOW).allowPinned, false);
});

test('an allow-pinned hold keeps the pool out of an unpinned pick, and the reason says pinned runs are allowed', () => {
  const route = pickPool('build', pools(hold({ allowPinned: true })), { now: NOW });
  assert.equal(route.pick.pool, 'acme');
  assert.match(route.why, /kept out: command-code held until 2026-11-17T10:00:00\.000Z \(fleet review\) · pinned runs allowed/);
  // A plain hold reads as today.
  const plain = pickPool('build', pools(hold()), { now: NOW });
  assert.equal(plain.pick.pool, 'acme');
  assert.match(plain.why, /kept out: command-code held until 2026-11-17T10:00:00\.000Z \(fleet review\)/);
  assert.doesNotMatch(plain.why, /pinned runs allowed/);
});

test('a strictPool pin may use an allow-pinned held pool; a plain hold still blocks it', () => {
  const allowed = pickPool('build', pools(hold({ allowPinned: true })).filter((p) => p.name === HELD), { now: NOW, strictPool: HELD });
  assert.equal(allowed.pick?.pool, HELD, allowed.why);
  const blocked = pickPool('build', pools(hold()).filter((p) => p.name === HELD), { now: NOW, strictPool: HELD });
  assert.equal(blocked.pick, null);
  assert.match(blocked.why, /kept out: command-code held until/);
});

test('a route naming the pool or its provider is a pin; an avoid list is not', () => {
  const allow = pools(hold({ allowPinned: true }));
  for (const route of [{ pools: { use: [HELD] } }, { pools: { use: [HELD, 'acme'] } }, { providers: { use: [HELD] } }]) {
    const routeFilter = routeOf(route);
    const picked = pickPool('build', allow, { now: NOW, routeFilter });
    assert.equal(picked.pick?.pool, HELD, `${JSON.stringify(route)}: ${picked.why}`);
  }
  // Avoiding the other pool leaves command-code the only one, but that is
  // not a choice of command-code: it stays out.
  for (const route of [{ pools: { avoid: ['acme'] } }, { providers: { avoid: ['acme'] } }]) {
    const routeFilter = routeOf(route);
    const left = allow.filter((p) => p.name === HELD);
    const picked = pickPool('build', left, { now: NOW, routeFilter });
    assert.equal(picked.pick, null, `${JSON.stringify(route)}: ${picked.why}`);
    assert.match(picked.why, /pinned runs allowed/);
  }
  // A plain hold blocks a route that names it.
  const plain = pickPool('build', pools(hold()), { now: NOW, routeFilter: routeOf({ pools: { use: [HELD] } }) });
  assert.notEqual(plain.pick?.pool, HELD);
});

test('pick preview (run --dry-run): --use-provider picks the held pool, --avoid-pool does not', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'bs-hold-pinned-preview-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const preview = (list, route) => previewStepPick({
    action: { id: 'task', lane: 'build', effort: 'low', ...(route ? { route } : {}) },
    pools: list, bullswarmDir: home, coreState: { decisionLog: [] }, targetDir: home, now: NOW,
  });
  const allow = pools(hold({ allowPinned: true }));
  assert.equal((await preview(allow, { providers: { use: [HELD] } })).pick?.pool, HELD);
  assert.equal((await preview(allow)).pick?.pool, 'acme');
  const avoided = await preview(allow, { pools: { avoid: ['acme'] } });
  assert.equal(avoided.ok, false);
  assert.match(avoided.why, /command-code held \(fleet review; pinned runs allowed\) until 2026-11-17T10:00:00\.000Z/);
  const plain = await preview(pools(hold()), { providers: { use: [HELD] } });
  assert.equal(plain.ok, false);
  assert.doesNotMatch(plain.why, /pinned runs allowed/);
});

// dispatchV2Action with the worker seam (watchOnce) and the state injected:
// no process starts and nothing is written to a real home.
async function dispatch(t, list, options = {}) {
  const home = mkdtempSync(join(tmpdir(), 'bs-hold-pinned-dispatch-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const core = { config: { depthLimit: 2 }, pools: {}, incumbents: {}, decisionLog: [] };
  const ran = [];
  const result = await dispatchV2Action({
    action: { id: 'task', lane: 'build', effort: 'low' },
    taskText: 'do it', targetDir: home,
    paths: { taskFile: join(home, 'task.md'), outFile: join(home, 'out.md') },
    pools: list, bullswarmDir: home, maxMechanicalRetries: 0,
    ...options,
    dependencies: {
      watchOnce: async (pool, task, targetDir, files) => {
        ran.push(pool.name);
        writeFileSync(files.taskFile, task);
        writeFileSync(join(targetDir, 'made.txt'), `made by ${pool.name}\n`);
        writeFileSync(files.outFile, '## Completed\n\nMade the change and verified it: all checks passed.');
        return { ok: true, why: 'ok', meta: { exitCode: 0, wallSec: 1 } };
      },
      loadState: () => structuredClone(core),
      saveState: (_dir, next) => Object.assign(core, structuredClone(next)),
      now: () => NOW,
      uuid: () => 'session-fixed',
    },
  });
  return { result, ran };
}

test('dispatch: --worker-pool on an allow-pinned held pool runs there; a plain hold does not', async (t) => {
  const allowed = await dispatch(t, pools(hold({ allowPinned: true })), { strictPool: HELD });
  assert.deepEqual(allowed.ran, [HELD]);
  const unpinned = await dispatch(t, pools(hold({ allowPinned: true })));
  assert.deepEqual(unpinned.ran, ['acme']);
  const plain = await dispatch(t, pools(hold()), { strictPool: HELD });
  assert.deepEqual(plain.ran, []);
  assert.equal(plain.result.ok, false);
});

test('dispatch: a step route naming the provider runs on the held pool; an avoid route does not', async (t) => {
  const allow = pools(hold({ allowPinned: true }));
  const named = await dispatch(t, allow, { routeFilter: routeOf({ providers: { use: [HELD] } }) });
  assert.deepEqual(named.ran, [HELD]);
  const avoided = await dispatch(t, allow, { routeFilter: routeOf({ pools: { avoid: ['acme'] } }) });
  assert.deepEqual(avoided.ran, []);
  assert.match(avoided.result.verdict?.why ?? '', /pinned runs allowed/);
});

test('plan validate checks: a program pinned to the pool passes under an allow-pinned hold, fails under a plain one', () => {
  const program = { actions: [{ id: 'task', lane: 'build', effort: 'low' }] };
  const doc = { config: { workerRouting: { strictPool: HELD } } };
  assert.deepEqual(pinnedPoolIssues(doc, program, pools(hold({ allowPinned: true }))), []);
  const plain = pinnedPoolIssues(doc, program, pools(hold()));
  assert.equal(plain.length, 1, plain.join('\n'));
  assert.match(plain[0], /pinned pool command-code is held until 2026-11-17T10:00:00\.000Z \(fleet review\)/);
  assert.match(plain[0], /--allow-pinned/);

  const routed = [{ id: 'task', lane: 'build', effort: 'low', route: { providers: { use: [HELD] } } }];
  assert.deepEqual(routePoolIssues(routed, pools(hold({ allowPinned: true })), { config: {} }, {}), []);
  const routedPlain = routePoolIssues(routed, pools(hold()), { config: {} }, {});
  assert.equal(routedPlain.length, 1, routedPlain.join('\n'));
  assert.match(routedPlain[0], /^step task: .*command-code is held until 2026-11-17T10:00:00\.000Z \(fleet review\)/);
});

test('poolStatusText names an allow-pinned hold', () => {
  assert.equal(poolStatusText({ name: HELD, enabled: true, hold: hold({ allowPinned: true }) }, NOW),
    'held until 2026-11-17T10:00:00.000Z (fleet review) · pinned runs allowed');
  assert.equal(poolStatusText({ name: HELD, enabled: true, hold: hold() }, NOW),
    'held until 2026-11-17T10:00:00.000Z (fleet review)');
});

test('CLI: hold --allow-pinned stores the flag, pools shows it, a plain re-hold replaces it, unhold clears it, plan validate follows it', () => {
  const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const root = mkdtempSync(join(tmpdir(), 'bs-hold-pinned-cli-'));
  const home = join(root, 'home');
  try {
    // Unmetered legacy connectors, packaged providers and Claude profiles
    // off: the spawned CLI reads no live meter and finds no real login.
    const echo = JSON.parse(readFileSync(join(ROOT, 'src', 'providers', 'echo', 'connector.json'), 'utf8'));
    delete echo.flags.testFixture;
    mkdirSync(join(home, 'connectors'), { recursive: true });
    for (const name of ['heldpool', 'freepool']) {
      writeFileSync(join(home, 'connectors', `${name}.json`), JSON.stringify({ ...echo, name }, null, 2));
    }
    const env = {
      ...process.env, BULLSWARM_HOME: home, BULLSWARM_NO_PACKAGED_PROVIDERS: '1',
      BULLSWARM_DISABLE_CLAUDE_PROFILES: '1', BULLSWARM_METER_SNAPSHOT_DIR: '',
    };
    const cli = (...argv) => spawnSync(process.execPath, [join(ROOT, 'bin', 'bullswarm.js'), ...argv], { env, encoding: 'utf8', input: '' });
    const setup = cli('setup', '--yes');
    assert.equal(setup.status, 0, setup.stderr + setup.stdout);
    const stored = () => JSON.parse(readFileSync(join(home, 'state.json'), 'utf8')).pools?.heldpool?.hold ?? null;

    const held = cli('strategy', 'hold', 'heldpool', '--until', '2h', '--reason', 'fleet review', '--allow-pinned', '--yes');
    assert.equal(held.status, 0, held.stderr + held.stdout);
    assert.equal(JSON.parse(held.stdout).allowPinned, true);
    assert.equal(stored().allowPinned, true);
    assert.equal(stored().reason, 'fleet review');

    const listed = cli('pools');
    assert.equal(listed.status, 0, listed.stderr);
    assert.match(listed.stdout, /held until \S+ \(fleet review\) · pinned runs allowed/, listed.stdout);
    for (const real of ['grok', 'claude-code', 'codex', 'command-code']) {
      assert.doesNotMatch(listed.stdout, new RegExp(`^${real}\\s`, 'm'), 'a real pool showed up; no live meter may be read');
    }
    const json = JSON.parse(cli('pools', '--json', '--pool', 'heldpool').stdout).pools;
    assert.equal(json[0].hold.allowPinned, true);

    // plan validate: a program pinned to the held pool passes now.
    const program = join(root, 'program.json');
    writeFileSync(program, JSON.stringify({
      schemaVersion: 'bullswarm.workflow.program.v3',
      steps: [{ id: 'task', lane: 'chore', effort: 'low', prompt: 'Tidy the acme notes.' }],
    }));
    mkdirSync(join(root, 'repo'));
    const validate = () => cli('workflow', 'plan', 'validate', 'Tidy the acme notes', '--program', program,
      '--cwd', join(root, 'repo'), '--worker-pool', 'heldpool', '--json');
    const passes = validate();
    assert.equal(passes.status, 0, passes.stderr + passes.stdout);

    // A re-hold without the flag replaces the record: pins are blocked again.
    const plain = cli('strategy', 'hold', 'heldpool', '--until', '2h', '--reason', 'plain hold', '--yes');
    assert.equal(plain.status, 0, plain.stderr + plain.stdout);
    assert.equal(stored().allowPinned, false);
    assert.equal(stored().reason, 'plain hold');
    assert.doesNotMatch(cli('pools').stdout, /pinned runs allowed/);
    assert.equal(JSON.parse(cli('pools', '--json', '--pool', 'heldpool').stdout).pools[0].hold.allowPinned, false);
    const fails = validate();
    assert.notEqual(fails.status, 0, fails.stdout);
    assert.match(fails.stdout + fails.stderr, /heldpool is held until/);

    assert.equal(cli('strategy', 'unhold', 'heldpool', '--yes').status, 0);
    assert.equal(stored(), null);
    assert.equal(validate().status, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
