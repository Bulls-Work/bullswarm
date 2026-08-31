import { ACTION_PROGRAM_SCHEMA_VERSION, validateActionProgram } from './action-validator.js';
import { fileURLToPath } from 'node:url';
import { consolidateV2Gaps } from './v2-outcome.js';
import { validateV2DurableState } from './v2-state.js';
import { deriveV2PresentationStages } from './v2-presentation.js';

export const V2_PLANNER_RESPONSE_SCHEMA_VERSION = 'bullswarm.workflow.planner-response.v2';

const RESPONSE_FIELDS = new Set(['schemaVersion', 'kind', 'summary', 'program', 'reason']);
const clone = (value) => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const plain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);

export class V2PlannerValidationError extends Error {
  constructor(issues) {
    super(`V2 planner response invalid: ${issues.length} problem(s)`);
    this.name = 'V2PlannerValidationError';
    this.issues = [...issues];
  }
}

function substantive(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function runtimeFromState(state) {
  const freshEvidenceRequirementIds = Object.values(state.ledger.requirements)
    .filter((requirement) => requirement.status === 'passed')
    .map((requirement) => requirement.id);
  const knownArtifacts = [];
  for (const action of state.program.actions) for (const id of action.produces ?? []) knownArtifacts.push({ id, producer: action.id });
  return {
    requirements: state.intent.requirements.map(({ id, mandatory }) => ({ id, mandatory })),
    knownActions: state.program.actions.map((action) => ({
      id: action.id,
      dependsOn: clone(action.dependsOn),
      affects: clone(action.affects),
      ownedFiles: clone(action.ownedFiles),
      evidenceFor: clone(action.evidenceFor),
      produces: clone(action.produces ?? []),
    })),
    knownArtifacts,
    freshEvidenceRequirementIds,
    workspaceMutation: state.intent.constraints?.workspaceMutation ?? 'allowed',
    maxActions: Math.max(0, Number(state.config.settings.maxActions ?? 100) - state.program.actions.length),
    maxParallel: state.config.settings.concurrency ?? state.config.settings.maxParallel ?? 100,
  };
}

export function validateV2PlannerResponse(response, state, { boundary = state?.program?.actions?.length ? 'gaps' : 'initial' } = {}) {
  validateV2DurableState(state);
  const issues = [];
  if (!plain(response)) throw new V2PlannerValidationError(['response must be a plain object']);
  for (const key of Object.keys(response)) if (!RESPONSE_FIELDS.has(key)) issues.push(`response.${key} is not allowed`);
  if (response.schemaVersion !== V2_PLANNER_RESPONSE_SCHEMA_VERSION) issues.push(`schemaVersion must be "${V2_PLANNER_RESPONSE_SCHEMA_VERSION}"`);
  if (!['program', 'exhausted'].includes(response.kind)) issues.push('kind must be program|exhausted');
  if (!substantive(response.summary)) issues.push('summary must be a substantive string');
  let program = null;
  if (response.kind === 'program') {
    if (response.reason !== undefined) issues.push('reason is allowed only for kind=exhausted');
    if (!plain(response.program)) issues.push('program must be an object for kind=program');
    else try { program = validateActionProgram(response.program, runtimeFromState(state)); }
    catch (error) { issues.push(...(Array.isArray(error?.issues) ? error.issues : [error.message])); }
  }
  if (response.kind === 'exhausted') {
    if (boundary !== 'gaps') issues.push('kind=exhausted is allowed only at a real gap boundary');
    if (response.program !== undefined) issues.push('program is not allowed for kind=exhausted');
    if (!substantive(response.reason)) issues.push('reason must be a substantive string for kind=exhausted');
  }
  if (issues.length) throw new V2PlannerValidationError(issues);
  return response.kind === 'program'
    ? { schemaVersion: V2_PLANNER_RESPONSE_SCHEMA_VERSION, kind: 'program', summary: response.summary.trim(), program }
    : { schemaVersion: V2_PLANNER_RESPONSE_SCHEMA_VERSION, kind: 'exhausted', summary: response.summary.trim(), reason: response.reason.trim() };
}

export function parseV2PlannerResponse(text, state, options = {}) {
  const source = String(text ?? '').trim();
  const ends = source.endsWith('```') ? source.slice(0, -3).trimEnd() : source;
  const starts = [];
  for (let index = 0; index < ends.length; index += 1) if (ends[index] === '{') starts.push(index);
  const errors = [];
  for (const start of starts) {
    try {
      const candidate = JSON.parse(ends.slice(start));
      return validateV2PlannerResponse(candidate, state, options);
    } catch (error) {
      if (Array.isArray(error?.issues)) errors.push(...error.issues);
      else errors.push(error.message);
    }
  }
  throw new V2PlannerValidationError(errors.length ? [...new Set(errors)] : ['response did not contain a trailing JSON object']);
}

export function createV2PlannerContext(state, { scout = null, steering = [], correction = null } = {}) {
  validateV2DurableState(state);
  const boundary = state.program.actions.length ? 'gaps' : 'initial';
  const actionStates = new Map(state.actions.map((action) => [action.id, action]));
  return {
    schemaVersion: 'bullswarm.workflow.planner-context.v2',
    boundary,
    intent: clone(state.intent),
    limits: {
      maxActionsRemaining: Math.max(0, Number(state.config.settings.maxActions ?? 100) - state.program.actions.length),
      maxParallel: state.config.settings.concurrency ?? state.config.settings.maxParallel ?? 1,
      expansionRoundsRemaining: Math.max(0, Number(state.config.settings.maxExpansionRounds ?? 1) - Number(state.budget.expansions ?? 0)),
    },
    knownActions: state.program.actions.map((action) => ({
      id: action.id, purpose: action.purpose, dependsOn: clone(action.dependsOn),
      affects: clone(action.affects), evidenceFor: clone(action.evidenceFor),
      ownedFiles: clone(action.ownedFiles), produces: clone(action.produces ?? []),
      status: actionStates.get(action.id)?.status ?? 'pending',
    })),
    freshPassedRequirements: Object.values(state.ledger.requirements).filter((requirement) => requirement.status === 'passed').map((requirement) => requirement.id),
    gaps: boundary === 'gaps' ? consolidateV2Gaps(state) : null,
    scout: scout == null ? null : String(scout),
    steering: Array.isArray(steering) ? steering.map(String) : [],
    correction: correction == null ? null : clone(correction),
  };
}

export function buildV2PlannerPrompt(context) {
  if (!plain(context) || context.schemaVersion !== 'bullswarm.workflow.planner-context.v2') throw new TypeError('invalid V2 planner context');
  return [
    'You are the single logical Workflow Planner for Bullswarm autonomous V2.',
    'Propose the smallest complete bounded action program that can satisfy the supplied requirements. The kernel, not you, decides completion and failure.',
    'Use only generic actions. A work action declares affects and any exact ownedFiles. An evidence action declares evidenceFor, has empty affects/ownedFiles, and independently inspects the work it judges.',
    'Dependencies represent required data or exact-file ordering only. Do not serialize unrelated work. Do not add reviewer, verify, repair, phase, completion, pool, model, timeout, or retry fields.',
    'Every mandatory unresolved requirement needs an evidence action. File-disjoint work should be parallel. Prompts must be self-contained and include exact scope plus acceptance evidence.',
    context.intent.constraints?.workspaceMutation === 'forbidden'
      ? 'This goal is deterministically read-only. Every action must have empty ownedFiles and must not modify workspace files; reports belong in the action output artifact.'
      : 'Workspace mutation is allowed only through exact ownedFiles declared by the action.',
    context.boundary === 'gaps'
      ? 'This is one consolidated gap boundary. Propose only new actions that close the supplied gaps. If no useful bounded action remains, return kind=exhausted with a concrete reason; this does not declare workflow failure.'
      : 'This is initial planning. Return kind=program with the complete useful program; kind=exhausted is invalid here.',
    'Return only one JSON object with schemaVersion bullswarm.workflow.planner-response.v2.',
    'For kind=program use: {schemaVersion,kind:"program",summary,program:{schemaVersion:"bullswarm.workflow.program.v2",actions:[...]}}.',
    'For an exhausted gap boundary use: {schemaVersion,kind:"exhausted",summary,reason}.',
    '',
    JSON.stringify(context),
  ].join('\n');
}

export function applyV2PlannerResponse(state, response, options = {}) {
  const accepted = validateV2PlannerResponse(response, state, options);
  const next = clone(state);
  next.planner.turns += 1;
  next.planner.lastDecision = { kind: accepted.kind, summary: accepted.summary, ...(accepted.kind === 'exhausted' ? { reason: accepted.reason } : {}) };
  if (accepted.kind === 'exhausted') {
    next.planner.status = 'completed';
    return next;
  }
  next.planner.status = 'waiting';
  const revision = next.program.revision + 1;
  next.program = {
    schemaVersion: ACTION_PROGRAM_SCHEMA_VERSION,
    revision,
    actions: [...next.program.actions, ...accepted.program.actions],
  };
  next.presentation.stages.push(...deriveV2PresentationStages(accepted.program.actions, revision));
  for (const action of accepted.program.actions) next.actions.push({
    id: action.id, status: 'pending', attempts: 0, programRevision: revision,
    workRevision: next.ledger.workRevision, startedAt: null, finishedAt: null,
    outputFile: null, artifactIds: [], lastFailure: null,
  });
  next.lifecycle.status = 'running';
  return next;
}

export function plannerCorrectionRequest(error, { attempt, maxCorrections = 1 } = {}) {
  if (!(error instanceof V2PlannerValidationError)) throw new TypeError('planner correction requires V2PlannerValidationError');
  if (!Number.isInteger(attempt) || attempt < 1 || !Number.isInteger(maxCorrections) || maxCorrections < 0) throw new TypeError('invalid planner correction bounds');
  return {
    allowed: attempt <= maxCorrections,
    attempt,
    maxCorrections,
    issues: [...error.issues],
    instruction: attempt <= maxCorrections
      ? 'Return one corrected full V2 planner response. Do not discuss the errors.'
      : 'Planner correction allowance exhausted; do not dispatch workers.',
  };
}

export function buildPlannerPreflight(statePath, boundary = 'initial', checkerPath = null) {
  if (typeof statePath !== 'string' || !statePath) throw new TypeError('statePath must be a non-empty string');
  if (!['initial', 'gaps'].includes(boundary)) throw new TypeError('boundary must be initial|gaps');
  const checker = checkerPath ?? fileURLToPath(new URL('../../bin/check-v2-plan.js', import.meta.url));
  const shellQuote = (value) => `'${String(value).replaceAll("'", `'"'"'`)}'`;
  const command = `${shellQuote(process.execPath)} ${shellQuote(checker)} --state ${shellQuote(statePath)} --boundary ${boundary} --value "$candidate_file"`;
  return [
    'MANDATORY V2 PLANNER PREFLIGHT before replying:',
    '1. Write only your complete planner response JSON to a temporary file: candidate_file=$(mktemp)',
    `2. Run: ${command}`,
    '3. If it exits non-zero, fix the candidate and rerun until it exits zero.',
    '4. End your response with the exact validated planner response, then remove the temporary file.',
  ].join('\n');
}

export const validatePlannerResponse = validateV2PlannerResponse;
