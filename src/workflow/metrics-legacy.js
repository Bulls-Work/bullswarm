// The legacy reader: old single-run log entries as run records.
//
// Before 0.37.0 `bullswarm run` kept its record only as an entry in the
// `state.json` decision log, which holds the last 500 entries of every kind.
// Stats and Budget read run records (rollups), so those runs were never
// counted. Since 0.37.0 a single run is a one-step workflow with its own
// rollup; this reader maps the entries the log still holds onto the same
// record shape, marked `legacy`, so every page counts them the same way.
//
// Rules (metrics.js M1, M6):
//   - Nothing is invented. An entry with no start has no active minutes; an
//     entry with no amount has unknown money, never zero.
//   - The entries are read, never rewritten.
//   - Runs the log cap already dropped cannot be counted again.
//
// Old rollups (the pre-v2 `costUsd` pool shape, v2 pool aggregates written
// before per-attempt records, and `legacyRollupRecord` runs with no pools)
// need no mapping here: `recordEntries` in metrics.js reads their pool and
// model maps as legacy entries.

import { statSync } from 'node:fs';
import { join } from 'node:path';
import { readJsonSafe } from '../lib/fsjson.js';
import { finishedRow, isRunEntry, taskKey } from '../lib/tasks.js';
import { aggregateAttemptUsage, attemptMetric, attemptsUnion, attemptWorkerMinutes, round } from './metrics.js';

function statusOf(ok) {
  if (ok === true) return 'completed';
  if (ok === false) return 'failed';
  return null;
}

/**
 * One decision-log single-run entry as a run record. Pure.
 *
 * The record carries the task row's own fields (so a History row and a task
 * key read the same), the rollup fields every page reads, and one attempt
 * metrics record.
 */
export function legacyTaskRecord(entry, { home = null } = {}) {
  const row = finishedRow(entry, home, { withText: false });
  const finishedAt = row.endedAt;
  const attempt = {
    ...entry,
    pool: row.pool,
    startedAt: row.startedAt,
    finishedAt,
    status: entry?.ok === true ? 'succeeded' : entry?.ok === false ? 'failed' : null,
  };
  const pool = row.pool ?? 'unknown';
  const model = row.model ?? 'unknown';
  const union = attemptsUnion([attempt], { terminal: true, running: false });
  const workerMinutes = round(attemptWorkerMinutes(attempt), 2);
  const usage = aggregateAttemptUsage([attempt]);
  return {
    ...row,
    runId: `task:${taskKey(row)}`,
    shortId: null,
    kind: 'task',
    source: 'run',
    legacy: true,
    goal: null,
    cwd: typeof entry?.cwd === 'string' && entry.cwd ? entry.cwd : null,
    finishedAt,
    status: statusOf(row.ok),
    verified: false,
    requirements: { passed: 0, total: 0 },
    steps: { done: row.ok === true ? 1 : 0, total: 1 },
    minutes: {
      active: round(union.activeMinutes, 2),
      span: round(union.spanMinutes, 2),
      wall: round(union.spanMinutes, 2),
      agent: null,
    },
    pools: { [pool]: { ...usage, costUsd: usage.apiUsd } },
    models: { [model]: { attempts: 1, minutes: workerMinutes } },
    attemptMetrics: [attemptMetric(attempt, { role: 'worker' })],
  };
}

// state.json is several megabytes on a busy home and the dashboard asks every
// time the rollup index changes, so the mapped records are kept against the
// file's size and modification time.
let cached = { key: null, records: [] };

/** Every single-run entry the home's decision log still holds, as records. */
export function readLegacyTaskRecords(home) {
  if (typeof home !== 'string' || !home) return [];
  const path = join(home, 'state.json');
  let key;
  try {
    const stat = statSync(path);
    key = `${path}:${stat.size}:${stat.mtimeMs}`;
  } catch { return []; }
  if (cached.key === key) return cached.records.slice();
  const state = readJsonSafe(path, null);
  const entries = Array.isArray(state?.decisionLog) ? state.decisionLog : [];
  const records = entries.filter(isRunEntry).map((entry) => legacyTaskRecord(entry, { home }));
  cached = { key, records };
  return records.slice();
}
