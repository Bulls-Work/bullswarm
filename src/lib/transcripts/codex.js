// Codex durable rollout accounting.
//
// `event_msg/token_count` rows contain cumulative counters.  They must never
// be summed: a bounded attempt uses the last cumulative record at or before
// the attempt end minus the last record strictly before its start.

import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { edgeTimes, overlapsIndex, transcriptEdges } from './indexing.js';

const TOKEN_FIELDS = [
  'input_tokens',
  'cached_input_tokens',
  'cache_write_input_tokens',
  'output_tokens',
  'reasoning_output_tokens',
];

function finite(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function timeMs(value) {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || value.trim() === '') return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function timeText(value) {
  if (typeof value === 'string' && timeMs(value) !== null) return value;
  const ms = timeMs(value);
  return ms === null ? null : new Date(ms).toISOString();
}

function inWindow(timestamp, startedAt, endedAt) {
  const start = timeMs(startedAt);
  const end = timeMs(endedAt);
  if (start === null && end === null) return true;
  const at = timeMs(timestamp);
  if (at === null) return false;
  return (start === null || at >= start) && (end === null || at <= end);
}

function blankTokens() {
  return {
    standardRead: null,
    cacheRead: null,
    cacheWrite5m: null,
    cacheWrite1h: null,
    cacheWrite: null,
    output: null,
    reasoning: null,
    totalKnown: null,
  };
}

function knownSum(values) {
  const known = values.filter((value) => value !== null);
  return known.length ? known.reduce((sum, value) => sum + value, 0) : null;
}

function blankRecord(confidence = 'none') {
  return {
    tokens: blankTokens(),
    model: null,
    sessionId: null,
    cwd: null,
    file: null,
    firstAt: null,
    lastAt: null,
    requests: [],
    confidence,
  };
}

function tokenRecord({ input, cached, cacheWrite, output, reasoning }) {
  const cacheRead = input === 0 && cached === null
    ? 0
    : cached === null ? null : cached;
  const standardRead = input === null || cacheRead === null
    ? null
    : Math.max(0, input - cacheRead);
  const outputExclusive = output === null
    ? null
    : reasoning === null ? output : Math.max(0, output - reasoning);
  const tokens = {
    standardRead,
    cacheRead,
    cacheWrite5m: null,
    cacheWrite1h: null,
    cacheWrite,
    output: outputExclusive,
    reasoning,
    totalKnown: knownSum([standardRead, cacheRead, cacheWrite, outputExclusive, reasoning]),
  };
  return tokens;
}

function cumulativeFrom(value) {
  if (!value || typeof value !== 'object') return null;
  const counters = {};
  let present = false;
  for (const field of TOKEN_FIELDS) {
    counters[field] = finite(value[field]);
    if (counters[field] !== null) present = true;
  }
  return present ? counters : null;
}

function subtractCumulative(end, start) {
  if (!end) return null;
  const out = {};
  for (const field of TOKEN_FIELDS) {
    if (end[field] === null) out[field] = null;
    else out[field] = Math.max(0, end[field] - (start?.[field] ?? 0));
  }
  return out;
}

function safeRows(filePath) {
  let lines;
  try { lines = readFileSync(filePath, 'utf8').split(/\r?\n/); } catch { return []; }
  const rows = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (!lines[index].trim()) continue;
    try {
      const row = JSON.parse(lines[index]);
      if (row && typeof row === 'object') rows.push({ row, line: index + 1 });
    } catch {
      // Ignore malformed stream fragments.
    }
  }
  return rows;
}

function sessionIdFromPath(filePath) {
  const name = basename(filePath).replace(/\.jsonl$/i, '');
  const match = name.match(/-([0-9a-f]{8,}(?:-[0-9a-f-]{8,})?)$/i);
  return match?.[1] ?? name;
}

function codexRoot(home) {
  const supplied = resolve(home ?? homedir());
  return basename(supplied) === '.codex' ? supplied : join(supplied, '.codex');
}

