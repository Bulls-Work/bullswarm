import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { autoSetup } from '../src/setup.js';
import {
  buildStrategy, discoverConnectorModels, resolveDispatchModel, selectedModelsForTier,
} from '../src/lib/strategy.js';
import { loadConnectors } from '../src/lib/config.js';
import { loadState, saveState } from '../src/lib/state.js';
import {
  refreshStrategy, cmdStrategy, applyStrategyRecommendations, maybeRefreshStrategy, strategyInventory,
  renderRungs, rungRows,
} from '../src/strategy-cli.js';
import {
  inputKeys, recommendationLines, renderAnalysisProgress, renderRecommendationReview,
  renderSetupChoice, renderStrategyDashboard, visibleModels,
} from '../src/strategy-dashboard.js';
import { loadEpochBenchmarks, rungEvidence } from '../src/lib/epoch-benchmarks.js';

// These tests assert the unicode presentation, so pin it: the glyph table
// otherwise follows the developer's terminal and would fall back to ascii
// when the suite runs inside Apple Terminal.
process.env.BULLSWARM_UNICODE = '1';
// BULLSWARM_ASCII outranks it, and it is the workaround the README hands
// an affected user, so a contributor may well have it in their shell.
delete process.env.BULLSWARM_ASCII;

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'bullswarm-strategy-cli-'));
  autoSetup(dir, { reason: 'test' });
  // Strategy tests must not depend on whichever agent CLIs happen to be on
  // the host PATH. Enable one real packaged connector without dispatching it.
  // command-code is a contrib provider: its pools exist only once enabled.
  writeFileSync(join(dir, 'providers.json'), `${JSON.stringify({ enabled: ['command-code'] })}\n`);
  const state = loadState(dir);
  state.pools.codex ??= {};
  state.pools.codex.enabled = true;
  saveState(dir, state);
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('strategy refresh persists honest discovery and tier suggestions', async () => {
  const f = fixture();
  try {
    const progress = [];
    const report = await refreshStrategy(f.dir, {
      executor: (command) => command.includes('grok') ? '* grok-4.6 (default)\n' : 'gpt-5.6-luna  low\n',
      getReadings: async () => ({}),
      onProgress: (label) => progress.push(label),
    });
    assert.equal(report.schemaVersion, 'bullswarm.strategy.v1');
    assert.ok(report.discoveries.grok.models.some((model) => model.id === 'grok-4.6'));
    assert.equal(loadState(f.dir).strategy.lastReport.capturedAt, report.capturedAt);
    assert.match(report.caveats.join(' '), /does not invent/i);
    assert.match(progress[0], /^\[0\/\d+\] Preparing provider usage checks$/);
    assert.deepEqual(progress.slice(1), [
      'Discovering available models',
      'Comparing capability, quality, budget, and quota',
    ]);
  } finally { f.cleanup(); }
});

test('strategy subscription view states a missing price and then a declared price', async () => {
  const f = fixture();
  try {
    await refreshStrategy(f.dir, { executor: () => '', getReadings: async () => ({}) });
    const missing = await runStrategy(['show'], f.dir);
    assert.equal(missing.code, 0);
    assert.match(missing.out, /price unavailable: no published or operator-declared monthly price/);

    const originalLog = console.log;
    console.log = () => {};
    try {
      assert.equal(await cmdStrategy([
        'set-subscription', 'command-code', '--monthly-usd', '10', '--included-usd', '70',
      ], { bullswarmDir: f.dir }), 0);
    } finally { console.log = originalLog; }
    await refreshStrategy(f.dir, { executor: () => '', getReadings: async () => ({}) });
    const declared = await runStrategy(['show'], f.dir);
    assert.match(declared.out, /\$10\.00\/mo → \$70\.00 included/);
  } finally { f.cleanup(); }
});

test('strategy subscription metadata and assignments are explicit persisted user choices', async () => {
  const f = fixture();
  const originalLog = console.log;
  console.log = () => {};
  try {
    assert.equal(await cmdStrategy([
      'set-subscription', 'command-code', '--plan', 'Go', '--monthly-usd', '10',
      '--included-usd', '70', '--quota-window', 'monthly',
    ], { bullswarmDir: f.dir }), 0);
    assert.equal(await cmdStrategy([
      'assign', 'low', '--pool', 'command-code', '--model', 'gpt-5.6-luna',
    ], { bullswarmDir: f.dir }), 0);
    const state = loadState(f.dir);
    assert.deepEqual(state.strategy.subscriptions['command-code'], {
      plan: 'Go', monthlyPriceUsd: 10, includedValueUsd: 70, quotaWindow: 'monthly',
    });
    // Marked as the user's, so no apply or auto-refresh ever removes it.
    assert.deepEqual(state.strategy.assignments.low, {
      pool: 'command-code', model: 'gpt-5.6-luna', source: 'user',
    });
  } finally {
    console.log = originalLog;
    f.cleanup();
  }
});

test('strategy model exclusions are persisted and reversible', async () => {
  const f = fixture();
  const originalLog = console.log;
  console.log = () => {};
  try {
    assert.equal(await cmdStrategy(['exclude-model', 'Claude-Fable-5'], { bullswarmDir: f.dir }), 0);
    assert.deepEqual(loadState(f.dir).strategy.excludedModels, ['claude-fable-5']);
    assert.equal(await cmdStrategy(['include-model', 'claude-fable-5'], { bullswarmDir: f.dir }), 0);
    assert.deepEqual(loadState(f.dir).strategy.excludedModels, []);
  } finally {
    console.log = originalLog;
    f.cleanup();
  }
});

test('apply writes per-pool rungs, never a tier pin, and persists an auto-refresh policy', async () => {
  const f = fixture();
  try {
    const report = await refreshStrategy(f.dir, {
      executor: () => '',
      getReadings: async () => ({}),
    });
    assert.deepEqual(loadState(f.dir).strategy.assignments ?? {}, {});
    const result = applyStrategyRecommendations(f.dir, report, { refreshHours: 12 });
    assert.ok(Object.keys(result.bestNow).length > 0, 'the tier-wide pick is still reported');
    assert.ok(Object.keys(result.rungs).length > 0, 'each pool gets its rungs');
    assert.deepEqual([result.unpinned, result.keptPins], [[], []]);
    const state = loadState(f.dir);
    assert.deepEqual(state.strategy.assignments, {});
    assert.equal(state.strategy.lastReport.suggestions.high.assignment, null);
    for (const [pool, tiers] of Object.entries(result.rungs)) {
      for (const [tier, model] of Object.entries(tiers)) {
        assert.ok(state.strategy.modelTiers[pool][model].includes(tier), `${pool} ${tier} rung is ${model}`);
      }
    }
    assert.equal(state.strategy.policy.autoApplyRecommendations, true);
    assert.equal(state.strategy.policy.refreshHours, 12);
    assert.equal(state.strategy.policy.source, 'explicit-user-approval');
  } finally { f.cleanup(); }
});

test('strategy auto-refresh skips fresh reports and refreshes stale approved reports', async () => {
  const f = fixture();
  try {
    const initial = await refreshStrategy(f.dir, {
      executor: () => '', getReadings: async () => ({}),
    });
    applyStrategyRecommendations(f.dir, initial, { refreshHours: 1 });
    let discoveries = 0;
    assert.equal(await maybeRefreshStrategy(f.dir, {
      executor: () => { discoveries += 1; return ''; }, getReadings: async () => ({}),
    }), null);
    assert.equal(discoveries, 0);

    const state = loadState(f.dir);
    state.strategy.lastRefreshedAt = new Date(Date.now() - 2 * 3600_000).toISOString();
    saveState(f.dir, state);
    const refreshed = await maybeRefreshStrategy(f.dir, {
      executor: () => { discoveries += 1; return ''; }, getReadings: async () => ({}),
      openRouterCatalog: { models: {}, cache: 'test' },
    });
    assert.ok(refreshed?.report);
    assert.ok(discoveries > 0);
    assert.equal(loadState(f.dir).strategy.policy.autoApplyRecommendations, true);
  } finally { f.cleanup(); }
});

