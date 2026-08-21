// bullswarm command-code meter — Command Code alpha billing endpoints
// (the same ones the CLI's /usage overlay calls). Monthly credits plus
// 5-hour and weekly rate-limit windows.

import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DEFAULT_API_BASE = 'https://api.commandcode.ai';
const CREDITS_PATH = '/alpha/billing/credits';
const SUBSCRIPTIONS_PATH = '/alpha/billing/subscriptions';

const PLAN_NAMES = {
  'individual-go': 'Go',
  'individual-goat': 'GOAT',
  'individual-pro': 'Pro',
  'individual-pro-v1': 'Pro',
  'individual-provider': 'Provider',
  'individual-max': 'Max',
  'individual-ultra': 'Ultra',
  'teams-pro': 'Teams Pro',
};

const PLAN_CREDITS = {
  'individual-go': 10,
  'individual-goat': 70,
  'individual-pro': 30,
  'individual-pro-v1': 80,
  'individual-provider': 15,
  'individual-max': 150,
  'individual-ultra': 300,
  'teams-pro': 40,
};

export class CommandCodeMeterError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code; // no_auth | http | parse | network
  }
}

function authPath() {
  const home =
    process.env.COMMANDCODE_HOME?.trim() || path.join(os.homedir(), '.commandcode');
  return path.join(home, 'auth.json');
}

export function loadApiKey() {
  const p = authPath();
  if (!existsSync(p)) {
    throw new CommandCodeMeterError('Command Code not logged in. Run `cmd login`.', 'no_auth');
  }
  let raw;
  try {
    raw = JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    throw new CommandCodeMeterError('Command Code auth.json unreadable.', 'no_auth');
  }
  const key = typeof raw.apiKey === 'string' ? raw.apiKey.trim() : '';
  if (!key) {
    throw new CommandCodeMeterError('Command Code auth has no API key.', 'no_auth');
  }
  return key;
}

// --- pure decoders ---------------------------------------------------------------

export function parseCommandCodeCredits(body) {
  if (!body || typeof body !== 'object') {
    throw new CommandCodeMeterError('credits response missing body', 'parse');
  }
  const credits = body.credits;
  if (!credits || typeof credits !== 'object') {
    throw new CommandCodeMeterError('credits response missing credits object', 'parse');
  }
  const asCredit = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  return {
    remaining: asCredit(credits.monthlyCredits),
    purchased: asCredit(credits.purchasedCredits) ?? 0,
    free: asCredit(credits.freeCredits) ?? 0,
    planId: typeof credits.planId === 'string' && credits.planId.trim() ? credits.planId.trim() : null,
  };
}

export function parseCommandCodeWindow(raw) {
  if (!raw || typeof raw !== 'object') return { utilization: null, resets_at: null };
  const used = Number(raw.used);
  const cap = Number(raw.cap);
  let utilization = null;
  if (Number.isFinite(used) && Number.isFinite(cap) && cap > 0) {
    utilization = Math.min(100, Math.max(0, (used / cap) * 100));
  }
  let resets_at = null;
  const resetAt = Number(raw.resetAt);
  if (Number.isFinite(resetAt) && resetAt > 0) {
    const iso = new Date(resetAt).toISOString();
    resets_at = Number.isNaN(Date.parse(iso)) ? null : iso;
  }
  return { utilization, resets_at };
}

export function parseCommandCodeWindows(body) {
  const empty = { utilization: null, resets_at: null };
  const limits = body?.windowLimits;
  if (!limits || typeof limits !== 'object') return { five_hour: empty, seven_day: empty };
  return {
    five_hour: parseCommandCodeWindow(limits.fiveHour),
    seven_day: parseCommandCodeWindow(limits.weekly),
  };
}

export function planMonthlyCredits(planId) {
  if (typeof planId !== 'string' || !planId.trim()) return null;
  const key = planId.trim().toLowerCase().replace(/_/g, '-');
  if (PLAN_CREDITS[key] !== undefined) return PLAN_CREDITS[key];
  const match = Object.keys(PLAN_NAMES)
    .sort((a, b) => b.length - a.length)
    .find((p) => key.startsWith(p));
  return match ? PLAN_CREDITS[match] ?? null : null;
}

export function parseCommandCodeSubscription(body) {
  const data = body?.data;
  const planId = typeof data?.planId === 'string' && data.planId.trim() ? data.planId.trim() : null;
  const periodEnd = data?.currentPeriodEnd;
  return {
    planId,
    plan_type: planId ? (PLAN_NAMES[planId.toLowerCase()] ?? planId) : null,
    currentPeriodEnd:
      typeof periodEnd === 'string' && Number.isFinite(Date.parse(periodEnd))
        ? new Date(periodEnd).toISOString()
        : null,
  };
}

/** Monthly window from remaining credits + plan allocation. */
export function computeMonthly({ credits, subscription }) {
  const planId = subscription.planId ?? credits.planId;
  const limit = planMonthlyCredits(planId);
  const remaining = credits.remaining;
  let used = null;
  let utilization = null;
  if (limit != null && limit > 0 && remaining != null) {
    used = Math.round(Math.max(0, limit - remaining) * 100) / 100;
    utilization = Math.min(100, Math.max(0, (used / limit) * 100));
  }
  return {
    monthly: { utilization, resets_at: subscription.currentPeriodEnd },
    monthly_quota: {
      used,
      limit,
      remaining: remaining == null ? null : Math.round(Math.max(0, remaining) * 100) / 100,
      unit: 'credits',
    },
    plan_type: subscription.plan_type,
  };
}

// --- live fetch -----------------------------------------------------------------

async function fetchJson(url, key) {
  let res;
  try {
    res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${key}`,
        Accept: 'application/json',
        'User-Agent': 'bullswarm',
      },
    });
  } catch (err) {
    throw new CommandCodeMeterError(`Network error reaching Command Code billing: ${err.message}`, 'network');
  }
  let body = null;
  try {
    body = await res.json();
  } catch {
    /* leave null */
  }
  return { status: res.status, body };
}

export async function fetchCommandCodeUsage() {
  const key = loadApiKey();
  const base = (process.env.COMMANDCODE_API_URL?.trim() || DEFAULT_API_BASE).replace(/\/$/, '');

  const creditsRes = await fetchJson(`${base}${CREDITS_PATH}`, key);
  if (creditsRes.status === 401 || creditsRes.status === 403) {
    throw new CommandCodeMeterError(`Command Code credits HTTP ${creditsRes.status}`, 'no_auth');
  }
  if (creditsRes.status < 200 || creditsRes.status >= 300) {
    throw new CommandCodeMeterError(`Command Code credits HTTP ${creditsRes.status}`, 'http');
  }

  const credits = parseCommandCodeCredits(creditsRes.body);
  const windows = parseCommandCodeWindows(creditsRes.body);

  let subscription = { planId: null, plan_type: null, currentPeriodEnd: null };
  try {
    const subRes = await fetchJson(`${base}${SUBSCRIPTIONS_PATH}`, key);
    if (subRes.status >= 200 && subRes.status < 300) {
      subscription = parseCommandCodeSubscription(subRes.body);
    }
  } catch {
    /* best-effort */
  }

  const monthly = computeMonthly({ credits, subscription });
  return {
    captured_at: new Date().toISOString(),
    pool: 'command-code',
    five_hour: windows.five_hour,
    seven_day: windows.seven_day,
    monthly: monthly.monthly,
    monthly_quota: monthly.monthly_quota,
    plan_type: monthly.plan_type,
  };
}
