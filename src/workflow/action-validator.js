// Deterministic validation for the generic autonomous workflow V2 program.

import { isReasoningLevel } from '../lib/reasoning.js';

export const ACTION_PROGRAM_SCHEMA_VERSION = 'bullswarm.workflow.program.v2';

const ID_RE = /^[a-z0-9][a-z0-9-]*$/;
const LANES = new Set(['analyze', 'build', 'chore']);
const EFFORTS = new Set(['high', 'medium', 'low']);
export const DEFAULT_EFFORT_BY_LANE = Object.freeze({
  analyze: 'medium',
  build: 'medium',
  chore: 'low',
});
// The closed set of work natures. `kind` says what the action IS; the table
// derives the lane and effort that nature implies, so an author states the
// nature once instead of re-deciding two routing fields per action.
export const KIND_DEFAULTS = Object.freeze({
  mechanical: Object.freeze({ lane: 'chore', effort: 'low' }),
  'io-read': Object.freeze({ lane: 'analyze', effort: 'low' }),
  check: Object.freeze({ lane: 'analyze', effort: 'medium' }),
  implement: Object.freeze({ lane: 'build', effort: 'medium' }),
  integration: Object.freeze({ lane: 'build', effort: 'high' }),
  architecture: Object.freeze({ lane: 'analyze', effort: 'high' }),
  'adversarial-acceptance': Object.freeze({ lane: 'analyze', effort: 'high' }),
});
export const ACTION_KINDS = Object.freeze(Object.keys(KIND_DEFAULTS));
// Exactly two advisory codes. Advisories are advice about effort choices; they
// never affect validity, exit codes, or dispatch.
export const PROGRAM_ADVISORY_CODES = Object.freeze(['all-writers-high', 'docs-at-high']);
const PROGRAM_FIELDS = new Set(['schemaVersion', 'actions', 'defaults']);
const PROGRAM_DEFAULT_FIELDS = new Set(['effort', 'reasoning']);
const ACTION_FIELDS = new Set([
  'id', 'purpose', 'dependsOn', 'affects', 'ownedFiles', 'prompt',
  'kind', 'lane', 'effort', 'evidenceFor', 'inputs', 'produces', 'reasoning',
]);

