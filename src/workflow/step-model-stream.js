// Reading one attempt's per-attempt JSONL stream: where it lives (the
// explicit path or the kernel's conventional name), and the parse that turns
// each line into a normalised capture-order event without reconstructing any
// field from a neighbouring summary.

import { existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import { finiteOrNull } from '../lib/num.js';
import { safeReadText, resolveExistingPath } from './step-model-files.js';
import { hasOwn, textOrNull, finiteMs } from './step-model-values.js';

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
