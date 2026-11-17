// AGY stage 2: one CLI login, two quota pools (spec addendum A-E).
//
//   agy         the Gemini group of `agy -p /usage`
//   agy:claude  the Claude and GPT group
//
// Both are ordinary standalone pools: metered by their own group, paced and
// picked like any other pool with no pin, turned on together by setup, read
// with ONE `/usage` call, held apart by a quota refusal and together by a
// sign-in failure, and picked by a model pin.
//
// Nothing here spawns agy, reads ~/.gemini, a live meter or the real
// ~/.bullswarm: the meter takes an injected call-counting runner (through the
// loaded provider's ctx), discovery an injected executor, setup an injected
// discovery list, and every dispatch injects watchOnce and refreshPools. The
// loader is given `accounts: []`, so no Claude login is scanned.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadProviders } from '../src/lib/providers.js';
import { buildPools } from '../src/lib/config.js';
import { loadState } from '../src/lib/state.js';
import { activeAuthHolds } from '../src/lib/auth-hold.js';
import { findQuotaFailure } from '../src/lib/quota.js';
import { pickPool } from '../src/lib/route.js';
import { argvWithModel } from '../src/lib/worker-argv.js';
import { buildStrategy, discoverConnectorModels } from '../src/lib/strategy.js';
import { paceSnapshot } from '../src/meters/framework.js';
import { getAllMeterReadings, getMeterReading, refreshMeterAfterQuota } from '../src/meters/registry.js';
import { previewStepPick } from '../src/workflow/pick-preview.js';
import { dispatchV2Action, prepareV2DispatchPools } from '../src/workflow/v2-dispatch.js';
import { resolveRouteFilter } from '../src/workflow/step-route.js';
import { runStepProgram, runStepRequest } from '../src/lib/run-step.js';
import * as setup from '../src/setup.js';
import { applyStrategyRecommendations } from '../src/strategy-cli.js';
import { poolStatusText } from '../src/cli.js';

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const FIRST_CLASS = join(REPO, 'src', 'providers');
const AGY_DIR = join(FIRST_CLASS, 'agy');
const FIXTURES = join(REPO, 'tests', 'fixtures', 'agy');
const MODELS_TXT = readFileSync(join(FIXTURES, 'models.txt'), 'utf8');
const USAGE = JSON.parse(readFileSync(join(FIXTURES, 'usage.json'), 'utf8'));

// Inside both fixture windows: the Gemini 5h window resets 22:26:32Z, the weeklies on the 24th.
const NOW = Date.parse('2026-11-17T20:00:00.000Z');
const GEMINI_5H_RESET = Date.parse('2026-11-17T22:26:32.000Z');

const agyModule = () => import(join(AGY_DIR, 'provider.mjs'));

function tempHome(t, prefix = 'bs-agy-pools-') {
  const home = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  for (const dir of ['providers', 'connectors', 'contrib', 'meters']) mkdirSync(join(home, dir), { recursive: true });
  writeFileSync(join(home, 'state.json'), JSON.stringify({ pools: {}, strategy: {}, decisionLog: [] }));
  return home;
}

function loaderFor(home) {
  return {
    homeDir: home,
    accounts: [],
    enabled: [],
    dirs: {
      firstClass: FIRST_CLASS,
      contrib: join(home, 'contrib'),
      local: join(home, 'providers'),
      legacy: join(home, 'connectors'),
    },
  };
}

/** A body like `agy -p /usage --output-format json`, each group's buckets edited. */
function usageBody({ gemini = {}, claude = {} } = {}) {
  const body = structuredClone(USAGE);
  for (const group of body.command.data.groups) {
    const edits = group.name === 'Gemini Models' ? gemini : claude;
    for (const bucket of group.buckets) {
      if (edits[bucket.window] != null) bucket.remaining_fraction = edits[bucket.window];
    }
  }
  return body;
}

/** A call-counting runner standing in for the agy spawn; `bodies` answer in turn (the last repeats). */
function countingRunner(bodies = [USAGE]) {
  const calls = [];
  const runner = async (request) => {
    calls.push(request);
    const body = bodies[Math.min(calls.length - 1, bodies.length - 1)];
    return { stdout: JSON.stringify(body), stderr: '', exitCode: 0 };
  };
  return { runner, calls };
}