function walkRollouts(root) {
  const files = [];
  const visit = (dir) => {
    let entries;
    try { entries = readdirSync(dir).sort(); } catch { return; }
    for (const entry of entries) {
      const filePath = join(dir, entry);
      let isDirectory = false;
      try { isDirectory = statSync(filePath).isDirectory(); } catch { continue; }
      if (isDirectory) visit(filePath);
      else if (/^rollout-.*\.jsonl$/i.test(entry)) files.push(filePath);
    }
  };
  if (existsSync(root)) visit(root);
  return files;
}

export function buildTranscriptIndex({ home = homedir() } = {}) {
  const entries = walkRollouts(join(codexRoot(home), 'sessions')).map((filePath) => {
    const edge = transcriptEdges(filePath);
    const rows = edge.head;
    const meta = rows.find((row) => row.type === 'session_meta')?.payload ?? {};
    const context = [...rows].reverse().find((row) => row.type === 'turn_context')?.payload ?? {};
    return {
      file: filePath,
      sessionId: meta.session_id ?? meta.id ?? sessionIdFromPath(filePath),
      cwd: context.cwd ?? meta.cwd ?? null,
      ...edgeTimes(edge),
    };
  });
  return { provider: 'codex', home, entries };
}

function parseRollout(filePath, {
  sessionId = null,
  startedAt = null,
  endedAt = null,
  confidence = 'exact',
} = {}) {
  const rows = safeRows(filePath);
  let observedSessionId = sessionId || null;
  let model = null;
  let cwd = null;
  const timestamps = [];
  const cumulative = [];
  for (const { row } of rows) {
    const timestamp = timeText(row.timestamp);
    if (timestamp) timestamps.push(timestamp);
    const payload = row.payload && typeof row.payload === 'object' ? row.payload : {};
    if (row.type === 'session_meta') {
      if (!observedSessionId && typeof payload.session_id === 'string') observedSessionId = payload.session_id;
      if (!observedSessionId && typeof payload.id === 'string') observedSessionId = payload.id;
      if (typeof payload.cwd === 'string' && payload.cwd) cwd = payload.cwd;
      if (typeof payload.model === 'string' && payload.model) model = payload.model;
    }
    if (row.type === 'turn_context') {
      if (typeof payload.cwd === 'string' && payload.cwd) cwd = payload.cwd;
      if (typeof payload.model === 'string' && payload.model) model = payload.model;
    }
    if (typeof row.model === 'string' && row.model) model = row.model;
    const raw = row.type === 'event_msg' && payload.type === 'token_count'
      ? payload.info?.total_token_usage ?? payload.total_token_usage ?? payload.usage
      : null;
    const counters = cumulativeFrom(raw);
    if (counters) cumulative.push({ at: timestamp, counters });
  }
  observedSessionId ??= sessionIdFromPath(filePath);

  const start = timeMs(startedAt);
  const end = timeMs(endedAt);
  let endRecord = null;
  for (const record of cumulative) {
    const at = timeMs(record.at);
    if (end !== null && (at === null || at > end)) continue;
    if (at === null && end !== null) continue;
    endRecord = record;
  }
  if (end === null) endRecord = cumulative.at(-1) ?? null;
  let baseline = null;
  if (start !== null) {
    for (const record of cumulative) {
      const at = timeMs(record.at);
      if (at !== null && at < start) baseline = record;
    }
  }
  const delta = subtractCumulative(endRecord?.counters ?? null, baseline?.counters ?? null);
  const tokens = delta
    ? tokenRecord({
      input: delta.input_tokens,
      cached: delta.cached_input_tokens,
      cacheWrite: delta.cache_write_input_tokens,
      output: delta.output_tokens,
      reasoning: delta.reasoning_output_tokens,
    })
    : blankTokens();
  const requestAt = endRecord?.at ?? null;
  const requests = delta ? [{ at: requestAt, model, tokens }] : [];
  const sortedTimes = timestamps.sort((a, b) => (timeMs(a) ?? 0) - (timeMs(b) ?? 0));
  return {
    tokens,
    model: model ?? null,
    sessionId: observedSessionId,
    file: filePath,
    firstAt: sortedTimes[0] ?? null,
    lastAt: sortedTimes.at(-1) ?? null,
    requests,
    confidence,
    cwd,
    allFirstAt: sortedTimes[0] ?? null,
    allLastAt: sortedTimes.at(-1) ?? null,
  };
}

