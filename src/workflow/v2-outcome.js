import { scheduleV2Actions } from './v2-scheduler.js';
import { validateV2DurableState } from './v2-state.js';
import { hasPassingRequirementEvidence, isProgramWorkflow, v2SchedulingOptions } from './execution-policy.js';

export const V2_GAP_SCHEMA_VERSION = 'bullswarm.workflow.gaps.v2';
export const V2_RESULT_SCHEMA_VERSION = 'bullswarm.workflow.result.v2';

const TERMINAL_ACTION_STATUSES = new Set(['succeeded', 'failed', 'blocked', 'cancelled', 'interrupted']);
const ACTION_STATUSES = new Set(['pending', 'ready', 'running', 'waiting', ...TERMINAL_ACTION_STATUSES]);
const REQUIREMENT_STATUSES = new Set(['pending', 'passed', 'failed', 'blocked']);
const clone = (value) => value === undefined ? undefined : JSON.parse(JSON.stringify(value));

function resultFail(message) { throw new TypeError(`Invalid V2 result envelope: ${message}`); }
function resultObject(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) resultFail(`${name} must be an object`);
}
function resultString(value, name) {
  if (typeof value !== 'string' || !value) resultFail(`${name} must be a non-empty string`);
}
function exactFields(value, allowed, name) {
  for (const key of Object.keys(value)) if (!allowed.has(key)) resultFail(`${name}.${key} is not allowed`);
}
function stringArray(value, name) {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string' || !entry)) resultFail(`${name} must be an array of non-empty strings`);
}
function revision(value, name) {
  if ((typeof value !== 'string' && typeof value !== 'number') || value === '') resultFail(`${name} must be a string or number`);
}

function failureSummary(value, name) {
  resultObject(value, name);
  exactFields(value, new Set(['kind', 'message']), name);
  resultString(value.kind, `${name}.kind`);
  if (value.message !== undefined) resultString(value.message, `${name}.message`);
}

function publicFailure(value) {
  if (!value) return null;
  return {
    kind: value.kind,
    ...(value.message ? { message: value.message } : {}),
  };
}

function validateResultEvidence(value, name) {
  resultObject(value, name);
  exactFields(value, new Set(['sourceAction', 'status', 'evidence', 'concerns', 'eventSequence', 'mechanicalFailure']), name);
  resultString(value.sourceAction, `${name}.sourceAction`);
  if (!REQUIREMENT_STATUSES.has(value.status)) resultFail(`${name}.status is invalid`);
  stringArray(value.evidence, `${name}.evidence`);
  stringArray(value.concerns, `${name}.concerns`);
  if (!Number.isInteger(value.eventSequence) || value.eventSequence < 0) resultFail(`${name}.eventSequence must be a non-negative integer`);
  if (value.mechanicalFailure !== undefined) failureSummary(value.mechanicalFailure, `${name}.mechanicalFailure`);
}

function validateResultRequirement(value, name) {
  resultObject(value, name);
  exactFields(value, new Set(['id', 'text', 'mandatory', 'status', 'workRevision', 'evidence']), name);
  resultString(value.id, `${name}.id`);
  resultString(value.text, `${name}.text`);
  if (typeof value.mandatory !== 'boolean') resultFail(`${name}.mandatory must be a boolean`);
  if (!REQUIREMENT_STATUSES.has(value.status)) resultFail(`${name}.status is invalid`);
  revision(value.workRevision, `${name}.workRevision`);
  if (!Array.isArray(value.evidence)) resultFail(`${name}.evidence must be an array`);
  value.evidence.forEach((entry, index) => validateResultEvidence(entry, `${name}.evidence[${index}]`));
}

function validateResultBytes(value, name) {
  if (value === undefined || value === null) return;
  resultObject(value, name);
  exactFields(value, new Set(['taskFile', 'authorPrompt', 'kernel', 'dependencyInputs', 'output']), name);
  for (const field of ['taskFile', 'authorPrompt', 'kernel', 'dependencyInputs', 'output']) {
    if (value[field] === undefined || (value[field] !== null && (!Number.isInteger(value[field]) || value[field] < 0))) {
      resultFail(`${name}.${field} must be null or a non-negative integer`);
    }
  }
}

