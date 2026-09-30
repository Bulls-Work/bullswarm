// Grouping a capture-order stream into human turns: a completed response
// closes a turn, streamed chunks carry its text, and each turn's summary
// counts the real operations captured while it was open.

import {
  COMPLETE_STATUSES,
  validId,
  eventIsError,
  eventIsResponse,
  ENVELOPE_KINDS,
} from './step-model-events.js';
import { mergedCaptures, pairActivityEvents } from './step-model-pairs.js';
import { toolKindCategory } from './step-model-tool-kinds.js';
import { textOrNull } from './step-model-values.js';

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

export {
  eventKindSummary,
};
