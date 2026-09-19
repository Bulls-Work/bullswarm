// Read a cached pool meter and compare two readings without inventing quota.

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { MeterCache } from '../meters/framework.js';
import { loadProviders } from './providers.js';

function finite(value) {
  if (value == null || typeof value === 'boolean' || Array.isArray(value)) return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function text(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function timeMs(value) {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function homeFor(home) {
  return text(home) ?? process.env.BULLSWARM_HOME?.trim() ?? join(homedir(), '.bullswarm');
}

function normalizeWindow(value) {
  const name = text(value)?.toLowerCase();
  return name === '5h' || name === 'weekly' || name === 'monthly' ? name : null;
}

function readJson(path) {
  if (!existsSync(path)) return null;
  try {
    const value = JSON.parse(readFileSync(path, 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function declaredSubscription(home, poolName) {
  const state = readJson(join(home, 'state.json'));
  const record = state?.strategy?.subscriptions?.[poolName];
  return record && typeof record === 'object' ? record : null;
}

function connectorSubscription(home, poolName) {
  try {
    const loaded = loadProviders(home);
    return loaded.connectors?.[poolName]?.subscription
      && typeof loaded.connectors[poolName].subscription === 'object'
      ? loaded.connectors[poolName].subscription
      : null;
  } catch {
    return null;
  }
}

function selectedWindow(home, poolName, snapshot) {
  const declared = declaredSubscription(home, poolName);
  const connector = connectorSubscription(home, poolName);
  const requested = normalizeWindow(declared?.quotaWindow ?? connector?.quotaWindow);
  if (requested) return requested;
  // A home without connector metadata can still be inspected honestly. Pick
  // the first named window that the cached provider actually supplied.
  if (snapshot?.seven_day) return 'weekly';
  if (snapshot?.monthly) return 'monthly';
  if (snapshot?.five_hour) return '5h';
  return null;
}

function snapshotPart(snapshot, window) {
  const key = window === '5h' ? 'five_hour' : window === 'weekly' ? 'seven_day' : 'monthly';
  return snapshot?.[key] ?? null;
}

/** Read one cached meter into the compact attempt snapshot shape. */
export function snapshotPool(poolName, { home = null, now = Date.now() } = {}) {
  const root = homeFor(home);
  const cache = new MeterCache(join(root, 'meters'));
  const snapshot = cache.get(poolName);
  if (!snapshot || typeof snapshot !== 'object') return null;
  const capturedAt = text(snapshot.captured_at);
  const capturedMs = Date.parse(String(capturedAt ?? ''));
  if (!capturedAt || !Number.isFinite(capturedMs)) return null;
  const window = selectedWindow(root, poolName, snapshot);
  const reading = snapshotPart(snapshot, window);
  const usedPct = finite(reading?.utilization);
  if (!window || !reading || usedPct == null) return null;
  const nowMs = timeMs(now);
  const ageMs = Number.isFinite(nowMs) ? nowMs - capturedMs : null;
  if (ageMs == null) return null;
  const detectedPlan = text(snapshot.plan_name)
    ?? text(snapshot.plan_type)
    ?? text(snapshot.planName)
    ?? text(snapshot.planType)
    ?? null;
  return {
    at: capturedAt,
    window,
    usedPct,
    resetsAt: text(reading.resets_at) ?? null,
    ageMs,
    ...(detectedPlan ? { plan: detectedPlan } : {}),
    source: 'cache',
  };
}

/**
 * Compare two snapshots.  `now` is accepted for deterministic callers; by
 * default the end reading is the reference clock, avoiding wall-clock drift
 * in historical/replay tests.
 */
export function deltaBetween(start, end, { maxStartAgeMs = 60_000, now = null } = {}) {
  if (!start || !end || typeof start !== 'object' || typeof end !== 'object') {
    return { deltaPct: null, reason: 'missing-snapshot' };
  }
  const startMs = Date.parse(String(start.at ?? ''));
  const endMs = Date.parse(String(end.at ?? ''));
  const referenceMs = now == null
    ? Date.now()
    : timeMs(now);
  const startAge = referenceMs - startMs;
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)
    || !Number.isFinite(referenceMs)
    || !Number.isFinite(startAge)
    || startAge > maxStartAgeMs) {
    return { deltaPct: null, reason: 'stale-start' };
  }
  const startWindow = normalizeWindow(start.window);
  const endWindow = normalizeWindow(end.window);
  const startUsed = finite(start.usedPct);
  const endUsed = finite(end.usedPct);
  if (!startWindow || !endWindow || startUsed == null || endUsed == null) {
    return { deltaPct: null, reason: 'missing-snapshot' };
  }
  if (startWindow !== endWindow) return { deltaPct: null, reason: 'window-changed' };
  const startReset = text(start.resetsAt);
  const endReset = text(end.resetsAt);
  if (startReset && endReset) {
    const startResetMs = Date.parse(startReset);
    const endResetMs = Date.parse(endReset);
    if ((Number.isFinite(startResetMs) && Number.isFinite(endResetMs)
      && startResetMs !== endResetMs) || startReset !== endReset) {
      return { deltaPct: null, reason: 'reset-between-snapshots' };
    }
  }
  if (endUsed < startUsed) return { deltaPct: null, reason: 'counter-decreased' };
  return { deltaPct: Math.round((endUsed - startUsed) * 1e8) / 1e8, reason: null };
}

export default snapshotPool;
