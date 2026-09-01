import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseDiscoveredModels, discoverConnectorModels, discoverAllModels, buildStrategy, resolveDispatchModel,
  selectedModelsForTier, setModelTierSelection,
} from '../src/lib/strategy.js';

test('connector-declared parsing handles columns, bullets, and plain lines', () => {
  assert.deepEqual(parseDiscoveredModels('Header\nfoo/bar  description\ngpt-5  text\n', {
    parse: 'columns', ignorePattern: '^Header$',
  }), ['foo/bar', 'gpt-5']);
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
    modelProfiles: [{ match: 'live-model', tier: 'high', qualityRank: 5 }],
  };
  const result = discoverConnectorModels(connector, {
    executor: () => 'live-model\n',
  });
  assert.equal(result.source, 'cli');
  assert.deepEqual(result.models.map((m) => m.id), ['live-model', 'fallback-model', 'configured-model']);
  assert.equal(result.models[0].tier, 'high');
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
