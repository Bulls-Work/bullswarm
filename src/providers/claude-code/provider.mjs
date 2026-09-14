// bullswarm claude-code provider — every Claude Code login on this machine
// as a pool, metered through the Anthropic OAuth usage endpoint (the same
// data the /usage slash command shows).
//
// One account = one config dir (`~/.claude` by default, or CLAUDE_CONFIG_DIR).
// Extra homes live next to it as `~/.claude-<slug>`. Credentials:
//   macOS Keychain `Claude Code-credentials` for ~/.claude
//   `Claude Code-credentials-<sha256(absPath)[:8]>` for any other home
//   plus `$dir/.credentials.json` on every platform.
// No refresh flow — Claude Code rotates the token itself.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { basename, join, resolve } from 'node:path';

export const name = 'claude-code';
export const displayName = 'Claude';

const USAGE_ENDPOINT = 'https://api.anthropic.com/api/oauth/usage';
const BETA_HEADER = 'oauth-2025-04-20';
const EXPIRY_SKEW_MS = 60_000;
const HOME_MARKERS = ['.credentials.json', '.claude.json', 'settings.json', 'projects'];

export class ClaudeMeterError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code; // no_token | expired | http | parse | network
  }
}

export const DEFAULT_KEYCHAIN_SERVICE = 'Claude Code-credentials';

// --- credentials ----------------------------------------------------------------

export function isUsable(creds, now = Date.now(), skewMs = EXPIRY_SKEW_MS) {
  return Boolean(creds) && creds.expiresAt - skewMs > now;
}

export function readOAuthCredentials() {
  if (platform() === 'darwin') {
    return readFromMacKeychain(DEFAULT_KEYCHAIN_SERVICE) ?? readFromCredentialsFile();
  }
  return readFromCredentialsFile();
}

