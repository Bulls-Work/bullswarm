import { createHash } from 'node:crypto';
import { ACTION_PROGRAM_SCHEMA_VERSION, validateActionProgram } from './action-validator.js';
import { createLedger, deserializeLedger, serializeLedger } from './ledger.js';

export const V2_GOAL_SCHEMA_VERSION = 'bullswarm.workflow.goal.v2';
export const V2_STATE_SCHEMA_VERSION = 'bullswarm.workflow.state.v2';
export const GOAL_SCHEMA_VERSION = V2_GOAL_SCHEMA_VERSION;
export const STATE_SCHEMA_VERSION = V2_STATE_SCHEMA_VERSION;

const ID_RE = /^[a-z0-9][a-z0-9-]*$/;
const LEGACY_FIELDS = new Set([
  'phases', 'steps', 'graph', 'engine', 'engineSelector',
  'verify', 'reviewer', 'repair', 'decisions', 'decision', 'result', 'completion',
]);
const ROUTING_KEYS = new Set(['pool', 'model', 'preferredPool', 'preferredModel', 'strictPool']);
const PLANNER_STATUSES = new Set(['pending', 'running', 'waiting', 'completed', 'failed', 'cancelled']);
const ACTION_STATUSES = new Set(['pending', 'ready', 'running', 'waiting', 'succeeded', 'failed', 'blocked', 'cancelled', 'interrupted']);
const ATTEMPT_STATUSES = new Set(['pending', 'running', 'succeeded', 'failed', 'cancelled', 'interrupted']);
const LIFECYCLE_STATUSES = new Set(['queued', 'planning', 'running', 'waiting', 'ready-to-finalize', 'completed', 'partial', 'cancelled', 'failed']);
const PREFLIGHT_STATUSES = new Set(['pending', 'running', 'succeeded', 'failed', 'skipped']);
const ACTION_STATE_FIELDS = new Set([
  'id', 'status', 'attempts', 'programRevision', 'workRevision', 'startedAt', 'finishedAt',
  'outputFile', 'artifactIds', 'lastFailure',
]);
const ATTEMPT_FIELDS = new Set([
  'id', 'actionId', 'ordinal', 'status', 'pool', 'model', 'startedAt',
  'finishedAt', 'taskFile', 'outputFile', 'failure', 'failureKind', 'why',
  'usage', 'routing', 'continued', 'lastActivityAt', 'lastEventAt',
  'outputBytesObserved', 'lastAgentEvent', 'wallSec',
]);
const PLANNER_SESSION_FIELDS = new Set([
  'pool', 'model', 'sessionId', 'startedAt', 'lastUsedAt', 'generation',
]);
const PLANNER_ATTEMPT_FIELDS = new Set([
  'ordinal', 'turn', 'status', 'pool', 'model', 'startedAt', 'finishedAt',
  'taskFile', 'outputFile', 'failureKind', 'why', 'usage', 'continued',
  'lastActivityAt', 'lastEventAt', 'outputBytesObserved', 'lastAgentEvent', 'wallSec',
]);
const PRESENTATION_STAGE_FIELDS = new Set([
  'id', 'label', 'revision', 'actionIds', 'startedAt', 'completedAt',
]);
const STEERING_FIELDS = new Set([
  'id', 'message', 'queuedAt', 'delivery', 'status', 'deliveredAt', 'decisionSequence',
]);
const INTENT_CONSTRAINT_FIELDS = new Set(['workspaceMutation']);
const GOAL_SETTING_FIELDS = new Set([
  'concurrency', 'workspaceMode', 'maxAgents', 'maxActions',
  'maxExpansionRounds', 'maxMechanicalRetries', 'maxManifestFiles', 'scout',
  'suggestedPlan',
]);

export class V2StateValidationError extends TypeError {
  constructor(message) {
    super(`Invalid V2 autonomous workflow data: ${message}`);
    this.name = 'V2StateValidationError';
  }
}

const clone = (value) => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = (message) => { throw new V2StateValidationError(message); };

function requiredString(value, name) {
  if (typeof value !== 'string' || !value.trim()) fail(`${name} must be a non-empty string`);
  return value;
}

function identifier(value, name) {
  requiredString(value, name);
  if (!ID_RE.test(value)) fail(`${name} must be a lowercase kebab-case ID`);
  return value;
}

function object(value, name) {
  if (!isObject(value)) fail(`${name} must be an object`);
  return value;
}

function noUnknown(value, allowed, name) {
  for (const key of Object.keys(value)) {
    if (LEGACY_FIELDS.has(key)) fail(`${name}.${key} is a legacy autonomous field`);
    if (!allowed.has(key)) fail(`${name}.${key} is not allowed`);
  }
}

function nonNegativeInteger(value, name) {
  if (!Number.isInteger(value) || value < 0) fail(`${name} must be a non-negative integer`);
  return value;
}

