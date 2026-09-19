// bullswarm grok provider — the Grok CLI, metered through the Grok Build
// weekly credit pool via the billing endpoint the Grok CLI itself uses.
// Weekly-only: five_hour stays null. The meter is real code: it refreshes the
// OAuth token and writes the rotated token back into ~/.grok/auth.json.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { retryAfterMsFromHeaders } from '../../meters/framework.js';
import { readTranscriptUsage as readGrokTranscriptUsage } from '../../lib/transcripts/grok.js';

export const name = 'grok';
export const displayName = 'Grok';

const CREDITS_URL = 'https://cli-chat-proxy.grok.com/v1/billing?format=credits';
const REFRESH_URL = 'https://auth.x.ai/oauth2/token';
const TOKEN_AUTH = 'xai-grok-cli';
const DEFAULT_CLIENT_ID = 'b1a00492-073a-47ea-816f-4c329264a828';
const WEEKLY_PERIOD = 'USAGE_PERIOD_TYPE_WEEKLY';
const REFRESH_BUFFER_MS = 5 * 60_000;

export class GrokMeterError extends Error {
  constructor(message, code, { status = null, retryAfterMs = null } = {}) {
    super(message);
    this.code = code; // no_auth | http | parse | network | not_weekly
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

function authPath({ env = process.env, home = os.homedir() } = {}) {
  const grokHome = env.GROK_HOME?.trim() || path.join(home, '.grok');
  return path.join(grokHome, 'auth.json');
}

function loadAuthEntry(p) {
  if (!existsSync(p)) {
    throw new GrokMeterError('Grok not logged in. Run `grok login`.', 'no_auth');
  }
  let raw;
  try {
    raw = JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    throw new GrokMeterError('Grok auth.json unreadable. Re-run `grok login`.', 'no_auth');
  }
  for (const [entryKey, entry] of Object.entries(raw)) {
    const token = typeof entry?.key === 'string' ? entry.key.trim() : '';
    if (token) return { token, entry, entryKey };
  }
  throw new GrokMeterError('Grok auth has no access token.', 'no_auth');
}

function needsRefresh(entry) {
  if (!entry.expires_at) return false;
  const ms = Date.parse(entry.expires_at);
  return Number.isFinite(ms) && Date.now() >= ms - REFRESH_BUFFER_MS;
}

async function refreshAccessToken(entry, p) {
  const refresh = entry.refresh_token?.trim();
  if (!refresh) return null;
  const clientId = entry.oidc_client_id?.trim() || DEFAULT_CLIENT_ID;
  let res;
  try {
    res = await fetch(REFRESH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: clientId,
        refresh_token: refresh,
      }).toString(),
    });
  } catch {
    return null;
  }
  if (!res.ok) return null;
  try {
    const j = await res.json();
    if (typeof j.access_token !== 'string' || !j.access_token) return null;
    try {
      const raw = JSON.parse(readFileSync(p, 'utf8'));
      for (const key of Object.keys(raw)) {
        if (raw[key]?.key === entry.key || raw[key]?.refresh_token === refresh) {
          raw[key] = {
            ...raw[key],
            key: j.access_token,
            refresh_token: j.refresh_token ?? raw[key].refresh_token,
            expires_at:
              typeof j.expires_in === 'number'
                ? new Date(Date.now() + j.expires_in * 1000).toISOString()
                : raw[key].expires_at,
          };
          break;
        }
      }
      writeFileSync(p, JSON.stringify(raw, null, 2));
    } catch {
      /* in-memory token still works */
    }
    return j.access_token;
  } catch {
    return null;
  }
}

// --- pure decoder ---------------------------------------------------------------

export function parseGrokCreditsConfig(body) {
  if (!body || typeof body !== 'object') {
    throw new GrokMeterError('Grok billing response missing body', 'parse');
  }
  const config = body.config;
  if (!config || typeof config !== 'object') {
    throw new GrokMeterError('Grok billing response missing config', 'parse');
  }
  const period = config.currentPeriod;
  if (!period || typeof period !== 'object') {
    throw new GrokMeterError('Grok billing response missing currentPeriod', 'parse');
  }
  const periodType = typeof period.type === 'string' ? period.type.trim() : '';
  if (!periodType) {
    throw new GrokMeterError('Grok billing period type missing', 'parse');
  }

  let utilization = 0;
  if (config.creditUsagePercent !== undefined && config.creditUsagePercent !== null) {
    const n = Number(config.creditUsagePercent);
    if (!Number.isFinite(n)) {
      throw new GrokMeterError('creditUsagePercent is not a number', 'parse');
    }
    utilization = Math.min(100, Math.max(0, n));
  }

  const end =
    typeof period.end === 'string' && period.end ? new Date(period.end).toISOString() : null;

  return {
    utilization,
    resets_at: end && !Number.isNaN(Date.parse(end)) ? end : null,
    period_type: periodType,
  };
}

async function fetchJson(url, token) {
  let res;
  try {
    res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token.trim()}`,
        'X-XAI-Token-Auth': TOKEN_AUTH,
        Accept: 'application/json',
        'User-Agent': 'bullswarm',
      },
    });
  } catch (err) {
    throw new GrokMeterError(`Network error reaching Grok billing: ${err.message}`, 'network');
  }
  const retryAfterMs = retryAfterMsFromHeaders(res.headers);
  let body = null;
  try {
    body = await res.json();
  } catch {
    /* leave null */
  }
  return { status: res.status, body, retryAfterMs };
}

export async function fetchGrokUsage({ pool = 'grok', env, home } = {}) {
  const p = authPath({ env, home });
  const loaded = loadAuthEntry(p);
  let token = loaded.token;
  if (needsRefresh(loaded.entry)) {
    const refreshed = await refreshAccessToken(loaded.entry, p);
    if (refreshed) token = refreshed;
  }

  let { status, body, retryAfterMs } = await fetchJson(CREDITS_URL, token);
  if (status === 401 || status === 403) {
    const refreshed = await refreshAccessToken(loaded.entry, p);
    if (refreshed) {
      token = refreshed;
      ({ status, body, retryAfterMs } = await fetchJson(CREDITS_URL, token));
    }
  }
  if (status < 200 || status >= 300) {
    throw new GrokMeterError(
      `Grok billing returned HTTP ${status}`,
      status === 401 || status === 403 ? 'no_auth' : 'http',
      { status, retryAfterMs },
    );
  }

  const credits = parseGrokCreditsConfig(body);
  if (credits.period_type !== WEEKLY_PERIOD) {
    throw new GrokMeterError(
      `Grok period is ${credits.period_type}, not weekly — refusing to mislabel`,
      'not_weekly',
    );
  }

  return {
    captured_at: new Date().toISOString(),
    pool,
    five_hour: { utilization: null, resets_at: null },
    seven_day: { utilization: credits.utilization, resets_at: credits.resets_at },
    monthly: null,
    plan_type: null,
  };
}

export async function readUsage(pool, ctx = {}) {
  const poolName = typeof pool === 'string' ? pool : pool?.name;
  return fetchGrokUsage({ pool: poolName ?? 'grok', env: ctx.env, home: ctx.home });
}

export function readTranscriptUsage(args = {}) {
  return readGrokTranscriptUsage(args);
}
