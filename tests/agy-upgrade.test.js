// Upgrade path for new pools and step-model validation (spec addendum G).
//
// Nothing here spawns agy or claude, reads ~/.gemini, touches live meters or
// reads ~/.bullswarm: pools load with `accounts: []`, discovery uses an
// injected executor, and plan validation runs against a temp BULLSWARM_HOME.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildPools } from '../src/lib/config.js';
import { loadState } from '../src/lib/state.js';
import * as setup from '../src/setup.js';
import { maybeRefreshStrategy, refreshStrategy, rungRows } from '../src/strategy-cli.js';
import { pinnedPoolIssues, routePoolIssues } from '../src/workflow/cli-pool-checks.js';

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const BIN = join(REPO, 'bin', 'bullswarm.js');
const FIRST_CLASS = join(REPO, 'src', 'providers');
const MODELS_TXT = readFileSync(join(REPO, 'tests', 'fixtures', 'agy', 'models.txt'), 'utf8');
const NOW = Date.parse('2026-11-18T00:00:00.000Z');

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

/**
 * A temp home representing an upgraded installation: an existing pool (`existing`)
 * already has operator-approved tier picks (`existing-v1`, even though its
 * connector now also lists a higher-ranked `existing-v2`), `autoApplyRecommendations`
 * is off, and the other packaged non-agy pools were already seen by `lastReport`.
 */
