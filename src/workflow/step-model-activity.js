// The activity model of one attempt: its events with their tool kinds, the
// turns, the filters and their counts, the minimap, the selected event's
// detail and the overview rows the Step page lists.

import { validId, eventIsTool, eventIsError } from './step-model-events.js';
import { toolCallUpdates, pairActivityEvents } from './step-model-pairs.js';
import { withToolKinds } from './step-model-tool-kinds.js';
import { eventKindSummary, groupActivityTurns } from './step-model-turns.js';
import { dateMs } from './step-model-values.js';

const FILTERS = new Set(['all', 'turns', 'tools', 'errors']);
const VIEWS = new Set(['overview', 'detail']);

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

export {
  VIEWS,
  minimapFor,
  activityModel,
};
