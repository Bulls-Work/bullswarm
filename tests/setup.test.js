import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  Prompter,
  suggestRoutingTable,
  applyIntegrationBlock,
  integrationBlockPresent,
  upgradeConnectorMetadata,
  migrateTestFixturePools,
  autoSetup,
  ensureSetup,
  configureTierRungs,
} from '../src/setup.js';
import { loadState, saveState } from '../src/lib/state.js';

function tmp() {
  const d = mkdtempSync(join(tmpdir(), 'bullswarm-setup-'));
  return { d, cleanup: () => rmSync(d, { recursive: true, force: true }) };
}

test('routing table suggestion covers lanes from enabled pools', () => {
  const t = suggestRoutingTable([
    { name: 'codex', lanes: ['analyze', 'build', 'chore'] },
    { name: 'grok', lanes: ['build', 'chore'] },
    { name: 'command-code', lanes: ['build', 'chore'] },
  ]);
  assert.deepEqual(t.analyze.order, ['codex']); // command-code cannot serve analyze
  assert.ok(t.build.order.includes('grok'));
  assert.equal(t.chore.fallback, 'caller');
});

test('auto setup never enables the packaged echo test fixture', () => {
  const { d, cleanup } = tmp();
  try {
    const result = autoSetup(d, { reason: 'test' });
    const state = JSON.parse(readFileSync(join(d, 'state.json'), 'utf8'));
    assert.equal(result.enabledPools.includes('echo'), false);
    assert.equal(state.pools.echo.enabled, false);
    assert.equal(state.config.testFixturesMigrated, true);
  } finally { cleanup(); }
});

test('setup prompt cleanup is safe after per-question readline cleanup', () => {
  const prompt = new Prompter();
  assert.doesNotThrow(() => prompt.close());
});

function legacyEchoHome(poolEntry) {
  const { d, cleanup } = tmp();
  mkdirSync(join(d, 'connectors'), { recursive: true });
  writeFileSync(join(d, 'connectors', 'echo.json'), `${JSON.stringify({
    name: 'echo', flags: { stealth: false }, lanes: ['analyze', 'build', 'chore'],
  }, null, 2)}\n`);
  writeFileSync(join(d, 'state.json'), `${JSON.stringify({
    version: 1, pools: { echo: poolEntry }, config: {},
  }, null, 2)}\n`);
  return { d, cleanup };
}

test('existing installs migrate an unset echo fixture once', () => {
  // No explicit `enabled` in state.json: a legacy default the migration owns.
  const { d, cleanup } = legacyEchoHome({});
  try {
    ensureSetup(d);
    let state = JSON.parse(readFileSync(join(d, 'state.json'), 'utf8'));
    assert.equal(state.pools.echo.enabled, false);
    assert.equal(state.config.testFixturesMigrated, true);

    state.pools.echo.enabled = true;
    writeFileSync(join(d, 'state.json'), `${JSON.stringify(state, null, 2)}\n`);
    ensureSetup(d);
    state = JSON.parse(readFileSync(join(d, 'state.json'), 'utf8'));
    assert.equal(state.pools.echo.enabled, true, 'later explicit choice is preserved');
  } finally { cleanup(); }
});

test('the fixture migration never overrides an explicit enabled: true (D1)', () => {
  const { d, cleanup } = legacyEchoHome({ enabled: true });
  try {
    ensureSetup(d);
    const state = JSON.parse(readFileSync(join(d, 'state.json'), 'utf8'));
    assert.equal(state.pools.echo.enabled, true, 'the operator said yes; the migration is not a veto');
    assert.equal(state.config.testFixturesMigrated, true, 'the migration still runs exactly once');
  } finally { cleanup(); }
});

test('the fixture migration leaves an explicit enabled: false alone too', () => {
  const { d, cleanup } = legacyEchoHome({ enabled: false });
  try {
    const disabled = migrateTestFixturePools(d);
    assert.deepEqual(disabled, [], 'nothing was changed, so nothing is reported as changed');
    const state = JSON.parse(readFileSync(join(d, 'state.json'), 'utf8'));
    assert.equal(state.pools.echo.enabled, false);
    assert.equal(state.config.testFixturesMigrated, true);
  } finally { cleanup(); }
});