function validateResultUsageBytes(value, name) {
  if (value === undefined || value === null) return;
  resultObject(value, name);
  exactFields(value, new Set(['taskFiles', 'dependencyInputs', 'outputs']), name);
  for (const field of ['taskFiles', 'dependencyInputs', 'outputs']) {
    if (value[field] === undefined || (value[field] !== null && (!Number.isInteger(value[field]) || value[field] < 0))) {
      resultFail(`${name}.${field} must be null or a non-negative integer`);
    }
  }
}

function validateResultAction(value, name) {
  resultObject(value, name);
  exactFields(value, new Set(['id', 'purpose', 'status', 'outputFile', 'artifactIds', 'failure', 'reasoning', 'kind', 'bytes']), name);
  resultString(value.id, `${name}.id`);
  resultString(value.purpose, `${name}.purpose`);
  if (!ACTION_STATUSES.has(value.status)) resultFail(`${name}.status is invalid`);
  if (value.outputFile !== null && (typeof value.outputFile !== 'string' || !value.outputFile)) resultFail(`${name}.outputFile must be null or a non-empty string`);
  stringArray(value.artifactIds, `${name}.artifactIds`);
  if (value.failure !== undefined && value.failure !== null) failureSummary(value.failure, `${name}.failure`);
  // Optional so envelopes written before reasoning levels existed still
  // deserialize; absent and null both mean "no level was applied".
  if (value.reasoning !== undefined && value.reasoning !== null) resultObject(value.reasoning, `${name}.reasoning`);
  // Same optionality for `kind`: envelopes written before program actions
  // could state a work nature carry neither the field nor a null.
  if (value.kind !== undefined && value.kind !== null) resultString(value.kind, `${name}.kind`);
  validateResultBytes(value.bytes, `${name}.bytes`);
}

function validateGaps(value, result) {
  resultObject(value, 'gaps');
  exactFields(value, new Set(['schemaVersion', 'intentId', 'programRevision', 'requirements', 'actions', 'summary']), 'gaps');
  if (value.schemaVersion !== V2_GAP_SCHEMA_VERSION) resultFail(`gaps.schemaVersion must be ${V2_GAP_SCHEMA_VERSION}`);
  if (value.intentId !== result.intentId) resultFail('gaps.intentId must match result.intentId');
  if (!Number.isInteger(value.programRevision) || value.programRevision < 0) resultFail('gaps.programRevision must be a non-negative integer');
  resultString(value.summary, 'gaps.summary');
  if (!Array.isArray(value.requirements) || !Array.isArray(value.actions)) resultFail('gaps.requirements and gaps.actions must be arrays');
  value.requirements.forEach((entry, index) => validateResultRequirement(entry, `gaps.requirements[${index}]`));
  value.actions.forEach((entry, index) => {
    resultObject(entry, `gaps.actions[${index}]`);
    exactFields(entry, new Set(['id', 'purpose', 'status', 'affects', 'evidenceFor', 'failure']), `gaps.actions[${index}]`);
    resultString(entry.id, `gaps.actions[${index}].id`);
    resultString(entry.purpose, `gaps.actions[${index}].purpose`);
    if (!['failed', 'blocked', 'cancelled', 'interrupted'].includes(entry.status)) resultFail(`gaps.actions[${index}].status is invalid`);
    stringArray(entry.affects, `gaps.actions[${index}].affects`);
    stringArray(entry.evidenceFor, `gaps.actions[${index}].evidenceFor`);
    if (entry.failure !== null) failureSummary(entry.failure, `gaps.actions[${index}].failure`);
  });
}

function stateByAction(state) {
  return new Map(state.actions.map((action) => [action.id, action]));
}

// The reasoning record of the LAST attempt for an action: a retry can land on
// another connector with another level, and the last attempt is the one whose
// output the envelope reports.
function lastAttemptReasoning(state, actionId) {
  const attempt = state.attempts?.findLast((entry) => entry.actionId === actionId) ?? null;
  return clone(attempt?.reasoning ?? null);
}

function normalizeBytes(value) {
  if (value === undefined || value === null) return null;
  return Object.fromEntries(['taskFile', 'authorPrompt', 'kernel', 'dependencyInputs', 'output']
    .map((field) => [field, value[field] ?? null]));
}

function lastAttemptBytes(state, actionId) {
  const attempt = state.attempts?.findLast((entry) => entry.actionId === actionId) ?? null;
  return normalizeBytes(attempt?.bytes);
}

function allAttemptRecords(state) {
  return [
    ...(state.preflight?.scout?.attempts ?? []),
    ...(state.planner?.attempts ?? []),
    ...(state.attempts ?? []),
  ];
}

