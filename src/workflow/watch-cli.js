// Low-noise, non-interactive workflow progress watcher.
// Prints only semantic changes plus a periodic heartbeat, then a timing
// breakdown at terminal status. This is intentionally distinct from the
// full-screen TUI and the machine-oriented events replay API.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveRunId } from './short-id.js';
import { readSteering } from './steering.js';
import { readEvents } from './events.js';
import { isDeliveredWorkflowStatus, isTerminalWorkflowStatus } from './status.js';

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
  const sourceAttempts = state.schemaVersion === 'bullswarm.workflow.state.v2'
    ? [...(state.preflight?.scout?.attempts ?? []), ...(state.planner?.attempts ?? []), ...(state.attempts ?? [])]
    : (state.attempts ?? []);
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
  if (state.schemaVersion === 'bullswarm.workflow.state.v2') {
    const attempts = [...(state.preflight?.scout?.attempts ?? []), ...(state.planner?.attempts ?? []), ...(state.attempts ?? [])]
      .filter((attempt) => attempt.status === 'running');
    if (!attempts.length) return null;
    const latest = Math.max(...attempts.map((attempt) => Math.max(
      Date.parse(attempt.lastActivityAt ?? '') || 0, Date.parse(attempt.lastEventAt ?? '') || 0,
      Date.parse(attempt.startedAt ?? '') || 0,
    )));
    return latest ? Math.max(0, Math.floor((now.getTime() - latest) / 1000)) : null;
  }
  const running = Object.values(state.activeAgents ?? {}).filter((agent) =>
    !agent.finishedAt && (agent.status ?? 'running') === 'running');
  if (!running.length) return null;
  const latest = Math.max(...running.map((agent) => Math.max(
    Date.parse(agent.lastActivityAt ?? '') || 0,
    Date.parse(agent.lastEventAt ?? '') || 0,
    Date.parse(agent.startedAt ?? '') || 0,
  )));
  if (!latest) return null;
  return Math.max(0, Math.floor((now.getTime() - latest) / 1000));
}

export function watchSnapshot(runDir, state, now = new Date()) {
  if (state.schemaVersion === 'bullswarm.workflow.state.v2') {
    const lifecycle = state.lifecycle ?? {};
    const allAttempts = [...(state.preflight?.scout?.attempts ?? []), ...(state.planner?.attempts ?? []), ...(state.attempts ?? [])];
    const activeAttempts = allAttempts.filter((attempt) => attempt.status === 'running');
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
    const elapsedSec = secondsBetween(lifecycle.startedAt, lifecycle.finishedAt ?? now.toISOString());
    return {
      at: now.toISOString(), runId: state.runId, shortId: state.shortId ?? null,
      status: lifecycle.status ?? 'unknown', stage: state.preflight?.scout?.status === 'running' ? 'preflight' : state.planner?.status === 'running' ? 'planning' : terminal ? 'finished' : 'execution',
      phase: null, step: runningAction?.id ?? (state.planner?.status === 'running' ? 'workflow-planner' : null),
      elapsedSec, eventSequence: state.events?.sequence ?? 0,
      dispatchesUsed: state.budget?.agents ?? 0, dispatchTarget: state.config?.settings?.maxAgents ?? null,
      expansionRound: state.budget?.expansions ?? 0, expansionLimit: state.config?.settings?.maxExpansionRounds ?? 0,
      tokens: state.usage?.total ?? null, pendingSteering: 0, deliveredSteering: 0,
      quietForSec: 0, transportQuietForSec: transportQuietSeconds(state, now), agents,
      runningCount: (state.actions ?? []).filter((action) => action.status === 'running').length + (state.planner?.status === 'running' ? 1 : 0) + (state.preflight?.scout?.status === 'running' ? 1 : 0),
      waitingCount: (state.actions ?? []).filter((action) => action.status === 'waiting').length + (state.planner?.status === 'waiting' ? 1 : 0),
      latestAction: runningAction ? actionById.get(runningAction.id)?.purpose ?? runningAction.id : null,
      terminal, timing: terminal ? timingBreakdown(state) : null,
    };
  }
  const delivered = new Set((state.steering ?? []).map((entry) => entry.id));
  const queuedSteering = readSteering(runDir).filter((entry) => !delivered.has(entry.id));
  const elapsedSec = secondsBetween(state.startedAt, state.finishedAt ?? now.toISOString());
  return {
    at: now.toISOString(),
    runId: state.runId,
    shortId: state.shortId ?? null,
    status: state.status ?? 'unknown',
    stage: state.stage ?? null,
    phase: state.currentStep?.phase ?? state.currentPhase?.name ?? null,
    step: state.currentStep?.id ?? null,
    elapsedSec,
    eventSequence: state.eventSequence ?? 0,
    dispatchesUsed: state.budget?.dispatchesUsed ?? 0,
    dispatchTarget: state.budget?.dispatchTarget ?? null,
    expansionRound: state.budget?.expansionRound ?? 0,
    expansionLimit: state.budget?.expansionLimit ?? 0,
    tokens: state.usage?.tokens?.totalKnown ?? null,
    pendingSteering: queuedSteering.length,
    deliveredSteering: state.steering?.length ?? 0,
    quietForSec: 0,
    transportQuietForSec: transportQuietSeconds(state, now),
    agents: Object.values(state.activeAgents ?? {}).map((agent) => ({
      stepId: agent.stepId,
      pool: agent.pool ?? null,
      model: agent.model ?? null,
      status: agent.status ?? 'running',
      elapsedSec: secondsBetween(agent.startedAt, agent.finishedAt ?? now.toISOString()),
      silentForSec: agent.stall?.silentForSec ?? null,
      stall: agent.stall?.status ?? null,
      outputBytesObserved: agent.outputBytesObserved ?? 0,
      lastActions: (agent.lastActions ?? []).slice(-3).map((action) => ({
        kind: action.kind ?? 'agent', status: action.status, summary: action.summary ?? null,
      })),
    })),
    terminal: isTerminalWorkflowStatus(state.status) || Boolean(state.finishedAt),
    timing: isTerminalWorkflowStatus(state.status) || state.finishedAt ? timingBreakdown(state) : null,
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
        ? snapshot.status === 'completed' ? 'workflow complete; result ready' : `workflow ended ${snapshot.status}; result ready`
        : `${snapshot.runningCount} running, ${snapshot.waitingCount} waiting`;
      return `${snapshot.terminal ? '■' : heartbeat ? '♡' : '●'} +${formatDuration(snapshot.elapsedSec)} ${state} · ` +
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
      throw new Error(`run "${token}" has no state.json`);
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(250, Math.max(50, intervalMs))));
  }
}