test('connector metadata upgrades add packaged capabilities without removing custom ones', () => {
  const { d, cleanup } = tmp();
  try {
    const dir = join(d, 'connectors');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'grok.json'), `${JSON.stringify({
      name: 'grok', capabilities: ['custom-local-capability'],
    }, null, 2)}\n`);
    assert.deepEqual(upgradeConnectorMetadata(d), ['grok.json']);
    const installed = JSON.parse(readFileSync(join(dir, 'grok.json'), 'utf8'));
    assert.ok(installed.capabilities.includes('custom-local-capability'));
    assert.ok(installed.capabilities.includes('workflow-planning'));
    assert.equal(installed.eventStream.format, 'jsonl');
    assert.equal(installed.outputExtraction.strategy, 'event-stream');
    assert.deepEqual(installed.conversation.resumeArgs, ['--resume', '{sessionId}']);
    assert.deepEqual(upgradeConnectorMetadata(d), []);
  } finally { cleanup(); }
});

test('connector metadata upgrades model paths without replacing custom event rules', () => {
  const { d, cleanup } = tmp();
  try {
    const dir = join(d, 'connectors');
    mkdirSync(dir, { recursive: true });
    const customRules = [{ rootMatch: { path: 'custom', equals: true }, kind: 'custom' }];
    writeFileSync(join(dir, 'claude-code.json'), `${JSON.stringify({
      name: 'claude-code',
      capabilities: ['strong-analysis', 'code-reading', 'file-editing', 'workflow-planning'],
      authSignatures: ['custom-auth-marker'],
      eventStream: { format: 'jsonl', args: ['--custom-stream'], rules: customRules },
      modelDiscovery: {}, knownModels: [], modelProfiles: [], modelSelection: {}, subscription: {},
    }, null, 2)}\n`);
    assert.deepEqual(upgradeConnectorMetadata(d), ['claude-code.json']);
    const installed = JSON.parse(readFileSync(join(dir, 'claude-code.json'), 'utf8'));
    assert.deepEqual(installed.eventStream.modelPaths, ['model', 'message.model']);
    assert.deepEqual(installed.eventStream.args, ['--custom-stream']);
    assert.deepEqual(installed.eventStream.rules, customRules);
    assert.ok(installed.authSignatures.includes('custom-auth-marker'));
    assert.ok(installed.authSignatures.includes('failed to authenticate'));
  } finally { cleanup(); }
});

test('connector metadata upgrades add packaged quota signatures additively', () => {
  const { d, cleanup } = tmp();
  try {
    const dir = join(d, 'connectors');
    mkdirSync(dir, { recursive: true });
    // An installation that predates the `quota` failure kind: no field at all.
    writeFileSync(join(dir, 'claude-code.json'), `${JSON.stringify({
      name: 'claude-code',
      capabilities: ['strong-analysis', 'code-reading', 'file-editing', 'workflow-planning'],
      authSignatures: ['unauthorized', 'authentication failed', 'failed to authenticate',
        'credit balance', 'not logged in', 'please run /login'],
      quotaSignatures: ['my-own-limit-phrase'],
      eventStream: { format: 'jsonl', args: ['--custom'], rules: [], modelPaths: ['model', 'message.model'] },
    }, null, 2)}\n`);
    assert.deepEqual(upgradeConnectorMetadata(d), ['claude-code.json']);
    const installed = JSON.parse(readFileSync(join(dir, 'claude-code.json'), 'utf8'));
    assert.ok(installed.quotaSignatures.includes('my-own-limit-phrase'), 'user phrase kept');
    assert.ok(installed.quotaSignatures.includes('hit your session limit'), 'packaged phrase added');
    assert.deepEqual(upgradeConnectorMetadata(d), [], 'idempotent');
  } finally { cleanup(); }
});

