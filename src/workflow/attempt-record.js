// One attempt's durable record in state.attempts: the shape the kernel keeps
// (normalizeAttempt), what the worker's exit adds to it (the capture, the
// provider-confirmed session, the `## Not done` items), and the payloads the
// event log and the completion receipt carry for it.

import { readFileSync } from 'node:fs';
import { clone } from '../lib/clone.js';
import { preferredUsage } from './usage-preference.js';
import { parseNotDone } from './time-box.js';

export function normalizeAttempt(record, { id, actionId, ordinal }) {
  return {
    id, actionId, ordinal,
    status: record.status,
    pool: record.pool ?? null,
    model: record.model ?? null,
    startedAt: record.startedAt,
    finishedAt: record.finishedAt ?? null,
    taskFile: record.taskFile ?? null,
    outputFile: record.outFile ?? record.outputFile ?? null,
    failureKind: record.failureKind ?? null,
    why: record.why ?? null,
    // Keep the complete v2 usage envelope exactly as watchOnce produced it:
    // token classes, API-rate basis, subscription snapshots, calibration
    // basis, and the provider session id are all needed by reprice and the
    // result rollups. Do not project it back to the legacy cost aliases here.
    usage: clone(record.usage ?? null),
    ...(record.session !== undefined ? { session: clone(record.session) } : {}),
    wallSec: record.wallSec ?? null,
    routing: clone(record.routing ?? null),
    routeWhy: record.routeWhy ?? null,
    routeCandidates: clone(record.routeCandidates ?? null),
    // The resolved {requested, applied, source, clamped} record, so the TUI
    // and the durable state show the level this attempt actually ran at.
    reasoning: clone(record.reasoning ?? null),
    ...(record.continued !== undefined ? { continued: record.continued } : {}),
    ...(record.lastActivityAt !== undefined ? { lastActivityAt: record.lastActivityAt } : {}),
    ...(record.lastEventAt !== undefined ? { lastEventAt: record.lastEventAt } : {}),
    ...(record.outputBytesObserved !== undefined ? { outputBytesObserved: record.outputBytesObserved } : {}),
    ...(record.stalled !== undefined ? { stalled: record.stalled } : {}),
    ...(record.partialOutput !== undefined ? { partialOutput: record.partialOutput } : {}),
    ...(record.silentSec !== undefined ? { silentSec: record.silentSec } : {}),
    // The dispatch-time byte ledger (see attemptBytes). Only the kernel's
    // 'started' call carries it; a later normalize of the same attempt leaves
    // the recorded object in place instead of erasing it.
    ...(record.bytes !== undefined ? { bytes: clone(record.bytes) } : {}),
    ...(record.lastAgentEvent !== undefined ? { lastAgentEvent: clone(record.lastAgentEvent) } : {}),
    ...(record.notes !== undefined ? { notes: clone(record.notes) } : {}),
    ...(record.outputSamples !== undefined ? { outputSamples: clone(record.outputSamples) } : {}),
    ...(record.outputBytes !== undefined ? { outputBytes: record.outputBytes } : {}),
    ...(record.streamFile !== undefined ? { streamFile: record.streamFile } : {}),
    ...(record.diffFile !== undefined ? { diffFile: record.diffFile } : {}),
    ...(record.changedFileCount !== undefined ? { changedFileCount: record.changedFileCount } : {}),
    ...(Array.isArray(record.changedFiles) ? { changedFiles: [...record.changedFiles] } : {}),
    ...(record.deliverable !== undefined ? { deliverable: clone(record.deliverable) } : {}),
    // The last `response` event the persisted stream recorded, kept so the
    // handoff line names what the worker actually said last rather than
    // whatever event happened to arrive last (`lastAgentEvent` is any kind).
    ...(record.lastResponse !== undefined ? { lastResponse: record.lastResponse } : {}),
    ...(record.handoff !== undefined ? { handoff: clone(record.handoff) } : {}),
    // D3: the attempt the dispatcher started because of an earlier one, and how.
    ...(record.retryOf !== undefined ? { retryOf: clone(record.retryOf) } : {}),
    ...(record.outputTruncated !== undefined ? { outputTruncated: record.outputTruncated } : {}),
    ...(record.outputSource !== undefined ? { outputSource: record.outputSource } : {}),
    // What the provider reported at worker exit (recordAttemptCapture).
    ...(record.capture !== undefined ? { capture: clone(record.capture) } : {}),
    // The soft time box this attempt's task carried, and what its report left
    // under `## Not done` (time-box.js). Neither changes how the attempt ran.
    ...(record.timeBox !== undefined ? { timeBox: clone(record.timeBox) } : {}),
    ...(record.returnedEarly !== undefined ? { returnedEarly: clone(record.returnedEarly) } : {}),
    // What each declared check did (E20). Absent when the checks never ran
    // (E15): absence is the exact fact.
    ...(Array.isArray(record.evidenceResults) ? { evidenceResults: clone(record.evidenceResults) } : {}),
  };
}

