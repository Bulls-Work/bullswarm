// Live control of a run from outside its kernel: plan revise, pause and
// unpause, and reopening a finished run for resume. Revisions and pauses are
// intents written next to the run. A live kernel holds the run's lease and
// picks them up within about a second; when no kernel holds the lease
// (paused, waiting for its caller, interrupted, or finished) the command
// applies the intent itself under that same lease.

import { existsSync, readFileSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { writeJsonAtomic } from '../lib/fsjson.js';
import { appendEvent } from './events.js';
import {
  commitV2Revision, planV2Revision, queueRevisionRequest, rejectedRevisionRecord, removeStaleReceipts,
  revisionEventPayload, acceptedEventPayloads,
} from './v2-revision.js';
import { actionDefinition, deserializeV2DurableState, statePath, writeRunState } from './v2-state.js';
import { V2_TERMINAL_STATUSES } from './status.js';
import { appendRollupIndex, bullswarmDirOfRun, readRollup, rollupPath, rollupRecord } from './rollup.js';
import { v2RetryPlan } from './v2-outcome.js';
import { clearStepRestart, readStepRestarts } from './v2-dispatch.js';
import { roleOf } from './step-vocabulary.js';
import { readRunFeatures, runFeatureFlags } from './run-features.js';
import { clearWaitingFor } from './gates-loops.js';
import { deriveV2LiveStages } from './v2-presentation.js';
import { peekSteering } from './steering.js';
import { isProgramWorkflow } from './execution-policy.js';
import { acquireKernelLease } from './v2-process.js';

// D20: a `step rerun` writes its applied restart intent before it submits the
// revision. When that revision is rejected, the intent must not outlive it:
// delete the step's intent, but only the one that belongs to this request.
export function clearRejectedRerunIntent(runDir, request) {
  if (request?.source !== 'step-rerun' || typeof request.id !== 'string') return;
  const steps = new Set(Array.isArray(request.rerun) ? request.rerun : []);
  for (const entry of readStepRestarts(runDir)) {
    if (entry.source === 'step-rerun' && entry.revisionRequestId === request.id && (!steps.size || steps.has(entry.actionId))) {
      clearStepRestart(runDir, entry.actionId);
    }
  }
}

/**
 * A finished run that is reopened must stop looking finished on disk: the
 * dashboard's fast path treats `rollup.json` as a finished marker and the
 * history index row still says completed, so the reopened run vanished from
 * the running block while its Home card kept the old verdict. Archive the
 * rollup beside the archived result and re-index the run as running.
 */
function reopenRollup(runDir, state, tag) {
  const file = rollupPath(runDir);
  const previous = readRollup(runDir);
  if (existsSync(file)) renameSync(file, join(runDir, `rollup-before-${tag}.json`));
  try {
    appendRollupIndex(bullswarmDirOfRun(runDir), rollupRecord(state, null, {
      project: previous?.project ?? null, cwd: previous?.cwd ?? state?.intent?.cwd ?? null,
    }));
  } catch { /* the index is a cache of state.json; a failed refresh only delays the card */ }
}

const PAUSE_FILE = 'pause.json';

function runDirFor(bullswarmDir, runId) {
  if (typeof bullswarmDir !== 'string' || !bullswarmDir || !/^wf-[a-z0-9]+-[a-f0-9]{6}$/.test(runId ?? '')) {
    throw new TypeError('bullswarmDir and a valid runId are required');
  }
  const runDir = join(bullswarmDir, 'workflows', runId);
  if (!existsSync(statePath(runDir))) throw new Error(`run ${runId} has no durable state`);
  return runDir;
}

function tryRunLease(runDir) {
  try { return acquireKernelLease(runDir); } catch { return null; }
}

function readRunStateLoose(runDir) {
  try { return JSON.parse(readFileSync(statePath(runDir), 'utf8')); } catch { return null; }
}

// An act step whose current attempt a cancellation stopped: its worker had
// started, so it may have acted (D32).
function actStoppedAfterStart(state, runtime) {
  if (roleOf(actionDefinition(state, runtime.id)) !== 'act') return false;
  const last = state.attempts.findLast((attempt) => attempt.actionId === runtime.id && attempt.ordinal > (runtime.supersededAttempts ?? 0));
  return last?.status === 'cancelled';
}

// Apply one revision request to a run no kernel owns. The caller holds the
// lease. A finished run is reopened: its result is archived, cancellation
// cleared, and the new plan runs when the kernel is relaunched.
function commitRevisionUnderLease(runDir, request, { now }) {
  const state = deserializeV2DurableState(readFileSync(statePath(runDir), 'utf8'));
  const existing = (state.revisions ?? []).find((entry) => entry.id === request.id);
  if (existing) return { status: existing.status, record: existing, state, reopened: null };
  const at = now();
  const token = state.shortId ?? state.runId;
  const cancelFile = join(runDir, 'cancellation.json');
  if (!V2_TERMINAL_STATUSES.has(state.lifecycle.status) && existsSync(cancelFile) && JSON.parse(readFileSync(cancelFile, 'utf8'))?.requested) {
    return { status: 'rejected', record: { issues: [`the run has a pending cancellation; finalize it with bullswarm workflow cancel ${token} before revising`] }, state, reopened: null };
  }
  const features = runFeatureFlags(readRunFeatures(runDir));
  const planned = planV2Revision(state, request, { pendingSteeringIds: peekSteering(state, runDir).map((entry) => entry.id), features });
  if (!planned.ok) {
    state.revisions = [...(state.revisions ?? []), rejectedRevisionRecord(request, planned.issues, at)];
    appendEvent(runDir, state, 'program.revision_rejected', { requestId: request.id, issues: planned.issues, source: request.source ?? 'cli' });
    writeRunState(runDir, state);
    clearRejectedRerunIntent(runDir, request);
    return { status: 'rejected', record: state.revisions.at(-1), state, reopened: null };
  }
  const previousStatus = state.lifecycle.status;
  const committed = commitV2Revision(state, planned, { request, runDir, at });
  let reopened = null;
  if (V2_TERMINAL_STATUSES.has(previousStatus)) {
    const resultFile = state.lifecycle.resultFile ?? join(runDir, 'result.json');
    const archived = join(runDir, `result-before-revision-${state.program.revision}.json`);
    const hadResult = existsSync(resultFile);
    if (hadResult) renameSync(resultFile, archived);
    Object.assign(state.lifecycle, { status: 'running', finishedAt: null, resultFile: null });
    reopenRollup(runDir, state, `revision-${state.program.revision}`);
    if (state.cancellation.requested) state.cancellation = { requested: false, requestedAt: null, reason: null };
    rmSync(cancelFile, { force: true });
    if (['completed', 'cancelled', 'failed'].includes(state.planner.status)) state.planner.status = 'waiting';
    // Steps the cancellation stopped were never judged; reopening the run is
    // what lifts that cancellation, so they run again. Their earlier attempts
    // stay on record but never count as this step's completion. Failed steps
    // are left as they are: rerunning them is the caller's decision.
    // F22 (D32, P3): a step rerun, step accept or workflow add never runs
    // again an act step the cancellation stopped after its worker started (it
    // may already have acted): it stays cancelled and is listed to the caller
    // (`keptCancelled`). `plan revise` keeps its saved behaviour.
    const keepStartedActs = ['step-rerun', 'step-accept', 'workflow-add'].includes(request.source);
    const requeued = [];
    const keptCancelled = [];
    for (const action of state.actions) {
      if (action.status !== 'cancelled') continue;
      if (keepStartedActs && actStoppedAfterStart(state, action)) {
        keptCancelled.push(action.id);
        continue;
      }
      Object.assign(action, {
        status: 'pending', startedAt: null, finishedAt: null, outputFile: null, artifactIds: [],
        lastFailure: null, supersededAttempts: action.attempts,
      });
      requeued.push(action.id);
    }
    if (requeued.length) state.presentation.stages = deriveV2LiveStages(state, { revision: state.program.revision, at });
    const kept = keptCancelled.length ? { keptCancelled } : {};
    reopened = { previousStatus, archivedResult: hadResult ? archived : null, requeued, ...kept };
    appendEvent(runDir, state, 'workflow.reopened', { previousStatus, requestId: request.id, archivedResult: reopened.archivedResult, requeued, ...kept });
  }
  // A revision answers a caller-planner pause as fully as a submission does.
  if (state.planner.awaiting) {
    state.planner.awaiting = null;
    state.planner.status = 'waiting';
    if (state.lifecycle.status === 'waiting') state.lifecycle.status = 'running';
  }
  for (const entry of committed.deliveredSteering) {
    appendEvent(runDir, state, 'steering.delivered', { steeringId: entry.id, message: entry.message, decisionSequence: entry.decisionSequence, source: 'revision' });
  }
  appendEvent(runDir, state, 'program.revised', revisionEventPayload(committed.record));
  for (const payload of acceptedEventPayloads(planned)) appendEvent(runDir, state, 'step.accepted', payload);
  writeRunState(runDir, state);
  removeStaleReceipts(runDir, committed.staleReceipts);
  return { status: 'applied', record: committed.record, state, reopened };
}

/**
 * Reopen a finished program run so `workflow resume` runs its unfinished steps
 * again: steps that never ran or were stopped, steps whose failure a retry can
 * fix (no pool, a spent pool, a crashed or silent worker), and the steps
 * blocked behind them. Steps the caller has to change first stay as they are.
 * Resolves {status: reopened | nothing-to-retry | not-finished | live, ...};
 * only `reopened` changes the run.
 */
export function reopenV2RunForRetry({ bullswarmDir, runId, now = () => new Date().toISOString() } = {}) {
  const runDir = runDirFor(bullswarmDir, runId);
  const lease = tryRunLease(runDir);
  if (!lease) return { status: 'live' };
  try {
    const state = deserializeV2DurableState(readFileSync(statePath(runDir), 'utf8'));
    if (!V2_TERMINAL_STATUSES.has(state.lifecycle.status)) return { status: 'not-finished', state };
    const plan = v2RetryPlan(state);
    const steps = isProgramWorkflow(state) ? plan.rerun : [];
    if (!steps.length) return { status: 'nothing-to-retry', state, needsCaller: plan.needsCaller };
    const at = now();
    const previousStatus = state.lifecycle.status;
    const resultFile = state.lifecycle.resultFile ?? join(runDir, 'result.json');
    const earlier = readdirSync(runDir).filter((name) => /^result-before-resume-\d+\.json$/.test(name)).length;
    const archived = join(runDir, `result-before-resume-${earlier + 1}.json`);
    const hadResult = existsSync(resultFile);
    if (hadResult) renameSync(resultFile, archived);
    Object.assign(state.lifecycle, { status: 'running', finishedAt: null, resultFile: null });
    reopenRollup(runDir, state, `resume-${earlier + 1}`);
    if (state.cancellation.requested) state.cancellation = { requested: false, requestedAt: null, reason: null };
    rmSync(join(runDir, 'cancellation.json'), { force: true });
    if (['completed', 'cancelled', 'failed'].includes(state.planner.status)) state.planner.status = 'waiting';
    const requeued = [...plan.rerun, ...plan.blocked];
    const retrying = new Set(requeued);
    for (const action of state.actions) {
      if (!retrying.has(action.id) || action.status === 'pending') continue;
      // Earlier attempts stay on record but never count as this step's
      // completion, and a stale completion receipt cannot replay them.
      Object.assign(action, {
        status: 'pending', startedAt: null, finishedAt: null, outputFile: null, artifactIds: [],
        lastFailure: null, supersededAttempts: action.attempts,
      });
      rmSync(join(runDir, `completion-${action.id}.json`), { force: true });
    }
    state.presentation.stages = deriveV2LiveStages(state, { revision: state.program.revision, at });
    const archivedResult = hadResult ? archived : null;
    appendEvent(runDir, state, 'workflow.reopened', { previousStatus, source: 'resume', archivedResult, requeued });
    writeRunState(runDir, state);
    return {
      status: 'reopened', state, previousStatus, requeued, archivedResult, needsCaller: plan.needsCaller,
    };
  } finally { lease.release(); }
}

/**
 * Revise a run's plan. Applies directly when no kernel owns the run; otherwise
 * queues the request for the live kernel and waits up to waitMs for it to be
 * applied or rejected. If the kernel exits before taking the request, this
 * applies it itself. Resolves {status: applied|rejected|queued, record, state,
 * reopened, appliedBy: offline|kernel|null}.
 */
export async function reviseV2Program({ bullswarmDir, runId, request, waitMs = 120_000, pollMs = 250, now = () => new Date().toISOString() } = {}) {
  const runDir = runDirFor(bullswarmDir, runId);
  const applyOffline = () => {
    const lease = tryRunLease(runDir);
    if (!lease) return null;
    try { return { ...commitRevisionUnderLease(runDir, request, { now }), appliedBy: 'offline' }; }
    finally { lease.release(); }
  };
  const direct = applyOffline();
  if (direct) return direct;
  queueRevisionRequest(runDir, request);
  const deadline = Date.now() + Math.max(0, waitMs);
  for (;;) {
    const state = readRunStateLoose(runDir);
    const record = state?.revisions?.find((entry) => entry.id === request.id);
    if (record) return { status: record.status, record, state, reopened: null, appliedBy: 'kernel' };
    const takeover = applyOffline();
    if (takeover) return takeover;
    if (Date.now() >= deadline) return { status: 'queued', record: null, state, reopened: null, appliedBy: null };
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

/**
 * Pause a run: nothing new starts. mode "drain" lets running agents finish;
 * mode "now" stops them and runs those steps again after resume. A run with no
 * live kernel is paused on the spot. Resolves {status: paused|pausing, ...}.
 */
export async function pauseV2Run({ bullswarmDir, runId, mode = 'drain', source = 'cli', waitMs = 0, pollMs = 250, now = () => new Date().toISOString() } = {}) {
  const runDir = runDirFor(bullswarmDir, runId);
  const current = deserializeV2DurableState(readFileSync(statePath(runDir), 'utf8'));
  if (V2_TERMINAL_STATUSES.has(current.lifecycle.status)) throw new Error(`run ${runId} is already terminal (${current.lifecycle.status})`);
  if (current.lifecycle.status === 'paused') return { status: 'paused', already: true, state: current, appliedBy: null };
  const request = { requested: true, requestedAt: now(), mode: mode === 'now' ? 'now' : 'drain', source };
  writeJsonAtomic(join(runDir, PAUSE_FILE), request);
  const lease = tryRunLease(runDir);
  if (lease) {
    try {
      const state = deserializeV2DurableState(readFileSync(statePath(runDir), 'utf8'));
      if (state.lifecycle.status !== 'paused') {
        state.pause = { requestedAt: request.requestedAt, mode: request.mode, source, pausedAt: now() };
        clearWaitingFor(state); // a parked v3 run parks again when it resumes
        state.lifecycle.status = 'paused';
        appendEvent(runDir, state, 'workflow.paused', { mode: request.mode, source, requeued: [], kernel: false });
        writeRunState(runDir, state);
      }
      return { status: 'paused', already: false, state, appliedBy: 'offline' };
    } finally { lease.release(); }
  }
  const deadline = Date.now() + Math.max(0, waitMs);
  for (;;) {
    const state = readRunStateLoose(runDir);
    if (state?.lifecycle?.status === 'paused') return { status: 'paused', already: false, state, appliedBy: 'kernel' };
    if (V2_TERMINAL_STATUSES.has(state?.lifecycle?.status)) return { status: state.lifecycle.status, already: false, state, appliedBy: 'kernel' };
    if (Date.now() >= deadline) return { status: 'pausing', already: false, state, appliedBy: 'kernel' };
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

/**
 * Lift a pause. A live kernel still draining for the pause simply continues;
 * a paused run is marked runnable and the caller relaunches its kernel.
 */
export function unpauseV2Run({ bullswarmDir, runId, source = 'cli' } = {}) {
  const runDir = runDirFor(bullswarmDir, runId);
  rmSync(join(runDir, PAUSE_FILE), { force: true });
  const lease = tryRunLease(runDir);
  if (!lease) return { status: 'withdrawn', kernelAlive: true };
  try {
    const state = deserializeV2DurableState(readFileSync(statePath(runDir), 'utf8'));
    if (!state.pause && state.lifecycle.status !== 'paused') return { status: 'not-paused', kernelAlive: false, state };
    // The run stays paused on disk until a kernel resumes it and lifts the
    // pause under its own lease (workflow.unpaused, source resume). Lifting it
    // here would leave a "running" run whose recorded kernel is dead, which
    // watchers correctly report as interrupted.
    return { status: 'unpaused', kernelAlive: false, state, source };
  } finally { lease.release(); }
}
