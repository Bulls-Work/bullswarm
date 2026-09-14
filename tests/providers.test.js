import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  loadProviders, providerFor, ownsPoolName, readProvidersConfig, loadTemplates, providerDirs,
} from '../src/lib/providers.js';
import * as kit from '../src/provider-kit.js';

const FIXTURES = fileURLToPath(new URL('./fixtures/providers/', import.meta.url));

function fixtureHome() {
  const home = mkdtempSync(join(tmpdir(), 'bullswarm-providers-'));
  return { home, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

function dirs(home, extra = {}) {
  return {
    firstClass: join(FIXTURES, 'first-class'),
    contrib: join(FIXTURES, 'contrib'),
    local: join(FIXTURES, 'local'),
    legacy: join(home, 'connectors'),
    ...extra,
  };
}

const entry = (providers, name) => providers.find((p) => p.name === name);

test('tiers load first-class, contrib, local in that order', () => {
  const { home, cleanup } = fixtureHome();
  try {
    const { providers } = loadProviders(home, { dirs: dirs(home), enabled: ['relaykit', 'sidecar'] });
    const tiers = providers.map((p) => p.tier);
    const firstLocal = tiers.indexOf('local');
    assert.ok(tiers.lastIndexOf('first-class') < tiers.indexOf('contrib'));
    assert.ok(tiers.lastIndexOf('contrib') < firstLocal);
    assert.deepEqual(
      providers.filter((p) => p.tier === 'first-class').map((p) => p.dir.split('/').pop()),
      ['broken-json', 'echo', 'opencode2'],
    );
  } finally { cleanup(); }
});

test('contrib providers load only when providers.json enables them', () => {
  const { home, cleanup } = fixtureHome();
  try {
    const off = loadProviders(home, { dirs: dirs(home) });
    assert.equal(entry(off.providers, 'relaykit').enabled, false);
    assert.deepEqual(entry(off.providers, 'relaykit').pools, []);
    assert.equal(off.connectors.relaykit, undefined);
    // A disabled contrib module still loads for list output, without connectors().
    assert.equal(entry(off.providers, 'sidecar').displayName, 'Sidecar');

    writeFileSync(join(home, 'providers.json'), JSON.stringify({ enabled: ['relaykit'] }));
    assert.deepEqual(readProvidersConfig(home).enabled, ['relaykit']);
    const on = loadProviders(home, { dirs: dirs(home) });
    assert.equal(entry(on.providers, 'relaykit').enabled, true);
    assert.deepEqual(entry(on.providers, 'relaykit').pools, ['relaykit']);
    assert.equal(on.connectors.relaykit.model, 'rk-1');
    assert.equal(on.connectors.sidecar, undefined);

    const probe = loadProviders(home, { dirs: dirs(home), allContrib: true });
    assert.equal(entry(probe.providers, 'sidecar').enabled, false);
    assert.deepEqual(entry(probe.providers, 'sidecar').pools, ['sidecar']);
  } finally { cleanup(); }
});

test('a malformed providers.json is nothing enabled, not a crash', () => {
  const { home, cleanup } = fixtureHome();
  try {
    writeFileSync(join(home, 'providers.json'), '{ nope');
    assert.deepEqual(readProvidersConfig(home).enabled, []);
    assert.doesNotThrow(() => loadProviders(home, { dirs: dirs(home) }));
  } finally { cleanup(); }
});

test('templates cover every shipped connector.json, enabled or not', () => {
  const { home, cleanup } = fixtureHome();
  try {
    const templates = loadTemplates(dirs(home));
    assert.deepEqual(Object.keys(templates).sort(), ['echo', 'opencode2', 'relaykit']);
    // sidecar is disabled here, but clones the disabled relaykit template when probed.
    const { connectors } = loadProviders(home, { dirs: dirs(home), enabled: ['sidecar'] });
    assert.deepEqual(connectors.sidecar.spawn.cmd, ['relaykit', '{taskFile}']);
    assert.equal(connectors.sidecar.flags.isCaller, false);
  } finally { cleanup(); }
});

test('the relay reseller example yields prefixed pools with variants and a meter', async () => {
  const { home, cleanup } = fixtureHome();
  try {
    const { connectors, providers } = loadProviders(home, { dirs: dirs(home) });
    const relay = entry(providers, 'relay');
    assert.equal(relay.error, null);
    assert.equal(relay.tier, 'local');
    assert.equal(relay.displayName, 'Relay');
    assert.equal(relay.hasReadUsage, true);
    assert.equal(relay.hasDoctor, true);
    assert.deepEqual(relay.pools, ['relay', 'relay:b']);
    assert.deepEqual(connectors['relay:b'].spawn.cmd, ['opencode', 'run', '--auto', '--model', 'b/gpt-5.6-sol', '{taskFile}']);
    assert.equal(connectors['relay:b'].credentialGroup, 'relay:relay.example');
    assert.equal(connectors.relay.env.OPENCODE_CONFIG_CONTENT, kit.opencodeVariants('a', ['gpt-5.6-sol']));
    // The shared template is untouched by the clones.
    assert.deepEqual(connectors.opencode2.spawn.cmd, ['opencode', 'run', '--auto', '{taskFile}']);

    const owner = providerFor(providers, 'relay:b');
    const snap = await owner.module.readUsage('relay:b', {
      ...owner.ctx, subscription: { includedValueUsd: 50 },
    });
    assert.equal(snap.pool, 'relay:b');
    assert.equal(snap.used_usd, 12.5);
    assert.equal(snap.monthly.utilization, 25);
    assert.equal(owner.ctx.kit.snapshot, kit.snapshot);
    assert.equal(owner.ctx.bullswarmDir, home);
  } finally { cleanup(); }
});

test('pools outside the provider prefix are skipped and recorded', () => {
  const { home, cleanup } = fixtureHome();
  try {
    const { connectors, providers } = loadProviders(home, { dirs: dirs(home) });
    const squatter = entry(providers, 'squatter');
    assert.equal(squatter.error, null);
    assert.deepEqual(squatter.pools, ['squatter:ok']);
    assert.equal(connectors.squatterx, undefined);
    assert.ok(squatter.skipped.some((s) => s.pool === 'squatterx' && s.reason === 'prefix'));
    assert.ok(squatter.skipped.some((s) => s.pool === null && s.reason === 'invalid'));

    assert.equal(ownsPoolName('relay', 'relay'), true);
    assert.equal(ownsPoolName('relay', 'relay:a'), true);
    assert.equal(ownsPoolName('relay', 'relay:'), false);
    assert.equal(ownsPoolName('relay', 'relayx'), false);
    assert.equal(ownsPoolName('relay', 'relay-2'), false);
  } finally { cleanup(); }
});

test('an existing pool name is never overwritten', () => {
  const { home, cleanup } = fixtureHome();
  try {
    const { connectors, providers } = loadProviders(home, { dirs: dirs(home) });
    assert.equal(entry(providers, 'opencode2').tier, 'first-class');
    // squatter (local) cannot claim opencode2 (prefix) — a local provider named
    // opencode2 through the legacy dir cannot overwrite it either.
    mkdirSync(join(home, 'connectors'));
    writeFileSync(join(home, 'connectors', 'opencode2.json'), JSON.stringify({ name: 'opencode2', model: 'legacy-copy' }));
    writeFileSync(join(home, 'connectors', 'mine.json'), JSON.stringify({ name: 'mine', model: 'm' }));
    const again = loadProviders(home, { dirs: dirs(home) });
    assert.equal(again.connectors.opencode2.model, 'default');
    const legacyCopy = again.providers.find((p) => p.dir.endsWith('connectors/opencode2.json'));
    assert.equal(legacyCopy.tier, 'local');
    assert.deepEqual(legacyCopy.pools, []);
    assert.equal(legacyCopy.skipped[0].reason, 'duplicate');
    assert.match(legacyCopy.skipped[0].message, /already defined by provider "opencode2"/);
    assert.equal(again.connectors.mine.model, 'm');
    assert.equal(connectors.opencode2.model, 'default');
  } finally { cleanup(); }
});

test('a broken provider is recorded, never thrown', () => {
  const { home, cleanup } = fixtureHome();
  try {
    let result;
    assert.doesNotThrow(() => { result = loadProviders(home, { dirs: dirs(home) }); });
    const { providers, connectors } = result;
    assert.match(entry(providers, 'thrower').error, /thrower exploded/);
    assert.deepEqual(entry(providers, 'thrower').pools, []);
    assert.ok(providers.find((p) => p.dir.endsWith('broken-json')).error);
    assert.match(providers.find((p) => p.dir.endsWith('/tla')).error, /./);
    assert.match(providers.find((p) => p.dir.endsWith('/nameless')).error, /export a non-empty string `name`/);
    // Good providers after the broken ones still load.
    assert.ok(connectors.relay);
    assert.ok(connectors['squatter:ok']);
  } finally { cleanup(); }
});

test('a provider mutating its templates cannot change what the next provider clones', () => {
  const { home, cleanup } = fixtureHome();
  const local = mkdtempSync(join(tmpdir(), 'bullswarm-providers-local-'));
  try {
    mkdirSync(join(local, 'aaa-mutator'));
    writeFileSync(join(local, 'aaa-mutator', 'provider.mjs'), [
      "export const name = 'mutator';",
      'export function connectors({ templates }) { templates.opencode2.spawn.cmd.push("--evil"); return []; }',
    ].join('\n'));
    cpSync(join(FIXTURES, 'local', 'relay'), join(local, 'relay'), { recursive: true });
    const { connectors } = loadProviders(home, { dirs: dirs(home, { local }) });
    assert.ok(!connectors.relay.spawn.cmd.includes('--evil'));
    assert.ok(!connectors.opencode2.spawn.cmd.includes('--evil'));
  } finally { cleanup(); rmSync(local, { recursive: true, force: true }); }
});

test('json-only providers load one pool from connector.json', () => {
  const { home, cleanup } = fixtureHome();
  try {
    const { connectors, providers } = loadProviders(home, { dirs: dirs(home) });
    const echo = entry(providers, 'echo');
    assert.equal(echo.error, null);
    assert.equal(echo.hasReadUsage, false);
    assert.equal(echo.hasDoctor, false);
    assert.equal(echo.displayName, 'echo');
    assert.deepEqual(echo.pools, ['echo']);
    assert.equal(connectors.echo.flags.testFixture, true);
    // Entries serialize to the contract fields only.
    assert.deepEqual(Object.keys(JSON.parse(JSON.stringify(echo))).sort(), [
      'dir', 'displayName', 'enabled', 'error', 'hasDoctor', 'hasReadUsage', 'name', 'pools', 'skipped', 'tier',
    ]);
  } finally { cleanup(); }
});

test('under node:test the real local providers dir is skipped unless named', () => {
  const { home, cleanup } = fixtureHome();
  try {
    assert.ok(process.env.NODE_TEST_CONTEXT);
    cpSync(join(FIXTURES, 'local', 'relay'), join(home, 'providers', 'relay'), { recursive: true });
    const implicit = { firstClass: join(FIXTURES, 'first-class'), contrib: join(FIXTURES, 'contrib') };
    const skipped = loadProviders(home, { dirs: implicit });
    assert.equal(entry(skipped.providers, 'relay'), undefined);
    assert.equal(providerDirs(home).local, join(home, 'providers'));
    const named = loadProviders(home, { dirs: { ...implicit, local: join(home, 'providers') } });
    assert.deepEqual(entry(named.providers, 'relay').pools, ['relay', 'relay:b']);
  } finally { cleanup(); }
});

test('providerFor resolves the owning provider by loaded pools, then longest prefix', () => {
  const providers = [
    { name: 'relay', pools: ['relay'] },
    { name: 'relay:eu', pools: [] },
    { name: 'codex', pools: ['codex', 'codex:work'] },
  ];
  assert.equal(providerFor(providers, 'codex:work').name, 'codex');
  assert.equal(providerFor(providers, { name: 'relay' }).name, 'relay');
  assert.equal(providerFor(providers, 'relay:b').name, 'relay');
  assert.equal(providerFor(providers, 'relay:eu:2').name, 'relay:eu');
  assert.equal(providerFor(providers, 'relayx'), null);
  assert.equal(providerFor(providers, null), null);
  assert.equal(providerFor(null, 'relay'), null);
});
