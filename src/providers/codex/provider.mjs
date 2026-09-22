// bullswarm codex provider — the Codex CLI, metered through the ChatGPT WHAM
// usage API.
// Endpoint + auth flow documented by OpenUsage (MIT, robinebers/openusage);
// implemented here independently for bullswarm.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { retryAfterMsFromHeaders } from '../../meters/framework.js';
import {
  buildTranscriptIndex as buildCodexTranscriptIndex,
  readTranscriptUsage as readCodexTranscriptUsage,
} from '../../lib/transcripts/codex.js';

export const name = 'codex';
export const displayName = 'Codex';

const DISCOVERY_TIMEOUT_MS = 15_000;

export function parseCodexModelDiscovery(pages) {
  const records = Array.isArray(pages) ? pages : String(pages ?? '').split(/\r?\n/).filter(Boolean).map((line) => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(Boolean);
  const models = [];
  const seen = new Set();
  let found = false;
  for (const record of records) {
    const page = Array.isArray(record?.data) ? record : record?.result;
    if (!Array.isArray(page?.data)) continue;
    found = true;
    for (const row of page.data) {
      const id = typeof row?.id === 'string' ? row.id.trim() : '';
      if (!id || row.hidden === true || seen.has(id)) continue;
      seen.add(id);
      const reasoningLevels = (row.supportedReasoningEfforts ?? [])
        .map((entry) => typeof entry === 'string' ? entry : entry?.reasoningEffort)
        .filter((level) => typeof level === 'string');
      models.push({
        id,
        displayName: typeof row.displayName === 'string' ? row.displayName : null,
        default: row.isDefault === true,
        reasoningLevels: [...new Set(reasoningLevels)],
      });
    }
  }
  if (!found) throw new Error('Codex app-server did not return model/list data (CLI may be too old)');
  if (!models.length) throw new Error('Codex app-server returned no visible models');
  return models;
}

function runCodexDiscovery({ command, args, env, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
    const pages = [];
    let stdout = '';
    let stderr = '';
    let initialized = false;
    let requestId = 2;
    let settled = false;
    const send = (message) => {
      if (settled || child.stdin.destroyed || !child.stdin.writable) return;
      child.stdin.write(`${JSON.stringify(message)}\n`, (error) => {
        if (error) finish(error);
      });
    };
    const finish = (error = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill('SIGKILL');
      if (error) reject(error);
      else resolve(pages);
    };
    const timer = setTimeout(() => finish(new Error(`Codex model discovery timed out after ${timeoutMs}ms`)), timeoutMs);
    const handleLine = (line) => {
      if (settled) return;
      let message;
      try { message = JSON.parse(line); } catch { return; }
      if (message.id === 1) {
        if (message.error) return finish(new Error(`Codex initialize failed: ${message.error.message ?? 'unknown error'}`));
        initialized = true;
        send({ method: 'initialized', params: {} });
        send({ id: requestId, method: 'model/list', params: {} });
        return;
      }
      if (!initialized || message.id !== requestId) return;
      if (message.error) return finish(new Error(`Codex model/list failed: ${message.error.message ?? 'unknown error'}`));
      if (!Array.isArray(message.result?.data)) return finish(new Error('Codex model/list response has no data array'));
      pages.push(message.result);
      const cursor = message.result.nextCursor;
      if (typeof cursor === 'string' && cursor) {
        requestId += 1;
        send({ id: requestId, method: 'model/list', params: { cursor } });
      } else {
        finish();
      }
    };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      let newline;
      while ((newline = stdout.indexOf('\n')) >= 0) {
        const line = stdout.slice(0, newline).trim();
        stdout = stdout.slice(newline + 1);
        if (line) handleLine(line);
      }
    });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.stdin.on('error', (error) => finish(error));
    child.once('error', finish);
    child.once('close', (code) => {
      if (!settled) finish(new Error(`Codex model discovery exited ${code}${stderr.trim() ? `: ${stderr.trim()}` : ''}`));
    });
    send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'bullswarm-probe', version: '0' } } });
  });
}

export async function discoverModels(connector, { executor = runCodexDiscovery } = {}) {
  const timeoutMs = Number(connector?.modelDiscovery?.timeoutMs ?? DISCOVERY_TIMEOUT_MS);
  const command = connector?.bin ?? connector?.spawn?.cmd?.[0] ?? 'codex';
  const args = ['app-server', '--stdio'];
  const pages = await executor({
    command,
    args,
    env: { ...process.env, ...(connector?.env ?? {}) },
    timeoutMs,
  });
  return { command: [command, ...args], models: parseCodexModelDiscovery(pages) };
}

const USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';
const REFRESH_URL = 'https://auth.openai.com/oauth/token';
const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const FIVE_HOUR_SECONDS = 5 * 60 * 60;
const SEVEN_DAY_SECONDS = 7 * 24 * 60 * 60;
const REFRESH_BUFFER_MS = 5 * 60_000;

export class CodexMeterError extends Error {
  constructor(message, code, { status = null, retryAfterMs = null } = {}) {
    super(message);
    this.code = code; // no_auth | api_key_only | http | parse | network
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

function authPath({ env = process.env, home = os.homedir() } = {}) {
  const codexHome = env.CODEX_HOME?.trim() || path.join(home, '.codex');
  return path.join(codexHome, 'auth.json');
}

export function loadAuth(where = {}) {
  const p = authPath(where);
  if (!existsSync(p)) {
    throw new CodexMeterError('Codex not logged in. Run `codex` to authenticate.', 'no_auth');
  }
  let auth;
  try {
    auth = JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    throw new CodexMeterError('Codex auth.json unreadable. Re-run `codex` login.', 'no_auth');
  }
  const access = auth.tokens?.access_token?.trim();
  if (!access) {
    if (auth.OPENAI_API_KEY?.trim()) {
      throw new CodexMeterError(
        'Codex usage needs ChatGPT-account auth (API-key-only cannot read subscription usage).',
        'api_key_only',
      );
    }
    throw new CodexMeterError('Codex auth has no access token.', 'no_auth');
  }
  return { auth, path: p };
}

/** JWT exp claim in ms, or null when undecodable. */
export function accessTokenExpiresAtMs(token) {
  const parts = token.split('.');
  if (parts.length < 2) return null;
  try {
    const pad = '='.repeat((4 - (parts[1].length % 4)) % 4);
    const payload = JSON.parse(Buffer.from(parts[1] + pad, 'base64url').toString('utf8'));
    return typeof payload.exp === 'number' ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}

export function needsRefresh(accessToken, lastRefresh, nowMs = Date.now()) {
  const expMs = accessTokenExpiresAtMs(accessToken);
  if (expMs !== null) return nowMs >= expMs - REFRESH_BUFFER_MS;
  if (!lastRefresh) return false;
  const ms = Date.parse(lastRefresh);
  return Number.isFinite(ms) && nowMs - ms > 8 * 24 * 3600_000;
}

async function refreshAccessToken(auth, filePath) {
  const refresh = auth.tokens?.refresh_token?.trim();
  if (!refresh) return null;
  let res;
  try {
    res = await fetch(REFRESH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: CLIENT_ID,
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
    const next = {
      ...auth,
      tokens: {
        ...auth.tokens,
        access_token: j.access_token,
        refresh_token: j.refresh_token ?? auth.tokens?.refresh_token,
        id_token: j.id_token ?? auth.tokens?.id_token,
      },
      last_refresh: new Date().toISOString(),
    };
    // Best-effort write-back so the CLI shares the rotated token.
    try {
      writeFileSync(filePath, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    } catch {
      /* in-memory token still works */
    }
    return { accessToken: j.access_token, auth: next };
  } catch {
    return null;
  }
}

// --- pure decoder (unit-tested without network) ------------------------------

function numberOf(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim()) {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

function windowSeconds(raw) {
  if (!raw) return undefined;
  const sec = numberOf(raw.limit_window_seconds);
  if (sec !== undefined) return sec;
  const minutes = numberOf(raw.window_minutes);
  if (minutes !== undefined) return minutes * 60;
  return undefined;
}

function normalizeWindow(raw, headerPercent, nowMs) {
  const used = numberOf(raw?.used_percent) ?? headerPercent;
  if (used === undefined) return null;
  let resetsAt = null;
  const resetUnix = numberOf(raw?.reset_at) ?? numberOf(raw?.resets_at);
  if (resetUnix !== undefined) {
    resetsAt = new Date(resetUnix * 1000).toISOString();
  } else {
    const after = numberOf(raw?.reset_after_seconds);
    if (after !== undefined) resetsAt = new Date(nowMs + after * 1000).toISOString();
  }
  return { utilization: Math.min(100, Math.max(0, used)), resets_at: resetsAt };
}

/**
 * Decode the WHAM body (+ optional x-codex-*-used-percent headers).
 * Classification prefers explicit limit_window_seconds over slot order:
 * a sole weekly window can appear in the primary slot.
 */
export function parseCodexWhamUsage(body, headers = {}, nowMs = Date.now()) {
  if (!body || typeof body !== 'object') {
    throw new CodexMeterError('Codex usage response missing body', 'parse');
  }
  const rateLimit =
    body.rate_limit && typeof body.rate_limit === 'object' ? body.rate_limit : {};
  const headerPrimary = numberOf(headers['x-codex-primary-used-percent']);
  const headerSecondary = numberOf(headers['x-codex-secondary-used-percent']);
  const primary = rateLimit.primary_window ?? null;
  const secondary = rateLimit.secondary_window ?? null;

  const candidates = [
    { raw: primary, headerPercent: headerPrimary, fallback: 'five_hour' },
    { raw: secondary, headerPercent: headerSecondary, fallback: 'seven_day' },
  ];

  let fiveHour = null;
  let sevenDay = null;
  for (const c of candidates) {
    const secs = windowSeconds(c.raw);
    const w = normalizeWindow(c.raw, c.headerPercent, nowMs);
    if (!w) continue;
    if (secs === FIVE_HOUR_SECONDS) fiveHour ??= w;
    else if (secs === SEVEN_DAY_SECONDS) sevenDay ??= w;
  }
  if (!fiveHour || !sevenDay) {
    for (const c of candidates) {
      const secs = windowSeconds(c.raw);
      if (secs === FIVE_HOUR_SECONDS || secs === SEVEN_DAY_SECONDS) continue;
      const w = normalizeWindow(c.raw, c.headerPercent, nowMs);
      if (!w) continue;
      if (c.fallback === 'five_hour' && !fiveHour) fiveHour = w;
      else if (c.fallback === 'seven_day' && !sevenDay) sevenDay = w;
    }
  }

  const planRaw = body.plan_type;
  return {
    five_hour: fiveHour ?? { utilization: null, resets_at: null },
    seven_day: sevenDay ?? { utilization: null, resets_at: null },
    plan_type: typeof planRaw === 'string' && planRaw.trim() ? planRaw.trim() : null,
  };
}

// --- live fetch ----------------------------------------------------------------

async function fetchUsageResponse(accessToken, accountId) {
  let res;
  try {
    res = await fetch(USAGE_URL, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
        'User-Agent': 'bullswarm',
        ...(accountId?.trim() ? { 'ChatGPT-Account-Id': accountId.trim() } : {}),
      },
    });
  } catch (err) {
    throw new CodexMeterError(`Network error reaching Codex usage: ${err.message}`, 'network');
  }
  const headers = {};
  res.headers.forEach((value, key) => (headers[key.toLowerCase()] = value));
  const retryAfterMs = retryAfterMsFromHeaders(res.headers);
  let body = null;
  try {
    body = await res.json();
  } catch {
    /* parse layer errors if needed */
  }
  return { status: res.status, body, headers, retryAfterMs };
}

export async function fetchCodexUsage({ pool = 'codex', env, home } = {}) {
  const loaded = loadAuth({ env, home });
  let auth = loaded.auth;
  let access = auth.tokens.access_token.trim();
  const accountId = auth.tokens?.account_id;

  if (needsRefresh(access, auth.last_refresh)) {
    const refreshed = await refreshAccessToken(auth, loaded.path);
    if (refreshed) {
      access = refreshed.accessToken;
      auth = refreshed.auth;
    }
  }

  let { status, body, headers, retryAfterMs } = await fetchUsageResponse(access, accountId);
  if (status === 401 || status === 403) {
    const refreshed = await refreshAccessToken(auth, loaded.path);
    if (refreshed) {
      access = refreshed.accessToken;
      ({ status, body, headers, retryAfterMs } = await fetchUsageResponse(access, accountId));
    }
  }
  if (status < 200 || status >= 300) {
    throw new CodexMeterError(
      `Codex usage returned HTTP ${status}`,
      status === 401 || status === 403 ? 'no_auth' : 'http',
      { status, retryAfterMs },
    );
  }

  const windows = parseCodexWhamUsage(body, headers);
  return {
    captured_at: new Date().toISOString(),
    pool,
    five_hour: windows.five_hour,
    seven_day: windows.seven_day,
    monthly: null,
    plan_type: windows.plan_type,
  };
}

export async function readUsage(pool, ctx = {}) {
  const poolName = typeof pool === 'string' ? pool : pool?.name;
  return fetchCodexUsage({ pool: poolName ?? 'codex', env: ctx.env, home: ctx.home });
}

export function readTranscriptUsage(args = {}) {
  return readCodexTranscriptUsage(args);
}

// One pass over the store serves every lookup of a bulk reprice.
export function buildTranscriptIndex(args = {}) {
  return buildCodexTranscriptIndex(args);
}
