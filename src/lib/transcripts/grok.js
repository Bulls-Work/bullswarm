// Grok durable usage accounting.  Grok's streaming JSON does not expose
// token counters; the CLI writes authoritative per-inference counters to
// ~/.grok/logs/unified.jsonl instead.

import {
  readdirSync,
  readFileSync,
  statSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { edgeTimes, overlapsIndex, transcriptEdges } from './indexing.js';

const LONG_CONTEXT_THRESHOLD = 200_000;

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

function requestTokens(ctx = {}) {
  const prompt = finite(ctx.prompt_tokens);
  const cached = finite(ctx.cached_prompt_tokens);
  const cacheRead = prompt === 0 && cached === null
    ? 0
    : prompt === null || cached === null ? null : Math.min(prompt, cached);
  const standardRead = prompt === null || cacheRead === null
    ? null
    : Math.max(0, prompt - cacheRead);
  const reasoning = finite(ctx.reasoning_tokens);
  // Grok's completion counter is inclusive of its reasoning counter. Keep
  // the canonical classes exclusive so usage.js does not charge reasoning
  // twice (the provider's total is completion_tokens, not completion plus
  // reasoning).
  const completion = finite(ctx.completion_tokens);
  const output = completion == null || reasoning == null
    ? completion
    : Math.max(0, completion - reasoning);
  return {
    standardRead,
    cacheRead,
    cacheWrite5m: null,
    cacheWrite1h: null,
    cacheWrite: null,
    output,
    reasoning,
    totalKnown: knownSum([standardRead, cacheRead, output, reasoning]),
  };
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
      // Ignore malformed log lines; a valid inference row remains usable.
    }
  }
  return rows;
}

function grokRoots(home) {
  const supplied = resolve(home ?? homedir());
  const leaf = basename(supplied);
  if (leaf === '.grok' || leaf.startsWith('.grok-')) return [supplied];
  let names = [];
  try { names = readdirSync(supplied); } catch { /* no home */ }
  return [join(supplied, '.grok'), ...names.sort()
    .filter((name) => name.startsWith('.grok-'))
    .map((name) => join(supplied, name))];
}

function logFiles(home) {
  const files = [];
  for (const root of grokRoots(home)) {
    const filePath = join(root, 'logs', 'unified.jsonl');
    try {
      if (statSync(filePath).isFile()) files.push(filePath);
    } catch { /* missing store */ }
  }
  return files;
}

function parseLog(filePath, {
  sessionId = null,
  startedAt = null,
  endedAt = null,
  confidence = 'exact',
  rows: suppliedRows = null,
} = {}) {
  const rows = suppliedRows ?? safeRows(filePath);
  const records = [];
  const timestamps = [];
  let cwd = null;
  let model = null;
  let observedSessionId = sessionId;
  for (const { row } of rows) {
    if (sessionId && row.sid !== sessionId) continue;
    if (!observedSessionId && typeof row.sid === 'string' && row.sid) observedSessionId = row.sid;
    if (typeof row.ts === 'string' && timeMs(row.ts) !== null) timestamps.push(row.ts);
    if (row.msg === 'session created' && typeof row.ctx?.cwd === 'string') cwd = row.ctx.cwd;
    if (typeof row.ctx?.cwd === 'string' && row.ctx.cwd) cwd ??= row.ctx.cwd;
    if (row.msg === 'model changed' && typeof row.ctx?.model === 'string') model = row.ctx.model;
    if (typeof row.ctx?.model === 'string' && row.ctx.model) model ??= row.ctx.model;
    if (row.msg !== 'shell.turn.inference_done' || !row.ctx || !inWindow(row.ts, startedAt, endedAt)) continue;
    const tokens = requestTokens(row.ctx);
    const prompt = finite(row.ctx.prompt_tokens);
    records.push({
      at: timeText(row.ts),
      model: typeof row.ctx.model === 'string' && row.ctx.model ? row.ctx.model : model,
      tokens,
      contextTier: prompt !== null && prompt >= LONG_CONTEXT_THRESHOLD ? 'long' : 'short',
    });
  }
  const tokens = {
    standardRead: knownSum(records.map((record) => record.tokens.standardRead)),
    cacheRead: knownSum(records.map((record) => record.tokens.cacheRead)),
    cacheWrite5m: null,
    cacheWrite1h: null,
    cacheWrite: null,
    output: knownSum(records.map((record) => record.tokens.output)),
    reasoning: knownSum(records.map((record) => record.tokens.reasoning)),
    totalKnown: null,
  };
  tokens.totalKnown = knownSum([tokens.standardRead, tokens.cacheRead, tokens.output, tokens.reasoning]);
  const sortedTimes = timestamps.sort((a, b) => (timeMs(a) ?? 0) - (timeMs(b) ?? 0));
  const requestTimes = records.map((record) => record.at).filter(Boolean);
  return {
    tokens,
    model: records.at(-1)?.model ?? model ?? null,
    sessionId: observedSessionId,
    file: filePath,
    firstAt: requestTimes[0] ?? sortedTimes[0] ?? null,
    lastAt: requestTimes.at(-1) ?? sortedTimes.at(-1) ?? null,
    requests: records,
    confidence,
    cwd,
    allFirstAt: sortedTimes[0] ?? null,
    allLastAt: sortedTimes.at(-1) ?? null,
  };
}