test('applying recommendations persists no more than one model per provider tier', async () => {
  const f = fixture();
  try {
    const report = await refreshStrategy(f.dir, {
      executor: () => '', getReadings: async () => ({}),
      useOpenRouter: true,
      openRouterCatalog: {
        models: {
          'openai/gpt-5.6-sol': { id: 'openai/gpt-5.6-sol', ranks: { coding: 1 }, pricing: {} },
          'openai/gpt-5.6-terra': { id: 'openai/gpt-5.6-terra', ranks: { coding: 2 }, pricing: {} },
          'openai/gpt-5.6-luna': { id: 'openai/gpt-5.6-luna', ranks: { coding: 3 }, pricing: {} },
        },
        cache: 'test',
      },
    });
    applyStrategyRecommendations(f.dir, report);
    const strategy = loadState(f.dir).strategy;
    for (const models of Object.values(strategy.modelTiers ?? {})) {
      for (const tier of ['high', 'medium', 'low']) {
        assert.ok(Object.values(models).filter((tiers) => tiers.includes(tier)).length <= 1);
      }
    }
  } finally { f.cleanup(); }
});

// --- tier pins -----------------------------------------------------------------

// A home as an earlier (0.35.4 or older) apply left it: the pins it wrote, the
// same pins recorded in lastReport.suggestions[tier].assignment, and its stamp.
// `recorded` may differ from `pins` where the user changed a pin afterwards.
function legacyApplyHome(dir, { pins, recorded = pins, stale = false }) {
  const state = loadState(dir);
  const now = Date.now();
  state.strategy = {
    ...(state.strategy ?? {}),
    assignments: structuredClone(pins),
    lastAppliedAt: new Date(now - 3 * 3600_000).toISOString(),
    lastRefreshedAt: new Date(stale ? now - 48 * 3600_000 : now).toISOString(),
    policy: { autoApplyRecommendations: true, refreshHours: 24, source: 'explicit-user-approval' },
    lastReport: {
      capturedAt: new Date(now - 3 * 3600_000).toISOString(),
      subscriptions: [],
      discoveries: {},
      suggestions: Object.fromEntries(['high', 'medium', 'low'].map((tier) => [tier, {
        assignment: recorded[tier] ?? null, recommended: recorded[tier] ?? null, basis: 'fixture',
      }])),
    },
  };
  saveState(dir, state);
}

const ASTRA = { pool: 'codex', model: 'gpt-6-astra' };
const LUNA = { pool: 'codex', model: 'gpt-6-luna' };
const USER_MEDIUM = { pool: 'command-code', model: 'gpt-5.6-terra' };

test('apply removes a pin an earlier apply wrote, reports it, and keeps one the user changed', async () => {
  const f = fixture();
  try {
    // high is still what apply recorded; the user moved medium afterwards.
    legacyApplyHome(f.dir, {
      pins: { high: ASTRA, medium: USER_MEDIUM },
      recorded: { high: ASTRA, medium: LUNA },
    });
    const result = applyStrategyRecommendations(f.dir, await codexFallbackReport(f.dir));
    assert.deepEqual(result.unpinned, [{ tier: 'high', ...ASTRA }]);
    assert.deepEqual(result.keptPins, [{ tier: 'medium', ...USER_MEDIUM, source: 'user' }]);
    const saved = loadState(f.dir).strategy;
    assert.deepEqual(saved.assignments, { medium: { ...USER_MEDIUM, source: 'user' } });
    // The kept pin runs its own model, and the report no longer names the removed one.
    assert.deepEqual(saved.modelTiers['command-code'], { 'gpt-5.6-terra': ['medium'] });
    assert.equal(saved.lastReport.suggestions.high.assignment, null);
    // Nothing is left for a second apply to remove.
    const again = applyStrategyRecommendations(f.dir, await codexFallbackReport(f.dir));
    assert.deepEqual([again.unpinned, again.keptPins.map((pin) => pin.tier)], [[], ['medium']]);
  } finally { f.cleanup(); }
});

test('apply leaves a pin the user set alone, even once a refresh copies it into the report', async () => {
  const f = fixture();
  try {
    applyStrategyRecommendations(f.dir, await codexFallbackReport(f.dir));
    assert.equal((await runStrategy(['assign', 'high', '--pool', 'command-code', '--model', 'gpt-5.6-sol'], f.dir)).code, 0);
    // A refresh stores the pin in force where an earlier apply recorded its own.
    await refreshStrategy(f.dir, { executor: () => '', getReadings: async () => ({}) });
    const pin = { pool: 'command-code', model: 'gpt-5.6-sol', source: 'user' };
    assert.deepEqual(loadState(f.dir).strategy.lastReport.suggestions.high.assignment, pin);
    const result = applyStrategyRecommendations(f.dir, loadState(f.dir).strategy.lastReport);
    assert.deepEqual(result.unpinned, []);
    assert.deepEqual(result.keptPins, [{ tier: 'high', ...pin }]);
    assert.deepEqual(loadState(f.dir).strategy.assignments, { high: pin });
    // Pinned means the pool and its model: the pool's high rung is the pin's,
    // so dispatch runs gpt-5.6-sol there rather than the rung apply chose.
    const saved = loadState(f.dir).strategy;
    const commandCode = loadConnectors(f.dir, { packaged: true })['command-code'];
    assert.deepEqual(resolveDispatchModel(commandCode, 'high', {
      assignment: saved.assignments.high,
      allowedModels: selectedModelsForTier(saved, 'command-code', 'high'),
    }).model, 'gpt-5.6-sol');
    const shown = await runStrategy(['show'], f.dir);
    assert.match(shown.out, /^ {2}high: \S+ \(best now\)$/m);
    assert.match(shown.out, /^ {4}pinned to command-code\/gpt-5\.6-sol by you · high dispatches go there while it is available · strategy clear-assignment high removes it$/m);
    assert.match(shown.out, /medium: \S+.*\(best now; routing picks by spare quota\)/);
  } finally { f.cleanup(); }
});

test('a pin from a home where apply never ran is the user\'s, even when the report copies it', async () => {
  const f = fixture();
  try {
    legacyApplyHome(f.dir, { pins: { high: ASTRA } });
    const state = loadState(f.dir);
    delete state.strategy.lastAppliedAt;
    saveState(f.dir, state);
    const result = applyStrategyRecommendations(f.dir, await codexFallbackReport(f.dir));
    assert.deepEqual(result.unpinned, []);
    assert.deepEqual(result.keptPins, [{ tier: 'high', ...ASTRA, source: 'user' }]);
  } finally { f.cleanup(); }
});

test('an old pin is sorted before a command drops the report, so the next apply still removes it', async () => {
  const f = fixture();
  try {
    legacyApplyHome(f.dir, { pins: { high: ASTRA, low: LUNA } });
    // exclude-model drops the cached report: the only record of those pins.
    assert.equal((await runStrategy(['exclude-model', 'gpt-nope'], f.dir)).code, 0);
    const sorted = loadState(f.dir).strategy;
    assert.equal(sorted.lastReport, undefined);
    assert.deepEqual(sorted.assignments, { high: { ...ASTRA, source: 'apply' }, low: { ...LUNA, source: 'apply' } });
    await refreshStrategy(f.dir, { executor: () => '', getReadings: async () => ({}) });
    const shown = await runStrategy(['show'], f.dir);
    assert.match(shown.out, /pinned to codex\/gpt-6-astra by an earlier setup · high dispatches go there while it is available · the next strategy apply removes it/);
    const result = applyStrategyRecommendations(f.dir, loadState(f.dir).strategy.lastReport);
    assert.deepEqual(result.unpinned, [{ tier: 'high', ...ASTRA }, { tier: 'low', ...LUNA }]);
    assert.deepEqual(loadState(f.dir).strategy.assignments, {});
  } finally { f.cleanup(); }
});

