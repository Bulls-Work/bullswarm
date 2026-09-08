import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { autoSetup } from '../src/setup.js';
import { loadState, saveState } from '../src/lib/state.js';
import {
  refreshStrategy, cmdStrategy, applyStrategyRecommendations, maybeRefreshStrategy, strategyInventory,
} from '../src/strategy-cli.js';
import {
  inputKeys, recommendationLines, renderAnalysisProgress, renderRecommendationReview,
  renderSetupChoice, renderStrategyDashboard, visibleModels,
} from '../src/strategy-dashboard.js';

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
