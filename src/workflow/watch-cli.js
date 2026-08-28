// Low-noise, non-interactive workflow progress watcher.
// Prints only semantic changes plus a periodic heartbeat, then a timing
// breakdown at terminal status. This is intentionally distinct from the
// full-screen TUI and the machine-oriented events replay API.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveRunId } from './short-id.js';
import { readSteering } from './steering.js';
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
  const attempts = (state.attempts ?? []).map((attempt) => ({
    actionId: attempt.actionId,
    attemptNumber: attempt.attemptNumber,
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
    workflowElapsedSec: secondsBetween(state.startedAt, state.finishedAt),
    attempts,
    byPool,
  };
}

export function watchSnapshot(runDir, state, now = new Date()) {
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

export function renderWatchSnapshot(snapshot, { heartbeat = false } = {}) {
  const target = snapshot.dispatchTarget == null ? '∞' : snapshot.dispatchTarget;
  const location = [snapshot.phase, snapshot.step].filter(Boolean).join('/') || 'starting';
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

export async function runWorkflowWatch(bullswarmDir, token, {
  intervalMs = 2000,
  heartbeatMs = 60000,
  once = false,
  jsonl = false,
  output = process.stdout,
} = {}) {
  const resolved = resolveRunId(bullswarmDir, token);
  if (!resolved) throw new Error(`no run found for "${token}"`);
  const statePath = join(resolved.runDir, 'state.json');
  if (!existsSync(statePath)) throw new Error(`run "${token}" has no state.json`);
  let priorFingerprint = null;
  let lastPrintedAt = 0;
  while (true) {
    const state = readJson(statePath);
    if (state) {
      const snapshot = watchSnapshot(resolved.runDir, state);
      const fingerprint = snapshotFingerprint(snapshot);
      const heartbeat = Date.now() - lastPrintedAt >= heartbeatMs;
      if (fingerprint !== priorFingerprint || heartbeat || once) {
        output.write(jsonl
          ? `${JSON.stringify({ type: heartbeat && fingerprint === priorFingerprint ? 'heartbeat' : 'progress', ...snapshot })}\n`
          : `${renderWatchSnapshot(snapshot, { heartbeat: heartbeat && fingerprint === priorFingerprint })}\n`);
        priorFingerprint = fingerprint;
        lastPrintedAt = Date.now();
      }
      if (snapshot.terminal || once) return isDeliveredWorkflowStatus(snapshot.status) || once ? 0 : 1;
    }
    await new Promise((resolve) => setTimeout(resolve, Math.max(100, intervalMs)));
  }
}