function cwdMatches(parsed, cwd) {
  return typeof cwd !== 'string' || cwd === '' || parsed.cwd === cwd;
}

function overlaps(parsed, startedAt, endedAt) {
  const start = timeMs(startedAt);
  const end = timeMs(endedAt);
  const first = timeMs(parsed.allFirstAt);
  const last = timeMs(parsed.allLastAt);
  if (start === null && end === null) return true;
  if (first === null && last === null) return false;
  return (end === null || first === null || first <= end)
    && (start === null || last === null || last >= start);
}

/** Parse Codex's captured `codex exec --json` stdout usage stream. */
export function parseCodexStdout(input, { file = null, confidence = 'exact' } = {}) {
  let text = input;
  if (typeof input !== 'string') return blankRecord('none');
  try {
    if (existsSync(input) && statSync(input).isFile()) text = readFileSync(input, 'utf8');
  } catch { /* treat input as JSONL text */ }
  let sessionId = null;
  let usage = null;
  let at = null;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    if (row.type === 'thread.started' && typeof row.thread_id === 'string') sessionId = row.thread_id;
    if (row.type !== 'turn.completed' || !row.usage) continue;
    usage = row.usage;
  }
  if (!usage) return blankRecord('none');
  const tokens = tokenRecord({
    input: finite(usage.input_tokens),
    cached: finite(usage.cached_input_tokens),
    cacheWrite: finite(usage.cache_write_input_tokens),
    output: finite(usage.output_tokens),
    reasoning: finite(usage.reasoning_output_tokens),
  });
  return {
    tokens,
    model: null,
    sessionId,
    cwd: null,
    file,
    firstAt: at,
    lastAt: at,
    requests: [{ at, model: null, tokens }],
    confidence,
  };
}

/**
 * Read usage from Codex's durable rollout stores.
 *
 * @param {{sessionId?: string|null,cwd?: string|null,startedAt?: string|number|Date|null,endedAt?: string|number|Date|null,home?: string}} args
 */
export function readTranscriptUsage({
  sessionId = null,
  cwd = null,
  startedAt = null,
  endedAt = null,
  home = homedir(),
  index = null,
} = {}) {
  const wantedId = typeof sessionId === 'string' && sessionId ? sessionId : null;
  const indexed = index?.provider === 'codex' ? index.entries : null;
  const files = indexed
    ? indexed.filter((entry) => wantedId
      ? entry.sessionId === wantedId
      : (typeof cwd !== 'string' || cwd === '' || entry.cwd === cwd)
        && overlapsIndex(entry, startedAt, endedAt)).map((entry) => entry.file)
    : walkRollouts(join(codexRoot(home), 'sessions'));
  const candidates = [];
  for (const filePath of files) {
    const nameMatches = wantedId && (filePath.endsWith(`-${wantedId}.jsonl`) || filePath.endsWith(`${wantedId}.jsonl`));
    // Do not seed the parsed identity with the requested id while discovering
    // candidates: otherwise every rollout would appear to match the request.
    const parsed = parseRollout(filePath, { sessionId: null, startedAt: null, endedAt: null });
    if (wantedId) {
      if (nameMatches || parsed.sessionId === wantedId) candidates.push({ filePath, parsed });
      continue;
    }
    if (!cwdMatches(parsed, cwd) || !overlaps(parsed, startedAt, endedAt)) continue;
    candidates.push({ filePath, parsed });
  }
  if (candidates.length === 0) return blankRecord('none');
  if (candidates.length > 1) return blankRecord('ambiguous');
  const chosen = parseRollout(candidates[0].filePath, {
    sessionId: wantedId ?? candidates[0].parsed.sessionId,
    startedAt,
    endedAt,
    confidence: wantedId ? 'exact' : 'window',
  });
  return {
    tokens: chosen.tokens,
    model: chosen.model,
    sessionId: chosen.sessionId,
    cwd: chosen.cwd,
    file: chosen.file,
    firstAt: chosen.firstAt,
    lastAt: chosen.lastAt,
    requests: chosen.requests,
    confidence: chosen.confidence,
  };
}

export { blankTokens, tokenRecord };
