// What a kernel starting on an existing run repairs first (reconcileResume):
// completion receipts written without their attempt, attempts a dead kernel
// left running (an act step that died in its checks goes to the caller), and
// interrupted steps, which run again.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { invalidateRequirements } from './ledger.js';
import { actionDefinition } from './v2-state.js';
import { V2_TERMINAL_STATUSES } from './status.js';
import { clone } from '../lib/clone.js';
import { attemptArtifactsOnDisk } from './v2-dispatch.js';
import { declaredEvidence, roleOf } from './step-vocabulary.js';
import { evidenceItemTimeoutSec } from './evidence-runner.js';
import { EVIDENCE_RUNNING_NOTE, evidenceRunning } from '../lib/stale.js';
import { clearWaitingFor } from './gates-loops.js';

// An act step's worker has finished before its checks start, so it may
// already have sent, posted or deployed. A stop during the checks never
// queues that worker again (P3): the attempt goes to the caller as
// failed-evidence, and only an explicit plan revise --rerun runs it again.
export function actStoppedDuringChecksWhy(cause) {
  return `${cause} during its checks; the worker had finished and may already have acted, so it runs again only on an explicit plan revise --rerun · act steps are not retried`;
}

// A declared item a dead kernel never recorded an end for.
function stoppedEvidenceEntry(item) {
  const base = item?.type === 'schema'
    ? { type: 'schema', file: item.file, schema: item.schema, ...(item.format ? { format: item.format } : {}) }
    : { type: 'command', cmd: item?.cmd };
  return { ...base, timeoutSec: evidenceItemTimeoutSec(item), status: 'not-run', exit: null, durationMs: 0, tail: '', why: 'stopped' };
}

// The running-checks note (E18, src/lib/stale.js) lives only while the
// attempt runs; a finished or recovered attempt never keeps it.
export function clearEvidenceRunning(attempt) {
  if (!Array.isArray(attempt?.notes)) return;
  const notes = attempt.notes.filter((note) => note?.kind !== EVIDENCE_RUNNING_NOTE);
  if (notes.length) attempt.notes = notes;
  else delete attempt.notes;
}

// Returns the act steps it sent to the caller, `[{ actionId, why }]`, so the
// kernel can emit their action.finished once the event log is open.
export function reconcileResume(state, at, runDir) {
  // The receipt precedes the attempt snapshot. Recover either side of that
  // atomic-write boundary without dispatching successful work a second time.
  // Attempts a plan revision superseded never count as this step's completion.
  const current = (action, attempt) => attempt.actionId === action.id && attempt.ordinal > (action.supersededAttempts ?? 0);
  for (const action of state.actions) if (['running', 'waiting', 'interrupted'].includes(action.status)) {
    const attempt = state.attempts.findLast((item) => current(action, item));
    const path = join(runDir, `completion-${action.id}.json`);
    if (attempt && existsSync(path)) {
      const receipt = JSON.parse(readFileSync(path, 'utf8'));
      if (receipt.attemptId === attempt.id && receipt.verdict?.ok) Object.assign(attempt, {
        status: 'succeeded', finishedAt: receipt.finishedAt ?? at,
        failureKind: null, why: 'recovered durable dispatch completion',
        // The checks passed before the kernel died (E31): the recovered
        // attempt keeps their results, so its label reads what ran.
        ...(Array.isArray(receipt.verdict.evidenceResults) ? { evidenceResults: clone(receipt.verdict.evidenceResults) } : {}),
      });
      if (attempt.status === 'succeeded') clearEvidenceRunning(attempt);
    }
  }
  // Act steps whose kernel died during their checks: they go to the caller.
  const toCaller = new Map();
  for (const attempt of state.attempts) if (attempt.status === 'running') {
    const checking = evidenceRunning(attempt);
    clearEvidenceRunning(attempt);
    const declared = actionDefinition(state, attempt.actionId);
    if (checking && roleOf(declared) === 'act') {
      Object.assign(attempt, {
        status: 'failed', finishedAt: at, failureKind: 'failed-evidence',
        why: actStoppedDuringChecksWhy('the kernel died'),
        evidenceResults: declaredEvidence(declared).map(stoppedEvidenceEntry),
      });
      toCaller.set(attempt.actionId, attempt.why);
    } else {
      attempt.status = 'interrupted';
      attempt.finishedAt = at;
      attempt.failureKind = 'interrupted';
      attempt.why = 'runner stopped before the attempt reached a durable terminal state';
    }
    // The worker may have left partial output, a stream and a diff snapshot
    // on disk before the kernel died; the record should say so, as it would
    // have had the attempt finished normally.
    for (const [field, value] of Object.entries(attemptArtifactsOnDisk(attempt.taskFile, attempt.actionId, attempt.ordinal))) {
      if (attempt[field] == null) attempt[field] = value;
    }
  }
  for (const action of state.actions) if (['running', 'waiting', 'interrupted'].includes(action.status)) {
    if (toCaller.has(action.id)) {
      Object.assign(action, { status: 'failed', finishedAt: at, lastFailure: { kind: 'failed-evidence', message: toCaller.get(action.id) } });
      continue;
    }
    const declared = actionDefinition(state, action.id);
    const completedAttempt = state.attempts.findLast((attempt) => attempt.actionId === action.id && attempt.status === 'succeeded');
    if (!completedAttempt && declared?.affects?.length) {
      const stillFresh = declared.affects.some((id) => state.ledger.requirements[id]?.status === 'passed');
      if (stillFresh) {
        const revision = `resume-${state.program.revision}-${state.events.sequence + 1}-${action.id}`;
        state.ledger = invalidateRequirements(state.ledger, declared.affects, revision);
        action.workRevision = revision;
      }
    }
    action.status = 'pending';
    action.finishedAt = null;
    action.lastFailure = { kind: 'interrupted', message: 'retrying mechanically after durable resume' };
  }
  if (state.planner.status === 'running') state.planner.status = 'pending';
  clearWaitingFor(state); // a parked v3 run (gates-loops.js) runs again
  if (!V2_TERMINAL_STATUSES.has(state.lifecycle.status)) state.lifecycle.status = state.program.actions.length ? 'running' : 'planning';
  return [...toCaller].map(([actionId, why]) => ({ actionId, why }));
}