export function readFromMacKeychain(service = DEFAULT_KEYCHAIN_SERVICE) {
  try {
    const blob = execFileSync(
      'security',
      ['find-generic-password', '-s', service, '-w'],
      { stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8' },
    );
    return extractCredentials(blob);
  } catch {
    return null;
  }
}

function readFromCredentialsFile() {
  for (const p of [
    join(homedir(), '.claude', '.credentials.json'),
    join(homedir(), '.config', 'claude', 'credentials.json'),
  ]) {
    try {
      return extractCredentials(readFileSync(p, 'utf8'));
    } catch {
      /* next candidate */
    }
  }
  return null;
}

export function extractCredentials(blob) {
  try {
    const oauth = JSON.parse(blob)?.claudeAiOauth;
    const accessToken = typeof oauth?.accessToken === 'string' ? oauth.accessToken : null;
    const expiresAt = typeof oauth?.expiresAt === 'number' ? oauth.expiresAt : null;
    if (!accessToken || expiresAt === null) return null;
    return { accessToken, expiresAt };
  } catch {
    return null;
  }
}

// --- home discovery and pool naming ------------------------------------------------

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
  return HOME_MARKERS.some((marker) => existsSync(join(dir, marker)));
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
    for (const entry of readdirSync(homeDir)) {
      if (!entry.startsWith('.claude-')) continue;
      add(join(homeDir, entry));
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

// --- pools -----------------------------------------------------------------------

/**
 * The packaged `claude-code` connector once per login. The default home keeps
 * the historical pool name `claude-code`; extra homes become
 * `claude-code:<slug>` with CLAUDE_CONFIG_DIR in env so spawn bills that seat.
 * Discovery is filesystem-driven — never a hardcoded profile list.
 *
 * ctx.opts carries test injection: `accounts`, `homeDir`, `envConfigDir`,
 * `disabled`.
 */
export function connectors(ctx = {}) {
  const base = ctx.template;
  if (!base) return [];
  const opts = ctx.opts ?? {};
  const env = ctx.env ?? process.env;
  if (opts.disabled === true) return [base];
  if (env.BULLSWARM_DISABLE_CLAUDE_PROFILES === '1') return [base];
  // node:test (and MCP children it spawns) inherit NODE_TEST_CONTEXT. Do not
  // scan the operator's real extra Claude homes unless the test injects
  // `accounts` or `homeDir`.
  if (env.NODE_TEST_CONTEXT && opts.accounts == null && opts.homeDir == null) {
    return [base];
  }
  const homeDir = opts.homeDir ?? ctx.home;
  const bin = base.bin ?? 'claude';
  const accounts = opts.accounts ?? discoverClaudeAccounts({
    homeDir,
    envConfigDir: opts.envConfigDir,
    bin,
  });
  const defaultDir = accounts.find((a) => a.slug == null)?.configDir
    ?? defaultClaudeHome(homeDir);
  base.env = { ...(base.env ?? {}), CLAUDE_CONFIG_DIR: defaultDir };
  base.profile = {
    slug: null,
    configDir: defaultDir,
    command: profileCommand(defaultDir, bin),
  };
  const pools = [base];
  const names = new Set([base.name]);
  for (const account of accounts) {
    if (!account.slug) continue;
    const poolName = account.pool;
    if (names.has(poolName)) continue;
    names.add(poolName);
    const clone = structuredClone(base);
    clone.name = poolName;
    // No credentialGroup, deliberately: each home is a SEPARATE subscription
    // with its own credential and its own window. One seat's auth failure
    // says nothing about the next one, so these pools are never benched
    // together (contrast the opencode2 provider, where three pools share one
    // relay).
    clone.env = { ...(base.env ?? {}), CLAUDE_CONFIG_DIR: account.configDir };
    clone.configDirs = [account.configDir];
    clone.flags = { ...(base.flags ?? {}), isCaller: false };
    clone.profile = {
      slug: account.slug,
      configDir: account.configDir,
      command: account.command,
    };
    pools.push(clone);
  }
  return pools;
}

// --- meter -----------------------------------------------------------------------

function normalizeWindow(raw) {
  if (!raw || typeof raw !== 'object') return null;
  return {
    utilization: typeof raw.utilization === 'number' ? raw.utilization : null,
    resets_at: typeof raw.resets_at === 'string' ? raw.resets_at : null,
  };
}

export function parseClaudeUsage(body, pool = 'claude-code') {
  if (!body || typeof body !== 'object') {
    throw new ClaudeMeterError('Claude usage response missing body', 'parse');
  }
  return {
    captured_at: new Date().toISOString(),
    pool,
    five_hour: normalizeWindow(body.five_hour) ?? { utilization: null, resets_at: null },
    seven_day: normalizeWindow(body.seven_day) ?? { utilization: null, resets_at: null },
    monthly: null,
    seven_day_opus: normalizeWindow(body.seven_day_opus),
    seven_day_sonnet: normalizeWindow(body.seven_day_sonnet),
    plan_type: null,
  };
}

export async function fetchClaudeUsageWithCredentials(creds, pool = 'claude-code') {
  if (!creds) {
    throw new ClaudeMeterError('No Claude Code OAuth token. Run `claude` to log in.', 'no_token');
  }
  if (!isUsable(creds)) {
    throw new ClaudeMeterError(
      'Claude OAuth token expired; open Claude Code to refresh it.',
      'expired',
    );
  }

  let res;
  try {
    res = await fetch(USAGE_ENDPOINT, {
      headers: {
        Authorization: `Bearer ${creds.accessToken}`,
        'anthropic-beta': BETA_HEADER,
        'User-Agent': 'bullswarm',
      },
    });
  } catch (err) {
    throw new ClaudeMeterError(`Network error reaching Anthropic: ${err.message}`, 'network');
  }
  if (!res.ok) {
    throw new ClaudeMeterError(`Usage endpoint returned ${res.status}`, 'http');
  }
  let body;
  try {
    body = await res.json();
  } catch (err) {
    throw new ClaudeMeterError(`Failed to parse usage response: ${err.message}`, 'parse');
  }
  return parseClaudeUsage(body, pool);
}

export async function fetchClaudeUsage() {
  return fetchClaudeUsageWithCredentials(readOAuthCredentials(), 'claude-code');
}

/**
 * The usage snapshot for one pool (`claude-code`, `claude-code:<slug>`, or the
 * legacy `claude` alias), read with that home's own credential.
 */
export async function readUsage(pool, ctx = {}) {
  const poolName = typeof pool === 'string' ? pool : pool?.name;
  const opts = ctx.opts ?? {};
  const accounts = discoverClaudeAccounts({
    homeDir: opts.homeDir ?? ctx.home,
    envConfigDir: opts.envConfigDir,
  });
  const slug = poolName?.startsWith('claude-code:') ? poolName.slice('claude-code:'.length) : null;
  const account = accounts.find((a) => poolNameForSlug(a.slug) === poolName)
    ?? accounts.find((a) => a.slug === slug);
  if (!account) {
    throw new ClaudeMeterError(
      `No Claude Code OAuth token for pool ${poolName}. Log in with CLAUDE_CONFIG_DIR pointing at that home.`,
      'no_token',
    );
  }
  return fetchClaudeUsageWithCredentials(account.creds, poolName);
}
