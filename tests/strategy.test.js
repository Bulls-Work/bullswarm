import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  parseDiscoveredModels, discoverConnectorModels, discoverAllModels, buildStrategy, resolveDispatchModel,
  selectedModelsForTier, setModelTierSelection,
  rungsFor, setRung, rungRecord, formatRungEvidence,
  TIER_LANES, TIER_CONTEXTS, clearTierAssignment, STRATEGY_TIERS,
  applyRecommendedReasoning, getRecommendedReasoning, setStrategyReasoning, clearStrategyReasoning,
} from '../src/lib/strategy.js';
import { resolveReasoningLevel } from '../src/lib/reasoning.js';
import { DEFAULT_EFFORT_BY_LANE, KIND_DEFAULTS } from '../src/workflow/action-validator.js';

test('connector-declared parsing handles columns, bullets, and plain lines', () => {
  assert.deepEqual(parseDiscoveredModels('Header\nfoo/bar  description\ngpt-5  text\n', {
    parse: 'columns', ignorePattern: '^Header$',
  }), ['foo/bar', 'gpt-5']);
  assert.deepEqual(parseDiscoveredModels('Meta\nmeta/muse-spark-1.3  multimodal\nGoogle\ngoogle/gemini-3.8-flash  fast\n', {
    parse: 'columns', ignorePattern: '^(Available|Open Source$|Anthropic$|OpenAI$|Google$|Sakana$|Meta$|xAI$|Pass|cmd|Docs)',
  }), ['meta/muse-spark-1.3', 'google/gemini-3.8-flash']);
  assert.deepEqual(parseDiscoveredModels('* grok-4.6 (default)\n- grok-4.5\nnoise', {
    parse: 'bullets',
  }), ['grok-4.6', 'grok-4.5']);
  assert.deepEqual(parseDiscoveredModels('one/model\ntwo/model\n', { parse: 'lines' }), ['one/model', 'two/model']);
});

test('model discovery uses live models without merging last-resort fallbacks', async () => {
  const connector = {
    name: 'fixture',
    model: 'configured-model',
    modelDiscovery: { cmd: ['fixture', 'models'], parse: 'lines' },
    knownModels: ['fallback-model'],
    modelProfiles: [{ match: 'live-model', tier: 'high', qualityRank: 5, autoRecommend: false }],
  };
  const result = await discoverConnectorModels(connector, {
    executor: () => 'live-model\n',
  });
  assert.equal(result.source, 'cli');
  assert.deepEqual(result.models.map((m) => m.id), ['live-model']);
  assert.equal(result.models[0].tier, 'high');
  assert.equal(result.models[0].autoRecommend, false);
});

test('command-code profiles deepseek-v4.1-flash specifically; v4-flash stays on the generic flash catch-all', async () => {
  // modelProfile (src/lib/usage.js) walks modelProfiles in order and returns
  // the first regex match, so the v4.1 entry must sit before the generic
  // `(?:flash|...|luna|free)` catch-all or it would inherit qualityRank 2
  // and no pricing.
  const commandCode = JSON.parse(readFileSync(new URL('../providers/contrib/command-code/connector.json', import.meta.url), 'utf8'));
  const result = await discoverConnectorModels(commandCode, {
    executor: () => [
      'deepseek/deepseek-v4.1-flash   V4.1 hybrid-attention reasoning with vision',
      'deepseek/deepseek-v4-flash   predecessor flash',
    ].join('\n'),
  });
  const v41 = result.models.find((m) => m.id === 'deepseek/deepseek-v4.1-flash');
  const v4 = result.models.find((m) => m.id === 'deepseek/deepseek-v4-flash');
  // Same tier and rank as the generic catch-all: the entry adds pricing, not a recommendation.
  assert.equal(v41.tier, 'low');
  assert.equal(v41.qualityRank, 2);
  assert.deepEqual(v41.pricing, {
    inputUsdPerMillion: 0.15,
    cacheReadUsdPerMillion: 0.003,
    outputUsdPerMillion: 0.6,
  });
  assert.equal(v41.pricingSource, 'https://commandcode.ai/docs/resources/pricing-limits');
  assert.equal(v41.pricingUpdatedAt, '2026-09-11');
  assert.equal(v4.tier, 'low');
  assert.equal(v4.qualityRank, 2);
  assert.equal(v4.pricing, null);
});

test('model discovery executes an identical provider command only once across account clones', async () => {
  let calls = 0;
  const connector = (name) => ({ name, modelDiscovery: { cmd: ['agent', 'models'] } });
  const result = await discoverAllModels({ a: connector('a'), b: connector('b') }, {
    executor: () => { calls += 1; return 'provider/model\n'; },
  });
  assert.equal(calls, 1);
  assert.deepEqual(result.a.models.map((model) => model.id), ['provider/model']);
  assert.deepEqual(result.b.models.map((model) => model.id), ['provider/model']);
});

test('a slow list command does not freeze the event loop while other providers handshake', async () => {
  // A command-based connector whose list command takes 800 ms, next to a
  // provider whose own discovery races a 300 ms timer. With a synchronous
  // executor the timer would fire late, after the slow command returned.
  const slow = {
    name: 'slow',
    modelDiscovery: { cmd: [process.execPath, '-e', 'setTimeout(() => console.log("vendor/slow-model"), 800)'] },
  };
  const handshake = {
    name: 'handshake',
    knownModels: ['fallback-model'],
  };
  let timerLateMs = null;
  const provider = {
    pools: ['handshake'],
    module: {
      discoverModels: () => new Promise((resolve) => {
        const started = Date.now();
        setTimeout(() => {
          timerLateMs = Date.now() - started - 300;
          resolve({ models: [{ id: 'live-model' }] });
        }, 300);
      }),
    },
  };
  const result = await discoverAllModels({ slow, handshake }, { providers: [provider] });
  assert.deepEqual(result.slow.models.map((model) => model.id), ['vendor/slow-model']);
  assert.deepEqual(result.handshake.models.map((model) => model.id), ['live-model']);
  assert.ok(timerLateMs < 400, `the handshake timer fired ${timerLateMs} ms late`);
});

test('strategy keeps unknown subscription values null and ranks each tier deterministically', () => {
  const connector = {
    name: 'a', meter: { window: 'weekly' },
    lanes: ['analyze', 'build', 'chore'],
    capabilities: ['strong-analysis', 'workflow-planning', 'code-reading', 'file-editing'],
  };
  const pools = [{ name: 'a', connector, enabled: true, pace: 20, costRank: 2, meterSource: 'cache' }];
  const discoveries = { a: { models: [
    { id: 'pro', tier: 'high', qualityRank: 5, free: false },
    { id: 'cheap', tier: 'low', qualityRank: 2, free: true },
  ] } };
  const result = buildStrategy({ connectors: { a: connector }, pools, state: {}, discoveries });
  assert.equal(result.subscriptions[0].includedValueUsd, null);
  assert.deepEqual(result.suggestions.high.recommended, { pool: 'a', model: 'pro' });
  assert.deepEqual(result.suggestions.low.recommended, { pool: 'a', model: 'cheap' });
  assert.equal(result.suggestions.medium.recommended, null);
});

test('dated connector benchmark scores break ties only between models of equal quality rank', () => {
  const capable = {
    lanes: ['analyze'], capabilities: ['strong-analysis', 'workflow-planning'],
  };
  const connectors = { a: { name: 'a', ...capable }, b: { name: 'b', ...capable } };
  const pools = [
    { name: 'a', connector: connectors.a, enabled: true, costRank: 1, pace: 0 },
    { name: 'b', connector: connectors.b, enabled: true, costRank: 1, pace: 0 },
  ];
  const model = (id, qualityRank, score) => ({
    id, tier: 'high', qualityRank, benchmarkScore: score, benchmark: { score, source: `dated-${id}` },
  });
  // Equal rank: the higher dated score wins the tie.
  const tie = buildStrategy({
    connectors, pools, state: {},
    discoveries: { a: { models: [model('a1', 5, 40)] }, b: { models: [model('b1', 5, 60)] } },
  });
  assert.deepEqual(tie.suggestions.high.recommended, { pool: 'b', model: 'b1' });
  // Different rank: the score is never weighed against the rank.
  const ranked = buildStrategy({
    connectors, pools, state: {},
    discoveries: { a: { models: [model('a1', 6, 40)] }, b: { models: [model('b1', 5, 60)] } },
  });
  assert.deepEqual(ranked.suggestions.high.recommended, { pool: 'a', model: 'a1' });
});