/** The loaded providers with the agy meter's spawn replaced by `runner` (through its ctx, as readerFor passes it). */
function providersWithRunner(home, runner) {
  const { providers, connectors } = loadProviders(home, loaderFor(home));
  return {
    connectors,
    providers: providers.map((entry) => {
      if (entry.name !== 'agy') return entry;
      // The loader keeps module and ctx non-enumerable: copy every property.
      const copy = Object.defineProperties({}, Object.getOwnPropertyDescriptors(entry));
      Object.defineProperty(copy, 'ctx', { value: { ...entry.ctx, runner }, enumerable: false, writable: true });
      return copy;
    }),
  };
}

/** A reading as the meter registry hands it to the pool builder. */
const reading = (snapshot) => ({ snapshot, source: 'live', ...paceSnapshot(snapshot, NOW) });

/** A pool far ahead of its weekly pace (60% used early in the week). */
const busy = (pool) => reading({
  captured_at: new Date(NOW).toISOString(), pool,
  five_hour: { utilization: 10, resets_at: '2026-11-17T23:00:00.000Z' },
  seven_day: { utilization: 60, resets_at: '2026-11-24T12:00:00.000Z' },
  monthly: null,
});
const OTHERS = () => ({ 'claude-code': busy('claude-code'), codex: busy('codex'), grok: busy('grok') });

/** The agy readings through the real registry and provider reader, from one `/usage` body. */
async function agyReadings(home, body, { nowMs = NOW, runner = null } = {}) {
  const counting = runner ? { runner } : countingRunner([body]);
  const { providers } = providersWithRunner(home, counting.runner);
  return getAllMeterReadings(['agy', 'agy:claude'], {
    bullswarmDir: home, providers, nowMs, force: true,
  });
}

async function poolsFrom(home, readings) {
  const { pools } = buildPools(home, NOW, { ...OTHERS(), ...readings }, loaderFor(home));
  return pools.filter((p) => p.enabled);
}

function pairAt(argv, flag, value) {
  const index = argv.indexOf(flag);
  return index >= 0 && argv[index + 1] === value;
}

// The weekly buckets that put one agy pool most behind and the other ahead of its pace.
const GEMINI_BEHIND = { gemini: { weekly: 0.999 }, claude: { weekly: 0.4 } };
const CLAUDE_BEHIND = { gemini: { weekly: 0.4 }, claude: { weekly: 0.999 } };
const BOTH_BEHIND = { gemini: { weekly: 0.999 }, claude: { weekly: 0.999 } };

async function strategyReport(t) {
  const home = tempHome(t, 'bs-agy-strategy-');
  const { providers, connectors } = loadProviders(home, loaderFor(home));
  const provider = providers.find((p) => p.name === 'agy');
  const executor = async () => MODELS_TXT;
  const agy = connectors.agy;
  const claude = connectors['agy:claude'];
  const discoveries = {
    agy: await discoverConnectorModels(agy, { provider, providerExecutor: executor }),
    'agy:claude': await discoverConnectorModels(claude, { provider, providerExecutor: executor }),
  };
  const poolFor = (connector) => ({
    name: connector.name, connector, enabled: true, pace: 0, costRank: connector.costRank,
    lanes: connector.lanes, capabilities: connector.capabilities,
  });
  const report = buildStrategy({
    connectors: { agy, 'agy:claude': claude }, pools: [poolFor(agy), poolFor(claude)], state: {}, discoveries,
  });
  return { home, report, discoveries, agy, claude };
}

// --- A: two standalone pools, on by default, drained naturally ---------------------------