// The `attempt.finished` payload key `evidenceOutcome` (§2.8), only when the
// attempt ran its checks.
export function evidenceOutcomePayload(record) {
  const results = Array.isArray(record?.evidenceResults) ? record.evidenceResults : null;
  if (!results) return {};
  const count = (status) => results.filter((item) => item?.status === status).length;
  const failed = count('failed');
  const stopped = results.some((item) => item?.status === 'not-run' && item.why === 'stopped');
  return {
    evidenceOutcome: {
      passed: count('passed'), failed, notRun: count('not-run'),
      why: failed ? record.why ?? null : stopped ? 'evidence stopped' : null,
    },
  };
}

// The completion receipt's verdict. It carries the attempt's check results
// (E31), so reconcileResume can restore them when the kernel dies between the
// receipt and the stored attempt.
export function receiptVerdict(verdict, record) {
  const base = verdict ?? { ok: true, outFile: record.outFile ?? record.outputFile };
  if (!Array.isArray(record.evidenceResults) || Array.isArray(base.evidenceResults)) return base;
  return { ...base, evidenceResults: clone(record.evidenceResults) };
}

// A succeeded work attempt whose report lists items under `## Not done`
// returned early: the step still succeeds, and the items travel with it to
// verify and the pages. Read from the durable out file, never from the stream.
export function recordReturnedEarly(attempt) {
  if (!attempt?.outputFile) return;
  let text;
  try { text = readFileSync(attempt.outputFile, 'utf8'); } catch { return; }
  const early = parseNotDone(text);
  if (early.count > 0) attempt.returnedEarly = early;
  else delete attempt.returnedEarly;
}

// The `captured` dispatch stage: the worker has exited and its stream is
// decoded, but the verdict (meters, transcripts, verification) is still
// being assembled. Record what the provider reported now, once — the first
// capture is immutable — and let the caller persist it. The attempt stays
// running and its usage is not yet added to the run totals; `finished` does
// that exactly once.
export function recordAttemptCapture(attempt, record) {
  if (!attempt || !record?.capture || typeof record.capture !== 'object' || attempt.capture) return false;
  attempt.capture = clone(record.capture);
  if (record.usage) attempt.usage = preferredUsage(attempt.usage ?? null, record.usage);
  const confirmed = attempt.capture.sessionSource === 'provider-stream' ? attempt.capture.providerSessionId : null;
  if (confirmed && attempt.session && typeof attempt.session === 'object') attempt.session.sessionId = confirmed;
  return true;
}

// The `finished` record replaces the attempt's fields; the capture taken at
// worker exit, the session id the provider confirmed in it, and any
// provider-reported usage it carried survive that.
export function settleFinishedAttempt(attempt, prior) {
  if (prior.capture) attempt.capture = prior.capture;
  attempt.usage = preferredUsage(prior.usage ?? null, attempt.usage ?? null);
  const confirmed = prior.capture?.sessionSource === 'provider-stream' ? prior.capture.providerSessionId : null;
  if (confirmed && attempt.session && typeof attempt.session === 'object') attempt.session.sessionId = confirmed;
}