function upgradedHome(t) {
  const home = mkdtempSync(join(tmpdir(), 'bs-agy-upgrade-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  for (const dir of ['providers', 'connectors', 'contrib', 'meters']) mkdirSync(join(home, dir), { recursive: true });

  writeFileSync(join(home, 'connectors', 'existing.json'), JSON.stringify({
    name: 'existing',
    bin: 'existing-cli',
    spawn: { cmd: ['existing-cli', '{taskFile}'] },
    outputExtraction: { strategy: 'stdout' },
    meter: { type: 'none', window: 'none' },
    costRank: 3,
    lanes: ['analyze', 'build', 'chore'],
    capabilities: ['strong-analysis', 'code-reading', 'file-editing', 'workflow-planning'],
    model: 'existing-v1',
    knownModels: ['existing-v1', 'existing-v2', 'existing-mid', 'existing-lite'],
    modelSelection: { flag: '--model', mode: 'replace-or-append' },
    modelProfiles: [
      { id: 'existing-v2', tier: 'high', qualityRank: 9 },
      { id: 'existing-v1', tier: 'high', qualityRank: 5 },
      { id: 'existing-mid', tier: 'medium', qualityRank: 4 },
      { id: 'existing-lite', tier: 'low', qualityRank: 3 },
    ],
    subscription: { plan: null, monthlyPriceUsd: null, includedValueUsd: null, quotaWindow: 'weekly' },
    flags: { stealth: false },
  }, null, 2));

  writeFileSync(join(home, 'state.json'), JSON.stringify({
    version: 1,
    pools: {
      existing: { enabled: true },
      'claude-code': { enabled: false },
      codex: { enabled: false },
      grok: { enabled: false },
    },
    config: { testFixturesMigrated: true },
    decisionLog: [],
    strategy: {
      configuredTiers: ['high', 'medium', 'low'],
      modelTiers: {
        // Deliberately pinned to existing-v1 on high so a full re-apply would
        // overwrite it with existing-v2; seeding new pools must NOT touch it.
        existing: {
          'existing-v1': ['high'],
          'existing-mid': ['medium'],
          'existing-lite': ['low'],
        },
      },
      policy: {
        autoApplyRecommendations: false,
        refreshHours: 24,
        approvedAt: '2026-10-01T00:00:00.000Z',
        source: 'explicit-user-approval',
      },
      lastAppliedAt: '2026-10-01T00:00:00.000Z',
      lastRefreshedAt: new Date().toISOString(),
      lastReport: {
        discoveries: {
          existing: { models: [{ id: 'existing-v1' }, { id: 'existing-mid' }, { id: 'existing-lite' }] },
          'claude-code': { models: [] },
          codex: { models: [] },
          grok: { models: [] },
        },
      },
    },
  }, null, 2));

  return home;
}

test('G: maybeRefreshStrategy seeds new agy pools on an upgraded home without touching existing picks, records who/when/why, and plan validate passes', async (t) => {
  const home = upgradedHome(t);
  const loaderOpts = loaderFor(home);

  // Before seeding: agy and agy:claude are tier-selection-empty on every tier.
  const beforePools = buildPools(home, NOW, {}, loaderOpts).pools;
  const routedAction = [{ id: 'impl', lane: 'build', effort: 'high', route: { providers: { use: ['agy'] } } }];
  assert.equal(routePoolIssues(routedAction, beforePools, { config: {} }, {}).length, 1);

  const seeded = await maybeRefreshStrategy(home, {
    loaderOpts,
    executor: () => '',
    providerExecutors: { agy: async () => MODELS_TXT },
    getReadings: async () => ({}),
  });
  assert.ok(seeded, 'maybeRefreshStrategy seeded the newly discovered agy pools');

  const state = loadState(home);
  // Existing pool's approved picks are untouched (still existing-v1, not existing-v2), and policy stays false.
  assert.deepEqual(state.strategy.modelTiers.existing, {
    'existing-v1': ['high'],
    'existing-mid': ['medium'],
    'existing-lite': ['low'],
  });
  assert.equal(state.strategy.policy.autoApplyRecommendations, false);

  // Both agy pools got their suggested picks per tier.
  assert.deepEqual(state.strategy.modelTiers.agy, {
    'gemini-4-carbon': ['high'],
    'gemini-4-hydrogen': ['medium'],
    'gemini-3.8-flash': ['low'],
  });
  assert.deepEqual(state.strategy.modelTiers['agy:claude'], {
    'claude-opus-4-6-thinking': ['high'],
    'claude-sonnet-4-6': ['medium'],
    'gpt-oss-120b-medium': ['low'],
  });

  // Who/when/why record is persisted per seeded pool (like poolToggles).
  for (const pool of ['agy', 'agy:claude']) {
    const entry = state.strategy.rungSeeds?.[pool];
    assert.ok(entry?.latest, `missing rungSeeds record for ${pool}`);
    assert.ok(Array.isArray(entry.history) && entry.history.length === 1);
    assert.equal(typeof entry.latest.at, 'string');
    assert.ok(!Number.isNaN(Date.parse(entry.latest.at)));
    assert.ok('by' in entry.latest);
    assert.equal(typeof entry.latest.via, 'string');
    assert.match(entry.latest.reason ?? '', /new pool/i);
    assert.ok(entry.latest.rungs?.high);
  }

  // `strategy rungs` shows filled models on agy and agy:claude, never tier-selection-empty.
  const rungs = await rungRows(home, { loaderOpts });
  const agyRungs = rungs.filter((r) => r.pool === 'agy' || r.pool === 'agy:claude');
  assert.equal(agyRungs.length, 6);
  assert.ok(agyRungs.every((r) => r.model !== null && r.modelSource !== 'tier-selection-empty'), JSON.stringify(agyRungs));

  // Route check and CLI `workflow plan validate` now accept a `providers: agy` build/high step.
  const afterPools = buildPools(home, NOW, {}, loaderOpts).pools;
  assert.deepEqual(routePoolIssues(routedAction, afterPools, { config: {} }, {}), []);

  const workspace = mkdtempSync(join(tmpdir(), 'bs-agy-ws-'));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  const planFile = join(workspace, 'plan.json');
  writeFileSync(planFile, JSON.stringify({
    schemaVersion: 'bullswarm.workflow.program.v3',
    steps: [{
      id: 'impl',
      lane: 'build',
      effort: 'high',
      files: ['out.txt'],
      route: { providers: { use: ['agy'] } },
      prompt: 'Write out.txt.',
    }],
  }, null, 2));
  const validated = spawnSync(
    process.execPath,
    [BIN, 'workflow', 'plan', 'validate', 'Write out.txt', '--program', planFile, '--cwd', workspace, '--json'],
    {
      encoding: 'utf8',
      env: { ...process.env, BULLSWARM_HOME: home, BULLSWARM_DISABLE_CLAUDE_PROFILES: '1' },
    },
  );
  assert.equal(validated.status, 0, validated.stderr + validated.stdout);
  assert.equal(JSON.parse(validated.stdout).action, 'plan-valid');

  // A second call finds no new unseeded pools and runs no discovery.
  let calls = 0;
  const second = await maybeRefreshStrategy(home, {
    loaderOpts,
    providerExecutors: { agy: async () => { calls += 1; return MODELS_TXT; } },
  });
  assert.equal(second, null);
  assert.equal(calls, 0);
});

test('G: autoSetup and refreshStrategy also seed new agy pools without touching existing approved picks', async (t) => {
  // 1. autoSetup path
  const setupHome = upgradedHome(t);
  const entry = (name, pools, discovered) => ({
    file: name, name, displayName: name, tier: 'first-class', enabled: true, pools, skipped: [], error: null,
    broken: false, shadowed: false, bin: name, health: 'default', installed: discovered, loggedIn: discovered,
    hint: null, discovered, meter: 'reader', costRank: 2, lanes: ['analyze', 'build', 'chore'], lanesSource: 'connector',
    testFixture: false,
  });
  setup.autoSetup(setupHome, {
    reason: 'auto',
    loaderOpts: loaderFor(setupHome),
    discover: () => [
      entry('existing', ['existing'], true),
      entry('agy', ['agy', 'agy:claude'], true),
    ],
  });
  const afterSetup = loadState(setupHome);
  assert.deepEqual(afterSetup.strategy.modelTiers.existing, {
    'existing-v1': ['high'],
    'existing-mid': ['medium'],
    'existing-lite': ['low'],
  });
  assert.deepEqual(afterSetup.strategy.modelTiers.agy, {
    'gemini-4-carbon': ['high'],
    'gemini-4-hydrogen': ['medium'],
    'gemini-3.8-flash': ['low'],
  });
  assert.deepEqual(afterSetup.strategy.modelTiers['agy:claude'], {
    'claude-opus-4-6-thinking': ['high'],
    'claude-sonnet-4-6': ['medium'],
    'gpt-oss-120b-medium': ['low'],
  });
  assert.equal(afterSetup.strategy.rungSeeds?.agy?.latest?.via, 'auto-setup');
  assert.equal(afterSetup.strategy.rungSeeds?.['agy:claude']?.latest?.via, 'auto-setup');

  // 2. Direct refreshStrategy (without --apply) path
  const refreshHome = upgradedHome(t);
  await refreshStrategy(refreshHome, {
    loaderOpts: loaderFor(refreshHome),
    executor: () => '',
    providerExecutors: { agy: async () => MODELS_TXT },
    getReadings: async () => ({}),
  });
  const afterRefresh = loadState(refreshHome);
  assert.deepEqual(afterRefresh.strategy.modelTiers.existing, {
    'existing-v1': ['high'],
    'existing-mid': ['medium'],
    'existing-lite': ['low'],
  });
  assert.deepEqual(afterRefresh.strategy.modelTiers.agy, {
    'gemini-4-carbon': ['high'],
    'gemini-4-hydrogen': ['medium'],
    'gemini-3.8-flash': ['low'],
  });
  assert.equal(afterRefresh.strategy.rungSeeds?.agy?.latest?.via, 'strategy-refresh');
});

test('G: a step naming its own model satisfies route and pinned-pool checks even when the pool tier is empty', (t) => {
  const home = upgradedHome(t);
  const pools = buildPools(home, NOW, {}, loaderFor(home)).pools;

  // Pool agy has no model assigned on high yet, so an unnamed high step is refused.
  assert.equal(
    routePoolIssues([{ id: 'impl', lane: 'build', effort: 'high', route: { providers: { use: ['agy'] } } }], pools, { config: {} }, {}).length,
    1,
  );
  assert.equal(
    pinnedPoolIssues({ config: { workerRouting: { strictPool: 'agy' } } }, { actions: [{ id: 'impl', lane: 'build', effort: 'high' }] }, pools).length,
    1,
  );

  // Naming a model agy can run (`gemini-4-carbon`, or `claude-opus-4-6-thinking` on agy:claude) satisfies both checks.
  assert.deepEqual(
    routePoolIssues(
      [{ id: 'impl', lane: 'build', effort: 'high', model: 'gemini-4-carbon', route: { providers: { use: ['agy'] } } }],
      pools,
      { config: {} },
      {},
    ),
    [],
  );
  assert.deepEqual(
    routePoolIssues(
      [{ id: 'impl', lane: 'build', effort: 'high', model: 'claude-opus-4-6-thinking', route: { providers: { use: ['agy'] } } }],
      pools,
      { config: {} },
      {},
    ),
    [],
  );
  assert.deepEqual(
    pinnedPoolIssues(
      { config: { workerRouting: { strictPool: 'agy' } } },
      { actions: [{ id: 'impl', lane: 'build', effort: 'high', model: 'gemini-4-carbon' }] },
      pools,
    ),
    [],
  );

  // A step model the pinned/routed pool CANNOT run is still refused.
  assert.equal(
    pinnedPoolIssues(
      { config: { workerRouting: { strictPool: 'agy' } } },
      { actions: [{ id: 'impl', lane: 'build', effort: 'high', model: 'claude-opus-4-6-thinking' }] },
      pools,
    ).length,
    1,
  );
});
