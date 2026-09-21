// Live plan revisions. The caller of a program-mode workflow can rewrite its
// plan at any time — while agents are running, while the run is paused, or
// after it finished — by submitting the whole program it wants now. The kernel
// compares that program with the live plan by action id and makes the run
// match it:
//
//   new id                          added: runs once its dependencies succeed
//   same id, same definition        kept: a finished result is reused, a
//                                   running agent keeps running
//   same id, changed definition     amended: a running agent is stopped and the
//                                   step starts over with the new definition
//   id listed in `rerun`            rerun: its result is discarded and it runs again
//   id missing from the program     removed: a running agent is stopped; the step
//                                   never runs again and no longer counts toward
//                                   the result, but its history stays
//   dependents of an amended,       invalidated: they consumed inputs that are
//   restored, or rerun step         about to change, so they run again too
//
// Planning a revision is pure. Applying one mutates the given state in place,
// on purpose: a live kernel's running actions hold references to their own
// runtime records, and those must stay the records the new plan uses.

import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { writeJsonAtomic } from '../lib/fsjson.js';
import { ACTION_PROGRAM_SCHEMA_VERSION, validateActionProgram } from './action-validator.js';
import { isProgramWorkflow, removedActionIds } from './execution-policy.js';
import { discardEvidence } from './ledger.js';
import { deliverSteering } from './steering.js';
import { deriveV2LiveStages } from './v2-presentation.js';
import { v2LiveProgramRuntime, validateV2DurableState } from './v2-state.js';
import { revisedVerifyRounds } from './verify-rounds.js';

export const V2_REVISION_SCHEMA_VERSION = 'bullswarm.workflow.revision.v1';
const PLANNER_RESPONSE_SCHEMA_VERSION = 'bullswarm.workflow.planner-response.v2';
const DOCUMENT_FIELDS = new Set(['schemaVersion', 'baseRevision', 'summary', 'program', 'rerun', 'steeringIds']);
const REQUEST_FILE_RE = /^(rev-[a-z0-9]+-[a-f0-9]{6})\.json$/;
export const REVISION_CHANGE_KINDS = Object.freeze(['added', 'amended', 'restored', 'removed', 'rerun', 'invalidated']);

export class V2RevisionError extends Error {
  constructor(issues) {
    super(`plan revision invalid: ${issues.length} problem(s)`);
    this.name = 'V2RevisionError';
    this.issues = [...issues];
  }
}

const clone = (value) => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const plain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const canonical = (value) => Array.isArray(value)
  ? value.map(canonical)
  : plain(value) ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
const sameDefinition = (left, right) => JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));

function idList(value, name, issues) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string' || !entry)) {
    issues.push(`${name} must be an array of ids`);
    return [];
  }
  return [...new Set(value)];
}

/**
 * Accept what `workflow plan export` writes (a revision document), a bare
 * program, or a kind=program planner response. Values given on the command
 * line win over the document's own; `rerun` lists are merged.
 */
export function normalizeRevisionInput(input, { summary = null, rerun = [], baseRevision = null } = {}) {
  if (!plain(input)) throw new V2RevisionError(['a revision must be a JSON object']);
  const issues = [];
  let document = {};
  let program = null;
  if (input.schemaVersion === V2_REVISION_SCHEMA_VERSION) {
    for (const key of Object.keys(input)) if (!DOCUMENT_FIELDS.has(key)) issues.push(`revision.${key} is not allowed`);
    document = input;
    program = input.program;
    if (!plain(program)) issues.push('revision.program must be a program object');
    if (input.summary !== undefined && typeof input.summary !== 'string') issues.push('revision.summary must be a string');
  } else if (input.schemaVersion === ACTION_PROGRAM_SCHEMA_VERSION) {
    program = input;
  } else if (input.schemaVersion === PLANNER_RESPONSE_SCHEMA_VERSION && input.kind === 'program') {
    program = input.program;
    document = { summary: input.summary };
  } else {
    issues.push(`schemaVersion must be "${V2_REVISION_SCHEMA_VERSION}" (what plan export writes), a bare "${ACTION_PROGRAM_SCHEMA_VERSION}" program, or a kind=program planner response`);
  }
  const base = baseRevision ?? document.baseRevision ?? null;
  if (base !== null && (!Number.isInteger(base) || base < 0)) issues.push('baseRevision must be a non-negative integer');
  const rerunIds = [...new Set([...idList(document.rerun, 'revision.rerun', issues), ...idList(rerun, '--rerun', issues)])];
  const steeringIds = idList(document.steeringIds, 'revision.steeringIds', issues);
  if (issues.length) throw new V2RevisionError(issues);
  const text = [summary, document.summary].find((value) => typeof value === 'string' && value.trim());
  return { summary: text ? text.trim() : null, baseRevision: base, program: clone(program), rerun: rerunIds, steeringIds };
}