test('high-tier strategy excludes a higher-scoring model without planning capability', () => {
  const connectors = {
    planner: { name: 'planner', lanes: ['analyze'], capabilities: ['strong-analysis', 'workflow-planning'] },
    coder: { name: 'coder', lanes: ['analyze'], capabilities: ['strong-analysis', 'code-reading'] },
  };
  const pools = Object.values(connectors).map((connector) => ({
    name: connector.name, connector, enabled: true, costRank: 1, pace: 0,
  }));
  const discoveries = {
    planner: { models: [{ id: 'planner-model', tier: 'high', qualityRank: 5, free: false }] },
    coder: { models: [{ id: 'coder-model', tier: 'high', qualityRank: 100, free: false }] },
  };
  const report = buildStrategy({ connectors, pools, state: {}, discoveries });
  assert.deepEqual(report.suggestions.high.recommended, { pool: 'planner', model: 'planner-model' });
  assert.deepEqual(report.suggestions.high.requirements.capabilities, ['strong-analysis', 'workflow-planning']);
});

test('model exclusions pin an allowed same-tier model or block an unsafe implicit default', () => {
  const claude = {
    name: 'claude-code',
    spawn: { cmd: ['claude', '-p', 'task'] },
    modelSelection: { flag: '--model', mode: 'replace-or-append' },
    knownModels: ['claude-fable-5', 'claude-opus-5', 'claude-sonnet-5'],
    modelProfiles: [
      { match: '^claude-fable-5$', tier: 'high', qualityRank: 6 },
      { match: '^claude-opus-5$', tier: 'high', qualityRank: 5 },
      { match: '^claude-sonnet-5$', tier: 'medium', qualityRank: 4 },
    ],
  };
  assert.deepEqual(resolveDispatchModel(claude, 'high', {
    excludedModels: ['claude-fable-5'],
  }), {
    eligible: true, model: 'claude-opus-5', source: 'exclusion-safe-tier-fallback',
  });
  assert.equal(resolveDispatchModel(claude, 'medium', {
    excludedModels: ['claude-fable-5'],
  }).model, 'claude-sonnet-5');
  // A never-recommend model is skipped by the fallback even when it ranks
  // highest: an unrelated exclusion must not route high work onto it.
  assert.deepEqual(resolveDispatchModel({
    ...claude,
    modelProfiles: [
      { match: '^claude-fable-5$', tier: 'high', qualityRank: 6, autoRecommend: false },
      ...claude.modelProfiles.slice(1),
    ],
  }, 'high', { excludedModels: ['claude-sonnet-5'] }), {
    eligible: true, model: 'claude-opus-5', source: 'exclusion-safe-tier-fallback',
  });
  assert.equal(resolveDispatchModel({
    name: 'implicit-only', spawn: { cmd: ['agent'] }, knownModels: ['blocked-model'],
    modelProfiles: [{ match: 'blocked-model', tier: 'high' }],
  }, 'high', { excludedModels: ['blocked-model'] }).eligible, false);
});

test('strategy recommendations omit persistently excluded models', () => {
  const connector = {
    name: 'planner', lanes: ['analyze'], capabilities: ['strong-analysis', 'workflow-planning'],
  };
  const report = buildStrategy({
    connectors: { planner: connector },
    pools: [{ name: 'planner', connector, enabled: true, pace: 0, costRank: 1 }],
    state: { strategy: { excludedModels: ['premium'] } },
    discoveries: { planner: { models: [
      { id: 'premium', tier: 'high', qualityRank: 6 },
      { id: 'standard', tier: 'high', qualityRank: 5 },
    ] } },
  });
  assert.deepEqual(report.excludedModels, ['premium']);
  assert.deepEqual(report.suggestions.high.recommended, { pool: 'planner', model: 'standard' });
});

test('multi-tier model selections are normalized and become an explicit allow-list', () => {
  const strategy = {};
  assert.deepEqual(setModelTierSelection(strategy, 'pool-a', 'model-a', ['low', 'high', 'bogus']), ['high', 'low']);
  strategy.configuredTiers = ['high'];
  assert.deepEqual(selectedModelsForTier(strategy, 'pool-a', 'high'), ['model-a']);
  assert.equal(selectedModelsForTier(strategy, 'pool-a', 'low'), null);
  assert.deepEqual(selectedModelsForTier(strategy, 'pool-b', 'high'), []);
});

test('explicit model allow-list selects its strongest model and blocks unselected pools', () => {
  const connector = {
    name: 'pool-a', modelSelection: { flag: '--model' },
    modelProfiles: [
      { match: 'strong', tier: 'high', qualityRank: 5 },
      { match: 'cheap', tier: 'low', qualityRank: 2 },
    ],
  };
  assert.deepEqual(resolveDispatchModel(connector, 'high', {
    allowedModels: ['cheap', 'strong'],
  }), { eligible: true, model: 'strong', source: 'tier-selection' });
  assert.equal(resolveDispatchModel(connector, 'high', { allowedModels: [] }).eligible, false);
});

test('OpenRouter signals select one current Claude default for every provider tier', () => {
  const connector = {
    name: 'claude-code', lanes: ['analyze', 'build', 'chore'],
    capabilities: ['strong-analysis', 'workflow-planning', 'code-reading', 'file-editing'],
  };
  const report = buildStrategy({
    connectors: { 'claude-code': connector },
    pools: [{ name: 'claude-code', connector, enabled: true, pace: 0, costRank: 4 }],
    state: {},
    discoveries: { 'claude-code': { models: [
      { id: 'claude-fable-5', tier: 'high', qualityRank: 6, autoRecommend: false },
      { id: 'claude-opus-5', tier: 'high', qualityRank: 5 },
      { id: 'claude-sonnet-5', tier: 'medium', qualityRank: 4 },
      { id: 'claude-haiku-4-5', tier: 'low', qualityRank: 3 },
    ] } },
    openRouterCatalog: { models: {
      'anthropic/claude-fable-5': {
        id: 'anthropic/claude-fable-5', ranks: { agentic: 1, coding: 1, intelligence: 1 },
        pricing: { inputUsdPerMillion: 10, outputUsdPerMillion: 50 },
      },
      'anthropic/claude-opus-5': {
        id: 'anthropic/claude-opus-5', ranks: { agentic: 2, coding: 2, intelligence: 2 },
        pricing: { inputUsdPerMillion: 5, outputUsdPerMillion: 25 },
      },
      'anthropic/claude-sonnet-5': {
        id: 'anthropic/claude-sonnet-5', ranks: { agentic: 3, coding: 3, intelligence: 4 },
        pricing: { inputUsdPerMillion: 2, outputUsdPerMillion: 10 },
      },
      'anthropic/claude-haiku-4-5': {
        id: 'anthropic/claude-haiku-4-5', ranks: { agentic: 15, coding: 14, intelligence: 18 },
        pricing: { inputUsdPerMillion: 1, outputUsdPerMillion: 5 },
      },
    } },
  });

  assert.deepEqual(report.providerSuggestions['claude-code'].high.recommended, { model: 'claude-opus-5' });
  assert.equal(report.providerSuggestions['claude-code'].high.candidates.some((entry) => entry.model === 'claude-fable-5'), false);
  assert.equal(report.discoveries['claude-code'].models.some((entry) => entry.id === 'claude-fable-5'), true);
  assert.deepEqual(resolveDispatchModel({ ...connector, modelSelection: { flag: '--model' } }, 'high', {
    assignment: { pool: 'claude-code', model: 'claude-fable-5' },
  }), { eligible: true, model: 'claude-fable-5', source: 'assignment' });
  assert.deepEqual(report.providerSuggestions['claude-code'].medium.recommended, { model: 'claude-sonnet-5' });
  assert.deepEqual(report.providerSuggestions['claude-code'].low.recommended, { model: 'claude-haiku-4-5' });
  for (const tier of ['high', 'medium', 'low']) {
    assert.deepEqual(Object.keys(report.providerSuggestions['claude-code'][tier].recommended), ['model']);
  }
});

