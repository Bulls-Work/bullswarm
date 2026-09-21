// Claude Code durable transcript accounting.
//
// Claude streams several partial assistant rows for one API request.  The
// final row is the authoritative usage row, so this reader deliberately keeps
// the last row for each message.id:requestId (the same rule as the audit
// script) before applying an attempt time window.

import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import {
  attemptTaskKeys,
  edgeTimes,
  incrementalEntries,
  overlapsIndex,
  promptKeys,
  promptMatchesTask,
  scanHeadRows,
  transcriptEdges,
} from './indexing.js';

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

function claudeTokens(usage = {}) {
  const standardRead = finite(usage.input_tokens);
  const cacheRead = finite(usage.cache_read_input_tokens);
  const cacheWrite5m = finite(
    usage.cache_creation?.ephemeral_5m_input_tokens
      ?? usage.cache_creation_5m_input_tokens,
  );
  const cacheWrite1h = finite(
    usage.cache_creation?.ephemeral_1h_input_tokens
      ?? usage.cache_creation_1h_input_tokens,
  );
  const cacheWriteDirect = finite(
    usage.cache_write_input_tokens
      ?? usage.cache_write_tokens
      ?? usage.cache_creation_input_tokens,
  );
  const reasoning = finite(
    usage.output_tokens_details?.thinking_tokens
      ?? usage.reasoning_tokens,
  );
  const outputInclusive = finite(usage.output_tokens);
  const output = outputInclusive === null
    ? null
    : reasoning === null ? outputInclusive : Math.max(0, outputInclusive - reasoning);
  const cacheWrite = cacheWrite5m !== null || cacheWrite1h !== null
    ? (cacheWrite5m ?? 0) + (cacheWrite1h ?? 0)
    : cacheWriteDirect;
  const tokens = {
    standardRead,
    cacheRead,
    cacheWrite5m,
    cacheWrite1h,
    cacheWrite,
    output,
    reasoning,
    totalKnown: knownSum([
      standardRead,
      cacheRead,
      cacheWrite5m,
      cacheWrite1h,
      cacheWrite5m === null && cacheWrite1h === null ? cacheWrite : null,
      output,
      reasoning,
    ]),
  };
  return tokens;
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

function resultRecord({ tokens, model = null, sessionId = null, file = null, at = null, confidence = 'exact' }) {
  return {
    tokens,
    model: typeof model === 'string' && model ? model : null,
    sessionId: typeof sessionId === 'string' && sessionId ? sessionId : null,
    cwd: null,
    file,
    firstAt: at,
    lastAt: at,
    requests: [{ at, model: typeof model === 'string' && model ? model : null, tokens }],
    confidence,
  };
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
      // A damaged line cannot provide trustworthy usage and is ignored.
    }
  }
  return rows;
}

function sessionIdFromPath(filePath) {
  return basename(filePath).replace(/\.jsonl$/i, '');
}

function sidechainFiles(parentPath) {
  const sessionDir = join(dirname(parentPath), sessionIdFromPath(parentPath), 'subagents');
  if (!existsSync(sessionDir)) return [];
  let names;
  try {
    names = readdirSync(sessionDir).sort();
  } catch {
    return [];
  }
  return names
    .filter((name) => name.startsWith('agent-') && name.endsWith('.jsonl'))
    .map((name) => join(sessionDir, name))
    .filter((filePath) => {
      try { return statSync(filePath).isFile(); } catch { return false; }
    });
}

function slugForCwd(cwd) {
  return typeof cwd === 'string' ? cwd.replace(/[^A-Za-z0-9]/g, '-') : null;
}

function claudeRoots(home) {
  const supplied = resolve(home ?? homedir());
  const leaf = basename(supplied);
  if (leaf === '.claude' || leaf.startsWith('.claude-')) return [supplied];
  let names = [];
  try { names = readdirSync(supplied); } catch { /* no home */ }
  const roots = [join(supplied, '.claude')];
  for (const name of names.sort()) {
    if (name.startsWith('.claude-')) roots.push(join(supplied, name));
  }
  return roots;
}

function parentFiles(home, cwd = null, sessionId = null) {
  const files = [];
  const wantedSlug = slugForCwd(cwd);
  for (const root of claudeRoots(home)) {
    const projects = join(root, 'projects');
    if (!existsSync(projects)) continue;
    let slugs;
    try { slugs = readdirSync(projects).sort(); } catch { continue; }
    for (const slug of slugs) {
      if (wantedSlug && slug !== wantedSlug) continue;
      const projectDir = join(projects, slug);
      let entries;
      try { entries = readdirSync(projectDir).sort(); } catch { continue; }
      for (const entry of entries) {
        if (!entry.endsWith('.jsonl')) continue;
        if (sessionId && !entry.endsWith(`${sessionId}.jsonl`)) continue;
        const filePath = join(projectDir, entry);
        try {
          if (statSync(filePath).isFile()) files.push(filePath);
        } catch { /* raced with cleanup */ }
      }
    }
  }
  return files;
}

