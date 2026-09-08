// bullswarm meter registry — pool name → live reader, cache-first.

import { join } from 'node:path';
import { homedir } from 'node:os';
import { MeterCache, paceSnapshot, FRESH_MS, STALE_MS } from './framework.js';
import { fetchCodexUsage, CodexMeterError } from './codex.js';
import { fetchGrokUsage, GrokMeterError } from './grok.js';
import { fetchCommandCodeUsage, CommandCodeMeterError } from './command-code.js';
import { fetchClaudeUsage, fetchClaudeUsageWithCredentials, ClaudeMeterError } from './claude.js';
import { fetchRelayUsage, RelayMeterError } from './relay.js';
import { discoverClaudeAccounts, poolNameForSlug } from '../lib/claude-accounts.js';
import { discoverRelayProviders } from '../lib/opencode-relay.js';

export const METERS_DIR = () =>
  process.env.BULLSWARM_HOME?.trim() || join(homedir(), '.bullswarm');

const READERS = {
  codex: fetchCodexUsage,
  grok: fetchGrokUsage,
  'command-code': fetchCommandCodeUsage,
  'claude-code': fetchClaudeUsage,
  claude: fetchClaudeUsage,
};

function claudeReaderFor(pool) {
  return async () => {
    const accounts = discoverClaudeAccounts();
    const slug = pool.startsWith('claude-code:') ? pool.slice('claude-code:'.length) : null;
    const account = accounts.find((a) => poolNameForSlug(a.slug) === pool)
      ?? accounts.find((a) => a.slug === slug);
    if (!account) {
      throw new ClaudeMeterError(
        `No Claude Code OAuth token for pool ${pool}. Log in with CLAUDE_CONFIG_DIR pointing at that home.`,
        'no_token',
      );
    }
    return fetchClaudeUsageWithCredentials(account.creds, pool);
  };
}

function relayReaderFor(pool) {
  return async () => {
    const providers = discoverRelayProviders();
    const hit = providers.find((p) => p.pool === pool);
    if (!hit) {
      throw new RelayMeterError(`No Relay key configured in OpenCode for pool ${pool}.`, 'no_token');
    }
    const includedUsd = Number(process.env.RELAY_PLAN_USD ?? 50);
    return fetchRelayUsage(hit.apiKey, {
      pool,
      includedUsd: Number.isFinite(includedUsd) && includedUsd > 0 ? includedUsd : null,
    });
  };
}

export function readerFor(pool) {
  if (pool === 'claude-code' || pool === 'claude' || pool.startsWith('claude-code:')) {
    return claudeReaderFor(pool);
  }
  if (pool === 'opencode2' || pool.startsWith('opencode2:')) {
    return relayReaderFor(pool);
  }
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
    // No programmatic reader for this pool. A cached snapshot is still a real
    // recorded reading, so a FORCED refresh must not blank it — that call is
    // the post-quota-failure path, exactly when routing needs the 5h numbers
    // most. Same age ladder as the reader-failure branch below. With no
    // usable cache, declared meters (state.json) remain the fallback and are
    // handled by config.js; signal that here.
    if (cached) {
      const ageMs = nowMs - Date.parse(cached.captured_at);
      if (Number.isFinite(ageMs) && ageMs <= STALE_MS) {
        return {
          snapshot: cached,
          source: ageMs <= FRESH_MS ? 'cache' : 'stale',
          ageMs,
          ...paceSnapshot(cached, nowMs),
        };
      }
    }
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
  let completed = 0;
  await Promise.all(
    poolNames.map(async (p, index) => {
      opts.onProgress?.({ stage: 'start', pool: p, index: index + 1, total: poolNames.length });
      try {
        out[p] = await getMeterReading(p, opts);
      } catch (err) {
        out[p] = { snapshot: null, source: 'error', error: err, pacing: null, burstGate: false, windows: {} };
      } finally {
        completed += 1;
        opts.onProgress?.({ stage: 'complete', pool: p, completed, total: poolNames.length });
      }
    }),
  );
  return out;
}

export { CodexMeterError, GrokMeterError, CommandCodeMeterError, ClaudeMeterError, RelayMeterError, FRESH_MS, STALE_MS };