test('a stale rank on an older family member never outranks the current version', () => {
  const connector = {
    name: 'codex', lanes: ['analyze'], capabilities: ['strong-analysis', 'workflow-planning'],
  };
  const report = buildStrategy({
    connectors: { codex: connector },
    pools: [{ name: 'codex', connector, enabled: true, pace: 0, costRank: 2 }],
    state: {},
    discoveries: { codex: { models: [
      { id: 'gpt-5.6-sol', tier: 'high', qualityRank: 99, family: 'sol', version: '5.6' },
      { id: 'gpt-6-sol', tier: 'high', qualityRank: 6, family: 'sol', version: '6' },
    ] } },
    // Only the older model is benchmarked and priced.
    openRouterCatalog: { models: {
      'openai/gpt-5.6-sol': {
        id: 'openai/gpt-5.6-sol', ranks: { agentic: 2, coding: 1, intelligence: 2 },
        pricing: { inputUsdPerMillion: 4, outputUsdPerMillion: 20 },
      },
    } },
  });
  assert.deepEqual(report.providerSuggestions.codex.high.recommended, { model: 'gpt-6-sol' });
  const [first, second] = report.providerSuggestions.codex.high.candidates;
  assert.equal(first.inheritsFrom, 'gpt-5.6-sol');
  assert.equal(second.model, 'gpt-5.6-sol');
});

test('OpenRouter indices break a tie between families of equal quality rank', () => {
  const connector = {
    name: 'codex', lanes: ['analyze'], capabilities: ['strong-analysis', 'workflow-planning'],
  };
  const report = buildStrategy({
    connectors: { codex: connector },
    pools: [{ name: 'codex', connector, enabled: true, pace: 0, costRank: 2 }],
    state: {},
    discoveries: { codex: { models: [
      { id: 'gpt-a', tier: 'high', qualityRank: 6 },
      { id: 'gpt-b', tier: 'high', qualityRank: 6 },
      { id: 'gpt-c', tier: 'high', qualityRank: 7 },
    ] } },
    openRouterCatalog: { models: {
      'openai/gpt-a': { id: 'openai/gpt-a', ranks: { agentic: 40, coding: 40, intelligence: 40 } },
      'openai/gpt-b': { id: 'openai/gpt-b', ranks: { agentic: 1, coding: 1, intelligence: 1 } },
    } },
  });
  assert.deepEqual(report.providerSuggestions.codex.high.candidates.map((c) => c.model), ['gpt-c', 'gpt-b', 'gpt-a']);
});

test('an unbenchmarked OpenRouter listing does not masquerade as quality evidence', () => {
  const connector = {
    name: 'codex', lanes: ['analyze'], capabilities: ['strong-analysis', 'workflow-planning'],
  };
  const report = buildStrategy({
    connectors: { codex: connector },
    pools: [{ name: 'codex', connector, enabled: true, pace: 0, costRank: 2 }],
    state: {},
    discoveries: { codex: { models: [
      { id: 'proven-model', tier: 'high', qualityRank: 8 },
      { id: 'gpt-listed-only', tier: 'high', qualityRank: 2 },
    ] } },
    openRouterCatalog: { models: {
      'openai/gpt-listed-only': {
        id: 'openai/gpt-listed-only', indices: {}, ranks: {},
        pricing: { inputUsdPerMillion: 1, outputUsdPerMillion: 2 },
      },
    } },
  });
  assert.deepEqual(report.providerSuggestions.codex.high.recommended, { model: 'proven-model' });
});

test('account-cloned providers recommend only models belonging to that account', () => {
  const connector = (name, providerId) => ({
    name, profile: { providerId }, lanes: ['analyze'],
    capabilities: ['strong-analysis', 'workflow-planning'],
  });
  const primary = connector('relay', 'a');
  const second = connector('relay:b', 'b');
  const models = [
    { id: 'a/gpt-5.6-sol', tier: 'high', qualityRank: 6 },
    { id: 'b/gpt-5.6-sol', tier: 'high', qualityRank: 6 },
  ];
  const report = buildStrategy({
    connectors: { relay: primary, 'relay:b': second },
    pools: [
      { name: 'relay', connector: primary, enabled: true, pace: 0, costRank: 1 },
      { name: 'relay:b', connector: second, enabled: true, pace: 0, costRank: 1 },
    ],
    state: {},
    discoveries: {
      relay: { models },
      'relay:b': { models },
    },
  });
  assert.deepEqual(report.providerSuggestions.relay.high.recommended, { model: 'a/gpt-5.6-sol' });
  assert.deepEqual(report.providerSuggestions['relay:b'].high.recommended, { model: 'b/gpt-5.6-sol' });
});

// --- family and version ranking ----------------------------------------------
// The real Codex and Claude connectors, fed through the real discovery step.

function packagedConnector(name) {
  return JSON.parse(readFileSync(new URL(`../src/providers/${name}/connector.json`, import.meta.url), 'utf8'));
}

async function discoverWith(connector, ids) {
  return discoverConnectorModels(connector, {
    provider: { module: { discoverModels: async () => ({ models: ids.map((id) => ({ id })) }) } },
  });
}

function poolFor(connector, extra = {}) {
  return {
    name: connector.name, connector, enabled: true, pace: 0, costRank: connector.costRank,
    lanes: connector.lanes, capabilities: connector.capabilities, ...extra,
  };
}

const CODEX_IDS = ['gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5'];

// Fixture benchmark numbers, not real results: they only make the 5.x models
// look strongly benchmarked while the gpt-6 models have none.
function codexWithBenchmarkedFiveSix() {
  const codex = packagedConnector('codex');
  codex.modelProfiles = codex.modelProfiles.map((row) => (row.match.includes('5\\.6')
    ? { ...row, benchmark: { name: 'fixture', score: 99, source: 'fixture', updatedAt: '2026-09-01' } }
    : row));
  return codex;
}

const FIVE_SIX_ON_OPENROUTER = { models: Object.fromEntries(['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5']
  .map((id) => [`openai/${id}`, {
    id: `openai/${id}`,
    indices: { agentic: 60, coding: 80, intelligence: 60 },
    pricing: { inputUsdPerMillion: 1, outputUsdPerMillion: 2 },
  }])) };

test('Codex: the gpt-6 models win their tiers over benchmarked and priced 5.x models', async () => {
  const codex = codexWithBenchmarkedFiveSix();
  const discovery = await discoverWith(codex, CODEX_IDS);
  const byId = Object.fromEntries(discovery.models.map((model) => [model.id, model]));
  // The 5.6 models are priced and benchmarked, the gpt-6 models are not, and
  // no price was copied onto a newer model.
  assert.ok(byId['gpt-5.6-sol'].pricing && byId['gpt-5.6-sol'].benchmarkScore === 99);
  for (const id of ['gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna']) {
    assert.equal(byId[id].pricing, null, id);
    assert.equal(byId[id].benchmarkScore, null, id);
  }
  const report = buildStrategy({
    connectors: { codex },
    pools: [poolFor(codex)],
    state: {},
    discoveries: { codex: discovery },
    openRouterCatalog: FIVE_SIX_ON_OPENROUTER,
  });
  const provider = report.providerSuggestions.codex;
  for (const view of [provider, report.suggestions]) {
    // astra sits above sol in the family order; neither may be a 5.x model.
    assert.equal(view.high.recommended.model, 'gpt-6-astra');
    assert.equal(view.low.recommended.model, 'gpt-6-luna');
    // There is no gpt-6 terra, so medium falls back to the newest luna
    // (the generation fallback tests below cover it in full).
    assert.equal(view.medium.recommended.model, 'gpt-6-luna');
  }
  const order = (tier) => provider[tier].candidates.map((c) => c.model);
  assert.deepEqual(order('high'), ['gpt-6-astra', 'gpt-6-sol', 'gpt-5.6-sol', 'gpt-5.5']);
  assert.deepEqual(order('medium'), ['gpt-6-luna', 'gpt-5.6-terra']);
  assert.deepEqual(order('low'), ['gpt-6-luna', 'gpt-5.6-luna']);
  const sol = provider.high.candidates.find((c) => c.model === 'gpt-6-sol');
  assert.deepEqual([sol.tier, sol.qualityRank, sol.family, sol.version, sol.inheritsFrom],
    ['high', 6, 'sol', '6', 'gpt-5.6-sol']);
  assert.deepEqual(report.unranked, []);
});

