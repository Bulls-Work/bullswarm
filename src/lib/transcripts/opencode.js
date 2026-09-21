// OpenCode's durable transcript reader.
//
// OpenCode keeps its sessions in a SQLite database rather than a stream file.
// The database is opened read-only in place; callers must not copy it (the
// owner's database can be several gigabytes and may have a live WAL).

import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

const require = createRequire(import.meta.url);

const PROVIDER = 'opencode';

function finite(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function timeMs(value) {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || value.trim() === '') return null;
  const text = value.trim();
  // OpenCode stores epoch milliseconds in JSON and SQLite INTEGER columns.
  if (/^-?\d+(?:\.\d+)?$/.test(text)) {
    const number = Number(text);
    if (Number.isFinite(number)) return number;
  }
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : null;
}

function timeText(value) {
  const milliseconds = timeMs(value);
  return milliseconds === null ? null : new Date(milliseconds).toISOString();
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
    reason,
  };
}

function parseJson(value) {
  if (value && typeof value === 'object') return value;
  if (typeof value !== 'string' || value.trim() === '') return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function modelId(value) {
  const parsed = parseJson(value);
  if (parsed) {
    const id = parsed.id ?? parsed.modelID ?? parsed.modelId;
    if (typeof id === 'string' && id.trim()) return id.trim();
  }
  if (typeof value === 'string' && value.trim()) return value.trim();
  return null;
}

function tokensFromData(data) {
  const raw = data?.tokens;
  if (!raw || typeof raw !== 'object') return blankTokens();

  // OpenCode's `input` counter is the fresh-input class.  The captured
  // database rows prove that cache.read/cache.write are separate counters, so
  // do not subtract either cache class from input here.
  const standardRead = finite(raw.input);
  const cacheRead = finite(raw.cache?.read);
  const cacheWrite = finite(raw.cache?.write);
  const output = finite(raw.output);
  const reasoning = finite(raw.reasoning);
  return {
    standardRead,
    cacheRead,
    cacheWrite5m: null,
    cacheWrite1h: null,
    cacheWrite,
    output,
    reasoning,
    totalKnown: knownSum([standardRead, cacheRead, cacheWrite, output, reasoning]),
  };
}

function tokensFromSession(row) {
  if (!row || typeof row !== 'object') return blankTokens();
  const standardRead = finite(row.tokens_input);
  const cacheRead = finite(row.tokens_cache_read);
  const cacheWrite = finite(row.tokens_cache_write);
  const output = finite(row.tokens_output);
  const reasoning = finite(row.tokens_reasoning);
  return {
    standardRead,
    cacheRead,
    cacheWrite5m: null,
    cacheWrite1h: null,
    cacheWrite,
    output,
    reasoning,
    totalKnown: knownSum([standardRead, cacheRead, cacheWrite, output, reasoning]),
  };
}

function hasTokenFields(data) {
  const raw = data?.tokens;
  return !!raw && typeof raw === 'object'
    && ['input', 'output', 'reasoning', 'cache'].some((field) => (
      field === 'cache'
        ? raw.cache && typeof raw.cache === 'object'
          && ('read' in raw.cache || 'write' in raw.cache)
        : field in raw
    ));
}

function messageCreated(row, data) {
  return timeMs(data?.time?.created ?? row?.time_created);
}

function messageCompleted(row, data) {
  return timeMs(data?.time?.completed ?? row?.time_updated ?? row?.time_created);
}

function inWindow(timestamp, startedAt, endedAt) {
  const start = timeMs(startedAt);
  const end = timeMs(endedAt);
  if (start === null && end === null) return true;
  const at = timeMs(timestamp);
  if (at === null) return false;
  return (start === null || at >= start) && (end === null || at <= end);
}

function overlaps(firstAt, lastAt, startedAt, endedAt) {
  const start = timeMs(startedAt);
  const end = timeMs(endedAt);
  const first = timeMs(firstAt);
  const last = timeMs(lastAt);
  if (start === null && end === null) return true;
  if (first === null && last === null) return false;
  return (end === null || first === null || first <= end)
    && (start === null || last === null || last >= start);
}

const TASK_MATCH_SLOP_MS = 120_000;

function createdNearWindow(entry, startedAt, endedAt) {
  const created = timeMs(entry?.firstAt ?? entry?.allFirstAt);
  const start = timeMs(startedAt);
  const end = timeMs(endedAt);
  if (created === null) return false;
  return (start === null || created >= start - TASK_MATCH_SLOP_MS)
    && (end === null || created <= end + TASK_MATCH_SLOP_MS);
}

function cwdMatches(entry, cwd) {
  return typeof cwd !== 'string' || cwd.trim() === '' || entry?.cwd === cwd;
}

function databasePathFor(home = homedir(), supplied = null) {
  if (typeof supplied === 'string' && supplied.trim()) return resolve(supplied);
  const root = resolve(home ?? homedir());
  // A direct database path is useful for tests and for callers that already
  // resolved the OpenCode data directory.  The public contract still defaults
  // to <home>/.local/share/opencode/opencode.db.
  if (basename(root) === 'opencode.db') return root;
  if (basename(root) === 'opencode' && basename(dirname(root)) === 'share') {
    return join(root, 'opencode.db');
  }
  return join(root, '.local', 'share', 'opencode', 'opencode.db');
}

function openDatabase(file) {
  if (!existsSync(file)) return null;
  try {
    // Keep the experimental node:sqlite warning out of ordinary CLI/provider
    // startup. The module is required only when a transcript index/read is
    // actually requested.
    const { DatabaseSync } = require('node:sqlite');
    // `readOnly` is intentional: the real OpenCode database is opened in
    // place and must never be copied, migrated, or modified by accounting.
    return new DatabaseSync(file, { readOnly: true });
  } catch {
    return null;
  }
}

function firstUserParts(db, sessionId) {
  try {
    const message = db.prepare(`
      SELECT id, data
      FROM message
      WHERE session_id = ? AND json_extract(data, '$.role') = 'user'
      ORDER BY time_created, id
      LIMIT 1
    `).get(sessionId);
    if (!message?.id) return [];
    const messageData = parseJson(message.data);
    const inline = [];
    if (typeof messageData?.text === 'string' && messageData.text.trim()) inline.push(messageData.text.trim());
    if (typeof messageData?.content === 'string' && messageData.content.trim()) inline.push(messageData.content.trim());
    if (Array.isArray(messageData?.content)) {
      for (const item of messageData.content) {
        if (typeof item?.text === 'string' && item.text.trim()) inline.push(item.text.trim());
      }
    }
    const rows = db.prepare(`
      SELECT data
      FROM part
      WHERE message_id = ?
      ORDER BY time_created, id
    `).all(message.id);
    return [...inline, ...rows.map((row) => parseJson(row.data))
      .filter((part) => part?.type === 'text' && typeof part.text === 'string' && part.text.trim())
      .map((part) => part.text.trim())];
  } catch {
    return [];
  }
}

function sessionEntries(db, databasePath) {
  const rows = db.prepare(`
    SELECT id, directory, model, time_created, time_updated,
           tokens_input, tokens_output, tokens_reasoning,
           tokens_cache_read, tokens_cache_write
    FROM session
    ORDER BY time_created, id
  `).all();
  return rows.map((row) => {
    const firstAt = timeText(row.time_created);
    const lastAt = timeText(row.time_updated);
    return {
      provider: PROVIDER,
      sessionId: row.id ?? null,
      file: databasePath ?? null,
      directory: typeof row.directory === 'string' && row.directory ? row.directory : null,
      cwd: typeof row.directory === 'string' && row.directory ? row.directory : null,
      model: modelId(row.model),
      firstAt,
      lastAt,
      allFirstAt: firstAt,
      allLastAt: lastAt,
      tokens: tokensFromSession(row),
      taskText: null,
      taskTexts: [],
    };
  });
}

function buildIndexFromDatabase(db, home, databasePath) {
  if (!db) return { provider: PROVIDER, home, databasePath, entries: [] };
  try {
    return {
      provider: PROVIDER,
      home,
      databasePath,
      entries: sessionEntries(db, databasePath),
    };
  } catch {
    return { provider: PROVIDER, home, databasePath, entries: [] };
  }
}

/**
 * Build a lightweight index of OpenCode sessions.
 *
 * The index contains session directory/CWD, session time bounds, model id,
 * aggregate token counters, and the first user text used for a tie-break.
 */
export function buildTranscriptIndex({ home = homedir(), databasePath = null, dbPath = null } = {}) {
  const file = databasePathFor(home, databasePath ?? dbPath);
  const db = openDatabase(file);
  if (!db) return { provider: PROVIDER, home, databasePath: file, entries: [] };
  try {
    return buildIndexFromDatabase(db, home, file);
  } finally {
    try { db.close(); } catch { /* already closed */ }
  }
}

function taskTargets({ taskText = null, task = null, prompt = null, taskFile = null, taskPath = null } = {}) {
  const values = [];
  const add = (value) => {
    if (typeof value !== 'string' || !value.trim()) return;
    values.push(value.trim());
  };
  add(taskText);
  add(typeof task === 'string' ? task : null);
  add(prompt);
  add(taskFile);
  add(taskPath);
  return [...new Set(values)];
}

function normalizedTask(value) {
  return String(value ?? '').replace(/\\/g, '/').replace(/\s+/g, ' ').trim();
}

function taskMatches(entry, targets) {
  const available = [entry?.taskText, ...(Array.isArray(entry?.taskTexts) ? entry.taskTexts : [])]
    .filter((value) => typeof value === 'string' && value.trim())
    .map(normalizedTask);
  if (!available.length || !targets.length) return false;
  return available.some((candidate) => targets.some((target) => {
    const wanted = normalizedTask(target);
    if (!wanted || candidate === wanted) return true;
    // The normal headless OpenCode prompt is the task-file path.  Permit an
    // absolute path on either side when the path was normalized differently.
    if ((candidate.startsWith('/') || wanted.startsWith('/'))
      && (candidate.endsWith(wanted) || wanted.endsWith(candidate))) return true;
    // For an inline prompt, only use containment when both sides are
    // substantive; this avoids selecting a session on a one-word coincidence.
    return candidate.length >= 24 && wanted.length >= 24
      && (candidate.includes(wanted) || wanted.includes(candidate));
  }));
}

function selectedTaskParts(db, entries) {
  if (!db || !Array.isArray(entries)) return entries;
  return entries.map((entry) => {
    if (entry.taskTextsLoaded === true) return entry;
    const parts = firstUserParts(db, entry.sessionId);
    // The bulk repricer reuses one index across hundreds of attempts. Cache
    // both hits and misses on that private index entry so an ambiguous CWD/time
    // set never re-queries the same session's parts for every attempt.
    entry.taskText = parts[0] ?? null;
    entry.taskTexts = parts;
    entry.taskTextsLoaded = true;
    return entry;
  });
}

function rowsForSession(db, sessionId) {
  try {
    return db.prepare(`
      SELECT id, session_id, time_created, time_updated, data
      FROM message
      WHERE session_id = ?
      ORDER BY time_created, id
    `).all(sessionId);
  } catch {
    return [];
  }
}

function parseSession(db, entry, { startedAt = null, endedAt = null, confidence = 'window' } = {}) {
  const rows = rowsForSession(db, entry.sessionId);
  const requests = [];
  const requestEnds = [];
  let cwd = entry.cwd ?? entry.directory ?? null;
  let fallbackModel = entry.model ?? null;
  const allTimes = [];

  for (const row of rows) {
    const data = parseJson(row.data);
    const created = messageCreated(row, data);
    const completed = messageCompleted(row, data);
    if (created !== null) allTimes.push(created);
    if (completed !== null) allTimes.push(completed);
    if (typeof data?.path?.cwd === 'string' && data.path.cwd) cwd = data.path.cwd;
    if (data?.modelID || data?.model?.modelID) fallbackModel = data.modelID ?? data.model.modelID;
    if (data?.role !== 'assistant' || !hasTokenFields(data)) continue;
    if (!inWindow(created ?? completed, startedAt, endedAt)) continue;
    const tokens = tokensFromData(data);
    const model = modelId(data.modelID ?? data.model?.modelID ?? fallbackModel);
    requests.push({
      at: timeText(created ?? completed),
      model,
      tokens,
    });
    if (completed !== null) requestEnds.push(completed);
  }

  const tokens = {
    standardRead: knownSum(requests.map((request) => request.tokens.standardRead)),
    cacheRead: knownSum(requests.map((request) => request.tokens.cacheRead)),
    cacheWrite5m: null,
    cacheWrite1h: null,
    cacheWrite: knownSum(requests.map((request) => request.tokens.cacheWrite)),
    output: knownSum(requests.map((request) => request.tokens.output)),
    reasoning: knownSum(requests.map((request) => request.tokens.reasoning)),
    totalKnown: null,
  };
  tokens.totalKnown = knownSum([
    tokens.standardRead,
    tokens.cacheRead,
    tokens.cacheWrite,
    tokens.output,
    tokens.reasoning,
  ]);

  const requestTimes = requests.map((request) => timeMs(request.at)).filter((value) => value !== null);
  const sortedAll = allTimes.sort((a, b) => a - b);
  const firstAt = requestTimes.length ? timeText(Math.min(...requestTimes)) : null;
  const lastAt = requestEnds.length ? timeText(Math.max(...requestEnds)) : null;
  return {
    tokens,
    model: requests.at(-1)?.model ?? fallbackModel ?? null,
    sessionId: entry.sessionId ?? null,
    cwd,
    file: entry.file ?? db.filename ?? null,
    firstAt,
    lastAt,
    requests,
    confidence,
    reason: null,
    allFirstAt: sortedAll.length ? timeText(sortedAll[0]) : entry.firstAt ?? null,
    allLastAt: sortedAll.length ? timeText(sortedAll.at(-1)) : entry.lastAt ?? null,
  };
}

function normalizeIndex(index, db, home, databasePath) {
  if (index?.provider === PROVIDER && Array.isArray(index.entries)) {
    return {
      ...index,
      databasePath: index.databasePath ?? databasePath,
      entries: index.entries,
    };
  }
  return buildIndexFromDatabase(db, home, databasePath);
}

/**
 * Read usage for one OpenCode attempt from the SQLite transcript.
 *
 * Resolution is session id first, then sessions overlapping the attempt
 * window. A recorded CWD narrows that set; when a task text/path is present,
 * the unique first-user task match in a +/-2 minute creation window can select
 * an isolated workspace even when CWD is absent. Multiple matches remain
 * unknown with `confidence: "ambiguous"`.
 */
export function readTranscriptUsage({
  provider = PROVIDER,
  sessionId = null,
  cwd = null,
  startedAt = null,
  endedAt = null,
  home = homedir(),
  index = null,
  databasePath = null,
  dbPath = null,
  taskText = null,
  task = null,
  prompt = null,
  taskFile = null,
  taskPath = null,
} = {}) {
  const rawProvider = provider == null
    ? PROVIDER
    : typeof provider === 'string' ? provider : provider?.name;
  const providerName = typeof rawProvider === 'string'
    ? rawProvider.toLowerCase().split(':', 1)[0]
    : null;
  // `opencode2` is the historical pool prefix retained in old workflow
  // records; the registry normally canonicalizes it before this hook, but
  // accepting it here keeps direct provider calls safe as well.
  if (providerName !== PROVIDER && providerName !== 'opencode2') {
    return blankRecord('none', 'provider-not-opencode');
  }
  const file = databasePathFor(home, databasePath ?? dbPath ?? index?.databasePath ?? null);
  const db = openDatabase(file);
  if (!db) return blankRecord('none', 'database-unavailable');

  try {
    const effectiveIndex = normalizeIndex(index, db, home, file);
    const entries = effectiveIndex.entries ?? [];
    const wantedId = typeof sessionId === 'string' && sessionId.trim() ? sessionId.trim() : null;
    let candidates;
    if (wantedId) {
      candidates = entries.filter((entry) => entry.sessionId === wantedId);
      // A supplied index can be stale or partial; a direct id query is still
      // safe and preserves exact matching without scanning the whole store.
      if (!candidates.length) {
        const row = db.prepare(`
          SELECT id, directory, model, time_created, time_updated,
                 tokens_input, tokens_output, tokens_reasoning,
                 tokens_cache_read, tokens_cache_write
          FROM session WHERE id = ?
        `).get(wantedId);
        if (row) {
          candidates = [{
            provider: PROVIDER,
            sessionId: row.id,
            file,
            directory: row.directory ?? null,
            cwd: row.directory ?? null,
            model: modelId(row.model),
            firstAt: timeText(row.time_created),
            lastAt: timeText(row.time_updated),
            tokens: tokensFromSession(row),
          }];
        }
      }
      if (!candidates.length) return blankRecord('none', 'session-not-found');
      const parsed = parseSession(db, candidates[0], {
        startedAt,
        endedAt,
        confidence: 'exact',
      });
      return { ...parsed, sessionId: wantedId, reason: null };
    }

    const targets = taskTargets({ taskText, task, prompt, taskFile, taskPath });
    const overlapping = entries.filter((entry) => overlaps(
      entry.firstAt ?? entry.allFirstAt,
      entry.lastAt ?? entry.allLastAt,
      startedAt,
      endedAt,
    ));
    candidates = overlapping.filter((entry) => cwdMatches(entry, cwd));
    if (targets.length) {
      const taskWindow = entries.filter((entry) => createdNearWindow(entry, startedAt, endedAt));
      const matched = selectedTaskParts(db, taskWindow)
        .filter((entry) => taskMatches(entry, targets));
      if (matched.length === 1) candidates = matched;
      else if (matched.length > 1) {
        return blankRecord('ambiguous', 'ambiguous-task-match');
      }
    }
    if (candidates.length === 0) return blankRecord('none', 'session-not-found');
    if (candidates.length > 1) return blankRecord('ambiguous', 'ambiguous-session-match');

    const parsed = parseSession(db, candidates[0], {
      startedAt,
      endedAt,
      confidence: 'window',
    });
    return parsed;
  } catch {
    return blankRecord('none', 'database-read-failed');
  } finally {
    try { db.close(); } catch { /* already closed */ }
  }
}

export { blankTokens, modelId, tokensFromData };
