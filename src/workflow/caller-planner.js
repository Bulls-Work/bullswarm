// The caller-planner handshake: a run whose caller writes the program waits
// with a durable request (plan show reads it, refreshed when steering was
// queued since), and a submitted program is validated against the exact turn
// and boundary the kernel recorded, then accepted with the same bookkeeping a
// dispatched planner turn gets (acceptCallerPlannerResponse).

import { withV2Cancellation } from './v2-cancellation.js';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeJsonAtomic } from '../lib/fsjson.js';
import { appendEvent } from './events.js';
import {
  deserializeV2DurableState, initializeNewActions, serializeV2DurableState, statePath, v2PlannerMode,
} from './v2-state.js';
import { V2_TERMINAL_STATUSES } from './status.js';
import {
  applyV2PlannerResponse, createV2PlannerContext, createV2PlannerRequest, validateV2PlannerResponse,
  V2PlannerValidationError,
} from './v2-planner.js';
import { readRunFeatures, runFeatureFlags } from './run-features.js';
import { deliverSteering, peekSteering } from './steering.js';
import { acquireKernelLease } from './v2-process.js';
import { ensureVerifyLoop } from './verify-rounds.js';

export function callerPlannerSubmitCommand(token) {
  return `bullswarm workflow plan submit ${token} --program <file.json>`;
}

// Apply a planner response that did not come from a dispatched planner
// process (a caller-authored program). Shared by the runtime's initial-program
// path and the CLI's `workflow plan submit`, so both record identical durable
// bookkeeping: turn counters, expansion rounds, action initialization, and
// the same planner.finished event a dispatched planner would have produced.
export function acceptCallerPlannerResponse(state, response, { boundary, runDir, onEvent = null, now = () => new Date().toISOString(), deliverSteeringIds = null } = {}) {
  // Steering the request surfaced to the caller is consumed by this turn
  // (recorded before the turn counter advances, like a dispatched delivery).
  // Steering queued after the request was shown stays pending, so the resumed
  // kernel opens a steering boundary for it instead of losing it.
  const deliveredSteering = deliverSteeringIds ? deliverSteering(state, runDir, { ids: deliverSteeringIds }) : [];
  const next = applyV2PlannerResponse(state, response, { boundary, requiredScoutUnits: [] });
  next.planner.awaiting = null;
  for (const entry of deliveredSteering) {
    // Append first, then notify: `onEvent?.(appendEvent(...))` would skip the
    // append entirely when no listener is attached (optional-call
    // short-circuiting does not evaluate the arguments).
    const event = appendEvent(runDir, next, 'steering.delivered', { steeringId: entry.id, message: entry.message, decisionSequence: entry.decisionSequence, source: 'caller' });
    onEvent?.(event);
  }
  if (boundary === 'gaps') next.budget.expansions += 1;
  ensureVerifyLoop(next, response, runFeatureFlags(readRunFeatures(runDir)));
  initializeNewActions(next);
  const accepted = next.planner.lastDecision;
  if (accepted.kind === 'exhausted') {
    next.lifecycle.status = 'planning';
  }
  const event = appendEvent(runDir, next, 'planner.finished', {
    turn: next.planner.turns, ok: true, kind: accepted.kind, summary: accepted.summary,
    programRevision: next.program.revision, source: 'caller', boundary, at: now(),
  });
  onEvent?.(event);
  return { state: next, accepted };
}

// One composer for every durable caller-planner request, whether the kernel
// writes it at a boundary or `plan show` refreshes it with steering queued
// while the run was paused. Steering is surfaced (peeked), never consumed.
function composeCallerPlannerRequest(state, { boundary, turn, requestPath, candidatePath, correction = null, pendingSteering = [], scoutReport = null }) {
  const context = createV2PlannerContext(state, {
    scout: scoutReport,
    steering: [
      ...(state.config.settings.suggestedPlan ? [state.config.settings.suggestedPlan] : []),
      ...pendingSteering.map((entry) => entry.message),
    ],
    correction,
    boundary,
  });
  const request = createV2PlannerRequest(state, context, {
    turn, requestPath, candidatePath, correction,
    submitCommand: callerPlannerSubmitCommand(state.shortId ?? state.runId),
    pendingSteering: pendingSteering.map(({ id, message, queuedAt }) => ({ id, message, queuedAt })),
  });
  return { request, context };
}

function durableScoutReport(state) {
  const outputFile = state.preflight?.scout?.outputFile;
  if (state.preflight?.scout?.status !== 'succeeded' || !outputFile || !existsSync(outputFile)) return null;
  return readFileSync(outputFile, 'utf8');
}