test('A: auto setup turns both agy pools on when agy is found, and both off when it is not', (t) => {
  assert.equal(typeof setup.providerPoolNames, 'function', 'setup names every pool a discovered provider contributes');
  const home = tempHome(t, 'bs-agy-setup-');
  const entry = (name, pools, discovered) => ({
    file: name, name, displayName: name, tier: 'first-class', enabled: true, pools, skipped: [], error: null,
    broken: false, shadowed: false, bin: name, health: 'default', installed: discovered, loggedIn: discovered,
    hint: null, discovered, meter: 'reader', costRank: 2, lanes: ['analyze', 'build', 'chore'], lanesSource: 'connector',
    testFixture: false,
  });
  assert.deepEqual(setup.providerPoolNames(entry('agy', ['agy', 'agy:claude'], true)), ['agy', 'agy:claude']);

  const found = setup.autoSetup(home, {
    reason: 'test', discover: () => [entry('agy', ['agy', 'agy:claude'], true), entry('codex', ['codex'], false)],
  });
  assert.deepEqual(found.enabledPools.sort(), ['agy', 'agy:claude']);
  let state = loadState(home);
  assert.equal(state.pools.agy.enabled, true);
  assert.equal(state.pools['agy:claude'].enabled, true);
  assert.equal(state.pools.codex.enabled, false);

  // Both pools route with no pin and no further step.
  const { pools } = buildPools(home, NOW, {}, loaderFor(home));
  assert.deepEqual(pools.filter((p) => p.name.startsWith('agy')).map((p) => [p.name, p.enabled]),
    [['agy', true], ['agy:claude', true]]);

  // A machine without agy: neither pool is left on.
  setup.autoSetup(home, { reason: 'test', discover: () => [entry('agy', ['agy', 'agy:claude'], false)] });
  state = loadState(home);
  assert.equal(state.pools.agy.enabled, false);
  assert.equal(state.pools['agy:claude'].enabled, false, 'agy:claude is not left routing to a CLI that is not there');
  assert.match(state.strategy.poolToggles['agy:claude'].latest.reason ?? '', /not detected on this machine/);
});

test('A: an unpinned analyze or build step goes to whichever agy pool is most behind its pace', async (t) => {
  for (const [buckets, expected] of [[CLAUDE_BEHIND, 'agy:claude'], [GEMINI_BEHIND, 'agy']]) {
    const home = tempHome(t);
    const pools = await poolsFrom(home, await agyReadings(home, usageBody(buckets)));
    const mine = Object.fromEntries(pools.filter((p) => p.name.startsWith('agy')).map((p) => [p.name, p]));
    assert.equal(mine.agy.meterSource, 'live');
    assert.equal(mine['agy:claude'].meterSource, 'live');
    for (const lane of ['analyze', 'build']) {
      const route = pickPool(lane, pools, { now: NOW });
      assert.equal(route.pick?.pool, expected, `${lane}: ${route.why}`);
    }
  }
});

test('A: a full 5-hour window on one agy pool leaves the other one picked', async (t) => {
  // Both are far behind their weekly pace, but agy:claude's 5h bucket is spent: agy takes the work.
  let home = tempHome(t);
  let pools = await poolsFrom(home, await agyReadings(home, usageBody({ ...BOTH_BEHIND, claude: { weekly: 0.999, '5h': 0 } })));
  let route = pickPool('build', pools, { now: NOW });
  assert.equal(route.pick?.pool, 'agy', route.why);
  assert.ok(!route.candidates.some((c) => c.pool === 'agy:claude'), route.why);

  // And the other way round.
  home = tempHome(t);
  pools = await poolsFrom(home, await agyReadings(home, usageBody({ ...BOTH_BEHIND, gemini: { weekly: 0.999, '5h': 0.005 } })));
  route = pickPool('build', pools, { now: NOW });
  assert.equal(route.pick?.pool, 'agy:claude', route.why);
  assert.ok(!route.candidates.some((c) => c.pool === 'agy'), route.why);
});

