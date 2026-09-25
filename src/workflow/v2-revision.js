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
//   `accept` entry (step accept)    accepted: a failed step is recorded as
//                                   succeeded by the caller's choice, or a
//                                   check's failing requirements are accepted;
//                                   a choice is never proof (stage-3 D22)
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
export const REVISION_CHANGE_KINDS = Object.freeze(['added', 'amended', 'restored', 'removed', 'rerun', 'invalidated', 'accepted']);
const ACCEPT_REASON_MAX = 500;
const UNFINISHED = new Set(['failed', 'blocked', 'cancelled', 'interrupted']);

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

// `accept` comes only from the `step accept` verb (normalizeRevisionInput
// refuses it in a file), and is written only when present.
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
    ...(Array.isArray(body.accept) && body.accept.length ? { accept: clone(body.accept) } : {}),
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

// The failed step at the root of why `id` is blocked, or null.
function blockingStep(state, definitions, id, seen = new Set()) {
  for (const dependency of definitions.get(id)?.dependsOn ?? []) {
    if (seen.has(dependency)) continue;
    seen.add(dependency);
    const status = state.actions.find((action) => action.id === dependency)?.status;
    if (status === 'blocked') return blockingStep(state, definitions, dependency, seen) ?? dependency;
    if (UNFINISHED.has(status)) return dependency;
    const deeper = status === 'pending' ? blockingStep(state, definitions, dependency, seen) : null;
    if (deeper) return deeper;
  }
  return null;
}

const currentAttempts = (state, runtime) => (state.attempts ?? [])
  .filter((attempt) => attempt.actionId === runtime.id && attempt.ordinal > (runtime.supersededAttempts ?? 0))
  .sort((left, right) => left.ordinal - right.ordinal);

// A requirement the caller already accepted on `stepId`, still current.
function acceptedOn(runtime, requirement) {
  return (runtime?.acceptance?.requirements ?? []).some((entry) => entry.id === requirement.id
    && String(entry.workRevision) === String(requirement.workRevision));
}

/**
 * The `accept` entries of a `step accept` revision (stage-3 §2.8), checked
 * against the live state. Pure: returns the acceptances to apply, and pushes
 * the §2.8 refusal texts (without the ✗) onto `issues`.
 */
function planAcceptances(state, request, desired, issues) {
  if (request.accept === undefined) return [];
  const token = state.shortId ?? state.runId;
  if (!Array.isArray(request.accept) || request.accept.some((entry) => !plain(entry))) {
    issues.push('revision.accept must be an array of {step, reason, requirements}');
    return [];
  }
  const definitions = new Map(desired.map((action) => [action.id, action]));
  const runtimeById = new Map(state.actions.map((action) => [action.id, action]));
  const requirements = state.ledger?.requirements ?? {};
  const isolated = state.config?.settings?.workspaceMode === 'isolated';
  const planned = [];
  const seen = new Set();
  for (const entry of request.accept) {
    const step = entry.step;
    const reason = typeof entry.reason === 'string' ? entry.reason.trim() : '';
    if (!reason) { issues.push('--reason is required: say why you accept it (it is recorded as evidence "choice")'); continue; }
    if (reason.length > ACCEPT_REASON_MAX || /[\r\n]/.test(reason)) { issues.push(`--reason must be one line of at most ${ACCEPT_REASON_MAX} characters`); continue; }
    if (entry.requirements != null && (!Array.isArray(entry.requirements) || entry.requirements.some((id) => typeof id !== 'string' || !id))) {
      issues.push('revision.accept requirements must be null or an array of requirement ids');
      continue;
    }
    const runtime = runtimeById.get(step);
    const definition = definitions.get(step);
    if (typeof step !== 'string' || !runtime || !definition || runtime.status === 'removed') { issues.push(`run ${token} has no step "${step}"`); continue; }
    if (seen.has(step)) { issues.push(`revision.accept names ${step} twice`); continue; }
    seen.add(step);
    const status = runtime.status;
    if (status === 'running' || status === 'waiting') { issues.push(`step ${step} is still running; wait for it to finish or restart it`); continue; }
    if (status === 'blocked' || status === 'pending') {
      const blocker = blockingStep(state, definitions, step);
      if (status === 'blocked' || blocker) { issues.push(`step ${step} is blocked by ${blocker ?? 'a failed dependency'}; accept or rerun ${blocker ?? 'it'} first`); continue; }
      issues.push(`step ${step} has not run yet; nothing to accept`);
      continue;
    }
    if (status === 'cancelled' || status === 'interrupted') {
      issues.push(`step ${step} did not finish (${status}); run it again with bullswarm workflow resume ${token} or bullswarm workflow step rerun ${token} ${step}`);
      continue;
    }
    const checks = new Set(definition.evidenceFor ?? []);
    const failingIds = [...checks].filter((id) => ['failed', 'blocked'].includes(requirements[id]?.status) && !acceptedOn(runtime, requirements[id]));
    let named = null;
    if (Array.isArray(entry.requirements) && entry.requirements.length) {
      named = [...new Set(entry.requirements)];
      const before = issues.length;
      for (const id of named) {
        if (!checks.has(id)) issues.push(`step ${step} does not check ${id}`);
        else if (!failingIds.includes(id)) issues.push(`requirement ${id} is not failing (${acceptedOn(runtime, requirements[id]) ? 'accepted' : requirements[id]?.status ?? 'unknown'}); nothing to accept`);
      }
      if (issues.length > before) continue;
    }
    const attempts = currentAttempts(state, runtime);
    const requirementEntries = (ids) => ids.map((id) => ({ id, workRevision: requirements[id].workRevision }));
    if (status === 'failed') {
      if (isolated && !checks.size && (definition.ownedFiles ?? []).length) {
        const where = attempts.at(-1)?.cwd ?? 'its private workspace';
        issues.push(`run ${token} is isolated: ${step}'s work is in a retained workspace that was never merged back (${where}); merge it yourself, then accept`);
        continue;
      }
      const last = attempts.at(-1) ?? null;
      planned.push({
        step, reason, kind: 'step',
        attemptId: last?.id ?? null,
        failureKind: last?.failureKind ?? runtime.lastFailure?.kind ?? null,
        outputFile: last?.outputFile ?? null,
        artifactIds: [...(definition.produces ?? [])],
        requirements: named ? requirementEntries(named) : null,
      });
      continue;
    }
    // succeeded: only a check whose requirements are failing has anything to accept.
    const ids = named ?? failingIds;
    if (!ids.length) { issues.push(`step ${step} succeeded and no requirement it checks is failing; nothing to accept`); continue; }
    const earlier = (runtime.acceptance?.requirements ?? []).filter((item) => requirements[item.id] && acceptedOn(runtime, requirements[item.id]) && !ids.includes(item.id));
    planned.push({
      step, reason, kind: 'requirements',
      attemptId: attempts.findLast((attempt) => attempt.status === 'succeeded')?.id ?? null,
      failureKind: null,
      requirements: [...clone(earlier), ...requirementEntries(ids)],
    });
  }
  return planned;
}

