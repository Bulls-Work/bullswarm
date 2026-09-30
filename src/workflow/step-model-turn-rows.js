// The turn rows the Step page prints: one row per turn with its counts and
// any tool still running, the tool rows of an open turn (one per operation,
// not per capture), and the prelude of captures before the first response.

import { otherToolKindNames, turnCountsText } from './step-model-counts.js';
import {
  isInFlightStart,
  eventIsError,
  eventIsResponse,
  ENVELOPE_KINDS,
} from './step-model-events.js';
import { callUpdatesByCall, unlinkedCaptures } from './step-model-pairs.js';
import { stepClockText, stepTimeText, stepTimeSecText } from './step-model-text.js';
import { toolKindCategory } from './step-model-tool-kinds.js';
import { eventToolSummary } from './step-model-tool-text.js';
import { eventKindSummary } from './step-model-turns.js';
import { textOrNull, finiteMs, dateMs } from './step-model-values.js';

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

export {
  stepTurns,
  preludeRows,
};
