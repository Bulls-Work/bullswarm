import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  accountSlugForConfigDir,
  discoverClaudeAccounts,
  discoverClaudeConfigDirs,
  expandClaudeAccountConnectors,
  keychainServiceForConfigDir,
  poolNameForSlug,
  profileCommand,
} from '../src/lib/claude-accounts.js';

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

test('default home uses unsuffixed keychain service; extra homes hash the abs path', () => {
  assert.equal(
    keychainServiceForConfigDir('/Users/me/.claude', '/Users/me'),
    'Claude Code-credentials',
  );
  assert.equal(
    keychainServiceForConfigDir('/Users/me/.claude-work', '/Users/me'),
    'Claude Code-credentials-1e91dd84',
  );
});

test('slug and pool names come from the directory, never a hardcoded profile list', () => {
  assert.equal(accountSlugForConfigDir('/Users/me/.claude', '/Users/me'), null);
  assert.equal(accountSlugForConfigDir('/Users/me/.claude-work', '/Users/me'), 'work');
  assert.equal(poolNameForSlug(null), 'claude-code');
  assert.equal(poolNameForSlug('work'), 'claude-code:work');
  assert.equal(
    profileCommand('/Users/me/.claude-work'),
    'CLAUDE_CONFIG_DIR=/Users/me/.claude-work claude',
  );
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
    const accounts = discoverClaudeAccounts({
      homeDir: home,
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

test('expandClaudeAccountConnectors clones the packaged connector per extra login', () => {
  const home = makeHome();
  try {
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
    const connectors = {
      'claude-code': {
        name: 'claude-code',
        bin: 'claude',
        spawn: { cmd: ['claude', '-p', '{taskFile}'] },
        flags: { isCaller: true },
      },
    };
    expandClaudeAccountConnectors(connectors, {
      accounts: discoverClaudeAccounts({ homeDir: home, platform: 'linux' }),
    });
    assert.equal(connectors['claude-code'].env.CLAUDE_CONFIG_DIR, resolve(join(home, '.claude')));
    assert.equal(connectors['claude-code'].flags.isCaller, true);
    const extra = connectors['claude-code:work'];
    assert.ok(extra);
    assert.equal(extra.name, 'claude-code:work');
    assert.equal(extra.env.CLAUDE_CONFIG_DIR, resolve(join(home, '.claude-work')));
    assert.equal(extra.flags.isCaller, false);
    assert.equal(extra.profile.slug, 'work');
    assert.match(extra.profile.command, /CLAUDE_CONFIG_DIR=/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