test('Codex: newer wins inside a family whatever pace, pool cost, or price say', async () => {
  const codex = codexWithBenchmarkedFiveSix();
  const discovery = await discoverWith(codex, CODEX_IDS);
  for (const pool of [
    poolFor(codex, { pace: 90, costRank: 1 }),
    poolFor(codex, { pace: -90, costRank: 9 }),
  ]) {
    const report = buildStrategy({
      connectors: { codex }, pools: [pool], state: {},
      discoveries: { codex: discovery }, openRouterCatalog: FIVE_SIX_ON_OPENROUTER,
    });
    assert.equal(report.suggestions.low.recommended.model, 'gpt-6-luna');
    assert.equal(report.suggestions.high.recommended.model, 'gpt-6-astra');
  }
  // Without astra, gpt-6-sol takes high, not the benchmarked gpt-5.6-sol.
  const withoutAstra = await discoverWith(codex, CODEX_IDS.filter((id) => id !== 'gpt-6-astra'));
  const report = buildStrategy({
    connectors: { codex }, pools: [poolFor(codex)], state: {},
    discoveries: { codex: withoutAstra }, openRouterCatalog: FIVE_SIX_ON_OPENROUTER,
  });
  assert.equal(report.suggestions.high.recommended.model, 'gpt-6-sol');
  // The per-pool pick used by rungs and dispatch applies the same rule.
  assert.equal(resolveDispatchModel(codex, 'high', {
    allowedModels: ['gpt-5.6-sol', 'gpt-6-sol', 'gpt-5.5'],
  }).model, 'gpt-6-sol');
  assert.equal(resolveDispatchModel(codex, 'low', {
    allowedModels: ['gpt-5.6-luna', 'gpt-6-luna'],
  }).model, 'gpt-6-luna');
});

test('an exact row may lower a newer model\'s rank without breaking newer-wins; autoRecommend false steps aside', async () => {
  const base = {
    name: 'fixture', lanes: ['build'], capabilities: ['code-reading', 'file-editing'],
    modelSelection: { flag: '--model' },
    modelFamilies: [{ family: 'terra', match: '-terra$', tier: 'medium', qualityRank: 4 }],
  };
  const priced = { match: '^m-1-terra$', qualityRank: 8, pricing: { inputUsdPerMillion: 1, outputUsdPerMillion: 2 } };
  const recommend = async (newerRow) => {
    const connector = { ...base, modelProfiles: [priced, newerRow] };
    return buildStrategy({
      connectors: { fixture: connector },
      pools: [{ name: 'fixture', connector, enabled: true, pace: 0, costRank: 1 }],
      state: {},
      discoveries: { fixture: await discoverWith(connector, ['m-1-terra', 'm-2-terra']) },
    }).suggestions.medium.recommended?.model;
  };
  // The newer model is unpriced and an exact row even lowers its rank.
  assert.equal(await recommend({ match: '^m-2-terra$', qualityRank: 1 }), 'm-2-terra',
    'neither the lowered rank nor the missing price pushes the newer model down');
  assert.equal(await recommend({ match: '^m-2-terra$', autoRecommend: false }), 'm-1-terra',
    'a deliberate opt-out lets the older model be suggested');
  const connector = { ...base, modelProfiles: [priced, { match: '^m-2-terra$', qualityRank: 1 }] };
  assert.equal(resolveDispatchModel(connector, 'medium', { allowedModels: ['m-1-terra', 'm-2-terra'] }).model, 'm-2-terra');
});

test('Claude: claude-opus-5-5 beats claude-opus-5, and Fable is never auto-recommended', async () => {
  const claude = packagedConnector('claude-code');
  const discovery = await discoverWith(claude, [
    'claude-opus-5', 'claude-opus-5-5', 'claude-opus-5-5[1m]', 'claude-fable-5-1[1m]',
    'claude-sonnet-5', 'claude-haiku-4-5',
  ]);
  const report = buildStrategy({
    connectors: { 'claude-code': claude },
    pools: [poolFor(claude)],
    state: {},
    discoveries: { 'claude-code': discovery },
    // Only the older Opus is benchmarked (fixture ranks).
    openRouterCatalog: { models: {
      'anthropic/claude-opus-5': { id: 'anthropic/claude-opus-5', ranks: { agentic: 1, coding: 1, intelligence: 1 } },
      'anthropic/claude-fable-5-1': { id: 'anthropic/claude-fable-5-1', ranks: { agentic: 1, coding: 1, intelligence: 1 } },
    } },
  });
  const provider = report.providerSuggestions['claude-code'];
  assert.deepEqual(provider.high.recommended, { model: 'claude-opus-5-5' });
  assert.deepEqual(report.suggestions.high.recommended, { pool: 'claude-code', model: 'claude-opus-5-5' });
  assert.deepEqual(provider.high.candidates.map((c) => c.model),
    ['claude-opus-5-5', 'claude-opus-5-5[1m]', 'claude-opus-5']);
  assert.equal(provider.high.candidates.some((c) => /fable/.test(c.model)), false);
  const fable = discovery.models.find((model) => model.id === 'claude-fable-5-1[1m]');
  assert.deepEqual([fable.tier, fable.family, fable.autoRecommend], ['high', 'fable', false]);
  assert.deepEqual(provider.medium.recommended, { model: 'claude-sonnet-5' });
  assert.deepEqual(provider.low.recommended, { model: 'claude-haiku-4-5' });
});

test('an unknown model is reported as unranked and never recommended', async () => {
  const codex = packagedConnector('codex');
  const discovery = await discoverWith(codex, ['gpt-5.6-luna', 'nova-9-preview']);
  const nova = discovery.models.find((model) => model.id === 'nova-9-preview');
  assert.deepEqual([nova.tier, nova.qualityRank, nova.ranking], [null, null, 'unranked']);
  const report = buildStrategy({
    connectors: { codex }, pools: [poolFor(codex)], state: {}, discoveries: { codex: discovery },
  });
  assert.deepEqual(report.unranked, [{
    pool: 'codex', model: 'nova-9-preview', ranking: 'unranked',
    reason: 'new model: no family rule or model profile gives it a tier yet',
  }]);
  assert.ok(report.discoveries.codex.models.some((model) => model.id === 'nova-9-preview'), 'still listed');
  for (const tier of STRATEGY_TIERS) {
    assert.equal(report.suggestions[tier].candidates.some((c) => c.model === 'nova-9-preview'), false, tier);
    assert.equal(report.providerSuggestions.codex[tier].candidates.some((c) => c.model === 'nova-9-preview'), false, tier);
  }
  assert.equal(report.suggestions.low.recommended.model, 'gpt-5.6-luna');
  // Alone, it is still not recommended for any tier.
  const alone = buildStrategy({
    connectors: { codex }, pools: [poolFor(codex)], state: {},
    discoveries: { codex: await discoverWith(codex, ['nova-9-preview']) },
  });
  for (const tier of STRATEGY_TIERS) assert.equal(alone.suggestions[tier].recommended, null, tier);
  assert.equal(alone.unranked.length, 1);
});

// --- newest-generation fallback ----------------------------------------------
// Owner decision: when the family serving medium has no model in the newest
// generation, medium runs the next-lower family's newest model at deeper
// reasoning. The real Codex connector opts medium in; high and low do not.

// The reasoning levels codex-cli's model/list reports today (discovery keeps
// them per model); `ultra` is outside Bullswarm's scale.
const SIX_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];

async function discoverWithLevels(connector, ids, levels = () => SIX_LEVELS) {
  return discoverConnectorModels(connector, {
    provider: { module: { discoverModels: async () => ({
      models: ids.map((id) => ({ id, reasoningLevels: levels(id) })),
    }) } },
  });
}

function codexReport(discovery, extra = {}) {
  const codex = extra.connector ?? packagedConnector('codex');
  return buildStrategy({
    connectors: { codex }, pools: [poolFor(codex)], state: extra.state ?? {},
    discoveries: { codex: discovery },
  });
}

test('Codex medium suggests gpt-6-luna at max reasoning while there is no gpt-6 terra', async () => {
  const report = codexReport(await discoverWithLevels(packagedConnector('codex'), CODEX_IDS));
  const why = 'no gpt-6 terra yet, newest generation preferred';
  assert.deepEqual(report.providerSuggestions.codex.medium.recommended,
    { model: 'gpt-6-luna', reasoning: 'max', why });
  assert.deepEqual(report.suggestions.medium.recommended,
    { pool: 'codex', model: 'gpt-6-luna', reasoning: 'max', why });
  const [fallback, stale] = report.providerSuggestions.codex.medium.candidates;
  assert.deepEqual(fallback.fallback, {
    family: 'luna', generation: 6, staleFamily: 'terra', staleVersion: '5.6',
    replaces: 'gpt-5.6-terra', reasoning: 'max', reasoningClamped: false, reason: why,
  });
  // The stale terra is still listed, directly below the model that replaces it.
  assert.equal(stale.model, 'gpt-5.6-terra');
  assert.equal(stale.fallback, undefined);
  // High and low do not fall back: astra/sol by family order, the newest luna.
  assert.deepEqual(report.providerSuggestions.codex.high.recommended, { model: 'gpt-6-astra' });
  assert.deepEqual(report.providerSuggestions.codex.low.recommended, { model: 'gpt-6-luna' });
  assert.match(report.caveats.join(' '), /generationFallback/);
});

