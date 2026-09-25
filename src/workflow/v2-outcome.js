import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { scheduleV2Actions } from './v2-scheduler.js';
import { NOT_JUDGED_STATUS, verifyLoopResult } from './verify-rounds.js';
import { validateV2DurableState } from './v2-state.js';
import { hasPassingRequirementEvidence, isProgramWorkflow, v2SchedulingOptions } from './execution-policy.js';
import { aggregateAttemptUsage } from './rollup.js';
import { countRetries, declaredEvidence, evidenceResultsIssues } from './step-vocabulary.js';
import { readRunFeatures, runFeatureFlags } from './run-features.js';

export const V2_GAP_SCHEMA_VERSION = 'bullswarm.workflow.gaps.v2';
export const V2_RESULT_SCHEMA_VERSION = 'bullswarm.workflow.result.v2';

const TERMINAL_ACTION_STATUSES = new Set(['succeeded', 'failed', 'blocked', 'cancelled', 'interrupted', 'removed']);
const ACTION_STATUSES = new Set(['pending', 'ready', 'running', 'waiting', ...TERMINAL_ACTION_STATUSES]);
const REQUIREMENT_STATUSES = new Set(['pending', 'passed', 'failed', 'blocked']);
const clone = (value) => value === undefined ? undefined : JSON.parse(JSON.stringify(value));

// Failure kinds a plain retry can fix: the work itself was never judged (no
// pool, a paused pool, a crashed or silent worker, unreadable output). A step
// that failed for any other reason (the worker reported failure, it wrote
// outside its files) needs the caller to change something before it reruns.
export const V2_RETRYABLE_FAILURE_KINDS = Object.freeze([
  'provider', 'quota', 'throttle', 'auth', 'process', 'unavailable', 'interrupted', 'runtime', 'schema', 'stalled',
]);
const RETRYABLE_FAILURE_KINDS = new Set(V2_RETRYABLE_FAILURE_KINDS);
const RERUN_STATUSES = new Set(['pending', 'ready', 'waiting', 'running', 'cancelled', 'interrupted']);

// Which unfinished steps `workflow resume` runs again on a finished run:
// steps that never ran or were stopped, steps whose failure a retry can fix,
// and blocked steps once something they wait on runs again. Everything else is
// listed as needing the caller.
export function v2RetryPlan(state) {
  const runtimeById = new Map((state.actions ?? []).map((action) => [action.id, action]));
  const rerun = [];
  const blocked = [];
  const needsCaller = [];
  for (const definition of state.program?.actions ?? []) {
    const runtime = runtimeById.get(definition.id);
    const status = runtime?.status ?? 'pending';
    const failureKind = runtime?.lastFailure?.kind ?? null;
    if (status === 'succeeded' || status === 'removed') continue;
    if (RERUN_STATUSES.has(status) || (status === 'failed' && RETRYABLE_FAILURE_KINDS.has(failureKind))) rerun.push(definition.id);
    else if (status === 'blocked') blocked.push(definition.id);
    else needsCaller.push({ id: definition.id, status, failureKind });
  }
  if (!rerun.length) {
    for (const id of blocked) needsCaller.push({ id, status: 'blocked', failureKind: runtimeById.get(id)?.lastFailure?.kind ?? 'dependency' });
    return { rerun, blocked: [], needsCaller };
  }
  return { rerun, blocked, needsCaller };
}

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

function nullableNonEmpty(value, name) {
  if (value !== null && (typeof value !== 'string' || !value)) resultFail(`${name} must be null or a non-empty string`);
}

function validateResultEvidence(value, name) {
  resultObject(value, name);
  exactFields(value, new Set(['sourceAction', 'status', 'evidence', 'concerns', 'eventSequence', 'mechanicalFailure', 'reviewer', 'independent']), name);
  resultString(value.sourceAction, `${name}.sourceAction`);
  if (!REQUIREMENT_STATUSES.has(value.status)) resultFail(`${name}.status is invalid`);
  stringArray(value.evidence, `${name}.evidence`);
  stringArray(value.concerns, `${name}.concerns`);
  if (!Number.isInteger(value.eventSequence) || value.eventSequence < 0) resultFail(`${name}.eventSequence must be a non-negative integer`);
  if (value.mechanicalFailure !== undefined) failureSummary(value.mechanicalFailure, `${name}.mechanicalFailure`);
  // Who reviewed (D27): written only by stage-3 kernels.
  if (value.reviewer !== undefined) {
    resultObject(value.reviewer, `${name}.reviewer`);
    exactFields(value.reviewer, new Set(['pool', 'model', 'provider']), `${name}.reviewer`);
    resultString(value.reviewer.pool, `${name}.reviewer.pool`);
    nullableNonEmpty(value.reviewer.model, `${name}.reviewer.model`);
    nullableNonEmpty(value.reviewer.provider, `${name}.reviewer.provider`);
  }
  if (value.independent !== undefined && value.independent !== null && typeof value.independent !== 'boolean') resultFail(`${name}.independent must be true, false or null`);
}

// A caller's choice recorded on a step (D22): never proof.
function validateResultAcceptance(value, name) {
  resultObject(value, name);
  exactFields(value, new Set(['evidence', 'reason', 'at', 'attemptId', 'failureKind', 'requirements']), name);
  if (value.evidence !== 'choice') resultFail(`${name}.evidence must be choice`);
  resultString(value.reason, `${name}.reason`);
  if (typeof value.at !== 'string' || Number.isNaN(Date.parse(value.at))) resultFail(`${name}.at must be an ISO-compatible timestamp`);
  nullableNonEmpty(value.attemptId, `${name}.attemptId`);
  nullableNonEmpty(value.failureKind, `${name}.failureKind`);
  if (value.requirements !== undefined) {
    if (!Array.isArray(value.requirements) || !value.requirements.length) resultFail(`${name}.requirements must be a non-empty array`);
    value.requirements.forEach((entry, index) => {
      resultObject(entry, `${name}.requirements[${index}]`);
      exactFields(entry, new Set(['id', 'workRevision']), `${name}.requirements[${index}]`);
      resultString(entry.id, `${name}.requirements[${index}].id`);
      revision(entry.workRevision, `${name}.requirements[${index}].workRevision`);
    });
  }
}