// Only reject direct response instructions. Product-inspection prompts often
// mention output, JSON, and schemas together; proximity alone says nothing
// about whether the planner is trying to replace the kernel's evidence format.
// This is authoring feedback, not the enforcement boundary: evidence still
// passes the kernel-owned output validator after dispatch.
const EVIDENCE_OUTPUT_DIRECTIVE = /(?:^|[.!?;\n]|\b(?:and|then)\s+)\s*(?:please\s+)?(?:return|respond|reply|output|emit|produce|provide|finish|end)\s+(?:(?:only|exactly|with|in|as|using|an?|the|your|final|evidence|structured|valid|raw|plain)\s+){0,8}(?:json|object|envelope)\b/i;
const LEGACY_EVIDENCE_SHAPE = /["']?ok["']?\s*:\s*(?:true|false|boolean|true\s*\|\s*false)[\s\S]{0,240}["']?(?:concerns|summary)["']?\s*:/i;

function evidencePromptOwnsOutput(prompt) {
  return typeof prompt === 'string'
    && (EVIDENCE_OUTPUT_DIRECTIVE.test(prompt) || LEGACY_EVIDENCE_SHAPE.test(prompt));
}

// One resolution path for the three routing fields, used by the validator
// (which writes the resolved values back onto the normalised action) and by
// the advisories (which read raw or normalised programs alike). Nothing
// downstream re-applies this precedence: acceptance normalises once.
//   lane    : action.lane > KIND_DEFAULTS[kind].lane
//   effort  : action.effort > KIND_DEFAULTS[kind].effort > defaults.effort
//             > DEFAULT_EFFORT_BY_LANE[lane]
//   reasoning: action.reasoning > defaults.reasoning  (run/strategy/connector
//             levels still apply later, unchanged, when this is absent)
export function resolveActionRouting(action, defaults = {}) {
  const kindDefaults = KIND_DEFAULTS[action?.kind] ?? null;
  const lane = action?.lane ?? kindDefaults?.lane ?? null;
  const effort = action?.effort
    ?? kindDefaults?.effort
    ?? defaults?.effort
    ?? (LANES.has(lane) ? DEFAULT_EFFORT_BY_LANE[lane] : null);
  return {
    lane,
    effort: effort ?? null,
    reasoning: action?.reasoning ?? defaults?.reasoning ?? null,
  };
}

const isMarkdown = (file) => typeof file === 'string' && /\.md$/i.test(file);

/**
 * Non-blocking authoring advice about a program's effort choices. Advisories
 * never change validity, exit codes, or dispatch; they are printed and stored
 * so an author can see a routing smell it is still free to keep.
 */
export function programAdvisories(program) {
  if (!isObject(program) || !Array.isArray(program.actions)) return [];
  const defaults = isObject(program.defaults) ? program.defaults : {};
  const resolved = program.actions.filter(isObject).map((action) => ({
    id: typeof action.id === 'string' ? action.id : null,
    ownedFiles: Array.isArray(action.ownedFiles) ? action.ownedFiles : [],
    ...resolveActionRouting(action, defaults),
  }));
  const writers = resolved.filter((action) => action.lane === 'build' || action.lane === 'chore');
  const advisories = [];
  if (writers.length >= 3 && writers.every((action) => action.effort === 'high')) {
    advisories.push({
      code: 'all-writers-high',
      actionId: null,
      message: `all ${writers.length} build/chore actions run at high effort; high is for architecture, ambiguous tradeoffs, or cross-cutting integration, so ordinary implementation slices belong at medium`,
    });
  }
  for (const action of writers) {
    if (action.effort !== 'high' || !action.ownedFiles.length) continue;
    if (!action.ownedFiles.every(isMarkdown)) continue;
    advisories.push({
      code: 'docs-at-high',
      actionId: action.id,
      message: `owns only markdown files (${action.ownedFiles.join(', ')}) at high effort; documentation edits rarely need the high tier`,
    });
  }
  return advisories;
}

export class ActionValidationError extends Error {
  constructor(issues) {
    super(`workflow action program invalid: ${issues.length} problem(s)`);
    this.name = 'ActionValidationError';
    this.issues = [...issues];
  }
}

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const hasId = (value) => typeof value === 'string' && ID_RE.test(value);

function clone(value) {
  if (Array.isArray(value)) return value.map(clone);
  if (isObject(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clone(item)]));
  return value;
}

function uniqueStrings(value, at, issues, { ids = false } = {}) {
  if (!Array.isArray(value)) {
    issues.push(`${at} must be an array`);
    return [];
  }
  const seen = new Set();
  for (const [index, item] of value.entries()) {
    if (typeof item !== 'string' || (ids && !hasId(item))) {
      issues.push(`${at}[${index}] must be ${ids ? 'a valid ID' : 'a string'}`);
      continue;
    }
    if (seen.has(item)) issues.push(`${at} contains duplicate "${item}"`);
    seen.add(item);
  }
  return [...value];
}

