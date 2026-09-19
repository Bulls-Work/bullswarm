// Width-independent data for the Step page.
//
// A Step combines durable state, one attempt's artifacts, an optional result
// envelope, and an optional per-attempt JSONL stream. Keep those sources
// separate here so the view cannot accidentally manufacture turns, tools,
// duration, usage, cost, or verification from prose.

import { existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';

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
    const local = join(runDir, basename(value));
    if (existsSync(local)) return local;
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
  if (runDir && typeof candidate === 'string' && candidate.trim()) return join(runDir, basename(candidate.trim()));
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
  const wall = finiteOrNull(attempt?.wallSec);
  if (wall != null && wall >= 0) return wall * 1000;
  return durationMs(attempt?.startedAt, attempt?.finishedAt, nowMs);
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

/** Pair only events carrying the same stable tool-call identifier. */
export function pairActivityEvents(events = []) {
  const indexedEvents = events.map((event, index) => (
    event && event.index != null ? event : { ...event, index }
  ));
  const starts = new Map();
  const used = new Set();
  const pairs = [];
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
    const start = indexedEvents.find((candidate) => candidate.index === startIndex);
    const providerDuration = finiteMs(event.durationMs) ?? finiteMs(start?.durationMs);
    const capturedDuration = providerDuration == null
      ? (() => {
        const a = dateMs(start?.providerAt ?? start?.at);
        const b = dateMs(event.providerAt ?? event.at);
        return a != null && b != null && b >= a ? b - a : null;
      })()
      : null;
    pairs.push({
      id: `tool:${id}:${startIndex}`,
      toolCallId: id,
      startIndex,
      completeIndex: event.index,
      durationMs: providerDuration ?? capturedDuration,
      durationSource: providerDuration != null
        ? 'provider'
        : capturedDuration != null && (start?.providerAt != null || event.providerAt != null)
          ? 'provider-time'
          : capturedDuration != null ? 'capture-order' : null,
    });
  }
  return pairs;
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

function normalizeFilter(value) {
  const filter = String(value ?? 'all').toLowerCase();
  return FILTERS.has(filter) ? filter : 'all';
}

function visibleEventIndices(events, filter) {
  return events
    .filter((event) => {
      if (filter === 'errors') return eventIsError(event);
      if (filter === 'tools') return eventIsTool(event);
      if (filter === 'turns') return validId(event?.turnId) != null;
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
    turns: events.filter((event) => validId(event.turnId) != null).length,
    tools: events.filter(eventIsTool).length,
    errors: events.filter(eventIsError).length,
  };
  const minimap = minimapFor(events, selected, visible);
  const turns = [...new Set(events.map((event) => validId(event.turnId)).filter(Boolean))]
    .map((turnId) => ({
      id: turnId,
      eventIndices: events.filter((event) => event.turnId === turnId).map((event) => event.index),
    }));
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
    turns,
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
  const finish = textOrNull(raw?.finishedAt);
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
    })
    : activityModel(parseAttemptStream(null));
  const selectedUsage = selected?.usageModel ?? normalizeAttemptUsage(null);
  const totalUsage = aggregateAttemptUsage(enrichedAttempts);
  const route = routeModel(selected ?? active, action);
  const resultPath = resultRecord.path ?? retainedPath(state.lifecycle?.resultFile, runDir);
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
  const moneyDisplay = totalUsage.display;
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
    selectedEvent: activity.selectedEvent,
    selectedEventDetail: activity.selectedEventDetail,
    // Keep the extraction renderer's arrays at the historical keys while
    // exposing rich objects for the Step feature view.
    outcome: output.lines,
    outcomeModel: outcome,
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

export {
  activityModel,
  minimapFor,
  normalizeTokens,
};