export function buildTranscriptIndex({ home = homedir() } = {}) {
  const entries = logFiles(home).map((filePath) => {
    const edge = transcriptEdges(filePath);
    const cwd = edge.head.find((row) => typeof row.ctx?.cwd === 'string' && row.ctx.cwd)?.ctx.cwd ?? null;
    const sessionId = edge.head.find((row) => typeof row.sid === 'string' && row.sid)?.sid ?? null;
    return { file: filePath, sessionId, cwd, ...edgeTimes(edge, 'ts') };
  });
  return { provider: 'grok', home, entries, rowsByFile: new Map() };
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

/**
 * Read usage from Grok's unified durable log.
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
  const indexed = index?.provider === 'grok' ? index : null;
  const files = indexed
    // Grok's unified log is one file containing many session ids. Keep the
    // file for an exact id and let the parsed rows select that session below;
    // the index's representative cwd is only a fast hint for window scans.
    ? indexed.entries.filter((entry) => wantedId || overlapsIndex(entry, startedAt, endedAt)).map((entry) => entry.file)
    : logFiles(home);
  const candidates = [];
  for (const filePath of files) {
    let rows = indexed?.rowsByFile.get(filePath);
    if (!rows) {
      rows = safeRows(filePath);
      indexed?.rowsByFile.set(filePath, rows);
    }
    if (wantedId) {
      const hasSession = rows.some(({ row }) => row.sid === wantedId);
      if (!hasSession) continue;
      const parsed = parseLog(filePath, { sessionId: wantedId, startedAt: null, endedAt: null, rows });
      if (parsed.sessionId === wantedId) candidates.push({ filePath, parsed });
      continue;
    }
    // A log can contain many sessions.  Discover their ids first, then parse
    // each session independently so candidate ambiguity is explicit.
    const ids = new Set();
    for (const { row } of rows) {
      if (typeof row.sid === 'string' && row.sid) ids.add(row.sid);
    }
    for (const id of ids) {
      const parsed = parseLog(filePath, { sessionId: id, startedAt: null, endedAt: null, rows });
      if ((typeof cwd === 'string' && cwd !== '' && parsed.cwd !== cwd)
        || !overlaps(parsed, startedAt, endedAt)) continue;
      candidates.push({ filePath, parsed });
    }
  }
  if (candidates.length === 0) return blankRecord('none');
  if (candidates.length > 1) return blankRecord('ambiguous');
  const chosen = parseLog(candidates[0].filePath, {
    sessionId: wantedId ?? candidates[0].parsed.sessionId,
    startedAt,
    endedAt,
    confidence: wantedId ? 'exact' : 'window',
    rows: indexed?.rowsByFile.get(candidates[0].filePath) ?? null,
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

export { blankTokens, requestTokens };
