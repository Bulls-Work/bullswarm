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
import { resolveRunId, v2RunnerLiveness, isLegacyRunDir, legacyRunLine } from './short-id.js';
import { hasPassingRequirementEvidence, isProgramWorkflow } from './execution-policy.js';
import { readEvents } from './events.js';
import { presentationStageStatus, projectV2DependencyStages } from './v2-presentation.js';
import { isDeliveredWorkflowStatus } from './status.js';

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
  // A terminal run is never waiting for its caller planner, whatever a stale
  // request record says; cancellation is surfaced so the watcher knows why a
  // paused run needs one resume to finalize.
  const awaitingPlanner = !terminal && state.planner?.awaiting ? { boundary: state.planner.awaiting.boundary, turn: state.planner.awaiting.turn } : null;
  const cancellationRequested = Boolean(state.cancellation?.requested) && !terminal;
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
    cancellationRequested,
    executionMode: state.config?.settings?.executionMode ?? 'verified',
    evidencePassed: hasPassingRequirementEvidence(state),
    terminal, timing: terminal ? timingBreakdown(state) : null,
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

export function renderWatchSnapshot(snapshot, { heartbeat = false, verbose = false, events = [] } = {}) {
  const target = snapshot.dispatchTarget == null ? '∞' : snapshot.dispatchTarget;
  const location = [snapshot.phase, snapshot.step].filter(Boolean).join('/') || 'starting';
  if (!verbose) {
    const actions = events.filter((event) => event.type === 'attempt.agent_action').length;
    if (snapshot.runningCount !== undefined) {
      const state = snapshot.terminal
        ? snapshot.status === 'completed'
          ? snapshot.executionMode === 'program' && !snapshot.evidencePassed ? 'program complete; not independently verified; result ready' : 'workflow complete; result ready'
          : `workflow ended ${snapshot.status}; result ready`
        : snapshot.awaitingPlanner
          ? `waiting for the caller planner (${snapshot.awaitingPlanner.boundary} boundary, turn ${snapshot.awaitingPlanner.turn})`
          : `${snapshot.runningCount} running, ${snapshot.waitingCount} waiting`;
      return `${snapshot.terminal || snapshot.awaitingPlanner ? '■' : heartbeat ? '♡' : '●'} +${formatDuration(snapshot.elapsedSec)} ${state} · ` +
        `${events.length} new events` +
        (snapshot.latestAction ? ` · latest: ${snapshot.latestAction}` : '') +
        ` · quiet ${formatDuration(snapshot.quietForSec)}` +
        (snapshot.transportQuietForSec == null ? '' : ` · agent output ${formatDuration(snapshot.transportQuietForSec)} ago`);
    }
    const line = `${snapshot.terminal ? '■' : heartbeat ? '♡' : '●'} +${formatDuration(snapshot.elapsedSec)} ` +
      `${snapshot.status}/${snapshot.stage ?? '?'} ${location} · ${events.length} events, ${actions} actions · ` +
      `quiet ${formatDuration(snapshot.quietForSec)}` +
      (snapshot.transportQuietForSec == null ? '' : ` · agent output ${formatDuration(snapshot.transportQuietForSec)} ago`);
    if (snapshot.terminal && snapshot.timing) {
      return `${line}\n  timing: ${snapshot.timing.attempts.length} attempts in ${formatDuration(snapshot.timing.workflowElapsedSec)}`;
    }
    return line;
  }
  const marker = snapshot.terminal ? '■' : heartbeat ? '♡' : '●';
  const lines = [
    `${marker} +${formatDuration(snapshot.elapsedSec)} ${snapshot.status}/${snapshot.stage ?? '?'} ` +
      `${location} · dispatch ${snapshot.dispatchesUsed}/${target} · ` +
      `round ${snapshot.expansionRound}/${snapshot.expansionLimit} · tokens ${compactTokens(snapshot.tokens)}` +
      (snapshot.pendingSteering ? ` · steering pending ${snapshot.pendingSteering}` : ''),
  ];
  for (const agent of snapshot.agents) {
    const model = agent.model ? `/${agent.model}` : '';
    const silence = agent.silentForSec == null ? '' : ` · quiet ${formatDuration(agent.silentForSec)}`;
    const stall = agent.stall === 'suspected_stalled' ? ' ⚠ suspected stalled' : '';
    lines.push(`  ⟡ ${agent.stepId} · ${agent.pool ?? '?'}${model} · ${formatDuration(agent.elapsedSec)}${silence}${stall}`);
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
    .map(({ stage }) => stage.id);
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
  return { stages: new Set(done), stalled, retry: new Map(), moving: new Map() };
}

// Epoch ms of a pool's re-probe deadline from the CORE bullswarm state (the
// one at `<bullswarmDir>/state.json`, distinct from this run's own
// state.json), when readable.
function readCoreQuarantineUntilMs(bullswarmDir, pool) {
  if (!bullswarmDir || !pool) return null;
  const core = readJson(join(bullswarmDir, 'state.json'));
  const until = core?.pools?.[pool]?.quarantine?.until;
  return Number.isFinite(until) ? until : null;
}

// ISO timestamp literal embedded in a verdict `why` string, e.g.
// `usage limit: "..." · pool paused until 2026-09-08T14:59:59.000Z`.
const ISO_TIMESTAMP_RE = /\b\d{4}-\d{2}-\d{2}T[\d:.]+Z\b/;

function quotaDeadlineIso(bullswarmDir, pool, why) {
  const untilMs = readCoreQuarantineUntilMs(bullswarmDir, pool);
  if (untilMs != null) return new Date(untilMs).toISOString();
  return ISO_TIMESTAMP_RE.exec(String(why ?? ''))?.[0] ?? null;
}

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
  bullswarmDir = null,
} = {}) {
  const carried = memory ?? initialWatchMemory(state);
  const stages = new Set(carried.stages);
  const stalled = new Map(carried.stalled);
  const retry = new Map(carried.retry);
  const moving = new Map(carried.moving);
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
    if (failureKind === 'quota') {
      const record = (state.attempts ?? []).find((attempt) => attempt.id === payload.attemptId);
      const pool = record?.pool ?? payload.pool ?? null;
      const why = payload.why ?? record?.why ?? null;
      notable.push({
        type: 'attempt.quota',
        actionId,
        attemptId: payload.attemptId ?? record?.id ?? null,
        pool,
        why,
        until: quotaDeadlineIso(bullswarmDir, pool, why),
      });
      moving.set(actionId, true);
      return;
    }
    retry.set(actionId, payload.failureKind ?? payload.status ?? 'unknown');
  };

  for (const event of events) {
    const payload = event.payload ?? {};
    switch (event.type) {
      case 'action.finished': {
        const runtime = (state.actions ?? []).find((item) => item.id === payload.actionId) ?? null;
        const status = payload.status ?? runtime?.status ?? 'finished';
        retry.delete(payload.actionId);
        moving.delete(payload.actionId);
        notable.push({
          type: 'action.finished',
          actionId: payload.actionId,
          status,
          failureKind: payload.failureKind ?? runtime?.lastFailure?.kind ?? null,
          why: payload.why ?? runtime?.lastFailure?.message
            ?? (payload.outOfScope ?? payload.paths)?.join(', ') ?? null,
          durationSec: status === 'blocked' ? null : actionDurationSec(runtime, event, nowMs),
        });
        break;
      }
      case 'evidence.recorded': {
        const requirementIds = payload.requirements ?? [];
        notable.push({
          type: 'evidence.recorded',
          actionId: payload.actionId,
          requirements: requirementIds.map((id) => ({
            id,
            status: payload.statuses?.[id] ?? state.ledger?.requirements?.[id]?.status ?? 'unknown',
          })),
        });
        break;
      }
      case 'presentation.stage_completed': {
        if (stages.has(payload.stageId)) break;
        stages.add(payload.stageId);
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
      case 'steering.delivered':
        if (verbose) notable.push({ type: 'steering.delivered', steeringId: payload.steeringId ?? null });
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
      if (!status.terminal || stages.has(stage.id)) continue;
      stages.add(stage.id);
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

  return { notable, memory: { stages, stalled, retry, moving } };
}

/** One notable event as one human line. `now` anchors the attempt.quota
 * deadline's local-vs-ISO formatting; it defaults to wall-clock time but the
 * watch loop threads its injectable clock through so it stays deterministic. */
export function renderWatchEvent(event, { now = Date.now() } = {}) {
  switch (event.type) {
    case 'attach':
      return `● watching ${event.shortId ?? event.runId} · ${event.status} · ` +
        `${event.running} running, ${event.waiting} waiting · +${formatDuration(event.elapsedSec)}`;
    case 'action.finished':
      if (event.status === 'succeeded') return `✓ ${event.actionId} finished · ${formatDuration(event.durationSec)}`;
      if (event.status === 'blocked') return `⊘ ${event.actionId} blocked · ${event.why ?? 'dependency not satisfied'}`;
      if (event.status === 'cancelled') return `✗ ${event.actionId} cancelled · ${formatDuration(event.durationSec)}`;
      return `✗ ${event.actionId} ${event.status} · ${event.failureKind ?? 'unknown'}: ` +
        `${event.why ?? 'no reason recorded'} · ${formatDuration(event.durationSec)}`;
    case 'evidence.recorded':
      return `◆ ${event.actionId} evidence · ` +
        (event.requirements.map((item) => `${item.id} ${item.status}`).join(', ') || 'no requirements');
    case 'stage.completed':
      return event.status === 'completed'
        ? `✓ ${event.label} completed · ${event.completed}/${event.total}`
        : `✗ ${event.label} ended · ${event.completed}/${event.total}`;
    case 'planner.finished':
      if (!event.ok) return `× planning attempt rejected · ${event.why}`;
      return event.turn === 1
        ? `◇ plan created (turn 1) · ${event.summary ?? event.kind ?? 'no summary'}`
        : `◇ plan updated #${event.turn} · ${event.summary ?? event.kind ?? 'no summary'}`;
    case 'agent.stalled':
      return `⚠ ${event.actionId} silent for ${formatDuration(event.silentSec)} · ` +
        `${event.pool ?? '?'}/${event.model ?? '?'} · still running, not auto-killed`;
    case 'agent.recovered':
      return `↻ ${event.actionId} active again after ${formatDuration(event.silentSec)}`;
    case 'cancellation.requested':
      return '⧖ cancellation requested';
    case 'action.started':
      return `▶ ${event.actionId} started · ${event.pool ?? '?'}/${event.model ?? '?'} · attempt ${event.attempt ?? '?'}`;
    case 'attempt.retrying':
      return `↺ ${event.actionId} retrying · ${event.failureKind}`;
    case 'attempt.quota':
      return `⚠ ${event.actionId} usage limit on ${event.pool ?? '?'} · ` +
        `paused until ${formatDeadline(event.until, now)} · retrying on another pool`;
    case 'attempt.moved':
      return `↺ ${event.actionId} now on ${event.pool ?? '?'} · ${event.model ?? '?'}`;
    case 'steering.delivered':
      return '→ steering delivered';
    default:
      return null;
  }
}

function watchEventLine(event, { jsonl, at, runId, shortId, sequence = null }) {
  if (!jsonl) return renderWatchEvent(event, { now: at });
  const { type, ...fields } = event;
  // `sequence` is the durable cursor this object was emitted at: the machine
  // form of the human `next: ... --after <sequence>` relaunch line.
  return JSON.stringify({ type, at, runId, shortId, ...(sequence == null ? {} : { sequence }), ...fields });
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
  now = Date.now,
  output = process.stdout,
} = {}) {
  const resolved = await resolveRunWithGrace(bullswarmDir, token, waitForRunMs, intervalMs);
  const statePath = join(resolved.runDir, 'state.json');
  // Nothing drives a legacy run, so there is nothing to watch: say so once and
  // stop, before any polling loop or output stream is set up.
  if (isLegacyRunDir(resolved.runDir)) {
    output.write(`${legacyRunLine({ shortId: resolved.shortId, runId: resolved.runId, runDir: resolved.runDir })}\n`);
    return 2;
  }
  // --next follows the run until something happens, so it never degrades to a
  // single snapshot even if --once is also passed.
  const oneShot = once && !next;
  let priorFingerprint = null;
  let priorHumanFingerprint = null;
  let lastPrintedAt = 0;
  let priorSequence = null;
  let pendingEvents = [];
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
      const eventMode = !oneShot && !classic;
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
      if (newEvents.length) {
        pendingEvents.push(...newEvents);
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
        });
        if (line == null) return;
        output.write(`${line}\n`);
        lastPrintedAt = nowMs;
      };
      let notablePrinted = 0;
      if (eventMode) {
        if (!attached) {
          attached = true;
          memory = initialWatchMemory(state, {
            replayedEvents: afterSequence == null ? [] : newEvents,
            sinceMs, stallAfterMs, nowMs,
          });
          lastPrintedAt = nowMs;
          // --next is a wake-up call, not a follow: it prints only what happens.
          if (!next) {
            emitLine({
              type: 'attach', runId: snapshot.runId, shortId: snapshot.shortId,
              status: snapshot.status, running: snapshot.runningCount,
              waiting: snapshot.waitingCount, elapsedSec: snapshot.elapsedSec,
            });
          }
        }
        const collected = notableWatchEvents({
          events: newEvents, state, memory, verbose, nowMs, stallAfterMs, bullswarmDir,
        });
        memory = collected.memory;
        for (const event of collected.notable) {
          emitLine(event);
          notablePrinted += 1;
        }
        // The periodic heartbeat is opt-in for V2 runs (--heartbeat <seconds>).
        const beatMs = Number.isFinite(heartbeatMs) && heartbeatMs > 0 ? heartbeatMs : null;
        if (beatMs != null && !next && nowMs - lastPrintedAt >= beatMs) {
          output.write(jsonl
            ? `${JSON.stringify({ type: 'heartbeat', ...snapshot })}\n`
            : `${renderWatchSnapshot(snapshot, { heartbeat: true, verbose, events: pendingEvents })}\n`);
          lastPrintedAt = nowMs;
          pendingEvents = [];
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
        if (eventMode && jsonl) emitLine({ type: 'interrupted', status: snapshot.status });
        else if (!jsonl) { output.write(`outcome: interrupted; edits retained\nnext: bullswarm workflow resume ${snapshot.shortId ?? snapshot.runId}\n`); }
        return oneShot ? 0 : 1;
      }
      if (snapshot.terminal || oneShot) {
        if (eventMode && jsonl && snapshot.terminal) {
          emitLine({ type: 'finished', status: snapshot.status, delivered: isDeliveredWorkflowStatus(snapshot.status) });
        } else if (!jsonl && snapshot.terminal) {
          output.write(`outcome: ${snapshot.status}\n`);
          output.write(`next: bullswarm workflow runs result ${snapshot.shortId ?? snapshot.runId} --json\n`);
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
            : `next: bullswarm workflow plan show ${runToken} --json\n`);
        }
        return 0;
      }
      // --next has delivered its wake-up: something notable happened and the
      // run is still going. The relaunch line hands the caller the exact cursor
      // and exit time to resume from, so nothing committed in between is lost.
      if (next && notablePrinted > 0) {
        if (eventMode && !jsonl) {
          output.write(`next: bullswarm workflow watch ${snapshot.shortId ?? snapshot.runId}`
            + ` --next --after ${priorSequence} --since ${snapshot.at}\n`);
        }
        return 0;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, Math.max(100, intervalMs)));
  }
}