function positiveInteger(value, name) {
  if (!Number.isInteger(value) || value < 1) fail(`${name} must be a positive integer`);
  return value;
}

function goalSettings(value) {
  object(value, 'goalDocument.config.settings');
  noUnknown(value, GOAL_SETTING_FIELDS, 'goalDocument.config.settings');
  for (const key of ['concurrency', 'maxAgents', 'maxActions', 'maxExpansionRounds', 'maxManifestFiles']) {
    if (value[key] !== undefined) positiveInteger(value[key], `goalDocument.config.settings.${key}`);
  }
  if (value.maxMechanicalRetries !== undefined) {
    nonNegativeInteger(value.maxMechanicalRetries, 'goalDocument.config.settings.maxMechanicalRetries');
  }
  if (value.workspaceMode !== undefined && !['shared', 'isolated'].includes(value.workspaceMode)) {
    fail('goalDocument.config.settings.workspaceMode must be shared or isolated');
  }
  if (value.scout !== undefined && typeof value.scout !== 'boolean') {
    fail('goalDocument.config.settings.scout must be a boolean');
  }
  if (value.suggestedPlan !== undefined) {
    requiredString(value.suggestedPlan, 'goalDocument.config.settings.suggestedPlan');
  }
  return clone(value);
}

function nullableString(value, name) {
  if (value !== null && (typeof value !== 'string' || !value)) fail(`${name} must be null or a non-empty string`);
}

function timestamp(value, name) {
  nullableString(value, name);
  if (value !== null && Number.isNaN(Date.parse(value))) fail(`${name} must be an ISO-compatible timestamp`);
}

function requirementsFor(value) {
  if (!Array.isArray(value) || !value.length) fail('requirements must be a non-empty array');
  const ids = new Set();
  return value.map((entry, index) => {
    object(entry, `requirements[${index}]`);
    noUnknown(entry, new Set(['id', 'text', 'mandatory', 'workRevision']), `requirements[${index}]`);
    const id = identifier(entry.id, `requirements[${index}].id`);
    if (ids.has(id)) fail(`duplicate requirement id ${id}`);
    ids.add(id);
    const text = requiredString(entry.text, `requirements[${index}].text`);
    if (entry.mandatory !== undefined && typeof entry.mandatory !== 'boolean') fail(`requirements[${index}].mandatory must be a boolean`);
    if (entry.workRevision !== undefined && ((typeof entry.workRevision !== 'string' && typeof entry.workRevision !== 'number') || entry.workRevision === '')) fail(`requirements[${index}].workRevision must be a string or number`);
    return { id, text, mandatory: entry.mandatory !== false, ...(entry.workRevision !== undefined ? { workRevision: entry.workRevision } : {}) };
  });
}

function routing(value, name) {
  if (value == null) return null;
  object(value, name);
  for (const key of Object.keys(value)) if (!ROUTING_KEYS.has(key)) fail(`${name}.${key} is not allowed`);
  for (const key of Object.keys(value)) if (value[key] !== null && typeof value[key] !== 'string') fail(`${name}.${key} must be a string or null`);
  return clone(value);
}

function intentConstraints(value) {
  if (value == null) return null;
  object(value, 'goalDocument.intent.constraints');
  for (const key of Object.keys(value)) {
    if (!INTENT_CONSTRAINT_FIELDS.has(key)) fail(`goalDocument.intent.constraints.${key} is not allowed`);
  }
  if (!['allowed', 'forbidden'].includes(value.workspaceMutation)) {
    fail('goalDocument.intent.constraints.workspaceMutation must be allowed|forbidden');
  }
  return { workspaceMutation: value.workspaceMutation };
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (isObject(value)) return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}

function stableId(intent) {
  return `intent-${createHash('sha256').update(JSON.stringify(canonical(intent))).digest('hex').slice(0, 16)}`;
}

function validateGoal(goal) {
  object(goal, 'goalDocument');
  noUnknown(goal, new Set(['schemaVersion', 'intentId', 'intent', 'config']), 'goalDocument');
  if (goal.schemaVersion !== V2_GOAL_SCHEMA_VERSION) fail(`goal schemaVersion must be ${V2_GOAL_SCHEMA_VERSION}`);
  requiredString(goal.intentId, 'goalDocument.intentId');
  object(goal.intent, 'goalDocument.intent');
  noUnknown(goal.intent, new Set(['goal', 'cwd', 'requirements', 'constraints']), 'goalDocument.intent');
  requiredString(goal.intent.goal, 'goalDocument.intent.goal');
  requiredString(goal.intent.cwd, 'goalDocument.intent.cwd');
  const requirements = requirementsFor(goal.intent.requirements);
  intentConstraints(goal.intent.constraints);
  object(goal.config, 'goalDocument.config');
  noUnknown(goal.config, new Set(['settings', 'plannerRouting', 'workerRouting']), 'goalDocument.config');
  goalSettings(goal.config.settings);
  routing(goal.config.plannerRouting, 'goalDocument.config.plannerRouting');
  routing(goal.config.workerRouting, 'goalDocument.config.workerRouting');
  if (goal.intentId !== stableId({ ...goal.intent, requirements })) fail('goalDocument.intentId does not match its normalized intent');
  return { requirements };
}