function validateResultRequirement(value, name) {
  resultObject(value, name);
  exactFields(value, new Set(['id', 'text', 'mandatory', 'status', 'workRevision', 'evidence', 'accepted']), name);
  resultString(value.id, `${name}.id`);
  resultString(value.text, `${name}.text`);
  if (typeof value.mandatory !== 'boolean') resultFail(`${name}.mandatory must be a boolean`);
  if (!REQUIREMENT_STATUSES.has(value.status)) resultFail(`${name}.status is invalid`);
  revision(value.workRevision, `${name}.workRevision`);
  if (!Array.isArray(value.evidence)) resultFail(`${name}.evidence must be an array`);
  value.evidence.forEach((entry, index) => validateResultEvidence(entry, `${name}.evidence[${index}]`));
  if (value.accepted !== undefined) {
    resultObject(value.accepted, `${name}.accepted`);
    exactFields(value.accepted, new Set(['step', 'reason', 'at']), `${name}.accepted`);
    resultString(value.accepted.step, `${name}.accepted.step`);
    resultString(value.accepted.reason, `${name}.accepted.reason`);
    if (typeof value.accepted.at !== 'string' || Number.isNaN(Date.parse(value.accepted.at))) resultFail(`${name}.accepted.at must be an ISO-compatible timestamp`);
  }
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
  exactFields(value, new Set(['id', 'purpose', 'status', 'outputFile', 'artifactIds', 'failure', 'reasoning', 'kind', 'role', 'evidenceResults', 'bytes', 'routeWhy', 'routeCandidates', 'usage', 'acceptance']), name);
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
  // `role` is written only for steps that store one, so older envelopes and
  // kind-only steps carry no field at all.
  if (value.role !== undefined) resultString(value.role, `${name}.role`);
  // Present only for steps that declare evidence: null when the latest
  // attempt ran none (E15), otherwise that attempt's per-item results.
  if (value.evidenceResults !== undefined && value.evidenceResults !== null) {
    const issues = evidenceResultsIssues(value.evidenceResults, `${name}.evidenceResults`);
    if (issues.length) resultFail(issues[0]);
  }
  validateResultBytes(value.bytes, `${name}.bytes`);
  if (value.usage !== undefined && value.usage !== null) validateUsageAggregate(value.usage, `${name}.usage`);
  if (value.acceptance !== undefined) validateResultAcceptance(value.acceptance, `${name}.acceptance`);
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

function nullableString(value, name) {
  if (value !== null && (typeof value !== 'string' || !value)) resultFail(`${name} must be null or a non-empty string`);
}

function validateHandback(value) {
  resultObject(value, 'handback');
  exactFields(value, new Set(['unfinished', 'unresolvedRequirements', 'unreadSteering']), 'handback');
  for (const key of ['unfinished', 'unresolvedRequirements', 'unreadSteering']) {
    if (!Array.isArray(value[key])) resultFail(`handback.${key} must be an array`);
  }
  value.unfinished.forEach((entry, index) => {
    const name = `handback.unfinished[${index}]`;
    resultObject(entry, name);
    exactFields(entry, new Set(['id', 'status', 'failureKind', 'why', 'retryAfter', 'retryable', 'retries']), name);
    resultString(entry.id, `${name}.id`);
    if (!ACTION_STATUSES.has(entry.status)) resultFail(`${name}.status is invalid`);
    nullableString(entry.failureKind, `${name}.failureKind`);
    nullableString(entry.why, `${name}.why`);
    if (entry.retryAfter !== undefined && (typeof entry.retryAfter !== 'string' || Number.isNaN(Date.parse(entry.retryAfter)))) resultFail(`${name}.retryAfter must be an ISO-compatible timestamp`);
    if (typeof entry.retryable !== 'boolean') resultFail(`${name}.retryable must be a boolean`);
    if (entry.retries !== undefined && (!Number.isInteger(entry.retries) || entry.retries < 0)) resultFail(`${name}.retries must be a non-negative integer`);
  });
  value.unresolvedRequirements.forEach((entry, index) => {
    const name = `handback.unresolvedRequirements[${index}]`;
    resultObject(entry, name);
    exactFields(entry, new Set(['id', 'status', 'why']), name);
    resultString(entry.id, `${name}.id`);
    if (!REQUIREMENT_STATUSES.has(entry.status) || entry.status === 'passed') resultFail(`${name}.status is invalid`);
    nullableString(entry.why, `${name}.why`);
  });
  value.unreadSteering.forEach((entry, index) => {
    const name = `handback.unreadSteering[${index}]`;
    resultObject(entry, name);
    exactFields(entry, new Set(['id', 'message', 'queuedAt']), name);
    resultString(entry.id, `${name}.id`);
    if (typeof entry.message !== 'string') resultFail(`${name}.message must be a string`);
    nullableString(entry.queuedAt, `${name}.queuedAt`);
  });
}

// What a finished run hands back to its caller: every step that did not
// succeed and whether a plain resume reruns it, every requirement still open
// with its latest reason, and guidance that arrived too late to act on. The
// caller decides what happens next; the run never waits for that decision.
function buildV2Handback(state, { unreadSteering = [], failureRule = false } = {}) {
  const runtimeStates = stateByAction(state);
  const plan = v2RetryPlan(state);
  const rerun = new Set([...plan.rerun, ...plan.blocked]);
  const unfinished = state.program.actions.map((definition) => {
    const runtime = runtimeStates.get(definition.id);
    const status = runtime?.status ?? 'pending';
    if (status === 'succeeded' || status === 'removed') return null;
    const failure = runtime?.lastFailure ?? null;
    return {
      id: definition.id,
      status,
      failureKind: typeof failure?.kind === 'string' && failure.kind ? failure.kind : null,
      why: firstLine(failure?.message, 300),
      ...(typeof failure?.retryAfter === 'string' && !Number.isNaN(Date.parse(failure.retryAfter)) ? { retryAfter: failure.retryAfter } : {}),
      retryable: rerun.has(definition.id),
      // Marked runs count the step's automatic retries from its attempts'
      // retryOf facts (D3); saved runs carry no count.
      ...(failureRule && status === 'failed' ? { retries: countRetries(state, definition.id) } : {}),
    };
  }).filter(Boolean);
  const unresolvedRequirements = state.intent.requirements.map((intentRequirement) => {
    const requirement = state.ledger.requirements[intentRequirement.id];
    if (requirement.status === 'passed') return null;
    const latest = currentEvidence(state.ledger, requirement).at(-1);
    return {
      id: requirement.id,
      status: requirement.status,
      why: firstLine(latest?.evidence?.[0] ?? latest?.mechanicalFailure?.message, 300) ?? 'no evidence recorded for the current work',
    };
  }).filter(Boolean);
  return {
    unfinished,
    unresolvedRequirements,
    unreadSteering: unreadSteering.map((entry) => ({
      id: String(entry.id),
      message: String(entry.message ?? '').slice(0, 500),
      queuedAt: typeof entry.queuedAt === 'string' && entry.queuedAt ? entry.queuedAt : null,
    })),
  };
}

function describeSteps(actions, runtimeStates, limit = 3) {
  const named = actions.slice(0, limit).map((action) => {
    const runtime = runtimeStates.get(action.id);
    const status = runtime?.status ?? 'pending';
    const kind = runtime?.lastFailure?.kind;
    return `${action.id} ${status}${kind && kind !== status ? ` (${kind})` : ''}`;
  });
  return actions.length > limit ? `${named.join(', ')} and ${actions.length - limit} more` : named.join(', ');
}

// Say what actually happened in words a caller can act on. "All program
// actions finished successfully" read as success on runs whose verify step
// had failed the work, and callers stopped there (2026-09 caller study).
function succeededProgramReason(state, count) {
  const steps = `all ${count} step${count === 1 ? '' : 's'} succeeded`;
  // A loop that handed failures back says how many rounds it spent.
  const loop = state.verifyLoop;
  const rounds = loop && loop.max > 1 && loop.rounds.some((round) => round.closedAt && round.failed.length)
    ? ` after verify rounds ${loop.rounds.length}/${loop.max}` : '';
  if (hasPassingRequirementEvidence(state)) return `${steps} and every mandatory requirement passed its check`;
  const checked = new Set(state.program.actions.flatMap((action) => action.evidenceFor ?? []));
  if (!checked.size) return `${steps}, but no step checked the requirements, so the result is not verified`;
  const open = Object.values(state.ledger.requirements).filter((requirement) => requirement.mandatory && requirement.status !== 'passed');
  if (!open.length) return `${steps}, but no mandatory requirement has passing evidence, so the result is not verified`;
  const named = open.slice(0, 3).map((requirement) => `${requirement.id} ${requirement.status}${checked.has(requirement.id) ? '' : ' (no step checks it)'}`);
  const first = open.find((requirement) => checked.has(requirement.id));
  const why = first ? clipAtWord(firstLine(currentEvidence(state.ledger, first).at(-1)?.evidence?.[0], 400), 160) : null;
  return `${steps}, but not verified${rounds}: ${named.join(', ')}${open.length > 3 ? ` and ${open.length - 3} more` : ''}${why ? ` — ${first.id}: ${why}` : ''}`;
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
  // Keep only the stable legacy envelope fields here.  Durable state may gain
  // v2 counters for its own incremental ledger, but result.usage owns those
  // counters under `totals`/`steps`; copying them beside the envelope would
  // violate its exact public shape and duplicate partial totals.
  const usageState = state.usage && typeof state.usage === 'object' ? state.usage : {};
  const usage = {
    total: usageState.total ?? 0,
    byPool: clone(usageState.byPool) ?? {},
  };
  usage.bytes = usage.bytes == null ? aggregateAttemptBytes(state) : {
    taskFiles: usage.bytes.taskFiles ?? null,
    dependencyInputs: usage.bytes.dependencyInputs ?? null,
    outputs: usage.bytes.outputs ?? null,
  };
  const attempts = allAttemptRecords(state);
  const totals = aggregateAttemptUsage(attempts);
  const steps = {};
  for (const action of state.program?.actions ?? []) {
    steps[action.id] = aggregateAttemptUsage(attempts.filter((attempt) => attempt?.actionId === action.id));
  }
  usage.totals = totals;
  usage.steps = steps;
  return usage;
}

function validateUsageAggregate(value, name) {
  resultObject(value, name);
  exactFields(value, new Set([
    'attempts', 'minutes', 'tokens', 'cacheRead', 'cacheWrite', 'reasoning',
    'apiUsd', 'apiKnownSubtotalUsd', 'subscriptionUsd', 'subscriptionKnownSubtotalUsd',
    'measuredAttempts', 'pricedAttempts', 'subscriptionPricedAttempts',
    'tokenSource', 'subscriptionBasis', 'subscriptionDeltaPct',
    'subscriptionWindow', 'subscriptionWindows',
  ]), name);
  for (const field of [
    'minutes', 'tokens', 'cacheRead', 'cacheWrite', 'reasoning',
    'apiUsd', 'apiKnownSubtotalUsd', 'subscriptionUsd', 'subscriptionKnownSubtotalUsd',
  ]) {
    if (value[field] !== null && (typeof value[field] !== 'number' || !Number.isFinite(value[field]))) {
      resultFail(`${name}.${field} must be null or a finite number`);
    }
  }
  for (const field of ['attempts', 'measuredAttempts', 'pricedAttempts', 'subscriptionPricedAttempts']) {
    if (!Number.isInteger(value[field]) || value[field] < 0) resultFail(`${name}.${field} must be a non-negative integer`);
  }
  if (value.subscriptionDeltaPct !== undefined && value.subscriptionDeltaPct !== null && (typeof value.subscriptionDeltaPct !== 'number' || !Number.isFinite(value.subscriptionDeltaPct))) {
    resultFail(`${name}.subscriptionDeltaPct must be null or a finite number`);
  }
  if (value.subscriptionWindow !== undefined && value.subscriptionWindow !== null && typeof value.subscriptionWindow !== 'string') {
    resultFail(`${name}.subscriptionWindow must be null or a string`);
  }
  if (value.subscriptionWindows !== undefined) {
    resultObject(value.subscriptionWindows, `${name}.subscriptionWindows`);
    for (const [window, delta] of Object.entries(value.subscriptionWindows)) {
      if (!window || typeof delta !== 'number' || !Number.isFinite(delta)) resultFail(`${name}.subscriptionWindows is invalid`);
    }
  }
  if (typeof value.tokenSource !== 'string' || !['provider-reported', 'transcript-summed', 'estimated:utf8-bytes/4', 'unknown'].includes(value.tokenSource)) {
    resultFail(`${name}.tokenSource is invalid`);
  }
  if (typeof value.subscriptionBasis !== 'string' || ![
    'observed:meter-delta', 'observed:meter-ledger', 'calibrated:usd-per-pct',
    'unknown:no-price', 'unknown:no-meter', 'unknown:no-cost',
    'unknown:below-resolution',
  ].includes(value.subscriptionBasis)) resultFail(`${name}.subscriptionBasis is invalid`);
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
      // Who reviewed (D27), on records a stage-3 kernel wrote.
      ...(record.reviewer ? {
        reviewer: { pool: record.reviewer.pool, model: record.reviewer.model ?? null, provider: record.reviewer.provider ?? null },
        independent: reviewIndependence(record.reviewer, record.writers),
      } : {}),
    }));
}