test('Codex medium returns to terra at the normal medium reasoning once a gpt-6 terra is discovered', async () => {
  const codex = packagedConnector('codex');
  const report = codexReport(await discoverWithLevels(codex, [...CODEX_IDS, 'gpt-6-terra']));
  assert.deepEqual(report.providerSuggestions.codex.medium.recommended, { model: 'gpt-6-terra' });
  assert.deepEqual(report.suggestions.medium.recommended, { pool: 'codex', model: 'gpt-6-terra' });
  assert.equal(report.providerSuggestions.codex.medium.candidates.some((c) => c.fallback), false);
  // No level travels with it, so the rung runs the connector's medium default.
  const strategy = { configuredTiers: ['medium'] };
  setRung(strategy, { pool: 'codex', tier: 'medium', model: 'gpt-6-terra' });
  const [row] = rungsFor({ pools: [poolFor(codex)], strategy });
  assert.deepEqual([row.model, row.reasoning.applied, row.reasoning.source], ['gpt-6-terra', 'medium', 'connector']);
});

test('the fallback level clamps to the reasoning levels the model reports', async () => {
  const codex = packagedConnector('codex');
  const suggested = async (levels) => codexReport(await discoverWithLevels(codex, CODEX_IDS,
    (id) => (id === 'gpt-6-luna' ? levels : SIX_LEVELS))).providerSuggestions.codex.medium;
  // Capped at max: `ultra` is never suggested.
  assert.equal((await suggested(SIX_LEVELS)).recommended.reasoning, 'max');
  // The strongest level the model supports.
  const high = await suggested(['low', 'medium', 'high']);
  assert.equal(high.recommended.reasoning, 'high');
  assert.equal(high.candidates[0].fallback.reasoningClamped, true);
  // No discovered list: the connector's own levels decide.
  assert.equal((await suggested(undefined)).recommended.reasoning, 'max');
  // A model the CLI reports no level for gets none.
  assert.equal((await suggested([])).recommended.reasoning, null);
});

test('the fallback steps aside for a disabled model and needs a lower family in the newest generation', async () => {
  const codex = packagedConnector('codex');
  const discovery = await discoverWithLevels(codex, CODEX_IDS);
  // The operator turned gpt-6-luna off for codex: no newest-generation luna.
  const disabled = codexReport(discovery, { state: { strategy: { disabledModels: { codex: ['gpt-6-luna'] } } } });
  assert.deepEqual(disabled.providerSuggestions.codex.medium.recommended, { model: 'gpt-5.6-terra' });
  // Without any gpt-6 model, gpt-5.6 is the newest generation and terra is current.
  const five = codexReport(await discoverWithLevels(codex, CODEX_IDS.filter((id) => !id.startsWith('gpt-6'))));
  assert.deepEqual(five.providerSuggestions.codex.medium.recommended, { model: 'gpt-5.6-terra' });
  // A connector that does not opt the tier in never falls back.
  const optedOut = { ...codex, generationFallback: undefined };
  const plain = codexReport(discovery, { connector: optedOut });
  assert.deepEqual(plain.providerSuggestions.codex.medium.recommended, { model: 'gpt-5.6-terra' });
});

test('with the stale terra disabled, the stand-in keeps terra\'s standing across pools', async () => {
  const codex = packagedConnector('codex');
  const claude = packagedConnector('claude-code');
  const report = buildStrategy({
    connectors: { codex, 'claude-code': claude },
    pools: [poolFor(codex, { pace: 0 }), poolFor(claude, { pace: 0 })],
    state: { strategy: { disabledModels: { codex: ['gpt-5.6-terra'] } } },
    discoveries: {
      codex: await discoverWithLevels(codex, CODEX_IDS),
      'claude-code': await discoverWith(claude, ['claude-sonnet-5']),
    },
    // Fixture indices: terra benchmarked above sonnet, gpt-6-luna not at all.
    openRouterCatalog: { models: {
      'openai/gpt-5.6-terra': { id: 'openai/gpt-5.6-terra', indices: { agentic: 70, coding: 70, intelligence: 70 } },
      'anthropic/claude-sonnet-5': { id: 'anthropic/claude-sonnet-5', indices: { agentic: 60, coding: 60, intelligence: 60 } },
    } },
  });
  const [first] = report.providerSuggestions.codex.medium.candidates;
  assert.deepEqual([first.model, first.fallback.replaces], ['gpt-6-luna', 'gpt-5.6-terra']);
  assert.deepEqual(report.suggestions.medium.recommended.model, 'gpt-6-luna');
  // The disabled terra is not a cross-pool candidate either.
  assert.equal(report.suggestions.medium.candidates.some((c) => c.model === 'gpt-5.6-terra'), false);
});

test('a tier is never pinned to a model the operator disabled for that pool', async () => {
  const codex = packagedConnector('codex');
  const report = codexReport(await discoverWithLevels(codex, CODEX_IDS), {
    state: { strategy: { disabledModels: { codex: ['gpt-6-astra'] } } },
  });
  assert.deepEqual(report.suggestions.high.recommended, { pool: 'codex', model: 'gpt-6-sol' });
  assert.equal(report.suggestions.high.candidates.some((c) => c.model === 'gpt-6-astra'), false);
});

test('Claude tiers are unchanged: Sonnet 5 is in the newest generation, so medium never falls back', async () => {
  const ids = ['claude-opus-5-5', 'claude-opus-5-5[1m]', 'claude-fable-5-1[1m]', 'claude-sonnet-5', 'claude-haiku-4-5'];
  for (const claude of [
    packagedConnector('claude-code'),
    // Even opted in the way Codex is, Opus 5.5 is generation 5 like Sonnet 5.
    { ...packagedConnector('claude-code'), generationFallback: { tiers: { medium: { reasoning: 'max' } } } },
  ]) {
    const report = buildStrategy({
      connectors: { 'claude-code': claude }, pools: [poolFor(claude)], state: {},
      discoveries: { 'claude-code': await discoverWith(claude, ids) },
    });
    const provider = report.providerSuggestions['claude-code'];
    assert.deepEqual(provider.high.recommended, { model: 'claude-opus-5-5' });
    assert.deepEqual(provider.medium.recommended, { model: 'claude-sonnet-5' });
    assert.deepEqual(provider.low.recommended, { model: 'claude-haiku-4-5' });
    assert.equal(STRATEGY_TIERS.some((tier) => provider[tier].candidates.some((c) => c.fallback)), false);
  }
});

test('a Codex fallback keeps terra\'s standing against other pools on medium', async () => {
  const codex = packagedConnector('codex');
  const claude = packagedConnector('claude-code');
  const report = buildStrategy({
    connectors: { codex, 'claude-code': claude },
    pools: [poolFor(codex, { pace: 10 }), poolFor(claude, { pace: 0 })],
    state: {},
    discoveries: {
      codex: await discoverWithLevels(codex, CODEX_IDS),
      'claude-code': await discoverWith(claude, ['claude-sonnet-5']),
    },
  });
  // Codex led medium with terra on pace; the stand-in takes that place, with
  // the stale terra right behind it and Claude after both.
  assert.deepEqual(report.suggestions.medium.candidates.map((c) => `${c.pool}/${c.model}`),
    ['codex/gpt-6-luna', 'codex/gpt-5.6-terra', 'claude-code/claude-sonnet-5']);
});

// --- Grok: one model line -------------------------------------------------------
// Owner decision: Grok suggests its newest grok-N.M on every tier, and the
// tiers differ only by reasoning. build-fast is the same model at twice the
// price, so it is never suggested.

// What `grok models` (grok 1.0.40) listed on 2026-09-23.
const GROK_IDS = ['grok-4.7', 'grok-4.7-build-fast', 'grok-4.6', 'grok-4.5'];
const GROK_WHY = 'one Grok line, lighter reasoning for lighter tiers';