function parsedSession(parentPath, {
  sessionId = null,
  startedAt = null,
  endedAt = null,
  confidence = 'exact',
} = {}) {
  const files = [parentPath, ...sidechainFiles(parentPath)];
  const deduped = new Map();
  const allTimes = [];
  let cwd = null;
  let observedSessionId = sessionId || sessionIdFromPath(parentPath);
  let fallbackModel = null;
  for (const filePath of files) {
    for (const { row, line } of safeRows(filePath)) {
      if (typeof row.timestamp === 'string' && timeMs(row.timestamp) !== null) allTimes.push(row.timestamp);
      if (typeof row.cwd === 'string' && row.cwd) cwd = row.cwd;
      if (!observedSessionId && typeof row.sessionId === 'string' && row.sessionId) observedSessionId = row.sessionId;
      if (!observedSessionId && typeof row.session_id === 'string' && row.session_id) observedSessionId = row.session_id;
      if (typeof row.model === 'string' && row.model) fallbackModel = row.model;
      if (row.type !== 'assistant' || !row.message || typeof row.message !== 'object') continue;
      if (typeof row.message.model === 'string' && row.message.model) fallbackModel = row.message.model;
      const messageId = typeof row.message.id === 'string' && row.message.id ? row.message.id : null;
      const requestId = typeof row.requestId === 'string' && row.requestId ? row.requestId : '';
      const key = messageId ? `${messageId}:${requestId}` : `${filePath}:line-${line}`;
      const entry = { row, filePath, line, message: row.message };
      if (deduped.has(key)) deduped.set(key, entry);
      else deduped.set(key, entry);
    }
  }

  const selected = [...deduped.values()]
    .filter(({ row }) => inWindow(row.timestamp, startedAt, endedAt))
    .sort((a, b) => (timeMs(a.row.timestamp) ?? 0) - (timeMs(b.row.timestamp) ?? 0));
  const requests = selected.map(({ row, message }) => ({
    at: timeText(row.timestamp),
    model: typeof message.model === 'string' && message.model ? message.model : fallbackModel,
    tokens: claudeTokens(message.usage ?? row.usage ?? {}),
  }));
  const cacheWrite5m = knownSum(requests.map((request) => request.tokens.cacheWrite5m));
  const cacheWrite1h = knownSum(requests.map((request) => request.tokens.cacheWrite1h));
  const directCacheWrite = knownSum(requests.map((request) => (
    request.tokens.cacheWrite5m === null && request.tokens.cacheWrite1h === null
      ? request.tokens.cacheWrite
      : null
  )));
  const componentCacheWrite = knownSum([cacheWrite5m, cacheWrite1h]);
  const tokens = {
    standardRead: knownSum(requests.map((request) => request.tokens.standardRead)),
    cacheRead: knownSum(requests.map((request) => request.tokens.cacheRead)),
    cacheWrite5m,
    cacheWrite1h,
    cacheWrite: componentCacheWrite === null
      ? directCacheWrite
      : componentCacheWrite + (directCacheWrite ?? 0),
    output: knownSum(requests.map((request) => request.tokens.output)),
    reasoning: knownSum(requests.map((request) => request.tokens.reasoning)),
    totalKnown: null,
  };
  tokens.totalKnown = knownSum([
    tokens.standardRead,
    tokens.cacheRead,
    tokens.cacheWrite5m,
    tokens.cacheWrite1h,
    tokens.cacheWrite5m === null && tokens.cacheWrite1h === null
      ? tokens.cacheWrite
      : directCacheWrite,
    tokens.output,
    tokens.reasoning,
  ]);
  const selectedTimes = requests.map((request) => request.at).filter(Boolean);
  const sessionTimes = allTimes.sort((a, b) => (timeMs(a) ?? 0) - (timeMs(b) ?? 0));
  return {
    tokens,
    model: requests.at(-1)?.model ?? fallbackModel,
    sessionId: observedSessionId,
    file: parentPath,
    firstAt: selectedTimes[0] ?? sessionTimes[0] ?? null,
    lastAt: selectedTimes.at(-1) ?? sessionTimes.at(-1) ?? null,
    requests,
    confidence,
    cwd,
    allFirstAt: sessionTimes[0] ?? null,
    allLastAt: sessionTimes.at(-1) ?? null,
  };
}

function cwdMatches(parsed, cwd, parentPath) {
  if (typeof cwd !== 'string' || cwd === '') return true;
  return parsed.cwd === cwd || basename(dirname(parentPath)) === slugForCwd(cwd);
}