// True when no writer attempt shares the reviewer's provider, false when one
// does, and null when no writer is known or a provider is unknown.
function reviewIndependence(reviewer, writers) {
  if (!Array.isArray(writers) || !writers.length) return null;
  if (reviewer?.provider && writers.some((writer) => writer?.provider === reviewer.provider)) return false;
  if (!reviewer?.provider || writers.some((writer) => !writer?.provider)) return null;
  return true;
}

// The acceptance a result reports (§2.9): the stored record without its
// revision number.
function publicAcceptance(value) {
  if (!value || typeof value !== 'object') return null;
  return {
    evidence: 'choice', reason: value.reason, at: value.at,
    attemptId: value.attemptId ?? null, failureKind: value.failureKind ?? null,
    ...(Array.isArray(value.requirements) ? { requirements: value.requirements.map(({ id, workRevision }) => ({ id, workRevision })) } : {}),
  };
}

// A step accepted by choice (not a check's requirement acceptance).
function stepAccepted(runtime) {
  return Boolean(runtime?.acceptance) && !Array.isArray(runtime.acceptance.requirements);
}

// The current acceptance of one requirement: a check step's acceptance whose
// recorded workRevision is still the requirement's (D23).
function requirementAcceptance(state, requirement) {
  for (const runtime of state.actions ?? []) {
    const entry = (runtime?.acceptance?.requirements ?? []).find((item) => item.id === requirement.id);
    if (entry && entry.workRevision === requirement.workRevision) {
      // F21: an entry carried forward by a later accept keeps its own reason and time.
      return { step: runtime.id, reason: entry.reason ?? runtime.acceptance.reason, at: entry.at ?? runtime.acceptance.at };
    }
  }
  return null;
}

// The run's marker, from the option or the directory its attempts live in.
function envelopeFlags(state, features) {
  if (features !== undefined) return runFeatureFlags(features);
  const file = (state.attempts ?? []).map((attempt) => attempt.taskFile ?? attempt.outputFile).find((path) => typeof path === 'string' && path.includes('/'));
  return runFeatureFlags(file ? readRunFeatures(dirname(file)) : {});
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
    // An action a plan revision removed no longer counts toward the result.
    const live = state.program.actions.filter((action) => runtimeStates.get(action.id)?.status !== 'removed');
    const unsuccessful = live.filter((action) => runtimeStates.get(action.id)?.status !== 'succeeded');
    return unsuccessful.length
      ? { status: 'partial', terminal: true, reason: `${unsuccessful.length} of ${live.length} step${live.length === 1 ? '' : 's'} did not succeed: ${describeSteps(unsuccessful, runtimeStates)}`, gaps: consolidateV2Gaps(state) }
      : { status: state.lifecycle.resultFile ? 'completed' : 'ready-to-finalize', terminal: Boolean(state.lifecycle.resultFile), reason: succeededProgramReason(state, live.length) };
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

function readTextQuietly(path) {
  try { return readFileSync(path, 'utf8'); } catch { return null; }
}

export function createV2ResultEnvelope(state, { finishedAt = new Date().toISOString(), plannerExhausted = false, limitsExhausted = false, terminalReason = null, workspace = null, unreadSteering = [], readText = readTextQuietly, features = undefined } = {}) {
  validateV2DurableState(state);
  const progress = evaluateV2Progress(state, { plannerExhausted, limitsExhausted, terminalReason });
  if (!['ready-to-finalize', 'partial', 'cancelled'].includes(progress.status)) {
    throw new TypeError(`V2 result is not ready: workflow status is ${progress.status}`);
  }
  const status = progress.status === 'ready-to-finalize' ? 'completed' : progress.status;
  const program = isProgramWorkflow(state);
  const verified = status === 'completed' && (!program || hasPassingRequirementEvidence(state));
  // The repair loop's rounds, measured, and what is left for the caller.
  const flags = envelopeFlags(state, features);
  const loop = program ? verifyLoopResult(state, { readText, token: state.shortId ?? state.runId, failureRule: flags.failureRule === true }) : null;
  const acceptedSteps = state.actions.filter(stepAccepted).length;
  const result = {
    schemaVersion: V2_RESULT_SCHEMA_VERSION,
    runId: state.runId,
    shortId: state.shortId,
    intentId: state.intentId,
    goal: state.intent.goal,
    status,
    verified,
    ...(program ? { executionMode: 'program', ...(workspace ? { workspace: clone(workspace) } : {}) } : {}),
    reason: `${progress.reason}${acceptedSteps ? ` · ${acceptedSteps} step${acceptedSteps === 1 ? '' : 's'} accepted by choice` : ''}`,
    requirements: state.intent.requirements.map((intentRequirement) => {
      const requirement = state.ledger.requirements[intentRequirement.id];
      const accepted = requirementAcceptance(state, requirement);
      return {
        id: requirement.id,
        text: intentRequirement.text,
        mandatory: requirement.mandatory,
        status: requirement.status,
        workRevision: requirement.workRevision,
        evidence: currentEvidence(state.ledger, requirement),
        ...(accepted ? { accepted } : {}),
      };
    }),
    actions: state.program.actions.map((definition) => {
      const runtime = state.actions.find((action) => action.id === definition.id);
      const attempt = state.attempts?.findLast((entry) => entry.actionId === definition.id);
      const actionUsage = aggregateAttemptUsage(allAttemptRecords(state)
        .filter((entry) => entry?.actionId === definition.id));
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
        ...(definition.role ? { role: definition.role } : {}),
        // Only steps that declare checks carry the key, so older result
        // shapes stay byte-identical.
        ...(declaredEvidence(definition).length ? { evidenceResults: clone(attempt?.evidenceResults ?? null) } : {}),
        bytes: lastAttemptBytes(state, definition.id),
        usage: actionUsage,
        routeWhy: attempt?.routeWhy ?? null,
        routeCandidates: clone(attempt?.routeCandidates ?? null),
        ...(program ? { failure: publicFailure(runtime?.lastFailure) } : {}),
        ...(runtime?.acceptance ? { acceptance: publicAcceptance(runtime.acceptance) } : {}),
      };
    }),
    gaps: status === 'completed' && verified ? null : (progress.gaps ?? consolidateV2Gaps(state)),
    usage: resultUsage(state),
    finishedAt,
    // Anything short of a verified run with no unread guidance is handed back.
    ...(status === 'completed' && verified && !unreadSteering.length ? {} : { handback: buildV2Handback(state, { unreadSteering, failureRule: flags.failureRule }) }),
    ...(loop ? { verifyRounds: loop.verifyRounds, callerDecision: loop.callerDecision } : {}),
  };
  validateV2ResultEnvelope(result);
  return clone(result);
}