test('A: strategy suggests Gemini on agy and Opus / Sonnet / GPT-OSS on agy:claude, and apply writes those rungs', async (t) => {
  const { home, report, discoveries } = await strategyReport(t);
  const pick = (pool, tier) => report.providerSuggestions[pool][tier].recommended?.model ?? null;
  assert.deepEqual(['high', 'medium', 'low'].map((tier) => pick('agy', tier)),
    ['gemini-4-carbon', 'gemini-4-hydrogen', 'gemini-3.8-flash']);
  assert.deepEqual(['high', 'medium', 'low'].map((tier) => pick('agy:claude', tier)),
    ['claude-opus-4-6-thinking', 'claude-sonnet-4-6', 'gpt-oss-120b-medium']);
  const gptOss = discoveries['agy:claude'].models.find((m) => m.id === 'gpt-oss-120b-medium');
  assert.deepEqual([gptOss.tier, gptOss.autoRecommend], ['low', true]);
  // Argon stays listed but never suggested.
  assert.ok(!['high', 'medium', 'low'].some((tier) => report.providerSuggestions.agy[tier].candidates.some((c) => c.model === 'gemini-4-argon')));

  applyStrategyRecommendations(home, report, { enableAutoRefresh: false });
  const tiers = loadState(home).strategy.modelTiers;
  assert.deepEqual(tiers.agy, { 'gemini-4-carbon': ['high'], 'gemini-4-hydrogen': ['medium'], 'gemini-3.8-flash': ['low'] });
  assert.deepEqual(tiers['agy:claude'], {
    'claude-opus-4-6-thinking': ['high'], 'claude-sonnet-4-6': ['medium'], 'gpt-oss-120b-medium': ['low'],
  });

  // With those rungs applied, agy:claude takes low-effort work too, on GPT-OSS with no --effort.
  const pools = await poolsFrom(home, await agyReadings(home, usageBody(CLAUDE_BEHIND)));
  for (const [effort, model] of [['high', 'claude-opus-4-6-thinking'], ['medium', 'claude-sonnet-4-6'], ['low', 'gpt-oss-120b-medium']]) {
    const preview = await previewStepPick({
      action: { id: 'task', lane: 'chore', effort }, pools, bullswarmDir: home,
      coreState: { decisionLog: [] }, targetDir: home, now: NOW,
    });
    assert.equal(preview.pick?.pool, 'agy:claude', `${effort}: ${preview.why}`);
    const command = preview.pick.command;
    assert.ok(pairAt(command, '--model', model), `${effort}: ${command.join(' ')}`);
    assert.ok(!command.includes('--effort'), `${effort}: ${command.join(' ')}`);
  }
});

// --- B: one /usage read serves both pools ------------------------------------------------

test('B: refreshing both agy pools spawns agy once, and each pool reads its own group', async (t) => {
  const home = tempHome(t);
  const { runner, calls } = countingRunner([usageBody(CLAUDE_BEHIND)]);
  const readings = await agyReadings(home, null, { runner });
  assert.equal(calls.length, 1, 'one `agy -p /usage` for both pools');
  assert.equal(readings.agy.source, 'live');
  assert.equal(readings['agy:claude'].source, 'live');
  assert.equal(readings.agy.snapshot.pool, 'agy');
  assert.equal(readings['agy:claude'].snapshot.pool, 'agy:claude');
  assert.equal(readings.agy.snapshot.seven_day.utilization, 60);
  assert.equal(readings['agy:claude'].snapshot.seven_day.utilization, 0.1);
});

test('B: readUsage reuses one /usage result for 30 s per runner and env, and a fresh read is never served from it', async () => {
  const { readUsage } = await agyModule();
  const { runner, calls } = countingRunner([USAGE]);
  let clock = NOW;
  const ctx = { runner, env: { HOME: '/home/a' }, now: () => clock };
  await Promise.all([readUsage('agy', ctx), readUsage('agy:claude', ctx)]);
  assert.equal(calls.length, 1, 'concurrent reads share one spawn');
  clock += 29_000;
  await readUsage('agy:claude', ctx);
  assert.equal(calls.length, 1, 'inside 30 s');
  // Another login (another HOME) is another reading.
  await readUsage('agy', { ...ctx, env: { HOME: '/home/b' } });
  assert.equal(calls.length, 2);
  // A caller that needs a reading taken now (the read after a quota refusal) gets one.
  await readUsage('agy', { ...ctx, maxAgeMs: 0 });
  assert.equal(calls.length, 3);
  clock += 31_000;
  await readUsage('agy', ctx);
  assert.equal(calls.length, 4, 'after 30 s');
  // A failed read is not kept: the next one tries again.
  const failing = countingRunner([{ status: 'ERROR', error: 'boom' }, USAGE]);
  await assert.rejects(readUsage('agy', { ...ctx, runner: failing.runner }), (error) => error.code === 'cli_error');
  const ok = await readUsage('agy', { ...ctx, runner: failing.runner });
  assert.equal(ok.pool, 'agy');
  assert.equal(failing.calls.length, 2);
});

// --- C: quota per pool, sign-in per login ----------------------------------------------------

