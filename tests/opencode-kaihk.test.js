import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  RELAY_OPENCODE_MODEL,
  discoverRelayProviders,
  expandOpenCodeRelayConnectors,
  isRelayBaseUrl,
  relayUpstreamGroup,
  relayVariantsConfig,
  poolNameForRelayProvider,
  retargetOpenCodeModel,
} from '../src/lib/opencode-relay.js';
import { expandClaudeAccountConnectors } from '../src/lib/claude-accounts.js';
import { parseRelayUsage } from '../src/meters/relay.js';
import { resolveReasoningLevel, reasoningArgs } from '../src/lib/reasoning.js';
import { argvWithModel } from '../src/lib/watch.js';
import { rungsFor } from '../src/lib/strategy.js';

const baseConnector = JSON.parse(readFileSync(new URL('../connectors/opencode2.json', import.meta.url), 'utf8'));

test('Relay host detection and pool naming', () => {
  assert.equal(isRelayBaseUrl('https://api.relay.com/v1'), true);
  assert.equal(isRelayBaseUrl('https://api.openai.com/v1'), false);
  assert.equal(poolNameForRelayProvider('relay', 0), 'opencode2');
  assert.equal(poolNameForRelayProvider('relay-2', 1), 'opencode2:relay-2');
  assert.deepEqual(
    retargetOpenCodeModel(['opencode', 'run', '--model', 'relay/gpt-5.6-luna', '{taskFile}'], 'relay-2'),
    ['opencode', 'run', '--model', 'relay-2/gpt-5.6-luna', '{taskFile}'],
  );
  assert.deepEqual(
    retargetOpenCodeModel(['opencode', 'run', '--auto', '{taskFile}'], 'relay-2'),
    ['opencode', 'run', '--auto', '--model', 'relay-2/gpt-5.6-luna', '{taskFile}'],
  );
});

test('base OpenCode connector uses the installation default without Relay providers', () => {
  assert.equal(baseConnector.spawn.cmd.includes('--model'), false);
  assert.deepEqual(discoverRelayProviders({ providers: [] }), []);
  const connectors = { opencode2: structuredClone(baseConnector) };
  expandOpenCodeRelayConnectors(connectors, { providers: [] });
  assert.equal(connectors.opencode2.spawn.cmd.includes('--model'), false);
});