function normalizeOwnedFiles(value, at, issues) {
  if (!Array.isArray(value)) {
    issues.push(`${at} must be an array`);
    return [];
  }
  const seen = new Set();
  const result = [];
  for (const [index, raw] of value.entries()) {
    if (typeof raw !== 'string' || !raw.length) {
      issues.push(`${at}[${index}] must be a non-empty relative path`);
      continue;
    }
    if (raw.includes('\0')) {
      issues.push(`${at}[${index}] must not contain NUL bytes`);
      continue;
    }
    if (raw.startsWith('/') || /^[A-Za-z]:[\\/]/.test(raw) || raw.startsWith('\\')) {
      issues.push(`${at}[${index}] must be relative`);
      continue;
    }
    const parts = raw.split(/[\\/]/);
    if (parts.includes('..')) {
      issues.push(`${at}[${index}] must not contain dot-dot traversal`);
      continue;
    }
    const normalized = parts.filter(Boolean).join('/').replace(/^\.\//, '');
    if (!normalized || normalized === '.') {
      issues.push(`${at}[${index}] must not be empty`);
      continue;
    }
    if (seen.has(normalized)) issues.push(`${at} contains duplicate "${normalized}"`);
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

// Program-level fallbacks an author may set once instead of repeating on
// every action. Deliberately only `effort` and `reasoning`: lane follows the
// nature of the individual action, so there is no program-wide lane.
function programDefaults(program, issues) {
  const raw = program.defaults;
  if (raw === undefined) return {};
  if (!isObject(raw)) {
    issues.push('program.defaults must be an object');
    return {};
  }
  const defaults = {};
  for (const key of Object.keys(raw)) if (!PROGRAM_DEFAULT_FIELDS.has(key)) {
    issues.push(`program.defaults.${key} is not allowed; only effort and reasoning`);
  }
  if (raw.effort !== undefined) {
    if (EFFORTS.has(raw.effort)) defaults.effort = raw.effort;
    else issues.push('program.defaults.effort must be high|medium|low');
  }
  if (raw.reasoning !== undefined) {
    if (isReasoningLevel(raw.reasoning)) defaults.reasoning = raw.reasoning;
    else issues.push('program.defaults.reasoning must be low|medium|high|xhigh|max|default');
  }
  return defaults;
}

function runtimeRequirements(runtime, issues) {
  const value = runtime.mandatoryRequirements ?? runtime.requiredRequirements ?? runtime.requirements ?? [];
  const all = new Set();
  const mandatory = new Set();
  const add = (id, isMandatory, at) => {
    if (!hasId(id)) {
      issues.push(`${at} must contain a valid ID`);
      return;
    }
    if (all.has(id)) issues.push(`runtime requirements contains duplicate "${id}"`);
    all.add(id);
    if (isMandatory) mandatory.add(id);
  };
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      if (typeof item === 'string') add(item, true, `runtime requirement [${index}]`);
      else if (isObject(item) && Object.keys(item).every((key) => key === 'id' || key === 'mandatory')) {
        if (typeof item.mandatory !== 'boolean') issues.push(`runtime requirement [${index}].mandatory must be boolean`);
        add(item.id, item.mandatory !== false, `runtime requirement [${index}].id`);
      } else issues.push(`runtime requirement [${index}] must be an ID or {id, mandatory} object`);
    });
  } else if (isObject(value)) {
    for (const [id, record] of Object.entries(value)) {
      if (record === undefined || record === null || typeof record === 'boolean') {
        add(id, record !== false, `runtime requirement "${id}"`);
      } else if (isObject(record) && Object.keys(record).every((key) => key === 'mandatory')) {
        if (typeof record.mandatory !== 'boolean') issues.push(`runtime requirement "${id}".mandatory must be boolean`);
        add(id, record.mandatory !== false, `runtime requirement "${id}"`);
      } else issues.push(`runtime requirement "${id}" must be a boolean or {mandatory} object`);
    }
  } else {
    issues.push('runtime requirements must be an array or object');
  }
  return { all, mandatory };
}

function knownActionRecords(runtime, issues) {
  const value = runtime.knownActions ?? [];
  const knownFields = new Set(['id', 'dependsOn', 'affects', 'ownedFiles', 'evidenceFor', 'produces']);
  if (!Array.isArray(value)) {
    issues.push('runtime knownActions must be an array');
    return [];
  }
  return value.map((raw, index) => {
    const at = `runtime.knownActions[${index}]`;
    if (!isObject(raw)) {
      issues.push(`${at} must be an object`);
      return null;
    }
    for (const key of Object.keys(raw)) if (!knownFields.has(key)) issues.push(`${at}.${key} is not allowed`);
    if (!hasId(raw.id)) issues.push(`${at}.id must be a valid kebab-case ID`);
    const action = { id: raw.id };
    for (const field of ['dependsOn', 'affects', 'ownedFiles', 'evidenceFor', 'produces']) {
      if (raw[field] !== undefined) {
        action[field] = field === 'ownedFiles'
          ? normalizeOwnedFiles(raw[field], `${at}.${field}`, issues)
          : uniqueStrings(raw[field], `${at}.${field}`, issues, { ids: true });
      } else action[field] = [];
    }
    return action;
  }).filter(Boolean);
}

