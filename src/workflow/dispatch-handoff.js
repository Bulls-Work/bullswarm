// The durable handoff a stopped or failed attempt leaves its next attempt:
// its facts read back from its saved files, written as one block.
import { clone } from '../lib/clone.js';
import { isAbsolute, join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { handoffBlock } from './retry-handoff.js';
import { fileBytes } from './dispatch-attempt-files.js';
import { parseAttemptStream } from './step-model-stream.js';
import { withToolKinds } from './step-model-tool-kinds.js';
import { ENVELOPE_KINDS, eventIsError, eventIsResponse, eventIsTool, eventIsUnnamedCapture } from './step-model-events.js';

export function lastResponseEvents(streamFile, limit = 3) {
  if (!streamFile) return [];
  try {
    const events = [];
    for (const line of readFileSync(streamFile, 'utf8').split('\n')) {
      if (!line) continue;
      let parsed;
      try { parsed = JSON.parse(line); } catch { continue; }
      if (parsed?.truncated === true) continue;
      if (parsed?.kind === 'response') {
        events.push({
          at: parsed.at ?? null,
          kind: 'response',
          summary: parsed.summary ?? parsed.response ?? null,
        });
      }
    }
    return events.slice(-limit);
  } catch {
    return [];
  }
}

// A tool-call record of any name or kind: whatever the Step page lists as a
// tool row (a declared kind or `other`, so a codex mcp_tool_call or any
// Claude Code tool_use counts), less the records that are no call at all: a
// response, an end-of-run envelope, an error, a capture with no name.
function eventIsToolCall(event) {
  if (eventIsTool(event)) return true;
  return !eventIsResponse(event)
    && !ENVELOPE_KINDS.has(String(event?.kind ?? '').trim().toLowerCase())
    && !eventIsError(event)
    && !eventIsUnnamedCapture(event);
}

// Whether an attempt's event stream shows work: any tool-call record.
// true: work seen; false: a readable stream with no tool call; null: the
// stream is missing, unreadable or not structured, so nothing is known.
export function streamShowsWork(streamFile, pool = null) {
  if (!streamFile) return null;
  let parsed;
  try { parsed = parseAttemptStream(streamFile); } catch { return null; }
  // An empty stream file is readable and holds no tool call: both refusals of
  // the incident this rule exists for (a 401, a model not in the plan) left one.
  if (!parsed.available || parsed.plainText) return null;
  if (!parsed.events.length && parsed.parseErrors > 0) return null;
  return withToolKinds(parsed.events, pool).some(eventIsToolCall);
}

function durableArtifactPath(runDir, path) {
  if (!path) return null;
  return isAbsolute(path) || !runDir ? path : join(runDir, path);
}

function durableHandoffFacts(attempt, runDir) {
  if (!attempt || typeof attempt !== 'object') return null;
  const streamFile = durableArtifactPath(runDir, attempt.streamFile);
  const diffFile = durableArtifactPath(runDir, attempt.diffFile);
  const outputFile = durableArtifactPath(runDir, attempt.outputFile ?? attempt.partialOutput);
  const diffStatText = diffFile && existsSync(diffFile)
    ? (() => { try { return readFileSync(diffFile, 'utf8').trimEnd(); } catch { return ''; } })()
    : '';
  const outputBytes = attempt.outputBytes ?? (outputFile ? fileBytes(outputFile) : null);
  const lastEvents = lastResponseEvents(streamFile);
  if (!lastEvents.length && typeof attempt.lastResponse === 'string' && attempt.lastResponse) {
    lastEvents.push({ at: attempt.finishedAt ?? null, kind: 'response', summary: attempt.lastResponse });
  }
  return {
    pool: attempt.pool,
    model: attempt.model,
    startedAt: attempt.startedAt,
    finishedAt: attempt.finishedAt,
    failureKind: attempt.failureKind,
    why: attempt.why,
    diffStatText,
    diffFile,
    changedFiles: Array.isArray(attempt.changedFiles) ? attempt.changedFiles : [],
    outputFile,
    partialOutput: durableArtifactPath(runDir, attempt.partialOutput),
    outputBytes,
    streamFile,
    hasEventStream: Boolean(streamFile && streamFile.endsWith('.jsonl')),
    lastEvents,
    // Only when the attempt ran its checks, so every other handoff stays
    // byte-identical.
    ...(Array.isArray(attempt.evidenceResults) ? { evidenceResults: clone(attempt.evidenceResults) } : {}),
  };
}

export function durableHandoff(attempt, runDir, formatHandoff) {
  const facts = durableHandoffFacts(attempt, runDir);
  if (!facts) return null;
  const block = formatHandoff(facts);
  if (typeof block !== 'string' || !block) return null;
  return {
    block,
    from: attempt.id ?? `${attempt.actionId ?? 'attempt'}-${attempt.ordinal ?? 1}`,
    bytes: Buffer.byteLength(block, 'utf8'),
  };
}

export function durableAttemptHandoff(attempt, runDir, formatHandoff = handoffBlock) {
  return durableHandoff(attempt, runDir, formatHandoff);
}
