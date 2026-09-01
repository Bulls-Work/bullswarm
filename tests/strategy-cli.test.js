import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { autoSetup } from '../src/setup.js';
import { loadState, saveState } from '../src/lib/state.js';
import {
  refreshStrategy, cmdStrategy, applyStrategyRecommendations, maybeRefreshStrategy, strategyInventory,
} from '../src/strategy-cli.js';
import { renderStrategyDashboard } from '../src/strategy-dashboard.js';

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
    const report = await refreshStrategy(f.dir, {
      executor: (command) => command.includes('grok') ? '* grok-4.6 (default)\n' : 'gpt-5.6-luna  low\n',
      getReadings: async () => ({}),
    });
    assert.equal(report.schemaVersion, 'bullswarm.strategy.v1');
    assert.ok(report.discoveries.grok.models.some((model) => model.id === 'grok-4.6'));
    assert.equal(loadState(f.dir).strategy.lastReport.capturedAt, report.capturedAt);
    assert.match(report.caveats.join(' '), /does not invent/i);
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
    });
    assert.ok(refreshed?.report);
    assert.ok(discoveries > 0);
    assert.equal(loadState(f.dir).strategy.policy.autoApplyRecommendations, true);
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
  assert.match(screen, /Effective choices now/);
  assert.match(screen, /worker\/smart/);
});
