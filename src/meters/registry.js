// bullswarm meter registry — pool name → live reader, cache-first.

import { join } from 'node:path';
import { homedir } from 'node:os';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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

/**
 * The wallet total a Relay used-USD figure is read against, in this order:
 * the pool's declared subscription (`strategy set-subscription <pool>
 * --included-usd <n>`), then the RELAY_PLAN_USD environment variable, then
 * $50. The wallets differ — the 2026-09-12 newcomer plan on relay-4 is $20 —
 * so one host-wide number would report a $10 spend on it as 20% used instead
 * of 50%. Anything that is not a positive finite number is skipped, and a
 * result that is still not positive is null, so the reader records used USD
 * without inventing a utilization.
 */
export function relayIncludedUsd({ includedUsd = null, env = process.env } = {}) {
  for (const candidate of [includedUsd, env?.RELAY_PLAN_USD, 50]) {
    if (candidate == null || candidate === '') continue;
    const n = Number(candidate);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

/** The operator-declared plan total for one pool, or null when none is recorded. */
export function declaredIncludedUsd(subscriptions, pool) {
  const n = Number(subscriptions?.[pool]?.includedValueUsd);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function relayReaderFor(pool, { includedUsd = null } = {}) {
  return async () => {
    const providers = discoverRelayProviders();
    const hit = providers.find((p) => p.pool === pool);
    if (!hit) {
      throw new RelayMeterError(`No Relay key configured in OpenCode for pool ${pool}.`, 'no_token');
    }
    return fetchRelayUsage(hit.apiKey, {
      pool,
      includedUsd: relayIncludedUsd({ includedUsd }),
    });
  };
}

/**
 * @param {string} pool
 * @param {{includedUsd?: number|null}} [readerOpts] per-pool facts the reader
 *   cannot discover on its own — today the declared wallet total for Relay.
 */
export function readerFor(pool, readerOpts = {}) {
  if (pool === 'claude-code' || pool === 'claude' || pool.startsWith('claude-code:')) {
    return claudeReaderFor(pool);
  }
  if (pool === 'opencode2' || pool.startsWith('opencode2:')) {
    return relayReaderFor(pool, readerOpts);
  }
  return READERS[pool] ?? null;
}

/**
 * Get a usable meter reading for a pool:
 *   1. fresh cache hit (<= FRESH_MS old) → use it
 *   2. live poll → cache + use
 *   3. poll failed → stale cache labeled stale, else the error
 * Never fabricates numbers. Every live poll is also appended to the pool's
 * reading history (see appendMeterHistory) so spend rates have a series.
 *
 * opts.reader overrides the registered reader — used by tests to exercise the
 * live path without touching a provider. opts.subscriptions is
 * state.strategy.subscriptions, so a pool's declared plan total reaches the
 * reader that needs it (Relay).
 */
export async function getMeterReading(pool, opts = {}) {
  const { force = false, nowMs = Date.now() } = opts;
  const cache = new MeterCache(join(METERS_DIR(), 'meters'));
  const cached = cache.get(pool);

  if (!force && cached && nowMs - Date.parse(cached.captured_at) <= FRESH_MS) {
    return { snapshot: cached, source: 'cache', ...paceSnapshot(cached, nowMs) };
  }

  const reader = opts.reader ?? readerFor(pool, {
    includedUsd: declaredIncludedUsd(opts.subscriptions, pool),
  });
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
    // The cache keeps only the latest reading; the spend model needs the
    // series, so every LIVE reading is also appended to the history log.
    appendMeterHistory(pool, snapshot, { dir: cache.dir });
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

// --- reading history --------------------------------------------------------
//
// MeterCache keeps ONE snapshot per pool, so nothing in the tree could answer
// "how fast is this pool burning its window?" — that needs two readings and
// the work dispatched between them. Every live reading is therefore also
// appended to `<meters dir>/history/<pool>.jsonl`, one JSON object per line,
// oldest first. The log is best-effort: a failure to record history never
// fails a meter read, and a rate with no series stays null rather than
// becoming an invented number.

/** Lines kept when the log is rewritten. */
export const MAX_HISTORY_LINES = 500;
/** Line count above which the log is rewritten down to MAX_HISTORY_LINES. */
export const HISTORY_REWRITE_AT = 600;

/** Snapshot window key → history window key. `weekly` is the spend-model name. */
const HISTORY_WINDOWS = [
  ['five_hour', 'five_hour'],
  ['weekly', 'seven_day'],
  ['monthly', 'monthly'],
];

/** Default meters directory — the same one MeterCache writes snapshots into. */
export function metersDir() {
  return join(METERS_DIR(), 'meters');
}

/** History log path. Pool → filename exactly as MeterCache names snapshots. */
export function meterHistoryPath(pool, dir = metersDir()) {
  return join(dir, 'history', `${pool}.jsonl`);
}

/**
 * The one history line a snapshot is worth: its capture time plus every
 * window it actually reported. A snapshot with no readable window produces
 * null — an empty line would only pad the log.
 */
export function meterHistoryEntry(snapshot) {
  if (!snapshot?.captured_at) return null;
  const entry = { captured_at: snapshot.captured_at };
  for (const [key, source] of HISTORY_WINDOWS) {
    const window = snapshot[source];
    const raw = window?.utilization;
    // M4: a window the provider did not report is absent from the line, never
    // a zero — Number(null) is 0 and that zero would read as "spent nothing".
    if (raw == null || raw === '' || typeof raw === 'boolean') continue;
    const utilization = Number(raw);
    if (!Number.isFinite(utilization)) continue;
    entry[key] = { utilization, resets_at: window.resets_at ?? null };
  }
  return Object.keys(entry).length > 1 ? entry : null;
}

/**
 * Append one reading to the pool's history log, capping the file.
 * Returns the appended entry, or null when nothing was recorded (unusable
 * snapshot, duplicate capture time, or an I/O failure).
 */
export function appendMeterHistory(pool, snapshot, opts = {}) {
  const entry = meterHistoryEntry(snapshot);
  if (!entry) return null;
  const path = meterHistoryPath(pool, opts.dir ?? metersDir());
  const line = JSON.stringify(entry);
  try {
    mkdirSync(join(path, '..'), { recursive: true });
    const raw = existsSync(path) ? readFileSync(path, 'utf8') : '';
    const lines = raw.split('\n').filter((l) => l.trim());
    // The same snapshot can be handed to us twice (a cached reading re-put by
    // a caller); a repeated capture time is not a second observation.
    if (lines.length && capturedAtOf(lines[lines.length - 1]) === entry.captured_at) return null;
    if (lines.length + 1 > HISTORY_REWRITE_AT) {
      writeFileSync(path, `${[...lines, line].slice(-MAX_HISTORY_LINES).join('\n')}\n`);
    } else {
      appendFileSync(path, raw && !raw.endsWith('\n') ? `\n${line}\n` : `${line}\n`);
    }
    return entry;
  } catch {
    // History is an optimization for routing, never a precondition for it.
    return null;
  }
}

function capturedAtOf(line) {
  try {
    return JSON.parse(line)?.captured_at ?? null;
  } catch {
    return null;
  }
}

/**
 * Read a pool's recorded readings, oldest first. Unparseable or undated lines
 * are skipped rather than throwing — a truncated write must not blind routing.
 *
 * @param {string} pool
 * @param {{dir?: string, sinceMs?: number|null}} [opts]
 * @returns {Array<{captured_at: string, capturedAtMs: number}>}
 */
export function readMeterHistory(pool, opts = {}) {
  const { dir = metersDir(), sinceMs = null } = opts;
  let raw;
  try {
    raw = readFileSync(meterHistoryPath(pool, dir), 'utf8');
  } catch {
    return [];
  }
  const out = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (!entry || typeof entry !== 'object') continue;
    const capturedAtMs = Date.parse(entry.captured_at);
    if (!Number.isFinite(capturedAtMs)) continue;
    if (sinceMs != null && capturedAtMs < sinceMs) continue;
    out.push({ ...entry, capturedAtMs });
  }
  out.sort((a, b) => a.capturedAtMs - b.capturedAtMs);
  return out;
}

export { CodexMeterError, GrokMeterError, CommandCodeMeterError, ClaudeMeterError, RelayMeterError, FRESH_MS, STALE_MS };
