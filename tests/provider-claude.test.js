import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { validateProvider } from '../src/provider-cli.js';
import { join, resolve } from 'node:path';
import {
  accountIdentity,
  accountSlugForConfigDir,
  claudePlanName,
  connectors,
  discoverClaudeAccounts,
  discoverClaudeConfigDirs,
  discoverModels as discoverClaudeModels,
  extractCredentials,
  claudeHomeLaunch,
  keychainServiceForLaunchEnv,
  parseClaudeUsage,
  parseClaudeModelDiscovery,
  poolNameForSlug,
  profileCommand,
  readAccountCredentials,
  readUsage,
} from '../src/providers/claude-code/provider.mjs';
import { discoverConnectorModels } from '../src/lib/strategy.js';
import { readUsage as readCodexUsage } from '../src/providers/codex/provider.mjs';
import { readUsage as readGrokUsage } from '../src/providers/grok/provider.mjs';
import { loadProviders, REPO_ROOT } from '../src/lib/providers.js';
import { watchOnce } from '../src/lib/watch.js';
import { meterSignInFailed } from '../src/meters/registry.js';
import { preparePools } from '../src/workflow/dispatch-pools.js';
import { workerEnv } from '../src/lib/worker-argv.js';
import { childDepthEnv } from '../src/lib/state.js';

const FIRST_CLASS = join(REPO_ROOT, 'src', 'providers');

function makeHome() {
  return mkdtempSync(join(tmpdir(), 'bs-claude-homes-'));
}

function touchClaudeHome(dir, extras = {}) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'settings.json'), '{}\n');
  for (const [name, body] of Object.entries(extras)) {
    writeFileSync(join(dir, name), body);
  }
}

function twoLogins(home) {
  const future = Date.now() + 3_600_000;
  touchClaudeHome(join(home, '.claude'), {
    '.credentials.json': JSON.stringify({
      claudeAiOauth: { accessToken: 'sk-default', expiresAt: future },
    }),
  });
  touchClaudeHome(join(home, '.claude-work'), {
    '.credentials.json': JSON.stringify({
      claudeAiOauth: { accessToken: 'sk-work', expiresAt: future },
    }),
  });
}

const CLAUDE_DISCOVERY_OUTPUT = `${JSON.stringify({
  type: 'control_response',
  response: {
    subtype: 'success',
    request_id: 'bullswarm-model-discovery',
    response: { models: [
      { value: 'default', displayName: 'Default', description: 'Opus 5.5 with 1M context' },
      { value: 'opus[1m]', displayName: 'Opus', description: 'Opus 5.5 with 1M context' },
      { value: 'claude-fable-5-1[1m]', displayName: 'Fable', description: 'Fable 5.1' },
      { value: 'sonnet', displayName: 'Sonnet', description: 'Sonnet 5' },
      { value: 'haiku', displayName: 'Haiku', description: 'Haiku 4.5' },
    ] },
  },
})}\n`;

// Claude Code 2.1.285 names an alias row's model in displayName and keeps
// the description for a tagline; only `default` still names it there.
const CLAUDE_DISPLAY_NAME_OUTPUT = `${JSON.stringify({
  type: 'control_response',
  response: {
    subtype: 'success',
    request_id: 'bullswarm-model-discovery',
    response: { models: [
      { value: 'default', displayName: 'Default (recommended)', description: 'Sonnet 5.5 · Efficient for routine tasks' },
      { value: 'opus', displayName: 'Opus 5.5', description: 'For complex work and everyday tasks' },
      { value: 'claude-fable-5-1', displayName: 'Fable 5.1', description: 'For your toughest challenges' },
      { value: 'sonnet', displayName: 'Sonnet 5.5', description: 'Most efficient for simpler tasks' },
      { value: 'haiku', displayName: 'Haiku 4.5', description: 'Fastest for quick answers' },
      { value: 'claude-sonnet-5', displayName: 'Sonnet 5', description: 'Efficient for routine tasks' },
    ] },
  },
})}\n`;

test('Claude discovery reads an alias row\'s model from its display name', () => {
  assert.deepEqual(parseClaudeModelDiscovery(CLAUDE_DISPLAY_NAME_OUTPUT).map((model) => [model.id, model.alias, model.idSource]), [
    ['claude-sonnet-5-5', 'default', 'description-inferred'],
    ['claude-opus-5-5', 'opus', 'display-name-inferred'],
    ['claude-fable-5-1', null, 'cli'],
    ['claude-haiku-4-5', 'haiku', 'display-name-inferred'],
    ['claude-sonnet-5', null, 'cli'],
  ]);
});