function aggregateAttemptBytes(state) {
  const records = allAttemptRecords(state).filter((attempt) => attempt.bytes && typeof attempt.bytes === 'object');
  if (!records.length) return null;
  const totals = { taskFiles: null, dependencyInputs: null, outputs: null };
  const fields = [['taskFile', 'taskFiles'], ['dependencyInputs', 'dependencyInputs'], ['output', 'outputs']];
  let recorded = false;
  for (const attempt of records) {
    for (const [source, target] of fields) {
      const value = attempt.bytes[source];
      if (!Number.isInteger(value) || value < 0) continue;
      totals[target] = (totals[target] ?? 0) + value;
      recorded = true;
    }
  }
  return recorded ? totals : null;
}

function resultUsage(state) {
  const usage = clone(state.usage);
  usage.bytes = usage.bytes == null ? aggregateAttemptBytes(state) : {
    taskFiles: usage.bytes.taskFiles ?? null,
    dependencyInputs: usage.bytes.dependencyInputs ?? null,
    outputs: usage.bytes.outputs ?? null,
  };
  return usage;
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
      ...(record.mechanicalFailure ? { mechanicalFailure: publicFailure(record.mechanicalFailure) } : {}),
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
        failure: publicFailure(runtime?.lastFailure),
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
  const schedule = scheduleV2Actions(
    state.program.actions,
    state.actions,
    v2SchedulingOptions(state),
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
  if (isProgramWorkflow(state)) {
    const unsuccessful = state.program.actions.filter((action) => runtimeStates.get(action.id)?.status !== 'succeeded');
    return unsuccessful.length
      ? { status: 'partial', terminal: true, reason: `program finished with ${unsuccessful.length} unsuccessful action(s)`, gaps: consolidateV2Gaps(state) }
      : { status: state.lifecycle.resultFile ? 'completed' : 'ready-to-finalize', terminal: Boolean(state.lifecycle.resultFile), reason: 'all program actions finished successfully; consult evidence for verification' };
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

export function createV2ResultEnvelope(state, { finishedAt = new Date().toISOString(), plannerExhausted = false, limitsExhausted = false, terminalReason = null, workspace = null } = {}) {
  validateV2DurableState(state);
  const progress = evaluateV2Progress(state, { plannerExhausted, limitsExhausted, terminalReason });
  if (!['ready-to-finalize', 'partial', 'cancelled'].includes(progress.status)) {
    throw new TypeError(`V2 result is not ready: workflow status is ${progress.status}`);
  }
  const status = progress.status === 'ready-to-finalize' ? 'completed' : progress.status;
  const program = isProgramWorkflow(state);
  const verified = status === 'completed' && (!program || hasPassingRequirementEvidence(state));
  const result = {
    schemaVersion: V2_RESULT_SCHEMA_VERSION,
    runId: state.runId,
    shortId: state.shortId,
    intentId: state.intentId,
    goal: state.intent.goal,
    status,
    verified,
    ...(program ? { executionMode: 'program', ...(workspace ? { workspace: clone(workspace) } : {}) } : {}),
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
        // The level the attempt that produced this action's output actually
        // ran at, so a consumer of the envelope alone can see how hard the
        // worker thought without re-reading durable state.
        reasoning: lastAttemptReasoning(state, definition.id),
        // The work nature the author stated, when they stated one. Lane and
        // effort are derived from it at acceptance and already visible on the
        // durable action; `kind` is what a reader needs to know WHY.
        kind: definition.kind ?? null,
        bytes: lastAttemptBytes(state, definition.id),
        ...(program ? { failure: publicFailure(runtime?.lastFailure) } : {}),
      };
    }),
    gaps: status === 'completed' && verified ? null : (progress.gaps ?? consolidateV2Gaps(state)),
    usage: resultUsage(state),
    finishedAt,
  };
  validateV2ResultEnvelope(result);
  return clone(result);
}

function firstLine(value, limit) {
  if (value === undefined || value === null) return null;
  const line = String(value).split(/\r?\n/, 1)[0].trim().slice(0, limit);
  return line || null;
}

function latestAttemptFor(state, actionId) {
  return [
    ...(state?.preflight?.scout?.attempts ?? []),
    ...(state?.planner?.attempts ?? []),
    ...(state?.attempts ?? []),
  ].findLast((attempt) => attempt.actionId === actionId) ?? null;
}