test('connector metadata upgrades backfill quota signatures onto a connector that has none', () => {
  const { d, cleanup } = tmp();
  try {
    const dir = join(d, 'connectors');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'codex.json'), `${JSON.stringify({ name: 'codex' }, null, 2)}\n`);
    assert.deepEqual(upgradeConnectorMetadata(d), ['codex.json']);
    const installed = JSON.parse(readFileSync(join(dir, 'codex.json'), 'utf8'));
    assert.ok(Array.isArray(installed.quotaSignatures));
    assert.ok(installed.quotaSignatures.includes('usage_credits_required'));
    assert.deepEqual(upgradeConnectorMetadata(d), [], 'idempotent');
  } finally { cleanup(); }
});

test('connector metadata upgrades additive provider concurrency preferences', () => {
  const { d, cleanup } = tmp();
  try {
    const dir = join(d, 'connectors');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'opencode2.json'), `${JSON.stringify({
      name: 'opencode2', capabilities: ['custom-local-capability'],
    }, null, 2)}\n`);
    assert.deepEqual(upgradeConnectorMetadata(d), ['opencode2.json']);
    const installed = JSON.parse(readFileSync(join(dir, 'opencode2.json'), 'utf8'));
    assert.equal(installed.preferredConcurrency, 1);
    assert.ok(installed.capabilities.includes('custom-local-capability'));
    assert.deepEqual(upgradeConnectorMetadata(d), []);
  } finally { cleanup(); }
});

test('connector metadata upgrades expensive-model recommendation guards idempotently', () => {
  const { d, cleanup } = tmp();
  try {
    const dir = join(d, 'connectors');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'opencode2.json'), `${JSON.stringify({
      name: 'opencode2',
      capabilities: ['strong-analysis', 'code-reading', 'file-editing', 'workflow-planning'],
      modelProfiles: [
        { match: '(?:fable|opus|gpt-5\\.6-sol)', tier: 'high', qualityRank: 5 },
      ],
    }, null, 2)}\n`);
    assert.deepEqual(upgradeConnectorMetadata(d), ['opencode2.json']);
    const installed = JSON.parse(readFileSync(join(dir, 'opencode2.json'), 'utf8'));
    assert.equal(installed.modelProfiles[0].match, '(?:^|/)claude-fable-');
    assert.equal(installed.modelProfiles[0].autoRecommend, false);
    assert.equal(installed.modelProfiles[1].match, 'gpt-5\\.6-sol$');
    assert.equal(installed.modelProfiles[1].autoRecommend, true);
    assert.deepEqual(upgradeConnectorMetadata(d), []);
  } finally { cleanup(); }
});

test('integration block: approval required, idempotent markers', () => {
  const { d, cleanup } = tmp();
  try {
    const file = join(d, 'CLAUDE.md');
    writeFileSync(file, '# My config\n\nexisting content\n');

    const denied = applyIntegrationBlock(file, { approved: false });
    assert.equal(denied.changed, false);

    applyIntegrationBlock(file, { approved: true });
    let text = readFileSync(file, 'utf8');
    assert.match(text, /bullswarm:begin v3/);
    assert.match(text, /bullswarm run/);
    assert.match(text, /BULLSWARM_DEPTH/);
    assert.match(text, /existing content/); // preserved

    // idempotent re-run: no duplicate blocks
    const before = (text.match(/bullswarm:begin/g) ?? []).length;
    void before;
    applyIntegrationBlock(file, { approved: false }); // present -> skip
    // force re-check through the public API:
    assert.equal(integrationBlockPresent(file), true);

    // manual double-apply must not duplicate either
    applyIntegrationBlock(file, { approved: true });
    text = readFileSync(file, 'utf8');
    const count = (text.match(/bullswarm:begin v3/g) ?? []).length;
    // second approved apply strips the old block first — exactly one remains
    assert.equal(count, 1);
    assert.match(text, /existing content/);
  } finally {
    cleanup();
  }
});