test('discoverRelayProviders reads OpenCode config, relay first', () => {
  const dir = mkdtempSync(join(tmpdir(), 'oc-relay-'));
  const configPath = join(dir, 'opencode.json');
  try {
    writeFileSync(configPath, JSON.stringify({
      provider: {
        'relay-3': {
          options: { baseURL: 'https://api.relay.com/v1', apiKey: 'sk-cccc' },
        },
        bai: {
          options: { baseURL: 'https://api.b.ai/v1', apiKey: 'sk-bbbb' },
        },
        relay: {
          options: { baseURL: 'https://api.relay.com/v1', apiKey: 'sk-aaaa' },
        },
        'relay-2': {
          options: { baseURL: 'https://api.relay.com/v1', apiKey: 'sk-bbbb2' },
          models: { 'gpt-5.6-sol': {}, 'gpt-5.6-luna': {}, 'gpt-5.5': {} },
        },
      },
    }));
    const found = discoverRelayProviders({ configPath });
    assert.deepEqual(found.map((p) => p.id), ['relay', 'relay-2', 'relay-3']);
    assert.deepEqual(found.map((p) => p.pool), ['opencode2', 'opencode2:relay-2', 'opencode2:relay-3']);
    assert.equal(found[1].command, 'opencode run --auto --model relay-2/gpt-5.6-luna');
    // The provider's own model list rides along; a provider without one is [].
    assert.deepEqual(found[1].models, ['gpt-5.6-sol', 'gpt-5.6-luna', 'gpt-5.5']);
    assert.deepEqual(found[0].models, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('expandOpenCodeRelayConnectors clones opencode2 per extra Relay provider', () => {
  const connectors = {
    opencode2: {
      name: 'opencode2',
      bin: 'opencode',
       spawn: { cmd: ['opencode', 'run', '--auto', '{taskFile}'] },
      flags: { stealth: false },
      meter: { type: 'none' },
    },
  };
  expandOpenCodeRelayConnectors(connectors, {
    providers: [
      { id: 'relay', pool: 'opencode2', command: 'opencode run --auto --model relay/gpt-5.6-luna', apiKey: 'sk-a' },
      { id: 'relay-2', pool: 'opencode2:relay-2', command: 'opencode run --auto --model relay-2/gpt-5.6-luna', apiKey: 'sk-b' },
    ],
  });
  assert.equal(connectors.opencode2.spawn.cmd.includes('relay/gpt-5.6-luna'), true);
  const extra = connectors['opencode2:relay-2'];
  assert.ok(extra);
  assert.equal(extra.name, 'opencode2:relay-2');
  assert.equal(extra.spawn.cmd.includes('relay-2/gpt-5.6-luna'), true);
  assert.equal(extra.flags.isCaller, false);
  assert.equal(extra.profile.providerId, 'relay-2');
});

test('every Relay pool declares the one upstream it shares, so auth failures bench them together', () => {
  // 2026-09-11: these three names front ONE relayed Codex OAuth pool. When it
  // was invalidated, a retry walked from one name to the next and burned both
  // attempts on the same dead credential.
  const connectors = expandPackaged();
  assert.equal(relayUpstreamGroup('https://api.relay.com/v1'), 'relay:api.relay.com');
  for (const name of ['opencode2', 'opencode2:relay-2', 'opencode2:relay-3']) {
    assert.equal(connectors[name].upstreamGroup, 'relay:api.relay.com', `${name} joins the group`);
  }
  // The host is part of the id: another relay is another group, never this one.
  assert.equal(relayUpstreamGroup('https://api.other-relay.example/v1'), 'relay:api.other-relay.example');
  // A Claude seat is a separate subscription with a separate credential and
  // must never be benched because a relay lost its token.
  const claude = { 'claude-code': { name: 'claude-code', bin: 'claude', spawn: { cmd: ['claude'] } } };
  expandClaudeAccountConnectors(claude, {
    accounts: [
      { slug: null, configDir: '/home/op/.claude', pool: 'claude-code', command: 'claude' },
      { slug: 'alt', configDir: '/home/op/.claude-alt', pool: 'claude-code:alt', command: 'claude' },
    ],
  });
  assert.ok(claude['claude-code:alt'], 'the second seat expanded');
  assert.equal(claude['claude-code:alt'].upstreamGroup, undefined);
  assert.equal(claude['claude-code'].upstreamGroup, undefined);
});

// --- reasoning: --variant + the injected opencode variants ------------------
// opencode drops `--variant` unless its CONFIG declares that variant for the
// model, so the connector's reasoning block is only true because the expansion
// injects the variants. Both halves are asserted here, against the REAL
// packaged connector, so neither can be changed without the other.

// The three providers the owner really has; no config file and no CLI is read.
const THREE_PROVIDERS = [
  { id: 'relay', pool: 'opencode2', command: 'opencode run --auto --model relay/gpt-5.6-luna', apiKey: 'sk-a' },
  { id: 'relay-2', pool: 'opencode2:relay-2', command: 'opencode run --auto --model relay-2/gpt-5.6-luna', apiKey: 'sk-b' },
  { id: 'relay-3', pool: 'opencode2:relay-3', command: 'opencode run --auto --model relay-3/gpt-5.6-luna', apiKey: 'sk-c' },
];

const expandPackaged = (opts = {}) => {
  const connectors = { opencode2: structuredClone(baseConnector), ...(opts.extra ?? {}) };
  if (opts.env) connectors.opencode2.env = opts.env;
  expandOpenCodeRelayConnectors(connectors, { providers: opts.providers ?? THREE_PROVIDERS });
  return connectors;
};

test('relayVariantsConfig is the exact opencode config opencode merges over the file', () => {
  assert.equal(
    relayVariantsConfig('relay-2'),
    '{"provider":{"relay-2":{"models":{"gpt-5.6-luna":{"variants":{"low":{"reasoningEffort":"low"},'
    + '"medium":{"reasoningEffort":"medium"},"high":{"reasoningEffort":"high"},'
    + '"xhigh":{"reasoningEffort":"xhigh"},"max":{"reasoningEffort":"max"}}}}}}}',
  );
  // The variant names are exactly the levels the connector declares, so a
  // level the rung table offers can never be one opencode would drop.
  const variants = JSON.parse(relayVariantsConfig('relay'))
    .provider.relay.models[RELAY_OPENCODE_MODEL].variants;
  assert.deepEqual(Object.keys(variants), baseConnector.reasoning.levels);
  for (const [level, spec] of Object.entries(variants)) {
    assert.deepEqual(spec, { reasoningEffort: level });
  }
  // The model is a parameter, not a constant baked into the string.
  assert.match(relayVariantsConfig('relay-3', 'gpt-5.6-sol'), /"models":\{"gpt-5\.6-sol"/);
  // A list declares the same five variants on EVERY model, so a rung that
  // moves a tier onto sol sends a --variant opencode forwards, not drops.
  const multi = JSON.parse(relayVariantsConfig('relay-2', ['gpt-5.6-sol', 'gpt-5.6-luna'])).provider['relay-2'].models;
  assert.deepEqual(Object.keys(multi), ['gpt-5.6-sol', 'gpt-5.6-luna']);
  assert.deepEqual(multi['gpt-5.6-sol'].variants, multi['gpt-5.6-luna'].variants);
  assert.deepEqual(multi['gpt-5.6-sol'].variants.medium, { reasoningEffort: 'medium' });
  // An empty or blank list falls back to the luna default rather than
  // declaring nothing (which would silently drop every --variant).
  assert.equal(relayVariantsConfig('relay-2', []), relayVariantsConfig('relay-2'));
  assert.equal(relayVariantsConfig('relay-2', ['', '  ']), relayVariantsConfig('relay-2'));
});

test('a pool whose provider lists several models carries variants for each of them', () => {
  const providers = THREE_PROVIDERS.map((p) => (p.id === 'relay-2'
    ? { ...p, models: ['gpt-5.6-sol', 'gpt-5.6-luna', 'gpt-5.5'] }
    : p));
  const connectors = expandPackaged({ providers });
  const relay2 = JSON.parse(connectors['opencode2:relay-2'].env.OPENCODE_CONFIG_CONTENT);
  assert.deepEqual(Object.keys(relay2.provider['relay-2'].models), ['gpt-5.6-sol', 'gpt-5.6-luna', 'gpt-5.5']);
  assert.deepEqual(relay2.provider['relay-2'].models['gpt-5.6-sol'].variants.medium, { reasoningEffort: 'medium' });
  // Siblings without a model list keep the luna-only default.
  assert.equal(connectors['opencode2:relay-3'].env.OPENCODE_CONFIG_CONTENT, relayVariantsConfig('relay-3'));
  assert.equal(connectors.opencode2.env.OPENCODE_CONFIG_CONTENT, relayVariantsConfig('relay'));
});

test('every Relay pool carries the variants for its OWN provider id', () => {
  const connectors = expandPackaged();
  const pools = ['opencode2', 'opencode2:relay-2', 'opencode2:relay-3'];
  const contents = pools.map((pool) => connectors[pool].env.OPENCODE_CONFIG_CONTENT);
  // Three providers, three DISTINCT strings: a clone that kept the base's
  // string would declare variants on a provider it never calls.
  assert.equal(new Set(contents).size, 3);
  for (const [index, pool] of pools.entries()) {
    const providerId = THREE_PROVIDERS[index].id;
    assert.equal(contents[index], relayVariantsConfig(providerId), pool);
    const parsed = JSON.parse(contents[index]);
    assert.deepEqual(Object.keys(parsed.provider), [providerId]);
    assert.deepEqual(
      parsed.provider[providerId].models[RELAY_OPENCODE_MODEL].variants.max,
      { reasoningEffort: 'max' },
    );
    // The injection is additive: the spawn model is still this pool's own.
    assert.ok(connectors[pool].spawn.cmd.includes(`${providerId}/${RELAY_OPENCODE_MODEL}`));
  }
});

test('an OPENCODE_CONFIG_CONTENT the operator set by hand is never overwritten', () => {
  const operator = '{"provider":{"relay":{"models":{"gpt-5.6-luna":{"variants":{"max":{"reasoningEffort":"xhigh"}}}}}}}';
  const connectors = expandPackaged({ env: { OPENCODE_CONFIG_CONTENT: operator, OPENCODE_THEME: 'dark' } });
  // Base and clones alike: the operator's answer survives the expansion.
  for (const pool of ['opencode2', 'opencode2:relay-2', 'opencode2:relay-3']) {
    assert.equal(connectors[pool].env.OPENCODE_CONFIG_CONTENT, operator, pool);
    assert.equal(connectors[pool].env.OPENCODE_THEME, 'dark', pool);
  }
  // An empty value is not an answer, so it is filled in.
  const blank = expandPackaged({ env: { OPENCODE_CONFIG_CONTENT: '  ' } });
  assert.equal(blank['opencode2:relay-2'].env.OPENCODE_CONFIG_CONTENT, relayVariantsConfig('relay-2'));
  // Other env the connector already carries is merged, not replaced.
  const other = expandPackaged({ env: { HTTP_PROXY: 'http://localhost:8080' } });
  assert.equal(other['opencode2:relay-3'].env.HTTP_PROXY, 'http://localhost:8080');
  assert.equal(other['opencode2:relay-3'].env.OPENCODE_CONFIG_CONTENT, relayVariantsConfig('relay-3'));
});

test('the packaged opencode2 reasoning block says --variant and the five levels', () => {
  assert.deepEqual(baseConnector.reasoning, {
    flag: '--variant',
    levels: ['low', 'medium', 'high', 'xhigh', 'max'],
    defaults: { high: 'high', medium: 'medium', low: 'low' },
  });
  // The block must name where its values came from AND why the flag works.
  assert.match(baseConnector['$comment-reasoning'], /verified 2026-09-09 against opencode 1\.18\.25/);
  assert.match(baseConnector['$comment-reasoning'], /OPENCODE_CONFIG_CONTENT/);
});

test('a medium/max dispatch on opencode2:relay-2 composes --variant max into the argv', () => {
  const connector = expandPackaged()['opencode2:relay-2'];
  const strategy = { reasoning: { tiers: {}, pools: { 'opencode2:relay-2': { medium: 'max' } } } };
  const model = 'relay-2/gpt-5.6-luna';
  const resolved = resolveReasoningLevel({ connector, tier: 'medium', model, strategy });
  assert.deepEqual(resolved, {
    requested: 'max', applied: 'max', source: 'strategy-pool', clamped: false,
  });
  assert.deepEqual(reasoningArgs(connector, resolved.applied), ['--variant', 'max']);

  const argv = argvWithModel(connector, { taskFile: '/tmp/task.md', cwd: '/repo' }, model, null, resolved);
  // The level lands after the positional task file, exactly where the shipped
  // event-stream flags already land — opencode's parser reads options either
  // side of the message.
  assert.deepEqual(argv, [
    'opencode', 'run', '--auto', '--model', 'relay-2/gpt-5.6-luna', '/tmp/task.md',
    '--variant', 'max', '--format', 'json',
  ]);
  console.log(`opencode2 medium/max argv: ${argv.join(' ')}`);

  // A level already pinned in the template is REPLACED, never duplicated.
  const pinned = structuredClone(connector);
  pinned.spawn.cmd = ['opencode', 'run', '--auto', '--variant', 'low', '{taskFile}'];
  const pinnedArgv = argvWithModel(pinned, { taskFile: '/tmp/task.md', cwd: '/repo' }, model, null, resolved);
  assert.equal(pinnedArgv.filter((arg) => arg === '--variant').length, 1);
  assert.deepEqual(pinnedArgv, [
    'opencode', 'run', '--auto', '--variant', 'max', '/tmp/task.md',
    '--model', 'relay-2/gpt-5.6-luna', '--format', 'json',
  ]);

  // The connector stops at max, so nothing on the common scale is clamped.
  for (const level of ['low', 'medium', 'high', 'xhigh', 'max']) {
    const row = resolveReasoningLevel({
      connector, tier: 'medium', model,
      strategy: { reasoning: { pools: { 'opencode2:relay-2': { medium: level } } } },
    });
    assert.deepEqual([row.applied, row.clamped], [level, false], level);
  }
});

test('the opencode2 rung reports a real reasoning source instead of unsupported', () => {
  const connectors = expandPackaged();
  const pools = Object.keys(connectors).map((name) => ({
    name, enabled: true, connector: connectors[name],
  }));
  const rows = rungsFor({
    pools,
    strategy: {
      configuredTiers: ['medium'],
      modelTiers: { 'opencode2:relay-2': { 'relay-2/gpt-5.6-luna': ['medium'] } },
      reasoning: { tiers: {}, pools: { 'opencode2:relay-2': { medium: 'max' } } },
    },
  });
  const row = rows.find((r) => r.pool === 'opencode2:relay-2');
  assert.equal(row.model, 'relay-2/gpt-5.6-luna');
  assert.deepEqual(row.reasoning, {
    applied: 'max', source: 'strategy-pool', requested: 'max', clamped: false,
  });
  // Every other Relay pool falls back to the connector default for the tier,
  // which is a supported answer too — `unsupported` is gone from the table.
  for (const other of rows.filter((r) => r.pool !== 'opencode2:relay-2')) {
    assert.deepEqual(
      [other.reasoning.applied, other.reasoning.source],
      ['medium', 'connector'],
      other.pool,
    );
  }
});

test('parseRelayUsage converts billing hundredths-of-a-dollar and token quota units', () => {
  const snap = parseRelayUsage({
    token: {
      data: {
        expires_at: 1790752330,
        name: 'Staging',
        total_used: 479,
        unlimited_quota: true,
      },
    },
    billingUsage: { total_usage: 0.0958 },
    billingSub: { access_until: 1790752330 },
    pool: 'opencode2:relay-2',
    includedUsd: 50,
  });
  assert.equal(snap.pool, 'opencode2:relay-2');
  assert.equal(snap.used_usd, 0.000958);
  assert.equal(snap.unlimited_quota, true);
  assert.ok(snap.monthly.utilization < 0.01);
  assert.equal(snap.monthly.resets_at, new Date(1790752330 * 1000).toISOString());
});