export function createV2GoalDocument({ goal, cwd, requirements, constraints = null, settings = {}, plannerRouting = null, workerRouting = null } = {}) {
  requiredString(goal, 'goal');
  requiredString(cwd, 'cwd');
  const normalizedRequirements = requirementsFor(requirements);
  object(settings, 'settings');
  const normalizedConstraints = intentConstraints(constraints);
  const intent = {
    goal: goal.trim(), cwd, requirements: normalizedRequirements,
    ...(normalizedConstraints ? { constraints: normalizedConstraints } : {}),
  };
  const document = {
    schemaVersion: V2_GOAL_SCHEMA_VERSION,
    intentId: stableId(intent),
    intent,
    config: { settings: goalSettings(settings), plannerRouting: routing(plannerRouting, 'plannerRouting'), workerRouting: routing(workerRouting, 'workerRouting') },
  };
  validateGoal(document);
  return clone(document);
}

export function createV2DurableState(goalDocument, { runId, shortId } = {}) {
  validateGoal(goalDocument);
  requiredString(runId, 'runId');
  requiredString(shortId, 'shortId');
  const ledger = createLedger(goalDocument.intent.requirements.map(({ id, mandatory, workRevision }) => ({ id, mandatory, workRevision })), { workRevision: goalDocument.intent.requirements[0].workRevision ?? 'initial' });
  return clone({
    schemaVersion: V2_STATE_SCHEMA_VERSION,
    runId, shortId, intentId: goalDocument.intentId,
    intent: goalDocument.intent,
    config: goalDocument.config,
    lifecycle: { status: 'queued', startedAt: null, finishedAt: null, resultFile: null },
    preflight: { scout: { status: goalDocument.config.settings.scout === false ? 'skipped' : 'pending', startedAt: null, finishedAt: null, outputFile: null, attempts: [], lastFailure: null } },
    planner: { status: 'pending', turns: 0, lastDecision: null, session: null, attempts: [] },
    program: { schemaVersion: ACTION_PROGRAM_SCHEMA_VERSION, revision: 0, actions: [] },
    presentation: { stages: [] },
    actions: [], attempts: [], steering: [],
    budget: { agents: 0, seconds: 0, expansions: 0 },
    cancellation: { requested: false, requestedAt: null, reason: null },
    usage: { total: 0, byPool: {} },
    events: { sequence: 0, last: null },
    ledger,
  });
}

function validatePlanner(planner) {
  object(planner, 'state.planner');
  noUnknown(planner, new Set(['status', 'turns', 'lastDecision', 'session', 'attempts']), 'state.planner');
  if (!PLANNER_STATUSES.has(planner.status)) fail('state.planner.status is invalid');
  nonNegativeInteger(planner.turns, 'state.planner.turns');
  if (planner.lastDecision !== null && !isObject(planner.lastDecision)) fail('state.planner.lastDecision must be null or an object');
  if (planner.turns === 0 && planner.lastDecision !== null) fail('state.planner.lastDecision requires at least one planner turn');
  if (planner.session !== null) {
    object(planner.session, 'state.planner.session');
    noUnknown(planner.session, PLANNER_SESSION_FIELDS, 'state.planner.session');
    for (const field of ['pool', 'model', 'sessionId']) requiredString(planner.session[field], `state.planner.session.${field}`);
    timestamp(planner.session.startedAt, 'state.planner.session.startedAt');
    timestamp(planner.session.lastUsedAt, 'state.planner.session.lastUsedAt');
    nonNegativeInteger(planner.session.generation, 'state.planner.session.generation');
    if (planner.session.generation < 1) fail('state.planner.session.generation must be positive');
  }
  if (!Array.isArray(planner.attempts)) fail('state.planner.attempts must be an array');
  for (const [index, attempt] of planner.attempts.entries()) {
    object(attempt, `state.planner.attempts[${index}]`);
    noUnknown(attempt, PLANNER_ATTEMPT_FIELDS, `state.planner.attempts[${index}]`);
    nonNegativeInteger(attempt.ordinal, `state.planner.attempts[${index}].ordinal`);
    nonNegativeInteger(attempt.turn, `state.planner.attempts[${index}].turn`);
    if (attempt.ordinal < 1 || attempt.turn < 1) fail(`state.planner.attempts[${index}] ordinal and turn must be positive`);
    if (!ATTEMPT_STATUSES.has(attempt.status)) fail(`state.planner.attempts[${index}].status is invalid`);
    for (const field of ['pool', 'model', 'taskFile', 'outputFile', 'failureKind', 'why']) if (attempt[field] !== undefined) nullableString(attempt[field], `state.planner.attempts[${index}].${field}`);
    for (const field of ['startedAt', 'finishedAt']) if (attempt[field] !== undefined) timestamp(attempt[field], `state.planner.attempts[${index}].${field}`);
    if (attempt.usage !== undefined && attempt.usage !== null && !isObject(attempt.usage)) fail(`state.planner.attempts[${index}].usage must be null or an object`);
    if (attempt.continued !== undefined && typeof attempt.continued !== 'boolean') fail(`state.planner.attempts[${index}].continued must be a boolean`);
    for (const field of ['lastActivityAt', 'lastEventAt']) if (attempt[field] !== undefined) timestamp(attempt[field], `state.planner.attempts[${index}].${field}`);
    if (attempt.outputBytesObserved !== undefined && (!Number.isFinite(attempt.outputBytesObserved) || attempt.outputBytesObserved < 0)) fail(`state.planner.attempts[${index}].outputBytesObserved must be a non-negative finite number`);
    if (attempt.wallSec !== undefined && attempt.wallSec !== null && (!Number.isFinite(attempt.wallSec) || attempt.wallSec < 0)) fail(`state.planner.attempts[${index}].wallSec must be null or a non-negative finite number`);
    if (attempt.lastAgentEvent !== undefined && attempt.lastAgentEvent !== null && !isObject(attempt.lastAgentEvent)) fail(`state.planner.attempts[${index}].lastAgentEvent must be null or an object`);
  }
}

