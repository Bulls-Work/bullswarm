import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { cmdProvider } from '../src/provider-cli.js';

const FIXTURES = fileURLToPath(new URL('./fixtures/providers/', import.meta.url));

// A throwaway BULLSWARM_HOME with the loader pointed at the fixture tiers. The
// local tier is a copy-free override: tests that need their own local provider
// pass a directory of their own.
function fixture({ local = join(FIXTURES, 'local') } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'bullswarm-provider-cli-'));
  const loaderOpts = {
    dirs: {
      firstClass: join(FIXTURES, 'first-class'),
      contrib: join(FIXTURES, 'contrib'),
      local,
      legacy: join(home, 'connectors'),
    },
  };
  return { home, loaderOpts, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

async function run(f, args) {
  const out = [];
  const err = [];
  const code = await cmdProvider(args, {
    bullswarmDir: f.home,
    loaderOpts: f.loaderOpts,
    log: (line) => out.push(String(line)),
    error: (line) => err.push(String(line)),
  });
  return { code, stdout: out.join('\n'), stderr: err.join('\n') };
}

test('provider list shows every tier, loading state, pools, skips and load errors', async () => {
  const f = fixture();
  try {
    const json = await run(f, ['list', '--json']);
    assert.equal(json.code, 0, json.stderr);
    const report = JSON.parse(json.stdout);
    assert.equal(report.schemaVersion, 'bullswarm.provider.list.v1');
    const by = Object.fromEntries(report.providers.map((p) => [p.name, p]));

    assert.equal(by.echo.tier, 'first-class');
    assert.deepEqual(by.echo.pools, ['echo']);
    assert.equal(by.relaykit.tier, 'contrib');
    assert.equal(by.relaykit.enabled, false);
    assert.deepEqual(by.relaykit.pools, [], 'a contrib provider that is not enabled loads no pools');
    assert.equal(by.relay.tier, 'local');
    assert.deepEqual(by.relay.pools, ['relay', 'relay:b']);
    assert.equal(by.relay.hasReadUsage, true);
    assert.match(by.thrower.error, /thrower exploded/);
    // The prefix rule is checked first, so even the pool named after a
    // first-class provider is skipped as a prefix violation.
    assert.deepEqual(by.squatter.skipped.map((s) => s.reason).sort(), ['invalid', 'prefix', 'prefix']);
    assert.deepEqual(by.squatter.pools, ['squatter:ok']);

    const human = await run(f, ['list']);
    assert.equal(human.code, 0, human.stderr);
    assert.match(human.stdout, /relaykit\s+contrib\s+not enabled/);
    assert.match(human.stdout, /✗ error: .*thrower exploded/);
    assert.match(human.stdout, /✗ skipped squatterx: pool name must be "squatter"/);
    assert.match(human.stdout, /strategy set-provider <pool> on\|off --yes/,
      'list keeps loading and routing as two separate notions');
  } finally { f.cleanup(); }
});

test('provider enable writes providers.json, never state.json, and disable removes the entry', async () => {
  const f = fixture();
  try {
    const enabled = await run(f, ['enable', 'sidecar']);
    assert.equal(enabled.code, 0, enabled.stderr);
    const config = join(f.home, 'providers.json');
    assert.deepEqual(JSON.parse(readFileSync(config, 'utf8')), { enabled: ['sidecar'] });
    assert.equal(existsSync(join(f.home, 'state.json')), false, 'enable must never write state.json');

    const again = await run(f, ['enable', 'sidecar']);
    assert.equal(again.code, 0);
    assert.match(again.stdout, /already enabled; nothing written/);
    assert.deepEqual(JSON.parse(readFileSync(config, 'utf8')).enabled, ['sidecar']);

    const list = JSON.parse((await run(f, ['list', '--json'])).stdout);
    const sidecar = list.providers.find((p) => p.name === 'sidecar');
    assert.equal(sidecar.enabled, true);
    assert.deepEqual(sidecar.pools, ['sidecar'], 'templates include contrib providers that are not enabled');

    const disabled = await run(f, ['disable', 'sidecar']);
    assert.equal(disabled.code, 0, disabled.stderr);
    assert.deepEqual(JSON.parse(readFileSync(config, 'utf8')), { enabled: [] });
    assert.equal(existsSync(join(f.home, 'state.json')), false);
    const after = JSON.parse((await run(f, ['list', '--json'])).stdout);
    assert.equal(after.providers.find((p) => p.name === 'sidecar').enabled, false);
  } finally { f.cleanup(); }
});

test('provider enable refuses a name a local provider claims, and a name with no contrib directory', async () => {
  const local = mkdtempSync(join(tmpdir(), 'bullswarm-provider-cli-local-'));
  mkdirSync(join(local, 'my-relaykit'));
  writeFileSync(join(local, 'my-relaykit', 'provider.mjs'),
    "export const name = 'relaykit';\nexport function connectors() { return []; }\n");
  const f = fixture({ local });
  try {
    const claimed = await run(f, ['enable', 'relaykit']);
    assert.equal(claimed.code, 2);
    assert.match(claimed.stderr, /refusing to enable "relaykit": the local provider at .*my-relaykit already claims the name "relaykit"/);
    assert.equal(existsSync(join(f.home, 'providers.json')), false);

    const missing = await run(f, ['enable', 'nope']);
    assert.equal(missing.code, 2);
    assert.match(missing.stderr, /no contrib provider named "nope" \(known: relaykit, sidecar\)/);
    assert.equal(existsSync(join(f.home, 'providers.json')), false);
  } finally {
    f.cleanup();
    rmSync(local, { recursive: true, force: true });
  }
});

test('provider validate accepts the relay example and reports every pool', async () => {
  const f = fixture();
  try {
    const result = await run(f, ['validate', join(FIXTURES, 'local', 'relay'), '--json']);
    assert.equal(result.code, 0, result.stdout);
    const report = JSON.parse(result.stdout);
    assert.equal(report.ok, true);
    assert.equal(report.name, 'relay');
    assert.equal(report.exports.readUsage, 'function');
    assert.deepEqual(report.pools.map((p) => [p.name, p.ok]), [['relay', true], ['relay:b', true]]);

    const byName = await run(f, ['validate', 'relay']);
    assert.equal(byName.code, 0, byName.stdout);
    assert.match(byName.stdout, /— OK/);
    assert.match(byName.stdout, /✓ pool relay:b/);
  } finally { f.cleanup(); }
});

test('provider validate rejects prefix violations, throwing connectors(), and schema errors with exit 2', async () => {
  const f = fixture();
  const bad = mkdtempSync(join(tmpdir(), 'bullswarm-provider-cli-bad-'));
  try {
    const squatter = await run(f, ['validate', join(FIXTURES, 'local', 'squatter'), '--json']);
    assert.equal(squatter.code, 2);
    const report = JSON.parse(squatter.stdout);
    assert.equal(report.ok, false);
    const pool = (name) => report.pools.find((p) => p.name === name);
    assert.match(pool('squatterx').errors.join('\n'), /name: must be "squatter" or "squatter:<suffix>"/);
    assert.equal(pool('squatter:ok').ok, true);
    assert.ok(report.pools.some((p) => p.name === null && p.errors.includes('pool is not an object')));

    const thrower = await run(f, ['validate', join(FIXTURES, 'local', 'thrower')]);
    assert.equal(thrower.code, 2);
    assert.match(thrower.stdout, /✗ connectors\(\) threw: thrower exploded/);

    const tla = await run(f, ['validate', join(FIXTURES, 'local', 'tla')]);
    assert.equal(tla.code, 2);
    assert.match(tla.stdout, /provider\.mjs failed to load/);

    writeFileSync(join(bad, 'provider.mjs'), [
      "export const name = 'bad';",
      "export const readUsage = 'not a function';",
      'export function connectors() {',
      "  return [{ name: 'bad', spawn: { cmd: ['bad-cli', '{outFile}'] }, outputExtraction: { strategy: 'pipe' } }];",
      '}',
    ].join('\n'));
    const schema = JSON.parse((await run(f, ['validate', bad, '--json'])).stdout);
    assert.equal(schema.ok, false);
    assert.ok(schema.errors.includes('export readUsage: must be a function'));

    // Fix the export so the pool-level schema errors are reached.
    writeFileSync(join(bad, 'provider.mjs'), [
      "export const name = 'bad';",
      'export function connectors() {',
      "  return [{ name: 'bad', spawn: { cmd: ['bad-cli', '{outFile}'] }, outputExtraction: { strategy: 'pipe' }, meter: { type: 'reader', window: 'daily' } }];",
      '}',
    ].join('\n'));
    const fresh = join(bad, 'v2');
    mkdirSync(fresh);
    writeFileSync(join(fresh, 'provider.mjs'), readFileSync(join(bad, 'provider.mjs'), 'utf8'));
    const pools = await run(f, ['validate', fresh, '--json']);
    assert.equal(pools.code, 2);
    const errors = JSON.parse(pools.stdout).pools[0].errors.join('\n');
    assert.match(errors, /spawn\.cmd: must contain \{taskFile\}/);
    assert.match(errors, /unknown placeholder \{outFile\}/);
    assert.match(errors, /outputExtraction\.strategy: must be stdout, stdout-tail, json-field, file, event-stream/);
    assert.match(errors, /model: set model, knownModels, or modelDiscovery/);
    assert.match(errors, /meter\.window: must be/);
  } finally {
    f.cleanup();
    rmSync(bad, { recursive: true, force: true });
  }
});

test('provider scaffold writes a commented provider that validate accepts unchanged', async () => {
  const f = fixture();
  try {
    const plain = await run(f, ['scaffold', 'acme']);
    assert.equal(plain.code, 0, plain.stderr);
    const dir = join(f.home, 'providers', 'acme');
    const source = readFileSync(join(dir, 'provider.mjs'), 'utf8');
    for (const exported of ['name', 'displayName', 'connectors', 'readUsage', 'doctor']) {
      assert.match(source, new RegExp(`export (const|function|async function) ${exported}\\b`), `skeleton shows ${exported}`);
    }
    assert.equal(existsSync(join(dir, 'connector.json')), false);
    const plainCheck = await run(f, ['validate', dir, '--json']);
    assert.equal(plainCheck.code, 0, plainCheck.stdout);
    assert.deepEqual(JSON.parse(plainCheck.stdout).pools.map((p) => p.name), ['acme']);

    const target = join(f.home, 'elsewhere', 'relay2');
    const cloned = await run(f, ['scaffold', 'relay2', '--from', 'opencode', '--dir', target]);
    assert.equal(cloned.code, 0, cloned.stderr);
    const connector = JSON.parse(readFileSync(join(target, 'connector.json'), 'utf8'));
    assert.equal(connector.name, 'relay2');
    assert.deepEqual(connector.spawn.cmd, ['opencode', 'run', '--auto', '{taskFile}']);
    const clonedCheck = await run(f, ['validate', target, '--json']);
    assert.equal(clonedCheck.code, 0, clonedCheck.stdout);
    assert.deepEqual(JSON.parse(clonedCheck.stdout).warnings, []);

    const again = await run(f, ['scaffold', 'relay2', '--dir', target]);
    assert.equal(again.code, 2);
    assert.match(again.stderr, /already exists and is not empty/);
    const unknown = await run(f, ['scaffold', 'x', '--from', 'nope']);
    assert.equal(unknown.code, 2);
    assert.match(unknown.stderr, /no shipped template "nope"/);
  } finally { f.cleanup(); }
});

// Not a real agent CLI: a node script standing in for one, so the runner path,
// PONG check, readUsage call and env redaction are exercised offline.
test('provider probe spawns the pool through the runner, reads usage once, and never prints env values', async () => {
  const local = mkdtempSync(join(tmpdir(), 'bullswarm-provider-cli-probe-'));
  const secret = 'sk-probe-secret-value-123456';
  mkdirSync(join(local, 'fake'));
  writeFileSync(join(local, 'fake', 'worker.mjs'),
    `console.log(process.env.FAKE_KEY === ${JSON.stringify(secret)} ? 'PONG' : 'no key');\n`);
  writeFileSync(join(local, 'fake', 'provider.mjs'), [
    "export const name = 'fake';",
    'export function connectors() {',
    '  return [',
    `    { name: 'fake', spawn: { cmd: [${JSON.stringify(process.execPath)}, ${JSON.stringify(join(local, 'fake', 'worker.mjs'))}, '{taskFile}', ${JSON.stringify(secret)}] }, outputExtraction: { strategy: 'stdout' }, model: 'm', env: { FAKE_KEY: ${JSON.stringify(secret)} }, subscription: { plan: 'p', includedValueUsd: 50 } },`,
    `    { name: 'fake:silent', spawn: { cmd: [${JSON.stringify(process.execPath)}, '-e', 'console.log("hello")', '{taskFile}'] }, outputExtraction: { strategy: 'stdout' }, model: 'm' },`,
    '  ];',
    '}',
    'export async function readUsage(pool, { kit, subscription }) {',
    "  if (pool === 'fake:silent') throw new kit.MeterError('meter offline', 'network');",
    '  return kit.snapshot({ pool, used_usd: 5, monthly: { utilization: kit.pct(5, subscription?.includedValueUsd), resets_at: null } });',
    '}',
  ].join('\n'));
  const f = fixture({ local });
  try {
    const ok = await run(f, ['probe', 'fake', '--json']);
    assert.equal(ok.code, 0, ok.stdout + ok.stderr);
    assert.ok(!ok.stdout.includes(secret), 'no env value may reach the output');
    const result = JSON.parse(ok.stdout);
    assert.equal(result.pong, true);
    assert.equal(result.provider, 'fake');
    assert.equal(result.argv.includes('[redacted env value]'), true);
    assert.equal(typeof result.elapsedMs, 'number');
    assert.equal(result.usage.called, true);
    assert.equal(result.usage.snapshot.monthly.utilization, 10);

    const failed = await run(f, ['probe', 'fake:silent']);
    assert.equal(failed.code, 1);
    assert.match(failed.stdout, /✗ does not contain PONG/);
    assert.match(failed.stdout, /✗ readUsage threw \(network\): meter offline/);

    const unknown = await run(f, ['probe', 'nope']);
    assert.equal(unknown.code, 2);
    assert.match(unknown.stderr, /unknown pool "nope"/);
  } finally {
    f.cleanup();
    rmSync(local, { recursive: true, force: true });
  }
});
