// bullswarm claude meter — Anthropic OAuth usage endpoint (same data the
// /usage slash command shows). Token lives in the macOS Keychain or
// ~/.claude/.credentials.json; no refresh flow — Claude Code rotates it.

import { execFileSync } from 'node:child_process';
import { platform } from 'node:os';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const USAGE_ENDPOINT = 'https://api.anthropic.com/api/oauth/usage';
const BETA_HEADER = 'oauth-2025-04-20';
const EXPIRY_SKEW_MS = 60_000;

export class ClaudeMeterError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code; // no_token | expired | http | parse | network
  }
}

export const DEFAULT_KEYCHAIN_SERVICE = 'Claude Code-credentials';

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