function validateEvents(events) {
  object(events, 'state.events');
  noUnknown(events, new Set(['sequence', 'last']), 'state.events');
  nonNegativeInteger(events.sequence, 'state.events.sequence');
  if (events.last !== null) {
    object(events.last, 'state.events.last');
    noUnknown(events.last, new Set(['sequence', 'type', 'committedAt']), 'state.events.last');
    nonNegativeInteger(events.last.sequence, 'state.events.last.sequence');
    if (events.last.sequence !== events.sequence || events.sequence === 0) fail('state.events.last sequence must match state.events.sequence');
    requiredString(events.last.type, 'state.events.last.type');
    timestamp(events.last.committedAt, 'state.events.last.committedAt');
  } else if (events.sequence !== 0) fail('state.events.last is required when sequence is non-zero');
}

function validatePresentation(presentation, program) {
  object(presentation, 'state.presentation');
  noUnknown(presentation, new Set(['stages']), 'state.presentation');
  if (!Array.isArray(presentation.stages)) fail('state.presentation.stages must be an array');
  const programIds = new Set(program.actions.map((action) => action.id));
  const assigned = new Set();
  const stageIds = new Set();
  for (const [index, stage] of presentation.stages.entries()) {
    object(stage, `state.presentation.stages[${index}]`);
    noUnknown(stage, PRESENTATION_STAGE_FIELDS, `state.presentation.stages[${index}]`);
    const id = identifier(stage.id, `state.presentation.stages[${index}].id`);
    if (stageIds.has(id)) fail(`duplicate presentation stage ${id}`);
    stageIds.add(id);
    requiredString(stage.label, `state.presentation.stages[${index}].label`);
    nonNegativeInteger(stage.revision, `state.presentation.stages[${index}].revision`);
    if (stage.revision < 1 || stage.revision > program.revision) fail(`state.presentation.stages[${index}].revision must reference an existing program revision`);
    if (!Array.isArray(stage.actionIds) || !stage.actionIds.length) fail(`state.presentation.stages[${index}].actionIds must be a non-empty array`);
    for (const actionId of stage.actionIds) {
      identifier(actionId, `state.presentation.stages[${index}].actionIds`);
      if (!programIds.has(actionId)) fail(`presentation stage ${id} references unknown action ${actionId}`);
      if (assigned.has(actionId)) fail(`program action ${actionId} appears in multiple presentation stages`);
      assigned.add(actionId);
    }
    timestamp(stage.startedAt, `state.presentation.stages[${index}].startedAt`);
    timestamp(stage.completedAt, `state.presentation.stages[${index}].completedAt`);
    if (stage.completedAt && !stage.startedAt) fail(`presentation stage ${id} cannot complete before it starts`);
  }
  for (const actionId of programIds) if (!assigned.has(actionId)) fail(`presentation is missing program action ${actionId}`);
}