// Read the request a paused caller-planner run left, refreshing it first when
// steering was queued after the pause so the caller sees every pending
// instruction and a submission consumes exactly what was shown. Run state is
// never changed here; only the request document is rewritten.
export function readCallerPlannerRequest({ bullswarmDir, runId, refresh = true } = {}) {
  if (typeof bullswarmDir !== 'string' || !bullswarmDir) throw new TypeError('bullswarmDir is required');
  if (typeof runId !== 'string' || !runId) throw new TypeError('runId is required');
  const runDir = join(bullswarmDir, 'workflows', runId);
  const path = statePath(runDir);
  if (!existsSync(path)) throw new Error(`run ${runId} has no durable state`);
  const state = withV2Cancellation(deserializeV2DurableState(readFileSync(path, 'utf8')), runDir);
  const awaiting = state.planner.awaiting;
  if (!awaiting || V2_TERMINAL_STATUSES.has(state.lifecycle.status)) return { state, runDir, awaiting: null, request: null, refreshed: false, pendingSteering: [] };
  let request = null;
  try { request = JSON.parse(readFileSync(awaiting.requestPath, 'utf8')); } catch { request = null; }
  const pendingSteering = peekSteering(state, runDir);
  const surfaced = new Set((request?.pendingSteering ?? []).map((entry) => entry.id));
  const stale = request == null || pendingSteering.some((entry) => !surfaced.has(entry.id));
  if (!stale || !refresh) return { state, runDir, awaiting, request, refreshed: false, pendingSteering };
  const composed = composeCallerPlannerRequest(state, {
    boundary: awaiting.boundary, turn: awaiting.turn, requestPath: awaiting.requestPath, candidatePath: awaiting.candidatePath,
    correction: awaiting.correction ?? null, pendingSteering, scoutReport: durableScoutReport(state),
  });
  writeJsonAtomic(awaiting.requestPath, composed.request);
  return { state, runDir, awaiting, request: composed.request, refreshed: true, pendingSteering };
}

// Durable submission of a caller-authored planner response to a paused run.
// The run must be awaiting its caller planner; the response is validated
// against the exact durable state and boundary the kernel recorded.
function submitCallerPlannerResponseLocked({ bullswarmDir, runId, response, onEvent = null } = {}) {
  if (typeof bullswarmDir !== 'string' || !bullswarmDir) throw new TypeError('bullswarmDir is required');
  if (typeof runId !== 'string' || !runId) throw new TypeError('runId is required');
  const runDir = join(bullswarmDir, 'workflows', runId);
  const path = statePath(runDir);
  if (!existsSync(path)) throw new Error(`run ${runId} has no durable state`);
  const state = withV2Cancellation(deserializeV2DurableState(readFileSync(path, 'utf8')), runDir);
  if (v2PlannerMode(state) !== 'caller') throw new Error(`run ${runId} uses a dispatched Workflow Planner; only caller-planner runs accept submitted programs`);
  if (V2_TERMINAL_STATUSES.has(state.lifecycle.status)) throw new Error(`run ${runId} is already terminal (${state.lifecycle.status})`);
  if (!state.planner.awaiting) throw new Error(`run ${runId} is not waiting for a planner submission (planner status ${state.planner.status}, workflow ${state.lifecycle.status})`);
  const cancellationFile = join(runDir, 'cancellation.json');
  if (existsSync(cancellationFile)) state.cancellation = JSON.parse(readFileSync(cancellationFile, 'utf8'));
  if (state.cancellation?.requested) {
    throw new Error(`run ${runId} has a pending cancellation (${state.cancellation.reason ?? 'operator requested stop'}); no program can be submitted. Finalize it with: bullswarm workflow goal --resume ${state.shortId ?? runId}`);
  }
  const { boundary, candidatePath, requestPath } = state.planner.awaiting;
  let request = null;
  try { request = JSON.parse(readFileSync(requestPath, 'utf8')); } catch { /* request unreadable: deliver no steering, the kernel re-surfaces it */ }
  const surfacedSteeringIds = Array.isArray(request?.pendingSteering) ? request.pendingSteering.map((entry) => entry.id).filter(Boolean) : [];
  let accepted;
  try {
    accepted = validateV2PlannerResponse(response, state, { boundary, requiredScoutUnits: [] });
  } catch (error) {
    if (error instanceof V2PlannerValidationError) return { ok: false, boundary, issues: [...error.issues], state };
    throw error;
  }
  // The submission holds the same lease as the kernel; recheck its boundary
  // before committing the accepted program.
  const latest = deserializeV2DurableState(readFileSync(path, 'utf8'));
  if (!latest.planner.awaiting || latest.planner.awaiting.turn !== state.planner.awaiting.turn || latest.planner.turns !== state.planner.turns) {
    throw new Error(`run ${runId} changed while validating the submission (another submit or resume claimed turn ${state.planner.awaiting.turn}); re-run plan show and submit again`);
  }
  writeJsonAtomic(candidatePath, accepted);
  const result = acceptCallerPlannerResponse(state, accepted, { boundary, runDir, onEvent, deliverSteeringIds: surfacedSteeringIds });
  serializeV2DurableState(result.state);
  writeJsonAtomic(path, result.state);
  return { ok: true, boundary, accepted: result.accepted, state: result.state, runDir, candidatePath };
}

export function submitCallerPlannerResponse(options = {}) {
  if (!options.bullswarmDir || !/^wf-[a-z0-9]+-[a-f0-9]{6}$/.test(options.runId ?? '')) throw new TypeError('bullswarmDir and a valid runId are required');
  const runDir = join(options.bullswarmDir, 'workflows', options.runId);
  if (!existsSync(runDir)) throw new Error(`run ${options.runId} has no durable state`);
  const lease = acquireKernelLease(runDir);
  try { return submitCallerPlannerResponseLocked(options); }
  finally { lease.release(); }
}
