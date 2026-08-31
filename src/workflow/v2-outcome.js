import { scheduleV2Actions } from './v2-scheduler.js';
import { validateV2DurableState } from './v2-state.js';

export const V2_GAP_SCHEMA_VERSION = 'bullswarm.workflow.gaps.v2';
export const V2_RESULT_SCHEMA_VERSION = 'bullswarm.workflow.result.v2';

const TERMINAL_ACTION_STATUSES = new Set(['succeeded', 'failed', 'blocked', 'cancelled', 'interrupted']);
const clone = (value) => value === undefined ? undefined : JSON.parse(JSON.stringify(value));

function stateByAction(state) {
  return new Map(state.actions.map((action) => [action.id, action]));
}

function currentEvidence(ledger, requirement) {
  return ledger.evidence
    .filter((record) => record.requirementId === requirement.id
      && record.stale === false
      && record.inspectedRevision === requirement.workRevision)
    .map((record) => ({
      sourceAction: record.sourceAction,
      status: record.status,
      evidence: clone(record.evidence),
      concerns: clone(record.concerns),
      eventSequence: record.eventSequence,
      ...(record.mechanicalFailure ? { mechanicalFailure: clone(record.mechanicalFailure) } : {}),
    }));
}

export function consolidateV2Gaps(state) {
  validateV2DurableState(state);
  const actionStates = stateByAction(state);
  const requirements = state.intent.requirements
    .map((intentRequirement) => {
      const requirement = state.ledger.requirements[intentRequirement.id];
      return {
        id: requirement.id,
        text: intentRequirement.text,
        mandatory: requirement.mandatory,
        status: requirement.status,
        workRevision: requirement.workRevision,
        evidence: currentEvidence(state.ledger, requirement),
      };
    })
    .filter((requirement) => requirement.status !== 'passed');
  const actions = state.program.actions
    .map((definition) => {
      const runtime = actionStates.get(definition.id);
      const status = runtime?.status ?? 'pending';
      if (!['failed', 'blocked', 'cancelled', 'interrupted'].includes(status)) return null;
      return {
        id: definition.id,
        purpose: definition.purpose,
        status,
        affects: clone(definition.affects),
        evidenceFor: clone(definition.evidenceFor),
        failure: clone(runtime?.lastFailure ?? null),
      };
    })
    .filter(Boolean);
  return {
    schemaVersion: V2_GAP_SCHEMA_VERSION,
    intentId: state.intentId,
    programRevision: state.program.revision,
    requirements,
    actions,
    summary: requirements.length
      ? `${requirements.length} requirement${requirements.length === 1 ? '' : 's'} remain unresolved: ${requirements.map((item) => `${item.id}=${item.status}`).join(', ')}`
      : 'No unresolved requirements.',
  };
}

export function evaluateV2Progress(state, { plannerExhausted = false, limitsExhausted = false, terminalReason = null } = {}) {
  validateV2DurableState(state);
  if (state.cancellation.requested) return { status: 'cancelled', terminal: true, reason: state.cancellation.reason ?? 'workflow cancellation requested' };
  const requirements = Object.values(state.ledger.requirements);
  const unresolvedMandatory = requirements.filter((requirement) => requirement.mandatory && requirement.status !== 'passed');
  const settings = state.config.settings;
  const schedule = scheduleV2Actions(
    state.program.actions,
    state.actions,
    {
      concurrency: settings.concurrency ?? settings.maxParallel ?? 1,
      workspaceMode: settings.workspaceMode ?? 'shared',
    },
  );
  const runtimeStates = stateByAction(state);
  const nonterminal = state.program.actions.filter((action) => !TERMINAL_ACTION_STATUSES.has(runtimeStates.get(action.id)?.status ?? 'pending'));

  if (!state.program.actions.length) {
    if (plannerExhausted || limitsExhausted) return { status: 'partial', terminal: true, reason: terminalReason ?? 'planning ended without an executable program', gaps: consolidateV2Gaps(state) };
    return { status: 'needs-planner', terminal: false, boundary: 'initial', reason: 'the goal has not been planned yet' };
  }
  // A hard dispatch/growth limit is stronger than the scheduler's knowledge
  // that work would otherwise be runnable. Once no paid attempt is active,
  // finalize the best evidence-backed partial result instead of spinning on
  // actions the kernel is forbidden to dispatch.
  if (limitsExhausted && !schedule.active.length) {
    return { status: 'partial', terminal: true, reason: terminalReason ?? 'workflow limits ended further useful work', gaps: consolidateV2Gaps(state) };
  }
  if (schedule.active.length || schedule.selected.length || nonterminal.some((action) => schedule.waiting.some((entry) => entry.id === action.id))) {
    return {
      status: 'running', terminal: false,
      active: clone(schedule.active), runnable: clone(schedule.selected), waiting: clone(schedule.waiting), deferred: clone(schedule.deferred),
    };
  }
  if (!unresolvedMandatory.length) {
    return { status: state.lifecycle.resultFile ? 'completed' : 'ready-to-finalize', terminal: Boolean(state.lifecycle.resultFile), reason: 'all mandatory requirements have fresh passing evidence' };
  }
  const gaps = consolidateV2Gaps(state);
  if (plannerExhausted || limitsExhausted) {
    return { status: 'partial', terminal: true, reason: terminalReason ?? (plannerExhausted ? 'planner reported no further useful bounded actions' : 'workflow limits ended further useful work'), gaps };
  }
  return { status: 'needs-planner', terminal: false, boundary: 'gaps', reason: gaps.summary, gaps };
}