test('C: a RESOURCE_EXHAUSTED refusal on agy holds agy, never agy:claude', async (t) => {
  const home = tempHome(t);
  const { connectors } = providersWithRunner(home, null);
  assert.ok(findQuotaFailure(connectors.agy, 'Error: RESOURCE_EXHAUSTED: quota exceeded for gemini-4-carbon'),
    'RESOURCE_EXHAUSTED reads as a quota notice');

  // Both pools read once; agy is the most behind, so it would get the work.
  await agyReadings(home, usageBody(GEMINI_BEHIND));
  // The refusal (watch.js calls this on a quota verdict); the meter is down right then.
  const refused = await refreshMeterAfterQuota('agy', {
    bullswarmDir: home, connector: connectors.agy, nowMs: NOW, resetAtMs: GEMINI_5H_RESET,
    reason: 'RESOURCE_EXHAUSTED', reader: async () => { throw new Error('meter unavailable'); },
  });
  assert.equal(refused.source, 'quota-refusal');

  // A minute later both meters read fine again, both far behind their weekly pace.
  const later = await agyReadings(home, usageBody(BOTH_BEHIND), { nowMs: NOW + 60_000 });
  assert.equal(later.agy.source, 'quota-refusal', 'the named refusal outlives the live read');
  assert.equal(later['agy:claude'].source, 'live');
  assert.equal(later['agy:claude'].quotaRefusal, undefined);
  const pools = await poolsFrom(home, later);
  const route = pickPool('build', pools, { now: NOW + 60_000 });
  assert.equal(route.pick?.pool, 'agy:claude', route.why);
  assert.ok(!route.candidates.some((c) => c.pool === 'agy'), route.why);
  // No sign-in hold on either pool: the login is fine.
  const state = loadState(home);
  assert.equal(state.pools?.agy?.authHold, undefined);
  assert.equal(state.pools?.['agy:claude']?.authHold, undefined);
});

test('C: the read after a quota refusal is a fresh /usage, not the shared one, and holds only agy', async (t) => {
  const home = tempHome(t);
  // First the shared read; then, after the refusal, Gemini's 5h bucket reads empty.
  const { runner, calls } = countingRunner([usageBody(BOTH_BEHIND), usageBody({ ...BOTH_BEHIND, gemini: { weekly: 0.999, '5h': 0 } })]);
  const { providers, connectors } = providersWithRunner(home, runner);
  await getAllMeterReadings(['agy', 'agy:claude'], { bullswarmDir: home, providers, nowMs: NOW, force: true });
  assert.equal(calls.length, 1);
  const refreshed = await refreshMeterAfterQuota('agy', {
    bullswarmDir: home, providers, connector: connectors.agy, nowMs: NOW + 1000, resetAtMs: GEMINI_5H_RESET,
  });
  assert.equal(calls.length, 2, 'the post-refusal read spawned agy again');
  assert.equal(refreshed.source, 'live');
  assert.equal(refreshed.snapshot.five_hour.utilization, 100);
  const claude = await getMeterReading('agy:claude', { bullswarmDir: home, providers, nowMs: NOW + 2000, force: true });
  assert.notEqual(claude.snapshot.five_hour.utilization, 100);
  const pools = await poolsFrom(home, {
    agy: await getMeterReading('agy', { bullswarmDir: home, providers, nowMs: NOW + 2000, force: true }),
    'agy:claude': claude,
  });
  assert.equal(pickPool('build', pools, { now: NOW + 2000 }).pick?.pool, 'agy:claude');
});

function fakeWorker(ran, verdictFor) {
  return async (connector, task, targetDir, files, opts) => {
    ran.push({ pool: connector.name, model: opts.model, argv: argvWithModel(connector, { taskFile: files.taskFile, cwd: targetDir }, opts.model, opts.conversation, opts.reasoning) });
    writeFileSync(files.taskFile, task);
    return verdictFor(connector.name);
  };
}

async function dispatchOnce(home, pools, worker, { action = { id: 'task', lane: 'build', effort: 'high' }, preferredModel = null } = {}) {
  const core = { config: { depthLimit: 2 }, pools: {}, incumbents: {}, decisionLog: [] };
  const dir = mkdtempSync(join(home, 'run-'));
  return dispatchV2Action({
    action, taskText: 'do it', targetDir: dir,
    paths: { taskFile: join(dir, 'task.md'), outFile: join(dir, 'out.md') },
    pools, bullswarmDir: home, maxMechanicalRetries: 0, preferredModel,
    routeFilter: action.route ? resolveRouteFilter({ attempts: [] }, action, pools) : null,
    refreshPools: async () => pools,
    dependencies: {
      watchOnce: worker,
      loadState: () => structuredClone(core),
      saveState: (_dir, next) => Object.assign(core, structuredClone(next)),
      now: () => NOW,
      uuid: () => 'session-fixed',
    },
  });
}

