import { withV2Cancellation } from './v2-cancellation.js';
// Low-noise, non-interactive workflow progress watcher.
// A run is event-based by default: one attach line, then one line per notable
// event and silence while work is merely in progress. `--once` and `--classic`
// switch to the transition-plus-heartbeat stream instead. This is intentionally
// distinct from the full-screen TUI and the machine-oriented events replay
// API. Legacy (pre-0.27.0 authored-graph) runs cannot be watched at all —
// nothing drives them — so the watcher refuses them with a single line.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveRunId, v2RunnerLiveness, isLegacyRunDir, legacyRunLine, readKernelStderrTail } from './short-id.js';
import { glyphs } from '../lib/glyphs.js';
import { withPoolLabels } from '../lib/pool-labels.js';
import { hasPassingRequirementEvidence, isProgramWorkflow } from './execution-policy.js';
import { readEvents } from './events.js';
import { presentationStageStatus, projectV2DependencyStages } from './v2-presentation.js';
import { isDeliveredWorkflowStatus } from './status.js';
import { deserializeV2ResultEnvelope, formatV2HandbackLines, formatV2ProofLabel, formatV2ProofLine, summarizeV2Result } from './v2-outcome.js';
import { createStaleProbe } from '../lib/stale.js';
import { declaredEvidence, NEEDS_YOU_LABELS } from './step-vocabulary.js';
import { needsYouFacts, needsYouJson, renderNeedsYou } from './needs-you.js';
import { readRunFeatures, runFeatureFlags } from './run-features.js';

// The needs-you facts ride on the notable under a symbol: the JSONL object
// carries only needsYouJson's fields, and the human block renders from these.
const NEEDS_YOU_FACTS = Symbol('needsYouFacts');
// A marked run's Workflow Planner or preflight scout that stopped on one of
// these goes to the caller (owner decision, 2026-09-25): the watch says so and
// wakes.
const LIMIT_STOP_KINDS = new Set(['quota', 'throttle', 'unavailable']);

function needsYouNotable(facts) {
  return facts ? { type: 'needs-you', ...needsYouJson(facts), [NEEDS_YOU_FACTS]: facts } : null;
}

function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

function secondsBetween(start, finish = new Date().toISOString()) {
  const value = (Date.parse(finish) - Date.parse(start)) / 1000;
  return Number.isFinite(value) ? Math.max(0, Math.round(value)) : null;
}

