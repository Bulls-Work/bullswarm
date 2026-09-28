// `bullswarm workflow events | watch | action | task`: reading a run, one of
// its steps, or a single task, without changing anything.

import { withV2Cancellation } from './v2-cancellation.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveRunId } from './short-id.js';
import { readEvents } from './events.js';
import { routeSummary } from './step-route.js';
import { runWorkflowWatch } from './watch-cli.js';
import { usageLine } from '../help.js';
import { stepPageModel } from './step-model.js';
import { taskStepInput, taskStepModel } from './task-step.js';
import { stepJsonModel } from './step-json.js';
import { listAssignments } from '../lib/assignments.js';
import { flagErrors } from './workflow-flags.js';
import { BULLSWARM_DIR, legacyRunRefusal } from './cli-run-lookup.js';

export function wfEvents(opts) {
  const token = opts.rest[0];
  if (!token) {
    console.error(`usage: ${usageLine(['workflow', 'events'])}`);
    return 2;
  }
  const resolved = resolveRunId(BULLSWARM_DIR(), token);
  if (!resolved) {
    console.error(`✗ no run found for "${token}"`);
    return 1;
  }
  const after = Number(opts.after ?? 0);
  if (!Number.isInteger(after) || after < 0) {
    console.error('✗ --after must be a non-negative integer');
    return 2;
  }
  const events = readEvents(resolved.runDir, { after });
  console.log(JSON.stringify({ action: 'events', runId: resolved.runId, shortId: resolved.shortId, after, count: events.length, events }, null, 2));
  return 0;
}

export async function wfWatch(opts) {
  // A value flag with no value (--heartbeat, --interval, --stall-after,
  // --after, --since) is a usage error, not a silent fall back to the default.
  const flagError = flagErrors(opts, ['workflow', 'watch']);
  if (flagError != null) return flagError;
  const token = opts.rest[0];
  if (!token) {
    console.error(`usage: ${usageLine(['workflow', 'watch'])}`);
    return 2;
  }
  // --classic forces the older heartbeat-based watcher, which has no notion
  // of notable events to wake up on, so it cannot combine with --next.
  if (opts.classic === true && opts.next === true) {
    console.error('✗ --classic cannot combine with --next (--next only applies to event mode)');
    return 2;
  }
  // --until is its own stopping rule and prints only trouble and the outcome.
  let until = null;
  if (opts.until != null) {
    if (!['outcome', 'trouble'].includes(opts.until)) {
      console.error(`✗ --until must be outcome or trouble (got "${opts.until}")`);
      return 2;
    }
    const clash = ['next', 'once', 'classic', 'heartbeat'].filter((flag) => opts[flag] != null);
    if (clash.length) {
      console.error(`✗ --until cannot combine with ${clash.map((flag) => `--${flag}`).join(', ')}: it prints only trouble and the outcome`);
      return 2;
    }
    until = opts.until;
  }
  const intervalSec = Number(opts.interval ?? 2);
  // --heartbeat is opt-in: absent means no periodic line in event mode, and
  // the historical 60s in --once/--classic mode.
  const heartbeatSec = opts.heartbeat == null ? null : Number(opts.heartbeat);
  if (!Number.isFinite(intervalSec) || intervalSec < 0.1 ||
      (heartbeatSec != null && (!Number.isFinite(heartbeatSec) || heartbeatSec < 1))) {
    console.error('✗ --interval must be >= 0.1 seconds and --heartbeat must be >= 1 second');
    return 2;
  }
  const stallAfterSec = Number(opts['stall-after'] ?? 300);
  if (!Number.isFinite(stallAfterSec) || stallAfterSec < 1) {
    console.error('✗ --stall-after must be >= 1 second');
    return 2;
  }
  // Continuity for a relaunched watcher: both values come from the `next:` line
  // the previous --next exit printed.
  let afterSequence = null;
  if (opts.after != null) {
    afterSequence = Number(opts.after);
    if (!Number.isInteger(afterSequence) || afterSequence < 0) {
      console.error('✗ --after must be a non-negative integer');
      return 2;
    }
  }
  let sinceMs = null;
  if (opts.since != null) {
    sinceMs = Date.parse(opts.since);
    if (!Number.isFinite(sinceMs)) {
      console.error('✗ --since must be an ISO 8601 timestamp');
      return 2;
    }
  }
  try {
    return await runWorkflowWatch(BULLSWARM_DIR(), token, {
      intervalMs: intervalSec * 1000,
      heartbeatMs: heartbeatSec == null ? null : heartbeatSec * 1000,
      stallAfterMs: stallAfterSec * 1000,
      afterSequence,
      sinceMs,
      once: opts.once === true,
      next: opts.next === true,
      classic: opts.classic === true,
      jsonl: opts.jsonl === true,
      verbose: opts.verbose === true,
      until,
    });
  } catch (err) {
    console.error(`✗ ${err.message}`);
    return 1;
  }
}

