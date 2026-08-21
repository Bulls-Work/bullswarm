// bullswarm meter registry — pool name → live reader, cache-first.

import { join } from 'node:path';
import { homedir } from 'node:os';
import { MeterCache, paceSnapshot, FRESH_MS, STALE_MS } from './framework.js';
import { fetchCodexUsage, CodexMeterError } from './codex.js';
import { fetchGrokUsage, GrokMeterError } from './grok.js';
import { fetchCommandCodeUsage, CommandCodeMeterError } from './command-code.js';
import { fetchClaudeUsage, ClaudeMeterError } from './claude.js';

export const METERS_DIR = () =>
  process.env.BULLSWARM_HOME?.trim() || join(homedir(), '.bullswarm');

const READERS = {
  codex: fetchCodexUsage,
  grok: fetchGrokUsage,
  'command-code': fetchCommandCodeUsage,
  'claude-code': fetchClaudeUsage,
  claude: fetchClaudeUsage,
};

export function readerFor(pool) {
  return READERS[pool] ?? null;
}

/**
 * Get a usable meter reading for a pool:
 *   1. fresh cache hit (<= FRESH_MS old) → use it
 *   2. live poll → cache + use
 *   3. poll failed → stale cache labeled stale, else the error
 * Never fabricates numbers.
 */
export async function getMeterReading(pool, opts = {}) {
  const { force = false, nowMs = Date.now() } = opts;
  const cache = new MeterCache(join(METERS_DIR(), 'meters'));
  const cached = cache.get(pool);

  if (!force && cached && nowMs - Date.parse(cached.captured_at) <= FRESH_MS) {
    return { snapshot: cached, source: 'cache', ...paceSnapshot(cached, nowMs) };
  }

  const reader = readerFor(pool);
  if (!reader) {
    // No programmatic reader for this pool — declared meters (state.json)
    // are the fallback and are handled by config.js. Signal that here.
    return { snapshot: null, source: 'none', pacing: null, burstGate: false, windows: {} };
  }

  try {
    const snapshot = await reader();
    cache.put(pool, snapshot);
    return { snapshot, source: 'live', ...paceSnapshot(snapshot, nowMs) };
  } catch (err) {
    if (cached) {
      const ageMs = nowMs - Date.parse(cached.captured_at);
      if (ageMs <= STALE_MS) {
        return {
          snapshot: cached,
          source: 'stale',
          error: err,
          ageMs,
          ...paceSnapshot(cached, nowMs),
        };
      }
    }
    throw err;
  }
}

/** Best-effort reading for all pools that have readers; never throws. */
export async function getAllMeterReadings(poolNames, opts = {}) {
  const out = {};
  await Promise.all(
    poolNames.map(async (p) => {
      try {
        out[p] = await getMeterReading(p, opts);
      } catch (err) {
        out[p] = { snapshot: null, source: 'error', error: err, pacing: null, burstGate: false, windows: {} };
      }
    }),
  );
  return out;
}

export { CodexMeterError, GrokMeterError, CommandCodeMeterError, ClaudeMeterError, FRESH_MS, STALE_MS };