export function createV2ResultEnvelope(state, { finishedAt = new Date().toISOString(), plannerExhausted = false, limitsExhausted = false, terminalReason = null } = {}) {
  validateV2DurableState(state);
  const progress = evaluateV2Progress(state, { plannerExhausted, limitsExhausted, terminalReason });
  if (!['ready-to-finalize', 'partial', 'cancelled'].includes(progress.status)) {
    throw new TypeError(`V2 result is not ready: workflow status is ${progress.status}`);
  }
  const status = progress.status === 'ready-to-finalize' ? 'completed' : progress.status;
  const result = {
    schemaVersion: V2_RESULT_SCHEMA_VERSION,
    runId: state.runId,
    shortId: state.shortId,
    intentId: state.intentId,
    goal: state.intent.goal,
    status,
    verified: status === 'completed',
    reason: progress.reason,
    requirements: state.intent.requirements.map((intentRequirement) => {
      const requirement = state.ledger.requirements[intentRequirement.id];
      return {
        id: requirement.id,
        text: intentRequirement.text,
        mandatory: requirement.mandatory,
        status: requirement.status,
        workRevision: requirement.workRevision,
        evidence: currentEvidence(state.ledger, requirement),
      };
    }),
    actions: state.program.actions.map((definition) => {
      const runtime = state.actions.find((action) => action.id === definition.id);
      return {
        id: definition.id,
        purpose: definition.purpose,
        status: runtime?.status ?? 'pending',
        outputFile: runtime?.outputFile ?? null,
        artifactIds: clone(runtime?.artifactIds ?? []),
      };
    }),
    gaps: status === 'completed' ? null : (progress.gaps ?? consolidateV2Gaps(state)),
    usage: clone(state.usage),
    finishedAt,
  };
  validateV2ResultEnvelope(result);
  return clone(result);
}

export function validateV2ResultEnvelope(result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new TypeError('Invalid V2 result envelope: result must be an object');
  const allowed = new Set(['schemaVersion', 'runId', 'shortId', 'intentId', 'goal', 'status', 'verified', 'reason', 'requirements', 'actions', 'gaps', 'usage', 'finishedAt']);
  for (const key of Object.keys(result)) if (!allowed.has(key)) throw new TypeError(`Invalid V2 result envelope: ${key} is not allowed`);
  if (result.schemaVersion !== V2_RESULT_SCHEMA_VERSION) throw new TypeError(`Invalid V2 result envelope: schemaVersion must be ${V2_RESULT_SCHEMA_VERSION}`);
  if (!['completed', 'partial', 'cancelled'].includes(result.status)) throw new TypeError('Invalid V2 result envelope: status is invalid');
  if (result.verified !== (result.status === 'completed')) throw new TypeError('Invalid V2 result envelope: verified does not match status');
  for (const key of ['runId', 'shortId', 'intentId', 'goal', 'reason', 'finishedAt']) if (typeof result[key] !== 'string' || !result[key]) throw new TypeError(`Invalid V2 result envelope: ${key} must be a non-empty string`);
  if (!Array.isArray(result.requirements) || !Array.isArray(result.actions)) throw new TypeError('Invalid V2 result envelope: requirements and actions must be arrays');
  if (result.status === 'completed' && result.requirements.some((requirement) => requirement.mandatory && requirement.status !== 'passed')) throw new TypeError('Invalid V2 result envelope: completed result has an unresolved mandatory requirement');
  if (result.status === 'completed' && result.gaps !== null) throw new TypeError('Invalid V2 result envelope: completed result must not contain gaps');
  if (result.status !== 'completed' && (!result.gaps || result.gaps.schemaVersion !== V2_GAP_SCHEMA_VERSION)) throw new TypeError('Invalid V2 result envelope: partial result requires V2 gaps');
  return true;
}

export function serializeV2ResultEnvelope(result) {
  validateV2ResultEnvelope(result);
  return JSON.stringify(result);
}

export function deserializeV2ResultEnvelope(serialized) {
  if (typeof serialized !== 'string') throw new TypeError('Invalid V2 result envelope: serialized result must be a string');
  let result;
  try { result = JSON.parse(serialized); } catch { throw new TypeError('Invalid V2 result envelope: serialized result must be valid JSON'); }
  validateV2ResultEnvelope(result);
  return clone(result);
}