function validateLifecycle(lifecycle) {
  object(lifecycle, 'state.lifecycle');
  noUnknown(lifecycle, new Set(['status', 'startedAt', 'finishedAt', 'resultFile']), 'state.lifecycle');
  if (!LIFECYCLE_STATUSES.has(lifecycle.status)) fail('state.lifecycle.status is invalid');
  timestamp(lifecycle.startedAt, 'state.lifecycle.startedAt');
  timestamp(lifecycle.finishedAt, 'state.lifecycle.finishedAt');
  nullableString(lifecycle.resultFile, 'state.lifecycle.resultFile');
  if (lifecycle.finishedAt !== null && !['completed', 'partial', 'cancelled', 'failed'].includes(lifecycle.status)) fail('state.lifecycle.finishedAt requires a terminal status');
  if (lifecycle.resultFile !== null && !['completed', 'partial', 'cancelled', 'failed'].includes(lifecycle.status)) fail('state.lifecycle.resultFile requires a terminal status');
}

function validatePreflight(preflight) {
  object(preflight, 'state.preflight');
  noUnknown(preflight, new Set(['scout']), 'state.preflight');
  object(preflight.scout, 'state.preflight.scout');
  noUnknown(preflight.scout, new Set(['status', 'startedAt', 'finishedAt', 'outputFile', 'attempts', 'lastFailure']), 'state.preflight.scout');
  if (!PREFLIGHT_STATUSES.has(preflight.scout.status)) fail('state.preflight.scout.status is invalid');
  timestamp(preflight.scout.startedAt, 'state.preflight.scout.startedAt');
  timestamp(preflight.scout.finishedAt, 'state.preflight.scout.finishedAt');
  nullableString(preflight.scout.outputFile, 'state.preflight.scout.outputFile');
  if (preflight.scout.lastFailure !== null && !isObject(preflight.scout.lastFailure)) fail('state.preflight.scout.lastFailure must be null or an object');
  if (!Array.isArray(preflight.scout.attempts)) fail('state.preflight.scout.attempts must be an array');
  for (const [index, attempt] of preflight.scout.attempts.entries()) {
    object(attempt, `state.preflight.scout.attempts[${index}]`);
    noUnknown(attempt, PLANNER_ATTEMPT_FIELDS, `state.preflight.scout.attempts[${index}]`);
    if (!ATTEMPT_STATUSES.has(attempt.status)) fail(`state.preflight.scout.attempts[${index}].status is invalid`);
    for (const field of ['ordinal', 'turn']) if (attempt[field] !== undefined) nonNegativeInteger(attempt[field], `state.preflight.scout.attempts[${index}].${field}`);
    for (const field of ['pool', 'model', 'taskFile', 'outputFile', 'failureKind', 'why']) if (attempt[field] !== undefined) nullableString(attempt[field], `state.preflight.scout.attempts[${index}].${field}`);
    for (const field of ['startedAt', 'finishedAt', 'lastActivityAt', 'lastEventAt']) if (attempt[field] !== undefined) timestamp(attempt[field], `state.preflight.scout.attempts[${index}].${field}`);
    if (attempt.usage !== undefined && attempt.usage !== null && !isObject(attempt.usage)) fail(`state.preflight.scout.attempts[${index}].usage must be null or an object`);
    if (attempt.wallSec !== undefined && attempt.wallSec !== null && (!Number.isFinite(attempt.wallSec) || attempt.wallSec < 0)) fail(`state.preflight.scout.attempts[${index}].wallSec must be null or a non-negative finite number`);
    if (attempt.outputBytesObserved !== undefined && (!Number.isFinite(attempt.outputBytesObserved) || attempt.outputBytesObserved < 0)) fail(`state.preflight.scout.attempts[${index}].outputBytesObserved must be a non-negative finite number`);
    if (attempt.lastAgentEvent !== undefined && attempt.lastAgentEvent !== null && !isObject(attempt.lastAgentEvent)) fail(`state.preflight.scout.attempts[${index}].lastAgentEvent must be null or an object`);
  }
  if (preflight.scout.status === 'succeeded' && !preflight.scout.outputFile) fail('successful state.preflight.scout requires outputFile');
}