const failedWith = (failureKind, why) => ({ ok: false, why, failureKind, meta: { exitCode: 1, wallSec: 1 } });

test('C: a quota failure at dispatch on agy stores no hold on either pool; a sign-in failure holds both', async (t) => {
  const home = tempHome(t);
  const pools = await poolsFrom(home, await agyReadings(home, usageBody(GEMINI_BEHIND)));
  const ran = [];
  const quota = await dispatchOnce(home, pools, fakeWorker(ran, () => failedWith('quota', 'RESOURCE_EXHAUSTED')));
  assert.equal(ran[0].pool, 'agy');
  assert.equal(quota.ok, false);
  let state = loadState(home);
  assert.equal(state.pools?.agy?.authHold, undefined);
  assert.equal(state.pools?.['agy:claude']?.authHold, undefined);

  ran.length = 0;
  await dispatchOnce(home, pools, fakeWorker(ran, () => failedWith('auth', 'sign-in failed')));
  assert.equal(ran[0].pool, 'agy');
  state = loadState(home);
  assert.ok(state.pools.agy.authHold, 'the failing pool is held');
  const { connectors } = loadProviders(home, loaderFor(home));
  const held = activeAuthHolds(state.pools, connectors, NOW + 60_000);
  assert.equal(held['agy:claude']?.via, 'agy', 'the other pool on the same login is held too');
  assert.equal(held.codex, undefined);

  // The next run, with agy:claude now the most behind, goes to neither agy pool.
  const next = await poolsFrom(home, await agyReadings(home, usageBody(CLAUDE_BEHIND), { nowMs: NOW + 60_000 }));
  assert.ok(next.find((p) => p.name === 'agy:claude').authHold);
  ran.length = 0;
  await dispatchOnce(home, next, fakeWorker(ran, () => failedWith('process', 'stop here')));
  assert.ok(ran.length >= 1);
  assert.ok(!ran.some((r) => r.pool.startsWith('agy')), JSON.stringify(ran.map((r) => r.pool)));
});

// --- D: a model pin picks the pool that serves it ------------------------------------------

test('D: --use-provider agy with a Claude model runs on agy:claude, with a Gemini model on agy', async (t) => {
  const home = tempHome(t);
  const parsed = runStepRequest({ lane: 'build', 'use-provider': 'agy', model: 'claude-opus-4-6-thinking', rest: ['do it'], check: 'true' }, { cwd: home });
  assert.equal(parsed.error, undefined, parsed.error);
  const step = runStepProgram(parsed.request).steps[0];
  assert.deepEqual([step.model, step.route], ['claude-opus-4-6-thinking', { providers: { use: ['agy'] } }]);

  for (const [buckets, model, expected] of [
    [GEMINI_BEHIND, 'claude-opus-4-6-thinking', 'agy:claude'],
    [GEMINI_BEHIND, 'gpt-oss-120b-medium', 'agy:claude'],
    [CLAUDE_BEHIND, 'gemini-4-carbon', 'agy'],
    [CLAUDE_BEHIND, 'gemini-4-hydrogen', 'agy'],
  ]) {
    const pools = await poolsFrom(home, await agyReadings(home, usageBody(buckets)));
    const action = { id: 'task', lane: 'build', effort: 'high', model, route: { providers: { use: ['agy'] } } };
    const preview = await previewStepPick({ action, pools, bullswarmDir: home, coreState: { decisionLog: [] }, targetDir: home, now: NOW });
    assert.equal(preview.pick?.pool, expected, `${model}: ${preview.why}`);
    assert.ok(pairAt(preview.pick.command, '--model', model), preview.pick.command.join(' '));
    assert.equal(preview.pick.command.includes('--effort'), expected === 'agy', preview.pick.command.join(' '));

    // The same through dispatch: the worker runs the pinned model on the pool that serves it.
    const ran = [];
    await dispatchOnce(home, pools, fakeWorker(ran, () => failedWith('process', 'stop here')), { action, preferredModel: model });
    assert.deepEqual(ran.map((r) => [r.pool, r.model]), [[expected, model]]);
  }
});