function firstLine(value, limit) {
  if (value === undefined || value === null) return null;
  const line = String(value).split(/\r?\n/, 1)[0].trim().slice(0, limit);
  return line || null;
}

// The tail a failed-evidence reason always keeps (§2.7): how many other
// checks failed, and why no retry follows.
const KEPT_WHY_SUFFIX = /(?: \(\+\d+ more failed\))?(?: · (?:act steps are not retried|no retry: \S.* is no longer eligible))?$/;

// A handback reason cut to `limit`: when it ends with a kept suffix, the
// middle goes (marked with an ellipsis) so the suffix survives (F17).
function clipWhy(value, limit) {
  const line = firstLine(value, Infinity);
  if (!line || line.length <= limit) return line;
  const suffix = line.match(KEPT_WHY_SUFFIX)[0];
  if (!suffix || suffix.length + 2 > limit) return firstLine(line, limit);
  return `${line.slice(0, limit - suffix.length - 1).trimEnd()}…${suffix}`;
}

// A reason line is read by a person: cut it between words and mark the cut,
// so "It contains no menti" never reads as the whole finding.
function clipAtWord(text, limit) {
  if (!text || text.length <= limit) return text;
  const head = text.slice(0, limit - 1);
  const space = head.lastIndexOf(' ');
  return `${(space > limit / 2 ? head.slice(0, space) : head).replace(/[\s,;:—-]+$/, '')}…`;
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

function roleField(role) {
  return role ? { role } : {};
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
// Shrink order when a summary is over budget: concerns first, then per-action
// detail, and an open requirement's `why` last. That one line is what a caller
// acts on; when it was blanked, callers went reading run files instead (6 of
// 10 unverified project-b runs, 2026-09).
const RESULT_SUMMARY_FIT_STEPS = [
  { actions: 'named', why: 200, concern: 160, concerns: 3, handbackWhy: 160, handbackCount: 8 },
  { actions: 'full', why: 200, concern: 160, concerns: 3, handbackWhy: 160, handbackCount: 8 },
  { actions: 'full', why: 200, concern: 80, concerns: 3, handbackWhy: 160, handbackCount: 8 },
  { actions: 'full', why: 200, concern: 80, concerns: 1, handbackWhy: 120, handbackCount: 8 },
  { actions: 'routing', why: 200, concern: 0, concerns: 0, handbackWhy: 120, handbackCount: 8 },
  { actions: 'status', why: 200, concern: 0, concerns: 0, handbackWhy: 120, handbackCount: 6 },
  // Output names go before the reasons do: the full result still lists them.
  { actions: 'bare', why: 200, concern: 0, concerns: 0, handbackWhy: 80, handbackCount: 6 },
  { actions: 'bare', why: 160, concern: 0, concerns: 0, handbackWhy: 80, handbackCount: 4 },
  { actions: 'bare', why: 120, concern: 0, concerns: 0, handbackWhy: 0, handbackCount: 4 },
  { actions: 'bare', why: 80, concern: 0, concerns: 0, handbackWhy: 0, handbackCount: 2 },
  { actions: 'bare', why: 40, concern: 0, concerns: 0, handbackWhy: 0, handbackCount: 0 },
  { actions: 'bare', why: 0, concern: 0, concerns: 0, handbackWhy: 0, handbackCount: 0 },
];

function summarySize(summary) {
  return Buffer.byteLength(JSON.stringify(summary), 'utf8');
}

// The loop's per-phase measures shrink first, to what a caller compares
// across rounds (minutes, pool, cost: requirement 5 of 0.35.2 names all
// three), then the decision evidence; ids and `next` are never cut.
const LOOP_FIT_LEVELS = [
  { phases: 'full', evidence: 200 },
  { phases: 'compact', evidence: 200 },
  { phases: 'compact', evidence: 120 },
];
// Only when everything else is already at its smallest: the round counts
// stay, the per-phase rows go (the full result keeps them).
const LOOP_LAST_RESORT = { phases: 'none', evidence: 120 };

function fitVerifyRounds(value, level) {
  if (!value) return value;
  if (level.phases === 'full') return value;
  if (level.phases === 'none') return { ...value, phases: [] };
  return { ...value, phases: value.phases.map(({ kind, round, wallMinutes, pools, cost }) => ({ kind, round, wallMinutes, pools, cost })) };
}

function fitCallerDecision(value, level) {
  if (!value) return value;
  return { ...value, requirements: value.requirements.map((entry) => ({ ...entry, evidence: firstLine(entry.evidence, level.evidence) ?? '' })) };
}

// Stage 3's summary fields (§2.9, L4, L5): the handback's step verbs, the
// retry counts, and acceptances by choice. Saved runs carry none of them.
const STAGE3_OPTIONS = ['rerun', 'accept', 'rerunReview', 'acceptRequirement'];

function hasStage3Additions(summary) {
  const options = summary.handback?.options ?? {};
  return STAGE3_OPTIONS.some((key) => Object.hasOwn(options, key))
    || (summary.handback?.unfinished ?? []).some((entry) => Object.hasOwn(entry, 'retries'))
    || summary.actions.some((action) => Object.hasOwn(action, 'accepted'))
    || summary.requirements.some((requirement) => Object.hasOwn(requirement, 'accepted'));
}

// A built summary with its stage-3 fields shed, least useful first:
// 1 cuts the options' explanations, 2 drops those options, 3 the retry
// counts, 4 the acceptance reasons (the full result keeps them all).
const STAGE3_SHEDS = [0, 1, 2, 3, 4];

function shedStage3(candidate, variant) {
  if (!variant) return candidate;
  let next = candidate;
  if (next.handback) {
    const options = { ...next.handback.options };
    for (const key of STAGE3_OPTIONS) {
      if (!Object.hasOwn(options, key)) continue;
      if (variant >= 2) delete options[key];
      else options[key] = options[key].replace(/ \([^()]*\)$/, '');
    }
    next = {
      ...next,
      handback: {
        ...next.handback,
        ...(variant >= 3 ? { unfinished: next.handback.unfinished.map(({ retries: _retries, ...entry }) => entry) } : {}),
        options,
      },
    };
  }
  if (variant >= 4) {
    next = {
      ...next,
      actions: next.actions.map(({ accepted: _accepted, ...action }) => action),
      requirements: next.requirements.map(({ accepted: _accepted, ...requirement }) => requirement),
    };
  }
  return next;
}

// A stage-3 summary (F32): the handback detail is picked as if the run had
// neither proof labels nor stage-3 fields, so neither costs a handback line;
// the stage-3 fields are shed before that floor would be, and a summary that
// runs over does so without them, never by more than stage 2's would.
function fitWithAdditions(summary, { plan, build, fitIndex, smallestAt }) {
  const { proof, ...unlabelled } = summary;
  const floorAt = fitIndex(unlabelled, (candidate) => shedStage3(candidate, STAGE3_SHEDS.at(-1)));
  const [floor, floorLevel] = plan[floorAt];
  const floored = ([step, level]) => [{
    ...step,
    why: Math.max(step.why, floor.why),
    handbackWhy: Math.max(step.handbackWhy, floor.handbackWhy),
    handbackCount: Math.max(step.handbackCount, floor.handbackCount),
  }, {
    phases: level.phases === 'none' && floorLevel.phases !== 'none' ? 'compact' : level.phases,
    evidence: Math.max(level.evidence, floorLevel.evidence),
  }];
  const withProof = (candidate, value) => (value ? { ...candidate, proof: value } : candidate);
  const shedUsage = (candidate) => (candidate.usage?.steps
    ? { ...candidate, usage: { ...candidate.usage, steps: Object.fromEntries(Object.entries(candidate.usage.steps).map(([id, step]) => [id, dropNullFields(step)])) } }
    : candidate);
  const proofs = proof ? [proof, { ...proof, unprovenSteps: [] }] : [null];
  // The least shedding with which the summary fits at some level, its proof
  // included (step detail, concerns and the unproven names give way first;
  // a row's acceptance also goes with the `bare` level, §2.9). When nothing
  // fits, the summary runs over as a stage-2 one would, without them.
  const built = plan.map((entry) => build(summary, ...floored(entry)));
  const smallest = [...new Set([smallestAt, plan.length - 1])].map((index) => built[index]);
  for (const variant of STAGE3_SHEDS) {
    const candidates = [];
    for (const candidate of built) for (const value of proofs) candidates.push(shedStage3(withProof(candidate, value), variant));
    for (const candidate of smallest) for (const value of proofs) candidates.push(shedUsage(shedStage3(withProof(candidate, value), variant)));
    const found = candidates.find((candidate) => summarySize(candidate) < RESULT_SUMMARY_BYTE_BUDGET);
    if (found) return found;
  }
  return shedUsage(shedStage3(withProof(build(summary, ...floored(plan[Math.max(floorAt, smallestAt)])), proof), STAGE3_SHEDS.at(-1)));
}

function fitResultSummary(summary) {
  const actionsAt = (level) => summary.actions.map((action) => {
    // Output paths are always basenames under `next.runDir`: one directory
    // string instead of N absolute prefixes, and the summary's size no longer
    // depends on where the home lives.
    const named = { ...action, outFile: compactActionValue(action.outFile) };
    if (level === 'named') return named;
    if (level === 'full') return dropNullFields(named);
    if (level === 'routing') return dropNullFields({ ...named, bytes: null });
    if (level === 'status') return dropNullFields({ id: named.id, status: named.status, outFile: named.outFile ?? null, accepted: named.accepted ?? null });
    return { id: named.id, status: named.status };
  });
  const requirementsAt = (limit, actionsLevel) => summary.requirements.map(({ accepted, ...requirement }) => ({
    ...requirement,
    // The open-requirement reason is the caller's definition of unfinished
    // work, so retain a useful sentence even in the smallest handback.
    why: firstLine(requirement.why, requirement.status === 'passed' ? limit : Math.max(limit, 120)),
    // An acceptance by choice is kept through the `status` level, like a step row's (L5).
    ...(accepted && actionsLevel !== 'bare' ? { accepted } : {}),
  }));
  const concernsAt = (limit, count) => ({
    count: summary.concerns.count,
    first: summary.concerns.first.slice(0, count).map((concern) => firstLine(concern, limit)).filter(Boolean),
  });
  const handbackAt = (limit, count) => {
    const { unfinished, unreadSteering } = summary.handback;
    const selected = [];
    for (const entry of unfinished) {
      if (selected.length < count || entry.retryAfter) selected.push(entry);
    }
    return {
      ...summary.handback,
      unfinished: selected.map((entry) => dropNullFields({
        ...entry,
        // A retry deadline without its cause is not an actionable handback.
        // Preserve the paused-pool explanation even in the smallest summary.
        why: clipWhy(entry.why, entry.retryAfter ? Math.max(limit, 200) : limit),
      })),
      ...(unfinished.length > selected.length ? { unfinishedOmitted: unfinished.length - selected.length } : {}),
      unreadSteering: unreadSteering.map((entry) => ({ ...entry, message: firstLine(entry.message, Math.max(limit, 80)) ?? '' })),
    };
  };
  const loopKeys = Object.hasOwn(summary, 'verifyRounds') || Object.hasOwn(summary, 'callerDecision');
  // `source` is the summary, or the summary without its proof labels.
  const build = (source, step, level) => {
    const actions = Object.hasOwn(source, 'proof') ? actionsAt(step.actions) : actionsAt(step.actions).map(({ proof: _proof, ...action }) => action);
    return {
      ...source,
      actions,
      requirements: requirementsAt(step.why, step.actions),
      concerns: concernsAt(step.concern, step.concerns),
      ...(summary.handback ? { handback: handbackAt(step.handbackWhy, step.handbackCount) } : {}),
      ...(loopKeys ? { verifyRounds: fitVerifyRounds(summary.verifyRounds, level) } : {}),
      ...(summary.callerDecision ? { callerDecision: fitCallerDecision(summary.callerDecision, level) } : {}),
      next: { ...summary.next, outputs: actions.map((action) => action.outFile).filter(Boolean) },
    };
  };
  const [firstStep, ...laterSteps] = RESULT_SUMMARY_FIT_STEPS;
  const plan = loopKeys
    ? [
      ...LOOP_FIT_LEVELS.map((level) => [firstStep, level]),
      ...laterSteps.map((step) => [step, LOOP_FIT_LEVELS.at(-1)]),
      [RESULT_SUMMARY_FIT_STEPS.at(-1), LOOP_LAST_RESORT],
    ]
    : RESULT_SUMMARY_FIT_STEPS.map((step) => [step, LOOP_FIT_LEVELS[0]]);
  // Nothing fits (a run with many steps: `usage.steps` is never cut). The
  // round rows are dropped only when that alone reaches the budget.
  const smallestAt = plan.length - (loopKeys ? 2 : 1);
  const fitIndex = (source, post = (candidate) => candidate) => {
    const index = plan.findIndex(([step, level]) => summarySize(post(build(source, step, level))) < RESULT_SUMMARY_BYTE_BUDGET);
    return index === -1 ? smallestAt : index;
  };
  if (hasStage3Additions(summary)) return fitWithAdditions(summary, { plan, build, fitIndex, smallestAt });
  if (!summary.proof) {
    const [step, level] = plan[fitIndex(summary)];
    return build(summary, step, level);
  }
  // A summary with proof labels (a new run's) picks its handback detail as if
  // it had none: the level the same run fits at without `proof` is the floor
  // for every handback reason, step count, requirement reason and round row,
  // so the labels never cost the caller a handback line (F16). Only optional
  // fields give way: step detail, concerns, then the unproven step names (the
  // proof counts stay), then the unknown (null) per-step usage fields.
  const { proof, ...unlabelled } = summary;
  const floorAt = fitIndex(unlabelled);
  const [floor, floorLevel] = plan[floorAt];
  const floored = ([step, level]) => [{
    ...step,
    why: Math.max(step.why, floor.why),
    handbackWhy: Math.max(step.handbackWhy, floor.handbackWhy),
    handbackCount: Math.max(step.handbackCount, floor.handbackCount),
  }, {
    phases: level.phases === 'none' && floorLevel.phases !== 'none' ? 'compact' : level.phases,
    evidence: Math.max(level.evidence, floorLevel.evidence),
  }];
  const withProof = (candidate, value) => ({ ...candidate, proof: value });
  const shedUsage = (candidate) => (candidate.usage?.steps
    ? { ...candidate, usage: { ...candidate.usage, steps: Object.fromEntries(Object.entries(candidate.usage.steps).map(([id, step]) => [id, dropNullFields(step)])) } }
    : candidate);
  const proofs = [proof, { ...proof, unprovenSteps: [] }];
  const candidates = plan.flatMap((entry) => {
    const candidate = build(summary, ...floored(entry));
    return proofs.map((value) => withProof(candidate, value));
  });
  for (const entry of new Set([plan[smallestAt], plan.at(-1)])) {
    const smallest = build(summary, ...floored(entry));
    candidates.push(...proofs.map((value) => shedUsage(withProof(smallest, value))));
  }
  // When even that does not fit (the run without labels was already at its
  // smallest levels), the summary runs over, as any summary does when nothing
  // fits, with its whole proof: a handback line is never the cost.
  return candidates.find((candidate) => summarySize(candidate) < RESULT_SUMMARY_BYTE_BUDGET)
    ?? shedUsage(withProof(build(summary, ...floored(plan[Math.max(floorAt, smallestAt)])), proof));
}

// Results written before 0.30.0 carry no handback; derive the same view from
// what they do carry, so every unfinished run reads the same way.
function legacyHandback(envelope) {
  if (envelope.status === 'completed' && envelope.verified) return null;
  const unfinished = envelope.actions
    .filter((action) => action.status !== 'succeeded' && action.status !== 'removed')
    .map((action) => ({ id: action.id, status: action.status, failureKind: action.failure?.kind ?? null, why: firstLine(action.failure?.message, 300) }));
  const rerunnable = (entry) => RERUN_STATUSES.has(entry.status) || (entry.status === 'failed' && RETRYABLE_FAILURE_KINDS.has(entry.failureKind));
  const anyRerun = unfinished.some(rerunnable);
  return {
    unfinished: unfinished.map((entry) => ({ ...entry, retryable: rerunnable(entry) || (anyRerun && entry.status === 'blocked') })),
    unresolvedRequirements: envelope.requirements
      .filter((requirement) => requirement.status !== 'passed')
      .map((requirement) => ({ id: requirement.id, status: requirement.status, why: firstLine(requirement.evidence.at(-1)?.evidence?.[0], 300) })),
    unreadSteering: [],
  };
}

// L4: a requirement the loop left failing, in a marked run, comes back with
// the review verbs: rerun its check away from the reviewer's pool, or accept
// it by choice. Named for the check that judged the first failing one.
function reviewVerbs(envelope, token, actions) {
  const open = (entry) => entry.status !== NOT_JUDGED_STATUS;
  for (const entry of envelope.callerDecision?.requirements ?? []) {
    if (!open(entry)) continue;
    const requirement = envelope.requirements.find((item) => item.id === entry.id);
    if (!requirement || requirement.accepted) continue;
    const record = requirement.evidence.findLast((item) => item.status === 'failed' && item.sourceAction);
    if (!record) continue;
    const judge = record.sourceAction;
    const pool = record.reviewer?.pool ?? actions.find((action) => action.id === judge)?.pool ?? null;
    const judged = envelope.callerDecision.requirements.filter((item) => open(item)
      && envelope.requirements.find((candidate) => candidate.id === item.id && !candidate.accepted)
        ?.evidence.findLast((evidence) => evidence.status === 'failed' && evidence.sourceAction)?.sourceAction === judge)
      .map((item) => item.id);
    return {
      rerunReview: `bullswarm workflow step rerun ${token} ${judge}${pool ? ` --avoid ${pool}` : ''} (judges it again${pool ? ' on another pool' : ''})`,
      acceptRequirement: `bullswarm workflow step accept ${token} ${judge} ${judged.map((id) => `--requirement ${id}`).join(' ')} --reason "…" (recorded as your choice, never proof)`,
    };
  }
  return {};
}

function summaryHandback(envelope, handback, token, { failureRule = false, actions = [] } = {}) {
  const retryable = handback.unfinished.filter((entry) => entry.retryable);
  const waits = retryable.map((entry) => Date.parse(entry.retryAfter ?? '')).filter(Number.isFinite);
  // Named only when every step to retry is waiting on a paused pool: resume
  // gets through once the first of them is back.
  const retryAfter = retryable.length && waits.length === retryable.length ? new Date(Math.min(...waits)).toISOString() : null;
  const rerunIds = retryable.map((entry) => entry.id);
  // A failed step that declares evidence but whose worker failed first (E15):
  // the result row holds `evidenceResults: null`, and the line says so.
  const notRun = new Set(envelope.actions
    .filter((action) => action.status === 'failed' && Object.hasOwn(action, 'evidenceResults') && action.evidenceResults === null)
    .map((action) => action.id));
  const failedIds = envelope.executionMode === 'program' ? handback.unfinished.filter((entry) => entry.status === 'failed').map((entry) => entry.id) : [];
  const failedStep = failedIds.length === 1 ? failedIds[0] : '<step>';
  return {
    unfinished: handback.unfinished.map((entry) => ({
      id: entry.id,
      status: entry.status,
      failureKind: entry.failureKind ?? null,
      why: clipWhy(entry.why, 160),
      ...(entry.status === 'failed' && notRun.has(entry.id) ? { evidenceNotRun: true } : {}),
      ...(entry.retryAfter ? { retryAfter: entry.retryAfter } : {}),
      retryable: entry.retryable,
      ...(Number.isInteger(entry.retries) ? { retries: entry.retries } : {}),
    })),
    unreadSteering: handback.unreadSteering.map((entry) => ({ id: entry.id, message: firstLine(entry.message, 160) ?? '' })),
    // Every option the caller has, as a command. Which one to take is theirs.
    options: {
      ...(envelope.executionMode === 'program'
        ? { continue: `bullswarm workflow plan export ${token} --out plan.json, edit it, then bullswarm workflow plan revise ${token} --program plan.json (--rerun <step ids> runs finished steps again)` }
        : {}),
      ...(retryable.length
        ? { retry: `bullswarm workflow resume ${token}${retryAfter ? ` after ${retryAfter}` : ''} (reruns ${rerunIds.slice(0, 4).join(', ')}${rerunIds.length > 4 ? ` and ${rerunIds.length - 4} more` : ''})` }
        : {}),
      // A marked run's failed steps come back with the caller verbs (§2.9).
      ...(failureRule && failedIds.length ? {
        rerun: `bullswarm workflow step rerun ${token} ${failedStep} [--avoid <pool>] (runs it again with its last attempt's handoff)`,
        accept: `bullswarm workflow step accept ${token} ${failedStep} --reason "…" (recorded as your choice, never proof)`,
      } : {}),
      ...(failureRule ? reviewVerbs(envelope, token, actions) : {}),
      takeOver: `do the unfinished work yourself; bullswarm workflow runs result ${token} --json names every step's output`,
      restart: 'start a new run: bullswarm workflow goal "<goal>" --cwd <dir> --program <file.json>',
    },
  };
}

// Plain lines for whoever reads watch or launch output: what is left, why, and
// the command behind each option.
/**
 * The caller-decision block and the per-round measures, for runs whose repair
 * loop ran more than one round or handed failures back. Empty otherwise, so a
 * run that passed in its first round reads as it always has.
 */
export function formatV2VerifyRoundLines(summary) {
  const rounds = summary?.verifyRounds;
  const decision = summary?.callerDecision;
  if (!rounds || (!decision && rounds.used <= 1)) return [];
  const lines = [];
  if (decision) {
    lines.push(`verify rounds ${decision.verifyRounds} · ${summary.verified ? 'verified, but some requirements were not judged' : 'not verified'} — your decision:`);
    for (const entry of decision.requirements) {
      lines.push(entry.status === NOT_JUDGED_STATUS
        ? `  ${entry.id} ${entry.status}${entry.evidence ? ` — ${entry.evidence}` : ''}`
        : `  ${entry.id} ${entry.status} in round ${entry.round}${entry.evidence ? ` — ${entry.evidence}` : ''}`);
      lines.push(`    next: ${entry.next}`);
    }
  }
  if (rounds.phases?.length) {
    lines.push('rounds:');
    for (const phase of rounds.phases) {
      const minutes = phase.wallMinutes == null ? '—' : `${phase.wallMinutes}m`;
      const pools = phase.pools?.length ? phase.pools.join(', ') : null;
      lines.push(`  ${phase.kind} round ${phase.round} · ${minutes}${pools ? ` · ${pools}` : ''} · ${phase.cost ?? '—'}`);
    }
  }
  return lines;
}

export function formatV2HandbackLines(summary) {
  const handback = summary?.handback;
  const loopLines = formatV2VerifyRoundLines(summary);
  if (!handback) return loopLines;
  const lines = [...loopLines];
  for (const entry of handback.unfinished) {
    const kind = entry.failureKind && entry.failureKind !== entry.status ? ` (${entry.failureKind})` : '';
    const retries = entry.retries > 0 ? ` after ${entry.retries} retr${entry.retries === 1 ? 'y' : 'ies'}` : '';
    lines.push(`  step ${entry.id}: ${entry.status}${kind}${retries}${entry.why ? ` — ${entry.why}` : ''}${entry.evidenceNotRun ? ' · evidence not run' : ''}${entry.retryAfter ? ` · its pool is back at ${entry.retryAfter}` : ''}`);
  }
  // L2: a failed step is never hidden. The summary's step rows are never cut,
  // so a failed step the handback left out for size is named from them; the
  // requirement lines give way for it, and blocked steps are counted.
  const listed = new Set(handback.unfinished.map((entry) => entry.id));
  const hidden = handback.unfinishedOmitted ? (summary.actions ?? []).filter((action) => !listed.has(action.id)) : [];
  const hiddenFailed = hidden.filter((action) => action.status === 'failed');
  for (const action of hiddenFailed) lines.push(`  step ${action.id}: failed`);
  const more = (handback.unfinishedOmitted ?? 0) - hiddenFailed.length;
  const blocked = hidden.filter((action) => action.status === 'blocked').length;
  // Saved runs' text changes only where a failed step was hidden.
  const counted = blocked && (hiddenFailed.length || Object.hasOwn(handback.options ?? {}, 'rerun'));
  if (more > 0) lines.push(`  … and ${more} more unfinished step(s)${counted ? ` (${blocked} blocked by a failed step)` : ''}`);
  // A requirement the decision block already names is not listed twice.
  const decided = new Set((summary.callerDecision?.requirements ?? []).map((entry) => entry.id));
  const open = (summary.requirements ?? []).filter((requirement) => requirement.status !== 'passed' && !decided.has(requirement.id));
  const shown = Math.max(0, 6 - hiddenFailed.length);
  for (const requirement of open.slice(0, shown)) {
    // L5: an acceptance by choice reads as such; the requirement stays failed.
    lines.push(requirement.accepted
      ? `  requirement ${requirement.id}: ${requirement.status} · accepted by choice "${requirement.accepted}"`
      : `  requirement ${requirement.id}: ${requirement.status}${requirement.why ? ` — ${requirement.why}` : ''}`);
  }
  if (open.length > shown) lines.push(`  … and ${open.length - shown} more open requirement(s)`);
  for (const entry of handback.unreadSteering) lines.push(`  steering not acted on: ${entry.message}`);
  const labels = { continue: 'continue', retry: 'retry', rerun: 'rerun', accept: 'accept', rerunReview: 'rerun', acceptRequirement: 'accept', takeOver: 'take over', restart: 'restart' };
  const options = Object.entries(handback.options ?? {});
  if (options.length) {
    lines.push('your call:');
    for (const [key, text] of options) lines.push(`  ${(labels[key] ?? key).padEnd(9)} ${text}`);
  }
  return lines;
}

// What can back a finished step, in the order labels list them (E22). Stage
// 3's `choice` (D34) is not a proof type: an accepted step's label is
// `['choice']` alone, and the summary counts it apart, never as proven.
export const PROOF_TYPES = Object.freeze(['command', 'schema', 'review']);

function isReviewStep(definition) {
  return Array.isArray(definition?.evidenceFor) && definition.evidenceFor.length > 0;
}

/**
 * What backs one succeeded step (E22): `{ by, reviewPending }`, or null for a
 * step that gets no label (a review or digest step, a step that did not
 * succeed, or, when `features` is given, a run without the `proofLabels`
 * marker and a step that declares no evidence, E23). `by` lists the evidence
 * types the latest succeeded attempt passed, then `review` when every
 * requirement the step affects has passed. `reviewPending` is computed only
 * `atFinish`: every affected requirement is checked by a live review step and
 * not all of them have passed yet.
 */
export function stepProof(state, definition, { atFinish = false, features } = {}) {
  if (!definition) return null;
  // A step the caller accepted is backed by that choice, whatever the marker
  // (only stage-3 code can accept, D34). A check's requirement acceptance
  // labels no step.
  if (stepAccepted((state?.actions ?? []).find((action) => action.id === definition.id))) return { by: ['choice'], reviewPending: false };
  if (isReviewStep(definition) || definition.kind === 'digest') return null;
  if (features !== undefined && features?.proofLabels !== 1 && !declaredEvidence(definition).length) return null;
  const runtime = (state?.actions ?? []).find((action) => action.id === definition.id) ?? null;
  if (!atFinish && runtime?.status !== 'succeeded') return null;
  const attempt = (state?.attempts ?? []).findLast((entry) => entry.actionId === definition.id && entry.status === 'succeeded');
  const passed = new Set((attempt?.evidenceResults ?? []).filter((item) => item?.status === 'passed').map((item) => item.type));
  const affects = Array.isArray(definition.affects) ? definition.affects : [];
  const requirements = state?.ledger?.requirements ?? {};
  const reviewed = affects.length > 0 && affects.every((id) => requirements[id]?.status === 'passed');
  const by = PROOF_TYPES.filter((type) => (type === 'review' ? reviewed : passed.has(type)));
  let reviewPending = false;
  if (atFinish && affects.length && !reviewed) {
    const statusOf = new Map((state?.actions ?? []).map((action) => [action.id, action.status]));
    const covered = new Set((state?.program?.actions ?? [])
      .filter((action) => action.id !== definition.id && isReviewStep(action) && statusOf.get(action.id) !== 'removed')
      .flatMap((action) => action.evidenceFor));
    reviewPending = affects.every((id) => covered.has(id));
  }
  return { by, reviewPending };
}

/** The words after `finished` on a step's line: `proven by command, schema`,
 * `review pending`, or `unproven`. */
export function formatV2ProofLabel(proof) {
  if (!proof) return null;
  const by = proof.by ?? [];
  if (by.includes('choice')) return 'accepted by choice';
  if (by.length) return `proven by ${by.join(', ')}${proof.reviewPending ? ' · review pending' : ''}`;
  return proof.reviewPending ? 'review pending' : 'unproven';
}

// The summary's top-level proof (§2.8): how many labelled rows are proven,
// by which type, and which are not. Steps accepted by choice (D34) are counted
// apart and never as proven; the keys appear only when there is one, so a
// saved run's summary reads as before.
function summaryProof(rows) {
  const labelled = rows.filter((row) => Array.isArray(row.proof));
  if (!labelled.length) return null;
  const byType = Object.fromEntries(PROOF_TYPES.map((type) => [type, labelled.filter((row) => row.proof.includes(type)).length]));
  const acceptedRows = labelled.filter((row) => row.proof.includes('choice'));
  const unprovenRows = labelled.filter((row) => !row.proof.length);
  return {
    proven: labelled.length - unprovenRows.length - acceptedRows.length,
    byType: acceptedRows.length ? { ...byType, choice: acceptedRows.length } : byType,
    unproven: unprovenRows.length,
    unprovenSteps: unprovenRows.slice(0, 4).map((row) => row.id),
    ...(acceptedRows.length ? { accepted: acceptedRows.length, acceptedSteps: acceptedRows.slice(0, 4).map((row) => row.id) } : {}),
  };
}

/**
 * The end-of-run proof line (§2.10), or null when no step carries a label:
 * `proof: 4 steps proven (command 3, schema 1, review 1) · 1 finished · unproven: readme`.
 */
export function formatV2ProofLine(summary) {
  const proof = summary?.proof;
  if (!proof) return null;
  const parts = [];
  if (proof.proven > 0) {
    const types = Object.entries(proof.byType ?? {}).filter(([type, count]) => type !== 'choice' && count > 0).map(([type, count]) => `${type} ${count}`);
    parts.push(`${proof.proven} step${proof.proven === 1 ? '' : 's'} proven${types.length ? ` (${types.join(', ')})` : ''}`);
  }
  if (proof.accepted > 0) {
    const names = proof.acceptedSteps ?? [];
    const more = proof.accepted - names.length;
    parts.push(`${proof.accepted} accepted by choice${names.length ? `: ${names.join(', ')}${more > 0 ? ` and ${more} more` : ''}` : ''}`);
  }
  if (proof.unproven > 0) {
    const names = proof.unprovenSteps ?? [];
    const more = proof.unproven - names.length;
    parts.push(`${proof.unproven} finished · unproven${names.length ? `: ${names.join(', ')}${more > 0 ? ` and ${more} more` : ''}` : ''}`);
  }
  return parts.length ? `proof: ${parts.join(' · ')}` : null;
}

function runDirOf(actions, runDir) {
  if (typeof runDir === 'string' && runDir) return runDir;
  const sample = actions.map((action) => action.outFile).find((file) => typeof file === 'string' && file.includes('/'));
  return sample ? sample.slice(0, sample.lastIndexOf('/')) : null;
}

export function summarizeV2Result(envelope, state = null, { runDir = null, features } = {}) {
  const concerns = envelope.requirements.flatMap((requirement) =>
    requirement.evidence.flatMap((entry) => entry.concerns ?? []));
  const shortId = envelope.shortId ?? envelope.runId;
  let runFeatures = features;
  if (runFeatures === undefined) {
    const dir = runDirOf(envelope.actions.map((action) => ({ outFile: fallback(action.outFile, action.outputFile) })), runDir);
    runFeatures = dir ? readRunFeatures(dir) : {};
  }
  const flags = runFeatureFlags(runFeatures);
  const actions = envelope.actions.map((action) => {
    const definition = stateActionFor(state, action.id);
    const attempt = latestAttemptFor(state, action.id);
    // A label only under the marker, or on a step that declares evidence (E23).
    const proof = action.status === 'succeeded' ? stepProof(state, definition, { features: runFeatures ?? {} }) : null;
    const acceptance = action.acceptance ?? (state?.actions ?? []).find((entry) => entry.id === action.id)?.acceptance ?? null;
    const accepted = action.status === 'succeeded' && acceptance && !Array.isArray(acceptance.requirements) ? firstLine(acceptance.reason, 80) : null;
    return {
      id: action.id,
      kind: fallback(action.kind, definition?.kind),
      ...roleField(fallback(action.role, definition?.role)),
      lane: fallback(action.lane, definition?.lane),
      effort: fallback(action.effort, definition?.effort),
      status: action.status,
      ...(proof ? { proof: proof.by } : {}),
      ...(accepted ? { accepted } : {}),
      pool: fallback(action.pool, attempt?.pool),
      model: fallback(action.model, attempt?.model),
      reasoning: appliedReasoning(fallback(action.reasoning, attempt?.reasoning)),
      wallSec: fallback(action.wallSec, attempt?.wallSec),
      outFile: fallback(action.outFile, fallback(action.outputFile, attempt?.outputFile)),
      bytes: normalizeBytes(fallback(action.bytes, attempt?.bytes)),
    };
  });
  const handback = envelope.handback ?? legacyHandback(envelope);
  const proof = summaryProof(actions);
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
      // Only an open requirement carries a reason: that line is what the
      // caller acts on. A passed requirement's evidence is in the full result.
      why: requirement.status === 'passed'
        ? null
        : firstLine(requirement.evidence.at(-1)?.evidence?.[0], 200)
          ?? firstLine(handback?.unresolvedRequirements?.find((entry) => entry.id === requirement.id)?.why, 200),
      // Accepted by choice (L5): the reason, as on a step row; verified stays false.
      ...(requirement.accepted ? { accepted: firstLine(requirement.accepted.reason, 80) } : {}),
    })),
    actions,
    ...(proof ? { proof } : {}),
    concerns: {
      count: concerns.length,
      first: concerns.slice(0, 3).map((concern) => firstLine(concern, 160)).filter(Boolean),
    },
    usage: clone(envelope.usage),
    ...(handback ? { handback: summaryHandback(envelope, handback, shortId, { failureRule: flags.failureRule, actions }) } : {}),
    // The loop's rounds once one ran, and the caller's block when there is one.
    ...(envelope.verifyRounds?.used > 0 ? { verifyRounds: clone(envelope.verifyRounds) } : {}),
    ...(envelope.callerDecision ? { callerDecision: clone(envelope.callerDecision) } : {}),
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
  const allowed = new Set(['schemaVersion', 'runId', 'shortId', 'intentId', 'goal', 'status', 'verified', 'reason', 'requirements', 'actions', 'gaps', 'usage', 'finishedAt', 'executionMode', 'workspace', 'handback', 'verifyRounds', 'callerDecision']);
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
  exactFields(result.usage, new Set(['total', 'byPool', 'bytes', 'steps', 'totals']), 'usage');
  validateResultUsageBytes(result.usage.bytes, 'usage.bytes');
  if (!Number.isFinite(result.usage.total) || result.usage.total < 0) resultFail('usage.total must be non-negative');
  resultObject(result.usage.byPool, 'usage.byPool');
  for (const [pool, total] of Object.entries(result.usage.byPool)) {
    resultString(pool, 'usage.byPool key');
    if (!Number.isFinite(total) || total < 0) resultFail(`usage.byPool.${pool} must be non-negative`);
  }
  if (result.usage.steps !== undefined) {
    resultObject(result.usage.steps, 'usage.steps');
    for (const [actionId, aggregate] of Object.entries(result.usage.steps)) {
      resultString(actionId, 'usage.steps key');
      validateUsageAggregate(aggregate, `usage.steps.${actionId}`);
    }
  }
  if (result.usage.totals !== undefined) validateUsageAggregate(result.usage.totals, 'usage.totals');
  if (result.verified && result.requirements.some((requirement) => requirement.mandatory && requirement.status !== 'passed')) resultFail('verified result has an unresolved mandatory requirement');
  const liveActions = result.actions.filter((action) => action.status !== 'removed');
  if (program && result.status === 'completed' && (!liveActions.length || liveActions.some((action) => action.status !== 'succeeded'))) resultFail('completed program must have successful actions');
  if (result.verified && result.gaps !== null) resultFail('verified result must not contain gaps');
  if (!result.verified) validateGaps(result.gaps, result);
  if (result.workspace !== undefined) {
    if (!program) resultFail('workspace report requires program execution');
    resultObject(result.workspace, 'workspace');
    exactFields(result.workspace, new Set(['cwd', 'changedFiles', 'baselineChangedFiles', 'warnings']), 'workspace');
    resultString(result.workspace.cwd, 'workspace.cwd');
    for (const key of ['changedFiles', 'baselineChangedFiles', 'warnings']) stringArray(result.workspace[key], `workspace.${key}`);
  }
  // Optional: results written before 0.30.0 carry none.
  if (result.handback !== undefined) validateHandback(result.handback);
  // Optional: results written before 0.35.2 carry neither.
  if (result.verifyRounds !== undefined) validateResultVerifyRounds(result.verifyRounds);
  if (result.callerDecision !== undefined && result.callerDecision !== null) {
    validateResultCallerDecision(result.callerDecision);
    // A verified run can only leave the caller requirements no evidence step covers.
    if (result.verified && result.callerDecision.requirements.some((entry) => entry.status !== NOT_JUDGED_STATUS)) resultFail('a verified result has no callerDecision except for not judged requirements');
  }
  return true;
}