/**
 * Compare a requested program with the live plan. Pure: returns what would
 * change, or the issues that reject the revision. `affected` lists the actions
 * whose running agents must be stopped before the revision can apply.
 * `features` (runFeatureFlags of the run's marker) decides how
 * `defaults.verifyRounds` reads: fix cycles in a run with `failureRule`,
 * total review rounds otherwise.
 */
export function planV2Revision(state, request, { pendingSteeringIds = [], features = null } = {}) {
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
  const acceptances = planAcceptances(state, request, desired, issues);
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
  const accepted = acceptances.map((entry) => entry.step);
  const keptIds = new Set(kept);
  for (const id of accepted) if (!keptIds.has(id)) issues.push(`step ${id} is changed by this revision; accept it on its own`);
  if (issues.length) return { ok: false, issues };

  // Everything downstream of a changed step, over the revised graph.
  const dependents = new Map();
  for (const action of desired) for (const dependency of action.dependsOn) {
    if (!dependents.has(dependency)) dependents.set(dependency, []);
    dependents.get(dependency).push(action.id);
  }
  const reached = new Set();
  // An accepted failed step now counts as succeeded: its blocked dependents run.
  const queue = [...amended, ...restored, ...rerun, ...acceptances.filter((entry) => entry.kind === 'step').map((entry) => entry.step)];
  while (queue.length) {
    for (const next of dependents.get(queue.shift()) ?? []) {
      if (reached.has(next)) continue;
      reached.add(next);
      queue.push(next);
    }
  }
  const acceptedIds = new Set(accepted);
  const invalidated = kept.filter((id) => reached.has(id) && !acceptedIds.has(id) && runtimeById.get(id).status !== 'pending');

  const pending = new Set(pendingSteeringIds);
  const steeringIds = (Array.isArray(request.steeringIds) ? request.steeringIds : []).filter((id) => pending.has(id));
  // A budget-only revision is a change: the loop reads defaults.verifyRounds at commit.
  const countsFixes = features?.failureRule === true || features?.failureRule === 1;
  const roundsChange = revisedVerifyRounds(state, request.program, { countsFixes }) !== null;
  // An accept-only revision is a change.
  if (![...added, ...amended, ...restored, ...removed, ...rerun, ...accepted].length && !steeringIds.length && !roundsChange) {
    return { ok: false, issues: ['the revision changes nothing: every action matches the live plan and no finished step is named in rerun'] };
  }
  return {
    ok: true,
    issues: [],
    desired,
    // `accepted` only when used, so a record without it still loads in older builds.
    changes: { added, amended, restored, removed, rerun, invalidated, ...(accepted.length ? { accepted } : {}) },
    ...(acceptances.length ? { acceptances } : {}),
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
    // Rerunning a step undoes an accept (D23); the history stays in state.revisions.
    delete runtime.acceptance;
    if (redefined.has(id)) runtime.programRevision = revision;
  }
  for (const entry of planned.acceptances ?? []) {
    const runtime = runtimeById.get(entry.step);
    const acceptance = {
      evidence: 'choice', reason: entry.reason, attemptId: entry.attemptId, failureKind: entry.failureKind, at, revision,
      ...(entry.requirements ? { requirements: clone(entry.requirements) } : {}),
    };
    if (entry.kind === 'step') {
      Object.assign(runtime, {
        status: 'succeeded', finishedAt: at, lastFailure: null,
        outputFile: entry.outputFile && existsSync(entry.outputFile) ? entry.outputFile : null,
        artifactIds: [...entry.artifactIds],
      });
    }
    runtime.acceptance = acceptance;
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
