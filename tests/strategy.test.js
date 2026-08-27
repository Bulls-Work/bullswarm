import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseDiscoveredModels, discoverConnectorModels, buildStrategy,
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
