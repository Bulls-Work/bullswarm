import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { ACTION_PROGRAM_SCHEMA_VERSION, PROGRAM_ADVISORY_CODES, validateActionProgram } from './action-validator.js';
import { DELIVERABLE_TYPES, evidenceResultsIssues } from './step-vocabulary.js';
import { createLedger, deserializeLedger, serializeLedger } from './ledger.js';
import { isLiveProgram, isProgramWorkflow, removedActionIds } from './execution-policy.js';

export const V2_GOAL_SCHEMA_VERSION = 'bullswarm.workflow.goal.v2';
export const V2_STATE_SCHEMA_VERSION = 'bullswarm.workflow.state.v2';

const ID_RE = /^[a-z0-9][a-z0-9-]*$/;
const LEGACY_FIELDS = new Set([
  'phases', 'steps', 'graph', 'engine', 'engineSelector',
  'verify', 'reviewer', 'repair', 'decisions', 'decision', 'result', 'completion',
]);
const ROUTING_KEYS = new Set(['pool', 'model', 'preferredPool', 'preferredModel', 'strictPool', 'reasoning']);
const PLANNER_STATUSES = new Set(['pending', 'running', 'waiting', 'completed', 'failed', 'cancelled']);
const ACTION_STATUSES = new Set(['pending', 'ready', 'running', 'waiting', 'succeeded', 'failed', 'blocked', 'cancelled', 'interrupted', 'removed']);
const ATTEMPT_STATUSES = new Set(['pending', 'running', 'succeeded', 'failed', 'cancelled', 'interrupted']);
const LIFECYCLE_STATUSES = new Set(['interrupted', 'queued', 'planning', 'running', 'waiting', 'paused', 'ready-to-finalize', 'completed', 'partial', 'cancelled', 'failed']);
const TERMINAL_LIFECYCLE = ['completed', 'partial', 'cancelled', 'failed'];
const PREFLIGHT_STATUSES = new Set(['pending', 'running', 'succeeded', 'failed', 'skipped']);
const ACTION_STATE_FIELDS = new Set([
  'id', 'status', 'attempts', 'programRevision', 'workRevision', 'startedAt', 'finishedAt',
  'outputFile', 'artifactIds', 'lastFailure', 'supersededAttempts',
]);
const PAUSE_FIELDS = new Set(['requestedAt', 'mode', 'source', 'pausedAt']);
const REVISION_RECORD_FIELDS = new Set([
  'id', 'status', 'source', 'queuedAt', 'processedAt', 'summary', 'baseRevision',
  'programRevision', 'changes', 'steeringIds', 'issues',
]);
const REVISION_CHANGE_FIELDS = new Set(['added', 'amended', 'restored', 'removed', 'rerun', 'invalidated']);
const ATTEMPT_FIELDS = new Set([
  'id', 'actionId', 'ordinal', 'status', 'pool', 'model', 'startedAt',
  'finishedAt', 'taskFile', 'outputFile', 'failure', 'failureKind', 'why',
  'usage', 'routing', 'reasoning', 'continued', 'lastActivityAt', 'lastEventAt',
  'outputBytesObserved', 'bytes', 'lastAgentEvent', 'wallSec', 'routeWhy', 'routeCandidates',
  // A stalled attempt: `stalled` marks it, `partialOutput` points at the bytes
  // the worker had already written before it was stopped (kept, never
  // overwritten — the retry writes a new -attempt-N file), and `silentSec` is
  // the threshold that ended it. Absent on every attempt that did not stall,
  // and on every attempt recorded before the free-pool stall clock existed.
  'stalled', 'partialOutput', 'silentSec',
  // Prior-attempt handoff: the finished attempt records the out file byte
  // count (whenever the file exists, including failures), the persisted
  // stream path, the diff snapshot taken at worker exit, and the file
  // count that snapshot attributed to it. The receiving attempt records
  // `handoff: { from, bytes }` pointing at the attempt it was briefed on.
  // `lastResponse` is the text of the last `response` event in that stream,
  // which is what the watch handoff line quotes.
  // `notes` records non-fatal transport observations; `outputSamples` is the
  // bounded fallback when a persisted stream has no byte measurements.
  'outputBytes', 'streamFile', 'diffFile', 'changedFileCount', 'lastResponse', 'handoff',
  'notes', 'outputSamples',
  'outputTruncated', 'outputSource',
  'cwd', 'project',
  // The provider conversation this attempt ran in, when the connector supports
  // resuming one (src/workflow/v2-dispatch.js `sessionFor`): which pool and
  // model the session belongs to, the provider's own session id, how many
  // sessions this chain has opened (`generation`), and when it was opened and
  // last used. Absent on attempts whose connector has no conversation support
  // and on every attempt recorded before measured usage capture existed.
  'session',
  // What the provider reported the moment the worker exited, written once and
  // never changed (src/lib/watch.js `attemptCapture`). Absent on attempts
  // recorded before 0.35.2 and on attempts whose worker never exited.
  'capture',
  // The soft time box written into this attempt's task (time-box.js), and the
  // `## Not done` items a succeeded work attempt reported. Absent on attempts
  // that had no box (`timeBox: 0`, digests) and on every attempt recorded
  // before 0.35.2; `returnedEarly` is absent when nothing was left undone.
  'timeBox', 'returnedEarly',
  // The repository paths the diff snapshot attributed to this attempt (at
  // most 200; `changedFileCount` is the full count). Read by the repair
  // loop's carry-forward rule and the durable handoff. Absent on attempts
  // recorded before 0.35.2 and on attempts with no snapshot.
  'changedFiles',
  // Present only when the action declared a deliverable. `written` and
  // `missing` appear when paths were declared; `carried` only when an earlier
  // dispatch of this step decided the result (D19).
  'deliverable',
  // Stage 2 (E20): what each declared evidence item did after the worker
  // finished. Present only when the checks ran (E15); at most 5 entries with a
  // closed key set (step-vocabulary.js `evidenceResultsIssues`).
  'evidenceResults',
]);
const ATTEMPT_DELIVERABLE_FIELDS = new Set(['type', 'gated', 'produced', 'written', 'missing', 'carried']);
const ATTEMPT_TIME_BOX_FIELDS = new Set(['minutes', 'wrapUpMinutes', 'source', 'n', 'medianMinutes', 'startClock']);
const ATTEMPT_TIME_BOX_SOURCES = new Set(['program', 'pair', 'kind', 'fallback']);
const ATTEMPT_RETURNED_EARLY_FIELDS = new Set(['count', 'items']);
// The kernel's repair loop (verify-rounds.js). None of these keys may be a
// legacy autonomous field name: noUnknown rejects those.
const VERIFY_LOOP_FIELDS = new Set(['max', 'stoppedBy', 'rounds']);
const VERIFY_ROUND_FIELDS = new Set([
  'round', 'verifyActionIds', 'startedAt', 'closedAt', 'toJudge', 'carried', 'passed', 'failed', 'discovery',
  'repairActionId', 'repairRequirements', 'repairOwnedFiles', 'repairUnrestricted', 'repairStartedAt',
  'repairFinishedAt', 'changedFiles',
]);
const VERIFY_LOOP_STOPS = new Set(['passed', 'rounds', 'revision', 'step-failed', 'act-step']);
const ATTEMPT_SESSION_FIELDS = new Set([
  'pool', 'model', 'sessionId', 'generation', 'startedAt', 'lastUsedAt',
]);
const ATTEMPT_CAPTURE_FIELDS = new Set([
  'capturedAt', 'source', 'providerSessionId', 'sessionSource', 'model',
  'tokens', 'tokenSource', 'providerCostUsd', 'exitCode', 'signal',
]);
const CAPTURE_TOKEN_FIELDS = new Set([
  'standardRead', 'cacheRead', 'cacheWrite5m', 'cacheWrite1h', 'cacheWrite', 'output', 'reasoning', 'totalKnown',
]);
const CAPTURE_SOURCES = new Set(['event-stream', 'exit-status']);
const CAPTURE_SESSION_SOURCES = new Set(['provider-stream', 'bullswarm-assigned']);
const CAPTURE_TOKEN_SOURCES = new Set(['provider-reported', 'unknown']);
const ATTEMPT_HANDOFF_FIELDS = new Set(['from', 'bytes']);
const ATTEMPT_NOTE_FIELDS = new Set(['at', 'kind', 'text']);
// Output samples are `[atMs, bytes]` pairs. The cap keeps live state small
// enough for readers to redraw a run without loading the stream transcript.
export const ATTEMPT_OUTPUT_SAMPLE_CAP = 240;
// `state.attempts[].bytes` — the kernel's byte ledger for one dispatch, written
// at dispatch and completed when the attempt ends (src/workflow/v2-runtime.js
// `attemptBytes`). `taskFile` is the task file the attempt was handed,
// `authorPrompt` the program author's own prompt text as authored, `kernel` the
// remainder after the prompt and any embedded requirement text,
// `dependencyInputs` the total size of the dependency output files the task
// points at (0 when there are none), and `output` the durable out file — null
// until the attempt finishes and whenever no out file exists. Attempts recorded
// before this ledger existed carry no `bytes` field at all.
const ATTEMPT_BYTES_FIELDS = new Set([
  'taskFile', 'authorPrompt', 'kernel', 'dependencyInputs', 'output',
]);
const PLANNER_BOUNDARIES = new Set(['initial', 'gaps', 'steering']);
const PLANNER_MODES = new Set(['dispatched', 'caller']);
const PLANNER_AWAITING_FIELDS = new Set([
  'boundary', 'turn', 'requestPath', 'candidatePath', 'since', 'correction',
]);
const PLANNER_SESSION_FIELDS = new Set([
  'pool', 'model', 'sessionId', 'startedAt', 'lastUsedAt', 'generation',
]);
const PLANNER_ATTEMPT_FIELDS = new Set([
  'ordinal', 'turn', 'status', 'pool', 'model', 'reasoning', 'startedAt', 'finishedAt',
  'taskFile', 'outputFile', 'failureKind', 'why', 'usage', 'continued',
  'lastActivityAt', 'lastEventAt', 'outputBytesObserved', 'lastAgentEvent', 'wallSec',
  'outputTruncated', 'outputSource',
  'cwd', 'project', 'capture',
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
  'suggestedPlan', 'plannerMode', 'executionMode',
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
  if (value.executionMode !== undefined && !['program', 'verified'].includes(value.executionMode)) {
    fail('goalDocument.config.settings.executionMode must be program or verified');
  }
  if (value.scout !== undefined && typeof value.scout !== 'boolean') {
    fail('goalDocument.config.settings.scout must be a boolean');
  }
  if (value.suggestedPlan !== undefined) {
    requiredString(value.suggestedPlan, 'goalDocument.config.settings.suggestedPlan');
  }
  if (value.plannerMode !== undefined && !PLANNER_MODES.has(value.plannerMode)) {
    fail('goalDocument.config.settings.plannerMode must be dispatched or caller');
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

function outputTimeMs(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value;
  if (typeof value === 'string' && value) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  return null;
}

function outputBytesValue(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function capOutputSeries(series) {
  if (!Array.isArray(series)) return [];
  return series
    .filter((sample) => Array.isArray(sample) && sample.length === 2
      && outputTimeMs(sample[0]) != null && outputBytesValue(sample[1]) != null)
    .map(([at, bytes]) => [outputTimeMs(at), outputBytesValue(bytes)])
    .slice(-ATTEMPT_OUTPUT_SAMPLE_CAP);
}

function streamOutputSeries(streamFile) {
  if (typeof streamFile !== 'string' || !streamFile || !existsSync(streamFile)) return [];
  let body;
  try { body = readFileSync(streamFile, 'utf8'); } catch { return []; }
  const series = [];
  for (const line of body.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (event?.truncated === true) continue;
    const at = outputTimeMs(event?.atMs ?? event?.at ?? event?.timestamp ?? event?.time);
    const bytes = outputBytesValue(
      event?.outputBytes
        ?? event?.outputBytesObserved
        ?? event?.totalBytes
        ?? event?.bytes
        ?? event?.size
        ?? event?.sizeBytes
        ?? event?.outputSize
        ?? event?.summaryBytes,
    );
    if (at != null && bytes != null) series.push([at, bytes]);
  }
  return capOutputSeries(series);
}

/**
 * Return an attempt's output-over-time series as `[atMs, bytes]` pairs.
 *
 * A persisted stream wins when its event records carry both a timestamp and a
 * byte/size field. Older streams do not, so their durable `outputSamples`
 * fallback is used instead. The result is bounded to the same 240-point cap
 * used by the runtime sampler.
 */
export function attemptOutputSeries(attempt, runDir = null) {
  const streamFile = typeof attempt?.streamFile === 'string' ? attempt.streamFile : null;
  const resolvedStream = streamFile
    ? (isAbsolute(streamFile) || typeof runDir !== 'string' || !runDir ? streamFile : join(runDir, streamFile))
    : null;
  const fromStream = streamOutputSeries(resolvedStream);
  return fromStream.length ? fromStream : capOutputSeries(attempt?.outputSamples);
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
    planner: { status: 'pending', turns: 0, lastDecision: null, session: null, attempts: [], awaiting: null },
    program: { schemaVersion: ACTION_PROGRAM_SCHEMA_VERSION, revision: 0, actions: [] },
    presentation: { stages: [] },
    actions: [], attempts: [], steering: [],
    budget: { agents: 0, seconds: 0, expansions: 0 },
    cancellation: { requested: false, requestedAt: null, reason: null },
    // Non-blocking authoring advice recorded when a program is accepted, so
    // `runs show` can list what the launch already printed.
    advisories: [],
    // Attempt records remain authoritative. These counters make their strict
    // API/subscription totals and the conserved meter ledger available to live
    // views without rescanning every attempt on each refresh.
    usage: {
      total: 0,
      byPool: {},
      apiUsd: null,
      apiKnownSubtotalUsd: null,
      subscriptionUsd: null,
      subscriptionKnownSubtotalUsd: null,
      measuredAttempts: 0,
      pricedAttempts: 0,
      subscriptionPricedAttempts: 0,
      attempts: 0,
      apiMissingAttempts: 0,
      subscriptionMissingAttempts: 0,
      subscriptionLedgerByPool: {},
    },
    events: { sequence: 0, last: null },
    ledger,
  });
}

function validatePlanner(planner) {
  object(planner, 'state.planner');
  noUnknown(planner, new Set(['status', 'turns', 'lastDecision', 'session', 'attempts', 'awaiting']), 'state.planner');
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
  if (planner.awaiting !== undefined && planner.awaiting !== null) {
    object(planner.awaiting, 'state.planner.awaiting');
    noUnknown(planner.awaiting, PLANNER_AWAITING_FIELDS, 'state.planner.awaiting');
    if (!PLANNER_BOUNDARIES.has(planner.awaiting.boundary)) fail('state.planner.awaiting.boundary must be initial|gaps|steering');
    positiveInteger(planner.awaiting.turn, 'state.planner.awaiting.turn');
    if (planner.awaiting.turn !== planner.turns + 1) fail('state.planner.awaiting.turn must be the next planner turn');
    requiredString(planner.awaiting.requestPath, 'state.planner.awaiting.requestPath');
    requiredString(planner.awaiting.candidatePath, 'state.planner.awaiting.candidatePath');
    timestamp(planner.awaiting.since, 'state.planner.awaiting.since');
    if (planner.awaiting.since === null) fail('state.planner.awaiting.since is required');
    if (planner.awaiting.correction !== undefined && planner.awaiting.correction !== null) {
      object(planner.awaiting.correction, 'state.planner.awaiting.correction');
      noUnknown(planner.awaiting.correction, new Set(['issues', 'attempt']), 'state.planner.awaiting.correction');
      if (!Array.isArray(planner.awaiting.correction.issues) || planner.awaiting.correction.issues.some((issue) => typeof issue !== 'string' || !issue)) fail('state.planner.awaiting.correction.issues must be an array of non-empty strings');
      positiveInteger(planner.awaiting.correction.attempt, 'state.planner.awaiting.correction.attempt');
    }
    if (planner.status !== 'waiting') fail('state.planner.awaiting requires planner status waiting');
  }
  if (!Array.isArray(planner.attempts)) fail('state.planner.attempts must be an array');
  for (const [index, attempt] of planner.attempts.entries()) {
    object(attempt, `state.planner.attempts[${index}]`);
    noUnknown(attempt, PLANNER_ATTEMPT_FIELDS, `state.planner.attempts[${index}]`);
    nonNegativeInteger(attempt.ordinal, `state.planner.attempts[${index}].ordinal`);
    nonNegativeInteger(attempt.turn, `state.planner.attempts[${index}].turn`);
    if (attempt.ordinal < 1 || attempt.turn < 1) fail(`state.planner.attempts[${index}] ordinal and turn must be positive`);
    if (!ATTEMPT_STATUSES.has(attempt.status)) fail(`state.planner.attempts[${index}].status is invalid`);
    for (const field of ['pool', 'model', 'taskFile', 'outputFile', 'failureKind', 'why', 'cwd', 'project']) if (attempt[field] !== undefined) nullableString(attempt[field], `state.planner.attempts[${index}].${field}`);
    for (const field of ['startedAt', 'finishedAt']) if (attempt[field] !== undefined) timestamp(attempt[field], `state.planner.attempts[${index}].${field}`);
    if (attempt.usage !== undefined && attempt.usage !== null && !isObject(attempt.usage)) fail(`state.planner.attempts[${index}].usage must be null or an object`);
    if (attempt.reasoning !== undefined && attempt.reasoning !== null && !isObject(attempt.reasoning)) fail(`state.planner.attempts[${index}].reasoning must be null or an object`);
    if (attempt.continued !== undefined && typeof attempt.continued !== 'boolean') fail(`state.planner.attempts[${index}].continued must be a boolean`);
    for (const field of ['lastActivityAt', 'lastEventAt']) if (attempt[field] !== undefined) timestamp(attempt[field], `state.planner.attempts[${index}].${field}`);
    if (attempt.outputBytesObserved !== undefined && (!Number.isFinite(attempt.outputBytesObserved) || attempt.outputBytesObserved < 0)) fail(`state.planner.attempts[${index}].outputBytesObserved must be a non-negative finite number`);
    validateOutputRecovery(attempt, `state.planner.attempts[${index}]`);
    if (attempt.capture !== undefined) validateAttemptCapture(attempt.capture, `state.planner.attempts[${index}].capture`);
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

// Stages cover exactly the live plan: an action a revision removed belongs to
// no stage.
function validatePresentation(presentation, program, removed = new Set()) {
  object(presentation, 'state.presentation');
  noUnknown(presentation, new Set(['stages']), 'state.presentation');
  if (!Array.isArray(presentation.stages)) fail('state.presentation.stages must be an array');
  const programIds = new Set(program.actions.map((action) => action.id).filter((id) => !removed.has(id)));
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
    for (const field of ['pool', 'model', 'taskFile', 'outputFile', 'failureKind', 'why', 'cwd', 'project']) if (attempt[field] !== undefined) nullableString(attempt[field], `state.preflight.scout.attempts[${index}].${field}`);
    for (const field of ['startedAt', 'finishedAt', 'lastActivityAt', 'lastEventAt']) if (attempt[field] !== undefined) timestamp(attempt[field], `state.preflight.scout.attempts[${index}].${field}`);
    if (attempt.usage !== undefined && attempt.usage !== null && !isObject(attempt.usage)) fail(`state.preflight.scout.attempts[${index}].usage must be null or an object`);
    if (attempt.wallSec !== undefined && attempt.wallSec !== null && (!Number.isFinite(attempt.wallSec) || attempt.wallSec < 0)) fail(`state.preflight.scout.attempts[${index}].wallSec must be null or a non-negative finite number`);
    if (attempt.outputBytesObserved !== undefined && (!Number.isFinite(attempt.outputBytesObserved) || attempt.outputBytesObserved < 0)) fail(`state.preflight.scout.attempts[${index}].outputBytesObserved must be a non-negative finite number`);
    validateOutputRecovery(attempt, `state.preflight.scout.attempts[${index}]`);
    if (attempt.capture !== undefined) validateAttemptCapture(attempt.capture, `state.preflight.scout.attempts[${index}].capture`);
    if (attempt.lastAgentEvent !== undefined && attempt.lastAgentEvent !== null && !isObject(attempt.lastAgentEvent)) fail(`state.preflight.scout.attempts[${index}].lastAgentEvent must be null or an object`);
  }
  if (preflight.scout.status === 'succeeded' && !preflight.scout.outputFile) fail('successful state.preflight.scout requires outputFile');
}

// Optional: runs accepted before advisories existed carry no field at all,
// and an absent list means "no advice was recorded", never an error.
function validateAdvisories(advisories) {
  if (advisories === undefined || advisories === null) return;
  if (!Array.isArray(advisories)) fail('state.advisories must be an array');
  for (const [index, entry] of advisories.entries()) {
    const at = `state.advisories[${index}]`;
    object(entry, at);
    noUnknown(entry, new Set(['code', 'actionId', 'message']), at);
    if (!PROGRAM_ADVISORY_CODES.includes(entry.code)) fail(`${at}.code must be ${PROGRAM_ADVISORY_CODES.join('|')}`);
    nullableString(entry.actionId, `${at}.actionId`);
    requiredString(entry.message, `${at}.message`);
  }
}

// The validation options for a revised program's live graph, shared with the
// revision planner so a revision is accepted by exactly the rules the stored
// state is later checked against.
export function v2LiveProgramRuntime(state, { enforceRoutingPolicy = true } = {}) {
  return {
    // Kernel repairs run after the verify that failed their requirement, so
    // the evidence-ancestor rule skips them (the loop record names them).
    kernelRepairActionIds: Array.isArray(state.verifyLoop?.rounds)
      ? state.verifyLoop.rounds.map((round) => round?.repairActionId).filter((id) => typeof id === 'string' && id)
      : [],
    requirements: state.intent.requirements.map(({ id, mandatory }) => ({ id, mandatory })),
    knownActions: [],
    knownArtifacts: [],
    freshEvidenceRequirementIds: [],
    workspaceMutation: state.intent.constraints?.workspaceMutation ?? 'allowed',
    requireMandatoryEvidence: false,
    relaxedGraph: true,
    requireOwnedFiles: state.config.settings.workspaceMode === 'isolated',
    maxActions: state.config.settings.maxActions ?? 100,
    maxParallel: state.config.settings.concurrency ?? state.config.settings.maxParallel ?? 100,
    enforceMaxActions: false,
    enforceMaxParallel: false,
    enforceRoutingPolicy,
  };
}

// A revised program no longer replays revision by revision (a revision can
// rewrite an action accepted long before). Its live actions are one program;
// removed actions are frozen history that nothing live may depend on.
function validateLiveProgram(program, state) {
  const ids = new Set();
  for (const [index, action] of program.actions.entries()) {
    object(action, `state.program.actions[${index}]`);
    const id = identifier(action.id, `state.program.actions[${index}].id`);
    if (ids.has(id)) fail(`state.program has duplicate action ${id}`);
    ids.add(id);
  }
  const removed = removedActionIds(state);
  const live = program.actions.filter((action) => !removed.has(action.id));
  if (!live.length) fail('a revised state.program must keep at least one live action');
  for (const action of program.actions) if (removed.has(action.id)) {
    if (!Array.isArray(action.dependsOn) || action.dependsOn.some((dependency) => !ids.has(dependency))) fail(`removed action ${action.id} has an invalid dependsOn`);
    if (!Array.isArray(action.ownedFiles)) fail(`removed action ${action.id} must keep its ownedFiles array`);
  }
  try {
    validateActionProgram({ schemaVersion: program.schemaVersion, actions: live }, v2LiveProgramRuntime(state, { enforceRoutingPolicy: false }));
  } catch (error) {
    const detail = Array.isArray(error?.issues) ? error.issues.join('; ') : error.message;
    fail(`state.program is invalid: ${detail}`);
  }
}

// Optional: absent on runs no one has paused. Set while a pause is pending
// (pausedAt null) and once the kernel has stopped for it.
function validatePause(pause, lifecycle) {
  if (pause === undefined || pause === null) {
    if (lifecycle.status === 'paused') fail('state.lifecycle paused requires state.pause');
    return;
  }
  object(pause, 'state.pause');
  noUnknown(pause, PAUSE_FIELDS, 'state.pause');
  timestamp(pause.requestedAt, 'state.pause.requestedAt');
  if (pause.requestedAt === null) fail('state.pause.requestedAt is required');
  if (!['drain', 'now'].includes(pause.mode)) fail('state.pause.mode must be drain|now');
  requiredString(pause.source, 'state.pause.source');
  timestamp(pause.pausedAt, 'state.pause.pausedAt');
  if (lifecycle.status === 'paused' && !pause.pausedAt) fail('state.lifecycle paused requires state.pause.pausedAt');
  if (TERMINAL_LIFECYCLE.includes(lifecycle.status)) fail('state.pause must be null once the workflow is terminal');
}

// Optional: one record per processed revision request, applied or rejected.
function validateRevisions(revisions, program) {
  if (revisions === undefined || revisions === null) return;
  if (!Array.isArray(revisions)) fail('state.revisions must be an array');
  const ids = new Set();
  let lastApplied = 0;
  for (const [index, entry] of revisions.entries()) {
    const at = `state.revisions[${index}]`;
    object(entry, at);
    noUnknown(entry, REVISION_RECORD_FIELDS, at);
    requiredString(entry.id, `${at}.id`);
    if (ids.has(entry.id)) fail(`duplicate revision request ${entry.id}`);
    ids.add(entry.id);
    if (!['applied', 'rejected'].includes(entry.status)) fail(`${at}.status must be applied|rejected`);
    requiredString(entry.source, `${at}.source`);
    timestamp(entry.queuedAt, `${at}.queuedAt`);
    timestamp(entry.processedAt, `${at}.processedAt`);
    if (entry.summary !== null) requiredString(entry.summary, `${at}.summary`);
    if (entry.baseRevision !== null) nonNegativeInteger(entry.baseRevision, `${at}.baseRevision`);
    if (!Array.isArray(entry.steeringIds) || entry.steeringIds.some((id) => typeof id !== 'string' || !id)) fail(`${at}.steeringIds must be an array of ids`);
    if (entry.status === 'applied') {
      positiveInteger(entry.programRevision, `${at}.programRevision`);
      if (entry.programRevision > program.revision || entry.programRevision <= lastApplied) fail(`${at}.programRevision must increase and reference an existing program revision`);
      lastApplied = entry.programRevision;
      object(entry.changes, `${at}.changes`);
      noUnknown(entry.changes, REVISION_CHANGE_FIELDS, `${at}.changes`);
      for (const field of REVISION_CHANGE_FIELDS) {
        const list = entry.changes[field];
        if (!Array.isArray(list) || list.some((id) => typeof id !== 'string' || !ID_RE.test(id))) fail(`${at}.changes.${field} must be an array of action ids`);
      }
      if (entry.issues !== null) fail(`${at}.issues must be null for an applied revision`);
    } else {
      if (entry.programRevision !== null || entry.changes !== null) fail(`${at} was rejected and cannot carry a program revision or changes`);
      if (!Array.isArray(entry.issues) || !entry.issues.length || entry.issues.some((issue) => typeof issue !== 'string' || !issue)) fail(`${at}.issues must list why the revision was rejected`);
    }
  }
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
  if (isLiveProgram(state)) return validateLiveProgram(program, state);
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
        relaxedGraph: isProgramWorkflow(state),
        requireOwnedFiles: isProgramWorkflow(state) && state.config.settings.workspaceMode === 'isolated',
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
          id: action.id, kind: action.kind ?? null,
          dependsOn: clone(action.dependsOn), affects: clone(action.affects),
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

function validateActionStates(actions, program, live = false) {
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
    // Attempts up to this ordinal belong to a definition or result a plan
    // revision replaced; recovery never reads them as this step's completion.
    if (action.supersededAttempts !== undefined) {
      nonNegativeInteger(action.supersededAttempts, `state.actions[${index}].supersededAttempts`);
      if (action.supersededAttempts > action.attempts) fail(`state.actions[${index}].supersededAttempts cannot exceed attempts`);
    }
    if (action.status === 'removed' && !live) fail(`state.actions[${index}] is removed, which requires an applied plan revision`);
  }
  for (const id of programIds) if (!ids.has(id)) fail(`state.actions is missing program action ${id}`);
}

// Byte counts are measured, never estimated: each field is a real file size or
// a real string length, and an unmeasured `output` is null rather than 0.
function validateAttemptBytes(bytes, at) {
  object(bytes, at);
  noUnknown(bytes, ATTEMPT_BYTES_FIELDS, at);
  for (const field of ['taskFile', 'authorPrompt', 'kernel', 'dependencyInputs']) {
    nonNegativeInteger(bytes[field], `${at}.${field}`);
  }
  if (bytes.output !== null && bytes.output !== undefined) nonNegativeInteger(bytes.output, `${at}.output`);
}

// The attempt's provider conversation. `sessionId` is the provider's own id and
// is the one field that must be there — the rest are recorded when the kernel
// knows them, and an attempt that never opened a session carries `null`.
function validateAttemptSession(session, at) {
  object(session, at);
  noUnknown(session, ATTEMPT_SESSION_FIELDS, at);
  requiredString(session.sessionId, `${at}.sessionId`);
  for (const field of ['pool', 'model']) {
    if (session[field] !== undefined) nullableString(session[field], `${at}.${field}`);
  }
  for (const field of ['startedAt', 'lastUsedAt']) {
    if (session[field] !== undefined) timestamp(session[field], `${at}.${field}`);
  }
  if (session.generation !== undefined && session.generation !== null) {
    positiveInteger(session.generation, `${at}.generation`);
  }
}

// Only what the provider said: token classes appear exactly when the provider
// reported counters, and an attempt whose stream carried none is `unknown`.
function validateAttemptCapture(capture, at) {
  object(capture, at);
  noUnknown(capture, ATTEMPT_CAPTURE_FIELDS, at);
  timestamp(capture.capturedAt, `${at}.capturedAt`);
  if (capture.capturedAt === null) fail(`${at}.capturedAt is required`);
  if (!CAPTURE_SOURCES.has(capture.source)) fail(`${at}.source is invalid`);
  for (const field of ['providerSessionId', 'model', 'signal']) {
    if (capture[field] !== undefined) nullableString(capture[field], `${at}.${field}`);
  }
  if (capture.sessionSource !== undefined && capture.sessionSource !== null
    && !CAPTURE_SESSION_SOURCES.has(capture.sessionSource)) fail(`${at}.sessionSource is invalid`);
  if (!CAPTURE_TOKEN_SOURCES.has(capture.tokenSource)) fail(`${at}.tokenSource is invalid`);
  if (capture.tokens !== undefined && capture.tokens !== null) {
    object(capture.tokens, `${at}.tokens`);
    noUnknown(capture.tokens, CAPTURE_TOKEN_FIELDS, `${at}.tokens`);
    for (const [field, value] of Object.entries(capture.tokens)) {
      nullableFiniteNumber(value, `${at}.tokens.${field}`);
      if (value != null && value < 0) fail(`${at}.tokens.${field} must not be negative`);
    }
  }
  if ((capture.tokenSource === 'provider-reported') !== (capture.tokens != null)) {
    fail(`${at}.tokens are present exactly when tokenSource is provider-reported`);
  }
  nullableFiniteNumber(capture.providerCostUsd, `${at}.providerCostUsd`);
  if (capture.providerCostUsd != null && capture.providerCostUsd < 0) fail(`${at}.providerCostUsd must not be negative`);
  if (capture.exitCode !== undefined && capture.exitCode !== null && !Number.isInteger(capture.exitCode)) {
    fail(`${at}.exitCode must be null or an integer`);
  }
}

function validateAttemptNotes(notes, at) {
  if (!Array.isArray(notes)) fail(`${at} must be an array`);
  for (const [index, note] of notes.entries()) {
    object(note, `${at}[${index}]`);
    noUnknown(note, ATTEMPT_NOTE_FIELDS, `${at}[${index}]`);
    timestamp(note.at, `${at}[${index}].at`);
    requiredString(note.kind, `${at}[${index}].kind`);
    requiredString(note.text, `${at}[${index}].text`);
  }
}

function validateOutputSamples(samples, at) {
  if (!Array.isArray(samples)) fail(`${at} must be an array`);
  if (samples.length > ATTEMPT_OUTPUT_SAMPLE_CAP) fail(`${at} must contain at most ${ATTEMPT_OUTPUT_SAMPLE_CAP} samples`);
  for (const [index, sample] of samples.entries()) {
    if (!Array.isArray(sample) || sample.length !== 2) fail(`${at}[${index}] must be [atMs, bytes]`);
    const [atMs, bytes] = sample;
    if (!Number.isFinite(atMs) || atMs < 0) fail(`${at}[${index}][0] must be a non-negative finite number`);
    if (!Number.isFinite(bytes) || bytes < 0) fail(`${at}[${index}][1] must be a non-negative finite number`);
  }
}

function validateOutputRecovery(attempt, at) {
  if (attempt.outputTruncated !== undefined && typeof attempt.outputTruncated !== 'boolean') {
    fail(`${at}.outputTruncated must be a boolean`);
  }
  if (attempt.outputSource !== undefined) {
    nullableString(attempt.outputSource, `${at}.outputSource`);
    if (attempt.outputSource !== null && !['follow-up', 'derived'].includes(attempt.outputSource)) {
      fail(`${at}.outputSource must be follow-up or derived`);
    }
  }
}

function stringPathList(value, at) {
  if (!Array.isArray(value) || value.length > 50 || value.some((item) => typeof item !== 'string')) {
    fail(`${at} must be a string array of at most 50 entries`);
  }
}

function validateAttemptDeliverable(value, at) {
  object(value, at);
  noUnknown(value, ATTEMPT_DELIVERABLE_FIELDS, at);
  if (!DELIVERABLE_TYPES.includes(value.type)) fail(`${at}.type must be ${DELIVERABLE_TYPES.join('|')}`);
  if (typeof value.gated !== 'boolean') fail(`${at}.gated must be a boolean`);
  if (typeof value.produced !== 'boolean' && value.produced !== null) fail(`${at}.produced must be a boolean or null`);
  if (value.written !== undefined) stringPathList(value.written, `${at}.written`);
  if (value.missing !== undefined) stringPathList(value.missing, `${at}.missing`);
  if (value.carried !== undefined && value.carried !== true) fail(`${at}.carried must be true`);
}

function validateAttemptEvidenceResults(value, at) {
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      if (isObject(item)) for (const key of Object.keys(item)) if (LEGACY_FIELDS.has(key)) fail(`${at}[${index}].${key} is a legacy autonomous field`);
    }
  }
  const issues = evidenceResultsIssues(value, at);
  if (issues.length) fail(issues[0]);
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
    for (const field of ['pool', 'model', 'taskFile', 'outputFile', 'failureKind', 'why', 'streamFile', 'diffFile', 'lastResponse', 'cwd', 'project']) if (attempt[field] !== undefined) nullableString(attempt[field], `state.attempts[${index}].${field}`);
    for (const field of ['startedAt', 'finishedAt', 'lastActivityAt', 'lastEventAt']) if (attempt[field] !== undefined) timestamp(attempt[field], `state.attempts[${index}].${field}`);
    if (attempt.failure !== undefined && attempt.failure !== null && !isObject(attempt.failure)) fail(`state.attempts[${index}].failure must be null or an object`);
    for (const field of ['routing', 'reasoning']) if (attempt[field] !== undefined && attempt[field] !== null && !isObject(attempt[field])) fail(`state.attempts[${index}].${field} must be null or an object`);
    validateUsageV2(attempt.usage, `state.attempts[${index}].usage`);
    if (attempt.continued !== undefined && typeof attempt.continued !== 'boolean') fail(`state.attempts[${index}].continued must be a boolean`);
    if (attempt.outputBytesObserved !== undefined && (!Number.isFinite(attempt.outputBytesObserved) || attempt.outputBytesObserved < 0)) fail(`state.attempts[${index}].outputBytesObserved must be a non-negative finite number`);
    if (attempt.outputBytes !== undefined && attempt.outputBytes !== null) nonNegativeInteger(attempt.outputBytes, `state.attempts[${index}].outputBytes`);
    if (attempt.changedFileCount !== undefined) nonNegativeInteger(attempt.changedFileCount, `state.attempts[${index}].changedFileCount`);
    if (attempt.handoff !== undefined && attempt.handoff !== null) {
      object(attempt.handoff, `state.attempts[${index}].handoff`);
      noUnknown(attempt.handoff, ATTEMPT_HANDOFF_FIELDS, `state.attempts[${index}].handoff`);
      if (attempt.handoff.from !== undefined) nullableString(attempt.handoff.from, `state.attempts[${index}].handoff.from`);
      if (attempt.handoff.bytes !== undefined) nonNegativeInteger(attempt.handoff.bytes, `state.attempts[${index}].handoff.bytes`);
    }
    if (attempt.session !== undefined && attempt.session !== null) validateAttemptSession(attempt.session, `state.attempts[${index}].session`);
    if (attempt.capture !== undefined) validateAttemptCapture(attempt.capture, `state.attempts[${index}].capture`);
    if (attempt.notes !== undefined) validateAttemptNotes(attempt.notes, `state.attempts[${index}].notes`);
    if (attempt.outputSamples !== undefined) validateOutputSamples(attempt.outputSamples, `state.attempts[${index}].outputSamples`);
    validateOutputRecovery(attempt, `state.attempts[${index}]`);
    if (attempt.bytes !== undefined) validateAttemptBytes(attempt.bytes, `state.attempts[${index}].bytes`);
    if (attempt.timeBox !== undefined) validateAttemptTimeBox(attempt.timeBox, `state.attempts[${index}].timeBox`);
    if (attempt.returnedEarly !== undefined) validateReturnedEarly(attempt.returnedEarly, `state.attempts[${index}].returnedEarly`);
    if (attempt.changedFiles !== undefined && (!Array.isArray(attempt.changedFiles) || attempt.changedFiles.length > 200
      || attempt.changedFiles.some((file) => typeof file !== 'string' || !file))) fail(`state.attempts[${index}].changedFiles must list at most 200 paths`);
    if (attempt.deliverable !== undefined) validateAttemptDeliverable(attempt.deliverable, `state.attempts[${index}].deliverable`);
    if (attempt.evidenceResults !== undefined) validateAttemptEvidenceResults(attempt.evidenceResults, `state.attempts[${index}].evidenceResults`);
    if (attempt.wallSec !== undefined && attempt.wallSec !== null && (!Number.isFinite(attempt.wallSec) || attempt.wallSec < 0)) fail(`state.attempts[${index}].wallSec must be null or a non-negative finite number`);
    if (attempt.lastAgentEvent !== undefined && attempt.lastAgentEvent !== null && !isObject(attempt.lastAgentEvent)) fail(`state.attempts[${index}].lastAgentEvent must be null or an object`);
  }
}

