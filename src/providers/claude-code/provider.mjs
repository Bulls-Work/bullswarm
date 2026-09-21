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
import { retryAfterMsFromHeaders } from '../../meters/framework.js';
import {
  buildTranscriptIndex as buildClaudeTranscriptIndex,
  readTranscriptUsage as readClaudeTranscriptUsage,
} from '../../lib/transcripts/claude-code.js';

export const name = 'claude-code';
export const displayName = 'Claude';

const USAGE_ENDPOINT = 'https://api.anthropic.com/api/oauth/usage';
const BETA_HEADER = 'oauth-2025-04-20';
const EXPIRY_SKEW_MS = 60_000;
const HOME_MARKERS = ['.credentials.json', '.claude.json', 'settings.json', 'projects'];

export class ClaudeMeterError extends Error {
  constructor(message, code, { status = null, retryAfterMs = null } = {}) {
    super(message);
    this.code = code; // no_token | expired | http | parse | network
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

export const DEFAULT_KEYCHAIN_SERVICE = 'Claude Code-credentials';

// --- credentials ----------------------------------------------------------------

export function isUsable(creds, now = Date.now(), skewMs = EXPIRY_SKEW_MS) {
  return Boolean(creds) && creds.expiresAt - skewMs > now;
}

export function readOAuthCredentials() {
  const fileCreds = readFromCredentialsFile();
  if (platform() === 'darwin') {
    const keychainCreds = readFromMacKeychain(DEFAULT_KEYCHAIN_SERVICE);
    return keychainCreds
      ? {
        ...fileCreds,
        ...keychainCreds,
        subscriptionType: fileCreds?.subscriptionType ?? keychainCreds.subscriptionType ?? null,
        rateLimitTier: fileCreds?.rateLimitTier ?? keychainCreds.rateLimitTier ?? null,
      }
      : fileCreds;
  }
  return fileCreds;
}

// `security find-generic-password` takes 100–300 ms and blocks the caller;
// the dashboard used to pay it on every one-second tick. A login changes the
// keychain entry rarely, so one read serves a minute of callers.
const KEYCHAIN_CACHE_MS = 60_000;
const keychainCache = new Map();

/** Forget cached keychain reads (tests, or after a fresh `claude login`). */
export function resetKeychainCache() {
  keychainCache.clear();
}

export function readFromMacKeychain(service = DEFAULT_KEYCHAIN_SERVICE, { now = Date.now() } = {}) {
  const cached = keychainCache.get(service);
  if (cached && now - cached.at < KEYCHAIN_CACHE_MS) return cached.value;
  let value = null;
  try {
    const blob = execFileSync(
      'security',
      ['find-generic-password', '-s', service, '-w'],
      { stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8' },
    );
    value = extractCredentials(blob);
  } catch {
    value = null;
  }
  keychainCache.set(service, { at: now, value });
  return value;
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
    return {
      accessToken,
      expiresAt,
      subscriptionType: typeof oauth?.subscriptionType === 'string' && oauth.subscriptionType.trim()
        ? oauth.subscriptionType.trim()
        : null,
      rateLimitTier: typeof oauth?.rateLimitTier === 'string' && oauth.rateLimitTier.trim()
        ? oauth.rateLimitTier.trim()
        : null,
    };
  } catch {
    return null;
  }
}

/**
 * A human plan label from Claude Code's local OAuth metadata. The raw
 * subscriptionType and rateLimitTier are retained on the snapshot as well;
 * this label is only a convenience for a reader and price-table lookup.
 */
export function claudePlanName({ subscriptionType = null, rateLimitTier = null } = {}) {
  const subscription = typeof subscriptionType === 'string' ? subscriptionType.trim().toLowerCase() : '';
  const tier = typeof rateLimitTier === 'string' ? rateLimitTier.trim().toLowerCase() : '';
  const combined = `${subscription} ${tier}`;
  // Team and enterprise seats can carry a Max-shaped usage tier; that tier is
  // a limit multiplier, not the seat's individual billing plan.
  if (subscription.includes('team') || subscription.includes('enterprise')) return subscriptionType.trim();
  const max = combined.match(/max[^0-9]*(5|10|20)\s*x?/i);
  if (max) return `max ${max[1]}x`;
  if (subscription.includes('pro') || tier.includes('pro')) return 'pro';
  if (subscription.includes('free') || tier.includes('free')) return 'free';
  if (subscription) return subscriptionType.trim();
  if (tier) return rateLimitTier.trim();
  return null;
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
  // macOS keychain entries historically contain only the token and expiry.
  // Merge the file's non-secret plan metadata into that token so detection is
  // still sourced from `.credentials.json`, without ever shelling out to read
  // the plan itself.
  const mergedKeychain = keychainCreds && fileCreds
    ? {
      ...fileCreds,
      ...keychainCreds,
      subscriptionType: fileCreds.subscriptionType ?? keychainCreds.subscriptionType ?? null,
      rateLimitTier: fileCreds.rateLimitTier ?? keychainCreds.rateLimitTier ?? null,
    }
    : keychainCreds;
  if (mergedKeychain) candidates.push({ creds: mergedKeychain, source: 'keychain' });
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

// The Anthropic account a home is logged into, as recorded by `claude` itself.
// A token string cannot answer this: signing the same account in twice mints
// two unrelated access tokens, so token equality sees two accounts where the
// subscription — and its quota — is one.
export function accountIdentity(configDir, opts = {}) {
  const read = opts.readClaudeConfig ?? ((path) => readFileSync(path, 'utf8'));
  try {
    const uuid = JSON.parse(read(join(configDir, '.claude.json')))?.oauthAccount?.accountUuid;
    return typeof uuid === 'string' && uuid.length > 0 ? `account:${uuid}` : null;
  } catch {
    // No .claude.json, unreadable, or a home that predates the field.
    return null;
  }
}

export function discoverClaudeAccounts(opts = {}) {
  const homeDir = opts.homeDir ?? homedir();
  const dirs = discoverClaudeConfigDirs({
    homeDir,
    envConfigDir: opts.envConfigDir,
  });
  const accounts = [];
  const seen = new Set();
  for (const configDir of dirs) {
    const got = readAccountCredentials(configDir, opts);
    if (!got) continue;
    // Keyed on the account when the home records one, on the raw token when it
    // does not. `dirs` starts at the default home, so first-wins keeps the
    // caller's own login and drops the duplicate — routing never hands work to
    // the subscription already running the session.
    const key = accountIdentity(configDir, opts) ?? `token:${got.creds.accessToken}`;
    if (seen.has(key)) continue;
    seen.add(key);
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
    // together (contrast the opencode provider, where three pools share one
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

export function parseClaudeUsage(body, pool = 'claude-code', credentials = null) {
  if (!body || typeof body !== 'object') {
    throw new ClaudeMeterError('Claude usage response missing body', 'parse');
  }
  const subscriptionType = typeof credentials?.subscriptionType === 'string' && credentials.subscriptionType.trim()
    ? credentials.subscriptionType.trim()
    : null;
  const rateLimitTier = typeof credentials?.rateLimitTier === 'string' && credentials.rateLimitTier.trim()
    ? credentials.rateLimitTier.trim()
    : null;
  const planName = claudePlanName({ subscriptionType, rateLimitTier });
  return {
    captured_at: new Date().toISOString(),
    pool,
    five_hour: normalizeWindow(body.five_hour) ?? { utilization: null, resets_at: null },
    seven_day: normalizeWindow(body.seven_day) ?? { utilization: null, resets_at: null },
    monthly: null,
    seven_day_opus: normalizeWindow(body.seven_day_opus),
    seven_day_sonnet: normalizeWindow(body.seven_day_sonnet),
    // Keep `plan_type` consistent with other provider snapshots while also
    // exposing the two exact fields Claude Code persists locally. Prefer the
    // canonical tier label when both fields make one available.
    plan_type: planName ?? subscriptionType ?? rateLimitTier,
    plan_name: planName,
    subscription_type: subscriptionType,
    rate_limit_tier: rateLimitTier,
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
    throw new ClaudeMeterError(`Usage endpoint returned ${res.status}`, 'http', {
      status: res.status,
      retryAfterMs: retryAfterMsFromHeaders(res.headers),
    });
  }
  let body;
  try {
    body = await res.json();
  } catch (err) {
    throw new ClaudeMeterError(`Failed to parse usage response: ${err.message}`, 'parse');
  }
  return parseClaudeUsage(body, pool, creds);
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

export function readTranscriptUsage(args = {}) {
  return readClaudeTranscriptUsage(args);
}

// One pass over the store serves every lookup of a bulk reprice.
export function buildTranscriptIndex(args = {}) {
  return buildClaudeTranscriptIndex(args);
}