export async function runWorkflowWatch(bullswarmDir, token, {
  intervalMs = 2000,
  heartbeatMs = 60000,
  once = false,
  jsonl = false,
  verbose = false,
  waitForRunMs = 0,
  output = process.stdout,
} = {}) {
  const resolved = await resolveRunWithGrace(bullswarmDir, token, waitForRunMs, intervalMs);
  const statePath = join(resolved.runDir, 'state.json');
  let priorFingerprint = null;
  let priorHumanFingerprint = null;
  let lastPrintedAt = 0;
  let priorSequence = null;
  let pendingEvents = [];
  let lastActivityAt = null;
  while (true) {
    const state = readJson(statePath);
    if (state) {
      const snapshot = watchSnapshot(resolved.runDir, state);
      if (priorSequence == null) {
        // A newly attached watcher has no preceding interval. Start at the
        // durable high-water mark instead of replaying the run lifetime.
        priorSequence = state.events?.sequence ?? state.eventSequence ?? 0;
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
          Date.parse(state.lifecycle?.startedAt ?? state.startedAt ?? '') || Date.now(),
        );
      }
      const newEvents = readEvents(resolved.runDir, { after: priorSequence });
      if (newEvents.length) {
        pendingEvents.push(...newEvents);
        lastActivityAt = Math.max(
          lastActivityAt,
          ...newEvents.map((event) => Date.parse(event.committedAt ?? '') || Date.now()),
        );
        priorSequence = newEvents.at(-1)?.sequence ?? state.events?.sequence ?? state.eventSequence ?? priorSequence;
      }
      snapshot.quietForSec = Math.max(0, Math.floor((Date.now() - lastActivityAt) / 1000));
      const fingerprint = snapshotFingerprint(snapshot);
      const humanFingerprint = humanTransitionFingerprint(snapshot);
      const heartbeat = Date.now() - lastPrintedAt >= heartbeatMs;
      const changed = jsonl || verbose
        ? fingerprint !== priorFingerprint
        : humanFingerprint !== priorHumanFingerprint;
      if (changed || heartbeat || once) {
        output.write(jsonl
          ? `${JSON.stringify({ type: heartbeat && fingerprint === priorFingerprint ? 'heartbeat' : 'progress', ...snapshot })}\n`
          : `${renderWatchSnapshot(snapshot, {
            heartbeat: heartbeat && !changed,
            verbose,
            events: pendingEvents,
          })}\n`);
        priorFingerprint = fingerprint;
        priorHumanFingerprint = humanFingerprint;
        lastPrintedAt = Date.now();
        pendingEvents = [];
      }
      if (snapshot.terminal || once) {
        if (!jsonl && snapshot.terminal) {
          output.write(`outcome: ${snapshot.status}\n`);
          output.write(`next: bullswarm workflow runs result ${snapshot.shortId ?? snapshot.runId} --json\n`);
        }
        return isDeliveredWorkflowStatus(snapshot.status) || once ? 0 : 1;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, Math.max(100, intervalMs)));
  }
}