test('auto-refresh removes pins an earlier apply wrote and keeps the user\'s', async () => {
  const f = fixture();
  try {
    // low is a pin `strategy assign` wrote, which a refresh then copied into
    // the report: the record matches it, and `source: 'user'` still protects it.
    const userLow = { pool: 'command-code', model: 'gpt-5.6-luna', source: 'user' };
    legacyApplyHome(f.dir, {
      pins: { high: ASTRA, medium: USER_MEDIUM, low: userLow },
      recorded: { high: ASTRA, medium: LUNA, low: userLow },
      stale: true,
    });
    const refreshed = await maybeRefreshStrategy(f.dir, {
      executor: () => '', getReadings: async () => ({}),
      openRouterCatalog: { models: {}, cache: 'test' },
    });
    assert.ok(refreshed?.report, JSON.stringify(refreshed));
    assert.deepEqual(refreshed.unpinned, [{ tier: 'high', ...ASTRA }]);
    assert.deepEqual(refreshed.keptPins, [
      { tier: 'medium', ...USER_MEDIUM, source: 'user' },
      { tier: 'low', ...userLow },
    ]);
    const saved = loadState(f.dir).strategy;
    assert.deepEqual(Object.keys(saved.assignments), ['medium', 'low']);
    assert.equal(saved.policy.autoApplyRecommendations, true);
    // The refresh did not pin anything new.
    assert.equal(saved.assignments.high, undefined);
  } finally { f.cleanup(); }
});

test('strategy show counts unranked models per pool instead of listing them', async () => {
  const f = fixture();
  try {
    const unranked = [
      ...['a', 'b', 'c'].map((model) => ({ pool: 'command-code', model: `cc-${model}`, ranking: 'unranked' })),
      { pool: 'codex', model: 'nova-9-preview', ranking: 'unranked' },
      ...['x', 'y'].map((model) => ({ pool: 'opencode', model: `oc-${model}`, ranking: 'unranked' })),
    ];
    const state = loadState(f.dir);
    state.strategy = {
      ...(state.strategy ?? {}),
      lastReport: { capturedAt: new Date().toISOString(), subscriptions: [], suggestions: {}, discoveries: {}, unranked },
    };
    saveState(f.dir, state);
    const shown = await runStrategy(['show'], f.dir);
    assert.equal(shown.code, 0);
    assert.match(shown.out, /^unranked: 6 models \(command-code 3, opencode 2, codex 1\) · never recommended · strategy show --json lists them$/m);
    for (const entry of unranked) assert.doesNotMatch(shown.out, new RegExp(entry.model));
    // JSON keeps the full list.
    const json = JSON.parse((await runStrategy(['show', '--json'], f.dir)).out);
    assert.deepEqual(json.unranked, unranked);
  } finally { f.cleanup(); }
});

test('strategy argument errors use usage exit code 2', async () => {
  const f = fixture();
  const originalError = console.error;
  console.error = () => {};
  try {
    assert.equal(await cmdStrategy(['set-subscription', 'missing-pool'], { bullswarmDir: f.dir }), 2);
    assert.equal(await cmdStrategy(['assign', 'low', '--pool', 'missing-pool', '--model', 'x'], { bullswarmDir: f.dir }), 2);
    assert.equal(await cmdStrategy(['auto', 'off'], { bullswarmDir: f.dir }), 2);
  } finally {
    console.error = originalError;
    f.cleanup();
  }
});

test('--quota-window selects the pacing window and refuses anything else', async () => {
  const f = fixture();
  const originalLog = console.log;
  const originalError = console.error;
  console.log = () => {};
  console.error = () => {};
  try {
    const run = (args) => cmdStrategy(args, { bullswarmDir: f.dir });
    // command-code's real budget is its monthly credit allocation.
    assert.equal(await run(['set-subscription', 'command-code', '--quota-window', 'monthly']), 0);
    assert.equal(loadState(f.dir).strategy.subscriptions['command-code'].quotaWindow, 'monthly');
    assert.equal(await run(['set-subscription', 'command-code', '--quota-window', 'Weekly']), 0);
    assert.equal(loadState(f.dir).strategy.subscriptions['command-code'].quotaWindow, 'weekly');

    // A label pacing cannot act on is refused, and nothing is written.
    assert.equal(await run(['set-subscription', 'command-code', '--quota-window', 'fortnight']), 2);
    assert.equal(await run(['set-subscription', 'command-code', '--quota-window', '5h']), 2);
    assert.equal(loadState(f.dir).strategy.subscriptions['command-code'].quotaWindow, 'weekly');

    // `unknown` clears it back to the connector's own declaration.
    assert.equal(await run(['set-subscription', 'command-code', '--quota-window', 'unknown']), 0);
    assert.equal(loadState(f.dir).strategy.subscriptions['command-code'].quotaWindow, null);
  } finally {
    console.log = originalLog;
    console.error = originalError;
    f.cleanup();
  }
});

test('agent-facing model configuration is multi-select and clears legacy tier pins', async () => {
  const f = fixture();
  const originalLog = console.log;
  console.log = () => {};
  try {
    const state = loadState(f.dir);
    state.strategy = {
      assignments: { high: { pool: 'codex', model: 'old' } },
      lastReport: {
        capturedAt: new Date().toISOString(), subscriptions: [], suggestions: {},
        discoveries: { codex: { models: [{ id: 'gpt-5.6-sol', tier: 'high', qualityRank: 6 }] } },
      },
    };
    saveState(f.dir, state);
    assert.equal(await cmdStrategy([
      'set-model', 'codex', 'gpt-5.6-sol', '--tiers', 'high,medium', '--yes',
    ], { bullswarmDir: f.dir }), 0);
    const saved = loadState(f.dir);
    assert.deepEqual(saved.strategy.modelTiers.codex['gpt-5.6-sol'], ['high', 'medium']);
    assert.deepEqual(saved.strategy.configuredTiers, ['high', 'medium']);
    assert.equal(saved.strategy.assignments.high, undefined);
  } finally { console.log = originalLog; f.cleanup(); }
});

test('turning one model off does not convert automatic tiers into empty allow-lists', async () => {
  const f = fixture();
  const originalLog = console.log;
  console.log = () => {};
  try {
    const state = loadState(f.dir);
    state.strategy = {
      lastReport: {
        capturedAt: new Date().toISOString(), subscriptions: [], suggestions: {},
        discoveries: { codex: { models: [{ id: 'gpt-5.6-sol', tier: 'high', qualityRank: 6 }] } },
      },
    };
    saveState(f.dir, state);
    assert.equal(await cmdStrategy([
      'set-model', 'codex', 'gpt-5.6-sol', '--tiers', 'off', '--yes',
    ], { bullswarmDir: f.dir }), 0);
    const saved = loadState(f.dir);
    assert.deepEqual(saved.strategy.configuredTiers ?? [], []);
    assert.deepEqual(saved.strategy.disabledModels.codex, ['gpt-5.6-sol']);
  } finally { console.log = originalLog; f.cleanup(); }
});

test('strategy inventory and dashboard show provider toggles, tier matrix, and effective routes', () => {
  const connector = {
    name: 'worker', modelSelection: { flag: '--model' }, lanes: ['analyze', 'build', 'chore'],
    capabilities: ['strong-analysis', 'workflow-planning', 'code-reading', 'file-editing'],
    modelProfiles: [{ match: 'smart', tier: 'high', qualityRank: 5 }],
  };
  const state = { strategy: { configuredTiers: ['high'], modelTiers: { worker: { smart: ['high'] } } } };
  const pool = { name: 'worker', connector, enabled: true, lanes: connector.lanes, capabilities: connector.capabilities, pace: 12, usedPct: 20 };
  const report = {
    capturedAt: new Date().toISOString(),
    discoveries: { worker: { models: [{ id: 'smart', tier: 'high', qualityRank: 5 }] } },
    suggestions: { high: { requirements: { lane: 'analyze', capabilities: ['strong-analysis', 'workflow-planning'] } } },
  };
  const inventory = strategyInventory({ pools: [pool], state, report });
  assert.equal(inventory.routes.high.model, 'smart');
  const screen = renderStrategyDashboard(inventory, { width: 60, height: 30 });
  assert.match(screen, /Providers/);
  assert.match(screen, /H smart/);
  assert.match(screen, /M —/);
  assert.match(screen, /L —/);
  assert.match(screen, /Routing now · by spare quota at each dispatch, unless pinned/);
  assert.match(screen, /worker\/smart/);
  assert.equal(inventory.routes.high.pin, null);
  assert.match(screen, /Finish setup/);
});

