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
const ACTION_STATE_FIELDS = new Set([
  'id', 'status', 'attempts', 'workRevision', 'startedAt', 'finishedAt',
  'outputFile', 'artifactIds', 'lastFailure',
]);
const ATTEMPT_FIELDS = new Set([
  'id', 'actionId', 'ordinal', 'status', 'pool', 'model', 'startedAt',
  'finishedAt', 'outputFile', 'failure',
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
  noUnknown(goal.intent, new Set(['goal', 'cwd', 'requirements']), 'goalDocument.intent');
  requiredString(goal.intent.goal, 'goalDocument.intent.goal');
  requiredString(goal.intent.cwd, 'goalDocument.intent.cwd');
  const requirements = requirementsFor(goal.intent.requirements);
  object(goal.config, 'goalDocument.config');
  noUnknown(goal.config, new Set(['settings', 'plannerRouting', 'workerRouting']), 'goalDocument.config');
  object(goal.config.settings, 'goalDocument.config.settings');
  for (const key of Object.keys(goal.config.settings)) if (key.startsWith('engine') || LEGACY_FIELDS.has(key) || key === 'actions') fail(`goalDocument.config.settings.${key} is a legacy field`);
  routing(goal.config.plannerRouting, 'goalDocument.config.plannerRouting');
  routing(goal.config.workerRouting, 'goalDocument.config.workerRouting');
  if (goal.intentId !== stableId({ ...goal.intent, requirements })) fail('goalDocument.intentId does not match its normalized intent');
  return { requirements };
}

export function createV2GoalDocument({ goal, cwd, requirements, settings = {}, plannerRouting = null, workerRouting = null } = {}) {
  requiredString(goal, 'goal');
  requiredString(cwd, 'cwd');
  const normalizedRequirements = requirementsFor(requirements);
  object(settings, 'settings');
  const intent = { goal: goal.trim(), cwd, requirements: normalizedRequirements };
  const document = {
    schemaVersion: V2_GOAL_SCHEMA_VERSION,
    intentId: stableId(intent),
    intent,
    config: { settings: clone(settings), plannerRouting: routing(plannerRouting, 'plannerRouting'), workerRouting: routing(workerRouting, 'workerRouting') },
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
    planner: { status: 'pending', turns: 0, lastDecision: null },
    program: { schemaVersion: ACTION_PROGRAM_SCHEMA_VERSION, revision: 0, actions: [] },
    actions: [], attempts: [],
    budget: { agents: 0, seconds: 0, expansions: 0 },
    cancellation: { requested: false, requestedAt: null, reason: null },
    usage: { total: 0, byPool: {} },
    ledger,
  });
}

function validatePlanner(planner) {
  object(planner, 'state.planner');
  noUnknown(planner, new Set(['status', 'turns', 'lastDecision']), 'state.planner');
  if (!PLANNER_STATUSES.has(planner.status)) fail('state.planner.status is invalid');
  nonNegativeInteger(planner.turns, 'state.planner.turns');
  if (planner.lastDecision !== null && !isObject(planner.lastDecision)) fail('state.planner.lastDecision must be null or an object');
  if (planner.turns === 0 && planner.lastDecision !== null) fail('state.planner.lastDecision requires at least one planner turn');
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
  const freshEvidenceRequirementIds = Object.values(state.ledger.requirements)
    .filter((requirement) => requirement.status === 'passed')
    .map((requirement) => requirement.id);
  try {
    validateActionProgram(
      { schemaVersion: program.schemaVersion, actions: program.actions },
      {
        requirements: state.intent.requirements.map(({ id, mandatory }) => ({ id, mandatory })),
        freshEvidenceRequirementIds,
        maxActions: state.config.settings.maxActions ?? 100,
        maxParallel: state.config.settings.concurrency ?? state.config.settings.maxParallel ?? 100,
      },
    );
  } catch (error) {
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
    if (action.workRevision !== undefined && ((typeof action.workRevision !== 'string' && typeof action.workRevision !== 'number') || action.workRevision === '')) fail(`state.actions[${index}].workRevision must be a string or number`);
    for (const field of ['startedAt', 'finishedAt']) if (action[field] !== undefined) timestamp(action[field], `state.actions[${index}].${field}`);
    if (action.outputFile !== undefined) nullableString(action.outputFile, `state.actions[${index}].outputFile`);
    if (action.artifactIds !== undefined && (!Array.isArray(action.artifactIds) || action.artifactIds.some((item) => typeof item !== 'string' || !ID_RE.test(item)))) fail(`state.actions[${index}].artifactIds must contain valid IDs`);
    if (action.lastFailure !== undefined && action.lastFailure !== null && !isObject(action.lastFailure)) fail(`state.actions[${index}].lastFailure must be null or an object`);
  }
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
    for (const field of ['pool', 'model', 'outputFile']) if (attempt[field] !== undefined) nullableString(attempt[field], `state.attempts[${index}].${field}`);
    for (const field of ['startedAt', 'finishedAt']) if (attempt[field] !== undefined) timestamp(attempt[field], `state.attempts[${index}].${field}`);
    if (attempt.failure !== undefined && attempt.failure !== null && !isObject(attempt.failure)) fail(`state.attempts[${index}].failure must be null or an object`);
  }
}

function validateCounters(value, name) {
  object(value, name);
  for (const [key, count] of Object.entries(value)) {
    if (!/^[a-z][A-Za-z0-9]*$/.test(key)) fail(`${name}.${key} is not a valid counter name`);
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
  noUnknown(state, new Set(['schemaVersion', 'runId', 'shortId', 'intentId', 'intent', 'config', 'planner', 'program', 'actions', 'attempts', 'budget', 'cancellation', 'usage', 'ledger']), 'state');
  if (state.schemaVersion !== V2_STATE_SCHEMA_VERSION) fail(`state schemaVersion must be ${V2_STATE_SCHEMA_VERSION}`);
  requiredString(state.runId, 'state.runId');
  requiredString(state.shortId, 'state.shortId');
  requiredString(state.intentId, 'state.intentId');
  validateGoal({ schemaVersion: V2_GOAL_SCHEMA_VERSION, intentId: state.intentId, intent: state.intent, config: state.config });
  validatePlanner(state.planner);
  const ledger = validateLedger(state);
  validateProgram(state.program, { ...state, ledger });
  validateActionStates(state.actions, state.program);
  validateAttempts(state.attempts, state.program);
  validateCounters(state.budget, 'state.budget');
  object(state.cancellation, 'state.cancellation');
  noUnknown(state.cancellation, new Set(['requested', 'requestedAt', 'reason']), 'state.cancellation');
  if (typeof state.cancellation.requested !== 'boolean') fail('state.cancellation.requested must be a boolean');
  timestamp(state.cancellation.requestedAt, 'state.cancellation.requestedAt');
  nullableString(state.cancellation.reason, 'state.cancellation.reason');
  if (!state.cancellation.requested && (state.cancellation.requestedAt !== null || state.cancellation.reason !== null)) fail('state.cancellation metadata requires requested=true');
  object(state.usage, 'state.usage');
  noUnknown(state.usage, new Set(['total', 'byPool']), 'state.usage');
  if (typeof state.usage.total !== 'number' || !Number.isFinite(state.usage.total) || state.usage.total < 0) fail('state.usage.total must be a non-negative finite number');
  validateCounters(state.usage.byPool, 'state.usage.byPool');
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
