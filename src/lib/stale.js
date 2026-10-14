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
// Once the kernel runs the step's declared checks (E18), the worker has
// exited and each check runs under a hard timeout: the attempt then carries
// the kernel's running-checks note, the three worker signals are off, and
// quiet reads the checks' 30 s heartbeat alone.
//
// The score is the sum of the firing signals' weights; the attempt is stale at
// DEFAULT_STALE_THRESHOLDS.staleScore. Quiet alone is enough (the agent is
// doing nothing at all); any two of the others are, and so is no-file-change
// alone once it lasts twice its window (NO_FILE_CHANGE_ALONE). Nothing here stops,
// restarts or retries anything — the watcher prints one line and the caller
// decides (`bullswarm workflow step restart`).

import { existsSync, readFileSync, readdirSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { isAbsolute, join } from 'node:path';
import { artifactBesideTask } from './attempt-stream.js';
import { walkFolderFiles } from '../workflow/folder-walk.js';
import { deliverableTypeOf } from '../workflow/step-vocabulary.js';

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
// After this many windows with no file change (2 × 20 min by default) the
// no-file-change signal is enough on its own, so a writer gets its warning
// before the dispatcher's 60-minute no-progress stop (dispatch-silence.js).
export const NO_FILE_CHANGE_ALONE = 2;

// A normalized stream record opens a tool call, updates one, or closes one.
const OPEN_STATUSES = new Set(['running', 'pending', 'queued', 'in_progress', 'started']);
const CLOSE_STATUSES = new Set(['completed', 'failed', 'error', 'cancelled', 'canceled', 'succeeded', 'done']);
// The close statuses of a call that did its work: a failed, errored or
// cancelled edit changed no file.
const DONE_STATUSES = new Set(['completed', 'succeeded', 'done']);
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

// The note kind the kernel stamps on a running attempt when its first check
// starts, removed when the attempt finishes (src/workflow/v2-runtime.js).
export const EVIDENCE_RUNNING_NOTE = 'evidence-running';

// The most files one workspace reading stats: a step's own files, or the
// changed files git lists (the bound of the folder walk outside git). Past it
// the reading is not whole, and the no-progress clock gives no reading.
const MAX_READ_FILES = 5000;
const MAX_COMMAND_TIMES = 256;
const WORKSPACE_STAT_TTL_MS = 10_000;

function toMs(value) {
  const ms = typeof value === 'number' ? value : Date.parse(value ?? '');
  return Number.isFinite(ms) ? ms : null;
}

/** Whether the kernel is running the attempt's checks (its worker has exited). */
export function evidenceRunning(attempt) {
  return Array.isArray(attempt?.notes) && attempt.notes.some((entry) => entry?.kind === EVIDENCE_RUNNING_NOTE);
}

function fileChangeKind(kind) {
  return FILE_CHANGE_KINDS.has(String(kind ?? '').toLowerCase());
}

/**
 * The last file change the stream shows (epoch ms, or null): the edits that
 * finished well, and an edit still in flight at its start (its outcome is not
 * known yet). An edit that failed is neither: a worker that retries an Edit
 * whose old_string is not found changes nothing, so its clock must not move.
 */
export function lastFileChange(facts) {
  const inFlight = (facts?.open ?? []).filter((entry) => fileChangeKind(entry.kind)).map((entry) => entry.at);
  const at = Math.max(facts?.lastFileChangeAt ?? 0, ...inFlight);
  return at > 0 ? at : null;
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
    // An edit in flight may have finished in the gap: its outcome is unknown,
    // so it keeps counting.
    for (const entry of facts.open) {
      if (fileChangeKind(entry.kind)) facts.lastFileChangeAt = Math.max(facts.lastFileChangeAt ?? 0, entry.at);
    }
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

  // An edit that finished well is a file change, whatever record says so: the
  // edit's own (codex, grok), or the generic result that closes the Edit call
  // opened earlier (Claude Code), counted from the call's start. An edit that
  // failed changes nothing; one still open counts through lastFileChange().
  const confirmChange = (changedAt) => {
    facts.lastFileChangeAt = Math.max(facts.lastFileChangeAt ?? 0, changedAt);
    facts.streak = null;
  };
  if (fileChangeKind(kind) && DONE_STATUSES.has(status)) confirmChange(at);
  else if (!fileChangeKind(kind) && DONE_STATUSES.has(status) && id) {
    const opened = facts.open.find((entry) => entry.id === id);
    if (opened && fileChangeKind(opened.kind)) confirmChange(opened.at);
  }

  if (CLOSE_STATUSES.has(status)) {
    let index = -1;
    if (id) index = facts.open.findIndex((entry) => entry.id === id);
    else {
      const sameKind = facts.open.findIndex((entry) => entry.kind === lower && entry.id == null);
      index = sameKind >= 0 ? sameKind : generic ? 0 : -1;
    }
    // An edit that failed did not break the command repeat it interrupted.
    const closing = facts.open[index];
    if (closing && !DONE_STATUSES.has(status) && fileChangeKind(closing.kind) && facts.streak === null && closing.streakBefore) {
      facts.streak = closing.streakBefore;
    }
    closeOpen(facts, index);
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
  // An edit under way is progress, so it ends a command repeat; if it then
  // fails, the repeat is back (the close above).
  if (fileChangeKind(kind) && facts.streak) {
    facts.open.at(-1).streakBefore = facts.streak;
    facts.streak = null;
  }
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
      // The tail rolls: an edit it showed once is kept after it scrolls out,
      // so the last file change never moves back (the no-progress stop and
      // the stale score count from it).
      const latest = Math.max(entry.lastFileChangeAt ?? 0, entry.withTail.lastFileChangeAt ?? 0);
      if (latest > 0) entry.withTail.lastFileChangeAt = entry.lastFileChangeAt = latest;
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
  return ownedFilesReading(targetDir, ownedFiles).at;
}

// A workspace reading: {at (latest mtime, epoch ms, or null when no file was
// found), whole (false when part of the workspace could not be read: too many
// files, a folder too large to walk, or git failing)}. Only a whole reading
// can tell "no file changed" from "a change it did not look at".
function ownedFilesReading(targetDir, ownedFiles = []) {
  if (!targetDir || !Array.isArray(ownedFiles) || !ownedFiles.length) return { at: null, whole: true };
  let latest = null;
  for (const file of ownedFiles.slice(0, MAX_READ_FILES)) {
    if (typeof file !== 'string' || !file) continue;
    const stat = statOrNull(isAbsolute(file) ? file : join(targetDir, file));
    if (stat) latest = Math.max(latest ?? 0, stat.mtimeMs);
  }
  return { at: latest, whole: ownedFiles.length <= MAX_READ_FILES };
}

// Outside a git repository there is no changed-file list: the latest
// modification time of the folder's own files (the bounded walk the
// deliverable check uses, folder-walk.js); not whole when it is too large.
function folderFilesReading(targetDir) {
  const files = walkFolderFiles(targetDir);
  if (!files) return { at: null, whole: false };
  let latest = null;
  for (const file of files) {
    const stat = statOrNull(join(targetDir, file));
    if (stat) latest = Math.max(latest ?? 0, stat.mtimeMs);
  }
  return { at: latest, whole: true };
}

/**
 * The changed files of an unrestricted workspace, read as {at, whole}: the
 * latest modification time among them, or the last time HEAD moved there,
 * whichever is later. A worker that writes and commits in one shell command
 * leaves no changed file for git status to list (the deliverable check counts
 * HEAD moving as a change too, dispatch-deliverable.js). HEAD's move is read
 * from the mtime of its reflog. Every changed path is stat'ed, up to
 * MAX_READ_FILES: a shell edit (sed, a redirect) is no event in the stream, so
 * a path left unread could hide the worker's only change.
 */
function unrestrictedFilesReading(targetDir) {
  if (!targetDir) return { at: null, whole: true };
  let root;
  let gitDir;
  let output;
  try {
    const options = {
      cwd: targetDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 1500,
      maxBuffer: 2 * 1024 * 1024,
      windowsHide: true,
    };
    try {
      [root, gitDir] = execFileSync('git', ['rev-parse', '--show-toplevel', '--absolute-git-dir'], options).split(/\r?\n/);
    } catch {
      return folderFilesReading(targetDir);
    }
    output = execFileSync('git', [
      'status', '--porcelain=v1', '-z', '--untracked-files=all',
    ], options);
  } catch {
    return { at: null, whole: false };
  }

  let latest = gitDir ? statOrNull(join(gitDir, 'logs', 'HEAD'))?.mtimeMs ?? null : null;
  let checked = 0;
  for (const record of output.split('\0')) {
    if (!record) continue;
    const status = record.slice(0, 2);
    const path = record.slice(3);
    if (!path || !(status === '??' || /[AMRC]/.test(status))) continue;
    if (checked >= MAX_READ_FILES) return { at: latest, whole: false };
    checked += 1;
    const stat = statOrNull(join(root, path));
    if (stat) latest = Math.max(latest ?? 0, stat.mtimeMs);
  }
  return { at: latest, whole: true };
}

/**
 * The files a step changed in the directory it works in, read as {at,
 * whole}: its owned files when it declares some, else the git-changed files
 * there and the last time HEAD moved (a commit; outside a git repository, the
 * folder's files), plus its deliverable paths. `at` is null when none can be
 * read; `whole` is false when part of it could not be read.
 */
function stepFilesReading(targetDir, action) {
  const ownedFiles = Array.isArray(action?.ownedFiles) ? action.ownedFiles : [];
  const reading = ownedFiles.length ? ownedFilesReading(targetDir, ownedFiles) : unrestrictedFilesReading(targetDir);
  let changedAt = reading.at;
  // A git-ignored data or media path is invisible to git status. Its
  // mtime still counts as this step's file change.
  const deliverablePaths = action?.deliverable?.paths;
  if (Array.isArray(deliverablePaths) && deliverablePaths.length) {
    const deliverableAt = ownedFilesChangedAt(targetDir, deliverablePaths);
    if (deliverableAt != null) changedAt = Math.max(changedAt ?? 0, deliverableAt);
  }
  return { at: changedAt, whole: reading.whole };
}

/** The latest file change stepFilesReading found, or null; the stale score reads it. */
function stepFilesChangedAt(targetDir, action) {
  return stepFilesReading(targetDir, action).at;
}

/**
 * The dispatcher's no-progress clock for one running attempt: the same file
 * change the stale score reads (an edit in the attempt's event stream, or a
 * changed file in its workspace), never earlier than the attempt's start,
 * and never earlier than a change it read before (an edit that scrolled out
 * of the stream's rolling tail, or a changed file since committed, still
 * counts). Returns `() => epoch ms | null`; null means a file change cannot
 * be told from no file change, so nothing may be stopped on it: the attempt
 * has no event stream yet, or its workspace could not be read whole (more
 * than 5,000 changed files, a folder too large to walk, git failing), where a
 * shell edit, which the event stream does not show, could go unseen.
 */
export function createFileChangeClock({
  streamFile,
  targetDir,
  action = null,
  startedAtMs,
  readFacts = createStreamFactsReader(),
} = {}) {
  let seen = startedAtMs;
  return function changedAt() {
    let facts = null;
    try { facts = readFacts(streamFile); } catch { facts = null; }
    if (!facts) return null;
    let workspace = { at: null, whole: false };
    try { workspace = stepFilesReading(targetDir, action); } catch { workspace = { at: null, whole: false }; }
    const workspaceAt = workspace.at;
    seen = Math.max(
      seen,
      lastFileChange(facts) ?? 0,
      workspaceAt != null && workspaceAt >= startedAtMs ? workspaceAt : 0,
    );
    return workspace.whole ? seen : null;
  };
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

/**
 * Whether a step is expected to change files in its workspace: it owns some,
 * or it is a build or chore step (a step with no lane dispatches as chore)
 * whose deliverable is not outward. The one definition the watcher's score
 * and the dispatcher's no-file-change stop both read (noProgressLimitApplies
 * in src/workflow/dispatch-silence.js), so a step stopped for changing no
 * file is always watched as a writer first.
 */
export function actionWrites(action) {
  if (!action) return false;
  if (Array.isArray(action.evidenceFor) && action.evidenceFor.length) return false;
  if (deliverableTypeOf(action.deliverable) === 'outward') return false;
  return (Array.isArray(action.ownedFiles) && action.ownedFiles.length > 0) || ['build', 'chore'].includes(action.lane ?? 'chore');
}

/**
 * Score one running attempt. Every input is plain data, so the score is
 * deterministic for a given `nowMs`:
 *   attempt           the durable attempt record (startedAt, lastActivityAt,
 *                     lastEventAt, routing.forecast.expectedMinutes, and the
 *                     running-checks note in `notes`)
 *   facts             the stream facts reader's output, or null with no event stream
 *   fileChangedAt     latest mtime of the step's owned files, or, when it owns
 *                     none, of the git-changed files in its workspace; null
 *                     when that check cannot be read
 *   writes            whether the step is expected to change files
 *   expectedMinutes   overrides the attempt's recorded expectation
 * Returns {score, stale, staleSince, signals: [{id, weight, firedAt, reason}],
 * reasons: [string], progressAt, progressBy, progressWindowSec}; staleSince is
 * when the score first reached the stale threshold in the current episode
 * (epoch ms), null when not stale. progressAt is the attempt's last progress
 * (epoch ms): its last file change, or the start, for a step that writes
 * (progressBy 'file-change'), its last output for any other ('output').
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
  // The checks are running: nothing the worker did or took counts any more.
  const checking = evidenceRunning(attempt);

  // quiet: silence while no command is in flight. During the checks, a call
  // the exited worker left open is not in flight; the heartbeat is.
  const activityAt = Math.max(
    startedAt,
    facts?.lastEventAt ?? 0,
    toMs(attempt.lastActivityAt) ?? 0,
    toMs(attempt.lastEventAt) ?? 0,
  );
  const commandRunning = !checking && Boolean(facts?.open?.length);
  const quietMs = nowMs - activityAt;
  if (!commandRunning && quietMs >= limits.quietSec * 1000) {
    let reason = `no output for ${formatMinutes(quietMs)}`;
    if (checking) reason = `no check heartbeat for ${formatMinutes(quietMs)}`;
    else if (facts) reason = `quiet ${formatMinutes(quietMs)} with no command running`;
    signals.push({ id: 'quiet', firedAt: activityAt + limits.quietSec * 1000, reason });
  }

  // The writer's last file change: an edit in its stream or a changed file in
  // its workspace, never earlier than its start.
  const workspaceChangedAt = fileChangedAt != null && fileChangedAt >= startedAt ? fileChangedAt : 0;
  const changedAt = Math.max(startedAt, lastFileChange(facts) ?? 0, workspaceChangedAt);

  // no-file-change: a writer keeps running commands but changes nothing.
  // Past twice its window it is stale on its own (NO_FILE_CHANGE_ALONE): a
  // worker that keeps reading different files is never quiet and never
  // repeats, and the dispatcher stops it at its no-progress limit (60 min by
  // default), so its warning must not wait for a second signal.
  if (writes && facts && !checking) {
    const sinceChange = nowMs - changedAt;
    const after = facts.commandAts.filter((at) => at > changedAt);
    if (after.length >= limits.noFileChangeCommands && sinceChange >= limits.noFileChangeSec * 1000) {
      const firedAt = Math.max(changedAt + limits.noFileChangeSec * 1000, after[limits.noFileChangeCommands - 1]);
      const aloneAt = changedAt + NO_FILE_CHANGE_ALONE * limits.noFileChangeSec * 1000;
      signals.push({
        id: 'no-file-change',
        firedAt,
        ...(nowMs >= aloneAt ? { aloneAt: Math.max(aloneAt, firedAt) } : {}),
        reason: `no file change in ${formatMinutes(sinceChange)} while ${after.length} command${after.length === 1 ? '' : 's'} ran`,
      });
    }
  }

  // repeat: the same command several times in a row, nothing changed between.
  const streak = checking ? null : facts?.streak;
  if (streak && streak.count >= limits.repeatCount) {
    signals.push({
      id: 'repeat', firedAt: streak.nthAt ?? facts.lastCommandAt ?? nowMs,
      reason: `same command ${streak.count}× in a row: ${clip(streak.summary)}`,
    });
  }

  // wall: well past what the router expected this lane/effort to take.
  const expected = expectedMinutes !== undefined ? Number(expectedMinutes) : Number(attempt.routing?.forecast?.expectedMinutes);
  if (!checking && Number.isFinite(expected) && expected > 0) {
    const limitMs = limits.wallFactor * expected * 60_000;
    const elapsed = nowMs - startedAt;
    if (elapsed >= limitMs) {
      signals.push({
        id: 'wall', firedAt: startedAt + limitMs,
        reason: `running ${formatMinutes(elapsed)}, over ${limits.wallFactor}× the expected ${formatMinutes(expected * 60_000)}`,
      });
    }
  }

  // Progress, for the watcher's repeated warning: a file change for a step
  // that writes, any output for any other (and for the checks, their
  // heartbeat). `progressWindowSec` is how long the watcher waits without it
  // before it warns again.
  const writerProgress = writes && !checking;
  const progress = {
    progressAt: writerProgress ? changedAt : activityAt,
    progressBy: writerProgress ? 'file-change' : 'output',
    progressWindowSec: writerProgress ? limits.noFileChangeSec : limits.quietSec,
  };

  for (const signal of signals) signal.weight = STALE_SIGNAL_WEIGHTS[signal.id] ?? 1;
  // A no-file-change signal past twice its window weighs the stale score
  // alone; its weight grew at aloneAt, which staleSince reads.
  const steps = [];
  for (const signal of signals) {
    if (signal.aloneAt == null) { steps.push([signal.firedAt, signal.weight]); continue; }
    const alone = Math.max(signal.weight, limits.staleScore);
    steps.push([signal.firedAt, signal.weight], [signal.aloneAt, alone - signal.weight]);
    signal.weight = alone;
    delete signal.aloneAt;
  }
  const score = signals.reduce((sum, signal) => sum + signal.weight, 0);
  const stale = score >= limits.staleScore;
  let staleSince = null;
  if (stale) {
    let cumulative = 0;
    for (const [at, weight] of steps.sort((a, b) => a[0] - b[0])) {
      cumulative += weight;
      if (cumulative >= limits.staleScore) { staleSince = at; break; }
    }
  }
  // Strongest first, so the line leads with the reason that matters most.
  const ordered = [...signals].sort((a, b) => b.weight - a.weight || a.firedAt - b.firedAt);
  return { score, stale, staleSince, signals: ordered, reasons: ordered.map((signal) => signal.reason), ...progress };
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
    if (writes) {
      const key = attempt.id ?? `${attempt.actionId}-${attempt.ordinal}`;
      const cached = workspaceCache.get(key);
      if (cached && nowMs - cached.at < WORKSPACE_STAT_TTL_MS) fileChangedAt = cached.value;
      else {
        const isolated = current?.config?.settings?.workspaceMode === 'isolated'
          ? isolatedWorkspace(runDir, attempt.actionId)
          : null;
        const targetDir = isolated ?? current?.intent?.cwd ?? null;
        fileChangedAt = stepFilesChangedAt(targetDir, action);
        workspaceCache.set(key, { at: nowMs, value: fileChangedAt });
      }
    }
    return staleScore({ attempt, facts, fileChangedAt, writes, nowMs, thresholds });
  };
}