// Through the connector's own `bullets` parser, as `grok models` prints them.
async function grokDiscovery(ids = GROK_IDS) {
  const output = ids.map((id, i) => (i === 0 ? `  * ${id} (default)` : `  - ${id}`)).join('\n');
  return discoverConnectorModels(packagedConnector('grok'), { executor: async () => `Available models:\n${output}\n` });
}

async function grokReport(ids) {
  const grok = packagedConnector('grok');
  return buildStrategy({
    connectors: { grok }, pools: [poolFor(grok)], state: {},
    discoveries: { grok: await grokDiscovery(ids) },
  });
}

test('Grok suggests grok-4.7 on every tier, at xhigh, high and medium reasoning', async () => {
  const grok = packagedConnector('grok');
  const report = await grokReport();
  assert.equal(report.discoveries.grok.source, 'cli');
  const provider = report.providerSuggestions.grok;
  // High is the family's own tier: the newest version wins and carries no
  // level, so the rung runs the connector's high default.
  assert.deepEqual(provider.high.recommended, { model: 'grok-4.7' });
  const high = resolveReasoningLevel({ connector: grok, tier: 'high', model: 'grok-4.7', strategy: {} });
  assert.deepEqual([high.applied, high.source], ['xhigh', 'connector']);
  // No family serves medium or low: the same model, carrying the tier's level.
  assert.deepEqual(provider.medium.recommended, { model: 'grok-4.7', reasoning: 'high', why: GROK_WHY });
  assert.deepEqual(provider.low.recommended, { model: 'grok-4.7', reasoning: 'medium', why: GROK_WHY });
  assert.deepEqual(provider.low.candidates[0].fallback, {
    family: 'grok', generation: 4, staleFamily: null, staleVersion: null,
    replaces: null, reasoning: 'medium', reasoningClamped: false, reason: GROK_WHY,
  });
  assert.deepEqual(provider.medium.candidates.map((c) => c.model), ['grok-4.7']);
  // The carried levels are the connector's own tier defaults.
  for (const tier of ['medium', 'low']) {
    assert.equal(grok.generationFallback.tiers[tier].reasoning, grok.reasoning.defaults[tier], tier);
  }
  // Every model the CLI lists is ranked, and grok-4.5 is no longer medium.
  assert.deepEqual(report.unranked, []);
  assert.equal(report.discoveries.grok.models.find((m) => m.id === 'grok-4.5').tier, 'high');
  for (const tier of STRATEGY_TIERS) assert.equal(report.suggestions[tier].recommended.model, 'grok-4.7', tier);
});

test('a newer grok takes over every Grok tier the day the CLI lists it', async () => {
  for (const newest of ['grok-4.8', 'grok-5']) {
    const report = await grokReport([newest, `${newest}-build-fast`, ...GROK_IDS]);
    const provider = report.providerSuggestions.grok;
    assert.deepEqual(provider.high.recommended, { model: newest }, newest);
    assert.deepEqual(provider.medium.recommended, { model: newest, reasoning: 'high', why: GROK_WHY }, newest);
    assert.deepEqual(provider.low.recommended, { model: newest, reasoning: 'medium', why: GROK_WHY }, newest);
    // It has no price row yet and still ranks first: newest wins in the family.
    assert.equal(provider.high.candidates[1].model, 'grok-4.7');
    assert.equal(report.discoveries.grok.models.find((m) => m.id === newest).pricing, null);
  }
  // A new build-fast alone changes nothing: it is never suggested.
  const fastOnly = await grokReport(['grok-4.8-build-fast', ...GROK_IDS]);
  for (const tier of STRATEGY_TIERS) {
    assert.equal(fastOnly.providerSuggestions.grok[tier].recommended.model, 'grok-4.7', tier);
  }
});

test('grok-4.7-build-fast is never recommended but stays selectable by hand', async () => {
  const grok = packagedConnector('grok');
  const report = await grokReport();
  const fast = report.discoveries.grok.models.find((m) => m.id === 'grok-4.7-build-fast');
  // Listed and ranked like its base model, opted out of recommendations, unpriced.
  assert.deepEqual([fast.tier, fast.qualityRank, fast.family, fast.version, fast.autoRecommend, fast.ranking],
    ['high', 5, 'grok-build-fast', '4.7', false, 'ranked']);
  assert.equal(fast.pricing, null);
  for (const tier of STRATEGY_TIERS) {
    assert.equal(report.providerSuggestions.grok[tier].candidates.some((c) => c.model === fast.id), false, tier);
    assert.equal(report.suggestions[tier].candidates.some((c) => c.model === fast.id), false, tier);
  }
  // Alone, it is still not suggested for any tier.
  const alone = await grokReport(['grok-4.7-build-fast']);
  for (const tier of STRATEGY_TIERS) assert.equal(alone.providerSuggestions.grok[tier].recommended, null, tier);
  // By hand, a rung runs it at the tier's reasoning.
  const strategy = { configuredTiers: ['medium'] };
  setRung(strategy, { pool: 'grok', tier: 'medium', model: 'grok-4.7-build-fast' });
  const [row] = rungsFor({ pools: [poolFor(grok)], strategy });
  assert.deepEqual([row.model, row.eligible, row.reasoning.applied], ['grok-4.7-build-fast', true, 'high']);
  // Where models are ordered by rank alone (exclusions on, no rung), the
  // plain model wins the tie with its equally ranked fast twin.
  assert.equal(resolveDispatchModel(grok, 'high', { excludedModels: ['grok-4.5'] }).model, 'grok-4.7');
});

test('Codex and Claude suggestions are unchanged with Grok alongside', async () => {
  const codex = packagedConnector('codex');
  const claude = packagedConnector('claude-code');
  const grok = packagedConnector('grok');
  const discoveries = {
    codex: await discoverWithLevels(codex, CODEX_IDS),
    'claude-code': await discoverWith(claude, ['claude-opus-5-5', 'claude-sonnet-5', 'claude-haiku-4-5']),
    grok: await grokDiscovery(),
  };
  const report = (withGrok) => buildStrategy({
    connectors: withGrok ? { codex, 'claude-code': claude, grok } : { codex, 'claude-code': claude },
    pools: [poolFor(codex), poolFor(claude), ...(withGrok ? [poolFor(grok)] : [])],
    state: {},
    discoveries,
  });
  const before = report(false);
  const after = report(true);
  for (const pool of ['codex', 'claude-code']) {
    assert.deepEqual(after.providerSuggestions[pool], before.providerSuggestions[pool], pool);
  }
  // Grok's medium and low stand-in has no rank of its own there, so the
  // tier-wide pick stays with the pools that serve those tiers.
  for (const tier of STRATEGY_TIERS) {
    assert.deepEqual(after.suggestions[tier].recommended, before.suggestions[tier].recommended, tier);
  }
  assert.deepEqual(after.suggestions.medium.recommended, { pool: 'codex', model: 'gpt-6-luna', reasoning: 'max', why: 'no gpt-6 terra yet, newest generation preferred' });
  const grokMedium = after.suggestions.medium.candidates.find((c) => c.pool === 'grok');
  assert.deepEqual([grokMedium.model, grokMedium.fallback.reasoning], ['grok-4.7', 'high']);
  assert.equal(after.suggestions.medium.candidates.at(-1).pool, 'grok');
});