test('integration block creates parent dirs for new AGENTS.md', () => {
  const { d, cleanup } = tmp();
  try {
    const file = join(d, 'sub', 'AGENTS.md');
    applyIntegrationBlock(file, { approved: true });
    assert.equal(existsSync(file), true);
    assert.match(readFileSync(file, 'utf8'), /bullswarm:begin v3/);
  } finally {
    cleanup();
  }
});

// --- reasoning depth ---------------------------------------------------------

function scriptedPrompter(answers) {
  const asked = [];
  return {
    asked,
    question(prompt) {
      asked.push(prompt);
      return Promise.resolve(answers.shift() ?? '');
    },
  };
}

test('the wizard tier step asks one reasoning question per tier and Enter keeps the connector default', async () => {
  const { d, cleanup } = tmp();
  try {
    autoSetup(d, { reason: 'test' });
    const prompter = scriptedPrompter(['LOW', '', 'max']);
    const stored = await configureTierRungs(d, prompter, { log: () => {}, evidence: null });

    assert.deepEqual(prompter.asked, [
      'Reasoning for high [Enter keeps the connector default]: ',
      'Reasoning for medium [Enter keeps the connector default]: ',
      'Reasoning for low [Enter keeps the connector default]: ',
    ]);
    // A typed answer wins (case-insensitively); a blank answer stores NOTHING,
    // which is what leaves the connector's own per-tier default in charge.
    assert.deepEqual(stored.tiers, { high: 'low', low: 'max' });
    assert.deepEqual(loadState(d).strategy.reasoning, {
      tiers: { high: 'low', low: 'max' }, pools: {},
    });
  } finally { cleanup(); }
});

test('an unrecognized wizard answer keeps the connector default instead of storing junk', async () => {
  const { d, cleanup } = tmp();
  try {
    autoSetup(d, { reason: 'test' });
    const notes = [];
    const stored = await configureTierRungs(d, scriptedPrompter(['ludicrous', 'max', 'default']), {
      log: (line) => notes.push(line),
      evidence: null,
    });
    // `default` is no longer offered by this question: Enter already means
    // "let the connector decide", so anything off the five-level scale is
    // reported and dropped rather than stored.
    assert.deepEqual(stored.tiers, { medium: 'max' });
    assert.ok(notes.some((line) => /"ludicrous" is not a reasoning level/.test(line)));
    assert.ok(notes.some((line) => /"default" is not a reasoning level/.test(line)));
  } finally { cleanup(); }
});

test('the wizard answer survives the strategy step writing state through its own loader', async () => {
  const { d, cleanup } = tmp();
  try {
    autoSetup(d, { reason: 'test' });
    // Simulate the strategy autopilot question having persisted assignments
    // after the wizard loaded its own copy of state.
    const state = loadState(d);
    state.strategy = { assignments: { high: { pool: 'codex', model: 'gpt-5.6-sol' } } };
    saveState(d, state);
    await configureTierRungs(d, scriptedPrompter(['max', 'high', 'low']), {
      log: () => {}, evidence: null,
    });
    const saved = loadState(d);
    assert.deepEqual(saved.strategy.assignments.high, { pool: 'codex', model: 'gpt-5.6-sol' });
    assert.deepEqual(saved.strategy.reasoning.tiers, { high: 'max', medium: 'high', low: 'low' });
  } finally { cleanup(); }
});