function candidateFiles(home, cwd, sessionId) {
  // A direct id is looked up across all stores.  For cwd resolution the slug
  // narrows the scan while the parsed cwd remains the authoritative check.
  const narrowed = parentFiles(home, sessionId ? null : cwd, sessionId);
  // The on-disk convention is `<session-id>.jsonl`, but older Claude builds
  // have emitted a different filename while retaining `row.sessionId`.  Fall
  // back to a full project scan only when the conventional lookup found no
  // file, keeping the common path cheap.
  return sessionId && narrowed.length === 0
    ? parentFiles(home, null, null)
    : narrowed;
}

// The first user turn: the prompt rows before the first assistant row.
// Meta rows (hook/command output) and tool results are not the prompt.
function promptStep(row, texts) {
  if (row?.type === 'assistant') return true;
  if (row?.type !== 'user' || row.isMeta || row.isSidechain) return false;
  const message = row.message && typeof row.message === 'object' ? row.message : null;
  if (!message || (message.role && message.role !== 'user')) return false;
  const content = message.content;
  const text = typeof content === 'string'
    ? content
    : (Array.isArray(content) ? content : [])
      .filter((part) => part?.type === 'text' && typeof part.text === 'string')
      .map((part) => part.text)
      .join('\n');
  if (text.trim()) texts.push(text);
  return false;
}

function promptTexts(filePath, headRows = null) {
  const texts = [];
  if (Array.isArray(headRows)) {
    for (const row of headRows) if (promptStep(row, texts)) return texts;
  }
  const scanned = [];
  scanHeadRows(filePath, (row) => promptStep(row, scanned));
  return scanned;
}

/** First-user-turn keys for one session file (paths it quotes, text hashes). */
export function sessionPromptKeys(filePath, headRows = null) {
  return promptKeys(promptTexts(filePath, headRows));
}

/**
 * Index every transcript's identity, cwd, edge times and first-turn keys.
 * `previous` (an earlier index of the same home) lets unchanged files be
 * reused; `changedFiles` names the files read this time and `grownFrom`
 * the previous last timestamp of each one that only grew.
 */
export function buildTranscriptIndex({ home = homedir(), previous = null } = {}) {
  const reusable = previous?.provider === 'claude-code' && previous?.home === home ? previous : null;
  const { entries, changedFiles, grownFrom } = incrementalEntries(parentFiles(home, null, null), reusable, (filePath) => {
    const edge = transcriptEdges(filePath);
    const rows = edge.head;
    const cwd = rows.find((row) => typeof row.cwd === 'string' && row.cwd)?.cwd ?? null;
    const sessionId = rows.find((row) => typeof (row.sessionId ?? row.session_id) === 'string');
    return {
      file: filePath,
      sessionId: sessionId?.sessionId ?? sessionId?.session_id ?? sessionIdFromPath(filePath),
      cwd,
      ...edgeTimes(edge),
      ...sessionPromptKeys(filePath, rows),
    };
  });
  return { provider: 'claude-code', home, entries, changedFiles, grownFrom };
}

/** Parse one captured Claude result event (useful when no durable transcript exists). */
export function parseClaudeResultEvent(input, { file = null, confidence = 'exact' } = {}) {
  let row = input;
  if (typeof input === 'string') {
    let text = input;
    try {
      if (existsSync(input) && statSync(input).isFile()) text = readFileSync(input, 'utf8');
    } catch { /* treat input as JSON text */ }
    try { row = JSON.parse(text); } catch { return blankRecord('none'); }
  }
  if (!row || typeof row !== 'object') return blankRecord('none');
  const usage = row.usage ?? row.message?.usage ?? {};
  const model = typeof row.model === 'string' && row.model
    ? row.model
    : Object.keys(row.modelUsage ?? {})[0] ?? null;
  const at = timeText(row.timestamp ?? null);
  return resultRecord({
    tokens: claudeTokens(usage),
    model,
    sessionId: row.session_id ?? row.sessionId ?? null,
    file,
    at,
    confidence,
  });
}

function chosenRecord(filePath, { sessionId, startedAt, endedAt, confidence, wantedId = null }) {
  const chosen = parsedSession(filePath, { sessionId, startedAt, endedAt, confidence });
  return {
    tokens: chosen.tokens,
    model: chosen.model ?? null,
    sessionId: chosen.sessionId ?? wantedId,
    cwd: chosen.cwd ?? null,
    file: chosen.file,
    firstAt: chosen.firstAt,
    lastAt: chosen.lastAt,
    requests: chosen.requests,
    confidence: chosen.confidence,
  };
}

