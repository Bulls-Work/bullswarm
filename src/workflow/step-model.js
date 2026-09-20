// Width-independent data for the Step page.
//
// A Step combines durable state, one attempt's artifacts, an optional result
// envelope, and an optional per-attempt JSONL stream. Keep those sources
// separate here so the view cannot accidentally manufacture turns, tools,
// duration, usage, cost, or verification from prose.

import { existsSync, readFileSync } from 'node:fs';
import { basename, isAbsolute, join, relative } from 'node:path';

// These imports are the extraction seam used by dashboard.js. They are used
// only for compatibility fields; the rich model below does its own shaping.
import {
  workflowPanelModel,
  reasoningText,
  durationText,
  outputSparkline,
  taskPreview,
  outcomePreview,
  runEconomics,
} from './dashboard.js';
import { formatMoneyPair } from '../lib/usage-basis.js';
import { finiteOrNull } from '../lib/num.js';
import { isFreeModel } from '../lib/usage.js';

const START_STATUSES = new Set([
  'started', 'start', 'running', 'pending', 'in_progress', 'in-progress', 'queued',
]);
const COMPLETE_STATUSES = new Set([
  'completed', 'complete', 'succeeded', 'success', 'failed', 'error', 'cancelled',
  'canceled', 'interrupted', 'done',
]);
const SUCCESS_STATUSES = new Set(['succeeded', 'success', 'completed', 'complete', 'done']);
const FILTERS = new Set(['all', 'turns', 'tools', 'errors']);
const VIEWS = new Set(['overview', 'detail']);
const TOKEN_FIELDS = [
  'standardRead', 'cacheRead', 'cacheWrite5m', 'cacheWrite1h', 'cacheWrite',
  'output', 'reasoning',
];

function hasOwn(value, key) {
  return Boolean(value && typeof value === 'object' && Object.hasOwn(value, key));
}

function textOrNull(value) {
  if (value == null) return null;
  const text = String(value).trim();
  return text || null;
}