test('applying a recommendation writes its level once, marked, and never over an operator level', () => {
  const why = 'no gpt-6 terra yet, newest generation preferred';
  const levels = { codex: { medium: { level: 'max', model: 'gpt-6-luna', why } } };
  const strategy = {};
  assert.deepEqual(applyRecommendedReasoning(strategy, levels).written,
    [{ pool: 'codex', tier: 'medium', level: 'max', model: 'gpt-6-luna', why }]);
  assert.deepEqual(strategy.reasoning, { tiers: {}, pools: { codex: { medium: 'max' } } });
  assert.deepEqual(getRecommendedReasoning(strategy), { codex: { medium: { level: 'max', model: 'gpt-6-luna', why } } });
  const codex = packagedConnector('codex');
  const resolved = (model, s = strategy) => resolveReasoningLevel({ connector: codex, tier: 'medium', model, strategy: s });
  assert.deepEqual([resolved('gpt-6-luna').applied, resolved('gpt-6-luna').source], ['max', 'recommendation']);
  // The level belongs to the model it was recommended for.
  assert.deepEqual([resolved('gpt-5.6-terra').applied, resolved('gpt-5.6-terra').source], ['medium', 'connector']);
  // Re-applying is idempotent.
  applyRecommendedReasoning(strategy, levels);
  assert.deepEqual(strategy.reasoning.pools, { codex: { medium: 'max' } });

  // An operator's pool+tier level is theirs: set-rung takes the slot over,
  // and a later apply keeps it.
  const own = {};
  applyRecommendedReasoning(own, levels);
  setRung(own, { pool: 'codex', tier: 'medium', model: 'gpt-6-luna', reasoning: 'high' });
  assert.deepEqual(getRecommendedReasoning(own), {});
  const kept = applyRecommendedReasoning(own, levels);
  assert.deepEqual(kept.kept, [{ pool: 'codex', tier: 'medium', level: 'high', source: 'strategy-pool' }]);
  assert.equal(own.reasoning.pools.codex.medium, 'high');
  assert.equal(resolved('gpt-6-luna', own).source, 'strategy-pool');

  // A tier-wide operator level replaces the recommended one and is kept too.
  const tierWide = {};
  applyRecommendedReasoning(tierWide, levels);
  setStrategyReasoning(tierWide, { tier: 'medium', level: 'xhigh' });
  assert.deepEqual(tierWide.reasoning, { tiers: { medium: 'xhigh' }, pools: {} });
  assert.deepEqual(applyRecommendedReasoning(tierWide, levels).kept,
    [{ pool: 'codex', tier: 'medium', level: 'xhigh', source: 'strategy-tier' }]);
  assert.equal(resolved('gpt-6-luna', tierWide).applied, 'xhigh');

  // Once medium is no longer a fallback, the next apply removes its own level.
  const back = {};
  applyRecommendedReasoning(back, levels);
  assert.deepEqual(applyRecommendedReasoning(back, {}).cleared,
    [{ pool: 'codex', tier: 'medium', level: 'max', model: 'gpt-6-luna' }]);
  assert.equal(back.reasoning, undefined);
  assert.equal(back.recommendedReasoning, undefined);
  // ...but never an operator's level in the same slot.
  const mine = { reasoning: { tiers: {}, pools: { codex: { medium: 'low' } } } };
  applyRecommendedReasoning(mine, {});
  assert.equal(mine.reasoning.pools.codex.medium, 'low');
  // reset-reasoning clears the marks with the levels.
  clearStrategyReasoning(strategy, { tier: 'medium' });
  assert.equal(strategy.recommendedReasoning, undefined);
});

// --- rungs -------------------------------------------------------------------
// A rung is one pool's model plus its reasoning level for one effort tier.
// These fixtures are hand-built connector specs, never a real provider.

function rungFixtures() {
  const deep = {
    name: 'deep',
    model: 'deep-1',
    knownModels: ['deep-1', 'deep-2'],
    modelSelection: { flag: '--model' },
    reasoning: { flag: '--effort', levels: ['low', 'high'], defaults: { high: 'high' } },
    modelProfiles: [
      { id: 'deep-1', tier: 'high', qualityRank: 3 },
      { id: 'deep-2', tier: 'medium', qualityRank: 1 },
    ],
  };
  const flat = { name: 'flat', model: 'flat-1', knownModels: ['flat-1'] };
  return {
    deep,
    flat,
    pools: [
      { name: 'deep', enabled: true, connector: deep },
      { name: 'flat', enabled: false, connector: flat },
    ],
    strategy: {
      configuredTiers: ['high', 'medium'],
      modelTiers: { deep: { 'deep-1': ['high'], 'deep-2': ['medium'] }, flat: { 'flat-1': ['high'] } },
      reasoning: { tiers: {}, pools: { deep: { medium: 'max' } } },
    },
  };
}

test('every rung reports its model, its effective reasoning level, and the source of each', () => {
  const f = rungFixtures();
  const rows = rungsFor({ pools: f.pools, strategy: f.strategy });
  // A disabled pool cannot take a dispatch, so it has no rung; only the two
  // CONFIGURED tiers appear, in the canonical high/medium/low order.
  assert.deepEqual(rows.map((row) => `${row.pool}/${row.tier}`), ['deep/high', 'deep/medium']);
  assert.deepEqual(rows[0].model, 'deep-1');
  assert.equal(rows[0].modelSource, 'tier-selection');
  assert.deepEqual(rows[0].reasoning, {
    applied: 'high', source: 'connector', requested: 'high', clamped: false,
  });
  // The pool asked for `max`; this connector only declares low and high, so
  // the rung reports the level the CLI would really see, marked clamped.
  assert.equal(rows[1].model, 'deep-2');
  assert.deepEqual(rows[1].reasoning, {
    applied: 'high', source: 'strategy-pool', requested: 'max', clamped: true,
  });
});

test('a rung with no evidence and no dispatches says so instead of guessing', () => {
  const f = rungFixtures();
  const rows = rungsFor({ pools: f.pools, strategy: f.strategy });
  assert.deepEqual(rows.map((row) => row.evidence), [null, null]);
  assert.deepEqual(rows.map((row) => row.record), [null, null]);
  assert.equal(formatRungEvidence(null), '');
});

test('rung evidence comes from the injected datapack lookup, never from core', () => {
  const f = rungFixtures();
  const asked = [];
  // The exact pair src/lib/epoch-benchmarks.js exports.
  const rows = rungsFor({
    pools: f.pools,
    strategy: f.strategy,
    evidence: {
      datapack: { rows: { 'deep-1': { blended: 0.71, costPerTask: 0.42, tokensPerTask: 31_200 } } },
      rungEvidence: (datapack, query) => {
        asked.push(query);
        return datapack.rows[query.model] ?? null;
      },
    },
  });
  assert.deepEqual(asked, [
    { pool: 'deep', tier: 'high', model: 'deep-1', reasoning: 'high' },
    { pool: 'deep', tier: 'medium', model: 'deep-2', reasoning: 'high' },
  ]);
  assert.deepEqual(rows[0].evidence, { blended: 0.71, costPerTask: 0.42, tokensPerTask: 31_200 });
  assert.equal(rows[1].evidence, null, 'a model the datapack does not cover has no evidence');
  assert.equal(formatRungEvidence(rows[0].evidence), 'blended 0.71 · $0.42/task · 31.2k tok/task');
});

test('a broken evidence lookup leaves the rung table standing', () => {
  const f = rungFixtures();
  const rows = rungsFor({
    pools: f.pools,
    strategy: f.strategy,
    evidence: () => { throw new Error('half-written datapack'); },
  });
  assert.deepEqual(rows.map((row) => row.evidence), [null, null]);
});

test('a rung local record counts only the picked pool and effort tier', () => {
  const f = rungFixtures();
  const at = (hour) => new Date(Date.parse(`2026-09-08T0${hour}:00:00Z`)).toISOString();
  const decisionLog = [
    // Three matching attempts, one of them failed: 5, 7 and 10 wall minutes.
    { ts: at(1), picked: 'deep', ok: true, wallSec: 300, routing: { effort: 'high' } },
    { ts: at(2), picked: 'deep', ok: true, wallSec: 420, effort: 'high' },
    { ts: at(3), pool: 'deep', ok: false, wallSec: 600, routing: { effortTier: 'high' } },
    // Same pool, different tier; different pool, same tier; and a matching
    // attempt with no usable duration at all.
    { ts: at(4), picked: 'deep', ok: true, wallSec: 60, effort: 'medium' },
    { ts: at(5), picked: 'other', ok: true, wallSec: 60, effort: 'high' },
    { ts: at(6), picked: 'deep', effortTier: 'high' },
  ];
  const rows = rungsFor({ pools: f.pools, strategy: f.strategy, decisionLog });
  assert.deepEqual(rows[0].record, { dispatches: 4, medianMinutes: 7, okShare: 0.667 });
  assert.deepEqual(rows[1].record, { dispatches: 1, medianMinutes: 1, okShare: 1 });
  assert.equal(rungRecord(decisionLog, 'deep', 'low'), null);
  assert.equal(rungRecord([], 'deep', 'high'), null);
});