function stateActionFor(state, actionId) {
  return state?.program?.actions?.find((action) => action.id === actionId) ?? null;
}

function fallback(value, alternate) {
  return value === undefined || value === null ? alternate ?? null : value;
}

function compactActionValue(value) {
  return typeof value === 'string' && value.includes('/') ? value.split('/').at(-1) : value;
}

function appliedReasoning(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value.applied ?? null;
  return value ?? null;
}

function dropNullFields(value) {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== null));
}

const RESULT_SUMMARY_BYTE_BUDGET = 4096;
const RESULT_SUMMARY_FIT_LIMITS = [
  [200, 160, 3], [200, 80, 3], [200, 40, 3], [200, 80, 1], [200, 40, 1], [200, 0, 0],
  [120, 80, 3], [120, 0, 0],
  [80, 80, 1], [80, 0, 0],
  [40, 0, 0], [0, 0, 0],
];

function summarySize(summary) {
  return Buffer.byteLength(JSON.stringify(summary), 'utf8');
}

function fitResultSummary(summary) {
  const basename = (actions) => actions.map((action) => ({
    ...action,
    outFile: compactActionValue(action.outFile),
  }));
  const whyAt = (limit) => summary.requirements.map((requirement) => ({
    ...requirement,
    why: firstLine(requirement.why, limit),
  }));
  const concernsAt = (limit, count) => ({
    count: summary.concerns.count,
    first: summary.concerns.first.slice(0, count).map((concern) => firstLine(concern, limit)).filter(Boolean),
  });
  const nextFor = (actions) => ({
    ...summary.next,
    outputs: actions.map((action) => action.outFile).filter(Boolean),
  });
  const candidates = [];
  const consider = (actions, requirements, concerns) => {
    candidates.push({
      ...summary,
      actions,
      requirements,
      concerns,
      next: nextFor(actions),
    });
  };

  // Output paths are always basenames under `next.runDir`: one directory
  // string instead of N absolute prefixes, and the summary's size no longer
  // depends on where the home lives.
  const named = basename(summary.actions);
  consider(named, summary.requirements, summary.concerns);
  const omitted = named.map(dropNullFields);
  consider(omitted, summary.requirements, summary.concerns);
  for (const [whyLimit, concernLimit, concernCount] of RESULT_SUMMARY_FIT_LIMITS) {
    consider(omitted, whyAt(whyLimit), concernsAt(concernLimit, concernCount));
  }

  return candidates.find((candidate) => summarySize(candidate) < RESULT_SUMMARY_BYTE_BUDGET) ?? candidates.at(-1);
}

function runDirOf(actions, runDir) {
  if (typeof runDir === 'string' && runDir) return runDir;
  const sample = actions.map((action) => action.outFile).find((file) => typeof file === 'string' && file.includes('/'));
  return sample ? sample.slice(0, sample.lastIndexOf('/')) : null;
}

export function summarizeV2Result(envelope, state = null, { runDir = null } = {}) {
  const concerns = envelope.requirements.flatMap((requirement) =>
    requirement.evidence.flatMap((entry) => entry.concerns ?? []));
  const shortId = envelope.shortId ?? envelope.runId;
  const actions = envelope.actions.map((action) => {
    const definition = stateActionFor(state, action.id);
    const attempt = latestAttemptFor(state, action.id);
    return {
      id: action.id,
      kind: fallback(action.kind, definition?.kind),
      lane: fallback(action.lane, definition?.lane),
      effort: fallback(action.effort, definition?.effort),
      status: action.status,
      pool: fallback(action.pool, attempt?.pool),
      model: fallback(action.model, attempt?.model),
      reasoning: appliedReasoning(fallback(action.reasoning, attempt?.reasoning)),
      wallSec: fallback(action.wallSec, attempt?.wallSec),
      outFile: fallback(action.outFile, fallback(action.outputFile, attempt?.outputFile)),
      bytes: normalizeBytes(fallback(action.bytes, attempt?.bytes)),
    };
  });
  return fitResultSummary({
    schemaVersion: 'bullswarm.workflow.result-summary.v1',
    runId: envelope.runId,
    shortId: envelope.shortId,
    status: envelope.status,
    verified: envelope.verified,
    executionMode: envelope.executionMode ?? null,
    reason: envelope.reason,
    finishedAt: envelope.finishedAt,
    goal: firstLine(envelope.goal, 120),
    goalBytes: Buffer.byteLength(String(envelope.goal ?? ''), 'utf8'),
    requirements: envelope.requirements.map((requirement) => ({
      id: requirement.id,
      status: requirement.status,
      mandatory: requirement.mandatory,
      evidenceCount: requirement.evidence.length,
      why: firstLine(requirement.evidence.at(-1)?.evidence?.[0], 200),
    })),
    actions,
    concerns: {
      count: concerns.length,
      first: concerns.slice(0, 3).map((concern) => firstLine(concern, 160)).filter(Boolean),
    },
    usage: clone(envelope.usage),
    next: {
      full: `bullswarm workflow runs result ${shortId} --json`,
      // Every entry of `outputs` (and every action's outFile) is a basename
      // inside this directory.
      runDir: runDirOf(actions, runDir),
      outputs: actions.map((action) => action.outFile).filter(Boolean),
    },
  });
}

