import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { autoSetup } from '../src/setup.js';
import { discoverConnectorModels } from '../src/lib/strategy.js';
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

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'bullswarm-strategy-cli-'));
  autoSetup(dir, { reason: 'test' });
  // Strategy tests must not depend on whichever agent CLIs happen to be on
  // the host PATH. Enable one real packaged connector without dispatching it.
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
    assert.deepEqual(state.strategy.assignments.low, {
      pool: 'command-code', model: 'gpt-5.6-luna',
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

test('recommended assignments require an explicit apply and persist an auto-refresh policy', async () => {
  const f = fixture();
  try {
    const report = await refreshStrategy(f.dir, {
      executor: () => '',
      getReadings: async () => ({}),
    });
    assert.deepEqual(loadState(f.dir).strategy.assignments ?? {}, {});
    const result = applyStrategyRecommendations(f.dir, report, { refreshHours: 12 });
    assert.ok(Object.keys(result.applied).length > 0);
    const state = loadState(f.dir);
    assert.deepEqual(state.strategy.assignments, result.applied);
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
  assert.match(screen, /Effective choices now/);
  assert.match(screen, /worker\/smart/);
  assert.match(screen, /Finish setup/);
});

test('strategy setup sorts providers and hides disabled test fixtures', () => {
  const pool = (name, extra = {}) => ({
    name, connector: { name, lanes: [], capabilities: [] }, enabled: true,
    lanes: [], capabilities: [], pace: 0, ...extra,
  });
  const inventory = strategyInventory({
    pools: [
      pool('opencode2:relay-2'),
      pool('echo', { enabled: false, testFixture: true }),
      pool('claude-code:wati'),
      pool('claude-code'),
    ],
    state: {},
    report: { capturedAt: new Date().toISOString(), discoveries: {}, suggestions: {} },
  });
  assert.deepEqual(inventory.providers.map((provider) => provider.name), [
    'claude-code', 'claude-code:wati', 'opencode2:relay-2',
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
      cmd: ['node', '{bullswarmDir}/connectors/echo-worker.mjs', '{taskFile}'],
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
    const discovered = discoverConnectorModels(loadConnectors(f.dir).deep);
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