test('strategy setup sorts providers and hides disabled test fixtures', () => {
  const pool = (name, extra = {}) => ({
    name, connector: { name, lanes: [], capabilities: [] }, enabled: true,
    lanes: [], capabilities: [], pace: 0, ...extra,
  });
  const inventory = strategyInventory({
    pools: [
      pool('relay:b'),
      pool('echo', { enabled: false, testFixture: true }),
      pool('claude-code:acme'),
      pool('claude-code'),
    ],
    state: {},
    report: { capturedAt: new Date().toISOString(), discoveries: {}, suggestions: {} },
  });
  assert.deepEqual(inventory.providers.map((provider) => provider.name), [
    'claude-code', 'claude-code:acme', 'relay:b',
  ]);
  const screen = renderStrategyDashboard(inventory, { width: 70, height: 30 });
  assert.doesNotMatch(screen, /echo/);
});

test('setup choice and analysis progress explain the interactive decision', () => {
  const choice = renderSetupChoice({ selected: 0, width: 80, height: 20 });
  assert.match(choice, /Analyze and recommend \(recommended\)/);
  assert.match(choice, /Configure manually/);
  const progress = renderAnalysisProgress({
    label: 'Discovering available models', startedAt: Date.now() - 2_000, width: 80, height: 20,
  });
  assert.match(progress, /Analyzing providers and models/);
  assert.match(progress, /Discovering available models/);
  assert.match(progress, /2s elapsed/);
  assert.match(progress, /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/);
});