function validateProgram(program, state) {
  object(program, 'state.program');
  noUnknown(program, new Set(['schemaVersion', 'revision', 'actions']), 'state.program');
  if (program.schemaVersion !== ACTION_PROGRAM_SCHEMA_VERSION) fail(`state.program.schemaVersion must be ${ACTION_PROGRAM_SCHEMA_VERSION}`);
  nonNegativeInteger(program.revision, 'state.program.revision');
  if (!Array.isArray(program.actions)) fail('state.program.actions must be an array');
  if (!program.actions.length) {
    if (program.revision !== 0) fail('an empty state.program must have revision 0');
    return;
  }
  if (program.revision < 1) fail('a non-empty state.program must have a positive revision');
  const revisionById = new Map(state.actions.map((action) => [action.id, action.programRevision]));
  const knownActions = [];
  const knownArtifacts = [];
  try {
    for (let revision = 1; revision <= program.revision; revision += 1) {
      const actions = program.actions.filter((action) => revisionById.get(action.id) === revision);
      if (!actions.length) fail(`state.program revision ${revision} has no actions`);
      validateActionProgram(
        { schemaVersion: program.schemaVersion, actions },
        {
        requirements: state.intent.requirements.map(({ id, mandatory }) => ({ id, mandatory })),
        knownActions,
        knownArtifacts,
        freshEvidenceRequirementIds: [],
        workspaceMutation: state.intent.constraints?.workspaceMutation ?? 'allowed',
        requireMandatoryEvidence: false,
        maxActions: state.config.settings.maxActions ?? 100,
        maxParallel: state.config.settings.concurrency ?? state.config.settings.maxParallel ?? 100,
        enforceMaxActions: false,
        enforceMaxParallel: false,
        // Durable runs predate the current routing policy. Replay their exact
        // accepted program; strict lane/effort policy applies to new planner
        // candidates before dispatch, not historical display or resume.
        enforceRoutingPolicy: false,
        },
      );
      for (const action of actions) {
        knownActions.push({
          id: action.id, dependsOn: clone(action.dependsOn), affects: clone(action.affects),
          ownedFiles: clone(action.ownedFiles), evidenceFor: clone(action.evidenceFor),
          produces: clone(action.produces ?? []),
        });
        for (const artifact of action.produces ?? []) knownArtifacts.push({ id: artifact, producer: action.id });
      }
    }
  } catch (error) {
    if (error instanceof V2StateValidationError) throw error;
    const detail = Array.isArray(error?.issues) ? error.issues.join('; ') : error.message;
    fail(`state.program is invalid: ${detail}`);
  }
}

function validateActionStates(actions, program) {
  if (!Array.isArray(actions)) fail('state.actions must be an array');
  const programIds = new Set(program.actions.map((action) => action.id));
  const ids = new Set();
  for (const [index, action] of actions.entries()) {
    object(action, `state.actions[${index}]`);
    noUnknown(action, ACTION_STATE_FIELDS, `state.actions[${index}]`);
    const id = identifier(action.id, `state.actions[${index}].id`);
    if (!programIds.has(id)) fail(`state.actions[${index}] references unknown program action ${id}`);
    if (ids.has(id)) fail(`duplicate state action ${id}`);
    ids.add(id);
    if (!ACTION_STATUSES.has(action.status)) fail(`state.actions[${index}].status is invalid`);
    nonNegativeInteger(action.attempts, `state.actions[${index}].attempts`);
    nonNegativeInteger(action.programRevision, `state.actions[${index}].programRevision`);
    if (action.programRevision < 1 || action.programRevision > program.revision) fail(`state.actions[${index}].programRevision must reference an existing program revision`);
    if (action.workRevision !== undefined && ((typeof action.workRevision !== 'string' && typeof action.workRevision !== 'number') || action.workRevision === '')) fail(`state.actions[${index}].workRevision must be a string or number`);
    for (const field of ['startedAt', 'finishedAt']) if (action[field] !== undefined) timestamp(action[field], `state.actions[${index}].${field}`);
    if (action.outputFile !== undefined) nullableString(action.outputFile, `state.actions[${index}].outputFile`);
    if (action.artifactIds !== undefined && (!Array.isArray(action.artifactIds) || action.artifactIds.some((item) => typeof item !== 'string' || !ID_RE.test(item)))) fail(`state.actions[${index}].artifactIds must contain valid IDs`);
    if (action.lastFailure !== undefined && action.lastFailure !== null && !isObject(action.lastFailure)) fail(`state.actions[${index}].lastFailure must be null or an object`);
  }
  for (const id of programIds) if (!ids.has(id)) fail(`state.actions is missing program action ${id}`);
}

