// What one captured event is: started, in flight or complete, a tool call,
// an error, a response, an unnamed capture, or a provider's end-of-run
// envelope. Each test reads only the event's own captured fields.

import { toolKindCategory } from './step-model-tool-kinds.js';
import { hasOwn, textOrNull } from './step-model-values.js';

const START_STATUSES = new Set([
  'started', 'start', 'running', 'pending', 'in_progress', 'in-progress', 'queued',
]);
const COMPLETE_STATUSES = new Set([
  'completed', 'complete', 'succeeded', 'success', 'failed', 'error', 'cancelled',
  'canceled', 'interrupted', 'done',
]);

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

// A provider that reports a tool result as its own event names it `tool`
// (claude-code's tool_result, grok's tool_call_update). A result answers a
// call, so it is never an operation of its own.
const TOOL_RESULT_KINDS = new Set(['tool']);

function eventIsUnnamedCapture(event) {
  return event?.kind === 'agent' && !validId(event?.toolName) && !eventIsResponse(event);
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

// A provider's own end-of-run records: the final result envelope and a usage
// report. They are stream metadata, never a tool call, so they are the only
// captured events a summary counts as nothing.
const ENVELOPE_KINDS = new Set(['result', 'usage']);

export {
  COMPLETE_STATUSES,
  validId,
  isStart,
  isInFlightStart,
  isComplete,
  TOOL_RESULT_KINDS,
  eventIsUnnamedCapture,
  eventHasToolDetails,
  eventIsTool,
  eventIsError,
  eventIsResponse,
  ENVELOPE_KINDS,
};
