// Stale score for one running attempt.
//
// The watcher's judgement that a step may be stuck, computed from evidence
// the attempt already leaves on disk: its persisted event stream (the
// normalized JSONL the dispatcher appends as the worker talks) and the
// modification times of the files it owns. Four signals, each with a reason a
// caller can read:
//
//   quiet            no output and no command running (a long `npm test` is
//                    not quiet: the time a command is in flight is excluded)
//   no-file-change   a step that writes has changed no file for a while even
//                    though it keeps running commands
//   repeat           the same command, several times in a row, with no file
//                    change in between
//   wall             wall time past a multiple of the router's expected
//                    minutes for this lane and effort
//
// The score is the sum of the firing signals' weights; the attempt is stale at
// DEFAULT_STALE_THRESHOLDS.staleScore. Quiet alone is enough (the agent is
// doing nothing at all); any two of the others are. Nothing here stops,
// restarts or retries anything — the watcher prints one line and the caller
// decides (`bullswarm workflow step restart`).

import { existsSync, readFileSync, readdirSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { artifactBesideTask } from './watch.js';

export const DEFAULT_STALE_THRESHOLDS = Object.freeze({
  quietSec: 600,
  noFileChangeSec: 1200,
  noFileChangeCommands: 5,
  repeatCount: 3,
  wallFactor: 3,
  staleScore: 2,
});

export const STALE_SIGNAL_WEIGHTS = Object.freeze({
  quiet: 2,
  'no-file-change': 1,
  repeat: 1,
  wall: 1,
});

// A normalized stream record opens a tool call, updates one, or closes one.
const OPEN_STATUSES = new Set(['running', 'pending', 'queued', 'in_progress', 'started']);
const CLOSE_STATUSES = new Set(['completed', 'failed', 'error', 'cancelled', 'canceled', 'succeeded', 'done']);
// Records that are the model talking or accounting, never a tool call.
const NON_TOOL_KINDS = new Set([
  'response', 'usage', 'result', 'reasoning', 'thinking', 'text', 'message',
  'error', 'system', 'init', 'session', 'status',
]);
// Tool-update records that name no tool of their own (a tool result, a
// progress update): they close or update the call they belong to and never
// start one.
const GENERIC_TOOL_KINDS = new Set(['tool', 'agent']);
// Tool verbs that change a file. Stream kinds are the tool names the
// normalizer recorded, lower-cased here; a todo list is not a file.
const FILE_CHANGE_KINDS = new Set([
  'file_change', 'apply_patch', 'patch', 'edit', 'multiedit', 'notebookedit',
  'write', 'edit_file', 'write_file', 'create_file', 'search_replace',
  'str_replace', 'str_replace_editor', 'str_replace_based_edit_tool',
]);

const MAX_OWNED_FILES = 200;
const MAX_COMMAND_TIMES = 256;
const WORKSPACE_STAT_TTL_MS = 10_000;

function toMs(value) {
  const ms = typeof value === 'number' ? value : Date.parse(value ?? '');
  return Number.isFinite(ms) ? ms : null;
}

function fileChangeKind(kind) {
  return FILE_CHANGE_KINDS.has(String(kind ?? '').toLowerCase());
}

function commandKey(record) {
  const summary = String(record.summary ?? '').replace(/\s+/g, ' ').trim();
  return summary ? `${String(record.kind).toLowerCase()}\u0000${summary}` : null;
}

/** A fresh reducer state for one attempt's stream. */
export function emptyStreamFacts() {
  return {
    records: 0,
    truncated: false,
    lastEventAt: null,
    open: [],
    commandCount: 0,
    lastCommandAt: null,
    // Start times of the most recent commands, oldest first, so the count and
    // the Nth time after any file change (stream- or workspace-observed) can
    // be read back without keeping the whole stream.
    commandAts: [],
    lastFileChangeAt: null,
    streak: null,
    countedIds: [],
  };
}

function cloneFacts(facts) {
  return structuredClone(facts);
}

function closeOpen(facts, index) {
  if (index >= 0) facts.open.splice(index, 1);
}

/**
 * Fold one normalized stream record into the facts. Pure apart from mutating
 * `facts`; `thresholds.repeatCount` fixes which repeat's time the repeat
 * signal fires at.
 */
export function foldStreamRecord(facts, record, thresholds = DEFAULT_STALE_THRESHOLDS) {
  if (!record || typeof record !== 'object') return facts;
  if (record.truncated === true) {
    // Events were dropped between the head and the tail: whatever was open
    // may have closed in the gap, so the in-flight set restarts empty.
    facts.truncated = true;
    facts.open = [];
    return facts;
  }
  const at = toMs(record.at);
  if (at == null) return facts;
  facts.records += 1;
  facts.lastEventAt = Math.max(facts.lastEventAt ?? 0, at);
  const kind = record.kind;
  if (typeof kind !== 'string' || !kind) return facts;
  const lower = kind.toLowerCase();
  const status = String(record.status ?? '').toLowerCase();
  const id = typeof record.toolCallId === 'string' && record.toolCallId ? record.toolCallId : null;
  const generic = GENERIC_TOOL_KINDS.has(lower);
  if (NON_TOOL_KINDS.has(lower) && !id) return facts;

  if (fileChangeKind(kind) && (OPEN_STATUSES.has(status) || CLOSE_STATUSES.has(status))) {
    facts.lastFileChangeAt = Math.max(facts.lastFileChangeAt ?? 0, at);
    facts.streak = null;
  }

  if (CLOSE_STATUSES.has(status)) {
    if (id) closeOpen(facts, facts.open.findIndex((entry) => entry.id === id));
    else {
      const sameKind = facts.open.findIndex((entry) => entry.kind === lower && entry.id == null);
      if (sameKind >= 0) closeOpen(facts, sameKind);
      else if (generic) closeOpen(facts, 0);
    }
    return facts;
  }
  if (!OPEN_STATUSES.has(status)) return facts;
  // An update of a call already in flight: same id, or the next status of an
  // id-less call of the same kind that carries no new command text.
  if (id && facts.open.some((entry) => entry.id === id)) return facts;
  if (!id && record.summary == null && facts.open.some((entry) => entry.kind === lower && entry.id == null)) return facts;
  if (generic) return facts;
  if (id && facts.countedIds.includes(id)) return facts;
  facts.open.push({ id, kind: lower, at });
  if (id) {
    facts.countedIds.push(id);
    if (facts.countedIds.length > 256) facts.countedIds.shift();
  }
  if (fileChangeKind(kind)) return facts;
  facts.commandCount += 1;
  facts.lastCommandAt = at;
  facts.commandAts.push(at);
  if (facts.commandAts.length > MAX_COMMAND_TIMES) facts.commandAts.shift();
  const key = commandKey(record);
  if (key == null) return facts;
  if (facts.streak?.key === key) {
    facts.streak.count += 1;
    if (facts.streak.count === thresholds.repeatCount) facts.streak.nthAt = at;
  } else {
    facts.streak = {
      key, kind: lower, summary: String(record.summary).replace(/\s+/g, ' ').trim(), count: 1,
      nthAt: thresholds.repeatCount <= 1 ? at : null,
    };
  }
  return facts;
}

/** Fold a block of JSONL text (whole lines only) into the facts. */
export function foldStreamText(facts, text, thresholds = DEFAULT_STALE_THRESHOLDS) {
  for (const line of String(text ?? '').split('\n')) {
    if (!line.trim()) continue;
    let record;
    try { record = JSON.parse(line); } catch { continue; }
    foldStreamRecord(facts, record, thresholds);
  }
  return facts;
}

/** Stream facts for a complete list of records (tests, one-shot readers). */
export function streamFacts(records, thresholds = DEFAULT_STALE_THRESHOLDS) {
  const facts = emptyStreamFacts();
  for (const record of records ?? []) foldStreamRecord(facts, record, thresholds);
  return facts;
}

function statOrNull(path) {
  try { return statSync(path); } catch { return null; }
}

// Bytes [offset, end) of a file. `end` is the size the caller stat'ed, so a
// worker appending in between is read on the next call, never twice.
function readRange(path, offset, end) {
  const fd = openSync(path, 'r');
  try {
    const length = Math.max(0, end - offset);
    const buffer = Buffer.alloc(length);
    let read = 0;
    while (read < length) {
      const n = readSync(fd, buffer, read, length - read, offset + read);
      if (n <= 0) break;
      read += n;
    }
    return buffer.subarray(0, read);
  } finally { closeSync(fd); }
}

/**
 * The persisted stream of a running attempt. A finished attempt names it; a
 * running one does not yet, so it is derived from the task file with the same
 * naming the dispatcher writes with.
 */
export function attemptStreamPath(attempt, runDir = null) {
  const named = attempt?.streamFile ?? null;
  const resolveIn = (path) => (path && runDir && !isAbsolute(path) ? join(runDir, path) : path);
  if (named && String(named).endsWith('.jsonl')) return resolveIn(named);
  const taskFile = resolveIn(attempt?.taskFile ?? null);
  return taskFile ? artifactBesideTask(taskFile, 'stream', '.jsonl') : null;
}

/**
 * Incremental stream reader. The head file is append-only while the worker
 * runs, so only new whole lines are parsed on each call; the `.tail` segment
 * the sink rewrites once the head is full is re-folded on top of the cached
 * head facts whenever it changes. Returns null when there is no stream.
 */
export function createStreamFactsReader({ thresholds = DEFAULT_STALE_THRESHOLDS } = {}) {
  const cache = new Map();
  return function read(streamFile) {
    if (!streamFile) return null;
    const head = statOrNull(streamFile);
    if (!head) return null;
    let entry = cache.get(streamFile);
    if (!entry || head.size < entry.offset || head.ino !== entry.ino) {
      entry = { ino: head.ino, offset: 0, carry: Buffer.alloc(0), facts: emptyStreamFacts(), tailKey: null, withTail: null };
      cache.set(streamFile, entry);
    }
    if (head.size > entry.offset) {
      // Bytes, not text, until a newline: a read may end inside a character.
      const bytes = Buffer.concat([entry.carry, readRange(streamFile, entry.offset, head.size)]);
      entry.offset = head.size;
      const cut = bytes.lastIndexOf(0x0a);
      entry.carry = cut < 0 ? bytes : bytes.subarray(cut + 1);
      if (cut >= 0) foldStreamText(entry.facts, bytes.subarray(0, cut + 1).toString('utf8'), thresholds);
      entry.tailKey = null;
    }
    const tailPath = `${streamFile}.tail`;
    const tail = existsSync(tailPath) ? statOrNull(tailPath) : null;
    if (!tail) return entry.facts;
    const tailKey = `${tail.size}:${tail.mtimeMs}`;
    if (entry.tailKey !== tailKey) {
      let text = '';
      try { text = readFileSync(tailPath, 'utf8'); } catch { text = ''; }
      entry.withTail = foldStreamText(cloneFacts(entry.facts), text, thresholds);
      entry.tailKey = tailKey;
    }
    return entry.withTail ?? entry.facts;
  };
}

/**
 * Latest modification time (epoch ms) among the files an action owns, in the
 * directory it works in, or null when none exists. Only declared files are
 * stat'ed — a sibling editing its own files in a shared workspace is not this
 * step's progress.
 */
export function ownedFilesChangedAt(targetDir, ownedFiles = []) {
  if (!targetDir || !Array.isArray(ownedFiles) || !ownedFiles.length) return null;
  let latest = null;
  for (const file of ownedFiles.slice(0, MAX_OWNED_FILES)) {
    if (typeof file !== 'string' || !file) continue;
    const stat = statOrNull(isAbsolute(file) ? file : join(targetDir, file));
    if (stat) latest = Math.max(latest ?? 0, stat.mtimeMs);
  }
  return latest;
}

function formatMinutes(ms) {
  const totalSec = Math.max(0, Math.round(ms / 1000));
  if (totalSec < 60) return `${totalSec}s`;
  const minutes = Math.round(totalSec / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h${String(minutes % 60).padStart(2, '0')}m`;
}

function clip(text, max = 60) {
  const value = String(text ?? '');
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

/** Whether a step is expected to change files: it owns some, or builds. */
export function actionWrites(action) {
  if (!action) return false;
  if (Array.isArray(action.evidenceFor) && action.evidenceFor.length) return false;
  return (Array.isArray(action.ownedFiles) && action.ownedFiles.length > 0) || action.lane === 'build';
}

/**
 * Score one running attempt. Every input is plain data, so the score is
 * deterministic for a given `nowMs`:
 *   attempt           the durable attempt record (startedAt, lastActivityAt,
 *                     lastEventAt, routing.forecast.expectedMinutes)
 *   facts             streamFacts()/reader output, or null with no event stream
 *   fileChangedAt     ownedFilesChangedAt() for the step's workspace, or null
 *   writes            whether the step is expected to change files
 *   expectedMinutes   overrides the attempt's recorded expectation
 * Returns {score, stale, staleSince, signals: [{id, weight, firedAt, reason}],
 * reasons: [string]}; staleSince is when the score first reached the stale
 * threshold in the current episode (epoch ms), null when not stale.
 */
export function staleScore({
  attempt,
  facts = null,
  fileChangedAt = null,
  writes = false,
  expectedMinutes = undefined,
  nowMs = Date.now(),
  thresholds = DEFAULT_STALE_THRESHOLDS,
} = {}) {
  const limits = { ...DEFAULT_STALE_THRESHOLDS, ...(thresholds ?? {}) };
  const startedAt = toMs(attempt?.startedAt);
  const empty = { score: 0, stale: false, staleSince: null, signals: [], reasons: [] };
  if (attempt?.status !== 'running' || startedAt == null) return empty;
  const signals = [];

  // quiet: silence while no command is in flight.
  const activityAt = Math.max(
    startedAt,
    facts?.lastEventAt ?? 0,
    toMs(attempt.lastActivityAt) ?? 0,
    toMs(attempt.lastEventAt) ?? 0,
  );
  const commandRunning = Boolean(facts?.open?.length);
  const quietMs = nowMs - activityAt;
  if (!commandRunning && quietMs >= limits.quietSec * 1000) {
    signals.push({
      id: 'quiet', firedAt: activityAt + limits.quietSec * 1000,
      reason: facts
        ? `quiet ${formatMinutes(quietMs)} with no command running`
        : `no output for ${formatMinutes(quietMs)}`,
    });
  }

  // no-file-change: a writer keeps running commands but changes nothing.
  if (writes && facts) {
    const workspaceChangedAt = fileChangedAt != null && fileChangedAt >= startedAt ? fileChangedAt : 0;
    const changedAt = Math.max(startedAt, facts.lastFileChangeAt ?? 0, workspaceChangedAt);
    const sinceChange = nowMs - changedAt;
    const after = facts.commandAts.filter((at) => at > changedAt);
    if (after.length >= limits.noFileChangeCommands && sinceChange >= limits.noFileChangeSec * 1000) {
      signals.push({
        id: 'no-file-change',
        firedAt: Math.max(changedAt + limits.noFileChangeSec * 1000, after[limits.noFileChangeCommands - 1]),
        reason: `no file change in ${formatMinutes(sinceChange)} while ${after.length} command${after.length === 1 ? '' : 's'} ran`,
      });
    }
  }

  // repeat: the same command several times in a row, nothing changed between.
  const streak = facts?.streak;
  if (streak && streak.count >= limits.repeatCount) {
    signals.push({
      id: 'repeat', firedAt: streak.nthAt ?? facts.lastCommandAt ?? nowMs,
      reason: `same command ${streak.count}× in a row: ${clip(streak.summary)}`,
    });
  }

  // wall: well past what the router expected this lane/effort to take.
  const expected = expectedMinutes !== undefined ? Number(expectedMinutes) : Number(attempt.routing?.forecast?.expectedMinutes);
  if (Number.isFinite(expected) && expected > 0) {
    const limitMs = limits.wallFactor * expected * 60_000;
    const elapsed = nowMs - startedAt;
    if (elapsed >= limitMs) {
      signals.push({
        id: 'wall', firedAt: startedAt + limitMs,
        reason: `running ${formatMinutes(elapsed)}, over ${limits.wallFactor}× the expected ${formatMinutes(expected * 60_000)}`,
      });
    }
  }

  for (const signal of signals) signal.weight = STALE_SIGNAL_WEIGHTS[signal.id] ?? 1;
  const score = signals.reduce((sum, signal) => sum + signal.weight, 0);
  const stale = score >= limits.staleScore;
  let staleSince = null;
  if (stale) {
    let cumulative = 0;
    for (const signal of [...signals].sort((a, b) => a.firedAt - b.firedAt)) {
      cumulative += signal.weight;
      if (cumulative >= limits.staleScore) { staleSince = signal.firedAt; break; }
    }
  }
  // Strongest first, so the line leads with the reason that matters most.
  const ordered = [...signals].sort((a, b) => b.weight - a.weight || a.firedAt - b.firedAt);
  return { score, stale, staleSince, signals: ordered, reasons: ordered.map((signal) => signal.reason) };
}

// The kernel names an isolated workspace `<step>-attempt-<n>-<time>` under the
// run's workspaces/ directory; the newest one belongs to the running attempt.
function isolatedWorkspace(runDir, actionId) {
  if (!runDir || !actionId) return null;
  try {
    const prefix = `${actionId}-attempt-`;
    const root = join(runDir, 'workspaces');
    const newest = readdirSync(root)
      .filter((name) => name.startsWith(prefix))
      .map((name) => ({ name, at: statOrNull(join(root, name))?.mtimeMs ?? 0 }))
      .sort((a, b) => b.at - a.at)[0];
    return newest ? join(root, newest.name) : null;
  } catch { return null; }
}

/**
 * A stale probe the watcher calls once per poll for each running attempt.
 * Caches stream folds per file and workspace stats per attempt, so a poll
 * with nothing new reads only file metadata.
 */
export function createStaleProbe({
  runDir,
  state = null,
  thresholds = DEFAULT_STALE_THRESHOLDS,
  readFacts = createStreamFactsReader({ thresholds }),
} = {}) {
  const workspaceCache = new Map();
  return function probe({ attempt, action = null, state: current = state, nowMs = Date.now() }) {
    const streamFile = attemptStreamPath(attempt, runDir);
    let facts = null;
    try { facts = readFacts(streamFile); } catch { facts = null; }
    const writes = actionWrites(action);
    let fileChangedAt = null;
    if (writes && Array.isArray(action?.ownedFiles) && action.ownedFiles.length) {
      const key = attempt.id ?? `${attempt.actionId}-${attempt.ordinal}`;
      const cached = workspaceCache.get(key);
      if (cached && nowMs - cached.at < WORKSPACE_STAT_TTL_MS) fileChangedAt = cached.value;
      else {
        const isolated = current?.config?.settings?.workspaceMode === 'isolated'
          ? isolatedWorkspace(runDir, attempt.actionId)
          : null;
        const targetDir = isolated ?? current?.intent?.cwd ?? null;
        fileChangedAt = ownedFilesChangedAt(targetDir, action.ownedFiles);
        workspaceCache.set(key, { at: nowMs, value: fileChangedAt });
      }
    }
    return staleScore({ attempt, facts, fileChangedAt, writes, nowMs, thresholds });
  };
}
