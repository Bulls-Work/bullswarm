// `strategy set-lanes`: which lanes a pool serves is the operator's setting
// (state.strategy.laneOverrides[pool]) when there is one, else the lanes its
// connector ships. Routing, `bullswarm pools`, strategy inventory, the
// workflow pin checks and a pinned dispatch all read the same answer.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { autoSetup, discoverConnectors, suggestRoutingTable } from '../src/setup.js';
import { buildPools } from '../src/lib/config.js';
import { loadState, updateState } from '../src/lib/state.js';
import { pickPool } from '../src/lib/route.js';
import { cmdStrategy, strategyInventory } from '../src/strategy-cli.js';
import * as cli from '../src/cli.js';
import { dispatchV2Action } from '../src/workflow/v2-dispatch.js';
import { pinnedPoolIssues, routePoolIssues } from '../src/workflow/cli-pool-checks.js';

function home() {
  const dir = mkdtempSync(join(tmpdir(), 'bullswarm-pool-lanes-'));
  autoSetup(dir, { reason: 'test' });
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

async function runStrategy(args, dir) {
  const out = [];
  const err = [];
  const log = console.log;
  const error = console.error;
  console.log = (...parts) => out.push(parts.join(' '));
  console.error = (...parts) => err.push(parts.join(' '));
  try {
    const code = await cmdStrategy(args, { bullswarmDir: dir });
    return { code, out: out.join('\n'), err: err.join('\n') };
  } finally {
    console.log = log;
    console.error = error;
  }
}

// A throwaway home and target for a dispatch test. Nothing is written there:
// loadState and saveState are injected, and dispatch stops before any pool runs.
function dispatchHome() {
  const dir = mkdtempSync(join(tmpdir(), 'bullswarm-pool-lanes-dispatch-'));
  const target = join(dir, 'target');
  mkdirSync(target);
  return {
    dispatchPaths: {
      targetDir: target,
      paths: { taskFile: join(dir, 'task.md'), outFile: join(dir, 'out.md') },
      bullswarmDir: join(dir, 'home'),
    },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

const poolsOf = (dir) => buildPools(dir, Date.now(), {}, { packaged: true }).pools;

test('strategy set-lanes writes the override, every pool view reads it back, and default clears it', async () => {
  const f = home();
  try {
    const set = await runStrategy(['set-lanes', 'grok', 'analyze', '--yes'], f.dir);
    assert.equal(set.code, 0, set.err);
    const doc = JSON.parse(set.out);
    assert.equal(doc.action, 'lanes-updated');
    assert.equal(doc.pool, 'grok');
    assert.deepEqual(doc.lanes, ['analyze']);
    assert.equal(doc.source, 'override');
    assert.deepEqual(loadState(f.dir).strategy.laneOverrides, { grok: ['analyze'] });

    const grok = poolsOf(f.dir).find((pool) => pool.name === 'grok');
    assert.deepEqual(grok.lanes, ['analyze']);
    assert.equal(grok.lanesSource, 'override');
    const codex = poolsOf(f.dir).find((pool) => pool.name === 'codex');
    assert.deepEqual(codex.lanes, ['analyze', 'build', 'chore']);
    assert.equal(codex.lanesSource, 'connector');

    // The pools view marks the override; a connector's lanes stay plain.
    assert.equal(cli.poolLanesText(grok), 'analyze (set-lanes)');
    assert.equal(cli.poolLanesText(codex), 'analyze/build/chore');

    // strategy inventory reports the same lanes and where they came from.
    const report = { capturedAt: new Date().toISOString(), discoveries: {}, suggestions: {} };
    const inventory = strategyInventory({ pools: [grok], state: loadState(f.dir), report });
    const row = inventory.providers.find((entry) => entry.name === 'grok');
    assert.deepEqual(row.lanes, ['analyze']);
    assert.equal(row.lanesSource, 'override');

    // Several lanes, in any order, are stored in lane order without repeats.
    assert.equal((await runStrategy(['set-lanes', 'grok', 'chore,analyze,chore', '--yes'], f.dir)).code, 0);
    assert.deepEqual(loadState(f.dir).strategy.laneOverrides.grok, ['analyze', 'chore']);

    const cleared = await runStrategy(['set-lanes', 'grok', 'default', '--yes'], f.dir);
    assert.equal(cleared.code, 0, cleared.err);
    assert.equal(JSON.parse(cleared.out).source, 'connector');
    assert.equal(loadState(f.dir).strategy.laneOverrides, undefined);
    const back = poolsOf(f.dir).find((pool) => pool.name === 'grok');
    assert.deepEqual(back.lanes, ['analyze', 'build', 'chore']);
    assert.equal(back.lanesSource, 'connector');
  } finally { f.cleanup(); }
});

test('strategy set-lanes refuses bad input with exit 2 and writes nothing', async () => {
  const f = home();
  try {
    const before = JSON.stringify(loadState(f.dir).strategy ?? null);
    for (const argv of [
      ['set-lanes', 'grok', 'analyze'],
      ['set-lanes', 'grok', '--yes'],
      ['set-lanes', '--yes'],
      ['set-lanes', 'no-such-pool', 'analyze', '--yes'],
      ['set-lanes', 'grok', 'review', '--yes'],
      ['set-lanes', 'grok', 'analyze,review', '--yes'],
      ['set-lanes', 'grok', ',', '--yes'],
      ['set-lanes', 'grok', 'default,analyze', '--yes'],
      ['set-lanes', 'grok', 'analyze', '--tier', 'low', '--yes'],
    ]) {
      const result = await runStrategy(argv, f.dir);
      assert.equal(result.code, 2, `${argv.join(' ')}: ${result.out}`);
      assert.match(result.err, /^✗ /, argv.join(' '));
    }
    assert.match((await runStrategy(['set-lanes', 'no-such-pool', 'analyze', '--yes'], f.dir)).err, /unknown pool "no-such-pool"/);
    assert.match((await runStrategy(['set-lanes', 'grok', 'review', '--yes'], f.dir)).err, /unknown lane "review"/);
    assert.equal(JSON.stringify(loadState(f.dir).strategy ?? null), before);
  } finally { f.cleanup(); }
});

test('routing leaves a pool out of a lane its override does not serve', async () => {
  const f = home();
  try {
    assert.equal((await runStrategy(['set-lanes', 'grok', 'analyze', '--yes'], f.dir)).code, 0);
    const grok = poolsOf(f.dir).find((pool) => pool.name === 'grok');
    const routed = [{ name: 'grok', costRank: 1, lanes: grok.lanes, lanesSource: grok.lanesSource }];
    assert.equal(pickPool('build', routed).pick, null);
    assert.equal(pickPool('chore', routed).pick, null);
    assert.equal(pickPool('analyze', routed).pick?.pool, 'grok');
  } finally { f.cleanup(); }
});

const fakePool = (name, extra = {}) => ({
  name, lanes: ['analyze', 'build', 'chore'], lanesSource: 'connector', enabled: true, spawn: { cmd: ['fake'] },
  modelSelection: { flag: '--model' }, strategyAssignments: { low: { pool: name, model: 'gpt-5.6-luna' } }, ...extra,
});

test('a dispatch pinned to a pool for a lane its override does not serve is refused with the override and its fix', async () => {
  const f = dispatchHome();
  try {
    const NOW = Date.parse('2026-11-15T10:00:00Z');
    const core = { config: { depthLimit: 2 }, pools: {}, incumbents: {}, decisionLog: [] };
    const dependencies = {
      watchOnce: async () => { throw new Error('nothing may be dispatched'); },
      loadState: () => structuredClone(core),
      saveState: () => {},
      now: () => NOW,
    };
    const pinned = await dispatchV2Action({
      action: { id: 'do-work', lane: 'build', effort: 'low' }, taskText: 'do it', ...f.dispatchPaths,
      dependencies,
      pools: [fakePool('grok', { lanes: ['analyze'], lanesSource: 'override' }), fakePool('codex')],
      strictPool: 'grok',
    });
    assert.equal(pinned.ok, false);
    assert.equal(pinned.verdict.why,
      'no eligible pool: the pinned pool grok does not serve build work: strategy set-lanes limits it to analyze '
      + '(bullswarm strategy set-lanes grok default --yes clears it)');
    assert.doesNotMatch(pinned.verdict.why, /\n/);
  } finally { f.cleanup(); }
});

test('workflow pin checks refuse a step on a lane the pinned pool\'s override does not serve', () => {
  const doc = { config: { workerRouting: { strictPool: 'grok' } } };
  const program = { actions: [{ id: 'write', lane: 'build', effort: 'low' }, { id: 'read', lane: 'analyze', effort: 'low' }] };
  const pools = [fakePool('grok', { lanes: ['analyze'], lanesSource: 'override' }), fakePool('codex')];
  const issues = pinnedPoolIssues(doc, program, pools);
  assert.equal(issues.length, 1, issues.join('\n'));
  assert.match(issues[0], /^program\.actions\[0\] \(write\) is build\/low work, which the pinned pool grok does not serve: strategy set-lanes limits it to analyze/);
  assert.match(issues[0], /bullswarm strategy set-lanes grok default --yes clears it/);
});

test('a dispatch whose route names only a provider whose pool does not serve the lane says so (run --use-provider)', async () => {
  const f = dispatchHome();
  try {
    const NOW = Date.parse('2026-11-15T10:00:00Z');
    const core = { config: { depthLimit: 2 }, pools: {}, incumbents: {}, decisionLog: [] };
    const dependencies = {
      watchOnce: async () => { throw new Error('nothing may be dispatched'); },
      loadState: () => structuredClone(core),
      saveState: () => {},
      now: () => NOW,
    };
    const routed = await dispatchV2Action({
      action: { id: 'do-work', lane: 'build', effort: 'low' }, taskText: 'do it', ...f.dispatchPaths,
      dependencies,
      pools: [fakePool('grok', { lanes: ['analyze'], lanesSource: 'override' }), fakePool('codex')],
      routeFilter: {
        usePools: null, avoidPools: [], useProviders: ['grok'], avoidProviders: [],
        independentProviders: [], independentOf: {}, summary: 'providers.use grok',
      },
    });
    assert.equal(routed.ok, false);
    assert.match(routed.verdict.why, /\(providers\.use grok\): grok does not serve build work: strategy set-lanes limits it to analyze \(bullswarm strategy set-lanes grok default --yes clears it\)$/);
    assert.doesNotMatch(routed.verdict.why, /\n/);
  } finally { f.cleanup(); }
});

test('setup discovery and its suggested routing table read the override', () => {
  const f = home();
  try {
    updateState(f.dir, (state) => {
      state.strategy ??= {};
      state.strategy.laneOverrides = { grok: ['analyze'], 'claude-code': ['chore'] };
    });
    const found = discoverConnectors(f.dir);
    const grok = found.find((entry) => entry.pools.includes('grok'));
    assert.deepEqual(grok.lanes, ['analyze']);
    assert.equal(grok.lanesSource, 'override');
    const claude = found.find((entry) => entry.pools.includes('claude-code'));
    assert.deepEqual(claude.lanes, ['chore']);
    const codex = found.find((entry) => entry.pools.includes('codex'));
    assert.deepEqual(codex.lanes, ['analyze', 'build', 'chore']);
    assert.equal(codex.lanesSource, 'connector');

    const table = suggestRoutingTable([grok, claude, codex]);
    assert.deepEqual(table.analyze.order, ['grok', 'codex']);
    assert.deepEqual(table.build.order, ['codex']);
    assert.deepEqual(table.chore.order, ['claude-code', 'codex']);
  } finally { f.cleanup(); }
});

test('workflow plan validate names the override when a step\'s route leaves only an off-lane pool', () => {
  const actions = [{ id: 'write-it', lane: 'build', effort: 'medium', route: { pools: { use: ['grok'] } } }];
  const pools = [fakePool('grok', { lanes: ['analyze'], lanesSource: 'override' }), fakePool('codex')];
  const issues = routePoolIssues(actions, pools, { config: {} }, {});
  assert.equal(issues.length, 1, issues.join('\n'));
  assert.match(issues[0], /^step write-it: no enabled pool can run it under its route \(build\/medium work; route: use grok\)/);
  assert.match(issues[0], /grok does not serve build work: strategy set-lanes limits it to analyze \(bullswarm strategy set-lanes grok default --yes clears it\)$/);
});

test('bullswarm pools prints the overridden lanes marked (set-lanes)', async () => {
  // Packaged providers stay off and the two pools are unmetered copies of the
  // echo connector in the temp home, so the spawned `pools` reads no live
  // meter and finds none of this machine's logins.
  const f = home();
  try {
    const ROOT = join(resolve(dirname(fileURLToPath(import.meta.url)), '..'));
    // Spawned under node:test, the CLI skips local provider directories but
    // reads legacy connector files, so the two pools are written as those.
    const connector = JSON.parse(readFileSync(join(ROOT, 'src', 'providers', 'echo', 'connector.json'), 'utf8'));
    delete connector.testFixture;
    mkdirSync(join(f.dir, 'connectors'), { recursive: true });
    for (const name of ['lanesa', 'lanesb']) {
      writeFileSync(join(f.dir, 'connectors', `${name}.json`), JSON.stringify({ ...connector, name }, null, 2));
    }
    const env = { ...process.env, BULLSWARM_HOME: f.dir, BULLSWARM_NO_PACKAGED_PROVIDERS: '1', BULLSWARM_DISABLE_CLAUDE_PROFILES: '1', BULLSWARM_METER_SNAPSHOT_DIR: '' };
    const BIN = join(ROOT, 'bin', 'bullswarm.js');
    const cli = (argv) => spawnSync(process.execPath, [BIN, ...argv], { env, encoding: 'utf8', input: '' });
    const setup = cli(['setup', '--yes']);
    assert.equal(setup.status, 0, setup.stderr + setup.stdout);
    const set = cli(['strategy', 'set-lanes', 'lanesa', 'analyze', '--yes']);
    assert.equal(set.status, 0, set.stderr + set.stdout);
    const run = cli(['pools']);
    assert.equal(run.status, 0, run.stderr);
    const line = (name) => run.stdout.split('\n').find((row) => row.split(/\s+/)[0] === name);
    assert.match(line('lanesa') ?? '', / lanes=analyze \(set-lanes\) /, run.stdout);
    assert.match(line('lanesb') ?? '', / lanes=analyze\/build\/chore /, run.stdout);
    for (const real of ['grok', 'claude-code', 'codex', 'command-code']) assert.equal(line(real), undefined, `${real} is a real pool; no live meter may be read\n${run.stdout}`);
  } finally { f.cleanup(); }
});