function validateAttempts(attempts, program) {
  if (!Array.isArray(attempts)) fail('state.attempts must be an array');
  const programIds = new Set(program.actions.map((action) => action.id));
  const attemptIds = new Set();
  for (const [index, attempt] of attempts.entries()) {
    object(attempt, `state.attempts[${index}]`);
    noUnknown(attempt, ATTEMPT_FIELDS, `state.attempts[${index}]`);
    const id = identifier(attempt.id, `state.attempts[${index}].id`);
    if (attemptIds.has(id)) fail(`duplicate attempt id ${id}`);
    attemptIds.add(id);
    const actionId = identifier(attempt.actionId, `state.attempts[${index}].actionId`);
    if (!programIds.has(actionId)) fail(`state.attempts[${index}] references unknown program action ${actionId}`);
    nonNegativeInteger(attempt.ordinal, `state.attempts[${index}].ordinal`);
    if (!ATTEMPT_STATUSES.has(attempt.status)) fail(`state.attempts[${index}].status is invalid`);
    for (const field of ['pool', 'model', 'taskFile', 'outputFile', 'failureKind', 'why']) if (attempt[field] !== undefined) nullableString(attempt[field], `state.attempts[${index}].${field}`);
    for (const field of ['startedAt', 'finishedAt', 'lastActivityAt', 'lastEventAt']) if (attempt[field] !== undefined) timestamp(attempt[field], `state.attempts[${index}].${field}`);
    if (attempt.failure !== undefined && attempt.failure !== null && !isObject(attempt.failure)) fail(`state.attempts[${index}].failure must be null or an object`);
    for (const field of ['usage', 'routing']) if (attempt[field] !== undefined && attempt[field] !== null && !isObject(attempt[field])) fail(`state.attempts[${index}].${field} must be null or an object`);
    if (attempt.continued !== undefined && typeof attempt.continued !== 'boolean') fail(`state.attempts[${index}].continued must be a boolean`);
    if (attempt.outputBytesObserved !== undefined && (!Number.isFinite(attempt.outputBytesObserved) || attempt.outputBytesObserved < 0)) fail(`state.attempts[${index}].outputBytesObserved must be a non-negative finite number`);
    if (attempt.wallSec !== undefined && attempt.wallSec !== null && (!Number.isFinite(attempt.wallSec) || attempt.wallSec < 0)) fail(`state.attempts[${index}].wallSec must be null or a non-negative finite number`);
    if (attempt.lastAgentEvent !== undefined && attempt.lastAgentEvent !== null && !isObject(attempt.lastAgentEvent)) fail(`state.attempts[${index}].lastAgentEvent must be null or an object`);
  }
}

function validateAttemptConsistency(actions, attempts) {
  const grouped = new Map(actions.map((action) => [action.id, []]));
  for (const attempt of attempts) grouped.get(attempt.actionId).push(attempt);
  for (const action of actions) {
    const records = grouped.get(action.id).sort((left, right) => left.ordinal - right.ordinal);
    if (records.length !== action.attempts) fail(`state action ${action.id}.attempts does not match durable attempt records`);
    for (let index = 0; index < records.length; index += 1) {
      if (records[index].ordinal !== index + 1) fail(`state action ${action.id} attempt ordinals must be unique and contiguous`);
    }
  }
}

function validateCounters(value, name) {
  object(value, name);
  for (const [key, count] of Object.entries(value)) {
    if (!/^[a-z][A-Za-z0-9]*$/.test(key)) fail(`${name}.${key} is not a valid counter name`);
    if (typeof count !== 'number' || !Number.isFinite(count) || count < 0) fail(`${name}.${key} must be a non-negative finite number`);
  }
}

function validatePoolUsage(value, name) {
  object(value, name);
  for (const [key, count] of Object.entries(value)) {
    if (typeof key !== 'string' || !key || key.includes('\0')) fail(`${name} contains an invalid pool name`);
    if (typeof count !== 'number' || !Number.isFinite(count) || count < 0) fail(`${name}.${key} must be a non-negative finite number`);
  }
}

function validateLedger(state) {
  let ledger;
  try { ledger = deserializeLedger(serializeLedger(state.ledger)); }
  catch (error) { fail(error.message); }
  const expected = new Map(state.intent.requirements.map((requirement) => [requirement.id, requirement]));
  const actualIds = Object.keys(ledger.requirements);
  if (actualIds.length !== expected.size) fail('state.ledger requirements do not match intent');
  for (const [id, requirement] of Object.entries(ledger.requirements)) {
    const intentRequirement = expected.get(id);
    if (!intentRequirement || requirement.mandatory !== intentRequirement.mandatory) fail(`state.ledger requirement ${id} does not match intent`);
  }
  return ledger;
}