export function validateV2ResultEnvelope(result) {
  resultObject(result, 'result');
  const allowed = new Set(['schemaVersion', 'runId', 'shortId', 'intentId', 'goal', 'status', 'verified', 'reason', 'requirements', 'actions', 'gaps', 'usage', 'finishedAt', 'executionMode', 'workspace']);
  exactFields(result, allowed, 'result');
  if (result.schemaVersion !== V2_RESULT_SCHEMA_VERSION) resultFail(`schemaVersion must be ${V2_RESULT_SCHEMA_VERSION}`);
  if (!['completed', 'partial', 'cancelled'].includes(result.status)) resultFail('status is invalid');
  if (result.executionMode !== undefined && result.executionMode !== 'program') resultFail('executionMode must be program when present');
  const program = result.executionMode === 'program';
  if (typeof result.verified !== 'boolean' || (!program && result.verified !== (result.status === 'completed')) || (result.verified && result.status !== 'completed')) resultFail('verified does not match status');
  for (const key of ['runId', 'shortId', 'intentId', 'goal', 'reason', 'finishedAt']) resultString(result[key], key);
  if (Number.isNaN(Date.parse(result.finishedAt))) resultFail('finishedAt must be an ISO-compatible timestamp');
  if (!Array.isArray(result.requirements) || !Array.isArray(result.actions)) resultFail('requirements and actions must be arrays');
  result.requirements.forEach((entry, index) => validateResultRequirement(entry, `requirements[${index}]`));
  result.actions.forEach((entry, index) => validateResultAction(entry, `actions[${index}]`));
  if (new Set(result.requirements.map((entry) => entry.id)).size !== result.requirements.length) resultFail('requirement ids must be unique');
  if (new Set(result.actions.map((entry) => entry.id)).size !== result.actions.length) resultFail('action ids must be unique');
  resultObject(result.usage, 'usage');
  exactFields(result.usage, new Set(['total', 'byPool', 'bytes']), 'usage');
  validateResultUsageBytes(result.usage.bytes, 'usage.bytes');
  if (!Number.isFinite(result.usage.total) || result.usage.total < 0) resultFail('usage.total must be non-negative');
  resultObject(result.usage.byPool, 'usage.byPool');
  for (const [pool, total] of Object.entries(result.usage.byPool)) {
    resultString(pool, 'usage.byPool key');
    if (!Number.isFinite(total) || total < 0) resultFail(`usage.byPool.${pool} must be non-negative`);
  }
  if (result.verified && result.requirements.some((requirement) => requirement.mandatory && requirement.status !== 'passed')) resultFail('verified result has an unresolved mandatory requirement');
  if (program && result.status === 'completed' && (!result.actions.length || result.actions.some((action) => action.status !== 'succeeded'))) resultFail('completed program must have successful actions');
  if (result.verified && result.gaps !== null) resultFail('verified result must not contain gaps');
  if (!result.verified) validateGaps(result.gaps, result);
  if (result.workspace !== undefined) {
    if (!program) resultFail('workspace report requires program execution');
    resultObject(result.workspace, 'workspace');
    exactFields(result.workspace, new Set(['cwd', 'changedFiles', 'baselineChangedFiles', 'warnings']), 'workspace');
    resultString(result.workspace.cwd, 'workspace.cwd');
    for (const key of ['changedFiles', 'baselineChangedFiles', 'warnings']) stringArray(result.workspace[key], `workspace.${key}`);
  }
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