// A V2 run keeps its graph in state.program.actions and its per-action
// bookkeeping in state.actions.
function v2ActionJson(resolved, state, actionId) {
  const action = state.program?.actions?.find((entry) => entry.id === actionId);
  if (!action) throw new Error(`run "${resolved.shortId ?? resolved.runId}" has no action "${actionId}"`);
  const actionState = state.actions?.find((entry) => entry.id === actionId) ?? null;
  const step = stepPageModel({
    runId: resolved.runId,
    shortId: resolved.shortId ?? state.shortId ?? null,
    runDir: resolved.runDir,
    state,
  }, { actionId });
  return {
    action: 'show-action',
    runId: resolved.runId,
    shortId: resolved.shortId ?? null,
    runDir: resolved.runDir,
    actionRecord: {
      id: action.id,
      purpose: action.purpose,
      status: actionState?.status ?? 'unknown',
      // `kind` only when the author supplied one; lane and effort are always
      // the values acceptance resolved, which is what dispatch used.
      ...(action.kind ? { kind: action.kind } : {}),
      ...(action.role ? { role: action.role } : {}),
      ...(action.deliverable ? { deliverable: action.deliverable } : {}),
      lane: action.lane,
      effort: action.effort,
      ...(action.reasoning ? { reasoning: action.reasoning } : {}),
      ...(action.route ? { route: action.route, routeSummary: routeSummary(action.route) } : {}),
      dependsOn: action.dependsOn,
      affects: action.affects,
      evidenceFor: action.evidenceFor,
      ownedFiles: action.ownedFiles,
      inputs: action.inputs ?? [],
      produces: action.produces ?? [],
      programRevision: actionState?.programRevision ?? null,
      outputFile: actionState?.outputFile ?? null,
      artifactIds: actionState?.artifactIds ?? [],
      lastFailure: actionState?.lastFailure ?? null,
      ...(actionState?.acceptance ? { acceptance: actionState.acceptance } : {}),
    },
    // Each attempt as stored, including `retryOf` on one the dispatcher
    // started because of an earlier one (stage 3).
    attempts: (state.attempts ?? []).filter((attempt) => attempt.actionId === actionId),
    events: readEvents(resolved.runDir).filter((event) =>
      event.payload?.actionId === actionId || event.payload?.parentId === actionId),
    step: stepJsonModel(step),
  };
}

export function wfAction(opts) {
  const [sub, token, actionId] = opts.rest;
  if (sub !== 'show' || !token || !actionId) {
    console.error(`usage: ${usageLine(['workflow', 'action', 'show'])}`);
    return 2;
  }
  // The refusal is the same single line every other verb prints; --json asks
  // for the machine form instead.
  const legacy = legacyRunRefusal(token, opts);
  if (legacy !== null) return legacy;
  try {
    const resolved = resolveRunId(BULLSWARM_DIR(), token);
    if (!resolved) throw new Error(`no run found for "${token}"`);
    const state = withV2Cancellation(JSON.parse(readFileSync(join(resolved.runDir, 'state.json'), 'utf8')), resolved.runDir);
    console.log(JSON.stringify(v2ActionJson(resolved, state, actionId), null, 2));
    return 0;
  } catch (err) {
    console.error(`✗ ${err.message}`);
    return 1;
  }
}

function taskRecordFor(home, token) {
  const live = listAssignments(home, { prune: false }).filter((entry) => entry?.source === 'run');
  let finished = [];
  try {
    const state = JSON.parse(readFileSync(join(home, 'state.json'), 'utf8'));
    finished = (state?.decisionLog ?? []).filter((entry) => entry?.kind === 'run' || entry?.source === 'run');
  } catch { /* a home with only a live ledger is still inspectable */ }
  const records = [...live, ...finished];
  const exact = records.find((entry) => entry?.id === token);
  if (exact) return exact;
  const matches = records.filter((entry) => typeof entry?.id === 'string' && entry.id.endsWith(token));
  if (matches.length > 1) throw new Error(`task id "${token}" is ambiguous`);
  return matches[0] ?? null;
}

/** Read one standalone task through the dashboard's shared Step projection. */
export function wfTask(opts, home) {
  const [sub, token] = opts.rest;
  if (sub !== 'show' || !token) {
    console.error(`usage: ${usageLine(['workflow', 'task', 'show'])}`);
    return 2;
  }
  try {
    const taskRecord = taskRecordFor(home, token);
    if (!taskRecord) throw new Error(`no task found for "${token}"`);
    const input = taskStepInput(taskRecord, { runsDir: join(home, 'runs') });
    const attempt = input.row.state.attempts[0] ?? null;
    const actionRecord = input.row.state.actions[0] ?? null;
    const step = stepJsonModel(taskStepModel(input));
    console.log(JSON.stringify({
      action: 'show-task',
      taskId: taskRecord.id ?? null,
      taskRecord,
      actionRecord,
      attempts: attempt ? [attempt] : [],
      events: [],
      step,
    }, null, 2));
    return 0;
  } catch (err) {
    console.error(`✗ ${err.message}`);
    return 1;
  }
}