test('model matrix filters by typing and sorts assigned models before disabled models', () => {
  const provider = { models: [
    { id: 'legacy-disabled', tiers: [], effectiveTiers: [], disabled: true },
    { id: 'gpt-5.6-luna', tiers: ['low'], effectiveTiers: ['low'], disabled: false },
    { id: 'gpt-5.6-sol', tiers: ['high'], effectiveTiers: ['high'], disabled: false },
  ] };
  assert.deepEqual(visibleModels(provider).map((model) => model.id), [
    'gpt-5.6-luna', 'gpt-5.6-sol', 'legacy-disabled',
  ]);
  assert.deepEqual(visibleModels(provider, 'sol').map((model) => model.id), ['gpt-5.6-sol']);

  const inventory = {
    providers: [{ name: 'codex', enabled: true, usedPct: 10, models: provider.models }],
    routes: {},
  };
  const screen = renderStrategyDashboard(inventory, {
    view: 'models', providerIndex: 0, modelIndex: 1, tierIndex: 0, search: 'gpt', width: 110, height: 30,
  });
  assert.match(screen, /Search: gpt/);
  assert.match(screen, /High/);
  assert.match(screen, /Medium/);
  assert.match(screen, /Low/);
  assert.match(screen, /\x1b\[7m\[✓ High\]\x1b\[27m/);
});

test('analysis review lists one recommendation per tier and asks before applying', () => {
  const candidate = (model, ranks, pricing) => ({ model, openRouter: { ranks, pricing } });
  const inventory = {
    providers: [{ name: 'claude-code', enabled: true }],
    recommendations: { 'claude-code': {
      high: { recommended: { model: 'claude-opus-5' }, candidates: [candidate('claude-opus-5', { agentic: 1, coding: 2 }, { inputUsdPerMillion: 5, outputUsdPerMillion: 25 })] },
      medium: { recommended: { model: 'claude-sonnet-5' }, candidates: [candidate('claude-sonnet-5', { agentic: 3, coding: 3 }, { inputUsdPerMillion: 2, outputUsdPerMillion: 10 })] },
      low: { recommended: { model: 'claude-haiku-4-5' }, candidates: [candidate('claude-haiku-4-5', { coding: 15 }, { inputUsdPerMillion: 1, outputUsdPerMillion: 5 })] },
    } },
    openRouter: { error: null },
  };
  assert.equal(recommendationLines(inventory).filter((line) => /^  [HML]  /.test(line)).length, 3);
  const screen = renderRecommendationReview(inventory, { width: 100, height: 30 });
  assert.match(screen, /one model per provider and tier/);
  assert.match(screen, /claude-opus-5/);
  assert.match(screen, /agentic #1 · coding #2/);
  assert.match(screen, /Apply these defaults\?  Y yes · N keep current choices/);
  const cached = renderRecommendationReview({
    ...inventory,
    openRouter: { error: 'release asset not published yet' },
  }, { width: 100, height: 30 });
  assert.match(cached, /Using cached benchmark data; latest refresh unavailable/);
  assert.doesNotMatch(cached, /local metadata was used/);
});

test('strategy show and the setup screens name an unranked model instead of dropping it', async () => {
  const f = fixture();
  try {
    const codex = loadConnectors(f.dir, { packaged: true }).codex;
    const discovery = await discoverConnectorModels(codex, {
      provider: { module: { discoverModels: async () => ({
        models: [{ id: 'gpt-5.6-luna' }, { id: 'nova-9-preview' }],
      }) } },
    });
    const report = buildStrategy({
      connectors: { codex },
      pools: [{ name: 'codex', connector: codex, enabled: true, pace: 0, costRank: 3 }],
      state: {},
      discoveries: { codex: discovery },
    });
    const state = loadState(f.dir);
    state.strategy = { ...(state.strategy ?? {}), lastReport: report };
    saveState(f.dir, state);
    const shown = await runStrategy(['show'], f.dir);
    assert.equal(shown.code, 0);
    assert.match(shown.out, /^unranked: 1 model \(codex 1\) · never recommended · strategy show --json lists them$/m);
    assert.doesNotMatch(shown.out, /codex\/nova-9-preview/);
    assert.match(shown.out, /low: codex\/gpt-5\.6-luna \(best now; routing picks by spare quota\)/);
    const json = JSON.parse((await runStrategy(['show', '--json'], f.dir)).out);
    assert.deepEqual(json.unranked.map((entry) => `${entry.pool}/${entry.model}`), ['codex/nova-9-preview']);

    const models = discovery.models.map((model) => ({
      ...model, tiers: [], effectiveTiers: model.tier ? [model.tier] : [], disabled: false,
    }));
    const inventory = {
      providers: [{ name: 'codex', enabled: true, usedPct: 10, models }],
      routes: {},
      recommendations: report.providerSuggestions,
      openRouter: { error: null },
    };
    const matrix = renderStrategyDashboard(inventory, {
      view: 'models', providerIndex: 0, modelIndex: 0, tierIndex: 0, search: '', width: 110, height: 30,
    });
    assert.match(matrix, /nova-9-preview \(unranked\)/);
    assert.doesNotMatch(matrix, /gpt-5\.6-luna \(unranked\)/);
    assert.ok(recommendationLines(inventory).includes('  unranked: 1 model · never recommended · strategy show --json lists them'));
  } finally { f.cleanup(); }
});

// --- newest-generation fallback, applied -------------------------------------

const CODEX_SIX = ['gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5'];

async function codexFallbackReport(dir, ids = CODEX_SIX) {
  const codex = loadConnectors(dir, { packaged: true }).codex;
  const discovery = await discoverConnectorModels(codex, {
    provider: { module: { discoverModels: async () => ({
      models: ids.map((id) => ({ id, reasoningLevels: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] })),
    }) } },
  });
  return buildStrategy({
    connectors: { codex },
    pools: [{ name: 'codex', connector: codex, enabled: true, pace: 0, costRank: 3, lanes: codex.lanes, capabilities: codex.capabilities }],
    state: {},
    discoveries: { codex: discovery },
  });
}

const medium = (rows) => rows.find((row) => row.pool === 'codex' && row.tier === 'medium');

test('apply writes the fallback reasoning into the codex medium rung, as set-rung --reasoning would', async () => {
  const f = fixture();
  try {
    const result = applyStrategyRecommendations(f.dir, await codexFallbackReport(f.dir));
    assert.deepEqual(result.reasoning.written, [{
      pool: 'codex', tier: 'medium', level: 'max', model: 'gpt-6-luna',
      why: 'no gpt-6 terra yet, newest generation preferred',
    }]);
    // No pin: the level lives on the rung, and routing still picks the pool.
    assert.deepEqual(loadState(f.dir).strategy.assignments, {});
    const row = medium(await rungRows(f.dir, { pool: 'codex' }));
    assert.equal(row.model, 'gpt-6-luna');
    assert.deepEqual(row.reasoning, {
      applied: 'max', source: 'recommendation', requested: 'max', clamped: false,
      why: 'no gpt-6 terra yet, newest generation preferred',
    });
    assert.match(renderRungs([row]), /codex {2}medium {2}gpt-6-luna {2}max \(recommendation\)/);

    // The report says why, in one line.
    const shown = await runStrategy(['show'], f.dir);
    assert.match(shown.out, /medium: codex\/gpt-6-luna · max reasoning \(best now; routing picks by spare quota\) — no gpt-6 terra yet, newest generation preferred/);
    assert.match(shown.out, /codex override: medium=max \(recommendation\)/);

    // A gpt-6 terra appears: the next apply takes medium back to terra and
    // removes the level it wrote, so the connector's medium default applies.
    const back = applyStrategyRecommendations(f.dir, await codexFallbackReport(f.dir, [...CODEX_SIX, 'gpt-6-terra']));
    assert.deepEqual(back.reasoning.cleared, [{ pool: 'codex', tier: 'medium', level: 'max', model: 'gpt-6-luna' }]);
    const terra = medium(await rungRows(f.dir, { pool: 'codex' }));
    assert.deepEqual([terra.model, terra.reasoning.applied, terra.reasoning.source], ['gpt-6-terra', 'medium', 'connector']);
  } finally { f.cleanup(); }
});

test('an explicit reasoning setting survives strategy apply', async () => {
  const f = fixture();
  try {
    assert.equal((await runStrategy(['set-rung', 'codex', 'medium', '--model', 'gpt-6-luna', '--reasoning', 'high', '--force'], f.dir)).code, 0);
    const result = applyStrategyRecommendations(f.dir, await codexFallbackReport(f.dir));
    assert.deepEqual(result.reasoning.written, []);
    assert.deepEqual(result.reasoning.kept, [{ pool: 'codex', tier: 'medium', level: 'high', source: 'strategy-pool' }]);
    const row = medium(await rungRows(f.dir, { pool: 'codex' }));
    assert.deepEqual([row.model, row.reasoning.applied, row.reasoning.source], ['gpt-6-luna', 'high', 'strategy-pool']);
    // Removing the level the recommendation did not write is not its job either.
    applyStrategyRecommendations(f.dir, await codexFallbackReport(f.dir, [...CODEX_SIX, 'gpt-6-terra']));
    assert.equal(loadState(f.dir).strategy.reasoning.pools.codex.medium, 'high');
  } finally { f.cleanup(); }
});

test('the setup review screen shows the fallback model, its reasoning, and why', async () => {
  const f = fixture();
  try {
    const report = await codexFallbackReport(f.dir);
    const inventory = {
      providers: [{ name: 'codex', enabled: true, usedPct: 10, models: [] }],
      routes: {},
      recommendations: report.providerSuggestions,
      openRouter: { error: null },
    };
    const lines = recommendationLines(inventory);
    const at = lines.indexOf('  M  gpt-6-luna · max reasoning');
    assert.ok(at > 0, lines.join('\n'));
    assert.equal(lines[at + 1], '     no gpt-6 terra yet, newest generation preferred');
    assert.ok(lines.includes('  L  gpt-6-luna'), 'low is not a fallback and carries no level');
  } finally { f.cleanup(); }
});

// --- Grok's one model line, applied ---------------------------------------------

const GROK_LISTED = 'Available models:\n  * grok-4.7 (default)\n  - grok-4.7-build-fast\n  - grok-4.6\n  - grok-4.5\n';
const GROK_WHY = 'one Grok line, lighter reasoning for lighter tiers';

async function grokAndCodexReport(dir) {
  const { codex, grok } = loadConnectors(dir, { packaged: true });
  const pool = (connector) => ({
    name: connector.name, connector, enabled: true, pace: 0, costRank: connector.costRank,
    lanes: connector.lanes, capabilities: connector.capabilities,
  });
  return buildStrategy({
    connectors: { codex, grok },
    pools: [pool(codex), pool(grok)],
    state: {},
    discoveries: {
      codex: (await codexFallbackReport(dir)).discoveries.codex,
      grok: await discoverConnectorModels(grok, { executor: async () => GROK_LISTED }),
    },
  });
}

test('apply gives every grok rung grok-4.7, with medium and low at the tier\'s lighter reasoning', async () => {
  const f = fixture();
  try {
    // Enable grok explicitly, as fixture() does for codex: setup only enables
    // it on a host where the grok CLI happens to be installed.
    const state = loadState(f.dir);
    state.pools.grok ??= {};
    state.pools.grok.enabled = true;
    saveState(f.dir, state);
    const result = applyStrategyRecommendations(f.dir, await grokAndCodexReport(f.dir));
    assert.deepEqual(result.rungs.grok, { high: 'grok-4.7', medium: 'grok-4.7', low: 'grok-4.7' });
    assert.deepEqual(result.reasoning.written.filter((entry) => entry.pool === 'grok'), [
      { pool: 'grok', tier: 'medium', level: 'high', model: 'grok-4.7', why: GROK_WHY },
      { pool: 'grok', tier: 'low', level: 'medium', model: 'grok-4.7', why: GROK_WHY },
    ]);
    assert.deepEqual(loadState(f.dir).strategy.assignments, {});
    const rows = (await rungRows(f.dir, { pool: 'grok' })).map((row) => [row.tier, row.model, row.reasoning.applied, row.reasoning.source]);
    assert.deepEqual(rows, [
      ['high', 'grok-4.7', 'xhigh', 'connector'],
      ['medium', 'grok-4.7', 'high', 'recommendation'],
      ['low', 'grok-4.7', 'medium', 'recommendation'],
    ]);
    // Best now stays with Codex; Grok's own rung is named under each tier.
    const shown = await runStrategy(['show'], f.dir);
    assert.match(shown.out, /medium: codex\/gpt-6-luna · max reasoning \(best now; routing picks by spare quota\)/);
    assert.match(shown.out, /^ {4}grok rung: grok-4\.7 · high reasoning — one Grok line, lighter reasoning for lighter tiers$/m);
    assert.match(shown.out, /^ {4}grok rung: grok-4\.7 · medium reasoning — one Grok line, lighter reasoning for lighter tiers$/m);
    assert.doesNotMatch(shown.out, /build-fast/);
    assert.doesNotMatch(shown.out, /^unranked:/m);
  } finally { f.cleanup(); }
});

test('raw terminal input preserves arrows and splits batched search typing', () => {
  assert.deepEqual(inputKeys(`opus\x1b[C\r`), ['o', 'p', 'u', 's', '\x1b[C', '\r']);
});

// --- reasoning depth ---------------------------------------------------------
// Reasoning is the second dimension of a dispatch: the effort tier picks WHICH
// model, reasoning picks HOW DEEPLY it thinks. Every mutation is agent-facing
// (no TUI) and, like the other routing mutations, requires --yes.

function reasoningPool(name, block, extra = {}) {
  const connector = {
    name,
    modelSelection: { flag: '--model' },
    lanes: ['analyze', 'build', 'chore'],
    capabilities: ['strong-analysis', 'workflow-planning', 'code-reading', 'file-editing'],
    modelProfiles: [{ match: 'smart', tier: 'high', qualityRank: 5 }],
    ...(block ? { reasoning: block } : {}),
  };
  return {
    name, connector, enabled: true, lanes: connector.lanes,
    capabilities: connector.capabilities, pace: 0, usedPct: 0, ...extra,
  };
}

test('set-reasoning persists tier and pool levels, and reset-reasoning removes them', async () => {
  const f = fixture();
  const originalLog = console.log;
  console.log = () => {};
  try {
    const run = (args) => cmdStrategy(args, { bullswarmDir: f.dir });
    assert.equal(await run(['set-reasoning', '--tier', 'high', '--level', 'xhigh', '--yes']), 0);
    assert.equal(await run(['set-reasoning', '--tier', 'low', '--level', 'default', '--yes']), 0);
    assert.equal(await run(['set-reasoning', '--tier', 'high', '--level', 'high', '--pool', 'codex', '--yes']), 0);
    assert.deepEqual(loadState(f.dir).strategy.reasoning, {
      tiers: { high: 'xhigh', low: 'default' },
      pools: { codex: { high: 'high' } },
    });

    assert.equal(await run(['reset-reasoning', '--pool', 'codex', '--yes']), 0);
    assert.deepEqual(loadState(f.dir).strategy.reasoning.pools, {});

    assert.equal(await run(['reset-reasoning', '--tier', 'high', '--yes']), 0);
    assert.deepEqual(loadState(f.dir).strategy.reasoning, { tiers: { low: 'default' }, pools: {} });

    assert.equal(await run(['reset-reasoning', '--yes']), 0);
    assert.equal(loadState(f.dir).strategy.reasoning, undefined);
  } finally { console.log = originalLog; f.cleanup(); }
});

test('a tier reset also clears that tier from every per-pool reasoning override', async () => {
  const f = fixture();
  const originalLog = console.log;
  console.log = () => {};
  try {
    const run = (args) => cmdStrategy(args, { bullswarmDir: f.dir });
    assert.equal(await run(['set-reasoning', '--tier', 'high', '--level', 'max', '--pool', 'codex', '--yes']), 0);
    assert.equal(await run(['set-reasoning', '--tier', 'low', '--level', 'low', '--pool', 'codex', '--yes']), 0);
    assert.equal(await run(['reset-reasoning', '--tier', 'high', '--yes']), 0);
    assert.deepEqual(loadState(f.dir).strategy.reasoning.pools, { codex: { low: 'low' } });
  } finally { console.log = originalLog; f.cleanup(); }
});

test('reasoning argument errors exit 2 and never write a partial policy', async () => {
  const f = fixture();
  const originalError = console.error;
  console.error = () => {};
  try {
    const run = (args) => cmdStrategy(args, { bullswarmDir: f.dir });
    assert.equal(await run(['set-reasoning', '--tier', 'high', '--level', 'xhigh']), 2, '--yes is required');
    assert.equal(await run(['set-reasoning', '--tier', 'huge', '--level', 'xhigh', '--yes']), 2);
    assert.equal(await run(['set-reasoning', '--tier', 'high', '--level', 'extreme', '--yes']), 2);
    assert.equal(await run(['set-reasoning', '--level', 'xhigh', '--yes']), 2, '--tier is required');
    assert.equal(await run(['set-reasoning', '--tier', 'high', '--yes']), 2, '--level is required');
    assert.equal(await run(['set-reasoning', '--tier', 'high', '--level', 'xhigh', '--pool', 'missing-pool', '--yes']), 2);
    assert.equal(await run(['reset-reasoning', '--tier', 'huge', '--yes']), 2);
    assert.equal(await run(['reset-reasoning', '--pool', 'missing-pool', '--yes']), 2);
    assert.equal(await run(['reset-reasoning']), 2, '--yes is required');
    assert.equal(loadState(f.dir).strategy?.reasoning, undefined);
  } finally { console.error = originalError; f.cleanup(); }
});

test('strategy configure applies a reasoning section atomically with the rest', async () => {
  const f = fixture();
  const originalLog = console.log;
  const originalError = console.error;
  console.log = () => {};
  console.error = () => {};
  try {
    // Seed a report so configure reads the cached inventory instead of
    // executing every installed agent CLI's discovery command.
    const seeded = loadState(f.dir);
    seeded.strategy = {
      lastReport: {
        capturedAt: new Date().toISOString(), subscriptions: [], suggestions: {},
        discoveries: { codex: { models: [{ id: 'gpt-5.6-sol', tier: 'high', qualityRank: 6 }] } },
      },
    };
    saveState(f.dir, seeded);
    const file = join(f.dir, 'strategy.json');

    // One bad level rejects the whole document: the provider toggle in the
    // same file must not survive either.
    writeFileSync(file, JSON.stringify({
      providers: { codex: false },
      reasoning: { tiers: { high: 'xhigh' }, pools: { codex: { low: 'ludicrous' } } },
    }));
    assert.equal(await cmdStrategy(['configure', '--file', file, '--yes'], { bullswarmDir: f.dir }), 2);
    let state = loadState(f.dir);
    assert.equal(state.strategy.reasoning, undefined, 'nothing written');
    assert.equal(state.pools.codex.enabled, true, 'the provider toggle was not applied either');

    writeFileSync(file, JSON.stringify({
      reasoning: { tiers: { high: 'xhigh', medium: 'default' }, pools: { codex: { low: 'high' } } },
    }));
    assert.equal(await cmdStrategy(['configure', '--file', file, '--yes'], { bullswarmDir: f.dir }), 0);
    assert.deepEqual(loadState(f.dir).strategy.reasoning, {
      tiers: { high: 'xhigh', medium: 'default' },
      pools: { codex: { low: 'high' } },
    });

    // null removes one level without disturbing the others.
    writeFileSync(file, JSON.stringify({ reasoning: { tiers: { high: null } } }));
    assert.equal(await cmdStrategy(['configure', '--file', file, '--yes'], { bullswarmDir: f.dir }), 0);
    state = loadState(f.dir);
    assert.deepEqual(state.strategy.reasoning.tiers, { medium: 'default' });
    assert.deepEqual(state.strategy.reasoning.pools, { codex: { low: 'high' } });

    writeFileSync(file, JSON.stringify({ reasoning: { pools: { 'missing-pool': { low: 'high' } } } }));
    assert.equal(await cmdStrategy(['configure', '--file', file, '--yes'], { bullswarmDir: f.dir }), 2);
  } finally { console.log = originalLog; console.error = originalError; f.cleanup(); }
});

test('inventory reports configured reasoning plus the effective level and source per pool', () => {
  const pools = [
    reasoningPool('deep', {
      flag: '--effort',
      levels: ['low', 'medium', 'high', 'xhigh', 'max'],
      defaults: { high: 'xhigh', medium: 'high', low: 'medium' },
    }, { pace: 12 }),
    reasoningPool('narrow', {
      args: ['-c', 'model_reasoning_effort={level}'],
      levels: ['low', 'medium', 'high'],
      defaults: { high: 'high', medium: 'medium', low: 'low' },
    }),
    reasoningPool('flat', null),
  ];
  const state = { strategy: { reasoning: { tiers: { medium: 'max' }, pools: { deep: { high: 'low' } } } } };
  const report = {
    capturedAt: new Date().toISOString(),
    discoveries: {},
    suggestions: { high: { requirements: { lane: 'analyze', capabilities: ['strong-analysis', 'workflow-planning'] } } },
  };
  const inventory = strategyInventory({ pools, state, report });

  assert.deepEqual(inventory.reasoning.tiers, { medium: 'max' });
  assert.deepEqual(inventory.reasoning.pools, { deep: { high: 'low' } });
  // Per-pool override beats the tier default, which beats the connector default.
  assert.deepEqual(inventory.reasoning.effective.deep, {
    high: { level: 'low', source: 'strategy-pool' },
    medium: { level: 'max', source: 'strategy-tier' },
    low: { level: 'medium', source: 'connector' },
  });
  // A CLI that stops at "high" is clamped down to it, never sent "max".
  assert.deepEqual(inventory.reasoning.effective.narrow.medium, { level: 'high', source: 'strategy-tier' });
  assert.deepEqual(inventory.reasoning.effective.narrow.low, { level: 'low', source: 'connector' });
  // A connector with no reasoning block reports no level at all.
  assert.deepEqual(inventory.reasoning.effective.flat, {
    high: { level: null, source: 'unsupported' },
    medium: { level: null, source: 'unsupported' },
    low: { level: null, source: 'unsupported' },
  });

  // The routed pool carries the depth it would actually be dispatched with.
  assert.equal(inventory.routes.high.pool, 'deep');
  assert.deepEqual(inventory.routes.high.reasoning, { level: 'low', source: 'strategy-pool' });
  const screen = renderStrategyDashboard(inventory, { width: 100, height: 30 });
  assert.match(screen, /High\s+analyze\s+→ deep\/.*· reasoning low/);
});

test('a pool with no reasoning support adds no reasoning note to the dashboard route', () => {
  const inventory = strategyInventory({
    pools: [reasoningPool('flat', null, { pace: 3 })],
    state: {},
    report: {
      capturedAt: new Date().toISOString(), discoveries: {},
      suggestions: { high: { requirements: { lane: 'analyze', capabilities: ['strong-analysis', 'workflow-planning'] } } },
    },
  });
  assert.deepEqual(inventory.routes.high.reasoning, { level: null, source: 'unsupported' });
  assert.doesNotMatch(renderStrategyDashboard(inventory, { width: 100, height: 30 }), /reasoning/);
});

// --- rungs -------------------------------------------------------------------
// One read/write view over a pool's model plus reasoning level for one effort
// tier. Everything below runs against a temporary home and two fixture
// connectors; no real provider CLI is ever consulted or dispatched.

function rungFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'bullswarm-rungs-'));
  autoSetup(dir, { reason: 'test' });
  // A discovery command that leaves a marker when it runs, so "never spawns
  // model discovery" is an observed fact rather than a claim.
  writeFileSync(join(dir, 'list-models.mjs'), [
    "import { writeFileSync } from 'node:fs';",
    "writeFileSync(new URL('./discovery-ran', import.meta.url), 'ran');",
    "console.log('deep-1');",
    '',
  ].join('\n'));
  writeFileSync(join(dir, 'connectors', 'deep.json'), `${JSON.stringify({
    name: 'deep',
    bin: 'node',
    configDirs: [],
    spawn: {
      cmd: ['node', '{bullswarmDir}/src/providers/echo/echo-worker.mjs', '{taskFile}'],
      cwdMode: 'task-file-dir',
    },
    outputExtraction: { strategy: 'stdout' },
    meter: { type: 'none' },
    costRank: 5,
    lanes: ['analyze', 'build', 'chore'],
    capabilities: ['strong-analysis', 'code-reading', 'file-editing', 'workflow-planning'],
    model: 'deep-1',
    knownModels: ['deep-1', 'deep-2'],
    modelSelection: { flag: '--model' },
    modelDiscovery: { cmd: ['node', join(dir, 'list-models.mjs')], parse: 'lines' },
    reasoning: { flag: '--effort', levels: ['low', 'high'], defaults: { high: 'high' } },
    modelProfiles: [
      { id: 'deep-1', tier: 'high', qualityRank: 3 },
      { id: 'deep-2', tier: 'medium', qualityRank: 1 },
    ],
    flags: { stealth: false, testFixture: true },
  }, null, 2)}\n`);
  const state = loadState(dir);
  state.pools.deep = { enabled: true };
  state.strategy = {
    configuredTiers: ['high', 'medium'],
    modelTiers: { deep: { 'deep-1': ['high'], 'deep-2': ['medium'] } },
    // A cached discovery report, exactly as `strategy refresh` persists one.
    lastReport: { discoveries: { deep: { models: [{ id: 'deep-1' }, { id: 'deep-2' }] } } },
  };
  state.decisionLog = [
    { ts: '2026-09-08T01:00:00Z', picked: 'deep', ok: true, wallSec: 300, routing: { effort: 'high' } },
    { ts: '2026-09-08T02:00:00Z', picked: 'deep', ok: true, wallSec: 420, routing: { effort: 'high' } },
    { ts: '2026-09-08T03:00:00Z', picked: 'deep', ok: false, wallSec: 600, routing: { effort: 'high' } },
  ];
  saveState(dir, state);
  return {
    dir,
    marker: join(dir, 'discovery-ran'),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
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

test('strategy rungs prints the model, reasoning, evidence, and local record of every rung', async () => {
  const f = rungFixture();
  try {
    const table = await runStrategy(['rungs', '--pool', 'deep'], f.dir);
    assert.equal(table.code, 0);
    assert.deepEqual(table.out.split('\n'), [
      'pool  tier    model   reasoning         evidence     record',
      'deep  high    deep-1  high (connector)  no evidence  3 dispatches · p50 7m · 67% ok',
      'deep  medium  deep-2  — (none)          no evidence  no dispatches',
    ]);

    const json = await runStrategy(['rungs', '--json', '--pool', 'deep'], f.dir);
    assert.equal(json.code, 0);
    const parsed = JSON.parse(json.out);
    assert.equal(parsed.schemaVersion, 'bullswarm.strategy.rungs.v1');
    assert.deepEqual(parsed.rungs.map((row) => [row.pool, row.tier, row.model]), [
      ['deep', 'high', 'deep-1'],
      ['deep', 'medium', 'deep-2'],
    ]);
    // No datapack is installed in this tree, so evidence is honestly absent.
    assert.deepEqual(parsed.rungs.map((row) => row.evidence), [null, null]);
    assert.deepEqual(parsed.rungs[0].record, { dispatches: 3, medianMinutes: 7, okShare: 0.667 });
    assert.equal(parsed.rungs[1].record, null);

    const unknown = await runStrategy(['rungs', '--pool', 'nope'], f.dir);
    assert.equal(unknown.code, 2);
    assert.match(unknown.err, /unknown pool "nope"/);
  } finally { f.cleanup(); }
});

test('strategy set-rung writes the model and the reasoning level in one save, clamping what the CLI cannot express', async () => {
  const f = rungFixture();
  try {
    const result = await runStrategy([
      'set-rung', 'deep', 'medium', '--model', 'deep-1', '--reasoning', 'max',
    ], f.dir);
    assert.equal(result.code, 0);
    const payload = JSON.parse(result.out);
    assert.equal(payload.action, 'rung-set');
    // deep declares only low and high, so max is clamped down and said so.
    assert.deepEqual(payload.reasoning, {
      requested: 'max', applied: 'high', source: 'strategy-pool', clamped: true,
    });
    assert.ok(payload.notes.some((note) => /cannot set max; clamped to high/.test(note)), payload.notes.join('|'));

    const state = loadState(f.dir);
    // One rung per pool and tier: medium moved off deep-2 onto deep-1, and
    // deep-1 kept the high tier it already held. Both halves in one save.
    assert.deepEqual(state.strategy.modelTiers.deep, { 'deep-1': ['high', 'medium'] });
    assert.deepEqual(state.strategy.reasoning, { tiers: {}, pools: { deep: { medium: 'max' } } });
    // Nothing outside the two rung halves was migrated or dropped.
    assert.deepEqual(state.strategy.configuredTiers, ['high', 'medium']);
    assert.ok(state.strategy.lastReport, 'the cached discovery report survives a rung write');

    const rungs = await rungRows(f.dir, { pool: 'deep' });
    assert.equal(rungs[1].model, 'deep-1');
    assert.equal(rungs[1].reasoning.applied, 'high');
    assert.equal(rungs[1].reasoning.clamped, true);
  } finally { f.cleanup(); }
});

test('strategy set-rung exits 2 on an unknown pool, tier, model, or level', async () => {
  const f = rungFixture();
  try {
    const pool = await runStrategy(['set-rung', 'nope', 'high', '--model', 'deep-1'], f.dir);
    assert.equal(pool.code, 2);
    assert.match(pool.err, /unknown pool "nope"/);

    const tier = await runStrategy(['set-rung', 'deep', 'enormous', '--model', 'deep-1'], f.dir);
    assert.equal(tier.code, 2);
    assert.match(tier.err, /unknown tier "enormous" \(high, medium, low\)/);

    const model = await runStrategy(['set-rung', 'deep', 'high', '--model', 'deep-9'], f.dir);
    assert.equal(model.code, 2);
    // The known models are listed, so the next attempt is a copy-paste away.
    assert.match(model.err, /unknown model "deep-9" for pool "deep" — cached discovery knows deep-1, deep-2/);
    assert.match(model.err, /--force/);

    const level = await runStrategy([
      'set-rung', 'deep', 'high', '--model', 'deep-1', '--reasoning', 'ludicrous',
    ], f.dir);
    assert.equal(level.code, 2);
    assert.match(level.err, /--reasoning must be low, medium, high, xhigh, max, default/);

    const missing = await runStrategy(['set-rung', 'deep', 'high'], f.dir);
    assert.equal(missing.code, 2);

    // None of the four rejections wrote anything.
    assert.deepEqual(loadState(f.dir).strategy.modelTiers.deep, { 'deep-1': ['high'], 'deep-2': ['medium'] });
    assert.equal(loadState(f.dir).strategy.reasoning, undefined);

    const forced = await runStrategy(['set-rung', 'deep', 'high', '--model', 'deep-9', '--force'], f.dir);
    assert.equal(forced.code, 0);
    assert.deepEqual(loadState(f.dir).strategy.modelTiers.deep['deep-9'], ['high']);
    assert.ok(JSON.parse(forced.out).notes.some((note) => /not in the cached discovery/.test(note)));
  } finally { f.cleanup(); }
});

test('neither strategy rungs nor set-rung spawns model discovery', async () => {
  const f = rungFixture();
  try {
    assert.equal(existsSync(f.marker), false);
    assert.equal((await runStrategy(['rungs'], f.dir)).code, 0);
    assert.equal(existsSync(f.marker), false, 'strategy rungs ran the connector discovery command');
    assert.equal((await runStrategy([
      'set-rung', 'deep', 'high', '--model', 'deep-2', '--reasoning', 'low',
    ], f.dir)).code, 0);
    assert.equal(existsSync(f.marker), false, 'strategy set-rung ran the connector discovery command');

    // Positive control: the discovery path really does leave the marker, so
    // its absence above means something. Only the fixture's own command is
    // run — a full refresh would execute every installed provider CLI.
    const discovered = await discoverConnectorModels(loadConnectors(f.dir).deep);
    assert.equal(discovered.source, 'cli');
    assert.equal(existsSync(f.marker), true, 'the marker mechanism itself is broken');
  } finally { f.cleanup(); }
});

test('strategy inventory --json carries the same rungs rows', async () => {
  const f = rungFixture();
  try {
    await refreshStrategy(f.dir, { executor: () => '', getReadings: async () => ({}) });
    const result = await runStrategy(['inventory', '--json'], f.dir);
    assert.equal(result.code, 0);
    const inventory = JSON.parse(result.out);
    const mine = inventory.rungs.filter((row) => row.pool === 'deep');
    assert.deepEqual(mine.map((row) => [row.tier, row.model]), [['high', 'deep-1'], ['medium', 'deep-2']]);
    assert.deepEqual(mine[0].record, { dispatches: 3, medianMinutes: 7, okShare: 0.667 });
    assert.deepEqual(await rungRows(f.dir, { pool: 'deep' }), mine);
  } finally { f.cleanup(); }
});

test('a rung whose model the bundled Epoch datapack covers carries the real evidence line', async () => {
  const datapack = await loadEpochBenchmarks({ fetchImpl: null });
  const levels = ['low', 'medium', 'high', 'xhigh', 'max'];
  const covered = (datapack?.records ?? []).find((record) => levels.includes(record.reasoningLevel)
    && rungEvidence(datapack, { model: record.model, reasoning: record.reasoningLevel }));
  if (!covered) return;
  const expected = rungEvidence(datapack, { model: covered.model, reasoning: covered.reasoningLevel });

  const f = rungFixture();
  try {
    // A fixture connector that declares a benchmarked model id and exactly the
    // reasoning level that model was measured at. Never spawned or dispatched.
    writeFileSync(join(f.dir, 'connectors', 'deep.json'), `${JSON.stringify({
      name: 'deep',
      bin: 'node',
      lanes: ['analyze', 'build', 'chore'],
      capabilities: ['strong-analysis', 'code-reading', 'file-editing', 'workflow-planning'],
      meter: { type: 'none' },
      model: covered.model,
      knownModels: [covered.model],
      modelSelection: { flag: '--model' },
      reasoning: {
        flag: '--effort',
        levels: [covered.reasoningLevel],
        defaults: { high: covered.reasoningLevel },
      },
      modelProfiles: [{ id: covered.model, tier: 'high', qualityRank: 3 }],
      flags: { stealth: false, testFixture: true },
    }, null, 2)}\n`);
    const state = loadState(f.dir);
    state.strategy.modelTiers = { deep: { [covered.model]: ['high'] } };
    saveState(f.dir, state);

    const [row] = await rungRows(f.dir, { pool: 'deep' });
    assert.equal(row.model, covered.model);
    assert.equal(row.reasoning.applied, covered.reasoningLevel);
    assert.deepEqual(row.evidence, {
      blended: expected.blended,
      costPerTask: expected.costPerTask,
      tokensPerTask: expected.tokensPerTask,
    });
    const printed = renderRungs([row]).split('\n')[1];
    assert.ok(
      printed.includes(`blended ${Math.round(expected.blended * 1000) / 1000}`),
      `evidence line missing from ${printed}`,
    );
  } finally { f.cleanup(); }
});

test('an empty rung table says what to configure instead of printing nothing', () => {
  assert.match(renderRungs([]), /^no rungs yet: enable a provider pool and configure an effort tier/);
});

test('--resets-at declares the reset a provider does not report, as ISO-8601, and refuses junk', async () => {
  const f = fixture();
  const originalLog = console.log;
  const originalError = console.error;
  console.log = () => {};
  console.error = () => {};
  try {
    const run = (args) => cmdStrategy(args, { bullswarmDir: f.dir });
    assert.equal(await run(['set-subscription', 'command-code', '--resets-at', '2026-09-17T01:46:01Z']), 0);
    assert.equal(loadState(f.dir).strategy.subscriptions['command-code'].resetsAt, '2026-09-17T01:46:01.000Z');

    // Not a date: refused, and the stored value is untouched.
    assert.equal(await run(['set-subscription', 'command-code', '--resets-at', 'next tuesday']), 2);
    assert.equal(loadState(f.dir).strategy.subscriptions['command-code'].resetsAt, '2026-09-17T01:46:01.000Z');

    // Other fields on the same subscription survive a reset-only update.
    assert.equal(await run(['set-subscription', 'command-code', '--quota-window', 'monthly']), 0);
    assert.equal(loadState(f.dir).strategy.subscriptions['command-code'].resetsAt, '2026-09-17T01:46:01.000Z');

    // `unknown` clears it.
    assert.equal(await run(['set-subscription', 'command-code', '--resets-at', 'unknown']), 0);
    assert.equal(loadState(f.dir).strategy.subscriptions['command-code'].resetsAt, null);
  } finally {
    console.log = originalLog;
    console.error = originalError;
    f.cleanup();
  }
});
