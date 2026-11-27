// The Stats page's Tokens tab: how many tokens Bullswarm's workers read and
// wrote, split the way Cloudflare's Workers AI chart splits them (input vs
// output), per day, and by pool, model and project.
//
// The grain is the per-attempt metric each rollup carries (metrics.js
// attemptMetric). Input is the uncached read plus the cache read and cache
// write; output is the generated text plus reasoning, the same disjoint
// fields metrics.js tokenTotal adds up. Only counts a provider reported (or a
// transcript summed) are added: a UTF-8 byte estimate is counted as an
// estimate and left out, and an attempt with no token data is counted as not
// reported. Nothing is guessed.
import { periodRange, recordProject } from './stats-model.js';
import { dayKey } from './day-key.js';

const finite = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null);

function startOfDay(ms) {
  const date = new Date(ms);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

function addDays(ms, days) {
  const date = new Date(ms);
  date.setDate(date.getDate() + days);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

function startOfWeek(ms) {
  const start = startOfDay(ms);
  const weekday = (new Date(start).getDay() + 6) % 7; // Monday first
  return addDays(start, -weekday);
}

function attemptTimeMs(metric, record) {
  for (const value of [metric?.finishedAt, metric?.startedAt, record?.finishedAt, record?.startedAt]) {
    const ms = typeof value === 'string' ? Date.parse(value) : NaN;
    if (Number.isFinite(ms)) return ms;
  }
  return null;
}

/**
 * One attempt's tokens: `kind` is reported, estimated or none; a reported
 * attempt from an index line written before uncached input and output were
 * recorded is `split: false` and carries only its total.
 */
export function attemptTokens(metric) {
  const total = finite(metric?.tokens);
  const source = typeof metric?.tokenSource === 'string' ? metric.tokenSource : 'unknown';
  if (total == null) return { kind: 'none' };
  if (source.startsWith('estimated')) return { kind: 'estimated' };
  const uncached = finite(metric.standardRead);
  const output = finite(metric.output);
  const cacheRead = finite(metric.cacheRead) ?? 0;
  const cacheWrite = finite(metric.cacheWrite) ?? 0;
  const reasoning = finite(metric.reasoning) ?? 0;
  if (uncached == null || output == null) return { kind: 'reported', split: false, total };
  return {
    kind: 'reported',
    split: true,
    total,
    uncached,
    cacheRead,
    cacheWrite,
    reasoning,
    input: uncached + cacheRead + cacheWrite,
    output: output + reasoning,
  };
}

function ranked(map, grand) {
  return [...map.entries()]
    .map(([name, row]) => ({ name, ...row, share: grand > 0 ? row.total / grand : null }))
    .sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));
}

function addTo(map, name, tokens) {
  const row = map.get(name) ?? { total: 0, input: 0, output: 0 };
  row.total += tokens.total;
  if (tokens.split) { row.input += tokens.input; row.output += tokens.output; }
  map.set(name, row);
}

/**
 * Tokens over a period, from the rollup index.
 *
 * @param {Array<object>} rollups
 * @param {{period?: string, now?: number}} [options]
 */
export function tokensModel(rollups, { period = '7d', now = Date.now() } = {}) {
  const range = periodRange(period, now);
  const bucketBy = range.period === 'all' ? 'week' : 'day';
  const startOfBucket = bucketBy === 'week' ? startOfWeek : startOfDay;
  const step = bucketBy === 'week' ? 7 : 1;

  const totals = { input: 0, uncached: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0, total: 0 };
  const attempts = { total: 0, reported: 0, estimated: 0, none: 0, unsplit: 0 };
  const byPool = new Map();
  const byModel = new Map();
  const byProject = new Map();
  const perBucket = new Map();
  let oldest = null;

  for (const record of Array.isArray(rollups) ? rollups : []) {
    const metrics = Array.isArray(record?.attemptMetrics) ? record.attemptMetrics : [];
    for (const metric of metrics) {
      const at = attemptTimeMs(metric, record);
      if (at == null || at > range.to || (range.from != null && at < range.from)) continue;
      attempts.total += 1;
      const tokens = attemptTokens(metric);
      if (tokens.kind !== 'reported') { attempts[tokens.kind] += 1; continue; }
      attempts.reported += 1;
      totals.total += tokens.total;
      const start = startOfBucket(at);
      oldest = oldest == null ? start : Math.min(oldest, start);
      const bucket = perBucket.get(start) ?? { input: 0, output: 0, unsplit: 0 };
      if (tokens.split) {
        totals.input += tokens.input;
        totals.uncached += tokens.uncached;
        totals.cacheRead += tokens.cacheRead;
        totals.cacheWrite += tokens.cacheWrite;
        totals.output += tokens.output;
        totals.reasoning += tokens.reasoning;
        bucket.input += tokens.input;
        bucket.output += tokens.output;
      } else {
        attempts.unsplit += 1;
        bucket.unsplit += tokens.total;
      }
      perBucket.set(start, bucket);
      addTo(byPool, metric.pool ?? 'unknown', tokens);
      addTo(byModel, metric.model ?? 'unknown', tokens);
      addTo(byProject, recordProject(record), tokens);
    }
  }

  // Every bucket of the period is drawn, an empty one as 0 tokens: a
  // token count of nothing is a measured zero. 'all' starts at the oldest.
  const first = range.from != null ? startOfBucket(range.from) : oldest;
  const buckets = [];
  if (first != null) {
    for (let at = first; at <= range.to; at = addDays(at, step)) {
      const bucket = perBucket.get(at) ?? { input: 0, output: 0, unsplit: 0 };
      const key = dayKey(at);
      buckets.push({ key, label: key, from: at, to: addDays(at, step), ...bucket });
    }
  }

  return {
    period: range.period,
    bucketBy,
    from: range.from,
    to: range.to,
    totals,
    attempts,
    buckets,
    byPool: ranked(byPool, totals.total),
    byModel: ranked(byModel, totals.total),
    byProject: ranked(byProject, totals.total),
  };
}