function knownArtifactRecords(runtime, issues) {
  const value = runtime.knownArtifacts ?? [];
  const result = new Map();
  const add = (artifact, producer, at) => {
    if (!hasId(artifact)) issues.push(`${at} must name a valid artifact ID`);
    if (!hasId(producer)) issues.push(`${at} must name a valid producer ID`);
    if (!hasId(artifact) || !hasId(producer)) return;
    if (result.has(artifact)) issues.push(`known artifact "${artifact}" has duplicate producers`);
    else result.set(artifact, producer);
  };
  if (Array.isArray(value)) value.forEach((record, index) => {
    const at = `runtime.knownArtifacts[${index}]`;
    if (isObject(record)) add(record.id ?? record.artifact, record.producer ?? record.producedBy ?? record.actionId, at);
    else issues.push(`${at} must be an object`);
  });
  else if (isObject(value)) for (const [artifact, producer] of Object.entries(value)) {
    if (isObject(producer)) add(artifact, producer.producer ?? producer.producedBy ?? producer.actionId, `runtime.knownArtifacts.${artifact}`);
    else add(artifact, producer, `runtime.knownArtifacts.${artifact}`);
  }
  else issues.push('runtime knownArtifacts must be an array or object');
  return result;
}

function ancestors(id, byId, memo = new Map(), visiting = new Set()) {
  if (memo.has(id)) return memo.get(id);
  if (visiting.has(id)) return new Set();
  visiting.add(id);
  const result = new Set();
  for (const dependency of byId.get(id)?.dependsOn ?? []) {
    result.add(dependency);
    for (const ancestor of ancestors(dependency, byId, memo, visiting)) result.add(ancestor);
  }
  visiting.delete(id);
  memo.set(id, result);
  return result;
}

function reaches(start, target, byId, visiting = new Set()) {
  if (visiting.has(start)) return false;
  visiting.add(start);
  return (byId.get(start)?.dependsOn ?? []).some((dependency) => dependency === target || reaches(dependency, target, byId, visiting));
}

function hasCycle(actions, byId) {
  const visiting = new Set();
  const visited = new Set();
  function visit(id) {
    if (visiting.has(id)) return true;
    if (visited.has(id)) return false;
    visiting.add(id);
    if ((byId.get(id)?.dependsOn ?? []).some(visit)) return true;
    visiting.delete(id);
    visited.add(id);
    return false;
  }
  return actions.some((action) => visit(action.id));
}

function maxParallelism(actions, byId) {
  // The largest antichain is the greatest number of actions that can be
  // runnable together. Dilworth's theorem reduces this to bipartite matching.
  const ids = actions.map((action) => action.id);
  const edges = new Map(ids.map((id) => [id, [...ancestors(id, byId)]]));
  const matched = new Map();
  function augment(id, seen) {
    for (const ancestor of edges.get(id) ?? []) {
      if (seen.has(ancestor)) continue;
      seen.add(ancestor);
      const prior = matched.get(ancestor);
      if (prior === undefined || augment(prior, seen)) {
        matched.set(ancestor, id);
        return true;
      }
    }
    return false;
  }
  let matching = 0;
  for (const id of ids) if (augment(id, new Set())) matching += 1;
  return ids.length - matching;
}

/**
 * Validate and normalize a planner-authored V2 program.
 * Runtime-only limits and mandatory requirements belong in `runtime`, not the
 * program JSON, so a planner cannot raise its own execution budget.
 */