test('the tier step asks only about configured tiers and shows each rung with its evidence line', async () => {
  const { d, cleanup } = tmp();
  try {
    autoSetup(d, { reason: 'test' });
    // Enable the packaged echo fixture and give it a configured low rung, so
    // the step has exactly one real rung to display and one tier to ask about.
    const state = loadState(d);
    state.pools.echo = { enabled: true };
    state.strategy = {
      configuredTiers: ['low'],
      modelTiers: { echo: { 'echo-local': ['low'] } },
    };
    saveState(d, state);

    const lines = [];
    const prompter = scriptedPrompter(['high']);
    const stored = await configureTierRungs(d, prompter, {
      log: (line) => lines.push(line),
      // Exactly the pair src/lib/epoch-benchmarks.js will export.
      evidence: {
        datapack: { models: { 'echo-local': {} } },
        rungEvidence: (datapack, { model }) => (datapack.models[model]
          ? { blended: 0.42, costPerTask: 0.13, tokensPerTask: 24_500 }
          : null),
      },
    });

    assert.deepEqual(prompter.asked, ['Reasoning for low [Enter keeps the connector default]: ']);
    assert.deepEqual(stored.tiers, { low: 'high' });
    const rung = lines.find((line) => line.includes('echo/echo-local'));
    assert.ok(rung, `no rung line printed; got ${JSON.stringify(lines)}`);
    assert.match(rung, /^ {4}low {4}echo\/echo-local {2}reasoning connector default \(unsupported\) {2}blended 0\.42 · \$0\.13\/task · 24\.5k tok\/task$/);
  } finally { cleanup(); }
});

test('the tier step prints no evidence text for a rung the datapack does not cover', async () => {
  const { d, cleanup } = tmp();
  try {
    autoSetup(d, { reason: 'test' });
    const state = loadState(d);
    state.pools.echo = { enabled: true };
    state.strategy = {
      configuredTiers: ['low'],
      modelTiers: { echo: { 'echo-local': ['low'] } },
    };
    saveState(d, state);
    const lines = [];
    await configureTierRungs(d, scriptedPrompter(['']), {
      log: (line) => lines.push(line),
      evidence: () => null,
    });
    const rung = lines.find((line) => line.includes('echo/echo-local'));
    assert.equal(rung, '    low    echo/echo-local  reasoning connector default (unsupported)');
  } finally { cleanup(); }
});

test('connector metadata upgrades backfill a packaged reasoning block without touching a custom one', () => {
  const { d, cleanup } = tmp();
  try {
    const packagedDir = join(d, 'packaged');
    const installedDir = join(d, 'connectors');
    mkdirSync(packagedDir, { recursive: true });
    mkdirSync(installedDir, { recursive: true });
    const block = {
      flag: '--effort',
      levels: ['low', 'medium', 'high', 'xhigh', 'max'],
      defaults: { high: 'xhigh', medium: 'high', low: 'medium' },
      skipModels: ['^claude-haiku-'],
    };
    writeFileSync(join(packagedDir, 'deep.json'), `${JSON.stringify({
      name: 'deep', reasoning: block, '$comment-reasoning': 'verified against the CLI',
    }, null, 2)}\n`);
    writeFileSync(join(packagedDir, 'custom.json'), `${JSON.stringify({
      name: 'custom', reasoning: block, '$comment-reasoning': 'verified against the CLI',
    }, null, 2)}\n`);
    // One installation predates the reasoning block entirely; the other has a
    // hand-edited one that must survive the upgrade untouched.
    writeFileSync(join(installedDir, 'deep.json'), `${JSON.stringify({ name: 'deep' }, null, 2)}\n`);
    const mine = { flag: '--effort', levels: ['low', 'high'], defaults: { high: 'high' } };
    writeFileSync(join(installedDir, 'custom.json'), `${JSON.stringify({
      name: 'custom', reasoning: mine,
    }, null, 2)}\n`);

    // Only the installation that was missing the block is rewritten at all.
    assert.deepEqual(upgradeConnectorMetadata(d, { packagedDir }), ['deep.json']);
    const deep = JSON.parse(readFileSync(join(installedDir, 'deep.json'), 'utf8'));
    assert.deepEqual(deep.reasoning, block);
    assert.equal(deep['$comment-reasoning'], 'verified against the CLI');
    const custom = JSON.parse(readFileSync(join(installedDir, 'custom.json'), 'utf8'));
    assert.deepEqual(custom.reasoning, mine, 'a customized block is never overwritten');
    assert.equal(custom['$comment-reasoning'], undefined, 'and gains no comment about a block it does not have');

    assert.deepEqual(upgradeConnectorMetadata(d, { packagedDir }), [], 'idempotent');
  } finally { cleanup(); }
});