export function createRevisionRequest(body, { source = 'cli', now = () => new Date().toISOString() } = {}) {
  return {
    schemaVersion: V2_REVISION_SCHEMA_VERSION,
    id: `rev-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`,
    queuedAt: now(),
    source,
    summary: body.summary ?? null,
    baseRevision: body.baseRevision ?? null,
    program: clone(body.program),
    rerun: [...(body.rerun ?? [])],
    steeringIds: [...(body.steeringIds ?? [])],
  };
}

export function revisionRequestsDir(runDir) {
  return join(runDir, 'revisions');
}

// A request is its own atomically written file, so a live kernel never reads
// half of one and a request survives a kernel that dies before applying it.
export function queueRevisionRequest(runDir, request) {
  const dir = revisionRequestsDir(runDir);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${request.id}.json`);
  writeJsonAtomic(path, request);
  return path;
}

// Requests no kernel has processed yet, oldest first. The file name is the
// request id, so a malformed body still gets recorded (as rejected) under it.
export function pendingRevisionRequests(state, runDir) {
  const dir = revisionRequestsDir(runDir);
  if (!existsSync(dir)) return [];
  const processed = new Set((state.revisions ?? []).map((entry) => entry.id));
  const pending = [];
  for (const name of readdirSync(dir)) {
    const match = REQUEST_FILE_RE.exec(name);
    if (!match || processed.has(match[1])) continue;
    let body;
    try { body = JSON.parse(readFileSync(join(dir, name), 'utf8')); } catch { body = null; }
    pending.push({ ...(plain(body) ? body : {}), id: match[1], queuedAt: plain(body) && typeof body.queuedAt === 'string' ? body.queuedAt : '' });
  }
  return pending.sort((left, right) => left.queuedAt.localeCompare(right.queuedAt) || left.id.localeCompare(right.id));
}

// Stored definitions normalized the way a submitted program is, so an action
// exported and resubmitted untouched is never mistaken for an amendment.
function storedDefinitions(state, removed) {
  const byId = new Map(state.program.actions.map((action) => [action.id, action]));
  const live = state.program.actions.filter((action) => !removed.has(action.id));
  if (!live.length) return byId;
  try {
    const normalized = validateActionProgram(
      { schemaVersion: ACTION_PROGRAM_SCHEMA_VERSION, actions: live },
      v2LiveProgramRuntime(state, { enforceRoutingPolicy: false }),
    ).actions;
    for (const action of normalized) byId.set(action.id, action);
  } catch { /* older durable definitions compare exactly as stored */ }
  return byId;
}

/**
 * Compare a requested program with the live plan. Pure: returns what would
 * change, or the issues that reject the revision. `affected` lists the actions
 * whose running agents must be stopped before the revision can apply.
 */
export function planV2Revision(state, request, { pendingSteeringIds = [] } = {}) {
  validateV2DurableState(state);
  if (!isProgramWorkflow(state)) {
    return { ok: false, issues: ['only program-mode workflows can be revised; this run uses the older verified execution mode'] };
  }
  if (!plain(request) || !plain(request.program)) return { ok: false, issues: ['the revision carries no program object'] };
  const issues = [];
  if (request.baseRevision != null && request.baseRevision !== state.program.revision) {
    issues.push(`the plan changed since revision ${request.baseRevision} (the run is now at revision ${state.program.revision}); export it again and reapply your edits`);
  }
  let desired = [];
  try {
    desired = validateActionProgram(request.program, v2LiveProgramRuntime(state)).actions;
  } catch (error) {
    issues.push(...(Array.isArray(error?.issues) ? error.issues : [error.message]));
  }
  if (issues.length) return { ok: false, issues };

  const runtimeById = new Map(state.actions.map((action) => [action.id, action]));
  const removedBefore = removedActionIds(state);
  const stored = storedDefinitions(state, removedBefore);
  const desiredIds = new Set(desired.map((action) => action.id));
  const requestedRerun = new Set(Array.isArray(request.rerun) ? request.rerun : []);
  for (const id of requestedRerun) {
    if (!desiredIds.has(id)) issues.push(`rerun names "${id}", which is not in the revised program`);
  }
  if (issues.length) return { ok: false, issues };

  const added = [], amended = [], restored = [], rerun = [], kept = [];
  for (const action of desired) {
    const runtime = runtimeById.get(action.id);
    if (!runtime) added.push(action.id);
    else if (runtime.status === 'removed') restored.push(action.id);
    else if (!sameDefinition(action, stored.get(action.id))) amended.push(action.id);
    // Rerunning a step that is still waiting to start changes nothing.
    else if (requestedRerun.has(action.id) && runtime.status !== 'pending') rerun.push(action.id);
    else kept.push(action.id);
  }
  const removed = state.program.actions
    .filter((action) => !removedBefore.has(action.id) && !desiredIds.has(action.id))
    .map((action) => action.id);

  // Everything downstream of a changed step, over the revised graph.
  const dependents = new Map();
  for (const action of desired) for (const dependency of action.dependsOn) {
    if (!dependents.has(dependency)) dependents.set(dependency, []);
    dependents.get(dependency).push(action.id);
  }
  const reached = new Set();
  const queue = [...amended, ...restored, ...rerun];
  while (queue.length) {
    for (const next of dependents.get(queue.shift()) ?? []) {
      if (reached.has(next)) continue;
      reached.add(next);
      queue.push(next);
    }
  }
  const invalidated = kept.filter((id) => reached.has(id) && runtimeById.get(id).status !== 'pending');

  const pending = new Set(pendingSteeringIds);
  const steeringIds = (Array.isArray(request.steeringIds) ? request.steeringIds : []).filter((id) => pending.has(id));
  // A budget-only revision is a change: the loop reads defaults.verifyRounds at commit.
  const roundsChange = revisedVerifyRounds(state, request.program) !== null;
  if (![...added, ...amended, ...restored, ...removed, ...rerun].length && !steeringIds.length && !roundsChange) {
    return { ok: false, issues: ['the revision changes nothing: every action matches the live plan and no finished step is named in rerun'] };
  }
  return {
    ok: true,
    issues: [],
    desired,
    changes: { added, amended, restored, removed, rerun, invalidated },
    affected: [...new Set([...removed, ...amended, ...rerun, ...invalidated])],
    steeringIds,
    nextRevision: state.program.revision + 1,
  };
}

/**
 * Apply a planned revision to `state` in place and return the durable record.
 * The caller persists the state; see commitV2Revision for the file side.
 */
export function applyV2Revision(state, planned, { request, at }) {
  const revision = state.program.revision + 1;
  const desired = new Map(planned.desired.map((action) => [action.id, action]));
  const { added, amended, restored, removed, rerun, invalidated } = planned.changes;
  const redefined = new Set([...amended, ...restored]);
  const previous = new Map(state.program.actions.map((action) => [action.id, action]));

  state.program.actions = state.program.actions.map((action) => (redefined.has(action.id) ? clone(desired.get(action.id)) : action));
  for (const id of added) state.program.actions.push(clone(desired.get(id)));
  state.program.revision = revision;

  const runtimeById = new Map(state.actions.map((action) => [action.id, action]));
  const discardedEvidence = [];
  // Attempts made before this point belong to a superseded definition or a
  // discarded result; recovery never treats them as this step's completion.
  for (const id of [...amended, ...restored, ...rerun, ...invalidated]) {
    const runtime = runtimeById.get(id);
    if (previous.get(id)?.evidenceFor?.length) discardedEvidence.push(id);
    Object.assign(runtime, {
      status: 'pending', startedAt: null, finishedAt: null, outputFile: null, artifactIds: [],
      lastFailure: null, supersededAttempts: runtime.attempts,
    });
    if (redefined.has(id)) runtime.programRevision = revision;
  }
  for (const id of removed) {
    const runtime = runtimeById.get(id);
    if (previous.get(id)?.evidenceFor?.length) discardedEvidence.push(id);
    Object.assign(runtime, { status: 'removed', finishedAt: at, lastFailure: null, supersededAttempts: runtime.attempts });
  }
  for (const id of added) {
    state.actions.push({
      id, status: 'pending', attempts: 0, programRevision: revision, workRevision: state.ledger.workRevision,
      startedAt: null, finishedAt: null, outputFile: null, artifactIds: [], lastFailure: null,
    });
  }
  // A discarded or removed evidence step's judgment no longer counts.
  if (discardedEvidence.length) state.ledger = discardEvidence(state.ledger, discardedEvidence);
  state.presentation.stages = deriveV2LiveStages(state, { revision, at });

  const record = {
    id: request.id,
    status: 'applied',
    source: request.source ?? 'cli',
    queuedAt: request.queuedAt || at,
    processedAt: at,
    summary: request.summary ?? `Plan revision ${revision}`,
    baseRevision: request.baseRevision ?? null,
    programRevision: revision,
    changes: clone(planned.changes),
    steeringIds: [...planned.steeringIds],
    issues: null,
  };
  state.revisions = [...(state.revisions ?? []), record];
  return { state, record };
}

export function rejectedRevisionRecord(request, issues, at) {
  return {
    id: request.id,
    status: 'rejected',
    source: typeof request.source === 'string' && request.source ? request.source : 'cli',
    queuedAt: request.queuedAt || at,
    processedAt: at,
    summary: typeof request.summary === 'string' && request.summary ? request.summary : null,
    baseRevision: Number.isInteger(request.baseRevision) && request.baseRevision >= 0 ? request.baseRevision : null,
    programRevision: null,
    changes: null,
    steeringIds: [],
    issues: [...issues],
  };
}

/**
 * Apply a revision and deliver the steering it acknowledges. Returns the
 * completion receipts that became stale; remove them only after the new state
 * is persisted (removeStaleReceipts), so a crash in between loses nothing.
 */
export function commitV2Revision(state, planned, { request, runDir, at }) {
  const applied = applyV2Revision(state, planned, { request, at });
  const { amended, restored, rerun, invalidated, removed } = planned.changes;
  const deliveredSteering = planned.steeringIds.length
    ? deliverSteering(state, runDir, { ids: planned.steeringIds })
    : [];
  return { ...applied, deliveredSteering, staleReceipts: [...amended, ...restored, ...rerun, ...invalidated, ...removed] };
}

export function removeStaleReceipts(runDir, actionIds) {
  for (const id of actionIds) rmSync(join(runDir, `completion-${id}.json`), { force: true });
}

export function revisionEventPayload(record) {
  return {
    requestId: record.id,
    programRevision: record.programRevision,
    summary: record.summary,
    source: record.source,
    changes: clone(record.changes),
    steeringIds: [...record.steeringIds],
  };
}

/**
 * The editable plan: a revision document holding every live action exactly as
 * the kernel stores it, the revision it was exported at (so a stale edit is
 * refused instead of silently undoing a newer one), and the pending steering
 * the caller has now been shown.
 */
export function exportV2Plan(state, { pendingSteering = [] } = {}) {
  const removed = removedActionIds(state);
  return {
    schemaVersion: V2_REVISION_SCHEMA_VERSION,
    baseRevision: state.program.revision,
    summary: '',
    rerun: [],
    steeringIds: pendingSteering.map((entry) => entry.id),
    program: {
      schemaVersion: ACTION_PROGRAM_SCHEMA_VERSION,
      actions: state.program.actions.filter((action) => !removed.has(action.id)).map(clone),
    },
  };
}
