// Width-independent data for the Step page.
//
// A Step combines durable state, one attempt's artifacts, an optional result
// envelope, and an optional per-attempt JSONL stream. Keep those sources
// separate here so the view cannot accidentally manufacture turns, tools,
// duration, usage, cost, or verification from prose.

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
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
import { formatMoney, formatMoneyPair } from '../lib/usage-basis.js';
import { finiteOrNull } from '../lib/num.js';
import { isFreeModel } from '../lib/usage.js';
import { loadTemplates, ownsPoolName, providerDirs } from '../lib/providers.js';
import { returnedEarlyItems, returnedEarlyText, timeBoxText } from './time-box.js';

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
    tailSegment: false,
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
  const appendLines = (body, { dropThroughSeq = null } = {}) => {
    for (const lineValue of body.split(/\r?\n/)) {
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
      const rawSeq = finiteOrNull(value.seq);
      if (dropThroughSeq != null && rawSeq != null && rawSeq <= dropThroughSeq) continue;
      events.push(normalized);
    }
  };
  appendLines(text);
  const tailFile = `${streamFile}.tail`;
  const tailSegment = existsSync(tailFile);
  if (tailSegment) {
    const tailText = safeReadText(tailFile);
    if (tailText != null) appendLines(tailText, { dropThroughSeq: events.at(-1)?.seq ?? null });
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
    tailSegment,
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

function isInFlightStart(event) {
  const status = String(event?.status ?? '').toLowerCase();
  return ['started', 'start', 'running'].includes(status)
    || /\.started$|_started$|^start/.test(String(event?.providerType ?? '').toLowerCase());
}

function isComplete(event) {
  const status = String(event?.status ?? '').toLowerCase();
  return COMPLETE_STATUSES.has(status) || /\.completed$|_completed$|^complete|^result$/.test(String(event?.providerType ?? '').toLowerCase());
}

// Each connector declares how its captured tool names map to the Step page's
// finite operation kinds. Provider quirks stay in connector.json, not here.
const TOOL_KINDS = new Set(['command', 'read', 'edit', 'search', 'other']);
let connectorToolKinds = null;

function declaredToolKinds() {
  if (connectorToolKinds) return connectorToolKinds;
  let templates = {};
  try { templates = loadTemplates(providerDirs('')); } catch { templates = {}; }
  const byProvider = new Map();
  const every = new Map();
  for (const [name, template] of Object.entries(templates)) {
    const map = new Map();
    for (const [tool, kind] of Object.entries(template?.eventStream?.toolKinds ?? {})) {
      const key = String(tool).trim().toLowerCase();
      if (!key || !TOOL_KINDS.has(kind)) continue;
      map.set(key, kind);
      if (!every.has(key)) every.set(key, kind);
    }
    byProvider.set(name, map);
  }
  connectorToolKinds = { byProvider, every };
  return connectorToolKinds;
}

export function toolKindsForPool(pool) {
  const { byProvider, every } = declaredToolKinds();
  const owner = [...byProvider.keys()]
    .filter((name) => ownsPoolName(name, pool))
    .sort((a, b) => b.length - a.length)[0];
  return owner ? byProvider.get(owner) : every;
}

function withToolKinds(events, pool) {
  const kinds = toolKindsForPool(pool);
  return events.map((event) => {
    const toolKind = kinds.get(String(event?.kind ?? '').trim().toLowerCase()) ?? 'other';
    return event && typeof event === 'object' ? { ...event, toolKind } : event;
  });
}

// A provider that reports a tool result as its own event names it `tool`
// (claude-code's tool_result, grok's tool_call_update). A result answers a
// call, so it is never an operation of its own.
const TOOL_RESULT_KINDS = new Set(['tool']);

function eventIsUnnamedCapture(event) {
  return event?.kind === 'agent' && !validId(event?.toolName) && !eventIsResponse(event);
}

function toolKindCategory(event) {
  const declared = event?.toolKind ?? toolKindsForPool(null).get(String(event?.kind ?? '').trim().toLowerCase()) ?? null;
  return declared && declared !== 'other' ? declared : null;
}

export function toolCallUpdates(events = []) {
  const calls = new Map();
  const closed = new Set();
  const updates = new Map();
  events.forEach((event, position) => {
    const id = validId(event?.toolCallId);
    if (!id || eventIsResponse(event)) return;
    const index = event.index ?? position;
    const call = calls.get(id);
    const opens = isStart(event) && !isComplete(event);
    if (call == null || (closed.has(id) && opens && validId(event?.toolName))) {
      if (!isComplete(event) || isStart(event)) {
        calls.set(id, index);
        closed.delete(id);
      }
      return;
    }
    if (!closed.has(id) && isComplete(event) && !isStart(event)) {
      closed.add(id);
      return;
    }
    updates.set(index, call);
  });
  return updates;
}

function callUpdatesByCall(entries = []) {
  const byCall = new Map();
  for (const [update, call] of entries ?? []) byCall.set(call, [...(byCall.get(call) ?? []), update]);
  return byCall;
}

function unlinkedCaptures(events, merged, updatesOf) {
  const linked = new Set([...updatesOf.values()].flat());
  return events.filter((event) => merged.has(event.index) && !linked.has(event.index)).map((event) => event.index);
}

function mergedCaptures(events = []) {
  const merged = new Set(toolCallUpdates(events).keys());
  events.forEach((event, position) => {
    if (eventIsUnnamedCapture(event)) merged.add(event.index ?? position);
  });
  return merged;
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
  const updates = toolCallUpdates(indexedEvents);
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
    if (!id || updates.has(event.index)) continue;
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
    if (used.has(event.index) || validId(event?.toolCallId) || eventIsUnnamedCapture(event)) continue;
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
    !used.has(event.index) && isStart(event) && !isComplete(event) && !eventIsUnnamedCapture(event)
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
    || kind === 'command'
    || kind === 'tool_call'
    || providerType.includes('tool')
    || toolKindCategory(event) != null
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
  // Codex closes every turn with a `result` envelope (`turn.completed`, usage
  // only, no text). It is the boundary marker, never a response of its own:
  // treating it as one opened an empty "response summary unavailable" turn at
  // the end of every codex step (seen on the 0.35.1 QA task, 2026-09-20).
  if (ENVELOPE_KINDS.has(kind)) return false;
  return kind === 'response'
    || kind === 'assistant_response'
    || providerType === 'response'
    || providerType.endsWith('.response')
    || providerType.endsWith('.response.completed')
    || providerType === 'turn.completed';
}

/**
 * A response closes a turn only when the provider recorded it as finished.
 * A streaming response is the model's own text arriving in pieces, not a
 * boundary: grok declares `aggregate: consecutive` plus `summaryMode: concat`
 * on its `text` rule, so it captures one `response/streaming` per delta and
 * closes the run with a summary-less `response/completed` terminator. Reading
 * every response as a boundary turned that one turn stream into 474 turns, 459
 * of them empty. Only a completed response ends the turn; the last chunk of a
 * still-streaming run ends it too, because nothing else will.
 */
function responseClosesTurn(event) {
  const status = String(event?.status ?? '').toLowerCase();
  if (COMPLETE_STATUSES.has(status)) return true;
  return /\.completed$|_completed$/.test(String(event?.providerType ?? '').toLowerCase());
}

/**
 * The text a turn's row prints. A finished response owns its wording; while a
 * run is still streaming, the chunks it has already sent are joined. `concat`
 * streamers send raw deltas, so the join is exact — no space, wording or
 * sentence is invented, and an empty run stays unknown rather than "0".
 */
function responseTextOf(terminal, chunks) {
  const finished = textOrNull(terminal?.summary);
  if (finished) return finished;
  const streamed = chunks
    .map((chunk) => String(chunk?.summary ?? ''))
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
  return streamed || null;
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
function eventKindSummary(events = [], pairs = null, merged = null) {
  const summary = {
    commands: 0,
    filesRead: 0,
    searches: 0,
    edits: 0,
    otherTools: 0,
    errors: 0,
    total: 0,
  };
  const relevant = pairs ?? pairActivityEvents(events);
  const partOfCall = merged ?? mergedCaptures(events);
  const paired = new Set();
  const units = [];
  for (const pair of relevant) {
    paired.add(pair.startIndex);
    paired.add(pair.completeIndex);
    const start = events.find((event) => event?.index === pair.startIndex);
    if (start) units.push(start);
  }
  for (const event of events) {
    if (event && typeof event === 'object' && !paired.has(event.index) && !partOfCall.has(event.index)
      && !eventIsResponse(event) && !ENVELOPE_KINDS.has(String(event.kind ?? '').trim().toLowerCase())) {
      units.push(event);
    }
  }
  for (const event of units) {
    summary.total += 1;
    const category = toolKindCategory(event);
    if (category === 'command') summary.commands += 1;
    else if (category === 'read') summary.filesRead += 1;
    else if (category === 'search') summary.searches += 1;
    else if (category === 'edit') summary.edits += 1;
    else summary.otherTools += 1;
  }
  for (const event of events) {
    if (eventIsError(event)) summary.errors += 1;
  }
  summary.text = `${summary.commands} commands · ${summary.filesRead} files read · ${summary.edits} edits · ${summary.errors} errors`;
  if (summary.searches > 0) summary.text += ` · ${summary.searches} searches`;
  if (summary.otherTools > 0) summary.text += ` · ${summary.otherTools} other tools`;
  return summary;
}

/**
 * Group a capture-order stream into the product's human turn projection.
 * Every turn gets one response row: the response that finished it, or the
 * chunks already streamed while it is still running. An atomic event belongs
 * to the turn that was open when it was captured, so a turn's summary covers
 * every atomic event since the previous completed response, and the started
 * and completed halves of one operation are never split across two turns.
 * `responseEvent` keeps the raw captured event the row was built from, and
 * `responseChunks` the streamed deltas that carry the text of a turn whose
 * terminator was captured without any. `pairs` is the stream-wide pairing when
 * the caller already computed one, so a summary counts a command whose
 * completion crossed a response once.
 */
export function groupActivityTurns(events = [], { pairs = null } = {}) {
  const turns = [];
  const prelude = [];
  let current = null;
  const openTurn = (event) => {
    const turn = {
      index: turns.length,
      id: validId(event.turnId) ?? `turn-${turns.length + 1}`,
      response: event,
      responseEvent: event,
      responseClosed: false,
      responseChunks: [],
      eventIndices: [],
      atomicEvents: [],
    };
    turns.push(turn);
    return turn;
  };
  for (const event of events) {
    if (eventIsResponse(event)) {
      // A chunk continues the open response; anything else — the completed
      // terminator, or a first chunk after a finished one — opens a new turn.
      if (!current || current.responseClosed) current = openTurn(event);
      current.eventIndices.push(event.index);
      if (responseClosesTurn(event)) {
        current.response = event;
        current.responseEvent = event;
        current.responseClosed = true;
      } else {
        current.responseChunks.push(event);
      }
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
  const merged = mergedCaptures(events);
  for (const turn of turns) {
    turn.summary = eventKindSummary(turn.atomicEvents, pairedEvents, merged);
    turn.summaryText = turn.summary.text;
    turn.responseText = responseTextOf(turn.responseClosed ? turn.response : null, turn.responseChunks);
    // The row prints the turn's own text: a finished response's wording, or the
    // chunks streamed so far. Only `summary` is composed from the provider's
    // captured text; every other captured field is carried through untouched.
    turn.response = turn.responseText != null && turn.responseText !== turn.response.summary
      ? { ...turn.response, summary: turn.responseText }
      : turn.response;
    turn.responseIndex = turn.response?.index ?? null;
    turn.expanded = false;
  }
  return { turns, prelude, responseCount: turns.length, merged };
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

// The `turns` lens narrows the atomic log to the rows the overview shows: the
// response each turn prints, plus any event the provider tagged with its own
// turn id. A streamed chunk is part of a turn's text, never a turn of its own.
function visibleEventIndices(events, filter, turnResponseIndices, merged = new Set()) {
  return events
    .filter((event) => {
      if (filter === 'errors') return eventIsError(event);
      if (filter === 'tools') return eventIsTool(event) && !merged.has(event.index);
      if (filter === 'turns') return turnResponseIndices.has(event.index) || validId(event?.turnId) != null;
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
  pool = null,
  filter = 'all',
  follow = true,
  selectedIndex = null,
  nowMs = Date.now(),
  view = 'overview',
  expandedTurn = null,
  running = false,
} = {}) {
  const normalizedFilter = normalizeFilter(filter);
  const events = withToolKinds(parsed.events ?? [], pool);
  const pairs = pairActivityEvents(events);
  const grouped = groupActivityTurns(events, { pairs });
  const turnResponseIndices = new Set(
    grouped.turns.map((turn) => turn.responseIndex).filter((index) => index != null),
  );
  const merged = grouped.merged;
  const visible = visibleEventIndices(events, normalizedFilter, turnResponseIndices, merged);
  const selected = selectedIndex != null && visible.includes(Number(selectedIndex))
    ? Number(selectedIndex)
    : follow ? visible.at(-1) ?? null : null;
  const filterCounts = {
    all: events.length,
    turns: visibleEventIndices(events, 'turns', turnResponseIndices).length,
    tools: events.filter((event) => eventIsTool(event) && !merged.has(event.index)).length,
    errors: events.filter(eventIsError).length,
  };
  const minimap = minimapFor(events, selected, visible);
  const parsedExpanded = expandedTurn == null || expandedTurn === '' ? null : Number(expandedTurn);
  const namedExpanded = grouped.turns.findIndex((turn) => turn.id === String(expandedTurn));
  // Follow keeps the live turn open so a long-running command is visible even
  // when no response has arrived to give it a row yet. An explicit turn still
  // wins, and turning follow off lets the caller close the default expansion.
  const selectedTurn = Number.isInteger(parsedExpanded) && parsedExpanded >= 0 && parsedExpanded < grouped.turns.length
    ? parsedExpanded
    : namedExpanded >= 0
      ? namedExpanded
      : running && follow && grouped.turns.length ? grouped.turns.length - 1 : null;
  for (const turn of grouped.turns) turn.expanded = turn.index === selectedTurn;
  const todayEvents = events.filter((event) => sameLocalDay(event.at, nowMs));
  const todayVisible = visibleEventIndices(todayEvents, normalizedFilter, turnResponseIndices, merged);
  const todayEventByIndex = new Map(todayEvents.map((event) => [event.index, event]));
  const visibleDetailEvents = todayVisible
    .map((index) => todayEventByIndex.get(index))
    .filter(Boolean);
  const overviewRows = [];
  if (grouped.prelude.length) {
    const preludeSummary = eventKindSummary(grouped.prelude, pairs, merged);
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
        if (merged.has(event.index)) continue;
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
    mergedCaptures: [...merged],
    toolCallUpdates: [...toolCallUpdates(events)],
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
    rateCards: clone(apiInput?.rateCards ?? (apiInput?.rateCard ? [apiInput.rateCard] : [])),
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
  const subscriptionPools = [];
  const subscriptionPoolByName = new Map();
  for (const record of records) {
    const source = record.subscription ?? {};
    const name = textOrNull(source.pool) ?? 'pool';
    let pool = subscriptionPoolByName.get(name);
    if (!pool) {
      pool = {
        name,
        monthlyPriceUsd: null,
        window: textOrNull(source.window),
        windowDays: finiteOrNull(source.windowDays),
        basis: textOrNull(source.basis) ?? 'unknown:no-meter',
      };
      subscriptionPoolByName.set(name, pool);
      subscriptionPools.push(pool);
    }
    const price = finiteOrNull(source.monthlyPriceUsd);
    if (pool.monthlyPriceUsd == null && price != null) pool.monthlyPriceUsd = price;
  }
  const namedPools = records.map((record) => textOrNull(record.subscription?.pool));
  const sameNamedPool = namedPools.length > 0
    && namedPools.every((name) => name != null && name === namedPools[0]);
  const monthlyPriceUsd = sameNamedPool
    ? finiteOrNull(subscriptionPools.find((pool) => pool.name === namedPools[0])?.monthlyPriceUsd)
    : null;
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
  const rateCards = [];
  const seenRateCards = new Set();
  for (const record of records) {
    for (const card of record.api?.rateCards ?? (record.api?.rateCard ? [record.api.rateCard] : [])) {
      const key = `${textOrNull(card?.source) ?? ''}|${textOrNull(card?.updatedAt) ?? ''}`;
      if (seenRateCards.has(key)) continue;
      seenRateCards.add(key);
      rateCards.push(clone(card));
    }
  }
  const api = {
    usd: apiUsd,
    knownSubtotalUsd: apiKnownSubtotalUsd,
    basis: apiBases.length === 1 && apiUsd != null ? apiBases[0] : apiUsd == null ? 'unknown: incomplete attempts' : 'aggregate',
    breakdown: Object.keys(apiBreakdown).length ? apiBreakdown : null,
    pricedFields: [...new Set(records.flatMap((record) => record.api?.pricedFields ?? []))],
    unpricedFields: [...new Set(records.flatMap((record) => record.api?.unpricedFields ?? []))],
    rateCard: clone(records.find((record) => record.api?.rateCard)?.api.rateCard ?? null),
    rateCards,
  };
  const subscription = {
    pool: textOrNull(firstSubscription?.pool),
    window: textOrNull(firstSubscription?.window),
    deltaPct,
    usd: subscriptionUsd,
    knownSubtotalUsd: subscriptionKnownSubtotalUsd,
    monthlyPriceUsd,
    pools: subscriptionPools,
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
    activity: activityModel(parsed, {
      running: String(raw?.status ?? '').toLowerCase() === 'running',
    }),
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

// ---------------------------------------------------------------------------
// Step page v2 presentation
//
// The blocks below are the design record's own vocabulary: one header said
// once, turn rows with non-zero counts, a result card read from structured
// data only, the task's author prompt beside the kernel wrapper's size, and
// two plain-word cost rows. Every string here is either a captured field or a
// word map over a finite code (a basis, a token source, an event kind); no
// value is parsed out of prose and an unknown stays a dash.
// ---------------------------------------------------------------------------

const MONTH_TEXT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** `49m07s` / `1h02m` / `30s`: the h/m/s clock, no decimals. */
export function stepClockText(ms) {
  if (ms == null || ms === '') return null;
  const value = finiteMs(ms);
  if (value == null) return null;
  const seconds = Math.round(value / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m${String(seconds % 60).padStart(2, '0')}s`;
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, '0')}m`;
}

function stepClockMs(value) {
  const at = dateMs(value);
  if (at == null) return null;
  const date = new Date(at);
  return {
    hh: String(date.getHours()).padStart(2, '0'),
    mm: String(date.getMinutes()).padStart(2, '0'),
    ss: String(date.getSeconds()).padStart(2, '0'),
    day: String(date.getDate()).padStart(2, '0'),
    month: MONTH_TEXT[date.getMonth()],
    year: String(date.getFullYear()),
  };
}

/** `01:50` in local time. */
function stepTimeText(value) {
  const parts = stepClockMs(value);
  return parts ? `${parts.hh}:${parts.mm}` : null;
}

/** `01:51:12` in local time. */
function stepTimeSecText(value) {
  const parts = stepClockMs(value);
  return parts ? `${parts.hh}:${parts.mm}:${parts.ss}` : null;
}

/** `20 Sep`. */
function stepDayText(value) {
  const parts = stepClockMs(value);
  return parts ? `${Number(parts.day)} ${parts.month}` : null;
}

/** `20 Sep 2026`. */
function stepDateText(value) {
  const parts = stepClockMs(value);
  return parts ? `${Number(parts.day)} ${parts.month} ${parts.year}` : null;
}

/** `2.4 KB`: one decimal, the way the kernel states an artifact's size. */
function stepBytesText(bytes) {
  const value = finiteOrNull(bytes);
  if (value == null || value < 0) return null;
  return `${(value / 1000).toFixed(1)} KB`;
}

/** `36.0M` / `713k` / `36`: a token class as the design prints it. */
function stepTokenText(value) {
  const tokens = finiteOrNull(value);
  if (tokens == null || tokens < 0) return null;
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k`;
  return String(Math.round(tokens));
}

/** `$0.96` measured, `≈ $0.25` estimated, `—` unknown. */
function stepMoneyText(usd, { estimated = false } = {}) {
  const value = finiteOrNull(usd);
  if (value == null) return '—';
  const text = formatMoney(value);
  if (text === '-') return '—';
  return estimated ? `≈ ${text}` : text;
}

// The one phrase a row prints for its measurement basis. Both word maps are
// closed over the finite codes in usage-basis.js: a code the map does not know
// prints itself, so a new basis is visible rather than silently blank.
function rateCardVendor(rateCard) {
  const source = String(rateCard?.source ?? '');
  if (/openai/i.test(source)) return 'OpenAI';
  if (/anthropic|claude/i.test(source)) return 'Anthropic';
  if (/(^|\.)x\.ai|xai|grok/i.test(source)) return 'xAI';
  if (/google|gemini/i.test(source)) return 'Google';
  return null;
}

function apiBasisWords(basis, rateCard, pool, { short = false, includeDate = true } = {}) {
  const code = textOrNull(basis) ?? 'unknown';
  const vendor = rateCardVendor(rateCard) ?? textOrNull(pool) ?? 'model';
  const dated = includeDate && rateCard ? stepDayText(rateCard.updatedAt) : null;
  const card = short
    ? `${vendor} card${dated ? ` ${dated}` : ''}`
    : dated ? `${vendor} rate card, ${dated}` : `${vendor} rate card`;
  if (code === 'rate-card:complete' || code === 'rate-card:partial') {
    return code === 'rate-card:partial' ? `${card}${short ? '' : ' (partial)'}` : card;
  }
  if (code === 'provider-reported') return 'provider-reported';
  if (code === 'legacy') return 'legacy estimate';
  if (code === 'aggregate') return 'summed across attempts';
  if (code === 'unknown') return 'no recorded rate';
  // An `unknown: <why>` code is the kernel's own reason; print it as a phrase.
  const reason = code.replace(/^unknown:\s*/, '').trim();
  if (reason === code) return code;
  return /^no\b/i.test(reason) ? reason : `no ${reason}`;
}

function subscriptionBasisWords(basis, pool, { short = false } = {}) {
  const code = textOrNull(basis) ?? 'unknown';
  const name = textOrNull(pool) ?? 'pool';
  if (code === 'unknown:no-meter') return short ? 'no meter reading' : 'no meter reading for this attempt';
  if (code === 'unknown:no-price') return short ? 'no plan price' : 'no plan price recorded';
  if (code === 'unknown:no-cost') return short ? 'no API cost' : 'no API cost to price';
  if (code === 'unknown:below-resolution') return short ? 'below meter resolution' : 'below the meter resolution';
  if (code === 'observed:meter-delta') return `measured from the ${name} meter`;
  if (code === 'observed:meter-ledger') return `measured from the ${name} meter ledger`;
  if (code === 'calibrated:usd-per-pct') return `calibrated from the ${name} meter`;
  if (code === 'provider-reported') return 'provider-reported';
  if (code === 'aggregate') return 'summed across attempts';
  if (code === 'unknown') return 'no meter reading';
  return code;
}

function subscriptionWindowWords(window, windowDays, { short = false } = {}) {
  const code = textOrNull(window);
  if (!code) {
    const days = finiteOrNull(windowDays);
    return days == null ? null : `${days}-day${short ? '' : ' window'}`;
  }
  if (code === 'weekly') return short ? 'weekly' : 'weekly window';
  if (code === 'monthly') return short ? 'monthly' : 'monthly window';
  if (code === '5h') return short ? '5h' : '5-hour window';
  return short ? code : `${code} window`;
}

// The token source says who measured the tokens; that is the sentence's own
// subject, so the map is over the finite codes in usage-basis.js.
function tokenSourceNoun(tokenSource, pool) {
  const code = textOrNull(tokenSource) ?? 'unknown';
  const name = textOrNull(pool) ?? 'provider';
  if (code === 'transcript-summed') return `${name} transcript`;
  if (code === 'provider-reported') return `${name} provider report`;
  if (code === 'estimated:utf8-bytes/4') return `${name} output bytes`;
  if (code === 'mixed') return 'recorded attempts';
  return null;
}

const TOOL_CATEGORIES = new Set(['command', 'read', 'search', 'edit']);

/** The distinct kinds behind a turn's `other tools` count, in capture order. */
function otherToolKindNames(atomicEvents, allPairs = null, merged = null) {
  const eventIndexes = new Set((atomicEvents ?? []).map((event) => event?.index));
  const pairs = allPairs ?? pairActivityEvents(atomicEvents);
  const pairedCompletions = new Set(pairs
    .filter((pair) => eventIndexes.has(pair.completeIndex))
    .map((pair) => pair.completeIndex));
  const names = [];
  for (const event of atomicEvents ?? []) {
    const kind = String(event.kind ?? '').trim().toLowerCase();
    if (eventIsResponse(event) || ENVELOPE_KINDS.has(kind) || TOOL_RESULT_KINDS.has(kind) || eventIsUnnamedCapture(event)) continue;
    if (merged?.has(event.index)) continue;
    // A completion is already represented by the paired call in the count;
    // it must not introduce a second, uncategorised display name.
    if (pairedCompletions.has(event.index)) continue;
    if (TOOL_CATEGORIES.has(toolKindCategory(event))) continue;
    const name = textOrNull(event?.kind);
    if (name && !names.includes(name)) names.push(name);
  }
  return names;
}

/**
 * The counts a turn row prints: only the non-zero classes, in the design's
 * order, pluralised, and with a lone `other tools` kind named. Zero segments
 * never print and an empty turn says `no tools`.
 */
export function turnCountsText(summary, { otherKinds = [] } = {}) {
  const parts = [];
  const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;
  if (summary?.commands) parts.push(plural(summary.commands, 'command'));
  if (summary?.filesRead) parts.push(`${plural(summary.filesRead, 'file')} read`);
  if (summary?.searches) parts.push(`${summary.searches} ${summary.searches === 1 ? 'search' : 'searches'}`);
  if (summary?.edits) parts.push(plural(summary.edits, 'edit'));
  if (summary?.otherTools) {
    parts.push(otherKinds.length === 1
      ? `${summary.otherTools} ${otherKinds[0]}`
      : plural(summary.otherTools, 'other tool'));
  }
  if (summary?.errors) parts.push(plural(summary.errors, 'error'));
  return parts.length ? parts.join(' · ') : 'no tools';
}

function collapseMarkdownLinks(line) {
  return String(line ?? '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
}

const BULLET = /^(?:[-*+]|\d+[.)])\s+/;
const HEADING = /^#{1,6}\s*/;

/**
 * The report's first lines as the result card prints them: markdown links
 * collapse to their label, the first item of a list joins the line that
 * introduced it (the kernel's own "Files added:" + bullet shape), and blank
 * lines and heading or bullet markers drop out. Nothing is rewritten beyond
 * that.
 */
export function reportLeadLines(text, limit = 3) {
  const lines = [];
  let joined = false;
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const bullet = BULLET.test(trimmed);
    const body = collapseMarkdownLinks(trimmed.replace(HEADING, '').replace(BULLET, '')).replace(/\s+/g, ' ').trim();
    if (!body) continue;
    if (bullet && lines.length && !joined) {
      lines[lines.length - 1] = `${lines[lines.length - 1]} ${body}`;
      joined = true;
    } else {
      lines.push(body);
      joined = false;
    }
    if (lines.length >= limit) break;
  }
  return lines;
}

/** `src/workflow/step-model.js | +992 lines (new)` -> the path. */
export function diffChangedPaths(text) {
  return String(text ?? '')
    .split(/\r?\n/)
    .map((line) => line.split(' | ')[0].trim())
    .filter((line) => line && !line.startsWith('diff '));
}

/**
 * What a step asked the integrator to carry. Only a report that carries the
 * kernel prompt's "Shared-file requests" heading has anything to show.
 */
export function sharedFileRequests(text, limit = 3) {
  const lines = String(text ?? '').split(/\r?\n/);
  const at = lines.findIndex((line) => /^#{1,6}\s*shared-file requests\s*$/i.test(line.trim()));
  if (at < 0) return [];
  const body = [];
  for (const line of lines.slice(at + 1)) {
    if (/^#{1,6}\s/.test(line.trim())) break;
    body.push(line);
  }
  return reportLeadLines(body.join('\n'), limit);
}

function shortHomePath(path, homeDir) {
  const value = textOrNull(path);
  if (!value) return null;
  if (homeDir && value.startsWith(homeDir)) return `~${value.slice(homeDir.length)}`;
  return value;
}

/** The route sentence, with the picked pool named beside the ones it beat. */
function routeSentence(routeReason, candidates) {
  const reason = textOrNull(routeReason);
  if (!reason) return null;
  const head = reason.split(/,\s*forecast\b/)[0].trim();
  const others = (candidates ?? []).slice(1).map((candidate) => textOrNull(candidate?.pool)).filter(Boolean);
  const picked = others.length ? ` · picked over ${others.join(', ')}` : '';
  // A trailing comma left by the trimmed forecast clause is the only edit.
  return `${head.replace(/,\s*$/, '')}${picked}`;
}

function attemptCountText(attempts, selected) {
  const total = attempts?.length ?? 0;
  const ordinal = finiteOrNull(selected?.ordinal) ?? (total ? 1 : null);
  if (ordinal == null) return null;
  return total > 1 ? `attempt ${ordinal} of ${total}` : `attempt ${ordinal} of ${total || 1}`;
}

function verificationSummary(requirements) {
  const list = Array.isArray(requirements) ? requirements : [];
  const passed = list.filter((entry) => entry?.status === 'passed').length;
  return { total: list.length, passed, complete: list.length > 0 && passed === list.length };
}

/**
 * The command a worker meant to run. Codex captures a shell invocation as
 * `/bin/zsh -lc "…"`; the design prints the command itself, so the outer
 * wrapper a connector adds around its own spawn is unwrapped and nothing else
 * is touched. Prose is never rewritten — this is the captured summary field.
 */
export function toolSummaryText(kind, summary) {
  const value = textOrNull(summary);
  if (!value) return toolKindWords(kind);
  if (kind !== 'command') return value;
  const match = /^\S*(?:zsh|bash|sh|dash)\s+-l?c\s+([\s\S]*)$/.exec(value);
  if (!match) return value;
  const inner = match[1];
  const quote = inner[0];
  if (quote === '"' || quote === "'") {
    if (inner.endsWith(quote)) return inner.slice(1, -1);
    if (inner.endsWith(`\\${quote}`)) return `${inner.slice(1, -2)}${quote}`;
    // A clipped capture keeps the text it has; its `…` is the provider's own.
    return inner.slice(1);
  }
  return inner;
}

function toolKindWords(kind, category = null) {
  if (category === 'command') return 'command';
  const raw = textOrNull(kind);
  if (!raw) return 'tool';
  return raw.toLowerCase().replace(/[_-]+/g, ' ');
}

function changeKindWords(kind) {
  const raw = textOrNull(kind)?.toLowerCase() ?? '';
  if (raw === 'add' || raw === 'create' || raw === 'created') return 'add';
  if (raw === 'delete' || raw === 'remove' || raw === 'deleted') return 'delete';
  if (raw === 'update' || raw === 'modify' || raw === 'modified' || raw === 'edit') return 'edit';
  return raw.replace(/[_-]+/g, ' ') || 'edit';
}

function changeEntries(value) {
  // Codex `file_change` keeps its complete `changes` array (or the array
  // itself) in `arguments`; Claude's Edit/Write keep a single file path. Any
  // other object (a Bash call's {command, description}) is not a change list,
  // so its keys must never be read as paths.
  const list = Array.isArray(value) ? value : (Array.isArray(value?.changes) ? value.changes : null);
  if (list) {
    return list.map((entry) => {
      if (typeof entry === 'string') return { path: entry, kind: null };
      return entry && typeof entry === 'object' ? entry : null;
    }).filter(Boolean);
  }
  const path = textOrNull(value?.file_path) ?? textOrNull(value?.filePath) ?? textOrNull(value?.path);
  return path ? [{ path, kind: textOrNull(value?.kind) ?? textOrNull(value?.type) }] : [];
}

function changeSummaryText(event) {
  if (toolKindCategory(event) !== 'edit') return null;
  const entries = changeEntries(event?.arguments);
  if (!entries.length) return null;
  const labels = entries.map((entry) => {
    const path = textOrNull(entry.path);
    if (!path) return null;
    return `${changeKindWords(entry.kind)} ${path}`;
  }).filter(Boolean);
  if (!labels.length) return null;
  const shown = labels.slice(0, 3);
  if (labels.length > 3) shown.push(`+${labels.length - 3} more`);
  return shown.join(' · ');
}

export function eventToolSummary(event) {
  const kind = textOrNull(event?.kind);
  const category = toolKindCategory(event);
  const changes = changeSummaryText(event);
  if (changes) return changes;
  const summary = textOrNull(event?.summary)
    ? toolSummaryText(category, event.summary)
    : null;
  if (summary) {
    // An edit whose captured arguments name no change says so in front of its
    // scalar summary, regardless of which connector supplied it.
    if (category === 'edit' && !/^(?:add|edit|delete)\s/.test(summary)) {
      return `edit ${summary}`;
    }
    return summary;
  }
  return toolKindWords(kind, category);
}

function truncateCells(value, limit = 40) {
  const text = String(value ?? '');
  const chars = [...text];
  return chars.length > limit ? `${chars.slice(0, Math.max(0, limit - 1)).join('')}…` : text;
}

function runningAgeText(durationMs) {
  const value = finiteMs(durationMs);
  if (value == null || value < 1000) return null;
  const seconds = Math.floor(value / 1000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m`;
}

/**
 * One row per operation, not per capture: a started/completed pair is the
 * command it ran, with the duration the pair measured. A capture whose partner
 * never arrived still prints, on its own. `eventIndices` names every captured
 * event the row stands for, so the detail view can open all of their fields.
 */
function toolRowsOf(events, {
  pairByStart, paired, byIndex = new Map(), inFlight = [], merged = new Set(), updatesOf = new Map(),
}) {
  return events
    .filter((event) => !eventIsResponse(event) && !ENVELOPE_KINDS.has(String(event.kind ?? '').trim().toLowerCase()))
    .filter((event) => !merged.has(event.index))
    .map((event) => {
      const pair = pairByStart.get(event.index) ?? null;
      if (!pair && paired.has(event.index)) return null;
      const inFlightTool = inFlight.find((tool) => tool.event.index === event.index) ?? null;
      const durationMs = inFlightTool?.durationMs ?? pair?.durationMs ?? event.durationMs ?? null;
      return {
        index: event.index,
        eventIndices: [event.index, ...(updatesOf.get(event.index) ?? []), ...(pair ? [pair.completeIndex] : [])],
        clock: stepTimeSecText(event.at),
        kind: textOrNull(event.kind),
        category: toolKindCategory(event) ?? 'other',
        command: toolKindCategory(event) === 'command',
        error: eventIsError(event) || Boolean(pair && byIndex.has(pair.completeIndex) && eventIsError(byIndex.get(pair.completeIndex))),
        text: inFlightTool?.text ?? eventToolSummary(event),
        startedAt: inFlightTool ? (event.providerAt ?? event.at ?? null) : null,
        durationMs,
        durationText: durationMs != null && durationMs >= 1000 ? stepClockText(durationMs) : null,
        inFlight: Boolean(inFlightTool),
      };
    })
    .filter(Boolean)
    .sort((a, b) => Number(a.inFlight) - Number(b.inFlight) || a.index - b.index);
}

/** The captured events a row of no tool stands for: envelopes, and a turn's response. */
function envelopeIndices(events) {
  return events
    .filter((event) => ENVELOPE_KINDS.has(String(event.kind ?? '').trim().toLowerCase()))
    .map((event) => event.index);
}

function stepTurns(activity, { outText = null, expandedTurn = null, nowMs = Date.now(), allTools = false } = {}) {
  const turns = activity?.turns ?? [];
  const last = turns.at(-1) ?? null;
  const reportEquality = last && outText != null
    ? String(last.responseText ?? '').trim() === String(outText).trim()
    : false;
  const pairs = activity?.pairs ?? [];
  const pairByStart = new Map(pairs.map((pair) => [pair.startIndex, pair]));
  const byIndex = new Map((activity?.events ?? []).map((event) => [event.index, event]));
  const paired = new Set();
  for (const pair of pairs) {
    paired.add(pair.startIndex);
    paired.add(pair.completeIndex);
  }
  const merged = new Set(activity?.mergedCaptures ?? []);
  const updatesOf = callUpdatesByCall(activity?.toolCallUpdates);
  return turns.map((turn) => {
    const baseCountsText = turnCountsText(turn.summary, { otherKinds: otherToolKindNames(turn.atomicEvents, pairs, merged) });
    const isLast = turn === last;
    const resultMarked = Boolean(isLast && reportEquality);
    const expanded = expandedTurn != null && turn.index === expandedTurn;
    const inFlightEvents = turn.atomicEvents.filter((event) => (
      !eventIsResponse(event)
      && !ENVELOPE_KINDS.has(String(event.kind ?? '').trim().toLowerCase())
      && isInFlightStart(event)
      && !pairByStart.has(event.index)
      && !merged.has(event.index)
      && toolKindCategory(event) != null
    ));
    const inFlight = inFlightEvents.map((event) => {
      const started = dateMs(event.providerAt ?? event.at);
      const durationMs = started == null || !Number.isFinite(nowMs) ? null : Math.max(0, nowMs - started);
      return {
        event,
        durationMs,
        durationText: durationMs != null && durationMs >= 1000 ? stepClockText(durationMs) : null,
        countDurationText: runningAgeText(durationMs),
        text: eventToolSummary(event),
      };
    });
    const runningTail = inFlight.length
      ? inFlight.map((tool) => `running: ${truncateCells(tool.text)}${tool.countDurationText ? ` ${tool.countDurationText}` : ''}`).join(' · ')
      : null;
    const countsText = runningTail ? `${baseCountsText} · ${runningTail}` : baseCountsText;
    return {
      index: turn.index,
      number: turn.index + 1,
      clock: stepTimeText(turn.response?.at ?? turn.responseEvent?.at),
      text: textOrNull(turn.responseText) ?? 'response summary unavailable',
      countsText,
      resultMarked,
      expanded,
      // The overview lists the rows of the one open turn; the detail view is
      // the transcript, so every turn carries its rows there.
      toolRows: expanded || allTools ? toolRowsOf(turn.atomicEvents, {
        pairByStart, paired, byIndex, inFlight, merged, updatesOf,
      }) : [],
      // The response (its closing event and every streamed chunk) and the
      // envelope captures (usage, result) belong to the turn head.
      headEventIndices: [
        ...(turn.eventIndices ?? []).filter((index) => !turn.atomicEvents.some((event) => event.index === index)),
        ...envelopeIndices(turn.atomicEvents),
        ...unlinkedCaptures(turn.atomicEvents, merged, updatesOf),
      ],
      otherKinds: otherToolKindNames(turn.atomicEvents, pairs, merged),
      atomicCount: turn.atomicEvents.length,
      summary: turn.summary,
      summaryText: turn.summaryText,
      responseIndex: turn.responseIndex,
    };
  });
}

/**
 * Captures before the first response belong to no turn. The transcript still
 * shows them, one row per tool, so no captured event is out of reach.
 */
function preludeRows(activity) {
  const events = activity?.prelude ?? [];
  if (!events.length) return null;
  const pairs = activity?.pairs ?? [];
  const pairByStart = new Map(pairs.map((pair) => [pair.startIndex, pair]));
  const paired = new Set(pairs.flatMap((pair) => [pair.startIndex, pair.completeIndex]));
  const merged = new Set(activity?.mergedCaptures ?? []);
  const updatesOf = callUpdatesByCall(activity?.toolCallUpdates);
  return {
    index: events[0].index,
    clock: stepTimeText(events[0].at),
    countsText: turnCountsText(eventKindSummary(events, pairs, merged), { otherKinds: otherToolKindNames(events, pairs, merged) }),
    toolRows: toolRowsOf(events, {
      pairByStart,
      paired,
      byIndex: new Map((activity?.events ?? []).map((event) => [event.index, event])),
      merged,
      updatesOf,
    }),
    headEventIndices: [...envelopeIndices(events), ...unlinkedCaptures(events, merged, updatesOf)],
  };
}

function stepPresentation({
  identity, verdict, action, selected, attempts, runDir, homeDir, activity, route,
  duration, meta, money, prompt, promptPath, outText, outFile, streamFile, diffFile,
  diffText, resultPath, requirements, nowMs, follow,
} = {}) {
  const execution = verdict?.execution ?? {};
  const running = execution.status === 'running';
  const verification = verificationSummary(requirements);
  const attemptText = attemptCountText(attempts, selected);
  const startMs = dateMs(selected?.startedAt ?? action?.startedAt);
  const finishMs = dateMs(selected?.finishedAt ?? selected?.endedAt);
  const lastEvent = activity?.events?.at(-1) ?? null;
  const lastEventMs = dateMs(lastEvent?.at);
  const presentedTurns = stepTurns(activity, {
    outText,
    expandedTurn: activity?.expandedTurn ?? null,
    nowMs,
    allTools: activity?.view === 'detail',
  });
  const runningCommand = running
    ? presentedTurns.flatMap((turn) => turn.toolRows ?? []).findLast((tool) => tool?.inFlight && tool?.command)
    : null;
  const nowValue = finiteOrNull(nowMs);
  const verdictText = verification.total
    ? `${verification.complete ? 'verified by the workflow' : 'not verified'} (${verification.passed}/${verification.total} requirements)`
    : identity?.verified === true ? 'verified' : identity?.verified === false ? 'not verified' : null;
  // Rule 2: one clock, and the span appears only when it differs from the
  // active time. `49m07s active of 1h02m` is the only shape that says both.
  const activeText = stepClockText(duration?.activeMs);
  const spanText = finiteOrNull(duration?.spanMs) != null && finiteOrNull(duration?.spanMs) !== finiteOrNull(duration?.activeMs)
    ? stepClockText(duration.spanMs)
    : null;
  return {
    header: {
      // The verdict of line 1 as a state; the view picks the glyph the terminal
      // can actually draw (a shell in ascii mode has no `●` or `✓`).
      state: execution.succeeded ? 'ok' : execution.terminal ? 'fail' : 'running',
      actionId: identity?.actionId ?? null,
      shortId: identity?.shortId ?? null,
      status: execution.status ?? 'unknown',
      succeeded: execution.succeeded === true,
      running,
      verdictText,
      attemptText,
      purpose: identity?.purpose ?? null,
      pool: meta?.pool ?? null,
      model: meta?.model ?? null,
      effort: meta?.effort ?? null,
      reasoning: meta?.reasoning ?? null,
      activeText,
      spanText,
      clockText: spanText ? `${activeText} active of ${spanText}` : activeText,
      startedClock: stepTimeText(startMs),
      finishedClock: stepTimeText(finishMs),
      dateText: stepDateText(finishMs ?? startMs),
      lastEventClock: stepTimeSecText(lastEventMs),
      // A raw instant, not a rendered age: "3s ago" is a fact about the screen
      // that draws it, so the view derives it from its own clock.
      lastEventMs,
      turnNumber: activity?.turns?.length ?? 0,
      following: Boolean(follow),
      route: routeSentence(route?.reason, route?.candidates),
      // The soft time box: `returned early · 2 not done` when the attempt's
      // report listed unfinished items, and `box 20m · ran 34m` once it ran
      // past its box (`box 20m` otherwise). Null when the attempt had none.
      earlyText: returnedEarlyText(selected),
      notDoneItems: returnedEarlyItems(selected),
      boxText: timeBoxText(selected, { durationMs: selected?.durationMs }),
    },
    activity: {
      available: Boolean(activity?.available),
      reason: activity?.reason ?? null,
      events: activity?.events?.length ?? 0,
      turns: presentedTurns,
      prelude: preludeRows(activity),
      totals: activityTotals(activity?.turns ?? []),
      filter: activity?.filter ?? 'all',
      running,
      following: Boolean(follow),
      runningCommand: runningCommand ? {
        text: runningCommand.text,
        startedAt: runningCommand.startedAt,
      } : null,
    },
    result: {
      running,
      title: execution.status ?? 'unknown',
      verification,
      verdictText,
      attemptNumber: finiteOrNull(selected?.ordinal),
      failure: textOrNull(selected?.failureReason),
      events: activity?.events?.length ?? 0,
      lastResponse: (() => {
        const last = activity?.turns?.at(-1) ?? null;
        const text = textOrNull(last?.responseText);
        return text ? { clock: stepTimeText(last.response?.at ?? last.responseEvent?.at), text } : null;
      })(),
      verdictText,
      reportLines: reportLeadLines(outText),
      changed: diffChangedPaths(diffText),
      asks: sharedFileRequests(outText),
      runDir: shortHomePath(runDir, homeDir),
      runDirShort: runDir ? basename(runDir) : null,
      artifacts: {
        task: shortHomePath(promptPath, homeDir),
        output: shortHomePath(outFile, homeDir),
        stream: shortHomePath(streamFile, homeDir),
        diff: shortHomePath(diffFile, homeDir),
        result: shortHomePath(resultPath, homeDir),
      },
      fullPaths: {
        task: promptPath ?? null,
        output: outFile ?? null,
        stream: streamFile ?? null,
        diff: diffFile ?? null,
        result: resultPath ?? null,
      },
      reportBytesText: stepBytesText(typeof outText === 'string' ? Buffer.byteLength(outText, 'utf8') : null),
      streamEvents: activity?.events?.length ?? 0,
    },
    task: {
      kind: textOrNull(action?.kind),
      // Only a step that stores a role carries the field, so kind-only
      // presentations stay byte-identical.
      ...(textOrNull(action?.role) ? { role: textOrNull(action.role) } : {}),
      lane: textOrNull(action?.lane),
      promptLines: String(prompt ?? '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(0, 3),
      owns: basenames(action?.ownedFiles),
      after: (Array.isArray(action?.dependsOn) ? action.dependsOn : []).map((id) => textOrNull(id)).filter(Boolean),
      affects: (Array.isArray(action?.affects) ? action.affects : []).map((id) => requirementWords(id)).filter(Boolean),
      bytes: selected?.bytes && typeof selected.bytes === 'object' ? clone(selected.bytes) : null,
    },
    cost: costRows(money, { running, attempts, selected }),
  };
}

function basenames(list) {
  return (Array.isArray(list) ? list : []).map((entry) => textOrNull(entry)).filter(Boolean).map((entry) => basename(entry));
}

function requirementWords(id) {
  const value = textOrNull(id);
  if (!value) return null;
  return value.replace(/^requirement[-_ ]?(\d+)$/i, 'requirement $1');
}

function activityTotals(turns) {
  const totals = { commands: 0, filesRead: 0, searches: 0, edits: 0, otherTools: 0, errors: 0 };
  for (const turn of turns) {
    for (const field of Object.keys(totals)) totals[field] += finiteOrNull(turn?.summary?.[field]) ?? 0;
  }
  return totals;
}

/**
 * An exact amount prints plain. A rate card without every field priced, a
 * transcript sum, or a byte estimate is not the provider's own bill, so it
 * carries `≈`; an amount nobody recorded stays a dash with the reason.
 */
function apiAmountIsExact(api, tokenSource) {
  const basis = textOrNull(api?.basis) ?? '';
  if (basis === 'rate-card:complete') return true;
  if (basis === 'provider-reported' || tokenSource === 'provider-reported') return true;
  return false;
}

function monthlyPriceText(value) {
  const price = finiteOrNull(value);
  return price == null ? '—' : `$${Number(price.toFixed(2))}/mo`;
}

function usageRecordsForAttempts(attempts) {
  return (Array.isArray(attempts) ? attempts : [])
    .map((attempt) => attempt?.usageModel)
    .filter(Boolean);
}

/** The dated rate-card vendors represented by every recorded attempt. */
function aggregateRateCardWords(api, attempts) {
  const records = usageRecordsForAttempts(attempts);
  const cards = [];
  const seen = new Set();
  for (const record of records) {
    const card = record.api?.rateCard;
    if (!card) continue;
    const vendor = rateCardVendor(card) ?? textOrNull(record.subscription?.pool) ?? 'model';
    const key = `${vendor}|${textOrNull(card.source) ?? ''}|${textOrNull(card.updatedAt) ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    cards.push({ card, vendor });
  }
  if (!cards.length) return apiBasisWords(api.basis, api.rateCard, null);
  const vendors = [...new Set(cards.map((entry) => entry.vendor))];
  const latest = cards
    .map((entry) => dateMs(entry.card.updatedAt))
    .filter((value) => value != null)
    .sort((a, b) => b - a)[0];
  const noun = vendors.length === 1 ? 'rate card' : 'rate cards';
  return `${vendors.join(' + ')} ${noun}${latest == null ? '' : `, ${stepDayText(latest)}`}`;
}

function poolPriceWords(subscription) {
  const pools = Array.isArray(subscription?.pools) ? subscription.pools : [];
  if (!pools.length) return null;
  return pools.map((pool) => `${pool.name ?? 'pool'} ${monthlyPriceText(pool.monthlyPriceUsd)}`).join(' · ');
}

function selectedAttemptShare(selected) {
  const usage = selected?.usageModel;
  if (!usage) return null;
  const api = usage.api ?? {};
  const amount = stepMoneyText(api.usd, { estimated: !apiAmountIsExact(api, usage.tokenSource) });
  const total = finiteOrNull(usage.tokens?.totalKnown);
  const tokens = total == null
    ? null
    : total >= 1_000_000
      ? `${(total / 1_000_000).toFixed(2).replace(/0+$/, '').replace(/\.$/, '')}M`
      : stepTokenText(total);
  const basis = apiBasisWords(api.basis, api.rateCard, usage.subscription?.pool, { includeDate: false });
  return `this attempt ${amount}${tokens ? ` · ${tokens} tokens` : ''}${basis ? ` · ${basis}` : ''}`;
}

function costRows(moneyInput, { running = false, attempts = [], selected = null } = {}) {
  const money = moneyInput?.pair ?? {};
  const api = money.api ?? {};
  const subscription = money.subscription ?? {};
  const tokens = moneyInput?.tokens ?? money.tokens ?? {};
  const tokenSource = textOrNull(moneyInput?.tokenSource ?? money.tokenSource);
  const attemptRecords = usageRecordsForAttempts(attempts);
  const attemptCount = Array.isArray(attempts) && attempts.length
    ? attempts.length
    : finiteOrNull(moneyInput?.attemptCount) ?? 1;
  const poolKeys = [...new Set(attemptRecords.map((record) => textOrNull(record.subscription?.pool) ?? 'pool'))];
  const multiplePools = attemptCount > 1 && poolKeys.length > 1;
  const pending = Boolean(moneyInput?.pending) && (api.usd == null || tokens.totalKnown == null);
  const pool = textOrNull(subscription.pool ?? moneyInput?.pool);
  const totalText = stepTokenText(tokens.totalKnown);
  const apiBasis = attemptCount > 1
    ? aggregateRateCardWords(api, attempts)
    : apiBasisWords(api.basis, api.rateCard, pool);
  const headline = [
    totalText ? `${totalText} tokens` : null,
    apiBasis,
  ].filter(Boolean).join(' · ');
  const classes = [
    ['cache read', tokens.cacheRead],
    ['input', tokens.standardRead],
    ['cache write', finiteOrNull(tokens.cacheWrite5m) ?? finiteOrNull(tokens.cacheWrite1h) ?? finiteOrNull(tokens.cacheWrite)],
    ['output', tokens.output],
    ['reasoning', tokens.reasoning],
  ]
    .filter(([, value]) => finiteOrNull(value) != null && finiteOrNull(value) !== 0)
    .map(([label, value]) => `${stepTokenText(value)} ${label}`);
  const price = finiteOrNull(subscription.monthlyPriceUsd);
  const windowWords = subscriptionWindowWords(subscription.window, subscription.windowDays);
  const poolPrices = multiplePools ? poolPriceWords(subscription) : null;
  const subDetails = [
    price == null ? null : monthlyPriceText(price),
    windowWords,
  ].filter(Boolean);
  const noun = tokenSourceNoun(tokenSource, pool);
  const explicit = finiteOrNull(api.usd);
  const exact = apiAmountIsExact(api, tokenSource);
  const shortBasis = subscriptionBasisWords(subscription.basis, pool, { short: true });
  const shortPlan = [
    price == null ? null : monthlyPriceText(price),
    subscriptionWindowWords(subscription.window, subscription.windowDays, { short: true }),
  ].filter(Boolean).join(' ');
  const selectedShare = attemptCount > 1 ? selectedAttemptShare(selected) : null;
  const apiDetails = selectedShare ? [...classes, selectedShare] : classes;
  const planHeadline = poolPrices ?? subscriptionBasisWords(subscription.basis, pool);
  const planDetails = poolPrices ? [subscriptionBasisWords(subscription.basis, pool), windowWords].filter(Boolean) : subDetails;
  const planPhone = poolPrices
    ? [shortBasis, poolPrices, subscriptionWindowWords(subscription.window, subscription.windowDays, { short: true })].filter(Boolean).join(' · ')
    : [shortBasis, shortPlan || null].filter(Boolean).join(' · ');
  const measuring = running && explicit == null;
  return {
    pending,
    running,
    attemptCount,
    multiplePools,
    rows: [
      {
        label: 'API rate',
        amount: measuring ? '—' : stepMoneyText(explicit, { estimated: !exact }),
        headline: measuring ? 'measured when the attempt finishes' : headline,
        details: measuring ? [] : apiDetails,
        // The phone says the same two facts in one row, with the classes left
        // to the desk layout where they fit.
        phoneText: measuring
          ? 'measured when the attempt finishes'
          : [totalText ? `${totalText} tokens` : null, apiBasisWords(api.basis, api.rateCard, pool, { short: true })].filter(Boolean).join(' · '),
        unknown: explicit == null,
      },
      {
        label: `${multiplePools ? 'plans' : pool ?? 'pool'}${multiplePools ? '' : ' plan'}`,
        amount: stepMoneyText(subscription.usd, { estimated: String(subscription.basis ?? '').startsWith('calibrated') }),
        headline: planHeadline,
        details: planDetails,
        phoneText: planPhone,
        unknown: finiteOrNull(subscription.usd) == null,
      },
    ],
    // Rule 6: the closing line is a word map over the finite tokenSource
    // codes. A live attempt says when the figure will exist instead.
    basisLine: running
      ? `measured when the attempt finishes${noun ? ` (${noun})` : ''}`
      : noun
        ? `${tokenSource === 'estimated:utf8-bytes/4' ? 'estimated from' : 'measured from'} ${noun.startsWith('the ') ? noun : `the ${noun}`}`
        : null,
    tokenSource,
  };
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
  // A live attempt shows what had been captured by `now`: a page drawn at an
  // earlier instant (a projection of a finished record) must not print events
  // that had not happened yet. A terminal attempt keeps its whole capture.
  const parsedStream = selected ? parseAttemptStream(selected.streamFile) : parseAttemptStream(null);
  const liveAttempt = String(selected?.status ?? '').toLowerCase() === 'running';
  const captured = liveAttempt && Number.isFinite(nowMs)
    ? parsedStream.events.filter((event) => {
      const at = dateMs(event.at);
      return at == null || at <= nowMs;
    })
    : parsedStream.events;
  const activity = selected
    ? activityModel({ ...parsedStream, events: captured }, {
      pool: selected?.pool ?? null,
      filter: filter ?? activityFilter,
      follow: followState,
      selectedIndex: selectedEventIndex,
      nowMs,
      view,
      expandedTurn,
      running: liveAttempt,
    })
    : activityModel(parseAttemptStream(null), { nowMs, view, expandedTurn, running: false });
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
  // The result card and the last turn's `→` marker read the report itself, and
  // the diff file is the kernel's own record of what the step changed. Both
  // are resolved inside the run directory, so a copied home stays read-only.
  const promptText = textOrNull(action.prompt) ?? prompt.text ?? textOrNull(state.intent?.goal);
  const outText = safeReadText(outFile) ?? output.text;
  const diffCandidate = selected?.diffFile ?? (runDir && selectedActionId && selected?.ordinal != null
    ? join(runDir, `diff-${selectedActionId}-attempt-${selected.ordinal}.txt`)
    : null);
  const diffPath = resolveExistingPath(diffCandidate, runDir);
  const diffText = safeReadText(diffPath);
  const presentation = stepPresentation({
    identity: {
      actionId: selectedActionId,
      shortId: textOrNull(row.shortId ?? state.shortId),
      purpose: textOrNull(action.purpose ?? action.role),
      verified: verdict.verified,
    },
    verdict,
    action,
    selected,
    attempts: enrichedAttempts,
    runDir,
    homeDir: homedir(),
    activity,
    route,
    duration: { activeMs: activeDurationMs, spanMs: spanDurationMs },
    meta: {
      pool: textOrNull(selected?.pool ?? active?.pool),
      model: textOrNull(selected?.model ?? active?.model),
      effort: textOrNull(selected?.effort ?? selected?.routing?.effort ?? route.effort),
      reasoning: textOrNull(selected?.reasoning?.applied ?? selected?.reasoning?.requested),
    },
    money: {
      pair: totalUsage,
      tokens: totalUsage.tokens,
      tokenSource: totalUsage.tokenSource,
      pending: Boolean(selected?.usagePending),
      pool: textOrNull(selected?.pool ?? active?.pool),
    },
    prompt: promptText,
    promptPath: taskFile,
    outText: outText ?? null,
    outFile,
    streamFile: activity.path,
    diffFile: diffPath,
    diffText,
    resultPath,
    requirements,
    nowMs,
    follow: followState,
  });
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
    // The design record's blocks, said once: one header, turn rows, a result
    // card, the task's own lines, and two plain-word cost rows. The view reads
    // these; every field above stays for the callers that already read it.
    presentation,
    stepHeader: presentation.header,
    resultCard: presentation.result,
    taskCard: presentation.task,
    costCard: presentation.cost,
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
 * The ledger has no workflow result or verification. Stream and usage
 * fields are copied when the record carries them and left unavailable
 * when it does not. The adapter never manufactures an envelope, event,
 * verdict, or effort value.
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
    streamFile: textOrNull(record.streamFile ?? record.eventStream ?? record.streamPath ?? record.stream),
    routing: { lane: textOrNull(record.lane), effort: null },
    usage: null,
  };
  // Keep the adapter from asking the workflow naming convention for a
  // synthetic stream path. Records that predate stream persistence stay
  // streamFile-null and the Step page reports that honestly.
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