test('Claude initialize discovery maps aliases, preserves 1M selectors, and sends no prompt', async () => {
  assert.deepEqual(parseClaudeModelDiscovery(CLAUDE_DISCOVERY_OUTPUT).map((model) => [model.id, model.idSource]), [
    ['claude-opus-5-5', 'description-inferred'],
    ['claude-opus-5-5[1m]', 'description-inferred'],
    ['claude-fable-5-1[1m]', 'cli'],
    ['claude-sonnet-5', 'description-inferred'],
    ['claude-haiku-4-5', 'description-inferred'],
  ]);
  let invocation;
  const result = await discoverClaudeModels({ bin: 'claude', env: { CLAUDE_CONFIG_DIR: '/tmp/acme' } }, {
    executor: async (input) => { invocation = input; return CLAUDE_DISCOVERY_OUTPUT; },
  });
  assert.equal(invocation.env.CLAUDE_CONFIG_DIR, '/tmp/acme');
  assert.ok(invocation.args.includes('--safe-mode'));
  assert.ok(invocation.args.includes('--no-session-persistence'));
  assert.equal(invocation.input.trim(), JSON.stringify({
    type: 'control_request', request_id: 'bullswarm-model-discovery', request: { subtype: 'initialize' },
  }));
  assert.equal(invocation.input.includes('user'), false);
  assert.equal(result.models[0].id, 'claude-opus-5-5');
});

test('Claude discovery falls back on timeout, bad JSON, and an old CLI response', async () => {
  const connector = {
    name: 'claude-code', knownModels: ['claude-fallback'],
    modelProfiles: [{ match: '^claude-', tier: 'high' }],
  };
  const provider = { module: { discoverModels: discoverClaudeModels }, ctx: {} };
  for (const executor of [
    async () => { throw new Error('timed out after 10ms'); },
    async () => 'not json\n',
    async () => `${JSON.stringify({ type: 'control_response', response: { subtype: 'success', response: {} } })}\n`,
  ]) {
    const result = await discoverConnectorModels(connector, { provider, providerExecutor: executor });
    assert.equal(result.source, 'connector-fallback');
    assert.deepEqual(result.models.map((model) => model.id), ['claude-fallback']);
    assert.ok(result.error);
  }
});

test('default home uses unsuffixed keychain service; extra homes hash the abs path', () => {
  assert.equal(
    claudeHomeLaunch('/home/me/.claude', '/home/me').keychainService,
    'Claude Code-credentials',
  );
  assert.equal(
    claudeHomeLaunch('/home/me/.claude-work', '/home/me').keychainService,
    'Claude Code-credentials-95e632f0',
  );
});

test('CLAUDE_CONFIG_DIR set, even to the default home, means the hashed keychain entry', () => {
  // Claude Code's own rule: unset reads the plain entry; set reads
  // `-<first 8 hex of sha256(path)>`. The vector is a real default home.
  assert.equal(keychainServiceForLaunchEnv({}), 'Claude Code-credentials');
  assert.equal(
    keychainServiceForLaunchEnv({ CLAUDE_CONFIG_DIR: '/Users/cowcow02/.claude' }),
    'Claude Code-credentials-2aca4d02',
  );
  // The default home is launched without the variable, so it keeps the plain entry.
  assert.equal(claudeHomeLaunch('/Users/cowcow02/.claude', '/Users/cowcow02').keychainService, 'Claude Code-credentials');
  assert.equal(profileCommand('/home/me/.claude', 'claude', '/home/me'), 'env -u CLAUDE_CONFIG_DIR claude');
});