export function validateActionProgram(program, runtime = {}) {
  const issues = [];
  const enforceRoutingPolicy = runtime.enforceRoutingPolicy !== false;
  if (!isObject(program)) throw new ActionValidationError(['program must be an object']);
  for (const key of Object.keys(program)) if (!PROGRAM_FIELDS.has(key)) issues.push(`program.${key} is not allowed`);
  if (program.schemaVersion !== ACTION_PROGRAM_SCHEMA_VERSION) {
    issues.push(`schemaVersion must be "${ACTION_PROGRAM_SCHEMA_VERSION}"`);
  }
  if (!Array.isArray(program.actions)) issues.push('actions must be an array');
  const rawActions = Array.isArray(program.actions) ? program.actions : [];
  if (Array.isArray(program.actions) && program.actions.length === 0) issues.push('actions must be a non-empty array');
  const defaults = programDefaults(program, issues);
  const actions = [];
  const knownActions = knownActionRecords(runtime, issues);
  const knownById = new Map();
  for (const action of knownActions) {
    if (knownById.has(action.id)) issues.push(`runtime knownActions contains duplicate "${action.id}"`);
    else knownById.set(action.id, action);
  }
  const byId = new Map(knownById);
  const allIds = new Set();

  rawActions.forEach((raw, index) => {
    const at = `actions[${index}]`;
    if (!isObject(raw)) {
      issues.push(`${at} must be an object`);
      return;
    }
    for (const key of Object.keys(raw)) if (!ACTION_FIELDS.has(key)) {
      issues.push(`${at}.${key} is not allowed`);
    }
    const action = clone(raw);
    if (!hasId(action.id)) issues.push(`${at}.id must be a valid kebab-case ID`);
    else if (allIds.has(action.id)) issues.push(`${at}.id "${action.id}" is duplicated`);
    else if (knownById.has(action.id)) issues.push(`${at}.id "${action.id}" collides with known action`);
    else allIds.add(action.id);
    for (const [field, label] of [['purpose', 'non-empty string'], ['prompt', 'non-empty string']]) {
      if (typeof action[field] !== 'string' || !action[field].trim()) issues.push(`${at}.${field} must be a ${label}`);
    }
    const dependsOn = uniqueStrings(action.dependsOn, `${at}.dependsOn`, issues, { ids: true });
    const affects = uniqueStrings(action.affects, `${at}.affects`, issues, { ids: true });
    const evidenceFor = uniqueStrings(action.evidenceFor, `${at}.evidenceFor`, issues, { ids: true });
    const inputs = action.inputs === undefined ? [] : uniqueStrings(action.inputs, `${at}.inputs`, issues, { ids: true });
    const produces = action.produces === undefined ? [] : uniqueStrings(action.produces, `${at}.produces`, issues, { ids: true });
    const ownedFiles = normalizeOwnedFiles(action.ownedFiles, `${at}.ownedFiles`, issues);
    // An unknown kind is a typo in the author's program, not a runtime
    // condition, so it is rejected before anything is launched.
    if (action.kind !== undefined && !Object.hasOwn(KIND_DEFAULTS, action.kind)) {
      issues.push(`${at}.kind must be ${ACTION_KINDS.join('|')}`);
    }
    // Resolve once, here, and write the resolved values back below: dispatch,
    // reports, and advisories all read concrete lane/effort/reasoning.
    const routing = resolveActionRouting(action, defaults);
    if (!LANES.has(routing.lane)) issues.push(`${at}.lane must be analyze|build|chore`);
    if (!EFFORTS.has(routing.effort)) issues.push(`${at}.effort must be high|medium|low`);
    // Optional caller override. `effort` still picks the model tier; this only
    // sets how hard that model thinks, and it outranks every configured level.
    if (action.reasoning !== undefined && !isReasoningLevel(action.reasoning)) {
      issues.push(`${at}.reasoning must be low|medium|high|xhigh|max|default`);
    }
    if (LANES.has(routing.lane)) action.lane = routing.lane;
    if (EFFORTS.has(routing.effort)) action.effort = routing.effort;
    if (routing.reasoning !== null) action.reasoning = routing.reasoning;
    if (enforceRoutingPolicy && evidenceFor.length && action.lane !== 'analyze') {
      issues.push(`${at} evidence actions must use lane analyze`);
    }
    if (enforceRoutingPolicy && ownedFiles.length && action.lane === 'analyze') {
      issues.push(`${at} analyze actions must not own workspace files; use build or chore for mutations`);
    }
    if (enforceRoutingPolicy && action.lane === 'chore' && action.effort !== 'low') {
      issues.push(`${at} chore actions are deterministic mechanical work and must use low effort`);
    }
    if (runtime.requireOwnedFiles === true && ['build', 'chore'].includes(action.lane) && !ownedFiles.length) {
      issues.push(`${at} isolated writers must declare non-empty ownedFiles; unrestricted integrators require a shared workspace`);
    }
    if (evidenceFor.length && (affects.length || ownedFiles.length)) {
      issues.push(`${at} evidence actions must have empty affects and ownedFiles`);
    }
    if (evidenceFor.length && evidencePromptOwnsOutput(action.prompt)) {
      issues.push(`${at}.prompt must describe inspection scope only; evidence output schema is supplied by the V2 kernel`);
    }
    if (!evidenceFor.length && (ownedFiles.length || (runtime.relaxedGraph === true && ['build', 'chore'].includes(action.lane))) && !affects.length) {
      issues.push(`${at} mutating actions with ownedFiles must affect a requirement`);
    }
    action.dependsOn = dependsOn;
    action.affects = affects;
    action.evidenceFor = evidenceFor;
    action.inputs = inputs;
    action.produces = produces;
    action.ownedFiles = ownedFiles;
    actions.push(action);
    if (hasId(action.id)) byId.set(action.id, action);
  });

  if (runtime.workspaceMutation === 'forbidden') {
    for (const action of actions) {
      if (runtime.relaxedGraph === true && action.lane !== 'analyze') issues.push(`${action.id} must use analyze because the goal forbids workspace mutation`);
      if (action.ownedFiles.length) {
        issues.push(`${action.id}.ownedFiles must be empty because the goal forbids workspace mutation`);
      }
    }
  }

  const forbidden = ['type', 'verify', 'repair', 'fanout', 'pool', 'model', 'preferredPool', 'taskFile', 'timeoutSec', 'completion', 'decision', 'onError', 'phase', 'requiresCapabilities'];
  for (const action of rawActions) for (const field of forbidden) if (Object.hasOwn(action ?? {}, field)) {
    issues.push(`actions[${rawActions.indexOf(action)}].${field} is not allowed in V2`);
  }
  const { all: requirementIds, mandatory: mandatoryRequirementIds } = runtimeRequirements(runtime, issues);
  const freshEvidence = runtime.freshEvidenceRequirementIds ?? [];
  const freshEvidenceRequirementIds = new Set();
  if (!Array.isArray(freshEvidence)) issues.push('runtime freshEvidenceRequirementIds must be an array');
  else for (const [index, id] of freshEvidence.entries()) {
    if (!hasId(id)) issues.push(`runtime freshEvidenceRequirementIds[${index}] must be a valid ID`);
    else if (!requirementIds.has(id)) issues.push(`runtime freshEvidenceRequirementIds references unknown requirement "${id}"`);
    else if (freshEvidenceRequirementIds.has(id)) issues.push(`runtime freshEvidenceRequirementIds contains duplicate "${id}"`);
    else freshEvidenceRequirementIds.add(id);
  }
  const knownArtifacts = knownArtifactRecords(runtime, issues);

  for (const action of knownActions) {
    for (const dependency of action.dependsOn) if (!byId.has(dependency)) {
      issues.push(`known action ${action.id}.dependsOn references unknown action "${dependency}"`);
    }
    for (const requirement of [...action.affects, ...action.evidenceFor]) if (!requirementIds.has(requirement)) {
      issues.push(`${action.id} references unknown requirement "${requirement}"`);
    }
  }

  const artifactProducer = new Map(knownArtifacts);
  for (const action of knownActions) {
    for (const artifact of action.produces) {
      if (artifactProducer.has(artifact) && artifactProducer.get(artifact) !== action.id) {
        issues.push(`artifact "${artifact}" has duplicate producers`);
      } else artifactProducer.set(artifact, action.id);
    }
  }
  for (const action of actions) {
    for (const artifact of action.produces) {
      if (artifactProducer.has(artifact)) issues.push(`artifact "${artifact}" has duplicate producers`);
      else artifactProducer.set(artifact, action.id);
    }
  }
  for (const action of actions) {
    for (const dependency of action.dependsOn) if (!byId.has(dependency)) issues.push(`${action.id}.dependsOn references unknown action "${dependency}"`);
    if (action.dependsOn.includes(action.id)) issues.push(`${action.id} cannot depend on itself`);
    for (const artifact of [...action.inputs, ...action.produces]) if (!hasId(artifact)) issues.push(`${action.id} has malformed artifact ID "${artifact}"`);
    for (const artifact of action.inputs) if (!artifactProducer.has(artifact)) issues.push(`${action.id}.inputs references unknown artifact "${artifact}"`);
    for (const requirement of [...action.affects, ...action.evidenceFor]) if (!requirementIds.has(requirement)) issues.push(`${action.id} references unknown requirement "${requirement}"`);
  }
  for (const [artifact, producer] of knownArtifacts) if (!byId.has(producer)) {
    issues.push(`known artifact "${artifact}" references unknown producer "${producer}"`);
  }
  for (const action of actions) {
    const ancestorsOfAction = ancestors(action.id, byId);
    for (const artifact of action.inputs) {
      const producer = artifactProducer.get(artifact);
      if (producer && !ancestorsOfAction.has(producer)) issues.push(`${action.id}.inputs artifact "${artifact}" producer must be a dependency ancestor`);
    }
    for (const dependency of action.dependsOn) {
      const dependencyAction = byId.get(dependency);
      if (!dependencyAction) continue;
      if (runtime.relaxedGraph === true) continue;
      if (dependencyAction.evidenceFor.length && !action.inputs.some((artifact) => artifactProducer.get(artifact) === dependency)) {
        issues.push(`${action.id} may depend on evidence action "${dependency}" only through its input artifact`);
      } else if (!action.evidenceFor.length && !dependencyAction.evidenceFor.length) {
        const overlap = action.ownedFiles.some((file) => dependencyAction.ownedFiles.includes(file));
        if (!overlap && !action.inputs.some((artifact) => artifactProducer.get(artifact) === dependency)) {
          issues.push(`${action.id} work dependency on "${dependency}" is not justified by an artifact or overlapping owned path`);
        }
      }
    }
  }
  for (const action of actions) {
    if (action.evidenceFor.length) for (const requirement of action.evidenceFor) {
      for (const work of [...knownActions, ...actions].filter((candidate) => !candidate.evidenceFor.length && candidate.affects.includes(requirement))) {
        if (!ancestors(action.id, byId).has(work.id)) issues.push(`${action.id} evidence for "${requirement}" must depend on work action "${work.id}"`);
      }
    }
  }
  for (const left of [...knownActions, ...actions]) for (const right of [...knownActions, ...actions]) {
    if (runtime.relaxedGraph === true) continue;
    if (left.id >= right.id || left.evidenceFor.length || right.evidenceFor.length) continue;
    if (left.ownedFiles.some((file) => right.ownedFiles.includes(file)) && !reaches(left.id, right.id, byId) && !reaches(right.id, left.id, byId)) {
      issues.push(`overlapping writers "${left.id}" and "${right.id}" must be transitively ordered`);
    }
  }
  if (hasCycle(actions, byId)) issues.push('dependency graph contains a cycle');
  const maxActions = runtime.maxActions ?? runtime.limits?.maxActions ?? 100;
  const maxParallel = runtime.maxParallel ?? runtime.limits?.maxParallel ?? 100;
  if (!Number.isInteger(maxActions) || maxActions < 0) issues.push('runtime maxActions must be a non-negative integer');
  else if (runtime.enforceMaxActions !== false && actions.length > maxActions) issues.push(`program exceeds maxActions=${maxActions}`);
  if (!Number.isInteger(maxParallel) || maxParallel < 1) issues.push('runtime maxParallel must be a positive integer');
  else if (runtime.enforceMaxParallel !== false && maxParallelism(actions, byId) > maxParallel) issues.push(`program exceeds maxParallel=${maxParallel}`);
  if (runtime.requireMandatoryEvidence !== false) {
    for (const requirement of mandatoryRequirementIds) if (!freshEvidenceRequirementIds.has(requirement) && !actions.some((action) => action.evidenceFor.includes(requirement))) {
      issues.push(`mandatory requirement "${requirement}" has no evidence action`);
    }
  }
  if (issues.length) throw new ActionValidationError(issues);
  return { schemaVersion: ACTION_PROGRAM_SCHEMA_VERSION, actions: actions.map(clone) };
}

export const validateProgram = validateActionProgram;