test('D: a Gemini model is never dispatched on agy:claude, nor a Claude or GPT-OSS model on agy', async (t) => {
  const home = tempHome(t);
  const pools = await poolsFrom(home, await agyReadings(home, usageBody(GEMINI_BEHIND)));
  const action = { id: 'task', lane: 'build', effort: 'high' };
  const names = (model, opts = {}) => prepareV2DispatchPools(pools, action, 'high', { preferredModel: model, now: NOW, ...opts })
    .map((p) => p.name).filter((name) => name.startsWith('agy'));
  for (const model of ['gemini-4-carbon', 'gemini-4-argon', 'gemini-4-hydrogen', 'gemini-3.8-flash']) {
    assert.deepEqual(names(model), ['agy'], model);
    assert.deepEqual(names(model, { strictPool: 'agy:claude' }), [], `${model} pinned to agy:claude`);
  }
  for (const model of ['claude-opus-4-6-thinking', 'claude-sonnet-4-6', 'gpt-oss-120b-medium']) {
    assert.deepEqual(names(model), ['agy:claude'], model);
    assert.deepEqual(names(model, { strictPool: 'agy' }), [], `${model} pinned to agy`);
  }
  // The orchestrator is AGY's own mode: no pool runs it.
  assert.deepEqual(names('gemini-pro-orchestrator'), []);
});

// --- E: pools and strategy show two pools with their own meters; docs -----------------------

test('E: the pool list shows agy and agy:claude as two rows, each with its own meter', async (t) => {
  const home = tempHome(t);
  const pools = await poolsFrom(home, await agyReadings(home, usageBody({ gemini: { weekly: 0.7, '5h': 0.9 }, claude: { weekly: 0.2, '5h': 0.5 } })));
  const rows = pools.filter((p) => p.name.startsWith('agy'));
  assert.deepEqual(rows.map((p) => p.name), ['agy', 'agy:claude']);
  const [gemini, claude] = rows;
  assert.deepEqual([gemini.meterSource, claude.meterSource], ['live', 'live']);
  assert.deepEqual([gemini.usedPct, claude.usedPct], [30, 80]);
  assert.deepEqual([gemini.fiveHourUsedPct, claude.fiveHourUsedPct], [10, 50]);
  assert.equal(gemini.pacingWindow, 'weekly');
  assert.equal(claude.pacingWindow, 'weekly');
  assert.notEqual(gemini.paceResetsAt, claude.paceResetsAt, 'each group has its own reset');
  for (const p of rows) assert.match(poolStatusText(p, NOW), /^ready/);
});

test('E: strategy lists a suggestion column per agy pool', async (t) => {
  const { report } = await strategyReport(t);
  assert.deepEqual(Object.keys(report.providerSuggestions).sort(), ['agy', 'agy:claude']);
  // The cross-pool view ranks both agy pools on every tier.
  for (const tier of ['high', 'medium', 'low']) {
    const pools = new Set((report.suggestions[tier].candidates ?? []).map((c) => c.pool));
    assert.ok(pools.has('agy') && pools.has('agy:claude'), `${tier}: ${[...pools].join(', ')}`);
  }
  for (const pool of ['agy', 'agy:claude']) {
    for (const tier of ['high', 'medium', 'low']) {
      assert.ok(report.providerSuggestions[pool][tier].recommended, `${pool} ${tier}`);
    }
  }
});

test('E: providers.md describes one login with several quota pools', () => {
  const doc = readFileSync(join(REPO, 'docs/reference/providers.md'), 'utf8');
  const start = doc.indexOf('## One login, several quota pools');
  assert.ok(start >= 0, 'providers.md has the section');
  const end = doc.indexOf('\n## ', start + 1);
  const section = doc.slice(start, end > 0 ? end : undefined);
  for (const needle of ['connectors(ctx)', 'credentialGroup', 'agy:claude', 'quota', 'sign-in', '/usage']) {
    assert.ok(section.includes(needle), `the section mentions ${needle}`);
  }
});
