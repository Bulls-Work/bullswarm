// A caller's step restart: the intent file beside the run, and how the
// kernel requeues the step and hands its next attempt the stopped one.
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { handoffBlock } from './retry-handoff.js';
import { durableAttemptHandoff } from './dispatch-handoff.js';

// --- Caller-driven step restart ----------------------------------------------
// `bullswarm workflow step restart <run> <step> [--pool <pool>]` never edits a
// live kernel's state: like pause, it writes one intent next to the run. The
// kernel stops that step's running attempt (stop kind `restarted`), puts the
// step straight back in the queue, and the step's next attempt carries the
// stopped attempt's durable handoff block — on the named pool when one was
// given. The intent stays on disk until that next attempt starts, so a kernel
// that dies in between still hands off (and pins the pool) on resume. Nothing
// ever restarts a step automatically.

const STEP_ID = /^[a-z0-9][a-z0-9-]*$/;
const RESTART_FILE = /^restart-([a-z0-9][a-z0-9-]*)\.json$/;

export function stepRestartPath(runDir, actionId) {
  if (!STEP_ID.test(actionId ?? '')) throw new TypeError(`step id must be a kebab-case ID (got "${actionId}")`);
  return join(runDir, `restart-${actionId}.json`);
}

function writeRestart(path, request) {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(request, null, 2)}\n`);
  renameSync(tmp, path);
}

/**
 * Record a restart intent for one step. A newer request replaces an older one.
 * `step rerun` (stage 3, D20) writes one already applied (`appliedAt`), with
 * `source: 'step-rerun'` and the `revisionRequestId` of the revision it
 * belongs to; it counts only once that revision is applied.
 */
export function requestStepRestart(runDir, {
  actionId, attemptId = null, pool = null, source = 'cli',
  now = () => new Date().toISOString(), id = null,
  revisionRequestId = null, appliedAt = null,
} = {}) {
  const request = {
    schemaVersion: 1,
    id: id ?? `restart-${randomUUID().slice(0, 8)}`,
    actionId, attemptId, pool: pool || null, source,
    ...(revisionRequestId ? { revisionRequestId } : {}),
    requestedAt: now(), appliedAt: appliedAt || null,
  };
  writeRestart(stepRestartPath(runDir, actionId), request);
  return request;
}

/** Every restart intent in the run directory, oldest first. */
export function readStepRestarts(runDir) {
  let names = [];
  try { names = readdirSync(runDir); } catch { return []; }
  const requests = [];
  for (const name of names) {
    const match = RESTART_FILE.exec(name);
    if (!match) continue;
    try {
      const request = JSON.parse(readFileSync(join(runDir, name), 'utf8'));
      if (request?.actionId === match[1]) requests.push(request);
    } catch { /* a half-written intent is read on the next poll */ }
  }
  return requests.sort((a, b) => String(a.requestedAt).localeCompare(String(b.requestedAt)));
}

/** The kernel has stopped and requeued the step; the intent now waits for its next attempt. */
export function markStepRestartApplied(runDir, request, { at, attemptId = request.attemptId } = {}) {
  const applied = { ...request, attemptId: attemptId ?? null, appliedAt: at };
  writeRestart(stepRestartPath(runDir, request.actionId), applied);
  return applied;
}

export function clearStepRestart(runDir, actionId) {
  try { rmSync(stepRestartPath(runDir, actionId), { force: true }); } catch { /* already gone */ }
}

/**
 * Put a restarted step back in the queue. The kernel calls this once the
 * step's running attempt has stopped (or when no attempt was running, e.g. a
 * resume after the kernel died). Returns {requeued, why, attemptId, stoppedPool}.
 */
export function requeueRestartedStep(state, request) {
  const runtime = (state.actions ?? []).find((entry) => entry.id === request.actionId);
  if (!runtime) return { requeued: false, why: `the plan has no step ${request.actionId}` };
  if (runtime.status === 'succeeded') return { requeued: false, why: 'it finished before the restart took effect' };
  if (runtime.status === 'removed') return { requeued: false, why: 'a plan revision removed it' };
  if (runtime.status === 'running') return { requeued: false, why: 'its attempt is still running' };
  const stopped = (request.attemptId ? (state.attempts ?? []).find((attempt) => attempt.id === request.attemptId) : null)
    ?? (state.attempts ?? []).findLast((attempt) => attempt.actionId === request.actionId);
  if (['cancelled', 'interrupted', 'failed', 'blocked'].includes(runtime.status)) {
    Object.assign(runtime, { status: 'pending', finishedAt: null, lastFailure: null });
  }
  return { requeued: true, why: null, attemptId: stopped?.id ?? null, stoppedPool: stopped?.pool ?? null };
}

// D20: a `step rerun` intent is live only once its revision is applied. A
// queued revision the kernel later rejected must not hand a stale handoff to
// a later `plan revise --rerun`.
function stepRerunRevisionApplied(state, revisionRequestId) {
  if (typeof revisionRequestId !== 'string' || !revisionRequestId) return false;
  return (state?.revisions ?? []).some((record) => record?.id === revisionRequestId && record.status === 'applied');
}

/**
 * The applied restart intent for a step about to be dispatched, and the
 * handoff block its next attempt carries (built from the stopped attempt's
 * durable facts, exactly as a mechanical retry's would be).
 */
export function appliedStepRestart(state, runDir, actionId, formatHandoff = handoffBlock) {
  const request = readStepRestarts(runDir).find((entry) => entry.actionId === actionId && entry.appliedAt
    && (entry.source !== 'step-rerun' || stepRerunRevisionApplied(state, entry.revisionRequestId)));
  if (!request) return null;
  const stopped = request.attemptId
    ? (state.attempts ?? []).find((attempt) => attempt.id === request.attemptId)
    : (state.attempts ?? []).findLast((attempt) => attempt.actionId === actionId);
  return { request, pool: request.pool ?? null, attempt: stopped ?? null, handoff: stopped ? durableAttemptHandoff(stopped, runDir, formatHandoff) : null };
}