test('setRung writes both halves of a rung and keeps one rung per pool and tier', () => {
  const strategy = {
    configuredTiers: ['high', 'medium'],
    modelTiers: { deep: { 'deep-1': ['high', 'medium'] } },
  };
  setRung(strategy, { pool: 'deep', tier: 'medium', model: 'deep-2', reasoning: 'high' });
  // The tier moved off the model that held it; that model's OTHER tier stayed.
  assert.deepEqual(strategy.modelTiers.deep, { 'deep-1': ['high'], 'deep-2': ['medium'] });
  assert.deepEqual(strategy.reasoning, { tiers: {}, pools: { deep: { medium: 'high' } } });
  // No level given leaves the reasoning half exactly as it was.
  setRung(strategy, { pool: 'deep', tier: 'high', model: 'deep-2' });
  assert.deepEqual(strategy.modelTiers.deep, { 'deep-2': ['high', 'medium'] });
  assert.deepEqual(strategy.reasoning, { tiers: {}, pools: { deep: { medium: 'high' } } });
  // `default` is a real answer: pass nothing to the CLI on that tier.
  setRung(strategy, { pool: 'deep', tier: 'high', model: 'deep-2', reasoning: 'default' });
  assert.deepEqual(strategy.reasoning.pools.deep, { high: 'default', medium: 'high' });
  // Nothing else in state.strategy is reshaped or migrated.
  assert.deepEqual(Object.keys(strategy).sort(), ['configuredTiers', 'modelTiers', 'reasoning']);
});

test('setRung marks the tier configured, so a rung set on a fresh home is visible and effective', () => {
  const fresh = { modelTiers: {} };
  setRung(fresh, { pool: 'deep', tier: 'medium', model: 'deep-2', reasoning: 'high' });
  assert.deepEqual(fresh.configuredTiers, ['medium']);
  assert.deepEqual(fresh.modelTiers.deep, { 'deep-2': ['medium'] });
  // Setting the same tier again adds no duplicate.
  setRung(fresh, { pool: 'deep', tier: 'medium', model: 'deep-3' });
  assert.deepEqual(fresh.configuredTiers, ['medium']);
  // An already-configured list is extended, never replaced.
  const seeded = { configuredTiers: ['high'], modelTiers: {} };
  setRung(seeded, { pool: 'deep', tier: 'low', model: 'deep-1' });
  assert.deepEqual(seeded.configuredTiers, ['high', 'low']);
});

test('setRung refuses an unknown tier or level before anything is written', () => {
  const strategy = { modelTiers: { deep: { 'deep-1': ['high'] } } };
  assert.throws(() => setRung(strategy, { pool: 'deep', tier: 'enormous', model: 'deep-2' }), /--tier must be/);
  assert.throws(() => setRung(strategy, { pool: 'deep', tier: 'high', model: 'deep-2', reasoning: 'ludicrous' }), /--level must be/);
  assert.throws(() => setRung(strategy, { pool: 'deep', tier: 'high' }), /needs a model/);
  assert.deepEqual(strategy.modelTiers, { deep: { 'deep-1': ['high'] } });
});

test('a rung written by setRung is the rung rungsFor reads back', () => {
  const f = rungFixtures();
  const strategy = { configuredTiers: ['medium'], modelTiers: {} };
  setRung(strategy, { pool: 'deep', tier: 'medium', model: 'deep-2', reasoning: 'low' });
  const [row] = rungsFor({ pools: f.pools, strategy });
  assert.equal(row.model, 'deep-2');
  assert.equal(row.reasoning.applied, 'low');
  assert.equal(row.reasoning.source, 'strategy-pool');
});

// --- C1: one lane/effort relation, three consumers --------------------------

test('tier lanes are derived from the validator tables, not restated', () => {
  // The values the hand-written table used to state, now computed.
  assert.deepEqual(TIER_LANES, { high: 'analyze', medium: 'build', low: 'chore' });
  // Derived, so no tier can name a lane the V2 validator does not know.
  for (const tier of STRATEGY_TIERS) {
    assert.ok(TIER_LANES[tier] in DEFAULT_EFFORT_BY_LANE, `${tier} -> unknown lane`);
    assert.equal(TIER_CONTEXTS[tier].lane, TIER_LANES[tier]);
  }
  // Each derived lane really is a lane KIND_DEFAULTS pairs with that effort.
  for (const tier of STRATEGY_TIERS) {
    assert.ok(
      Object.values(KIND_DEFAULTS).some(
        (kind) => kind.effort === tier && kind.lane === TIER_LANES[tier],
      ),
      `no ${tier} kind runs on ${TIER_LANES[tier]}`,
    );
  }
  // The map is total and one-to-one: three tiers, three distinct lanes.
  assert.equal(new Set(Object.values(TIER_LANES)).size, 3);
});

test('TIER_CONTEXTS still carries the per-tier capability requirements', () => {
  assert.deepEqual(TIER_CONTEXTS.high.capabilities, ['strong-analysis', 'workflow-planning']);
  assert.deepEqual(TIER_CONTEXTS.medium.capabilities, ['code-reading', 'file-editing']);
  assert.deepEqual(TIER_CONTEXTS.low.capabilities, []);
});

// --- C2: one invalidation for the overlapping pool pin ----------------------

test('clearTierAssignment drops one tier pin and leaves the others alone', () => {
  const strategy = {
    assignments: {
      high: { pool: 'codex', model: 'gpt-5.6-sol' },
      medium: { pool: 'grok', model: 'grok-4.6' },
    },
  };
  assert.equal(clearTierAssignment(strategy, 'high'), true);
  assert.deepEqual(Object.keys(strategy.assignments), ['medium']);
  // Idempotent, and honest about having changed nothing.
  assert.equal(clearTierAssignment(strategy, 'high'), false);
  assert.equal(clearTierAssignment(strategy, 'low'), false);
});

test('clearTierAssignment tolerates a strategy with no assignments at all', () => {
  assert.equal(clearTierAssignment(undefined, 'high'), false);
  assert.equal(clearTierAssignment(null, 'high'), false);
  assert.equal(clearTierAssignment({}, 'high'), false);
  const empty = { assignments: {} };
  assert.equal(clearTierAssignment(empty, 'high'), false);
  assert.deepEqual(empty.assignments, {});
});

test('rungRecord leaves stopped dispatches out of a pool ok share', () => {
  const log = [
    { picked: 'pool-a', effort: 'low', ok: true },
    { picked: 'pool-a', effort: 'low', ok: false, failureKind: 'semantic', why: 'no deliverable' },
    // Stopped by a cancel, a plan revision or a pause: not a verdict on the pool.
    { picked: 'pool-a', effort: 'low', ok: false, failureKind: 'cancelled', why: 'workflow cancellation requested' },
    // Recorded before dispatch rows carried failureKind.
    { picked: 'pool-a', effort: 'low', ok: false, why: 'workflow cancellation requested' },
  ];
  const record = rungRecord(log, 'pool-a', 'low');
  assert.equal(record.dispatches, 4, 'a stopped dispatch still counts as a dispatch');
  assert.equal(record.okShare, 0.5);
  assert.equal(rungRecord(log.slice(2), 'pool-a', 'low').okShare, null, 'only stops means no verdict yet');
});

test('rungRecord leaves stalled attempts out of medianMinutes', () => {
  const at = (hour) => new Date(Date.parse(`2026-09-08T0${hour}:00:00Z`)).toISOString();
  const log = [
    { ts: at(1), picked: 'pool-a', effort: 'low', ok: true, wallSec: 240 },
    { ts: at(2), picked: 'pool-a', effort: 'low', ok: true, wallSec: 360 },
    // Silence timeout: 60 wall minutes that would pull p50 from 5 to 6.
    { ts: at(3), picked: 'pool-a', effort: 'low', ok: false, failureKind: 'stalled', wallSec: 3600 },
    // Attempt-shaped row: stalled flag, no failureKind.
    { ts: at(4), picked: 'pool-a', effort: 'low', ok: false, stalled: true, wallSec: 7200 },
  ];
  const record = rungRecord(log, 'pool-a', 'low');
  assert.equal(record.dispatches, 4, 'a stall still counts as a dispatch');
  assert.equal(record.medianMinutes, 5, 'stall wall time does not move the median');
  assert.equal(record.okShare, 0.5, 'a stall remains a verdict for ok share');
  const stallOnly = rungRecord(log.slice(2), 'pool-a', 'low');
  assert.equal(stallOnly.dispatches, 2);
  assert.equal(stallOnly.medianMinutes, null, 'only stalls means no measured duration');
  assert.equal(stallOnly.okShare, 0);
});