export function formatDuration(seconds) {
  if (!Number.isFinite(seconds)) return '?';
  const total = Math.max(0, Math.round(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (hours) return `${hours}h${String(minutes).padStart(2, '0')}m`;
  if (minutes) return `${minutes}m${String(secs).padStart(2, '0')}s`;
  return `${secs}s`;
}

function compactTokens(value) {
  if (!Number.isFinite(value)) return '?';
  if (value >= 1000) return `${(value / 1000).toFixed(value >= 10000 ? 1 : 2)}k`;
  return String(value);
}

export function timingBreakdown(state) {
  const sourceAttempts = [...(state.preflight?.scout?.attempts ?? []), ...(state.planner?.attempts ?? []), ...(state.attempts ?? [])];
  const attempts = sourceAttempts.map((attempt) => ({
    actionId: attempt.actionId,
    attemptNumber: attempt.attemptNumber ?? attempt.ordinal,
    pool: attempt.pool ?? null,
    model: attempt.model ?? null,
    status: attempt.status,
    elapsedSec: secondsBetween(attempt.startedAt, attempt.finishedAt),
    tokens: attempt.usage?.tokens?.totalKnown ?? null,
  }));
  const byPool = {};
  for (const attempt of attempts) {
    const key = attempt.pool ?? 'unknown';
    byPool[key] ??= { attempts: 0, elapsedSec: 0, tokens: 0 };
    byPool[key].attempts += 1;
    byPool[key].elapsedSec += attempt.elapsedSec ?? 0;
    byPool[key].tokens += attempt.tokens ?? 0;
  }
  return {
    workflowElapsedSec: secondsBetween(state.lifecycle?.startedAt ?? state.startedAt, state.lifecycle?.finishedAt ?? state.finishedAt),
    attempts,
    byPool,
  };
}

// Seconds since any live agent last produced output bytes or provider stream
// events. This is transport liveness (is the child process still talking?),
// distinct from quietForSec, which counts durable workflow events (has
// anything semantically happened?). null when no agent is running.
export function transportQuietSeconds(state, now = new Date()) {
  const attempts = [...(state.preflight?.scout?.attempts ?? []), ...(state.planner?.attempts ?? []), ...(state.attempts ?? [])]
    .filter((attempt) => attempt.status === 'running');
  if (!attempts.length) return null;
  const latest = Math.max(...attempts.map((attempt) => Math.max(
    Date.parse(attempt.lastActivityAt ?? '') || 0, Date.parse(attempt.lastEventAt ?? '') || 0,
    Date.parse(attempt.startedAt ?? '') || 0,
  )));
  return latest ? Math.max(0, Math.floor((now.getTime() - latest) / 1000)) : null;
}

export function watchSnapshot(runDir, state, now = new Date()) {
  const lifecycle = state.lifecycle ?? {};
  const interrupted = lifecycle.status === 'interrupted' || !v2RunnerLiveness(state, { runDir, now: now.getTime() }).alive;
  const allAttempts = [...(state.preflight?.scout?.attempts ?? []), ...(state.planner?.attempts ?? []), ...(state.attempts ?? [])];
  const activeAttempts = interrupted ? [] : allAttempts.filter((attempt) => attempt.status === 'running');
  const actionById = new Map((state.program?.actions ?? []).map((action) => [action.id, action]));
  const agents = activeAttempts.map((attempt) => ({
    stepId: attempt.actionId ?? (state.planner?.attempts?.includes(attempt) ? 'workflow-planner' : 'preflight-scout'),
    pool: attempt.pool ?? null, model: attempt.model ?? null, status: attempt.status,
    elapsedSec: secondsBetween(attempt.startedAt, attempt.finishedAt ?? now.toISOString()),
    silentForSec: null, stall: null, outputBytesObserved: attempt.outputBytesObserved ?? 0,
    lastActions: attempt.lastAgentEvent ? [{ kind: attempt.lastAgentEvent.kind ?? attempt.lastAgentEvent.type ?? 'agent', status: 'running', summary: attempt.lastAgentEvent.summary ?? null }] : [],
  }));
  const runningAction = (state.actions ?? []).find((action) => ['running', 'waiting'].includes(action.status));
  const terminal = ['completed', 'partial', 'cancelled', 'failed'].includes(lifecycle.status);
  const kernelStderrTail = interrupted ? readKernelStderrTail(runDir) : [];
  // A terminal run is never waiting for its caller planner, whatever a stale
  // request record says; cancellation is surfaced so the watcher knows why a
  // paused run needs one resume to finalize.
  const awaitingPlanner = !terminal && state.planner?.awaiting ? { boundary: state.planner.awaiting.boundary, turn: state.planner.awaiting.turn } : null;
  const cancellationRequested = Boolean(state.cancellation?.requested) && !terminal;
  // An operator pause: the kernel has stopped and nothing starts until resume.
  const paused = !terminal && lifecycle.status === 'paused' ? { mode: state.pause?.mode ?? null, pausedAt: state.pause?.pausedAt ?? null } : null;
  const elapsedSec = secondsBetween(lifecycle.startedAt, lifecycle.finishedAt ?? now.toISOString());
  return {
    at: now.toISOString(), runId: state.runId, shortId: state.shortId ?? null,
    interrupted, status: interrupted ? 'interrupted' : lifecycle.status ?? 'unknown', stage: state.preflight?.scout?.status === 'running' ? 'preflight' : state.planner?.status === 'running' ? 'planning' : terminal ? 'finished' : 'execution',
    phase: null, step: runningAction?.id ?? (state.planner?.status === 'running' ? 'workflow-planner' : null),
    elapsedSec, eventSequence: state.events?.sequence ?? 0,
    dispatchesUsed: state.budget?.agents ?? 0, dispatchTarget: state.config?.settings?.maxAgents ?? null,
    expansionRound: state.budget?.expansions ?? 0, expansionLimit: state.config?.settings?.maxExpansionRounds ?? 0,
    tokens: state.usage?.total ?? null, pendingSteering: 0, deliveredSteering: 0,
    quietForSec: 0, transportQuietForSec: transportQuietSeconds(state, now), agents,
    runningCount: interrupted ? 0 : (state.actions ?? []).filter((action) => action.status === 'running').length + (state.planner?.status === 'running' ? 1 : 0) + (state.preflight?.scout?.status === 'running' ? 1 : 0),
    waitingCount: isProgramWorkflow(state)
      ? (state.actions ?? []).filter((action) => ['pending', 'ready', 'waiting'].includes(action.status)).length + (awaitingPlanner ? 1 : 0)
      : (state.actions ?? []).filter((action) => action.status === 'waiting').length + (state.planner?.status === 'waiting' ? 1 : 0),
    latestAction: runningAction ? actionById.get(runningAction.id)?.purpose ?? runningAction.id : null,
    awaitingPlanner,
    paused,
    cancellationRequested,
    executionMode: state.config?.settings?.executionMode ?? 'verified',
    evidencePassed: hasPassingRequirementEvidence(state),
    terminal, timing: terminal ? timingBreakdown(state) : null,
    ...(kernelStderrTail.length ? { kernelStderrTail } : {}),
  };
}

export function snapshotFingerprint(snapshot) {
  return JSON.stringify({
    status: snapshot.status,
    stage: snapshot.stage,
    phase: snapshot.phase,
    step: snapshot.step,
    eventSequence: snapshot.eventSequence,
    dispatchesUsed: snapshot.dispatchesUsed,
    pendingSteering: snapshot.pendingSteering,
    agents: snapshot.agents.map((agent) => ({
      stepId: agent.stepId,
      pool: agent.pool,
      model: agent.model,
      status: agent.status,
      stall: agent.stall,
      lastActions: agent.lastActions,
    })),
  });
}

function humanTransitionFingerprint(snapshot) {
  return JSON.stringify({
    status: snapshot.status,
    stage: snapshot.stage,
    phase: snapshot.phase,
    step: snapshot.step,
    dispatchesUsed: snapshot.dispatchesUsed,
    pendingSteering: snapshot.pendingSteering,
    agents: snapshot.agents.map((agent) => ({
      stepId: agent.stepId,
      pool: agent.pool,
      model: agent.model,
      status: agent.status,
      stall: agent.stall,
    })),
  });
}

export function renderWatchSnapshot(snapshot, {
  heartbeat = false, verbose = false, events = [], eventCount = null, actionCount = null,
} = {}) {
  const target = snapshot.dispatchTarget == null ? '∞' : snapshot.dispatchTarget;
  const location = [snapshot.phase, snapshot.step].filter(Boolean).join('/') || 'starting';
  if (!verbose) {
    const actions = actionCount ?? events.filter((event) => event.type === 'attempt.agent_action').length;
    const count = eventCount ?? events.length;
    if (snapshot.runningCount !== undefined) {
      const state = snapshot.terminal
        ? snapshot.status === 'completed'
          ? snapshot.executionMode === 'program' && !snapshot.evidencePassed ? 'program complete; not independently verified; result ready' : 'workflow complete; result ready'
          : `workflow ended ${snapshot.status}; result ready`
        : snapshot.awaitingPlanner
          ? `waiting for the caller planner (${snapshot.awaitingPlanner.boundary} boundary, turn ${snapshot.awaitingPlanner.turn})`
          : `${snapshot.runningCount} running, ${snapshot.waitingCount} waiting`;
      return `${snapshot.terminal || snapshot.awaitingPlanner ? glyphs().stopped : heartbeat ? glyphs().heartbeat : glyphs().ongoing} +${formatDuration(snapshot.elapsedSec)} ${state} · ` +
        `${count} new events` +
        (snapshot.latestAction ? ` · latest: ${snapshot.latestAction}` : '') +
        ` · quiet ${formatDuration(snapshot.quietForSec)}` +
        (snapshot.transportQuietForSec == null ? '' : ` · agent output ${formatDuration(snapshot.transportQuietForSec)} ago`);
    }
    const line = `${snapshot.terminal ? glyphs().stopped : heartbeat ? glyphs().heartbeat : glyphs().ongoing} +${formatDuration(snapshot.elapsedSec)} ` +
      `${snapshot.status}/${snapshot.stage ?? '?'} ${location} · ${count} events, ${actions} actions · ` +
      `quiet ${formatDuration(snapshot.quietForSec)}` +
      (snapshot.transportQuietForSec == null ? '' : ` · agent output ${formatDuration(snapshot.transportQuietForSec)} ago`);
    if (snapshot.terminal && snapshot.timing) {
      return `${line}\n  timing: ${snapshot.timing.attempts.length} attempts in ${formatDuration(snapshot.timing.workflowElapsedSec)}`;
    }
    return line;
  }
  const marker = snapshot.terminal ? glyphs().stopped : heartbeat ? glyphs().heartbeat : glyphs().ongoing;
  const lines = [
    `${marker} +${formatDuration(snapshot.elapsedSec)} ${snapshot.status}/${snapshot.stage ?? '?'} ` +
      `${location} · dispatch ${snapshot.dispatchesUsed}/${target} · ` +
      `round ${snapshot.expansionRound}/${snapshot.expansionLimit} · tokens ${compactTokens(snapshot.tokens)}` +
      (snapshot.pendingSteering ? ` · steering pending ${snapshot.pendingSteering}` : ''),
  ];
  for (const agent of snapshot.agents) {
    const model = agent.model ? `/${agent.model}` : '';
    const silence = agent.silentForSec == null ? '' : ` · quiet ${formatDuration(agent.silentForSec)}`;
    const stall = agent.stall === 'suspected_stalled' ? ` ${glyphs().warn} suspected stalled` : '';
    lines.push(`  ${glyphs().agent} ${agent.stepId} · ${agent.pool ?? '?'}${model} · ${formatDuration(agent.elapsedSec)}${silence}${stall}`);
    for (const action of agent.lastActions) {
      lines.push(`    ${action.kind}:${action.status}${action.summary ? ` · ${action.summary}` : ''}`);
    }
  }
  if (snapshot.terminal && snapshot.timing) {
    lines.push(`  timing: ${snapshot.timing.attempts.length} attempts in ${formatDuration(snapshot.timing.workflowElapsedSec)}`);
    for (const attempt of snapshot.timing.attempts) {
      lines.push(`    ${attempt.actionId}#${attempt.attemptNumber} · ${attempt.pool ?? '?'}${attempt.model ? `/${attempt.model}` : ''} · ${formatDuration(attempt.elapsedSec)} · ${attempt.status} · ${compactTokens(attempt.tokens)} tokens`);
    }
  }
  return lines.join('\n');
}

// A freshly launched detached run may not have written state.json yet when a
// watcher attaches (goal --watch hands off immediately). waitForRunMs bounds
// how long the watcher polls for the run to appear before giving up.
async function resolveRunWithGrace(bullswarmDir, token, waitForRunMs, intervalMs) {
  const deadline = Date.now() + Math.max(0, waitForRunMs);
  while (true) {
    const resolved = resolveRunId(bullswarmDir, token);
    if (resolved && existsSync(join(resolved.runDir, 'state.json'))) return resolved;
    if (Date.now() >= deadline) {
      if (!resolved) throw new Error(`no run found for "${token}"`);
      // The grace window is spent and there is still no state.json: by the one
      // rule every other reader uses (isLegacyRunDir) that directory is legacy
      // history, so hand it back and let the caller's legacy guard answer with
      // the same sentence the other driving verbs print. Reporting a missing
      // file here would jump the guard and exit 1 instead of 2.
      return resolved;
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(250, Math.max(50, intervalMs))));
  }
}

// ── Event mode ──────────────────────────────────────────────────────────────
// By default the watcher is event-based: one attach line, then one line per
// notable event and nothing at all while work is merely in progress. Progress
// polling still happens (state.json plus events.jsonl), but a poll that
// carries no notable event prints nothing.

export const DEFAULT_STALL_AFTER_MS = 300_000;

// Every agent attempt in one list with a stable key, so a silent episode can
// be reported exactly once and recovered exactly once. Worker attempts carry
// their own id; planner and scout attempts are keyed by their ordinal.
function v2AttemptRecords(state) {
  const records = [];
  for (const attempt of state.preflight?.scout?.attempts ?? []) {
    records.push({ key: `preflight-scout-${attempt.ordinal}`, actionId: 'preflight-scout', attempt });
  }
  for (const attempt of state.planner?.attempts ?? []) {
    records.push({ key: `workflow-planner-${attempt.ordinal}`, actionId: 'workflow-planner', attempt });
  }
  for (const attempt of state.attempts ?? []) {
    records.push({ key: attempt.id ?? `${attempt.actionId}-${attempt.ordinal}`, actionId: attempt.actionId, attempt });
  }
  return records;
}

// Epoch ms of the most recent sign of life for one attempt: output bytes, a
// provider stream event, or (before either) its start.
function attemptActivityAt(attempt) {
  const latest = Math.max(
    Date.parse(attempt.lastActivityAt ?? '') || 0,
    Date.parse(attempt.lastEventAt ?? '') || 0,
    Date.parse(attempt.startedAt ?? '') || 0,
  );
  return latest || null;
}

// Program runs group actions into dependency levels projected from the program
// itself; verified runs carry durable presentation stages. Both are rendered
// as one "stage completed" line, and each stage is reported once.
// The steps a phase covers, as one key. A plan revision renumbers the
// projected phases (`r1-level-1` becomes `live-level-1-<hash>`), so a phase
// already reported under its old id is known by its steps instead; the
// repair loop revises every failing run's plan.
function stageStepsKey(actionIds) {
  return Array.isArray(actionIds) && actionIds.length ? `steps:${[...actionIds].sort().join('\n')}` : null;
}

function v2Stages(state) {
  const stages = isProgramWorkflow(state)
    ? projectV2DependencyStages(state)
    : state.presentation?.stages ?? [];
  return stages.map((stage) => ({ stage, status: presentationStageStatus(stage, state.actions ?? []) }));
}

function actionDurationSec(runtime, event, nowMs) {
  if (!runtime?.startedAt) return null;
  return secondsBetween(runtime.startedAt, runtime.finishedAt ?? event?.committedAt ?? new Date(nowMs).toISOString());
}

// A failed step that declares evidence and whose worker failed first (E15):
// the attempt that failed, the last one finished by this event, ran no check.
function evidenceNotRun(state, payload, event) {
  if (payload.failureKind === 'failed-evidence') return false;
  const definition = (state.program?.actions ?? []).find((action) => action.id === payload.actionId);
  if (!declaredEvidence(definition).length) return false;
  const attempts = (state.attempts ?? []).filter((entry) => entry.actionId === payload.actionId);
  const at = Date.parse(event?.committedAt ?? '');
  const attempt = (Number.isFinite(at) ? attempts.findLast((entry) => Date.parse(entry.finishedAt ?? '') <= at) : null) ?? attempts.at(-1);
  return !Array.isArray(attempt?.evidenceResults);
}

function attemptOrdinal(state, attemptId) {
  const known = (state.attempts ?? []).find((attempt) => attempt.id === attemptId)?.ordinal;
  if (Number.isFinite(known)) return known;
  const trailing = Number(/-(\d+)$/.exec(String(attemptId ?? ''))?.[1]);
  return Number.isFinite(trailing) ? trailing : null;
}

// Carried across polls: which stages have already been reported, which
// attempts are in a reported silent episode, and which actions have a failed
// attempt whose replacement would be a mechanical retry.
//
// A relaunched watcher (--after/--since) seeds the same memory from continuity
// inputs instead of from the live state alone: replayedEvents are the durable
// events this launch is about to print, and sinceMs is when the previous
// watcher exited.
export function initialWatchMemory(state, {
  replayedEvents = [],
  sinceMs = null,
  stallAfterMs = DEFAULT_STALL_AFTER_MS,
  nowMs = Date.now(),
  stale = null,
} = {}) {
  // A stage whose action finished among the replayed events is exactly the news
  // this relaunch exists to deliver, so it must not be pre-marked as reported
  // even though it is already terminal on disk. A stage that was terminal
  // before the cursor stays silent.
  const replayedActions = new Set(replayedEvents
    .filter((event) => event.type === 'action.finished' || event.type === 'evidence.recorded')
    .map((event) => event.payload?.actionId)
    .filter(Boolean));
  const done = v2Stages(state)
    .filter(({ stage, status }) => (status.terminal || stage.completedAt)
      && !(stage.actionIds ?? []).some((id) => replayedActions.has(id)))
    .flatMap(({ stage }) => [stage.id, stageStepsKey(stage.actionIds)].filter(Boolean));
  const stalled = new Map();
  // An agent whose silence crossed the stall threshold before the previous
  // watcher exited was already reported by it: remember the episode so this
  // launch prints no duplicate stall line, while its recovery still prints.
  if (sinceMs != null) {
    for (const { key, attempt } of v2AttemptRecords(state)) {
      if (attempt.status !== 'running') continue;
      const activityAt = attemptActivityAt(attempt);
      if (activityAt == null) continue;
      if (nowMs - activityAt < stallAfterMs) continue;
      if (activityAt + stallAfterMs >= sinceMs) continue;
      stalled.set(key, { since: activityAt });
    }
  }
  // Likewise an attempt that already looked stale before the previous watcher
  // exited was reported by it: the score says when it crossed the threshold.
  const staleReported = new Map();
  if (sinceMs != null && typeof stale === 'function') {
    for (const record of v2AttemptRecords(state)) {
      if (record.attempt.status !== 'running') continue;
      const score = staleFor(stale, state, record, nowMs);
      if (score?.stale && score.staleSince != null && score.staleSince < sinceMs) staleReported.set(record.key, score.staleSince);
    }
  }
  return { stages: new Set(done), stalled, retry: new Map(), moving: new Map(), handoffs: new Map(), staleReported, stageSteps: new Map() };
}

function staleFor(probe, state, { attempt, actionId }, nowMs) {
  const action = (state.program?.actions ?? []).find((entry) => entry.id === actionId) ?? null;
  try { return probe({ attempt, action, state, nowMs }); } catch { return null; }
}

// ISO timestamp literal embedded in a verdict `why` string, e.g. a run from
// an earlier version: `usage limit: "..." · pool paused until
// 2026-09-08T14:59:59.000Z`.
const ISO_TIMESTAMP_RE = /\b\d{4}-\d{2}-\d{2}T[\d:.]+Z\b/;

// Human deadline: HH:MM local when the deadline falls on the same calendar
// day as `now`, else the full ISO timestamp so the date is never ambiguous.
function formatDeadline(untilIso, now) {
  if (!untilIso) return 'unknown';
  const until = new Date(untilIso);
  if (Number.isNaN(until.getTime())) return 'unknown';
  const reference = now instanceof Date ? now : new Date(now);
  const sameDay = until.getFullYear() === reference.getFullYear()
    && until.getMonth() === reference.getMonth()
    && until.getDate() === reference.getDate();
  if (!sameDay) return untilIso;
  return `${String(until.getHours()).padStart(2, '0')}:${String(until.getMinutes()).padStart(2, '0')}`;
}

// An ISO string for a time given as epoch ms or as a parseable string; null
// for anything else.
function isoOrNull(value) {
  const ms = typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

// The planner's or scout's attempt an attempt event names by its ordinal
// (their attempts live under state.planner and state.preflight.scout).
function orchestrationAttempt(state, actionId, ordinal) {
  const attempts = actionId === 'preflight-scout' ? state?.preflight?.scout?.attempts
    : actionId === 'workflow-planner' ? state?.planner?.attempts : null;
  return Number.isInteger(ordinal) ? (attempts ?? []).find((attempt) => attempt?.ordinal === ordinal) ?? null : null;
}

// Whether a run goes on after its scout stopped: it has a program, or the
// caller's --program is kept in the run directory (v2-runtime.js) until the
// kernel applies it just after the scout, so a state read in between shows no
// program yet.
function runHasProgram(state, runDir) {
  return (state?.program?.actions ?? []).length > 0
    || (runDir != null && existsSync(join(runDir, 'initial-planner-response.json')));
}

// The attempt a preflight.scout_finished or planner.finished event closed: the
// last one finished by the time it was committed (a replay reads a state that
// moved on).
function attemptClosedAt(attempts, committedAt) {
  const at = Date.parse(committedAt ?? '');
  if (!Number.isFinite(at)) return attempts.at(-1) ?? null;
  return attempts.filter((attempt) => !(Date.parse(attempt?.finishedAt ?? attempt?.startedAt ?? '') > at)).at(-1) ?? null;
}

function scoutAttemptAt(state, committedAt) {
  return attemptClosedAt(state?.preflight?.scout?.attempts ?? [], committedAt);
}

// A planner turn's attempts carry their turn; an event without one reads all.
function plannerAttemptAt(state, turn, committedAt) {
  const attempts = (state?.planner?.attempts ?? []).filter((attempt) => !Number.isInteger(turn) || attempt?.turn === turn);
  return attemptClosedAt(attempts, committedAt);
}

/**
 * Turn the durable events committed since the last poll, plus the current
 * state, into the notable events a watcher should print. Pure: the carried
 * memory is never mutated, a fresh one is returned alongside the events.
 */
export function notableWatchEvents({
  events = [],
  state,
  memory = null,
  verbose = false,
  nowMs = Date.now(),
  stallAfterMs = DEFAULT_STALL_AFTER_MS,
  // (attempt record) -> staleScore() result; null skips the stale score.
  stale = null,
  // The run directory, for the marker the needs-you block reads.
  runDir = null,
  // The run's features.json marker; read from `runDir` when not given.
  features = undefined,
} = {}) {
  const program = isProgramWorkflow(state);
  // Read once, and only when an event needs it.
  let markedRun;
  const marked = () => (markedRun ??= runFeatureFlags(features !== undefined ? features : runDir ? readRunFeatures(runDir) : {}).failureRule);
  const token = state?.shortId ?? state?.runId ?? '?';
  const carried = memory ?? initialWatchMemory(state);
  const stages = new Set(carried.stages);
  const stalled = new Map(carried.stalled);
  const retry = new Map(carried.retry);
  const moving = new Map(carried.moving);
  const handoffs = new Map(carried.handoffs);
  const staleReported = new Map(carried.staleReported);
  const stageSteps = new Map(carried.stageSteps ?? []);
  const notable = [];

  const onAttemptStarted = (actionId, payload, ordinal) => {
    // A new attempt after a failed one is the dispatcher retrying mechanically.
    if (retry.has(actionId)) {
      if (verbose) notable.push({ type: 'attempt.retrying', actionId, failureKind: retry.get(actionId) });
      retry.delete(actionId);
    }
    // A usage-limit failure always gets its own always-on pair of lines
    // (attempt.quota then attempt.moved), never the generic verbose retry line.
    if (moving.has(actionId)) {
      notable.push({
        type: 'attempt.moved', actionId, attemptId: payload.attemptId ?? null,
        pool: payload.pool ?? null, model: payload.model ?? null,
      });
      moving.delete(actionId);
    }
    const incoming = payload.handoff ?? handoffs.get(actionId) ?? null;
    if (incoming) {
      notable.push({
        type: 'attempt.handoff',
        actionId,
        pool: incoming.pool ?? null,
        files: incoming.files ?? incoming.changedFileCount ?? 0,
        lastSaid: incoming.lastSaid ?? incoming.lastResponse ?? '',
      });
      handoffs.delete(actionId);
    }
    if (verbose) {
      notable.push({
        type: 'action.started', actionId,
        pool: payload.pool ?? null, model: payload.model ?? null, attempt: ordinal,
      });
    }
  };
  const onAttemptFinished = (actionId, payload) => {
    if (payload.status === 'succeeded') { retry.delete(actionId); return; }
    const failureKind = payload.failureKind
      ?? (state.attempts ?? []).find((attempt) => attempt.id === payload.attemptId)?.failureKind;
    // Stopped by the caller's restart: not a retry, and the handoff line
    // comes from the next attempt's own start event.
    if (failureKind === 'restarted') { retry.delete(actionId); return; }
    // A failed check is retried once on the same pool with its output
    // attached (E14); without that retry the step's own finish line says why.
    if (failureKind === 'failed-evidence' && payload.willRetry !== true) { retry.delete(actionId); return; }
    // Marked runs: a planner or scout attempt is found by its ordinal.
    const record = (state.attempts ?? []).find((attempt) => attempt.id === payload.attemptId)
      ?? (payload.attemptId == null && marked() ? orchestrationAttempt(state, actionId, payload.ordinal) : null);
    const rememberHandoff = () => {
      if (payload.willRetry !== true || failureKind === 'schema') return;
      handoffs.set(actionId, {
        pool: record?.pool ?? payload.pool ?? null,
        files: payload.changedFileCount ?? record?.changedFileCount ?? 0,
        lastSaid: payload.lastResponse ?? '',
      });
    };
    if (failureKind === 'stalled') {
      const pool = record?.pool ?? payload.pool ?? null;
      const why = payload.why ?? record?.why ?? null;
      notable.push({
        type: 'attempt.stalled',
        actionId,
        attemptId: payload.attemptId ?? record?.id ?? null,
        pool,
        why,
        silentSec: payload.silentSec ?? record?.silentSec ?? null,
        partialOutput: payload.partialOutput ?? record?.partialOutput ?? null,
        willRetry: payload.willRetry === true,
      });
      rememberHandoff();
      moving.set(actionId, true);
      return;
    }
    if (failureKind === 'quota') {
      const pool = record?.pool ?? payload.pool ?? null;
      const why = payload.why ?? record?.why ?? null;
      // When the pool is back: the return time the event carries (`backAt`),
      // else a time the why names (`until`). No pool is paused (state.js S1),
      // so nothing is read from the shared state.
      const until = ISO_TIMESTAMP_RE.exec(String(why ?? ''))?.[0] ?? null;
      const backAt = isoOrNull(payload.retryAfter ?? payload.holdUntil ?? null);
      notable.push({
        type: 'attempt.quota',
        actionId,
        attemptId: payload.attemptId ?? record?.id ?? null,
        pool,
        why,
        until,
        ...(backAt ? { backAt } : {}),
        willRetry: payload.willRetry === true,
        // A marked (stage-3) run's line reads "back to you", or "no retry
        // spent" on an attempt that promised one (markedQuotaTail). A move or
        // wait decision rides on the JSONL object only when a saved stage-3
        // event carries it (F23); stored attempts never hold one.
        ...(payload.failureRule === true ? { failureRule: true } : {}),
        ...(['move', 'wait'].includes(payload.quotaNext) ? { quotaNext: payload.quotaNext } : {}),
      });
      rememberHandoff();
      moving.set(actionId, true);
      return;
    }
    retry.set(actionId, payload.failureKind ?? payload.status ?? 'unknown');
    rememberHandoff();
  };

  for (const event of events) {
    const payload = event.payload ?? {};
    switch (event.type) {
      case 'action.finished': {
        const runtime = (state.actions ?? []).find((item) => item.id === payload.actionId) ?? null;
        const status = payload.status ?? runtime?.status ?? 'finished';
        retry.delete(payload.actionId);
        moving.delete(payload.actionId);
        // A caller-driven restart stops the attempt on purpose; its own
        // step.restarted line reports it, and the step runs again.
        if (payload.failureKind === 'restarted') break;
        // A failed program step comes back to the caller as one block (D25).
        if (program && status === 'failed') {
          const block = needsYouNotable(needsYouFacts(state, { ...event, payload: { ...payload, status } }, { token, runDir }));
          if (block) { notable.push(block); break; }
        }
        notable.push({
          type: 'action.finished',
          actionId: payload.actionId,
          status,
          failureKind: payload.failureKind ?? runtime?.lastFailure?.kind ?? null,
          why: payload.why ?? runtime?.lastFailure?.message
            ?? (payload.outOfScope ?? payload.paths)?.join(', ') ?? null,
          durationSec: status === 'blocked' ? null : actionDurationSec(runtime, event, nowMs),
          // A succeeded step whose report listed `## Not done` items: the
          // kernel's event says how many (read per event, so a rerun's
          // earlier finish keeps its own line).
          ...(status === 'succeeded' && Number.isInteger(payload.returnedEarly?.count) && payload.returnedEarly.count > 0
            ? { returnedEarly: payload.returnedEarly.count } : {}),
          // What backs the step (E22); events of older runs carry none.
          ...(status === 'succeeded' && payload.proof && typeof payload.proof === 'object' ? { proof: payload.proof } : {}),
          ...(status === 'failed' && evidenceNotRun(state, payload, event) ? { evidenceNotRun: true } : {}),
        });
        break;
      }
      case 'evidence.recorded': {
        const requirementIds = payload.requirements ?? [];
        notable.push({
          type: 'evidence.recorded',
          actionId: payload.actionId,
          // With more than one verify round a failing judgment is the
          // kernel's to repair, not yet the caller's.
          ...(Number.isInteger(state.verifyLoop?.max) ? { loopMax: state.verifyLoop.max } : {}),
          requirements: requirementIds.map((id) => ({
            id,
            status: payload.statuses?.[id] ?? state.ledger?.requirements?.[id]?.status ?? 'unknown',
          })),
        });
        break;
      }
      case 'presentation.stage_started':
        if (payload.stageId && stageStepsKey(payload.actionIds)) stageSteps.set(payload.stageId, stageStepsKey(payload.actionIds));
        break;
      case 'presentation.stage_completed': {
        if (stages.has(payload.stageId)) break;
        stages.add(payload.stageId);
        const steps = stageSteps.get(payload.stageId)
          ?? stageStepsKey((state.presentation?.stages ?? []).find((stage) => stage.id === payload.stageId)?.actionIds);
        if (steps) stages.add(steps);
        notable.push({
          type: 'stage.completed',
          stageId: payload.stageId ?? null,
          label: payload.label ?? payload.stageId ?? 'stage',
          status: payload.status === 'completed' ? 'completed' : 'ended',
          completed: payload.completed ?? null,
          total: payload.total ?? null,
        });
        break;
      }
      case 'planner.finished': {
        // The dispatch is over: a later turn's first attempt is not a retry
        // or a move of this one (as action.finished does for a step).
        retry.delete('workflow-planner');
        moving.delete('workflow-planner');
        // A marked run's planner that stopped on a usage limit, a rate limit
        // that did not clear, or no free pool goes to the caller (the run
        // finishes): one line with its pool and when to try again, as the
        // scout's. Any other planner failure, and every unmarked run, keeps
        // the rejected line.
        if (payload.ok === false && LIMIT_STOP_KINDS.has(payload.failureKind) && marked()) {
          // `unavailable`: no planner attempt ran, so no pool is named.
          const pool = payload.pool ?? (payload.failureKind === 'unavailable'
            ? null : plannerAttemptAt(state, payload.turn, event.committedAt)?.pool ?? null);
          notable.push({
            type: 'planner.finished', ok: false, turn: payload.turn ?? null,
            failureKind: payload.failureKind, stopped: true,
            label: NEEDS_YOU_LABELS[payload.failureKind], pool,
            retryAfter: isoOrNull(payload.retryAfter ?? null),
            why: payload.why ?? payload.failureKind,
          });
          break;
        }
        notable.push(payload.ok === false
          ? {
            type: 'planner.finished', ok: false, turn: payload.turn ?? null,
            failureKind: payload.failureKind ?? null,
            why: payload.why ?? payload.failureKind ?? 'no reason recorded',
          }
          : {
            type: 'planner.finished', ok: true, turn: payload.turn ?? null,
            kind: payload.kind ?? null, summary: payload.summary ?? null,
          });
        break;
      }
      case 'workflow.cancellation_requested':
        notable.push({
          type: 'cancellation.requested',
          reason: payload.reason ?? null,
          source: payload.source ?? null,
        });
        break;
      case 'attempt.started':
        onAttemptStarted(payload.actionId, payload, attemptOrdinal(state, payload.attemptId));
        break;
      case 'planner.attempt_started':
        onAttemptStarted('workflow-planner', payload, payload.ordinal ?? null);
        break;
      case 'preflight.scout_attempt_started':
        onAttemptStarted('preflight-scout', payload, payload.ordinal ?? null);
        break;
      case 'attempt.finished':
        onAttemptFinished(payload.actionId, payload);
        break;
      case 'planner.attempt_finished':
        onAttemptFinished('workflow-planner', payload);
        break;
      case 'preflight.scout_attempt_finished':
        onAttemptFinished('preflight-scout', payload);
        break;
      // A marked run's scout that stopped on a usage limit, or found no pool
      // free, goes to the caller: a run with no program finishes, and one
      // with the caller's program runs on without the report.
      case 'preflight.scout_finished': {
        retry.delete('preflight-scout');
        moving.delete('preflight-scout');
        if (payload.status !== 'failed' || !LIMIT_STOP_KINDS.has(payload.failureKind) || !marked()) break;
        // `unavailable`: no scout attempt ran, so no pool is named.
        const pool = payload.pool ?? (payload.failureKind === 'unavailable' ? null : scoutAttemptAt(state, event.committedAt)?.pool ?? null);
        notable.push({
          type: 'preflight.scout_finished', status: 'failed', failureKind: payload.failureKind,
          label: NEEDS_YOU_LABELS[payload.failureKind], pool,
          retryAfter: isoOrNull(payload.retryAfter ?? null),
          why: payload.why ?? null,
          // The kernel's own decision when the event carries it: a replay of a
          // run revised later has a program the scout's run never had. Events
          // written before the field read the state.
          runContinues: typeof payload.runContinues === 'boolean' ? payload.runContinues : runHasProgram(state, runDir),
        });
        break;
      }
      case 'steering.delivered':
        if (verbose) notable.push({ type: 'steering.delivered', steeringId: payload.steeringId ?? null });
        break;
      // Live control always prints: the caller changed the plan or the run's
      // pace, and a --next watcher must wake on it.
      case 'steering.received':
        notable.push({ type: 'steering.received', steeringId: payload.steeringId ?? null, message: payload.message ?? null });
        break;
      // The kernel's own revisions add loop steps; the loop lines say it.
      case 'program.revised':
        if (payload.source === 'kernel') break;
        notable.push({
          type: 'plan.revised', requestId: payload.requestId ?? null, programRevision: payload.programRevision ?? null,
          summary: payload.summary ?? null, changes: payload.changes ?? {},
        });
        break;
      case 'program.revision_rejected':
        notable.push({ type: 'plan.rejected', requestId: payload.requestId ?? null, issues: payload.issues ?? [] });
        break;
      case 'workflow.pause_requested':
        notable.push({ type: 'pause.requested', mode: payload.mode ?? null, running: payload.running ?? [] });
        break;
      case 'workflow.unpaused':
        notable.push({ type: 'pause.lifted', requeued: payload.requeued ?? [] });
        break;
      case 'workflow.reopened':
        notable.push({
          type: 'run.reopened', previousStatus: payload.previousStatus ?? null,
          // F22: an act step the cancellation stopped after its worker started stays cancelled.
          ...(Array.isArray(payload.keptCancelled) && payload.keptCancelled.length ? { keptCancelled: [...payload.keptCancelled] } : {}),
          // `workflow resume` reopens a finished run too (reopenV2RunForRetry),
          // not only a plan revision: the line names which one did.
          ...(payload.source === 'resume' ? { source: 'resume' } : {}),
        });
        break;
      case 'step.restarted':
        staleReported.delete(payload.attemptId);
        notable.push({
          type: 'step.restarted', actionId: payload.actionId ?? null, attemptId: payload.attemptId ?? null,
          stoppedPool: payload.stoppedPool ?? null, pool: payload.pool ?? null,
        });
        break;
      case 'step.restart_refused':
        notable.push({ type: 'step.restart_refused', actionId: payload.actionId ?? null, why: payload.why ?? null });
        break;
      // The repair loop: one line per round start and outcome, one per repair.
      // A one-round run prints none, as before the loop existed.
      case 'workflow.verify-round':
        // Failures the loop leaves are the caller's: the review variant of
        // the block, whatever the number of rounds (D25).
        if (program && payload.stage === 'finished' && payload.next === 'caller') {
          const block = needsYouNotable(needsYouFacts(state, event, { token, runDir }));
          if (block) { notable.push(block); break; }
        }
        if (!(payload.of > 1)) break;
        notable.push({
          type: 'verify.round', round: payload.round ?? null, of: payload.of, stage: payload.stage ?? null,
          toJudge: (payload.toJudge ?? []).length, passed: (payload.passed ?? []).length,
          failed: (payload.failed ?? []).length, next: payload.next ?? null,
        });
        break;
      case 'step.accepted':
        notable.push({
          type: 'step.accepted', actionId: payload.actionId ?? null, reason: payload.reason ?? null,
          requirements: Array.isArray(payload.requirements) ? [...payload.requirements] : null,
        });
        break;
      case 'workflow.repair':
        if (!(state.verifyLoop?.max > 1)) break;
        notable.push({
          type: 'repair', round: payload.round ?? null, stage: payload.stage ?? null, actionId: payload.actionId ?? null,
          requirements: (payload.requirements ?? []).length, changedFiles: payload.changedFiles ?? null, status: payload.status ?? null,
        });
        break;
      default:
        break;
    }
  }

  // Program runs commit no durable level-completed event, so a dependency level
  // that flipped to terminal between polls is detected here instead. A stage
  // already reported from its durable event is never reported twice.
  if (isProgramWorkflow(state)) {
    for (const { stage, status } of v2Stages(state)) {
      const steps = stageStepsKey(stage.actionIds);
      if (!status.terminal || stages.has(stage.id) || (steps && stages.has(steps))) continue;
      stages.add(stage.id);
      if (steps) stages.add(steps);
      notable.push({
        type: 'stage.completed',
        stageId: stage.id,
        label: stage.label,
        status: status.successful ? 'completed' : 'ended',
        completed: status.completed,
        total: status.total,
      });
    }
  }

  // Silence is measured from the later of the attempt's last output activity,
  // last agent event and start. A stalled agent is never killed; the line only
  // says the watcher can no longer see progress.
  for (const { key, actionId, attempt } of v2AttemptRecords(state)) {
    const activityAt = attemptActivityAt(attempt);
    if (attempt.status !== 'running' || activityAt == null) {
      stalled.delete(key);
      continue;
    }
    const episode = stalled.get(key);
    if (episode) {
      if (activityAt > episode.since) {
        stalled.delete(key);
        notable.push({
          type: 'agent.recovered', actionId, attemptId: key,
          silentSec: Math.max(0, Math.round((activityAt - episode.since) / 1000)),
        });
      }
      continue;
    }
    const silentMs = Math.max(0, nowMs - activityAt);
    if (silentMs < stallAfterMs) continue;
    stalled.set(key, { since: activityAt });
    notable.push({
      type: 'agent.stalled', actionId, attemptId: key,
      silentSec: Math.round(silentMs / 1000),
      pool: attempt.pool ?? null, model: attempt.model ?? null,
    });
  }

  // The stale score: one line per attempt, the first time it crosses the
  // threshold. Nothing is stopped; the caller decides whether to restart.
  if (typeof stale === 'function') {
    const running = new Set();
    for (const record of v2AttemptRecords(state)) {
      if (record.attempt.status !== 'running') continue;
      running.add(record.key);
      if (staleReported.has(record.key)) continue;
      const score = staleFor(stale, state, record, nowMs);
      if (!score?.stale) continue;
      staleReported.set(record.key, score.staleSince ?? nowMs);
      notable.push({
        type: 'attempt.stale', actionId: record.actionId, attemptId: record.key,
        pool: record.attempt.pool ?? null, model: record.attempt.model ?? null,
        score: score.score, reasons: score.reasons,
        staleSince: score.staleSince == null ? null : new Date(score.staleSince).toISOString(),
      });
    }
    for (const key of [...staleReported.keys()]) if (!running.has(key)) staleReported.delete(key);
  }

  return { notable, memory: { stages, stalled, retry, moving, handoffs, staleReported, stageSteps } };
}

/**
 * What kind of trouble one notable event is, or null for routine progress.
 * `watch --until trouble` ends on the first one; `--until` of either kind
 * prints only these lines and the outcome.
 */
export function watchTrouble(event, { program = false } = {}) {
  switch (event?.type) {
    // One wake per block; blocked dependents are listed inside it.
    case 'needs-you':
      return 'failed';
    case 'action.finished':
      if (event.status === 'failed') return 'failed';
      if (event.status === 'cancelled' && event.failureKind === 'paused') return 'paused';
      return null;
    // With a loop, verify.round with the caller (the review block) covers it.
    case 'evidence.recorded':
      if (event.loopMax != null) return null;
      return (event.requirements ?? []).some((item) => item.status === 'failed' || item.status === 'blocked') ? 'rejected' : null;
    // The loop is done and failures are left: the caller decides now.
    case 'verify.round':
      return event.stage === 'finished' && event.next === 'caller' ? 'rejected' : null;
    case 'plan.rejected':
      return 'rejected';
    // A marked run's planner stopped by a limit or no free pool has its own kind.
    case 'planner.finished':
      if (event.ok !== false) return null;
      return event.stopped === true ? 'planner-limit' : 'rejected';
    // Only a marked run's scout stopped by a limit or no free pool is one.
    case 'preflight.scout_finished':
      return 'scout-limit';
    // In program runs a stall with no retry left becomes a needs-you block.
    case 'attempt.stalled':
      return program ? null : 'stalled';
    case 'attempt.stale':
      return 'stale';
    case 'pause.requested':
      return 'paused';
    // Steering is addressed to the caller, who acts on it by revising the plan.
    case 'steering.received':
      return 'steering';
    default:
      return null;
  }
}

// A marked run's quota line: a usage limit sends the step to the caller
// (owner decision, 2026-09-25). A saved stage-3 run may still show a retry.
function markedQuotaTail(event) {
  return event.willRetry ? 'no retry spent' : 'back to you';
}

/** One notable event as one human line. `now` anchors the attempt.quota
 * deadline's local-vs-ISO formatting; it defaults to wall-clock time but the
 * watch loop threads its injectable clock through so it stays deterministic. */
export function renderWatchEvent(event, { now = Date.now(), terminal = false } = {}) {
  switch (event.type) {
    case 'needs-you':
      return event[NEEDS_YOU_FACTS] ? renderNeedsYou(event[NEEDS_YOU_FACTS], { terminal }).join('\n') : null;
    case 'step.accepted': {
      const reason = `"${event.reason ?? ''}"`;
      if (event.requirements?.length) {
        return event.requirements.map((id) => `${glyphs().ok} ${id} accepted by choice on ${event.actionId} · ${reason}`).join('\n');
      }
      return `${glyphs().ok} ${event.actionId} accepted by choice · ${reason}`;
    }
    case 'attach':
      return `${glyphs().ongoing} watching ${event.shortId ?? event.runId} · ${event.status} · ` +
        `${event.running} running, ${event.waiting} waiting · +${formatDuration(event.elapsedSec)}`;
    case 'action.finished':
      if (event.status === 'succeeded' && event.returnedEarly > 0) {
        const label = formatV2ProofLabel(event.proof);
        return `${glyphs().early} ${event.actionId} returned early · ${event.returnedEarly} not done${label ? ` · ${label}` : ''}`;
      }
      if (event.status === 'succeeded') {
        const label = formatV2ProofLabel(event.proof);
        return `${glyphs().ok} ${event.actionId} finished · ${label ? `${label} · ` : ''}${formatDuration(event.durationSec)}`;
      }
      if (event.status === 'blocked') return `${glyphs().blocked} ${event.actionId} blocked · ${event.why ?? 'dependency not satisfied'}`;
      if (event.status === 'cancelled' && event.failureKind === 'superseded') return `${glyphs().reroute} ${event.actionId} stopped · replaced by a plan revision`;
      if (event.status === 'cancelled' && event.failureKind === 'paused') return `${glyphs().waiting} ${event.actionId} stopped · runs again after resume`;
      if (event.status === 'cancelled') return `${glyphs().fail} ${event.actionId} cancelled · ${formatDuration(event.durationSec)}`;
      return `${glyphs().fail} ${event.actionId} ${event.status} · ${event.failureKind ?? 'unknown'}: ` +
        `${event.why ?? 'no reason recorded'}${event.evidenceNotRun ? ' · evidence not run' : ''} · ${formatDuration(event.durationSec)}`;
    case 'evidence.recorded':
      return `${glyphs().evidence} ${event.actionId} evidence · ` +
        (event.requirements.map((item) => `${item.id} ${item.status}`).join(', ') || 'no requirements');
    case 'stage.completed':
      return event.status === 'completed'
        ? `${glyphs().ok} ${event.label} completed · ${event.completed}/${event.total}`
        : `${glyphs().fail} ${event.label} ended · ${event.completed}/${event.total}`;
    case 'preflight.scout_finished':
      return `${glyphs().warn} preflight scout stopped · ${event.label ?? event.failureKind ?? 'failed'} on ${event.pool ?? 'no pool'}`
        + (event.retryAfter ? ` · back at ${event.retryAfter}` : '')
        + (event.runContinues ? ' · the run continues without its report' : '');
    case 'planner.finished':
      if (!event.ok && event.stopped === true) {
        return `${glyphs().fail} planner stopped · ${event.label ?? event.failureKind ?? 'failed'} on ${event.pool ?? 'no pool'}`
          + (event.retryAfter ? ` · back at ${event.retryAfter}` : '');
      }
      if (!event.ok) return `× planning attempt rejected · ${event.why}`;
      return event.turn === 1
        ? `${glyphs().plan} plan created (turn 1) · ${event.summary ?? event.kind ?? 'no summary'}`
        : `${glyphs().plan} plan updated #${event.turn} · ${event.summary ?? event.kind ?? 'no summary'}`;
    case 'agent.stalled':
      return `${glyphs().warn} ${event.actionId} silent for ${formatDuration(event.silentSec)} · ` +
        `${event.pool ?? '?'}/${event.model ?? '?'} · still running, not auto-killed`;
    case 'agent.recovered':
      return `${glyphs().retry} ${event.actionId} active again after ${formatDuration(event.silentSec)}`;
    case 'attempt.stale':
      return `${glyphs().warn} ${event.actionId} looks stale: ${(event.reasons ?? []).join('; ') || 'no reason recorded'}`;
    case 'step.restarted':
      return `${glyphs().retry} ${event.actionId} restarted · stopped ${event.attemptId ?? 'its attempt'}`
        + `${event.stoppedPool ? ` on ${event.stoppedPool}` : ''} · runs again with its handoff`
        + `${event.pool ? ` on ${event.pool}` : ''}`;
    case 'step.restart_refused':
      return `× ${event.actionId} not restarted · ${event.why ?? 'no reason recorded'}`;
    case 'cancellation.requested':
      return `${glyphs().waiting} cancellation requested`;
    case 'action.started':
      return `${glyphs().started} ${event.actionId} started · ${event.pool ?? '?'}/${event.model ?? '?'} · attempt ${event.attempt ?? '?'}`;
    case 'attempt.retrying':
      return `${glyphs().reroute} ${event.actionId} retrying · ${event.failureKind}`
        + (event.failureKind === 'failed-evidence' ? ' · same pool, failure attached' : '');
    case 'attempt.stalled':
      return `${glyphs().warn} ${event.actionId} stalled on ${event.pool ?? '?'} · `
        + `silent for ${formatDuration(event.silentSec)} · `
        + (event.willRetry ? 'retrying on another pool' : 'no retry left');
    case 'attempt.quota':
      return `${glyphs().warn} ${event.actionId} usage limit on ${event.pool ?? '?'} · `
        // When the pool is back, when that is known.
        + (event.backAt ? `back at ${event.backAt} · `
          : event.until ? `back at ${formatDeadline(event.until, now)} · ` : '')
        + (event.failureRule ? markedQuotaTail(event)
          : (event.willRetry ? 'retrying on another pool' : 'no retry left'));
    case 'attempt.moved':
      return `${glyphs().reroute} ${event.actionId} now on ${event.pool ?? '?'} · ${event.model ?? '?'}`;
    case 'attempt.handoff': {
      const said = String(event.lastSaid ?? '').replace(/\s+/g, ' ').trim();
      return `${glyphs().handoff} ${event.actionId} handed off from ${event.pool ?? '?'} · ${event.files ?? 0} file${event.files === 1 ? '' : 's'} · last said "${said}"`;
    }
    case 'steering.delivered':
      return '→ steering delivered';
    case 'steering.received':
      return `${glyphs().waiting} steering received · ${event.message ?? event.steeringId ?? ''} · revise the plan to act on it`;
    case 'plan.revised': {
      const changes = event.changes ?? {};
      const parts = [['added', '+'], ['amended', '~'], ['restored', '↺'], ['removed', '-'], ['rerun', '⟲'], ['invalidated', '⟲'], ['accepted', '✓']]
        .filter(([key]) => (changes[key] ?? []).length)
        .map(([key]) => `${key} ${changes[key].map((entry) => (typeof entry === 'string' ? entry : entry?.step ?? entry?.actionId ?? '?')).join(', ')}`);
      return `${glyphs().plan} plan revised (revision ${event.programRevision ?? '?'}) · ${event.summary ?? 'no summary'}${parts.length ? ` · ${parts.join(' · ')}` : ''}`;
    }
    case 'plan.rejected':
      return `× plan revision rejected · ${(event.issues ?? []).join('; ') || 'no reason recorded'}`;
    case 'pause.requested':
      return `${glyphs().waiting} pause requested (${event.mode ?? 'drain'}) · ${(event.running ?? []).length} running step${(event.running ?? []).length === 1 ? '' : 's'} ${event.mode === 'now' ? 'being stopped' : 'finishing first'}`;
    case 'pause.lifted':
      return `${glyphs().started} pause lifted · work continues`;
    case 'run.reopened':
      return `${glyphs().started} run reopened from ${event.previousStatus ?? 'a finished state'} by ${event.source === 'resume' ? 'workflow resume' : 'a plan revision'}${event.keptCancelled?.length ? ` · not run again (act step, may have acted): ${event.keptCancelled.join(', ')}` : ''}`;
    case 'verify.round': {
      const head = `verify round ${event.round} of ${event.of}`;
      if (event.stage === 'started') return `${glyphs().evidence} ${head} · ${event.toJudge} to ${event.round === 1 ? 'judge' : 're-check'}`;
      if (!event.failed) return `${glyphs().ok} ${head} · all ${event.passed} passed`;
      return `${glyphs().fail} ${head} · ${event.failed} failed · ${event.next === 'repair' ? 'repair next' : 'your decision'}`;
    }
    case 'repair':
      if (event.stage === 'started') return `${glyphs().retry} repair round ${event.round} · ${event.requirements} requirement${event.requirements === 1 ? '' : 's'} · ${event.actionId}`;
      return `${glyphs().ok} repair round ${event.round} finished · ${event.changedFiles == null ? 'changed files unknown' : `${event.changedFiles} file${event.changedFiles === 1 ? '' : 's'} changed`}`;
    default:
      return null;
  }
}

function watchEventLine(event, { jsonl, at, runId, shortId, sequence = null, terminal = false }) {
  if (!jsonl) return renderWatchEvent(event, { now: at, terminal });
  const { type, ...fields } = event;
  // `sequence` is the durable cursor this object was emitted at: the machine
  // form of the human `next: ... --after <sequence>` relaunch line.
  return JSON.stringify({ type, at, runId, shortId, ...(sequence == null ? {} : { sequence }), ...fields });
}

function kernelLogLines(tail = []) {
  return tail.length ? ['kernel log:', ...tail.map((line) => `  ${line}`)] : [];
}

function terminalSummary(runDir, state) {
  try {
    const envelope = deserializeV2ResultEnvelope(readFileSync(join(runDir, 'result.json'), 'utf8'));
    return summarizeV2Result(envelope, state, { runDir });
  } catch {
    // An unreadable result still ends the watch; runs result reports why.
    return null;
  }
}

export async function runWorkflowWatch(bullswarmDir, token, {
  intervalMs = 2000,
  // Absent means "no periodic heartbeat"; `--heartbeat <seconds>` opts back in,
  // and the transition-plus-heartbeat stream falls back to the historical 60s.
  heartbeatMs = null,
  once = false,
  next = false,
  // Forces the transition-plus-heartbeat stream instead of event mode.
  classic = false,
  jsonl = false,
  verbose = false,
  stallAfterMs = DEFAULT_STALL_AFTER_MS,
  // Continuity across a --next relaunch: start from the durable sequence the
  // previous watcher had consumed, and treat stalls it already reported (it
  // exited at sinceMs) as reported. Both absent means attach as usual.
  afterSequence = null,
  sinceMs = null,
  waitForRunMs = 0,
  // 'outcome' follows until the run's outcome; 'trouble' also ends on the
  // first trouble line (failed, rejected, scout stopped, planner stopped,
  // paused, stalled, stale, steering).
  // Either prints only trouble lines and the outcome, with no attach line.
  until = null,
  // The stale-score probe (see src/lib/stale.js); false turns it off.
  stale = null,
  now = Date.now,
  output = process.stdout,
  onPendingEventCount = null,
} = {}) {
  if (!jsonl) {
    const sink = output;
    output = { write: (chunk) => sink.write(withPoolLabels(chunk, bullswarmDir)) };
  }
  const resolved = await resolveRunWithGrace(bullswarmDir, token, waitForRunMs, intervalMs);
  const statePath = join(resolved.runDir, 'state.json');
  // Nothing drives a legacy run, so there is nothing to watch: say so once and
  // stop, before any polling loop or output stream is set up.
  if (isLegacyRunDir(resolved.runDir)) {
    output.write(`${legacyRunLine({ shortId: resolved.shortId, runId: resolved.runId, runDir: resolved.runDir })}\n`);
    return 2;
  }
  const untilMode = until === 'outcome' || until === 'trouble';
  // --next follows the run until something happens, so it never degrades to a
  // single snapshot even if --once is also passed; neither does --until.
  const oneShot = once && !next && !untilMode;
  const staleProbe = stale === false ? null
    : typeof stale === 'function' ? stale
      : createStaleProbe({ runDir: resolved.runDir });
  let priorFingerprint = null;
  let priorHumanFingerprint = null;
  let lastPrintedAt = 0;
  let priorSequence = null;
  let pendingEvents = [];
  let pendingEventCount = 0;
  let pendingActionCount = 0;
  let lastActivityAt = null;
  let memory = null;
  let attached = false;
  while (true) {
    const state = withV2Cancellation(readJson(statePath), resolved.runDir);
    if (state) {
      const nowMs = now();
      const snapshot = watchSnapshot(resolved.runDir, state, new Date(nowMs));
      // --once stays a single snapshot and --classic forces the historical
      // transition-plus-heartbeat stream; everything else is event-based.
      if (priorSequence == null) {
        // A newly attached watcher has no preceding interval. Start at the
        // durable high-water mark instead of replaying the run lifetime, unless
        // --after names the cursor the previous watcher stopped at, in which
        // case the events committed since then are replayed and printed.
        priorSequence = afterSequence ?? state.events?.sequence ?? state.eventSequence ?? 0;
        // Semantic quiet counts durable marks only (events, action starts and
        // finishes). Raw child output is surfaced separately as transport
        // liveness so a thinking agent and a dead one look different.
        lastActivityAt = Math.max(
          Date.parse(state.events?.last?.committedAt ?? state.lastEvent?.committedAt ?? '') || 0,
          Date.parse(state.lifecycle?.finishedAt ?? state.finishedAt ?? '') || 0,
          ...[...(state.preflight?.scout?.attempts ?? []), ...(state.planner?.attempts ?? []), ...(state.attempts ?? [])].map((attempt) => Math.max(
            Date.parse(attempt.startedAt ?? '') || 0,
            Date.parse(attempt.finishedAt ?? '') || 0,
          )),
          ...Object.values(state.activeAgents ?? {}).map((agent) => Math.max(
            Date.parse(agent.lastActionAt ?? '') || 0,
            Date.parse(agent.startedAt ?? '') || 0,
          )),
          Date.parse(state.lifecycle?.startedAt ?? state.startedAt ?? '') || nowMs,
        );
      }
      const newEvents = readEvents(resolved.runDir, { after: priorSequence });
      const eventMode = untilMode || (!oneShot && !classic);
      const beatMs = Number.isFinite(heartbeatMs) && heartbeatMs > 0 ? heartbeatMs : null;
      if (newEvents.length) {
        if (eventMode) {
          if (beatMs != null) {
            pendingEventCount += newEvents.length;
            pendingActionCount += newEvents.filter((event) => event.type === 'attempt.agent_action').length;
          }
          onPendingEventCount?.(0);
        } else {
          pendingEvents.push(...newEvents);
          onPendingEventCount?.(pendingEvents.length);
        }
        lastActivityAt = Math.max(
          lastActivityAt,
          ...newEvents.map((event) => Date.parse(event.committedAt ?? '') || nowMs),
        );
        priorSequence = newEvents.at(-1)?.sequence ?? state.events?.sequence ?? state.eventSequence ?? priorSequence;
      }
      snapshot.quietForSec = Math.max(0, Math.floor((nowMs - lastActivityAt) / 1000));
      const emitLine = (event) => {
        const line = watchEventLine(event, {
          jsonl, at: snapshot.at, runId: snapshot.runId, shortId: snapshot.shortId,
          sequence: priorSequence,
          // The outcome and handback follow a run that ended in this poll (D26).
          terminal: snapshot.terminal,
        });
        if (line == null) return;
        output.write(`${line}\n`);
        lastPrintedAt = nowMs;
      };
      let notablePrinted = 0;
      let troublePrinted = 0;
      const staleSteps = [];
      if (eventMode) {
        if (!attached) {
          attached = true;
          memory = initialWatchMemory(state, {
            replayedEvents: afterSequence == null ? [] : newEvents,
            sinceMs, stallAfterMs, nowMs, stale: staleProbe,
          });
          lastPrintedAt = nowMs;
          // --next is a wake-up call, not a follow: it prints only what happens.
          if (!next && !untilMode) {
            emitLine({
              type: 'attach', runId: snapshot.runId, shortId: snapshot.shortId,
              status: snapshot.status, running: snapshot.runningCount,
              waiting: snapshot.waitingCount, elapsedSec: snapshot.elapsedSec,
            });
          }
        }
        const collected = notableWatchEvents({
          events: newEvents, state, memory, verbose, nowMs, stallAfterMs,
          stale: snapshot.interrupted ? null : staleProbe, runDir: resolved.runDir,
        });
        memory = collected.memory;
        for (const event of collected.notable) {
          const trouble = watchTrouble(event, { program: isProgramWorkflow(state) });
          // --until prints only what needs the caller: trouble, then the
          // outcome.
          if (untilMode && trouble == null) continue;
          emitLine(event);
          notablePrinted += 1;
          if (trouble != null) troublePrinted += 1;
          if (event.type === 'attempt.stale' && !staleSteps.includes(event.actionId)) staleSteps.push(event.actionId);
        }
        // The periodic heartbeat is opt-in for V2 runs (--heartbeat <seconds>).
        if (beatMs != null && !next && !untilMode && nowMs - lastPrintedAt >= beatMs) {
          output.write(jsonl
            ? `${JSON.stringify({ type: 'heartbeat', ...snapshot })}\n`
            : `${renderWatchSnapshot(snapshot, {
              heartbeat: true, verbose, events: pendingEvents,
              eventCount: pendingEventCount, actionCount: pendingActionCount,
            })}\n`);
          lastPrintedAt = nowMs;
          pendingEvents = [];
          pendingEventCount = 0;
          pendingActionCount = 0;
        }
      } else {
        const classicHeartbeatMs = heartbeatMs == null ? 60000 : heartbeatMs;
        const fingerprint = snapshotFingerprint(snapshot);
        const humanFingerprint = humanTransitionFingerprint(snapshot);
        const heartbeat = nowMs - lastPrintedAt >= classicHeartbeatMs;
        const changed = jsonl || verbose
          ? fingerprint !== priorFingerprint
          : humanFingerprint !== priorHumanFingerprint;
        if (changed || heartbeat || oneShot) {
          output.write(jsonl
            ? `${JSON.stringify({ type: heartbeat && fingerprint === priorFingerprint ? 'heartbeat' : 'progress', ...snapshot })}\n`
            : `${renderWatchSnapshot(snapshot, {
              heartbeat: heartbeat && !changed,
              verbose,
              events: pendingEvents,
            })}\n`);
          priorFingerprint = fingerprint;
          priorHumanFingerprint = humanFingerprint;
          lastPrintedAt = nowMs;
          pendingEvents = [];
          if (changed) notablePrinted += 1;
        }
      }
      if (snapshot.interrupted) {
        if (eventMode && jsonl) emitLine({ type: 'interrupted', status: snapshot.status, kernelStderrTail: snapshot.kernelStderrTail });
        else if (!jsonl) {
          output.write(`outcome: interrupted; edits retained\nnext: bullswarm workflow resume ${snapshot.shortId ?? snapshot.runId}\n`);
          const kernelLog = kernelLogLines(snapshot.kernelStderrTail);
          if (kernelLog.length) output.write(`${kernelLog.join('\n')}\n`);
        }
        return oneShot ? 0 : 1;
      }
      if (snapshot.terminal || oneShot) {
        // A finished run hands its caller what is left and the options, right
        // here, so deciding what to do next needs no second command.
        const summary = snapshot.terminal ? terminalSummary(resolved.runDir, state) : null;
        if (eventMode && jsonl && snapshot.terminal) {
          emitLine({
            type: 'finished', status: snapshot.status, delivered: isDeliveredWorkflowStatus(snapshot.status),
            ...(summary ? { verified: summary.verified, reason: summary.reason, ...(summary.handback ? { handback: summary.handback } : {}) } : {}),
            ...(summary?.proof ? { proof: summary.proof } : {}),
          });
        } else if (!jsonl && snapshot.terminal) {
          const rounds = summary?.callerDecision && summary.verifyRounds?.max > 1 ? ` · verify rounds ${summary.callerDecision.verifyRounds}` : '';
          output.write(`outcome: ${snapshot.status}${summary ? ` · ${summary.verified ? 'verified' : 'not verified'}${rounds}` : ''}\n`);
          if (summary?.reason) output.write(`reason: ${summary.reason}\n`);
          const proofLine = formatV2ProofLine(summary);
          if (proofLine) output.write(`${proofLine}\n`);
          const handback = formatV2HandbackLines(summary);
          if (handback.length) output.write(`${handback.join('\n')}\n`);
          output.write(`next: bullswarm workflow runs result ${snapshot.shortId ?? snapshot.runId} --json --summary\n`);
        }
        return isDeliveredWorkflowStatus(snapshot.status) || oneShot ? 0 : 1;
      }
      if (snapshot.awaitingPlanner) {
        // A caller-planner run has paused durably; the runtime process has
        // exited and nothing will change until the caller submits a program
        // (or, after a cancellation request, resumes it once to finalize).
        const runToken = snapshot.shortId ?? snapshot.runId;
        if (eventMode && jsonl) {
          emitLine({
            type: 'paused', boundary: snapshot.awaitingPlanner.boundary,
            turn: snapshot.awaitingPlanner.turn, cancellationRequested: snapshot.cancellationRequested,
          });
        } else if (!jsonl) {
          output.write(`outcome: waiting for the caller planner (${snapshot.awaitingPlanner.boundary} boundary)\n`);
          output.write(snapshot.cancellationRequested
            ? `next: cancellation requested; bullswarm workflow cancel ${runToken} --json finalizes it\n`
            : `next: bullswarm workflow plan show ${runToken} --json\n`
              + `  or revise: bullswarm workflow plan export ${runToken} --out plan.json, then bullswarm workflow plan revise ${runToken} --program plan.json\n`
              + `  or finish it: bullswarm workflow resume ${runToken} (it finishes and hands back what is left)\n`);
        }
        return 0;
      }
      if (snapshot.paused) {
        // An operator pause: the kernel exited and nothing starts until
        // resume. The plan can still be revised while it is paused.
        const runToken = snapshot.shortId ?? snapshot.runId;
        if (eventMode && jsonl) emitLine({ type: 'paused', reason: 'operator', mode: snapshot.paused.mode });
        else if (!jsonl) {
          output.write('outcome: paused\n');
          output.write(`next: bullswarm workflow resume ${runToken} (revise first with bullswarm workflow plan export ${runToken} --out plan.json)\n`);
        }
        return 0;
      }
      // --next (or --until trouble) has delivered its wake-up: something
      // happened and the run is still going. The relaunch line hands the
      // caller the exact cursor and exit time to resume from, so nothing
      // committed in between is lost; a stale step also gets its restart line.
      const woke = until === 'trouble' ? troublePrinted > 0 : next && notablePrinted > 0;
      if (woke) {
        if (eventMode && !jsonl) {
          const runToken = snapshot.shortId ?? snapshot.runId;
          output.write(`next: bullswarm workflow watch ${runToken}`
            + `${until === 'trouble' ? ' --until trouble' : ' --next'} --after ${priorSequence} --since ${snapshot.at}\n`);
          for (const step of staleSteps) {
            output.write(`  or restart: bullswarm workflow step restart ${runToken} ${step}\n`);
          }
        }
        return 0;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, Math.max(100, intervalMs)));
  }
}