test('every claude-code worker reads the keychain entry its meter check reads', () => {
  const home = makeHome();
  try {
    twoLogins(home);
    const template = { name: 'claude-code', bin: 'claude', spawn: { cmd: ['claude', '-p', '{taskFile}'] } };
    const accounts = discoverClaudeAccounts({ homeDir: home, envConfigDir: '', platform: 'linux' });
    const pools = connectors({ template, home, env: {}, opts: { accounts } });
    assert.deepEqual(pools.map((p) => p.name), ['claude-code', 'claude-code:work']);
    // The orchestrator itself runs under a third home; that must not leak.
    const callerEnv = { CLAUDE_CONFIG_DIR: join(home, '.claude-caller'), HOME: home };
    for (const pool of pools) {
      const env = workerEnv(pool, callerEnv, '/work', {});
      const read = [];
      readAccountCredentials(pool.profile.configDir, {
        homeDir: home, platform: 'darwin', readKeychain: (service) => { read.push(service); return null; },
      });
      assert.deepEqual(read, [keychainServiceForLaunchEnv(env)], pool.name);
    }
    assert.equal('CLAUDE_CONFIG_DIR' in workerEnv(pools[0], callerEnv, '/work', {}), false);
    assert.equal(workerEnv(pools[1], callerEnv, '/work', {}).CLAUDE_CONFIG_DIR, resolve(join(home, '.claude-work')));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('slug and pool names come from the directory, never a hardcoded profile list', () => {
  assert.equal(accountSlugForConfigDir('/home/me/.claude', '/home/me'), null);
  assert.equal(accountSlugForConfigDir('/home/me/.claude-work', '/home/me'), 'work');
  assert.equal(poolNameForSlug(null), 'claude-code');
  assert.equal(poolNameForSlug('work'), 'claude-code:work');
  assert.equal(
    profileCommand('/home/me/.claude-work'),
    'CLAUDE_CONFIG_DIR=/home/me/.claude-work claude',
  );
});

test('Claude credentials and usage snapshots retain subscription metadata without shelling out', () => {
  const home = makeHome();
  try {
    const future = Date.now() + 3_600_000;
    const body = JSON.stringify({ claudeAiOauth: {
      accessToken: 'sk-max', expiresAt: future,
      subscriptionType: 'max', rateLimitTier: 'default_claude_max_20x',
    } });
    const creds = extractCredentials(body);
    assert.deepEqual(creds, {
      accessToken: 'sk-max',
      expiresAt: future,
      subscriptionType: 'max',
      rateLimitTier: 'default_claude_max_20x',
    });
    assert.equal(claudePlanName(creds), 'max 20x');
    assert.equal(claudePlanName({ subscriptionType: 'team', rateLimitTier: 'default_claude_max_5x' }), 'team');
    const configDir = join(home, '.claude');
    touchClaudeHome(configDir, { '.credentials.json': body });
    const fromFile = readAccountCredentials(configDir, {
      homeDir: home, platform: 'linux', nowMs: Date.now(),
    });
    assert.equal(fromFile.source, 'file');
    assert.equal(fromFile.creds.rateLimitTier, 'default_claude_max_20x');
    const snapshot = parseClaudeUsage({
      five_hour: { utilization: 12, resets_at: '2026-09-18T13:00:00Z' },
    }, 'claude-code', fromFile.creds);
    assert.equal(snapshot.plan_type, 'max 20x');
    assert.equal(snapshot.plan_name, 'max 20x');
    assert.equal(snapshot.subscription_type, 'max');
    assert.equal(snapshot.rate_limit_tier, 'default_claude_max_20x');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('Claude plan metadata survives a token-only macOS keychain result', () => {
  const home = makeHome();
  try {
    const future = Date.now() + 3_600_000;
    const configDir = join(home, '.claude');
    touchClaudeHome(configDir, {
      '.credentials.json': JSON.stringify({ claudeAiOauth: {
        accessToken: 'sk-file', expiresAt: future,
        subscriptionType: 'pro', rateLimitTier: 'default_claude_ai',
      } }),
    });
    const result = readAccountCredentials(configDir, {
      homeDir: home, platform: 'darwin', nowMs: Date.now(),
      readKeychain: () => ({ accessToken: 'sk-keychain', expiresAt: future }),
    });
    assert.equal(result.source, 'keychain');
    assert.equal(result.creds.accessToken, 'sk-keychain');
    assert.equal(result.creds.subscriptionType, 'pro');
    assert.equal(result.creds.rateLimitTier, 'default_claude_ai');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('discoverClaudeConfigDirs finds ~/.claude-<slug> and skips unrelated .claude-* dirs', () => {
  const home = makeHome();
  try {
    touchClaudeHome(join(home, '.claude'));
    touchClaudeHome(join(home, '.claude-work'));
    mkdirSync(join(home, '.claude-harness'), { recursive: true });
    writeFileSync(join(home, '.claude-harness', 'HARNESS-PLAN.md'), 'x');
    const dirs = discoverClaudeConfigDirs({ homeDir: home, envConfigDir: '' });
    assert.deepEqual(dirs, [
      resolve(join(home, '.claude')),
      resolve(join(home, '.claude-work')),
    ]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('discoverClaudeAccounts returns one usable login per distinct token', () => {
  const home = makeHome();
  try {
    twoLogins(home);
    const accounts = discoverClaudeAccounts({
      homeDir: home,
      // A shell that exports CLAUDE_CONFIG_DIR (every worker spawned on an
      // extra Claude login does) must not leak a real login into the fixture.
      envConfigDir: '',
      platform: 'linux',
      nowMs: Date.now(),
    });
    assert.deepEqual(accounts.map((a) => a.slug), [null, 'work']);
    assert.deepEqual(accounts.map((a) => a.pool), ['claude-code', 'claude-code:work']);
    assert.equal(accounts[1].command, `CLAUDE_CONFIG_DIR=${resolve(join(home, '.claude-work'))} claude`);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('one account signed into two homes is discovered once, keeping the default home', () => {
  const home = makeHome();
  try {
    const future = Date.now() + 3_600_000;
    const oauthAccount = { accountUuid: 'acct-1', emailAddress: 'me@example.com' };
    // Same account, two separate logins: the tokens differ, the subscription
    // does not.
    // The default home runs with CLAUDE_CONFIG_DIR removed, so claude keeps
    // its account in <home>/.claude.json, not in ~/.claude.
    touchClaudeHome(join(home, '.claude'), {
      '.credentials.json': JSON.stringify({
        claudeAiOauth: { accessToken: 'sk-default', expiresAt: future },
      }),
    });
    writeFileSync(join(home, '.claude.json'), JSON.stringify({ oauthAccount }));
    touchClaudeHome(join(home, '.claude-dup'), {
      '.credentials.json': JSON.stringify({
        claudeAiOauth: { accessToken: 'sk-dup', expiresAt: future },
      }),
      '.claude.json': JSON.stringify({ oauthAccount }),
    });
    const accounts = discoverClaudeAccounts({
      homeDir: home, envConfigDir: '', platform: 'linux', nowMs: Date.now(),
    });
    assert.deepEqual(accounts.map((a) => a.pool), ['claude-code']);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('distinct accounts both survive, and a home with no recorded account falls back to its token', () => {
  const home = makeHome();
  try {
    const future = Date.now() + 3_600_000;
    touchClaudeHome(join(home, '.claude'), {
      '.credentials.json': JSON.stringify({
        claudeAiOauth: { accessToken: 'sk-default', expiresAt: future },
      }),
    });
    writeFileSync(join(home, '.claude.json'), JSON.stringify({ oauthAccount: { accountUuid: 'acct-1' } }));
    touchClaudeHome(join(home, '.claude-other'), {
      '.credentials.json': JSON.stringify({
        claudeAiOauth: { accessToken: 'sk-other', expiresAt: future },
      }),
      '.claude.json': JSON.stringify({ oauthAccount: { accountUuid: 'acct-2' } }),
    });
    // No .claude.json at all: keyed on its token, so it is its own account.
    touchClaudeHome(join(home, '.claude-legacy'), {
      '.credentials.json': JSON.stringify({
        claudeAiOauth: { accessToken: 'sk-legacy', expiresAt: future },
      }),
    });
    const accounts = discoverClaudeAccounts({
      homeDir: home, envConfigDir: '', platform: 'linux', nowMs: Date.now(),
    });
    assert.deepEqual(accounts.map((a) => a.pool), [
      'claude-code', 'claude-code:legacy', 'claude-code:other',
    ]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('accountIdentity reads the recorded account, and is null when there is none to read', () => {
  const home = makeHome();
  try {
    touchClaudeHome(join(home, '.claude-work'), {
      '.claude.json': JSON.stringify({ oauthAccount: { accountUuid: 'acct-1' } }),
    });
    touchClaudeHome(join(home, '.claude-empty'), { '.claude.json': '{}' });
    touchClaudeHome(join(home, '.claude-broken'), { '.claude.json': 'not json' });
    touchClaudeHome(join(home, '.claude-none'));
    assert.equal(accountIdentity(join(home, '.claude-work'), { homeDir: home }), 'account:acct-1');
    assert.equal(accountIdentity(join(home, '.claude-empty'), { homeDir: home }), null);
    assert.equal(accountIdentity(join(home, '.claude-broken'), { homeDir: home }), null);
    assert.equal(accountIdentity(join(home, '.claude-none'), { homeDir: home }), null);
    // The default home (workers run with CLAUDE_CONFIG_DIR removed): claude
    // records it in <home>/.claude.json; a stale ~/.claude/.claude.json from
    // when workers ran with the variable set is not read.
    touchClaudeHome(join(home, '.claude'), { '.claude.json': JSON.stringify({ oauthAccount: { accountUuid: 'acct-stale' } }) });
    writeFileSync(join(home, '.claude.json'), JSON.stringify({ oauthAccount: { accountUuid: 'acct-live' } }));
    assert.equal(accountIdentity(join(home, '.claude'), { homeDir: home }), 'account:acct-live');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('a stale ~/.claude/.claude.json naming another home\'s account does not drop that home as a duplicate', () => {
  const home = makeHome();
  try {
    const future = Date.now() + 3_600_000;
    touchClaudeHome(join(home, '.claude'), {
      '.credentials.json': JSON.stringify({ claudeAiOauth: { accessToken: 'sk-default', expiresAt: future } }),
      '.claude.json': JSON.stringify({ oauthAccount: { accountUuid: 'acct-a' } }),
    });
    writeFileSync(join(home, '.claude.json'), JSON.stringify({ oauthAccount: { accountUuid: 'acct-b' } }));
    touchClaudeHome(join(home, '.claude-x'), {
      '.credentials.json': JSON.stringify({ claudeAiOauth: { accessToken: 'sk-x', expiresAt: future } }),
      '.claude.json': JSON.stringify({ oauthAccount: { accountUuid: 'acct-a' } }),
    });
    touchClaudeHome(join(home, '.claude-y'), {
      '.credentials.json': JSON.stringify({ claudeAiOauth: { accessToken: 'sk-y', expiresAt: future } }),
      '.claude.json': JSON.stringify({ oauthAccount: { accountUuid: 'acct-b' } }),
    });
    const accounts = discoverClaudeAccounts({ homeDir: home, envConfigDir: '', platform: 'linux', nowMs: Date.now() });
    assert.deepEqual(accounts.map((a) => a.pool), ['claude-code', 'claude-code:x'], 'x is account A, a separate subscription; y duplicates the default home (B)');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('with extra homes turned off the default pool still runs with CLAUDE_CONFIG_DIR removed', () => {
  for (const ctx of [{ env: { BULLSWARM_DISABLE_CLAUDE_PROFILES: '1' }, opts: {} }, { env: {}, opts: { disabled: true } }]) {
    const template = { name: 'claude-code', bin: 'claude', spawn: { cmd: ['claude', '{taskFile}'] }, env: { CLAUDE_CONFIG_DIR: '/elsewhere/.claude-caller', ACME: '1' } };
    const pools = connectors({ template, home: '/home/acme', ...ctx });
    assert.equal(pools.length, 1);
    assert.deepEqual(pools[0].unsetEnv, ['CLAUDE_CONFIG_DIR']);
    assert.deepEqual(pools[0].env, { ACME: '1' });
    assert.equal(pools[0].profile.configDir, resolve('/home/acme/.claude'));
  }
});

test('the login command quotes a home path with a space, so it can be pasted into a shell', () => {
  assert.equal(profileCommand('/Users/John Smith/.claude-work', 'claude', '/Users/John Smith'), "CLAUDE_CONFIG_DIR='/Users/John Smith/.claude-work' claude");
  assert.equal(profileCommand("/tmp/it's/.claude-x", 'claude', '/tmp'), "CLAUDE_CONFIG_DIR='/tmp/it'\\''s/.claude-x' claude");
  assert.equal(profileCommand('/Users/acme/.claude-work', 'claude', '/Users/acme'), 'CLAUDE_CONFIG_DIR=/Users/acme/.claude-work claude');
  assert.equal(profileCommand('/Users/John Smith/.claude', 'claude', '/Users/John Smith'), 'env -u CLAUDE_CONFIG_DIR claude');
});

test('provider validate reads unsetEnv as a pool field on the packaged claude-code pools', () => {
  const home = makeHome();
  try {
    twoLogins(home);
    const report = validateProvider(join(home, '.bullswarm'), resolve('src/providers/claude-code'), { homeDir: home, envConfigDir: '', platform: 'linux' });
    assert.deepEqual(report.pools.map((pool) => [pool.name, pool.ok, pool.warnings]), [['claude-code', true, []], ['claude-code:work', true, []]]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('connectors(ctx) returns the packaged connector once per login', () => {
  const home = makeHome();
  try {
    twoLogins(home);
    const template = {
      name: 'claude-code',
      bin: 'claude',
      spawn: { cmd: ['claude', '-p', '{taskFile}'] },
      flags: { isCaller: true },
    };
    const pools = connectors({
      template,
      home,
      env: {},
      opts: { accounts: discoverClaudeAccounts({ homeDir: home, envConfigDir: '', platform: 'linux' }) },
    });
    assert.deepEqual(pools.map((p) => p.name), ['claude-code', 'claude-code:work']);
    const [base, extra] = pools;
    // The default home runs with CLAUDE_CONFIG_DIR removed (its keychain entry).
    assert.equal(base.env.CLAUDE_CONFIG_DIR, undefined);
    assert.deepEqual(base.unsetEnv, ['CLAUDE_CONFIG_DIR']);
    assert.equal(base.profile.configDir, resolve(join(home, '.claude')));
    assert.equal(base.flags.isCaller, true);
    assert.equal(extra.env.CLAUDE_CONFIG_DIR, resolve(join(home, '.claude-work')));
    assert.deepEqual(extra.unsetEnv, []);
    assert.deepEqual(extra.configDirs, [resolve(join(home, '.claude-work'))]);
    assert.equal(extra.flags.isCaller, false);
    assert.equal(extra.profile.slug, 'work');
    assert.match(extra.profile.command, /CLAUDE_CONFIG_DIR=/);
    // Separate subscriptions: a sign-in failure on one never skips the other.
    assert.equal(extra.credentialGroup, undefined);
    assert.equal(extra.upstreamGroup, undefined);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a worker bills its own pool's account even when the caller runs under another Claude home", async () => {
  const home = makeHome();
  const work = mkdtempSync(join(tmpdir(), 'bs-claude-env-work-'));
  const saved = process.env.CLAUDE_CONFIG_DIR;
  try {
    twoLogins(home);
    // The script prints what the worker actually received.
    const template = {
      name: 'claude-code',
      spawn: { cmd: [process.execPath, '-e', 'console.log(JSON.stringify({ config: process.env.CLAUDE_CONFIG_DIR, depth: process.env.BULLSWARM_DEPTH }))'] },
      outputExtraction: { strategy: 'stdout' },
    };
    const pools = connectors({ template, home, env: {}, opts: { accounts: discoverClaudeAccounts({ homeDir: home, envConfigDir: '', platform: 'linux' }) } });
    // The caller itself runs under another home, exactly as a CLI caller
    // with CLAUDE_CONFIG_DIR set does; the CLI hands workers a full copy.
    process.env.CLAUDE_CONFIG_DIR = resolve(join(home, '.claude-caller'));
    const callerEnv = childDepthEnv({ ...process.env, BULLSWARM_DEPTH: '1' });
    for (const pool of pools) {
      const paths = { taskFile: join(work, `task-${pool.name.replace(':', '-')}.md`), outFile: join(work, `out-${pool.name.replace(':', '-')}.md`) };
      await watchOnce(pool, 'Report your environment.', work, paths, { env: callerEnv });
      const seen = JSON.parse(readFileSync(paths.outFile, 'utf8').trim().split('\n').at(-1));
      // The default pool gets no CLAUDE_CONFIG_DIR at all (undefined here).
      assert.equal(seen.config, pool.env.CLAUDE_CONFIG_DIR, pool.name);
      // The recursion guard is Bullswarm's own and still comes from the caller.
      assert.equal(seen.depth, '2', pool.name);
    }
    assert.equal(pools[0].env.CLAUDE_CONFIG_DIR, undefined);
    assert.equal(pools[1].env.CLAUDE_CONFIG_DIR, resolve(join(home, '.claude-work')));
    // unsetEnv removes a variable whichever layer set it.
    assert.deepEqual(workerEnv({ unsetEnv: ['CLAUDE_CONFIG_DIR'] }, { CLAUDE_CONFIG_DIR: '/caller' }, '/work', { CLAUDE_CONFIG_DIR: '/base', KEEP: '1' }), { KEEP: '1', PWD: '/work' });
    // unsetEnv cannot remove the caller's BULLSWARM_ keys or PWD (docs/reference/providers.md).
    assert.deepEqual(workerEnv({ unsetEnv: ['BULLSWARM_DEPTH', 'FOO', 'PWD'] }, { BULLSWARM_DEPTH: '1', FOO: 'x' }, '/w', { PATH: '/bin' }), { PATH: '/bin', BULLSWARM_DEPTH: '1', PWD: '/w' });
    // No pool setting overrides a BULLSWARM_ key; PWD is always the spawned directory.
    const env = workerEnv({ env: { CLAUDE_CONFIG_DIR: '/pool', BULLSWARM_DEPTH: '9' } }, { CLAUDE_CONFIG_DIR: '/caller', BULLSWARM_DEPTH: '2', PWD: '/stale' }, '/work', {});
    assert.deepEqual(env, { CLAUDE_CONFIG_DIR: '/pool', BULLSWARM_DEPTH: '2', PWD: '/work' });
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = saved;
    rmSync(home, { recursive: true, force: true });
    rmSync(work, { recursive: true, force: true });
  }
});

test('connectors(ctx) does not scan real homes under node:test without injection', () => {
  const template = { name: 'claude-code', spawn: { cmd: ['claude', '{taskFile}'] } };
  const pools = connectors({ template, home: '/nonexistent', env: { NODE_TEST_CONTEXT: 'child' }, opts: {} });
  assert.deepEqual(pools.map((pool) => pool.name), ['claude-code']);
  // Even so, the default pool never inherits the caller's home: its workers
  // read the login its meter reads.
  assert.deepEqual([pools[0].env, pools[0].unsetEnv], [{}, ['CLAUDE_CONFIG_DIR']]);
  assert.equal(workerEnv(pools[0], {}, '/work', { CLAUDE_CONFIG_DIR: '/Users/acme/.claude-other' }).CLAUDE_CONFIG_DIR, undefined);
});

test('the four first-class providers load from src/providers through the loader', () => {
  const home = makeHome();
  const empty = mkdtempSync(join(tmpdir(), 'bs-providers-empty-'));
  try {
    twoLogins(home);
    const { connectors: pools, providers } = loadProviders(empty, {
      dirs: { firstClass: FIRST_CLASS, contrib: join(empty, 'contrib'), local: join(empty, 'local'), legacy: join(empty, 'legacy') },
      enabled: [],
      homeDir: home,
      accounts: discoverClaudeAccounts({ homeDir: home, envConfigDir: '', platform: 'linux' }),
    });
    const byName = Object.fromEntries(providers.map((p) => [p.name, p]));
    for (const name of ['claude-code', 'codex', 'grok', 'echo']) {
      assert.equal(byName[name]?.tier, 'first-class', name);
      assert.equal(byName[name].error, null, `${name}: ${byName[name].error}`);
    }
    assert.deepEqual(byName['claude-code'].pools, ['claude-code', 'claude-code:work']);
    assert.deepEqual(
      Object.fromEntries(['claude-code', 'codex', 'grok', 'echo'].map((n) => [n, [byName[n].displayName, byName[n].hasReadUsage]])),
      { 'claude-code': ['Claude', true], codex: ['Codex', true], grok: ['Grok', true], echo: ['echo', false] },
    );
    assert.equal(pools['claude-code:work'].env.CLAUDE_CONFIG_DIR, resolve(join(home, '.claude-work')));
    for (const name of ['codex', 'grok', 'echo']) assert.deepEqual(byName[name].pools, [name]);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(empty, { recursive: true, force: true });
  }
});

test('echo is json-only and its worker runs from the new {bullswarmDir} path', () => {
  assert.equal(existsSync(join(FIRST_CLASS, 'echo', 'provider.mjs')), false);
  const template = JSON.parse(readFileSync(join(FIRST_CLASS, 'echo', 'connector.json'), 'utf8'));
  const dir = mkdtempSync(join(tmpdir(), 'bs-echo-'));
  try {
    const taskFile = join(dir, 'task.md');
    writeFileSync(taskFile, 'say hi\n');
    // Same substitution src/lib/watch.js applies: {bullswarmDir} is the package root.
    const argv = template.spawn.cmd.map((a) => a.replaceAll('{bullswarmDir}', REPO_ROOT).replaceAll('{taskFile}', taskFile));
    assert.equal(argv[1], join(REPO_ROOT, 'src', 'providers', 'echo', 'echo-worker.mjs'));
    const out = spawnSync(argv[0] === 'node' ? process.execPath : argv[0], argv.slice(1), { encoding: 'utf8' });
    assert.equal(out.status, 0, out.stderr);
    assert.match(out.stdout, /## Completed/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readUsage reports a missing login without touching the network', async () => {
  const home = makeHome();
  const realFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('network must not be reached'); };
  try {
    await assert.rejects(
      readUsage('claude-code:work', { home, env: {}, opts: { envConfigDir: '' } }),
      (err) => err.code === 'no_token' && /claude-code:work/.test(err.message),
    );
    // The default pool reads the plain keychain entry, which only a login with
    // CLAUDE_CONFIG_DIR unset writes: the message names that command.
    await assert.rejects(
      readUsage('claude-code', { home, env: {}, opts: { envConfigDir: '' } }),
      (err) => err.code === 'no_token' && err.message === 'No Claude Code OAuth token for pool claude-code. Log in with `env -u CLAUDE_CONFIG_DIR claude` (it opens claude on that pool\'s home).',
    );
    // No login is a dead sign-in: its workers read the same login, so the
    // pool is out of the pick while that reading holds (doctrine 4).
    const missing = await readUsage('claude-code', { home, env: {}, opts: { homeDir: home, envConfigDir: '' } }).catch((err) => err);
    assert.equal(meterSignInFailed(missing), true);
    const pool = (name, extra = {}) => ({
      name, lanes: ['build'], enabled: true, spawn: { cmd: ['fake'] }, modelSelection: { flag: '--model' },
      strategyAssignments: { low: { pool: name, model: 'acme-model' } }, ...extra,
    });
    const prepared = preparePools([pool('claude-code', { meterError: 'no_token', meterSignInFailed: meterSignInFailed(missing) }), pool('grok')], { lane: 'build' }, 'low');
    assert.deepEqual(prepared.map((entry) => entry.name ?? entry.pool?.name ?? entry), ['grok']);
    // A pool that carries its profile names that profile's command.
    await assert.rejects(
      readUsage({ name: 'claude-code:work', profile: { command: `CLAUDE_CONFIG_DIR=${join(home, '.claude-work')} claude` } }, { home, env: {}, opts: { envConfigDir: '' } }),
      (err) => err.code === 'no_token' && err.message.includes(`\`CLAUDE_CONFIG_DIR=${join(home, '.claude-work')} claude\``),
    );
    await assert.rejects(
      readCodexUsage('codex', { home, env: { CODEX_HOME: join(home, '.codex') } }),
      (err) => err.code === 'no_auth',
    );
    await assert.rejects(
      readGrokUsage('grok', { home, env: { GROK_HOME: join(home, '.grok') } }),
      (err) => err.code === 'no_auth',
    );
  } finally {
    globalThis.fetch = realFetch;
    rmSync(home, { recursive: true, force: true });
  }
});

test('readUsage: a lapsed token is a login that reads expired, not a sign-in failure, so the pool stays pickable', async () => {
  const home = makeHome();
  mkdirSync(join(home, '.claude'), { recursive: true });
  writeFileSync(join(home, '.claude', 'settings.json'), '{}');
  const lapsed = JSON.stringify({ claudeAiOauth: { accessToken: 'acme-lapsed-token', expiresAt: Date.now() - 3_600_000 } });
  const realFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('network must not be reached'); };
  try {
    // The default home's keychain entry (macOS), read through the seam: no real keychain.
    const fromKeychain = await readUsage('claude-code', { home, env: {}, opts: { homeDir: home, envConfigDir: '', platform: 'darwin', readKeychain: () => JSON.parse(lapsed).claudeAiOauth } }).catch((err) => err);
    assert.equal(fromKeychain.code, 'expired', fromKeychain.message);
    assert.equal(meterSignInFailed(fromKeychain), false);
    // The same from the home's credentials file.
    writeFileSync(join(home, '.claude', '.credentials.json'), lapsed);
    const fromFile = await readUsage('claude-code', { home, env: {}, opts: { homeDir: home, envConfigDir: '', platform: 'linux' } }).catch((err) => err);
    assert.equal(fromFile.code, 'expired', fromFile.message);
    const pool = (name, extra = {}) => ({
      name, lanes: ['build'], enabled: true, spawn: { cmd: ['fake'] }, modelSelection: { flag: '--model' },
      strategyAssignments: { low: { pool: name, model: 'acme-model' } }, ...extra,
    });
    const prepared = preparePools([pool('claude-code', { meterError: 'expired', meterSignInFailed: meterSignInFailed(fromFile) }), pool('grok')], { lane: 'build' }, 'low');
    assert.deepEqual(prepared.map((entry) => entry.name ?? entry.pool?.name ?? entry), ['claude-code', 'grok']);
  } finally {
    globalThis.fetch = realFetch;
    rmSync(home, { recursive: true, force: true });
  }
});

test('grok readUsage refreshes an expired OAuth token and rewrites auth.json', async () => {
  const home = makeHome();
  const grokHome = join(home, '.grok');
  mkdirSync(grokHome, { recursive: true });
  const authFile = join(grokHome, 'auth.json');
  writeFileSync(authFile, JSON.stringify({
    'xai-grok-cli': { key: 'old-token', refresh_token: 'rt-1', expires_at: new Date(Date.now() - 60_000).toISOString() },
  }));
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), auth: init.headers?.Authorization ?? null });
    if (String(url).startsWith('https://auth.x.ai/')) {
      return new Response(JSON.stringify({ access_token: 'new-token', refresh_token: 'rt-2', expires_in: 3600 }), { status: 200 });
    }
    return new Response(JSON.stringify({
      config: { creditUsagePercent: 42, currentPeriod: { type: 'USAGE_PERIOD_TYPE_WEEKLY', end: '2026-09-20T00:00:00Z' } },
    }), { status: 200 });
  };
  try {
    const snap = await readGrokUsage('grok', { home, env: { GROK_HOME: grokHome } });
    assert.equal(snap.pool, 'grok');
    assert.deepEqual(snap.seven_day, { utilization: 42, resets_at: '2026-09-20T00:00:00.000Z' });
    assert.deepEqual(snap.five_hour, { utilization: null, resets_at: null });
    assert.equal(calls.length, 2);
    assert.equal(calls[1].auth, 'Bearer new-token');
    const rewritten = JSON.parse(readFileSync(authFile, 'utf8'))['xai-grok-cli'];
    assert.equal(rewritten.key, 'new-token');
    assert.equal(rewritten.refresh_token, 'rt-2');
  } finally {
    globalThis.fetch = realFetch;
    rmSync(home, { recursive: true, force: true });
  }
});