function validateAttemptTimeBox(box, at) {
  object(box, at);
  noUnknown(box, ATTEMPT_TIME_BOX_FIELDS, at);
  positiveInteger(box.minutes, `${at}.minutes`);
  nonNegativeInteger(box.wrapUpMinutes, `${at}.wrapUpMinutes`);
  if (!ATTEMPT_TIME_BOX_SOURCES.has(box.source)) fail(`${at}.source must be program|pair|kind|fallback`);
  if (box.n !== null) nonNegativeInteger(box.n, `${at}.n`);
  if (box.medianMinutes !== null && (!Number.isFinite(box.medianMinutes) || box.medianMinutes < 0)) fail(`${at}.medianMinutes must be null or a non-negative finite number`);
  if (typeof box.startClock !== 'string' || !/^\d{2}:\d{2}:\d{2}$/.test(box.startClock)) fail(`${at}.startClock must be HH:MM:SS`);
}

function validateReturnedEarly(early, at) {
  object(early, at);
  noUnknown(early, ATTEMPT_RETURNED_EARLY_FIELDS, at);
  positiveInteger(early.count, `${at}.count`);
  if (!Array.isArray(early.items) || early.items.length > 20 || early.items.length > early.count
    || early.items.some((item) => typeof item !== 'string' || !item)) fail(`${at}.items must list at most 20 non-empty strings`);
}

