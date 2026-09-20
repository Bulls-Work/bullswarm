// Command Code durable transcript accounting.
//
// A session is stored as JSONL at
// ~/.commandcode/projects/<cwd-slug>/<session-id>.jsonl.  Assistant message
// rows carry inclusive inputTokens plus cacheReadTokens/cacheWriteTokens, so
// the canonical fresh-input class is input - cache read - cache write.  The
// historical Bullswarm attempts were launched with --no-session and therefore
// have checkpoints rather than these usage-bearing transcripts; those attempts
// remain unknown until Command Code is run with session persistence enabled.

import {
  readdirSync,
  readFileSync,
  statSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { edgeTimes, overlapsIndex, transcriptEdges } from './indexing.js';

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

function knownSum(values) {
  const known = values.filter((value) => value !== null);
  return known.length ? known.reduce((sum, value) => sum + value, 0) : null;
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

function blankRecord(confidence = 'none', reason = null) {
  const record = {
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
  if (reason) record.reason = reason;
  return record;
}

/** Convert one observed Command Code usage object into exclusive classes. */
function commandCodeTokens(usage = {}) {
  const input = finite(usage.inputTokens ?? usage.input_tokens);
  const cacheRead = finite(usage.cacheReadTokens ?? usage.cache_read_input_tokens);
  const cacheWrite = finite(usage.cacheWriteTokens ?? usage.cache_write_input_tokens);
  const standardRead = input === null || cacheRead === null || cacheWrite === null
    ? null
    : Math.max(0, input - cacheRead - cacheWrite);
  const output = finite(usage.outputTokens ?? usage.output_tokens);
  const reasoning = finite(usage.reasoningTokens ?? usage.reasoning_tokens);
  const tokens = {
    standardRead,
    cacheRead,
    cacheWrite5m: null,
    cacheWrite1h: null,
    cacheWrite,
    output,
    reasoning,
    totalKnown: null,
  };
  tokens.totalKnown = knownSum([
    standardRead,
    cacheRead,
    cacheWrite,
    output,
    reasoning,
  ]);
  return tokens;
}

function hasTokenUsage(usage) {
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) return false;
  return [
    'inputTokens',
    'input_tokens',
    'cacheReadTokens',
    'cache_read_input_tokens',
    'cacheWriteTokens',
    'cache_write_input_tokens',
    'outputTokens',
    'output_tokens',
    'reasoningTokens',
    'reasoning_tokens',
  ].some((field) => Object.prototype.hasOwnProperty.call(usage, field));
}

function safeRows(filePath) {
  let lines;
  try {
    lines = readFileSync(filePath, 'utf8').split(/\r?\n/);
  } catch {
    return [];
  }
  const rows = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (!lines[index].trim()) continue;
    try {
      const row = JSON.parse(lines[index]);
      if (row && typeof row === 'object') rows.push({ row, line: index + 1 });
    } catch {
      // A torn or malformed line cannot provide trustworthy usage.
    }
  }
  return rows;
}

function sessionIdFromPath(filePath) {
  return basename(filePath).replace(/\.jsonl$/i, '');
}

function slugForCwd(cwd) {
  if (typeof cwd !== 'string' || cwd.trim() === '') return null;
  return cwd.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function commandCodeRoots(home) {
  const supplied = resolve(home ?? homedir());
  const leaf = basename(supplied).toLowerCase();
  if (leaf === '.commandcode' || leaf.startsWith('.commandcode-')) return [supplied];
  let names = [];
  try { names = readdirSync(supplied).sort(); } catch { /* no home */ }
  return [
    join(supplied, '.commandcode'),
    ...names
      .filter((name) => name.toLowerCase().startsWith('.commandcode-'))
      .map((name) => join(supplied, name)),
  ];
}

function isTranscriptFile(name) {
  return name.endsWith('.jsonl')
    && !name.endsWith('.checkpoints.jsonl')
    && !name.startsWith('hooks-audit-');
}

function projectFiles(home, cwd = null, sessionId = null) {
  const files = [];
  const wantedSlug = slugForCwd(cwd);
  for (const root of commandCodeRoots(home)) {
    const projects = join(root, 'projects');
    let slugs;
    try { slugs = readdirSync(projects).sort(); } catch { continue; }
    for (const slug of slugs) {
      if (wantedSlug && slug !== wantedSlug) continue;
      const projectDir = join(projects, slug);
      let entries;
      try { entries = readdirSync(projectDir).sort(); } catch { continue; }
      for (const entry of entries) {
        if (!isTranscriptFile(entry)) continue;
        if (sessionId && entry !== `${sessionId}.jsonl`) continue;
        const filePath = join(projectDir, entry);
        try {
          if (statSync(filePath).isFile()) files.push(filePath);
        } catch { /* raced with cleanup */ }
      }
    }
  }
  return files;
}

function candidateFiles(home, cwd, sessionId) {
  const narrowed = projectFiles(home, cwd, sessionId);
  // A legacy store can retain the session id in a row while using a different
  // filename. Fall back to the full project scan only when the conventional
  // `<session-id>.jsonl` lookup found nothing.
  return sessionId && narrowed.length === 0
    ? projectFiles(home, null, null)
    : narrowed;
}

function rowSessionId(row) {
  if (row?.type === 'session' && typeof row.id === 'string' && row.id) return row.id;
  for (const value of [row?.sessionId, row?.session_id]) {
    if (typeof value === 'string' && value) return value;
  }
  return null;
}

function rowModel(row) {
  for (const value of [row?.model, row?.modelID, row?.modelId, row?.message?.model]) {
    if (typeof value === 'string' && value) return value;
  }
  return null;
}

function rowCwd(row) {
  for (const value of [row?.cwd, row?.path?.cwd, row?.message?.cwd]) {
    if (typeof value === 'string' && value) return value;
  }
  return null;
}

function rowTimestamp(row) {
  return row?.timestamp ?? row?.message?.meta?.createdAt ?? row?.createdAt ?? null;
}

function isAssistantMessage(row) {
  return row?.message?.role === 'assistant' || row?.role === 'assistant';
}

function parseSession(filePath, {
  sessionId = null,
  startedAt = null,
  endedAt = null,
  confidence = 'exact',
  rows: suppliedRows = null,
} = {}) {
  const rows = suppliedRows ?? safeRows(filePath);
  let observedSessionId = sessionId || null;
  let cwd = null;
  let fallbackModel = null;
  const allTimes = [];
  const records = [];

  for (const { row } of rows) {
    const at = rowTimestamp(row);
    const textAt = timeText(at);
    if (textAt) allTimes.push(textAt);
    const observed = rowSessionId(row);
    if (!observedSessionId && observed) observedSessionId = observed;
    const observedCwd = rowCwd(row);
    if (observedCwd) cwd = observedCwd;
    const observedModel = rowModel(row);
    if (observedModel) fallbackModel = observedModel;

    const usage = row?.usage ?? row?.message?.usage;
    if (!isAssistantMessage(row) || !hasTokenUsage(usage)) continue;
    const tokens = commandCodeTokens(usage);
    records.push({
      at: textAt,
      model: observedModel ?? fallbackModel,
      tokens,
    });
  }

  observedSessionId ??= sessionIdFromPath(filePath);
  const selected = records.filter((record) => inWindow(record.at, startedAt, endedAt));
  const tokens = {
    standardRead: knownSum(selected.map((record) => record.tokens.standardRead)),
    cacheRead: knownSum(selected.map((record) => record.tokens.cacheRead)),
    cacheWrite5m: null,
    cacheWrite1h: null,
    cacheWrite: knownSum(selected.map((record) => record.tokens.cacheWrite)),
    output: knownSum(selected.map((record) => record.tokens.output)),
    reasoning: knownSum(selected.map((record) => record.tokens.reasoning)),
    totalKnown: null,
  };
  tokens.totalKnown = knownSum([
    tokens.standardRead,
    tokens.cacheRead,
    tokens.cacheWrite,
    tokens.output,
    tokens.reasoning,
  ]);
  const requestTimes = selected.map((record) => record.at).filter(Boolean);
  const sortedAllTimes = allTimes.sort((a, b) => (timeMs(a) ?? 0) - (timeMs(b) ?? 0));
  return {
    tokens,
    model: selected.at(-1)?.model ?? fallbackModel ?? null,
    sessionId: observedSessionId,
    file: filePath,
    firstAt: requestTimes[0] ?? sortedAllTimes[0] ?? null,
    lastAt: requestTimes.at(-1) ?? sortedAllTimes.at(-1) ?? null,
    requests: selected,
    confidence,
    cwd,
    allFirstAt: sortedAllTimes[0] ?? null,
    allLastAt: sortedAllTimes.at(-1) ?? null,
  };
}

function cwdMatches(parsed, cwd, filePath) {
  if (typeof cwd !== 'string' || cwd === '') return true;
  return parsed.cwd === cwd || basename(dirname(filePath)) === slugForCwd(cwd);
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

export function buildTranscriptIndex({ home = homedir() } = {}) {
  const entries = projectFiles(home, null, null).map((filePath) => {
    const edge = transcriptEdges(filePath);
    const rows = [...edge.head, ...edge.tail];
    const session = rows.find((row) => row?.type === 'session');
    const sessionId = session?.id
      ?? rows.find((row) => typeof row?.sessionId === 'string')?.sessionId
      ?? sessionIdFromPath(filePath);
    const cwd = session?.cwd
      ?? rows.find((row) => typeof row?.cwd === 'string' && row.cwd)?.cwd
      ?? null;
    return {
      file: filePath,
      sessionId,
      cwd,
      ...edgeTimes(edge),
    };
  });
  return { provider: 'command-code', home, entries };
}

/**
 * Read usage from Command Code's durable JSONL transcript store.
 *
 * @param {{sessionId?: string|null,cwd?: string|null,startedAt?: string|number|Date|null,endedAt?: string|number|Date|null,home?: string,index?: object}} args
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
  const indexed = index?.provider === 'command-code' ? index.entries : null;
  const files = indexed
    ? indexed.filter((entry) => wantedId
      ? entry.sessionId === wantedId
      : (typeof cwd !== 'string' || cwd === '' || entry.cwd === cwd
        || basename(dirname(entry.file)) === slugForCwd(cwd))
        && overlapsIndex(entry, startedAt, endedAt)).map((entry) => entry.file)
    : candidateFiles(home, cwd, wantedId);

  const candidates = [];
  for (const filePath of files) {
    const parsed = parseSession(filePath, { sessionId: null, startedAt: null, endedAt: null });
    if (wantedId) {
      if (parsed.sessionId === wantedId || sessionIdFromPath(filePath) === wantedId) {
        candidates.push({ filePath, parsed });
      }
      continue;
    }
    if (!cwdMatches(parsed, cwd, filePath) || !overlaps(parsed, startedAt, endedAt)) continue;
    candidates.push({ filePath, parsed });
  }

  if (candidates.length === 0) {
    return blankRecord('none', 'no matching command-code transcript');
  }
  if (candidates.length > 1) {
    return blankRecord('ambiguous', 'multiple command-code transcripts matched');
  }

  const chosen = parseSession(candidates[0].filePath, {
    sessionId: wantedId ?? candidates[0].parsed.sessionId,
    startedAt,
    endedAt,
    confidence: wantedId ? 'exact' : 'window',
  });
  const result = {
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
  if (chosen.requests.length === 0) {
    result.reason = 'command-code transcripts record no token usage';
  }
  return result;
}

export { blankTokens, commandCodeTokens };
