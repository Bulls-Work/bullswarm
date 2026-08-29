// Discover Claude Code logins on this machine.
//
// One account = one config dir (`~/.claude` by default, or CLAUDE_CONFIG_DIR).
// Extra homes live next to it as `~/.claude-<slug>`. Credentials:
//   macOS Keychain `Claude Code-credentials` for ~/.claude
//   `Claude Code-credentials-<sha256(absPath)[:8]>` for any other home
//   plus `$dir/.credentials.json` on every platform.

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { basename, join, resolve } from 'node:path';
import {
  DEFAULT_KEYCHAIN_SERVICE,
  extractCredentials,
  isUsable,
  readFromMacKeychain,
} from '../meters/claude.js';

const HOME_MARKERS = ['.credentials.json', '.claude.json', 'settings.json', 'projects'];

export function defaultClaudeHome(homeDir = homedir()) {
  return resolve(join(homeDir, '.claude'));
}

export function keychainServiceForConfigDir(configDir, homeDir = homedir()) {
  const resolved = resolve(configDir);
  if (resolved === defaultClaudeHome(homeDir)) return DEFAULT_KEYCHAIN_SERVICE;
  const hash = createHash('sha256').update(resolved).digest('hex').slice(0, 8);
  return `${DEFAULT_KEYCHAIN_SERVICE}-${hash}`;
}

export function accountSlugForConfigDir(configDir, homeDir = homedir()) {
  const resolved = resolve(configDir);
  if (resolved === defaultClaudeHome(homeDir)) return null;
  const base = basename(resolved);
  if (base.startsWith('.claude-')) {
    const slug = base.slice('.claude-'.length);
    return slug.length > 0 ? slug : 'alt';
  }
  if (base.startsWith('.claude')) {
    const rest = base.slice('.claude'.length).replace(/^-+/, '');
    return rest.length > 0 ? rest : 'alt';
  }
  return base || 'alt';
}

export function poolNameForSlug(slug) {
  return slug ? `claude-code:${slug}` : 'claude-code';
}

export function looksLikeClaudeHome(dir) {
  try {
    if (!statSync(dir).isDirectory()) return false;
  } catch {
    return false;
  }
  return HOME_MARKERS.some((name) => existsSync(join(dir, name)));
}

export function discoverClaudeConfigDirs(opts = {}) {
  const homeDir = opts.homeDir ?? homedir();
  const found = [];
  const seen = new Set();
  const add = (dir) => {
    const resolved = resolve(dir);
    if (seen.has(resolved)) return;
    if (!looksLikeClaudeHome(resolved)) return;
    seen.add(resolved);
    found.push(resolved);
  };
  add(join(homeDir, '.claude'));
  try {
    for (const name of readdirSync(homeDir)) {
      if (!name.startsWith('.claude-')) continue;
      add(join(homeDir, name));
    }
  } catch { /* unreadable home */ }
  const envDir = opts.envConfigDir ?? process.env.CLAUDE_CONFIG_DIR;
  if (envDir && String(envDir).trim()) add(String(envDir).trim());
  return found;
}

function readCredentialsFile(path) {
  try {
    return extractCredentials(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

export function readAccountCredentials(configDir, opts = {}) {
  const homeDir = opts.homeDir ?? homedir();
  const nowMs = opts.nowMs ?? Date.now();
  const os = opts.platform ?? platform();
  const keychainRead = opts.readKeychain ?? readFromMacKeychain;
  const usableOnly = opts.usableOnly !== false;

  const fileCreds = readCredentialsFile(join(configDir, '.credentials.json'));
  let keychainCreds = null;
  if (os === 'darwin') {
    keychainCreds = keychainRead(keychainServiceForConfigDir(configDir, homeDir));
  }
  const extraFile = resolve(configDir) === defaultClaudeHome(homeDir)
    ? readCredentialsFile(join(homeDir, '.config', 'claude', 'credentials.json'))
    : null;

  const candidates = [];
  if (keychainCreds) candidates.push({ creds: keychainCreds, source: 'keychain' });
  if (fileCreds) candidates.push({ creds: fileCreds, source: 'file' });
  if (extraFile) candidates.push({ creds: extraFile, source: 'file' });
  for (const c of candidates) {
    if (!usableOnly || isUsable(c.creds, nowMs)) return c;
  }
  return null;
}

export function profileCommand(configDir, bin = 'claude') {
  return `CLAUDE_CONFIG_DIR=${configDir} ${bin}`;
}

export function discoverClaudeAccounts(opts = {}) {
  const homeDir = opts.homeDir ?? homedir();
  const dirs = discoverClaudeConfigDirs({
    homeDir,
    envConfigDir: opts.envConfigDir,
  });
  const accounts = [];
  const seenTokens = new Set();
  for (const configDir of dirs) {
    const got = readAccountCredentials(configDir, opts);
    if (!got) continue;
    if (seenTokens.has(got.creds.accessToken)) continue;
    seenTokens.add(got.creds.accessToken);
    const slug = accountSlugForConfigDir(configDir, homeDir);
    accounts.push({
      configDir,
      slug,
      pool: poolNameForSlug(slug),
      command: profileCommand(configDir, opts.bin ?? 'claude'),
      creds: got.creds,
      source: got.source,
    });
  }
  accounts.sort((a, b) => {
    if (a.slug === null) return -1;
    if (b.slug === null) return 1;
    return a.slug.localeCompare(b.slug);
  });
  return accounts;
}

/**
 * Clone the packaged `claude-code` connector once per extra login.
 * The default home keeps the historical pool name `claude-code`.
 * Extra homes become `claude-code:<slug>` with CLAUDE_CONFIG_DIR in env
 * so spawn bills that seat. Discovery is filesystem-driven — never a
 * hardcoded profile list.
 */
export function expandClaudeAccountConnectors(connectors, opts = {}) {
  if (opts.disabled === true) return connectors;
  if (process.env.BULLSWARM_DISABLE_CLAUDE_PROFILES === '1') return connectors;
  // node:test (and MCP children it spawns) inherit NODE_TEST_CONTEXT. Do not
  // scan the operator's real extra Claude homes unless the test injects
  // `accounts` or `homeDir`.
  if (process.env.NODE_TEST_CONTEXT && opts.accounts == null && opts.homeDir == null) {
    return connectors;
  }
  const base = connectors['claude-code'];
  if (!base) return connectors;
  const accounts = opts.accounts ?? discoverClaudeAccounts({
    homeDir: opts.homeDir,
    envConfigDir: opts.envConfigDir,
    bin: base.bin ?? 'claude',
  });
  const defaultDir = accounts.find((a) => a.slug == null)?.configDir
    ?? defaultClaudeHome(opts.homeDir);
  const bin = base.bin ?? 'claude';
  base.env = { ...(base.env ?? {}), CLAUDE_CONFIG_DIR: defaultDir };
  base.profile = {
    slug: null,
    configDir: defaultDir,
    command: profileCommand(defaultDir, bin),
  };
  for (const account of accounts) {
    if (!account.slug) continue;
    const name = account.pool;
    if (connectors[name]) continue;
    const clone = structuredClone(base);
    clone.name = name;
    clone.env = { ...(base.env ?? {}), CLAUDE_CONFIG_DIR: account.configDir };
    clone.configDirs = [account.configDir];
    clone.flags = { ...(base.flags ?? {}), isCaller: false };
    clone.profile = {
      slug: account.slug,
      configDir: account.configDir,
      command: account.command,
    };
    connectors[name] = clone;
  }
  return connectors;
}