function idArray(value, at) {
  if (!Array.isArray(value) || value.some((id) => typeof id !== 'string' || !ID_RE.test(id))) fail(`${at} must be an array of ids`);
  if (new Set(value).size !== value.length) fail(`${at} must not repeat an id`);
}

// Optional: absent on runs accepted before 0.35.2 and on non-program runs.
// Rounds are numbered 1.. in order, and there are never more than three.
function validateVerifyLoop(loop, state) {
  if (loop === undefined) return;
  object(loop, 'state.verifyLoop');
  noUnknown(loop, VERIFY_LOOP_FIELDS, 'state.verifyLoop');
  if (!isProgramWorkflow(state)) fail('state.verifyLoop requires a program workflow');
  if (!Number.isInteger(loop.max) || loop.max < 1 || loop.max > 3) fail('state.verifyLoop.max must be 1, 2 or 3');
  if (loop.stoppedBy !== null && !VERIFY_LOOP_STOPS.has(loop.stoppedBy)) fail('state.verifyLoop.stoppedBy must be null|passed|rounds|revision|step-failed|act-step');
  if (!Array.isArray(loop.rounds)) fail('state.verifyLoop.rounds must be an array');
  if (loop.rounds.length > 3) fail('state.verifyLoop.rounds must hold at most three rounds');
  const requirementIds = new Set(state.intent.requirements.map((requirement) => requirement.id));
  const known = (ids, at) => { for (const id of ids) if (!requirementIds.has(id)) fail(`${at} references unknown requirement ${id}`); };
  for (const [index, round] of loop.rounds.entries()) {
    const at = `state.verifyLoop.rounds[${index}]`;
    object(round, at);
    noUnknown(round, VERIFY_ROUND_FIELDS, at);
    if (round.round !== index + 1) fail(`${at}.round must be ${index + 1}`);
    idArray(round.verifyActionIds, `${at}.verifyActionIds`);
    timestamp(round.startedAt, `${at}.startedAt`);
    if (round.startedAt === null) fail(`${at}.startedAt is required`);
    timestamp(round.closedAt, `${at}.closedAt`);
    for (const field of ['toJudge', 'carried', 'passed', 'failed', 'repairRequirements']) {
      idArray(round[field], `${at}.${field}`);
      known(round[field], `${at}.${field}`);
    }
    if (!Array.isArray(round.discovery) || round.discovery.length > 20) fail(`${at}.discovery must list at most 20 items`);
    for (const [itemIndex, item] of round.discovery.entries()) {
      object(item, `${at}.discovery[${itemIndex}]`);
      noUnknown(item, new Set(['requirementId', 'text']), `${at}.discovery[${itemIndex}]`);
      if (!requirementIds.has(item.requirementId)) fail(`${at}.discovery[${itemIndex}].requirementId is unknown`);
      requiredString(item.text, `${at}.discovery[${itemIndex}].text`);
    }
    if (round.repairActionId !== null && (typeof round.repairActionId !== 'string' || !ID_RE.test(round.repairActionId))) fail(`${at}.repairActionId must be null or an id`);
    if (!Array.isArray(round.repairOwnedFiles) || round.repairOwnedFiles.some((file) => typeof file !== 'string' || !file)) fail(`${at}.repairOwnedFiles must be an array of paths`);
    if (typeof round.repairUnrestricted !== 'boolean') fail(`${at}.repairUnrestricted must be a boolean`);
    timestamp(round.repairStartedAt, `${at}.repairStartedAt`);
    timestamp(round.repairFinishedAt, `${at}.repairFinishedAt`);
    if (round.changedFiles !== null && (!Array.isArray(round.changedFiles) || round.changedFiles.length > 200
      || round.changedFiles.some((file) => typeof file !== 'string' || !file))) fail(`${at}.changedFiles must be null or at most 200 paths`);
    if (round.repairActionId === null && (round.repairRequirements.length || round.repairStartedAt || round.repairFinishedAt)) fail(`${at} records a repair without repairActionId`);
    if (round.repairActionId !== null && round.closedAt === null) fail(`${at} cannot start a repair before the round closes`);
    if (index < loop.rounds.length - 1 && round.closedAt === null) fail(`${at} must be closed before round ${index + 2} opens`);
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

const USAGE_TOKEN_SOURCES = new Set([
  'provider-reported', 'transcript-summed', 'estimated:utf8-bytes/4', 'unknown',
]);
const USAGE_SUBSCRIPTION_BASES = new Set([
  'observed:meter-delta', 'observed:meter-ledger', 'calibrated:usd-per-pct',
  'unknown:no-price', 'unknown:no-meter', 'unknown:no-cost',
  'unknown:below-resolution',
]);

function nullableFiniteNumber(value, name) {
  if (value === undefined) return;
  if (value !== null && (typeof value !== 'number' || !Number.isFinite(value))) {
    fail(`${name} must be null or a finite number`);
  }
}

function validateUsageV2(usage, at) {
  if (usage === undefined || usage === null) return;
  object(usage, at);
  // Preserve legacy usage aliases and tolerate provider-specific diagnostic
  // keys, while validating every canonical v2 block when it is present.
  if (usage.tokens !== undefined && usage.tokens !== null) {
    object(usage.tokens, `${at}.tokens`);
    for (const field of [
      'standardRead', 'cacheRead', 'cacheWrite5m', 'cacheWrite1h', 'cacheWrite',
      'output', 'reasoning', 'totalKnown',
    ]) nullableFiniteNumber(usage.tokens[field], `${at}.tokens.${field}`);
  }
  if (usage.tokenSource !== undefined
    && (typeof usage.tokenSource !== 'string' || !USAGE_TOKEN_SOURCES.has(usage.tokenSource))) {
    fail(`${at}.tokenSource is invalid`);
  }
  for (const field of ['model', 'sessionId', 'costSource']) {
    if (usage[field] !== undefined && usage[field] !== null && typeof usage[field] !== 'string') {
      fail(`${at}.${field} must be null or a string`);
    }
  }
  if (usage.api !== undefined && usage.api !== null) {
    object(usage.api, `${at}.api`);
    nullableFiniteNumber(usage.api.usd, `${at}.api.usd`);
    if (usage.api.breakdown !== undefined && usage.api.breakdown !== null) {
      object(usage.api.breakdown, `${at}.api.breakdown`);
      for (const [key, value] of Object.entries(usage.api.breakdown)) {
        nullableFiniteNumber(value, `${at}.api.breakdown.${key}`);
      }
    }
    for (const field of ['pricedFields', 'unpricedFields']) {
      if (usage.api[field] !== undefined
        && (!Array.isArray(usage.api[field]) || usage.api[field].some((item) => typeof item !== 'string'))) {
        fail(`${at}.api.${field} must be an array of strings`);
      }
    }
    if (usage.api.rateCard !== undefined && usage.api.rateCard !== null) {
      object(usage.api.rateCard, `${at}.api.rateCard`);
      for (const field of ['source', 'updatedAt']) {
        if (usage.api.rateCard[field] !== undefined && usage.api.rateCard[field] !== null
          && typeof usage.api.rateCard[field] !== 'string') fail(`${at}.api.rateCard.${field} must be null or a string`);
      }
    }
    if (usage.api.basis !== undefined && typeof usage.api.basis !== 'string') fail(`${at}.api.basis must be a string`);
  }
  if (usage.subscription !== undefined && usage.subscription !== null) {
    object(usage.subscription, `${at}.subscription`);
    for (const field of ['pool', 'window', 'basis']) {
      if (usage.subscription[field] !== undefined && usage.subscription[field] !== null
        && typeof usage.subscription[field] !== 'string') fail(`${at}.subscription.${field} must be null or a string`);
    }
    for (const field of ['deltaPct', 'usd', 'monthlyPriceUsd', 'windowDays', 'resolutionPct', 'conservedDeltaPct']) {
      nullableFiniteNumber(usage.subscription[field], `${at}.subscription.${field}`);
    }
    if (usage.subscription.basis !== undefined && usage.subscription.basis !== null
      && !USAGE_SUBSCRIPTION_BASES.has(usage.subscription.basis)) fail(`${at}.subscription.basis is invalid`);
    if (usage.subscription.snapshots !== undefined && usage.subscription.snapshots !== null) {
      object(usage.subscription.snapshots, `${at}.subscription.snapshots`);
      for (const side of ['start', 'end']) {
        const snapshot = usage.subscription.snapshots[side];
        if (snapshot === undefined || snapshot === null) continue;
        object(snapshot, `${at}.subscription.snapshots.${side}`);
        if (typeof snapshot.at !== 'string' || Number.isNaN(Date.parse(snapshot.at))) fail(`${at}.subscription.snapshots.${side}.at must be an ISO timestamp`);
        if (typeof snapshot.usedPct !== 'number' || !Number.isFinite(snapshot.usedPct) || snapshot.usedPct < 0) fail(`${at}.subscription.snapshots.${side}.usedPct must be a non-negative finite number`);
        if (snapshot.resetsAt !== undefined && snapshot.resetsAt !== null && typeof snapshot.resetsAt !== 'string') fail(`${at}.subscription.snapshots.${side}.resetsAt must be null or a string`);
      }
    }
  }
  if (usage.pricing !== undefined && usage.pricing !== null && !isObject(usage.pricing)) fail(`${at}.pricing must be null or an object`);
  for (const field of ['cost', 'normalizedQuota']) {
    if (usage[field] !== undefined && usage[field] !== null && !isObject(usage[field])) fail(`${at}.${field} must be null or an object`);
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
  noUnknown(state, new Set(['schemaVersion', 'runId', 'shortId', 'intentId', 'intent', 'config', 'lifecycle', 'preflight', 'planner', 'program', 'presentation', 'actions', 'attempts', 'steering', 'budget', 'cancellation', 'usage', 'events', 'ledger', 'runner', 'advisories', 'pause', 'revisions', 'verifyLoop']), 'state');
  // Optional: written by a live kernel so readers can tell a running run from
  // one whose process died. Absent on a state no kernel has owned yet.
  if (state.runner !== undefined && state.runner !== null) {
    noUnknown(state.runner, new Set(['pid', 'startedAt', 'lastHeartbeatAt']), 'state.runner');
    if (state.runner.pid !== null && !Number.isInteger(state.runner.pid)) fail('state.runner.pid must be an integer or null');
    timestamp(state.runner.startedAt, 'state.runner.startedAt');
    timestamp(state.runner.lastHeartbeatAt, 'state.runner.lastHeartbeatAt');
  }
  if (state.schemaVersion !== V2_STATE_SCHEMA_VERSION) fail(`state schemaVersion must be ${V2_STATE_SCHEMA_VERSION}`);
  requiredString(state.runId, 'state.runId');
  requiredString(state.shortId, 'state.shortId');
  requiredString(state.intentId, 'state.intentId');
  validateGoal({ schemaVersion: V2_GOAL_SCHEMA_VERSION, intentId: state.intentId, intent: state.intent, config: state.config });
  validateLifecycle(state.lifecycle);
  if (state.planner?.awaiting != null && (['completed', 'partial', 'cancelled', 'failed'].includes(state.lifecycle.status) || state.lifecycle.resultFile !== null)) {
    fail('state.planner.awaiting must be null once the workflow is terminal');
  }
  validatePause(state.pause, state.lifecycle);
  validatePreflight(state.preflight);
  validatePlanner(state.planner);
  validateRevisions(state.revisions, state.program);
  const live = isLiveProgram(state);
  validatePresentation(state.presentation, state.program, live ? removedActionIds(state) : new Set());
  const ledger = validateLedger(state);
  validateActionStates(state.actions, state.program, live);
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
  validateAdvisories(state.advisories);
  validateVerifyLoop(state.verifyLoop, state);
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
  noUnknown(state.usage, new Set([
    'total', 'byPool', 'apiUsd', 'apiKnownSubtotalUsd', 'subscriptionUsd',
    'subscriptionKnownSubtotalUsd', 'measuredAttempts', 'pricedAttempts',
    'subscriptionPricedAttempts', 'attempts', 'apiMissingAttempts',
    'subscriptionMissingAttempts', 'tokenSource', 'subscriptionBasis',
    'subscriptionLedgerByPool',
  ]), 'state.usage');
  if (typeof state.usage.total !== 'number' || !Number.isFinite(state.usage.total) || state.usage.total < 0) fail('state.usage.total must be a non-negative finite number');
  validatePoolUsage(state.usage.byPool, 'state.usage.byPool');
  for (const field of ['apiUsd', 'apiKnownSubtotalUsd', 'subscriptionUsd', 'subscriptionKnownSubtotalUsd']) {
    nullableFiniteNumber(state.usage[field], `state.usage.${field}`);
    if (state.usage[field] !== null && state.usage[field] < 0) fail(`state.usage.${field} must be non-negative`);
  }
  for (const field of ['measuredAttempts', 'pricedAttempts', 'subscriptionPricedAttempts', 'attempts', 'apiMissingAttempts', 'subscriptionMissingAttempts']) {
    if (state.usage[field] !== undefined) nonNegativeInteger(state.usage[field], `state.usage.${field}`);
  }
  if (state.usage.tokenSource !== undefined && !USAGE_TOKEN_SOURCES.has(state.usage.tokenSource)) fail('state.usage.tokenSource is invalid');
  if (state.usage.subscriptionBasis !== undefined && !USAGE_SUBSCRIPTION_BASES.has(state.usage.subscriptionBasis)) fail('state.usage.subscriptionBasis is invalid');
  if (state.usage.subscriptionLedgerByPool !== undefined) {
    object(state.usage.subscriptionLedgerByPool, 'state.usage.subscriptionLedgerByPool');
    for (const [pool, ledger] of Object.entries(state.usage.subscriptionLedgerByPool)) {
      requiredString(pool, 'state.usage.subscriptionLedgerByPool key');
      object(ledger, `state.usage.subscriptionLedgerByPool.${pool}`);
      noUnknown(ledger, new Set(['observedPct', 'assignedPct', 'unassignedPct', 'basis']), `state.usage.subscriptionLedgerByPool.${pool}`);
      for (const field of ['observedPct', 'assignedPct', 'unassignedPct']) {
        nullableFiniteNumber(ledger[field], `state.usage.subscriptionLedgerByPool.${pool}.${field}`);
        if (ledger[field] != null && ledger[field] < 0) fail(`state.usage.subscriptionLedgerByPool.${pool}.${field} must be non-negative`);
      }
      if (!USAGE_SUBSCRIPTION_BASES.has(ledger.basis)) fail(`state.usage.subscriptionLedgerByPool.${pool}.basis is invalid`);
    }
  }
  validateEvents(state.events);
  return state;
}

export function v2PlannerMode(stateOrGoal) {
  return stateOrGoal?.config?.settings?.plannerMode ?? 'dispatched';
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