const VERIFY_ROUND_STOPS = new Set(['passed', 'rounds', 'revision', 'step-failed', 'act-step']);

function validateResultVerifyRounds(value) {
  resultObject(value, 'verifyRounds');
  exactFields(value, new Set(['max', 'used', 'stoppedBy', 'phases']), 'verifyRounds');
  if (!Number.isInteger(value.max) || value.max < 1 || value.max > 4) resultFail('verifyRounds.max must be 1 to 4');
  if (!Number.isInteger(value.used) || value.used < 0 || value.used > 4) resultFail('verifyRounds.used must be 0 to 4');
  if (value.stoppedBy !== null && !VERIFY_ROUND_STOPS.has(value.stoppedBy)) resultFail('verifyRounds.stoppedBy is invalid');
  if (!Array.isArray(value.phases)) resultFail('verifyRounds.phases must be an array');
  value.phases.forEach((phase, index) => {
    const name = `verifyRounds.phases[${index}]`;
    resultObject(phase, name);
    exactFields(phase, new Set(['kind', 'round', 'steps', 'judged', 'failed', 'notJudged', 'requirements', 'wallMinutes', 'pools', 'apiUsd', 'unmeasured', 'cost']), name);
    if (!['verify', 'repair'].includes(phase.kind)) resultFail(`${name}.kind must be verify|repair`);
    if (!Number.isInteger(phase.round) || phase.round < 1 || phase.round > 4) resultFail(`${name}.round must be 1 to 4`);
    stringArray(phase.steps, `${name}.steps`);
    stringArray(phase.pools, `${name}.pools`);
    if (phase.kind === 'verify') {
      if (!Number.isInteger(phase.judged) || phase.judged < 0) resultFail(`${name}.judged must be a non-negative integer`);
      stringArray(phase.failed, `${name}.failed`);
      if (phase.notJudged !== undefined) stringArray(phase.notJudged, `${name}.notJudged`);
    } else stringArray(phase.requirements, `${name}.requirements`);
    for (const field of ['wallMinutes', 'apiUsd']) {
      if (phase[field] !== null && (typeof phase[field] !== 'number' || !Number.isFinite(phase[field]) || phase[field] < 0)) resultFail(`${name}.${field} must be null or a non-negative number`);
    }
    if (!Number.isInteger(phase.unmeasured) || phase.unmeasured < 0) resultFail(`${name}.unmeasured must be a non-negative integer`);
    resultString(phase.cost, `${name}.cost`);
  });
}

function validateResultCallerDecision(value) {
  resultObject(value, 'callerDecision');
  exactFields(value, new Set(['verifyRounds', 'requirements']), 'callerDecision');
  if (typeof value.verifyRounds !== 'string' || !/^\d\/[1-4]$/.test(value.verifyRounds)) resultFail('callerDecision.verifyRounds must read used/max');
  if (!Array.isArray(value.requirements) || !value.requirements.length) resultFail('callerDecision.requirements must be a non-empty array');
  value.requirements.forEach((entry, index) => {
    const name = `callerDecision.requirements[${index}]`;
    resultObject(entry, name);
    exactFields(entry, new Set(['id', 'status', 'round', 'evidence', 'next']), name);
    resultString(entry.id, `${name}.id`);
    if (entry.status !== NOT_JUDGED_STATUS && (!REQUIREMENT_STATUSES.has(entry.status) || entry.status === 'passed')) resultFail(`${name}.status is invalid`);
    if (!Number.isInteger(entry.round) || entry.round < 1 || entry.round > 4) resultFail(`${name}.round must be 1 to 4`);
    if (typeof entry.evidence !== 'string') resultFail(`${name}.evidence must be a string`);
    resultString(entry.next, `${name}.next`);
  });
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