function validateState(state) {
  object(state, 'state');
  noUnknown(state, new Set(['schemaVersion', 'runId', 'shortId', 'intentId', 'intent', 'config', 'lifecycle', 'preflight', 'planner', 'program', 'presentation', 'actions', 'attempts', 'steering', 'budget', 'cancellation', 'usage', 'events', 'ledger']), 'state');
  if (state.schemaVersion !== V2_STATE_SCHEMA_VERSION) fail(`state schemaVersion must be ${V2_STATE_SCHEMA_VERSION}`);
  requiredString(state.runId, 'state.runId');
  requiredString(state.shortId, 'state.shortId');
  requiredString(state.intentId, 'state.intentId');
  validateGoal({ schemaVersion: V2_GOAL_SCHEMA_VERSION, intentId: state.intentId, intent: state.intent, config: state.config });
  validateLifecycle(state.lifecycle);
  validatePreflight(state.preflight);
  validatePlanner(state.planner);
  validatePresentation(state.presentation, state.program);
  const ledger = validateLedger(state);
  validateActionStates(state.actions, state.program);
  validateProgram(state.program, { ...state, ledger });
  validateAttempts(state.attempts, state.program);
  validateAttemptConsistency(state.actions, state.attempts);
  if (!Array.isArray(state.steering)) fail('state.steering must be an array');
  const steeringIds = new Set();
  for (const [index, entry] of state.steering.entries()) {
    object(entry, `state.steering[${index}]`);
    noUnknown(entry, STEERING_FIELDS, `state.steering[${index}]`);
    requiredString(entry.id, `state.steering[${index}].id`);
    if (steeringIds.has(entry.id)) fail(`duplicate steering id ${entry.id}`);
    steeringIds.add(entry.id);
    requiredString(entry.message, `state.steering[${index}].message`);
    timestamp(entry.queuedAt, `state.steering[${index}].queuedAt`);
    requiredString(entry.delivery, `state.steering[${index}].delivery`);
    if (entry.status !== 'delivered_to_planner') fail(`state.steering[${index}].status is invalid`);
    timestamp(entry.deliveredAt, `state.steering[${index}].deliveredAt`);
    nonNegativeInteger(entry.decisionSequence, `state.steering[${index}].decisionSequence`);
    if (entry.decisionSequence < 1) fail(`state.steering[${index}].decisionSequence must be positive`);
  }
  validateCounters(state.budget, 'state.budget');
  object(state.cancellation, 'state.cancellation');
  noUnknown(state.cancellation, new Set(['requested', 'requestedAt', 'reason', 'source', 'requesterPid']), 'state.cancellation');
  if (typeof state.cancellation.requested !== 'boolean') fail('state.cancellation.requested must be a boolean');
  timestamp(state.cancellation.requestedAt, 'state.cancellation.requestedAt');
  nullableString(state.cancellation.reason, 'state.cancellation.reason');
  if (state.cancellation.source !== undefined) requiredString(state.cancellation.source, 'state.cancellation.source');
  if (state.cancellation.requesterPid !== undefined) {
    nonNegativeInteger(state.cancellation.requesterPid, 'state.cancellation.requesterPid');
    if (state.cancellation.requesterPid < 1) fail('state.cancellation.requesterPid must be positive');
  }
  if (!state.cancellation.requested && (
    state.cancellation.requestedAt !== null
    || state.cancellation.reason !== null
    || state.cancellation.source !== undefined
    || state.cancellation.requesterPid !== undefined
  )) fail('state.cancellation metadata requires requested=true');
  object(state.usage, 'state.usage');
  noUnknown(state.usage, new Set(['total', 'byPool']), 'state.usage');
  if (typeof state.usage.total !== 'number' || !Number.isFinite(state.usage.total) || state.usage.total < 0) fail('state.usage.total must be a non-negative finite number');
  validatePoolUsage(state.usage.byPool, 'state.usage.byPool');
  validateEvents(state.events);
  return state;
}

export function validateV2GoalDocument(document) { validateGoal(document); return true; }
export function validateV2DurableState(state) { validateState(state); return true; }
export function serializeV2GoalDocument(document) { validateGoal(document); return JSON.stringify(document); }
export function deserializeV2GoalDocument(serialized) {
  if (typeof serialized !== 'string') fail('serialized goal document must be a string');
  let value; try { value = JSON.parse(serialized); } catch { fail('serialized goal document must be valid JSON'); }
  validateGoal(value); return clone(value);
}
export function serializeV2DurableState(state) { validateState(state); return JSON.stringify(state); }
export function deserializeV2DurableState(serialized) {
  if (typeof serialized !== 'string') fail('serialized state must be a string');
  let value; try { value = JSON.parse(serialized); } catch { fail('serialized state must be valid JSON'); }
  validateState(value); return clone(value);
}

export function assertV2Resume(goalDocument, state, { runId, shortId } = {}) {
  if (!goalDocument || goalDocument.schemaVersion === undefined || !state || state.schemaVersion === undefined) fail('unsupported old autonomous run: missing V2 schemaVersion');
  validateGoal(goalDocument);
  validateState(state);
  if (state.intentId !== goalDocument.intentId) fail('state intentId does not match goal document');
  if (JSON.stringify(canonical(state.intent)) !== JSON.stringify(canonical(goalDocument.intent))) fail('state intent does not match goal document');
  if (JSON.stringify(canonical(state.config)) !== JSON.stringify(canonical(goalDocument.config))) fail('state config does not match goal document');
  if (runId !== undefined && state.runId !== runId) fail('runId does not match durable state');
  if (shortId !== undefined && state.shortId !== shortId) fail('shortId does not match durable state');
  return true;
}

export const createV2State = createV2DurableState;
export const assertV2ResumeCompatible = assertV2Resume;