function clone(value) {
  if (value == null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((entry) => clone(entry));
  const output = {};
  for (const [key, entry] of Object.entries(value)) output[key] = clone(entry);
  return output;
}

function safeReadJson(path) {
  if (!path || !existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function safeReadText(path) {
  if (!path || !existsSync(path)) return null;
  try { return readFileSync(path, 'utf8'); } catch { return null; }
}

function resolveExistingPath(candidate, runDir) {
  if (typeof candidate !== 'string' || !candidate.trim()) return null;
  const value = candidate.trim();
  if (runDir) {
    const relativeCandidate = isAbsolute(value) ? null : relative(runDir, join(runDir, value));
    const local = relativeCandidate && !relativeCandidate.startsWith('..') && !isAbsolute(relativeCandidate)
      ? join(runDir, relativeCandidate)
      : null;
    if (local && existsSync(local)) return local;
    // Copied-home state often retains an absolute path from the source home;
    // the same basename is the safe local artifact when it was copied beside
    // state.json.
    const basenameLocal = join(runDir, basename(value));
    if (existsSync(basenameLocal)) return basenameLocal;
    // A copied-home inspection must not follow the absolute path retained in
    // state.json back into the live home. Only accept an absolute candidate
    // after proving it is inside this run directory.
    if ((value === runDir || value.startsWith(`${runDir}/`)) && existsSync(value)) return value;
    return null;
  }
  if (existsSync(value)) return value;
  return null;
}

function retainedPath(candidate, runDir) {
  const resolved = resolveExistingPath(candidate, runDir);
  if (resolved) return resolved;
  if (runDir && typeof candidate === 'string' && candidate.trim()) {
    const value = candidate.trim();
    const relativeCandidate = isAbsolute(value) ? null : relative(runDir, join(runDir, value));
    if (relativeCandidate && !relativeCandidate.startsWith('..') && !isAbsolute(relativeCandidate)) {
      return join(runDir, relativeCandidate);
    }
    return join(runDir, basename(value));
  }
  return textOrNull(candidate);
}

function finiteMs(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function dateMs(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    // Provider timestamps are normally epoch milliseconds; tolerate epoch
    // seconds as well without turning a structured timestamp into prose.
    return value < 100_000_000_000 ? value * 1000 : value;
  }
  if (typeof value !== 'string' && !(value instanceof Date)) return null;
  const number = Date.parse(value);
  return Number.isFinite(number) ? number : null;
}

function durationMs(startedAt, finishedAt, nowMs = Date.now()) {
  const started = dateMs(startedAt);
  if (started == null) return null;
  const ended = dateMs(finishedAt) ?? (Number.isFinite(nowMs) ? nowMs : null);
  if (ended == null) return null;
  return Math.max(0, ended - started);
}

function durationFromAttempt(attempt, nowMs) {
  const explicit = finiteMs(attempt?.durationMs);
  if (explicit != null) return explicit;
  const wall = finiteOrNull(attempt?.wallSec);
  if (wall != null && wall >= 0) return wall * 1000;
  const status = String(attempt?.status ?? '').toLowerCase();
  const open = ['started', 'start', 'running', 'in_progress', 'in-progress'].includes(status);
  const finishedAt = textOrNull(attempt?.finishedAt) ?? textOrNull(attempt?.endedAt);
  if (finishedAt == null && !open) return null;
  return durationMs(attempt?.startedAt, finishedAt, nowMs);
}

function attemptInterval(attempt, nowMs) {
  const start = dateMs(attempt?.startedAt);
  if (start == null) return { unknown: true };
  const recordedEnd = dateMs(attempt?.finishedAt) ?? dateMs(attempt?.endedAt);
  let end = recordedEnd;
  const open = end == null
    && ['started', 'start', 'running', 'in_progress', 'in-progress'].includes(String(attempt?.status ?? '').toLowerCase());
  if (open) {
    end = Number.isFinite(nowMs) ? nowMs : Date.now();
  }
  if (end == null) {
    const wall = finiteOrNull(attempt?.wallSec);
    if (wall != null && wall >= 0) end = start + wall * 1000;
  }
  if (end == null || end < start) return { unknown: true };
  return { start, end, open, spanKnown: recordedEnd != null };
}

/** Return the active union and wall span for one action's attempts. */
export function actionDurationFacts(attempts = [], nowMs = Date.now()) {
  const records = attempts.map((attempt) => attemptInterval(attempt, nowMs));
  const unknown = records.some((record) => record?.unknown === true);
  const intervals = records.filter((record) => Number.isFinite(record?.start) && Number.isFinite(record?.end))
    .sort((a, b) => a.start - b.start || a.end - b.end);
  if (unknown) {
    const measured = intervals.length === 0
      ? attempts.map((attempt) => durationFromAttempt(attempt, nowMs)).filter((value) => value != null)
      : [];
    return {
      activeMs: measured.length ? measured.reduce((total, value) => total + value, 0) : null,
      spanMs: null,
      startMs: intervals[0]?.start ?? null,
      endMs: intervals.at(-1)?.end ?? null,
      open: intervals.some((interval) => interval.open),
      spanKnown: false,
      unknown: true,
      intervals,
    };
  }
  if (!intervals.length) {
    const measured = attempts.map((attempt) => durationFromAttempt(attempt, nowMs)).filter((value) => value != null);
    return {
      activeMs: measured.length ? measured.reduce((total, value) => total + value, 0) : null,
      spanMs: null,
      startMs: null,
      endMs: null,
      open: false,
      spanKnown: false,
      unknown: false,
      intervals: [],
    };
  }
  const merged = [];
  for (const interval of intervals) {
    const previous = merged.at(-1);
    if (previous && interval.start <= previous.end) previous.end = Math.max(previous.end, interval.end);
    else merged.push({ ...interval });
  }
  return {
    activeMs: merged.reduce((total, interval) => total + interval.end - interval.start, 0),
    // A live attempt has an active clock but no proved terminal wall span.
    spanMs: intervals.some((interval) => interval.open) || intervals.some((interval) => !interval.spanKnown)
      ? null
      : intervals.at(-1).end - intervals[0].start,
    startMs: intervals[0].start,
    endMs: intervals.at(-1).end,
    open: intervals.some((interval) => interval.open),
    spanKnown: intervals.every((interval) => interval.spanKnown),
    unknown: false,
    intervals,
  };
}

function pathCandidates(attempt, runDir, actionId, ordinal) {
  const candidates = [
    attempt?.streamFile,
    attempt?.eventStream,
    attempt?.streamPath,
    attempt?.stream,
  ].filter((value) => typeof value === 'string' && value.trim());
  if (runDir && actionId && ordinal != null) {
    candidates.push(join(runDir, `stream-${actionId}-attempt-${ordinal}.jsonl`));
    candidates.push(join(runDir, `stdout-${actionId}-attempt-${ordinal}.log`));
  }
  return [...new Set(candidates)];
}

/** Resolve the persisted stream using the explicit path or the kernel name. */
export function resolveAttemptStreamPath(attempt, {
  runDir = null,
  actionId = attempt?.actionId ?? null,
  ordinal = attempt?.ordinal ?? attempt?.attemptNumber ?? null,
} = {}) {
  const candidates = pathCandidates(attempt, runDir, actionId, ordinal);
  for (const candidate of candidates) {
    const resolved = resolveExistingPath(candidate, runDir);
    if (resolved) return resolved;
  }
  const explicit = [attempt?.streamFile, attempt?.eventStream, attempt?.streamPath, attempt?.stream]
    .find((value) => typeof value === 'string' && value.trim());
  if (explicit) return runDir ? join(runDir, basename(explicit.trim())) : explicit.trim();
  // Return the conventional path even while the file has not appeared. The
  // caller can show it as unavailable without claiming it was captured.
  return runDir && actionId && ordinal != null
    ? join(runDir, `stream-${actionId}-attempt-${ordinal}.jsonl`)
    : null;
}

function normalizeEvent(raw, index) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (raw.truncated === true) return { marker: true, dropped: finiteOrNull(raw.dropped) };
  const event = { ...raw };
  event.index = index;
  event.seq = finiteOrNull(raw.seq) ?? index + 1;
  event.at = textOrNull(raw.at);
  event.source = textOrNull(raw.source);
  event.providerType = textOrNull(raw.providerType);
  event.kind = textOrNull(raw.kind);
  event.status = textOrNull(raw.status);
  event.summary = raw.summary == null ? null : String(raw.summary);
  // Optional provider-neutral fields are copied only when the source record
  // actually carries them. Aliases keep additive stream-contract revisions
  // readable without guessing from summaries.
  const optional = (name, ...aliases) => {
    const source = [name, ...aliases].find((key) => hasOwn(raw, key));
    if (source != null) event[name] = raw[source];
  };
  optional('eventId', 'eventID', 'id');
  optional('turnId', 'turnID');
  optional('toolCallId', 'tool_call_id');
  optional('toolName', 'tool');
  optional('arguments', 'args');
  optional('result');
  optional('providerAt', 'providerTimestamp', 'provider_at');
  if (hasOwn(raw, 'durationMs') || hasOwn(raw, 'duration')) event.durationMs = finiteMs(raw.durationMs ?? raw.duration);
  optional('usage');
  optional('parentId', 'parentID');
  optional('subagentId', 'subagentID');
  return event;
}

/**
 * Parse a canonical per-attempt JSONL stream. Bad lines are skipped and
 * counted; no field is reconstructed from a neighbouring summary.
 */
export function parseAttemptStream(streamFile) {
  const empty = {
    path: streamFile ?? null,
    available: false,
    readable: false,
    events: [],
    parseErrors: 0,
    truncated: false,
    dropped: null,
    plainText: false,
    reason: streamFile ? 'event stream unavailable' : 'no event stream path recorded',
  };
  if (!streamFile || !existsSync(streamFile)) return empty;
  const text = safeReadText(streamFile);
  if (text == null) return { ...empty, reason: 'event stream could not be read' };
  if (streamFile.endsWith('.log')) {
    return {
      ...empty,
      available: false,
      readable: true,
      plainText: true,
      reason: 'plain stdout capture has no structured events',
    };
  }
  const events = [];
  let parseErrors = 0;
  let truncated = false;
  let dropped = null;
  const lines = text.split(/\r?\n/);
  for (const lineValue of lines) {
    const line = lineValue.trim();
    if (!line) continue;
    let value;
    try { value = JSON.parse(line); } catch { parseErrors += 1; continue; }
    const normalized = normalizeEvent(value, events.length);
    if (!normalized) { parseErrors += 1; continue; }
    if (normalized.marker) {
      truncated = true;
      dropped = normalized.dropped;
      continue;
    }
    events.push(normalized);
  }
  return {
    path: streamFile,
    available: true,
    readable: true,
    events,
    parseErrors,
    truncated,
    dropped,
    plainText: false,
    reason: parseErrors ? `${parseErrors} malformed stream line${parseErrors === 1 ? '' : 's'} ignored` : null,
  };
}

function validId(value) {
  const result = textOrNull(value);
  return result && result.length <= 240 ? result : null;
}

function isStart(event) {
  const status = String(event?.status ?? '').toLowerCase();
  return START_STATUSES.has(status) || /\.started$|_started$|^start/.test(String(event?.providerType ?? '').toLowerCase());
}

function isComplete(event) {
  const status = String(event?.status ?? '').toLowerCase();
  return COMPLETE_STATUSES.has(status) || /\.completed$|_completed$|^complete|^result$/.test(String(event?.providerType ?? '').toLowerCase());
}

// Connectors capture the same operation under their own kind strings: codex
// emits item kinds (`command_execution`, `file_change`, `web_search`),
// claude-code emits the raw tool name (`Bash`, `Read`, `Write`, `Edit`,
// `Glob`, `Grep`, `ToolSearch`, ...) and `tool` for every tool_result, and
// grok emits its own tool names (`read_file`, `run_terminal_command`, `grep`,
// `list_dir`, ...). Normalising the real kinds into the three operation
// categories the page shows keeps the summary honest for every provider, and
// it is matched case-insensitively because a kind is raw capture text.
const TOOL_KIND_CATEGORIES = new Map(Object.entries({
  command: ['bash', 'run_terminal_command', 'command_execution', 'shell', 'exec'],
  read: ['read', 'read_file', 'glob', 'grep', 'search', 'file_read', 'list_dir'],
  edit: ['write', 'edit', 'multiedit', 'notebookedit', 'file_change', 'apply_patch', 'write_file', 'edit_file'],
}).flatMap(([category, kinds]) => kinds.map((kind) => [kind, category])));

// A provider that reports a tool result as its own event names it `tool`
// (claude-code's tool_result). A result answers a call, so it is never an
// operation of its own.
const TOOL_RESULT_KINDS = new Set(['tool']);

function toolKindCategory(event) {
  const kind = String(event?.kind ?? '').trim().toLowerCase();
  return TOOL_KIND_CATEGORIES.get(kind) ?? null;
}

/**
 * Pair each started event with its completion: a stable tool-call identifier
 * is the strongest key, a provider that records none (Codex streams each
 * command as `item.started` / `item.completed` with no id) is paired
 * positionally within the same kind, in capture order, and a result captured
 * under its own kind (`tool`) is paired with the call it answers, whatever
 * that call's kind is. One real operation is one pair, so a summary that
 * counts pairs never counts a command twice.
 */
export function pairActivityEvents(events = []) {
  const indexedEvents = events.map((event, index) => (
    event && event.index != null ? event : { ...event, index }
  ));
  const starts = new Map();
  const used = new Set();
  const pairs = [];
  const pairOf = (start, complete, id) => {
    const providerDuration = finiteMs(complete?.durationMs) ?? finiteMs(start?.durationMs);
    const capturedDuration = providerDuration == null
      ? (() => {
        const a = dateMs(start?.providerAt ?? start?.at);
        const b = dateMs(complete?.providerAt ?? complete?.at);
        return a != null && b != null && b >= a ? b - a : null;
      })()
      : null;
    return {
      id,
      toolCallId: validId(start?.toolCallId) ?? validId(complete?.toolCallId),
      startIndex: start.index,
      completeIndex: complete.index,
      durationMs: providerDuration ?? capturedDuration,
      durationSource: providerDuration != null
        ? 'provider'
        : capturedDuration != null && (start?.providerAt != null || complete?.providerAt != null)
          ? 'provider-time'
          : capturedDuration != null ? 'capture-order' : null,
    };
  };
  for (const event of indexedEvents) {
    const id = validId(event?.toolCallId);
    if (!id) continue;
    if (isStart(event) && !isComplete(event)) {
      const queue = starts.get(id) ?? [];
      queue.push(event.index);
      starts.set(id, queue);
      continue;
    }
    if (!isComplete(event)) continue;
    const queue = starts.get(id) ?? [];
    const startIndex = queue.find((candidate) => !used.has(candidate));
    if (startIndex == null) continue;
    used.add(startIndex);
    used.add(event.index);
    const start = indexedEvents.find((candidate) => candidate.index === startIndex);
    pairs.push(pairOf(start, event, `tool:${id}:${startIndex}`));
  }
  // A complete event only pairs with an unnamed start of its own kind; an
  // event that carried an id keeps whatever the id path decided for it.
  const openByKind = new Map();
  for (const event of indexedEvents) {
    if (used.has(event.index) || validId(event?.toolCallId)) continue;
    const kind = String(event?.kind ?? '').toLowerCase();
    if (!kind) continue;
    const queue = openByKind.get(kind) ?? [];
    if (isStart(event) && !isComplete(event)) {
      queue.push(event);
      openByKind.set(kind, queue);
      continue;
    }
    if (!isComplete(event)) continue;
    const start = queue.find((candidate) => !used.has(candidate.index));
    if (start == null) continue;
    used.add(start.index);
    used.add(event.index);
    pairs.push(pairOf(start, event, `position:${kind}:${start.index}`));
  }
  // A result captured under its own kind (claude-code records every tool_result
  // as `tool` while the call carries the tool's name) pairs with the earliest
  // open call, so the call keeps its place and the result is never counted as
  // an operation. A result whose call was never captured still counts once, on
  // its own, rather than disappearing.
  const openCalls = indexedEvents.filter((event) => (
    !used.has(event.index) && isStart(event) && !isComplete(event)
  ));
  for (const event of indexedEvents) {
    if (used.has(event.index) || validId(event?.toolCallId)) continue;
    const kind = String(event?.kind ?? '').toLowerCase();
    if (!TOOL_RESULT_KINDS.has(kind) || !isComplete(event)) continue;
    const start = openCalls.find((candidate) => !used.has(candidate.index));
    if (!start) continue;
    used.add(start.index);
    used.add(event.index);
    pairs.push(pairOf(start, event, `result:${start.index}`));
  }
  return pairs.sort((a, b) => a.startIndex - b.startIndex);
}

function eventHasToolDetails(event) {
  return Boolean(
    validId(event?.toolCallId)
    || validId(event?.toolName)
    || hasOwn(event, 'arguments')
    || hasOwn(event, 'result'),
  );
}

function eventIsTool(event) {
  const kind = String(event?.kind ?? '').toLowerCase();
  const providerType = String(event?.providerType ?? '').toLowerCase();
  return kind === 'tool'
    || kind === 'command_execution'
    || kind === 'command'
    || kind === 'tool_call'
    || providerType.includes('tool')
    || providerType.includes('command_execution')
    || eventHasToolDetails(event);
}

function eventIsError(event) {
  const status = String(event?.status ?? '').toLowerCase();
  const kind = String(event?.kind ?? '').toLowerCase();
  const providerType = String(event?.providerType ?? '').toLowerCase();
  return ['error', 'failed', 'failure'].includes(status)
    || ['error', 'failure'].includes(kind)
    || providerType.includes('error');
}

/** A response is the only durable boundary we use for a human turn. */
function eventIsResponse(event) {
  const kind = String(event?.kind ?? '').toLowerCase();
  const providerType = String(event?.providerType ?? '').toLowerCase();
  return kind === 'response'
    || kind === 'assistant_response'
    || providerType === 'response'
    || providerType.endsWith('.response')
    || providerType.endsWith('.response.completed')
    || providerType === 'turn.completed';
}

// A provider's own end-of-run records: the final result envelope and a usage
// report. They are stream metadata, never a tool call, so they are the only
// captured events a summary counts as nothing.
const ENVELOPE_KINDS = new Set(['result', 'usage']);

/**
 * The summary line counts real operations, not raw captures: the started and
 * completed events of one command are one command. `pairActivityEvents`
 * supplies the pairs, and an event whose partner was never captured still
 * counts once on its own. A pair counts in the window that holds its start,
 * so a command whose completion lands after the next response is still one
 * command and no two turns count it twice. Each unit is classed by the real
 * kind the connector captured, normalised across providers; a tool call the
 * table does not know is counted under `other tools` rather than dropped, so a
 * turn can never report nothing while its stream holds tool events. Errors stay
 * event-based: an event with an error status is an error, whatever it paired
 * with.
 */
function eventKindSummary(events = [], pairs = null) {
  const summary = {
    commands: 0,
    filesRead: 0,
    edits: 0,
    otherTools: 0,
    errors: 0,
    total: 0,
  };
  const relevant = pairs ?? pairActivityEvents(events);
  const paired = new Set();
  const units = [];
  for (const pair of relevant) {
    paired.add(pair.startIndex);
    paired.add(pair.completeIndex);
    const start = events.find((event) => event?.index === pair.startIndex);
    if (start) units.push(start);
  }
  for (const event of events) {
    if (event && typeof event === 'object' && !paired.has(event.index)
      && !eventIsResponse(event) && !ENVELOPE_KINDS.has(String(event.kind ?? '').trim().toLowerCase())) {
      units.push(event);
    }
  }
  for (const event of units) {
    summary.total += 1;
    const category = toolKindCategory(event);
    if (category === 'command') summary.commands += 1;
    else if (category === 'read') summary.filesRead += 1;
    else if (category === 'edit') summary.edits += 1;
    else summary.otherTools += 1;
  }
  for (const event of events) {
    if (eventIsError(event)) summary.errors += 1;
  }
  summary.text = `${summary.commands} commands · ${summary.filesRead} files read · ${summary.edits} edits · ${summary.errors} errors`;
  if (summary.otherTools > 0) summary.text += ` · ${summary.otherTools} other tools`;
  return summary;
}

/**
 * Group a capture-order stream into the product's human turn projection.
 * Every response gets a row. Events after that response, up to the next
 * response, remain atomic and are counted only by their normalized kind.
 * `pairs` is the stream-wide pairing when the caller already computed one,
 * so a summary counts a command whose completion crossed a response once.
 */
export function groupActivityTurns(events = [], { pairs = null } = {}) {
  const turns = [];
  const prelude = [];
  let current = null;
  for (const event of events) {
    if (eventIsResponse(event)) {
      current = {
        index: turns.length,
        id: validId(event.turnId) ?? `turn-${turns.length + 1}`,
        response: event,
        eventIndices: [event.index],
        atomicEvents: [],
      };
      turns.push(current);
      continue;
    }
    if (!current) {
      prelude.push(event);
      continue;
    }
    current.atomicEvents.push(event);
    current.eventIndices.push(event.index);
  }
  const pairedEvents = pairs ?? pairActivityEvents(events);
  for (const turn of turns) {
    turn.summary = eventKindSummary(turn.atomicEvents, pairedEvents);
    turn.summaryText = turn.summary.text;
    turn.responseIndex = turn.response?.index ?? null;
    turn.expanded = false;
  }
  return { turns, prelude, responseCount: turns.length };
}

function sameLocalDay(value, nowMs) {
  const at = dateMs(value);
  if (at == null) return false;
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  const left = new Date(at);
  const right = new Date(now);
  return left.getFullYear() === right.getFullYear()
    && left.getMonth() === right.getMonth()
    && left.getDate() === right.getDate();
}

function localDateKey(value) {
  const date = new Date(Number.isFinite(value) ? value : Date.now());
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function normalizeFilter(value) {
  const filter = String(value ?? 'all').toLowerCase();
  return FILTERS.has(filter) ? filter : 'all';
}

function visibleEventIndices(events, filter) {
  return events
    .filter((event) => {
      if (filter === 'errors') return eventIsError(event);
      if (filter === 'tools') return eventIsTool(event);
      if (filter === 'turns') return eventIsResponse(event) || validId(event?.turnId) != null;
      return true;
    })
    .map((event) => event.index);
}

function minimapFor(events, selectedIndex = null, visible = null, bucketLimit = 32) {
  if (!events.length) return { buckets: [], count: 0, selectedBucket: null };
  const count = Math.min(bucketLimit, events.length);
  const visibleSet = visible ? new Set(visible) : null;
  const buckets = [];
  for (let bucketIndex = 0; bucketIndex < count; bucketIndex += 1) {
    const start = Math.floor((bucketIndex * events.length) / count);
    const end = Math.max(start + 1, Math.floor(((bucketIndex + 1) * events.length) / count));
    const slice = events.slice(start, end);
    const kinds = [...new Set(slice.map((event) => event.kind).filter(Boolean))];
    const statuses = [...new Set(slice.map((event) => event.status).filter(Boolean))];
    const errors = slice.filter(eventIsError).length;
    const visibleCount = visibleSet ? slice.filter((event) => visibleSet.has(event.index)).length : slice.length;
    buckets.push({
      index: bucketIndex,
      start,
      end: Math.min(events.length, end),
      count: slice.length,
      visibleCount,
      kinds,
      statuses,
      errors,
      selected: selectedIndex != null && selectedIndex >= start && selectedIndex < end,
    });
  }
  return {
    buckets,
    count,
    selectedBucket: selectedIndex == null ? null : buckets.findIndex((bucket) => bucket.selected),
  };
}

function selectedEventDetail(events, selectedIndex, pairs) {
  const event = events.find((candidate) => candidate.index === selectedIndex) ?? null;
  if (!event) {
    return {
      available: false,
      event: null,
      pair: null,
      captured: [],
      unavailable: ['event detail unavailable'],
    };
  }
  const pair = pairs.find((candidate) => candidate.startIndex === event.index || candidate.completeIndex === event.index) ?? null;
  const fields = [
    ['event id', event.eventId],
    ['turn id', event.turnId],
    ['tool call id', event.toolCallId],
    ['tool', event.toolName],
    ['arguments', event.arguments],
    ['result', event.result],
    ['provider time', event.providerAt],
    ['duration', event.durationMs],
    ['usage', event.usage],
    ['parent', event.parentId],
    ['subagent', event.subagentId],
  ];
  const captured = fields.filter(([, value]) => value !== undefined && value !== null).map(([name]) => name);
  const unavailable = fields.filter(([, value]) => value === undefined || value === null).map(([name]) => name);
  return { available: true, event, pair, captured, unavailable };
}

function activityModel(parsed, {
  filter = 'all',
  follow = true,
  selectedIndex = null,
  nowMs = Date.now(),
  view = 'overview',
  expandedTurn = null,
} = {}) {
  const normalizedFilter = normalizeFilter(filter);
  const events = parsed.events ?? [];
  const visible = visibleEventIndices(events, normalizedFilter);
  const selected = selectedIndex != null && visible.includes(Number(selectedIndex))
    ? Number(selectedIndex)
    : follow ? visible.at(-1) ?? null : null;
  const pairs = pairActivityEvents(events);
  const filterCounts = {
    all: events.length,
    turns: events.filter((event) => eventIsResponse(event) || validId(event.turnId) != null).length,
    tools: events.filter(eventIsTool).length,
    errors: events.filter(eventIsError).length,
  };
  const minimap = minimapFor(events, selected, visible);
  const grouped = groupActivityTurns(events, { pairs });
  const parsedExpanded = expandedTurn == null || expandedTurn === '' ? null : Number(expandedTurn);
  const selectedTurn = Number.isInteger(parsedExpanded) && parsedExpanded >= 0 && parsedExpanded < grouped.turns.length
    ? parsedExpanded
    : grouped.turns.findIndex((turn) => turn.id === String(expandedTurn)) >= 0
      ? grouped.turns.findIndex((turn) => turn.id === String(expandedTurn))
      : null;
  for (const turn of grouped.turns) turn.expanded = turn.index === selectedTurn;
  const todayEvents = events.filter((event) => sameLocalDay(event.at, nowMs));
  const todayVisible = visibleEventIndices(todayEvents, normalizedFilter);
  const todayEventByIndex = new Map(todayEvents.map((event) => [event.index, event]));
  const visibleDetailEvents = todayVisible
    .map((index) => todayEventByIndex.get(index))
    .filter(Boolean);
  const overviewRows = [];
  if (grouped.prelude.length) {
    const preludeSummary = eventKindSummary(grouped.prelude, pairs);
    overviewRows.push({ type: 'summary', turnIndex: null, prelude: true, summary: preludeSummary });
  }
  for (const turn of grouped.turns) {
    const matches = normalizedFilter === 'all'
      || normalizedFilter === 'turns'
      ? true
      : eventIsError(turn.response) || turn.atomicEvents.some((event) => (
        normalizedFilter === 'errors' ? eventIsError(event) : eventIsTool(event)
      ));
    if (!matches) continue;
    overviewRows.push({ type: 'response', turnIndex: turn.index, turn, event: turn.response });
    if (turn.expanded) {
      for (const event of turn.atomicEvents) {
        if (normalizedFilter !== 'all' && normalizedFilter !== 'turns') {
          if (normalizedFilter === 'errors' && !eventIsError(event)) continue;
          if (normalizedFilter === 'tools' && !eventIsTool(event)) continue;
        }
        overviewRows.push({ type: 'event', turnIndex: turn.index, turn, event });
      }
    }
    // The summary is a fact about the turn, so it counts the turn's atomic
    // events whatever lens the filter puts on the rows: narrowing the log to
    // tool or error events must never report a turn that captured work as
    // empty.
    overviewRows.push({ type: 'summary', turnIndex: turn.index, turn, summary: turn.summary });
  }
  const detail = selectedEventDetail(events, selected, pairs);
  return {
    path: parsed.path,
    available: parsed.available,
    readable: parsed.readable,
    reason: parsed.reason,
    parseErrors: parsed.parseErrors,
    truncated: parsed.truncated,
    dropped: parsed.dropped,
    plainText: parsed.plainText,
    captureOrder: true,
    events,
    visibleEvents: visible.map((index) => events.find((event) => event.index === index)).filter(Boolean),
    visibleEventIndices: visible,
    pairs,
    minimap,
    minimapBuckets: minimap.buckets,
    filter: normalizedFilter,
    filterState: normalizedFilter,
    filters: [...FILTERS].map((name) => ({ name, count: filterCounts[name], selected: name === normalizedFilter })),
    filterCounts,
    follow,
    followTail: follow,
    selectedIndex: selected,
    selectedEvent: detail.event,
    selectedEventDetail: detail,
    view: VIEWS.has(view) ? view : 'overview',
    expandedTurn: selectedTurn,
    turns: grouped.turns,
    turnSummaries: grouped.turns.map((turn) => turn.summary),
    prelude: grouped.prelude,
    responseCount: grouped.responseCount,
    overviewRows,
    todayEvents,
    visibleDetailEvents,
    detailCaptureDate: localDateKey(nowMs),
  };
}

function normalizeTokens(usage) {
  const source = usage?.tokens && typeof usage.tokens === 'object' ? usage.tokens : usage;
  const tokens = {};
  for (const field of TOKEN_FIELDS) tokens[field] = finiteOrNull(source?.[field]);
  const explicitTotal = finiteOrNull(source?.totalKnown);
  const known = [
    tokens.standardRead,
    tokens.cacheRead,
    tokens.output,
    tokens.reasoning,
    ...(tokens.cacheWrite5m != null || tokens.cacheWrite1h != null
      ? [tokens.cacheWrite5m, tokens.cacheWrite1h]
      : [tokens.cacheWrite]),
  ].filter((value) => value != null);
  tokens.totalKnown = explicitTotal ?? (known.length ? known.reduce((sum, value) => sum + value, 0) : null);
  return tokens;
}

function normalizeMoney(usage) {
  const value = usage && typeof usage === 'object' ? usage : {};
  const apiInput = value.api && typeof value.api === 'object' ? value.api : null;
  const legacyApi = value.apiUsd ?? value.apiEquivalentUsd ?? value.cost?.estimatedUsd;
  const apiUsd = finiteOrNull(apiInput && hasOwn(apiInput, 'usd') ? apiInput.usd : legacyApi);
  const api = {
    usd: apiUsd,
    knownSubtotalUsd: apiUsd,
    basis: textOrNull(apiInput?.basis) ?? textOrNull(value.cost?.basis) ?? (apiUsd == null ? 'unknown' : 'legacy'),
    breakdown: clone(apiInput?.breakdown ?? value.cost?.breakdown ?? null),
    pricedFields: Array.isArray(apiInput?.pricedFields) ? [...apiInput.pricedFields] : [],
    unpricedFields: Array.isArray(apiInput?.unpricedFields) ? [...apiInput.unpricedFields] : [],
    rateCard: clone(apiInput?.rateCard ?? null),
  };
  const subInput = value.subscription && typeof value.subscription === 'object'
    ? value.subscription
    : (hasOwn(value, 'subscriptionUsd') || hasOwn(value, 'subscriptionBasis')
      ? {
        usd: value.subscriptionUsd,
        deltaPct: value.subscriptionDeltaPct ?? value.deltaPct,
        window: value.subscriptionWindow ?? value.window,
        basis: value.subscriptionBasis,
      }
      : null);
  const subscription = {
    pool: textOrNull(subInput?.pool),
    window: textOrNull(subInput?.window),
    deltaPct: finiteOrNull(subInput?.deltaPct),
    usd: finiteOrNull(subInput?.usd),
    knownSubtotalUsd: finiteOrNull(subInput?.usd),
    monthlyPriceUsd: finiteOrNull(subInput?.monthlyPriceUsd),
    windowDays: finiteOrNull(subInput?.windowDays),
    basis: textOrNull(subInput?.basis) ?? 'unknown:no-meter',
    snapshots: clone(subInput?.snapshots ?? null),
  };
  const tokenSource = textOrNull(value.tokenSource) ?? 'unknown';
  return {
    api,
    subscription,
    tokenSource,
    normalizedQuota: clone(value.normalizedQuota ?? null),
    pricing: clone(value.pricing ?? api.rateCard ?? null),
    display: formatMoneyPair({ api, subscription, tokenSource }),
    tokens: normalizeTokens(value),
    raw: clone(usage ?? null),
  };
}

export function normalizeAttemptUsage(usage) {
  return normalizeMoney(usage);
}

function aggregateAttemptUsage(attempts) {
  const records = attempts.map((attempt) => attempt?.usageModel).filter(Boolean);
  if (!records.length) return normalizeAttemptUsage(null);
  if (records.length === 1) return records[0];

  const sumField = (source, field) => {
    const values = records.map((record) => finiteOrNull(record?.[source]?.[field])).filter((value) => value != null);
    return values.length ? values.reduce((sum, value) => sum + value, 0) : null;
  };
  const sumToken = (field) => {
    const values = records.map((record) => finiteOrNull(record.tokens?.[field])).filter((value) => value != null);
    return values.length ? values.reduce((sum, value) => sum + value, 0) : null;
  };
  const tokenSourceValues = [...new Set(records.map((record) => record.tokenSource).filter((value) => value && value !== 'unknown'))];
  const tokenSource = tokenSourceValues.length === 1 ? tokenSourceValues[0] : tokenSourceValues.length ? 'mixed' : 'unknown';
  const tokens = Object.fromEntries([...TOKEN_FIELDS, 'totalKnown'].map((field) => [field, sumToken(field)]));
  const apiKnownValues = records.map((record) => finiteOrNull(record.api?.usd)).filter((value) => value != null);
  const subscriptionKnownValues = records.map((record) => finiteOrNull(record.subscription?.usd)).filter((value) => value != null);
  const apiKnownSubtotalUsd = apiKnownValues.length ? apiKnownValues.reduce((sum, value) => sum + value, 0) : null;
  const subscriptionKnownSubtotalUsd = subscriptionKnownValues.length
    ? subscriptionKnownValues.reduce((sum, value) => sum + value, 0)
    : null;
  const apiUsd = apiKnownValues.length === records.length ? apiKnownSubtotalUsd : null;
  const subscriptionUsd = subscriptionKnownValues.length === records.length ? subscriptionKnownSubtotalUsd : null;
  const deltaPct = sumField('subscription', 'deltaPct');
  const apiBreakdown = {};
  for (const record of records) {
    for (const [key, value] of Object.entries(record.api?.breakdown ?? {})) {
      const number = finiteOrNull(value);
      if (number != null) apiBreakdown[key] = (apiBreakdown[key] ?? 0) + number;
    }
  }
  const firstSubscription = records.find((record) => record.subscription?.pool || record.subscription?.window)?.subscription;
  const apiBases = [...new Set(records.map((record) => record.api?.basis).filter(Boolean))];
  const subscriptionBases = [...new Set(records.map((record) => record.subscription?.basis).filter(Boolean))];
  const api = {
    usd: apiUsd,
    knownSubtotalUsd: apiKnownSubtotalUsd,
    basis: apiBases.length === 1 && apiUsd != null ? apiBases[0] : apiUsd == null ? 'unknown: incomplete attempts' : 'aggregate',
    breakdown: Object.keys(apiBreakdown).length ? apiBreakdown : null,
    pricedFields: [...new Set(records.flatMap((record) => record.api?.pricedFields ?? []))],
    unpricedFields: [...new Set(records.flatMap((record) => record.api?.unpricedFields ?? []))],
    rateCard: clone(records.find((record) => record.api?.rateCard)?.api.rateCard ?? null),
  };
  const subscription = {
    pool: textOrNull(firstSubscription?.pool),
    window: textOrNull(firstSubscription?.window),
    deltaPct,
    usd: subscriptionUsd,
    knownSubtotalUsd: subscriptionKnownSubtotalUsd,
    monthlyPriceUsd: sumField('subscription', 'monthlyPriceUsd'),
    windowDays: finiteOrNull(firstSubscription?.windowDays),
    basis: subscriptionBases.length === 1 && subscriptionUsd != null
      ? subscriptionBases[0]
      : subscriptionUsd == null ? 'unknown:no-meter' : 'aggregate',
    snapshots: clone(records.find((record) => record.subscription?.snapshots)?.subscription.snapshots ?? null),
  };
  return {
    api,
    subscription,
    tokenSource,
    normalizedQuota: clone(records.find((record) => record.normalizedQuota)?.normalizedQuota ?? null),
    pricing: clone(records.find((record) => record.pricing)?.pricing ?? api.rateCard ?? null),
    display: formatMoneyPair({ api, subscription, tokenSource }),
    tokens,
    raw: records.map((record) => clone(record.raw)),
  };
}

function routeModel(attempt, action) {
  const routing = attempt?.routing ?? null;
  const candidates = Array.isArray(routing?.candidates)
    ? routing.candidates.map((candidate) => clone(candidate))
    : Array.isArray(attempt?.routeCandidates)
      ? attempt.routeCandidates.map((candidate) => clone(candidate))
      : [];
  const reason = textOrNull(attempt?.routeWhy) ?? textOrNull(routing?.reason);
  const lane = textOrNull(routing?.lane) ?? textOrNull(attempt?.lane);
  const effort = textOrNull(attempt?.effort) ?? textOrNull(routing?.effort);
  const forecast = clone(routing?.forecast ?? null);
  return {
    lane,
    effort,
    reason,
    explanation: reason,
    candidates,
    forecast,
    available: Boolean(reason || lane || effort || candidates.length || forecast),
    actionLane: textOrNull(action?.lane),
  };
}

function failureModel(attempt, action) {
  const raw = attempt?.failure ?? action?.failure ?? action?.lastFailure ?? null;
  const kind = textOrNull(attempt?.failureKind) ?? textOrNull(raw?.kind);
  const message = textOrNull(attempt?.failureReason)
    ?? textOrNull(raw?.message)
    ?? (kind ? textOrNull(attempt?.why) : null);
  if (!kind && !message) return null;
  return { kind, message, raw: clone(raw) };
}

function attemptRecord(raw, action, { runDir = null, nowMs = Date.now() } = {}) {
  const ordinal = finiteOrNull(raw?.ordinal ?? raw?.attemptNumber);
  const actionId = textOrNull(raw?.actionId) ?? textOrNull(action?.id);
  const usage = normalizeAttemptUsage(raw?.usage);
  const streamPath = resolveAttemptStreamPath(raw, { runDir, actionId, ordinal });
  const parsed = parseAttemptStream(resolveExistingPath(streamPath, runDir) ?? (streamPath?.endsWith('.jsonl') ? streamPath : null));
  const start = textOrNull(raw?.startedAt);
  const finish = textOrNull(raw?.finishedAt) ?? textOrNull(raw?.endedAt);
  const duration = durationFromAttempt(raw, nowMs);
  const outputFile = retainedPath(raw?.outputFile ?? raw?.outFile, runDir);
  const taskFile = retainedPath(raw?.taskFile, runDir);
  const failure = failureModel(raw, action);
  return {
    ...clone(raw),
    id: textOrNull(raw?.id),
    actionId,
    ordinal,
    attemptNumber: ordinal,
    status: textOrNull(raw?.status) ?? 'unknown',
    pool: textOrNull(raw?.pool),
    model: textOrNull(raw?.model),
    effort: textOrNull(raw?.effort) ?? textOrNull(raw?.routing?.effort),
    reasoning: clone(raw?.reasoning ?? null),
    lane: textOrNull(raw?.lane) ?? textOrNull(raw?.routing?.lane),
    startedAt: start,
    finishedAt: finish,
    durationMs: duration,
    durationSec: duration == null ? null : duration / 1000,
    failure,
    failureReason: failure?.message ?? null,
    routing: clone(raw?.routing ?? null),
    route: routeModel(raw, action),
    usage: usage.raw,
    usageModel: usage,
    tokens: usage.tokens,
    money: usage,
    outputFile,
    outFile: outputFile,
    taskFile,
    streamFile: parsed.path,
    activity: activityModel(parsed),
    outputBytes: finiteOrNull(raw?.outputBytesObserved ?? raw?.outputBytes ?? raw?.bytes?.output),
    outputBytesObserved: finiteOrNull(raw?.outputBytesObserved ?? raw?.outputBytes ?? raw?.bytes?.output),
    streamAvailable: parsed.available,
    turnsCaptured: parsed.events.some((event) => validId(event.turnId) != null),
    toolDetailsCaptured: parsed.events.some(eventHasToolDetails),
    usagePending: raw?.usage == null && String(raw?.status ?? '').toLowerCase() === 'running',
  };
}

function readResultEnvelope(row, state, runDir) {
  const candidates = [state?.lifecycle?.resultFile, runDir ? join(runDir, 'result.json') : null, runDir ? join(runDir, 'report.json') : null];
  for (const candidate of candidates) {
    const path = resolveExistingPath(candidate, runDir);
    const value = safeReadJson(path);
    if (value) return { value, path };
  }
  if (row?.report && typeof row.report === 'object') {
    return { value: row.report, path: retainedPath(state?.lifecycle?.resultFile, runDir) };
  }
  return { value: null, path: retainedPath(state?.lifecycle?.resultFile, runDir) };
}

function requirementEvidence(result, state) {
  const source = Array.isArray(result?.requirements)
    ? result.requirements
    : result?.requirements && typeof result.requirements === 'object'
      ? Object.values(result.requirements)
      : Array.isArray(result?.requirementEvidence)
        ? result.requirementEvidence
        : Object.values(state?.ledger?.requirements ?? {});
  return source.map((requirement) => ({
    id: textOrNull(requirement?.id),
    status: textOrNull(requirement?.status) ?? 'unknown',
    mandatory: requirement?.mandatory === true,
    why: textOrNull(requirement?.why),
    evidence: Array.isArray(requirement?.evidence) ? clone(requirement.evidence) : [],
  }));
}

function verdictModel({ result, state, action, requirements }) {
  const executionStatus = textOrNull(action?.status) ?? 'unknown';
  const workflowStatus = textOrNull(result?.status) ?? textOrNull(state?.lifecycle?.status) ?? 'unknown';
  const explicitVerified = typeof result?.verified === 'boolean' ? result.verified
    : typeof state?.verified === 'boolean' ? state.verified : null;
  return {
    execution: {
      status: executionStatus,
      succeeded: SUCCESS_STATUSES.has(executionStatus),
      terminal: !['running', 'pending', 'ready', 'queued', 'unknown'].includes(executionStatus),
    },
    workflow: {
      status: workflowStatus,
      terminal: ['completed', 'partial', 'cancelled', 'failed', 'interrupted'].includes(workflowStatus),
    },
    verification: {
      verdict: explicitVerified,
      available: explicitVerified !== null || requirements.some((entry) => entry.evidence.length > 0),
      reason: textOrNull(result?.reason),
      requirements,
    },
    executionStatus,
    workflowStatus,
    verified: explicitVerified,
  };
}

function promptModel(path) {
  const lines = path ? taskPreview(path, 6) : [];
  return { path: path ?? null, available: lines.length > 0, lines, text: lines.length ? lines.join('\n') : null };
}

function outputModel(path, output, maxChars = 64 * 1024) {
  const lines = path || output ? outcomePreview(path, output, maxChars) : [];
  return { path: path ?? null, available: lines.length > 0, lines, text: lines.length ? lines.join('\n') : null };
}

function artifactModel({ runDir, taskFile, outputFile, streamFile, resultFile }) {
  return {
    runDir: runDir ?? null,
    task: taskFile ?? null,
    output: outputFile ?? null,
    stream: streamFile ?? null,
    result: resultFile ?? null,
    paths: { task: taskFile ?? null, output: outputFile ?? null, stream: streamFile ?? null, result: resultFile ?? null },
  };
}

function chooseAttempt(rawAttempts, selectedAgent, options = {}) {
  if (!rawAttempts.length) return null;
  const requestedValue = options.attemptOrdinal
    ?? options.selectedAttempt
    ?? (selectedAgent?.status === 'running' ? selectedAgent?.attempt?.attemptNumber : null);
  const requested = requestedValue && typeof requestedValue === 'object'
    ? requestedValue.ordinal ?? requestedValue.attemptNumber ?? requestedValue.id
    : requestedValue;
  if (requested != null) {
    const found = rawAttempts.find((attempt) => (
      (requestedValue && typeof requestedValue === 'object' && requestedValue.id && attempt.id === requested)
      || Number(attempt.ordinal) === Number(requested)
    ));
    if (found) return found;
  }
  return rawAttempts.find((attempt) => attempt.status === 'running') ?? rawAttempts.at(-1);
}

function normalizeRowInput(input) {
  if (input?.row?.state) return input;
  if (input?.state) return { row: input };
  return { row: null };
}

/** Build the complete Step model from dashboardModel(row) or a row directly. */
export function stepPageModel(input, {
  phaseIndex = null,
  agentIndex = null,
  actionId = null,
  nowMs = Date.now(),
  attemptOrdinal = null,
  selectedAttempt = null,
  selectedEventIndex = null,
  activityFilter = 'all',
  filter = null,
  follow = true,
  followTail = null,
  view = 'overview',
  expandedTurn = null,
} = {}) {
  const normalizedInput = normalizeRowInput(input);
  const row = normalizedInput.row;
  if (!row?.state) return { model: input, panel: null, state: null, agent: null, shortId: '' };
  const panel = input?.panel?.selectedAgent ? input.panel : workflowPanelModel(row, { phaseIndex, agentIndex });
  const state = panel.state ?? row.state;
  const selectedAgent = panel.selectedAgent ?? null;
  const allActionDefinitions = [...(state.program?.actions ?? []), ...(state.actions ?? [])];
  const actionState = actionId ? (state.actions ?? []).find((entry) => entry.id === actionId) : null;
  const actionDefinition = actionId ? allActionDefinitions.find((entry) => entry.id === actionId) : null;
  const action = actionId
    ? (actionState || actionDefinition ? { ...(actionDefinition ?? {}), ...(actionState ?? {}) } : null)
    : (selectedAgent?.action
      ?? actionState
      ?? allActionDefinitions.find((entry) => (state.attempts ?? []).some((attempt) => attempt.actionId === entry.id && attempt.status === 'running'))
      ?? allActionDefinitions.find((entry) => (state.attempts ?? []).some((attempt) => attempt.actionId === entry.id))
      ?? null);
  if (!action) return { model: input, panel, state, agent: null, shortId: row.shortId ?? state.shortId ?? '' };
  const selectedActionId = action.id;
  const rawAttempts = (state.attempts ?? [])
    .filter((attempt) => attempt.actionId === selectedActionId)
    .sort((a, b) => Number(a.ordinal ?? 0) - Number(b.ordinal ?? 0));
  const runDir = row.runDir ?? row.dir ?? null;
  const enrichedAttempts = rawAttempts.map((attempt) => attemptRecord(attempt, action, { runDir, nowMs }));
  const rawSelected = chooseAttempt(rawAttempts, selectedAgent, { attemptOrdinal, selectedAttempt });
  const selected = enrichedAttempts.find((attempt) => attempt.id === rawSelected?.id) ?? enrichedAttempts.at(-1) ?? null;
  const active = selectedAgent?.active ?? (selected?.status === 'running' ? selected : null);
  const reasoning = reasoningText(selected ?? active) || reasoningText(active);
  const assignments = input?.assignments ?? [];
  const assignment = assignments.find((entry) => entry.runId === row.runId && entry.actionId === selectedActionId) ?? null;
  const expected = finiteOrNull(assignment?.expectedMinutes);
  const startedAt = selected?.startedAt ?? active?.startedAt ?? action.startedAt ?? null;
  const ranFor = durationText(startedAt, selected?.finishedAt);

  const resultRecord = readResultEnvelope(row, state, runDir);
  const result = resultRecord.value;
  const requirements = requirementEvidence(result, state);
  const verdict = verdictModel({ result, state, action, requirements });
  const outputRecord = state.outputs?.[selectedActionId] ?? null;
  const taskFile = retainedPath(selected?.taskFile ?? active?.taskFile, runDir);
  const outFile = retainedPath(selected?.outputFile ?? active?.outputFile ?? outputRecord?.outFile, runDir);
  const output = outputModel(outFile, outputRecord);
  const prompt = promptModel(taskFile);
  const followState = followTail == null ? Boolean(follow) : Boolean(followTail);
  const activity = selected
    ? activityModel(parseAttemptStream(selected.streamFile), {
      filter: filter ?? activityFilter,
      follow: followState,
      selectedIndex: selectedEventIndex,
      nowMs,
      view,
      expandedTurn,
    })
    : activityModel(parseAttemptStream(null), { nowMs, view, expandedTurn });
  const selectedUsage = selected?.usageModel ?? normalizeAttemptUsage(null);
  const totalUsage = aggregateAttemptUsage(enrichedAttempts);
  const route = routeModel(selected ?? active, action);
  const resultPath = resultRecord.path ?? retainedPath(state.lifecycle?.resultFile, runDir);
  const durationFacts = actionDurationFacts(rawAttempts, nowMs);
  const activeDurationMs = durationFacts.activeMs
    ?? (!durationFacts.unknown ? selected?.durationMs : null);
  const selectedHasFinish = dateMs(selected?.finishedAt) ?? dateMs(selected?.endedAt);
  const spanDurationMs = durationFacts.spanMs
    ?? (!durationFacts.unknown && durationFacts.intervals.length === 0 && selectedHasFinish != null
      ? selected?.durationMs : null);
  const outcome = {
    available: Boolean(result || output.available || verdict.execution.terminal),
    resultAvailable: Boolean(result),
    result,
    resultPath,
    action: (Array.isArray(result?.actions) ? result.actions : Object.values(result?.actions ?? {}))
      .find((entry) => entry?.id === selectedActionId) ?? null,
    actionStatus: verdict.executionStatus,
    workflowStatus: verdict.workflowStatus,
    verified: verdict.verified,
    reason: verdict.verification.reason,
    requirements,
    output,
  };
  const taskBlock = {
    available: prompt.available || Boolean(action.purpose || action.prompt),
    prompt: textOrNull(action.prompt) ?? textOrNull(state.intent?.goal),
    task: prompt,
    lines: prompt.lines,
    firstLines: prompt.lines,
    promptLines: prompt.lines,
    taskLines: prompt.lines,
    path: taskFile,
    expanded: false,
  };
  const resultBlock = {
    available: outcome.available,
    output: outcome.output,
    artifacts: artifactModel({ runDir, taskFile, outputFile: outFile, streamFile: activity.path, resultFile: resultPath }),
    outcome: {
      execution: verdict.execution,
      workflow: verdict.workflow,
      verification: verdict.verification,
      requirements,
      reason: outcome.reason,
      resultAvailable: outcome.resultAvailable,
    },
    result: outcome.result,
    resultPath: outcome.resultPath,
  };
  const moneyDisplay = totalUsage.display;
  const costBlock = {
    moneyPair: totalUsage,
    money: moneyDisplay,
    tokens: totalUsage.tokens,
    tokenSource: totalUsage.tokenSource,
    budget: clone(input?.budget ?? row?.budget ?? state?.budget ?? null),
    pending: Boolean(selected?.usagePending),
  };
  const bytes = finiteOrNull(selected?.outputBytesObserved ?? active?.outputBytesObserved ?? outputRecord?.bytes);
  const live = verdict.executionStatus === 'running' ? 'live' : 'recorded';
  const headerSpark = live === 'live' ? outputSparkline(selected ?? active, row.runDir, 10) : '';
  const poolEconomics = (() => {
    try {
      return runEconomics(row, input?.pools ?? [], nowMs).pools
        .find((entry) => entry.name === (selected?.pool ?? active?.pool ?? selectedAgent?.pool)) ?? null;
    } catch { return null; }
  })();
  const poolRecord = (Array.isArray(input?.pools) ? input.pools : [])
    .find((entry) => entry?.name === (selected?.pool ?? active?.pool ?? selectedAgent?.pool)) ?? null;
  const connector = poolRecord?.connector && typeof poolRecord.connector === 'object'
    ? poolRecord.connector
    : null;
  const selectedModel = selected?.model ?? active?.model ?? null;
  const freeModel = connector
    ? isFreeModel(connector, selectedModel)
    : typeof poolRecord?.free === 'boolean' ? poolRecord.free : null;
  const meterType = textOrNull(connector?.meter?.type)
    ?? (poolRecord?.meterSource && poolRecord.meterSource !== 'none' ? textOrNull(poolRecord.meterSource) : null);
  const poolProfile = {
    name: textOrNull(poolRecord?.name ?? selected?.pool ?? active?.pool),
    model: textOrNull(selectedModel),
    freeModel,
    meterType,
    meterSource: textOrNull(poolRecord?.meterSource),
    pacingWindow: textOrNull(poolRecord?.pacingWindow ?? connector?.meter?.window),
    available: Boolean(poolRecord),
  };
  const turnsCaptured = activity.turns.length > 0;
  const toolDetailsCaptured = activity.events.some(eventHasToolDetails);
  const availability = {
    streamAvailable: Boolean(activity.available),
    streamReadable: Boolean(activity.readable),
    streamParseErrors: activity.parseErrors,
    turnsCaptured,
    toolDetailsCaptured,
    toolIdentityCaptured: toolDetailsCaptured,
    argumentsCaptured: activity.events.some((event) => hasOwn(event, 'arguments')),
    resultsCaptured: activity.events.some((event) => hasOwn(event, 'result')),
    eventUsageCaptured: activity.events.some((event) => event.usage != null),
    subagentsCaptured: activity.events.some((event) => validId(event.parentId) || validId(event.subagentId)),
    eventDurationsCaptured: activity.events.some((event) => finiteMs(event.durationMs) != null) || activity.pairs.some((pair) => pair.durationMs != null),
    pairedEventsCaptured: activity.pairs.length > 0,
    usageCaptured: selected?.usage != null,
    usagePending: Boolean(selected?.usagePending),
    promptAvailable: prompt.available,
    outputAvailable: output.available,
    resultAvailable: outcome.resultAvailable,
    outcomeAvailable: outcome.available,
    routeAvailable: route.available,
    verificationAvailable: verdict.verification.available,
    selectedEventAvailable: activity.selectedEventDetail.available,
    artifactsAvailable: Boolean(taskFile || outFile || activity.path || resultPath),
  };
  const identity = {
    runId: textOrNull(row.runId ?? state.runId),
    shortId: textOrNull(row.shortId ?? state.shortId),
    actionId: selectedActionId,
    action: clone(action),
    purpose: textOrNull(action.purpose ?? action.role),
    goal: textOrNull(state.intent?.goal ?? state.workflow ?? result?.goal),
    status: verdict.executionStatus,
    executionStatus: verdict.executionStatus,
    executionSucceeded: verdict.execution.succeeded,
    workflowStatus: verdict.workflowStatus,
    verified: verdict.verified,
    verificationVerdict: verdict.verified,
    verificationReason: verdict.verification.reason,
    project: textOrNull(row.project ?? state.project ?? state.intent?.project),
  };
  const header = {
    identity,
    pool: textOrNull(selected?.pool ?? active?.pool),
    model: textOrNull(selected?.model ?? active?.model),
    effort: textOrNull(selected?.effort ?? selected?.routing?.effort ?? route.effort),
    duration: {
      activeMs: activeDurationMs,
      spanMs: spanDurationMs,
      activeMinutes: activeDurationMs == null ? null : activeDurationMs / 60_000,
      spanMinutes: spanDurationMs == null ? null : spanDurationMs / 60_000,
      active: activeDurationMs == null ? null : activeDurationMs / 60_000,
      span: spanDurationMs == null ? null : spanDurationMs / 60_000,
    },
    activeDurationMs,
    spanDurationMs,
    activeDuration: activeDurationMs,
    spanDuration: spanDurationMs,
  };
  const model = {
    identity,
    verdict,
    selectedAttempt: selected,
    attemptHistory: enrichedAttempts,
    attempts: enrichedAttempts,
    route,
    // `money` remains the old string for the extracted renderer. `moneyPair`
    // is the structured v2 pair used by the feature view.
    money: moneyDisplay,
    moneyPair: totalUsage,
    selectedMoneyPair: selectedUsage,
    usage: totalUsage,
    attemptUsage: selectedUsage,
    tokens: totalUsage.tokens,
    attemptTokens: selectedUsage.tokens,
    totalTokens: totalUsage.tokens,
    activity,
    view: VIEWS.has(view) ? view : 'overview',
    expandedTurn: activity.expandedTurn,
    turns: activity.turns,
    turnSummaries: activity.turnSummaries,
    overviewRows: activity.overviewRows,
    header,
    durationFacts,
    sectionOrder: ['header', 'task', 'activity', 'result', 'cost'],
    blocks: [
      { key: 'header', ...header },
      { key: 'task', ...taskBlock },
      { key: 'activity', ...activity },
      { key: 'result', ...resultBlock },
      { key: 'cost', ...costBlock },
    ],
    activeDurationMs,
    spanDurationMs,
    activeMinutes: activeDurationMs == null ? null : activeDurationMs / 60_000,
    spanMinutes: spanDurationMs == null ? null : spanDurationMs / 60_000,
    duration: header.duration,
    minutes: { active: activeDurationMs == null ? null : activeDurationMs / 60_000, span: spanDurationMs == null ? null : spanDurationMs / 60_000 },
    selectedEvent: activity.selectedEvent,
    selectedEventDetail: activity.selectedEventDetail,
    // Keep the extraction renderer's arrays at the historical keys while
    // exposing rich objects for the Step feature view.
    outcome: output.lines,
    outcomeModel: outcome,
    task: taskBlock,
    taskBlock,
    taskModel: taskBlock,
    resultBlock,
    resultView: resultBlock,
    resultModel: resultBlock,
    cost: costBlock,
    costBlock,
    costModel: costBlock,
    activityModel: activity,
    result: outcome.result,
    resultEnvelope: outcome.result,
    resultPath: outcome.resultPath,
    execution: verdict.execution,
    verification: verdict.verification,
    workflow: verdict.workflow,
    prompt: prompt.lines,
    promptModel: prompt,
    promptPreview: prompt.lines,
    artifacts: artifactModel({ runDir, taskFile, outputFile: outFile, streamFile: activity.path, resultFile: resultPath }),
    availability,
    streamAvailable: availability.streamAvailable,
    turnsCaptured: availability.turnsCaptured,
    toolDetailsCaptured: availability.toolDetailsCaptured,
    usagePending: availability.usagePending,
    // Extraction compatibility fields.
    modelInput: input,
    panel,
    state,
    agent: selectedAgent,
    shortId: identity.shortId ?? '',
    action,
    attempt: selected,
    active,
    routing: selected?.routing ?? active?.routing ?? null,
    reasoning,
    assignment,
    expected,
    startedAt,
    ranFor,
    pool: poolEconomics,
    poolProfile,
    attemptCost: selectedUsage.api.usd,
    taskFile,
    promptLines: prompt.lines,
    output: output.lines,
    outFile,
    outcomePreview: output.lines,
    outputModel: output,
    bytes,
    live,
    headerSpark,
  };
  return model;
}

export const stepModel = stepPageModel;
export const buildStepModel = stepPageModel;

/**
 * Adapt a normalized single-task ledger row to the same Step projection.
 *
 * The ledger intentionally has no workflow result, verification, usage, or
 * stream fields. The adapter therefore supplies only the durable task facts;
 * it never manufactures an envelope, event, verdict, or effort value.
 */
export function taskStepModel(task, { nowMs = Date.now(), view = 'overview', expandedTurn = null, ...options } = {}) {
  const record = task && typeof task === 'object' ? task : {};
  const taskFile = textOrNull(record.taskFile);
  const outputFile = textOrNull(record.outFile ?? record.outputFile);
  const id = textOrNull(record.id) ?? (taskFile ? basename(taskFile) : 'task');
  const status = record.ok === true ? 'succeeded'
    : record.ok === false ? 'failed'
      : record.startedAt && !record.endedAt ? 'running' : 'unknown';
  const action = {
    id,
    status,
    attempts: 1,
    purpose: null,
    startedAt: textOrNull(record.startedAt),
    finishedAt: textOrNull(record.endedAt ?? record.finishedAt),
    outputFile,
  };
  const attempt = {
    id: `${id}-1`,
    actionId: id,
    ordinal: 1,
    status,
    pool: textOrNull(record.pool),
    model: textOrNull(record.model),
    startedAt: textOrNull(record.startedAt),
    finishedAt: textOrNull(record.endedAt ?? record.finishedAt),
    durationMs: finiteMs(record.durationMs),
    taskFile,
    outputFile,
    streamFile: null,
    routing: { lane: textOrNull(record.lane), effort: null },
    usage: null,
  };
  // A standalone task row has no persisted stream pointer. Keep the adapter
  // from asking the workflow naming convention for a synthetic stream path.
  const runDir = null;
  const state = {
    runId: `task:${id}`,
    shortId: id.slice(0, 6),
    workflow: null,
    project: record.project ?? null,
    intent: {},
    lifecycle: {
      status: status === 'succeeded' ? 'completed' : status === 'failed' ? 'failed' : status,
      startedAt: attempt.startedAt,
      finishedAt: attempt.finishedAt,
      resultFile: null,
    },
    planner: { status: 'completed', attempts: [], turns: 0 },
    program: { actions: [action] },
    actions: [action],
    attempts: [attempt],
    presentation: { stages: [{ id: 'task', label: 'Task', actionIds: [id], startedAt: attempt.startedAt, completedAt: attempt.finishedAt }] },
    outputs: outputFile ? { [id]: { outFile: outputFile } } : {},
    ledger: { requirements: {} },
  };
  const row = {
    runId: state.runId,
    shortId: state.shortId,
    runDir,
    project: record.project ?? null,
    state,
  };
  const model = stepPageModel({ row, pools: [] }, {
    actionId: id,
    nowMs,
    view,
    expandedTurn,
    ...options,
  });
  model.taskRecord = clone(record);
  model.taskResult = textOrNull(record.reason);
  model.identity.project = record.project ?? null;
  // A ledger task has no workflow result envelope; `unknown` from the generic
  // state shim is normalized back to an unavailable workflow fact.
  model.identity.workflowStatus = null;
  model.verdict.workflow = { ...model.verdict.workflow, status: null };
  model.verdict.workflowStatus = null;
  model.workflow = { ...model.workflow, status: null };
  model.cost = model.costBlock;
  // A task reason is a result fact, not an independent verification verdict.
  model.resultBlock = {
    ...model.resultBlock,
    taskReason: model.taskResult,
    outcome: {
      ...model.resultBlock.outcome,
      reason: model.taskResult,
      workflow: { ...model.resultBlock.outcome.workflow, status: null },
    },
  };
  model.resultView = model.resultBlock;
  model.outcomeModel = {
    ...model.outcomeModel,
    reason: model.taskResult,
    workflow: { ...model.outcomeModel.workflow, status: null },
  };
  return model;
}

export {
  activityModel,
  eventIsResponse,
  eventKindSummary,
  eventIsError,
  eventIsTool,
  minimapFor,
  normalizeTokens,
};
