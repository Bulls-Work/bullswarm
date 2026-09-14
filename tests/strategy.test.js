import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  parseDiscoveredModels, discoverConnectorModels, discoverAllModels, buildStrategy, resolveDispatchModel,
  selectedModelsForTier, setModelTierSelection,
  rungsFor, setRung, rungRecord, formatRungEvidence,
  TIER_LANES, TIER_CONTEXTS, clearTierAssignment, STRATEGY_TIERS,
} from '../src/lib/strategy.js';
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

test('model discovery merges live, fallback, and configured models with profiles', () => {
  const connector = {
    name: 'fixture',
    model: 'configured-model',
    modelDiscovery: { cmd: ['fixture', 'models'], parse: 'lines' },
    knownModels: ['fallback-model'],
    modelProfiles: [{ match: 'live-model', tier: 'high', qualityRank: 5, autoRecommend: false }],
  };
  const result = discoverConnectorModels(connector, {
    executor: () => 'live-model\n',
  });
  assert.equal(result.source, 'cli');
  assert.deepEqual(result.models.map((m) => m.id), ['live-model', 'fallback-model', 'configured-model']);
  assert.equal(result.models[0].tier, 'high');
  assert.equal(result.models[0].autoRecommend, false);
});

test('command-code profiles deepseek-v4.1-flash specifically; v4-flash stays on the generic flash catch-all', () => {
  // modelProfile (src/lib/usage.js) walks modelProfiles in order and returns
  // the first regex match, so the v4.1 entry must sit before the generic
  // `(?:flash|...|luna|free)` catch-all or it would inherit qualityRank 2
  // and no pricing.
  const commandCode = JSON.parse(readFileSync(new URL('../providers/contrib/command-code/connector.json', import.meta.url), 'utf8'));
  const result = discoverConnectorModels(commandCode, {
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

test('model discovery executes an identical provider command only once across account clones', () => {
  let calls = 0;
  const connector = (name) => ({ name, modelDiscovery: { cmd: ['agent', 'models'] } });
  const result = discoverAllModels({ a: connector('a'), b: connector('b') }, {
    executor: () => { calls += 1; return 'provider/model\n'; },
  });
  assert.equal(calls, 1);
  assert.deepEqual(result.a.models.map((model) => model.id), ['provider/model']);
  assert.deepEqual(result.b.models.map((model) => model.id), ['provider/model']);
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

test('dated connector benchmark scores outrank coarse quality ranks when supplied', () => {
  const capable = {
    lanes: ['analyze'], capabilities: ['strong-analysis', 'workflow-planning'],
  };
  const connectors = { a: { name: 'a', ...capable }, b: { name: 'b', ...capable } };
  const pools = [
    { name: 'a', connector: connectors.a, enabled: true, costRank: 1, pace: 0 },
    { name: 'b', connector: connectors.b, enabled: true, costRank: 1, pace: 0 },
  ];
  const discoveries = {
    a: { models: [{ id: 'a1', tier: 'high', qualityRank: 100, benchmarkScore: 40, benchmark: { score: 40, source: 'dated-a' } }] },
    b: { models: [{ id: 'b1', tier: 'high', qualityRank: 1, benchmarkScore: 60, benchmark: { score: 60, source: 'dated-b' } }] },
  };
  const report = buildStrategy({ connectors, pools, state: {}, discoveries });
  assert.deepEqual(report.suggestions.high.recommended, { pool: 'b', model: 'b1' });
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

test('OpenRouter ranking favors current GPT generation over a stale local quality rank', () => {
  const connector = {
    name: 'codex', lanes: ['analyze'], capabilities: ['strong-analysis', 'workflow-planning'],
  };
  const report = buildStrategy({
    connectors: { codex: connector },
    pools: [{ name: 'codex', connector, enabled: true, pace: 0, costRank: 2 }],
    state: {},
    discoveries: { codex: { models: [
      { id: 'gpt-5.5', tier: 'high', qualityRank: 99 },
      { id: 'gpt-5.6-sol', tier: 'high', qualityRank: 6 },
    ] } },
    openRouterCatalog: { models: {
      'openai/gpt-5.6-sol': {
        id: 'openai/gpt-5.6-sol', ranks: { agentic: 2, coding: 1, intelligence: 2 },
        pricing: { inputUsdPerMillion: 4, outputUsdPerMillion: 20 },
      },
    } },
  });
  assert.deepEqual(report.providerSuggestions.codex.high.recommended, { model: 'gpt-5.6-sol' });
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