// A session whose first turn quotes another Bullswarm task file provably
// belongs to that task, so the cwd/time fallback must not hand it to this one.
function namesOtherTask(entry, keys) {
  if (!keys?.paths.length) return false;
  return (entry.taskPaths ?? []).some((path) => /\/task-[^/]+\.md$/.test(path) && !keys.paths.includes(path));
}

function promptEntries(indexed, home) {
  if (indexed) return indexed;
  return parentFiles(home, null, null).map((filePath) => ({
    file: filePath,
    ...sessionPromptKeys(filePath),
  }));
}

function taskTextMatches(entries, keys, startedAt, endedAt) {
  return entries
    .filter((entry) => promptMatchesTask(entry, keys))
    .filter((entry) => overlapsIndex(
      entry.firstAt !== undefined ? entry : { ...entry, ...edgeTimes(transcriptEdges(entry.file)) },
      startedAt,
      endedAt,
    ));
}

/**
 * Read usage from Claude Code's durable JSONL transcript stores.
 *
 * Precedence: a unique session id; else a unique session whose first user
 * turn quotes the attempt's task file or carries its exact text; else a
 * unique cwd + time-window match. More than one candidate at any step is
 * `ambiguous` — never a pick by recency or name.
 *
 * @param {{sessionId?: string|null,cwd?: string|null,startedAt?: string|number|Date|null,endedAt?: string|number|Date|null,home?: string,taskText?: string|null,taskFile?: string|null,taskPath?: string|null}} args
 */
export function readTranscriptUsage({
  sessionId = null,
  cwd = null,
  startedAt = null,
  endedAt = null,
  home = homedir(),
  index = null,
  taskText = null,
  taskFile = null,
  taskPath = null,
} = {}) {
  const wantedId = typeof sessionId === 'string' && sessionId ? sessionId : null;
  const indexed = index?.provider === 'claude-code' ? index.entries : null;
  const keys = attemptTaskKeys({ taskText, taskFile, taskPath });

  if (wantedId) {
    const files = indexed
      ? indexed.filter((entry) => entry.sessionId === wantedId).map((entry) => entry.file)
      : candidateFiles(home, cwd, wantedId);
    const candidates = [];
    for (const filePath of files) {
      const parsed = parsedSession(filePath, { sessionId: wantedId, startedAt: null, endedAt: null });
      if (parsed.sessionId === wantedId || sessionIdFromPath(filePath) === wantedId) candidates.push(filePath);
    }
    if (candidates.length > 1) return blankRecord('ambiguous');
    if (candidates.length === 1) {
      return chosenRecord(candidates[0], { sessionId: wantedId, startedAt, endedAt, confidence: 'exact', wantedId });
    }
    // A failed session lookup may still resolve through one unique task-text
    // match; it never widens to a cwd/time guess.
    if (!keys) return blankRecord('none');
  }

  let entries = null;
  if (keys) {
    entries = promptEntries(indexed, home);
    const matches = taskTextMatches(entries, keys, startedAt, endedAt);
    if (matches.length > 1) return blankRecord('ambiguous');
    if (matches.length === 1) {
      return chosenRecord(matches[0].file, { sessionId: null, startedAt, endedAt, confidence: 'task-text' });
    }
    if (wantedId) return blankRecord('none');
  }

  const excluded = new Set((entries ?? [])
    .filter((entry) => namesOtherTask(entry, keys))
    .map((entry) => entry.file));
  const files = indexed
    ? indexed.filter((entry) => (typeof cwd !== 'string' || cwd === ''
      || entry.cwd === cwd || basename(dirname(entry.file)) === slugForCwd(cwd))
      && overlapsIndex(entry, startedAt, endedAt)).map((entry) => entry.file)
    : candidateFiles(home, cwd, null);
  const candidates = [];
  for (const filePath of files) {
    if (excluded.has(filePath)) continue;
    const parsed = parsedSession(filePath, { sessionId: null, startedAt: null, endedAt: null });
    if (!cwdMatches(parsed, cwd, filePath)) continue;
    const first = timeMs(parsed.allFirstAt);
    const last = timeMs(parsed.allLastAt);
    const start = timeMs(startedAt);
    const end = timeMs(endedAt);
    const overlaps = (start === null && end === null)
      || (first === null && last === null)
      || (end === null || first === null || first <= end)
        && (start === null || last === null || last >= start);
    if (overlaps) candidates.push({ filePath, parsed });
  }

  if (candidates.length === 0) return blankRecord('none');
  if (candidates.length > 1) return blankRecord('ambiguous');
  return chosenRecord(candidates[0].filePath, {
    sessionId: candidates[0].parsed.sessionId,
    startedAt,
    endedAt,
    confidence: 'window',
  });
}

export { blankTokens, claudeTokens };
