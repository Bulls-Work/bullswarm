// Pairing captured events into operations: a started event with its
// completion, and a tool call with the later updates that belong to it, so a
// real operation is counted and shown once.

import {
  validId,
  isStart,
  isComplete,
  TOOL_RESULT_KINDS,
  eventIsUnnamedCapture,
  eventIsResponse,
} from './step-model-events.js';
import { finiteMs, dateMs } from './step-model-values.js';

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

export {
  callUpdatesByCall,
  unlinkedCaptures,
  mergedCaptures,
};
