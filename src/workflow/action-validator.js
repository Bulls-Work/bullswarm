// Deterministic validation for the generic autonomous workflow V2 program.

import { isReasoningLevel } from '../lib/reasoning.js';
import {
  DELIVERABLE_TYPES, EVIDENCE_TYPES, KIND_ROLES, ROLES,
  ROLE_DEFAULT_DELIVERABLE, ROLE_DELIVERABLES, STEP_EVIDENCE_TYPES, WRITING_DELIVERABLES,
  deliverableTypeOf, laneFitsDeliverable, roleRouting,
} from './step-vocabulary.js';

export { ROLES, KIND_ROLES, DELIVERABLE_TYPES, EVIDENCE_TYPES, STEP_EVIDENCE_TYPES };

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
  // A digest reads its dependencies' outputs and re-emits them condensed and
  // verbatim, so an expensive consumer reads one artifact instead of many raw
  // files. It is extractive by construction: no verdicts, no recommendations,
  // and never a source of evidence, because evidence reads the real artifacts.
  digest: Object.freeze({ lane: 'analyze', effort: 'low' }),
  check: Object.freeze({ lane: 'analyze', effort: 'medium' }),
  implement: Object.freeze({ lane: 'build', effort: 'medium' }),
  integration: Object.freeze({ lane: 'build', effort: 'high' }),
  architecture: Object.freeze({ lane: 'analyze', effort: 'high' }),
  'adversarial-acceptance': Object.freeze({ lane: 'analyze', effort: 'high' }),
});
export const ACTION_KINDS = Object.freeze(Object.keys(KIND_DEFAULTS));
// Exactly three advisory codes: two about effort choices, one about a
// requirement no step checks. Advisories never affect validity, exit codes, or
// dispatch.
export const PROGRAM_ADVISORY_CODES = Object.freeze(['all-writers-high', 'docs-at-high', 'requirement-unchecked']);
// `verifyRounds` at the top level is the normalized form this validator
// returns (see the end of validateActionProgram); accepting it back keeps an
// accepted program valid when it is validated a second time.
const PROGRAM_FIELDS = new Set(['schemaVersion', 'actions', 'defaults', 'verifyRounds']);
const PROGRAM_DEFAULT_FIELDS = new Set(['effort', 'reasoning', 'timeBox', 'verifyRounds']);
const ACTION_FIELDS = new Set([
  'id', 'purpose', 'dependsOn', 'affects', 'ownedFiles', 'prompt',
  'kind', 'role', 'lane', 'effort', 'deliverable', 'evidence', 'evidenceFor', 'inputs', 'produces', 'reasoning',
  'timeBox',
]);
// The soft time box, in whole minutes; 0 leaves the paragraph out. A guide
// written into the task, never a limit the kernel enforces (time-box.js).
export const TIME_BOX_MAX_MINUTES = 240;
// How many verify rounds the kernel may run before it hands failures back.
export const VERIFY_ROUNDS_DEFAULT = 3;
const VERIFY_ROUNDS_MAX = 3;
const isTimeBox = (value) => Number.isInteger(value) && value >= 0 && value <= TIME_BOX_MAX_MINUTES;

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
//   lane    : action.lane > KIND_DEFAULTS[kind].lane > roleRouting(role, type)
//   effort  : action.effort > KIND_DEFAULTS[kind].effort > role effort
//             > defaults.effort > DEFAULT_EFFORT_BY_LANE[lane]
//   reasoning: action.reasoning > defaults.reasoning  (run/strategy/connector
//             levels still apply later, unchanged, when this is absent)
export function resolveActionRouting(action, defaults = {}) {
  const kindDefaults = Object.hasOwn(KIND_DEFAULTS, action?.kind ?? '') ? KIND_DEFAULTS[action.kind] : null;
  const role = action?.role;
  const roleDefaults = !kindDefaults && typeof role === 'string' && ROLES.includes(role)
    ? roleRouting(role, deliverableTypeOf(action?.deliverable) ?? ROLE_DEFAULT_DELIVERABLE[role])
    : null;
  const lane = action?.lane ?? kindDefaults?.lane ?? roleDefaults?.lane ?? null;
  const effort = action?.effort
    ?? kindDefaults?.effort
    ?? roleDefaults?.effort
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
export function programAdvisories(program, { requirements = null } = {}) {
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
      message: `all ${writers.length} build/chore actions run at high effort; high is for design judgment, ambiguous tradeoffs, or cross-cutting integration, so ordinary implementation slices belong at medium`,
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
  // A requirement no step gives evidence for can never pass, so the run can
  // finish but never be verified. Said at launch, not discovered at the end.
  if (Array.isArray(requirements) && requirements.length) {
    const checked = new Set(program.actions.filter(isObject)
      .flatMap((action) => (Array.isArray(action.evidenceFor) ? action.evidenceFor : [])));
    const ids = requirements.map((requirement) => (typeof requirement === 'string' ? requirement : requirement?.id)).filter(Boolean);
    const unchecked = ids.filter((id) => !checked.has(id));
    if (unchecked.length) {
      const named = unchecked.length > 4 ? `${unchecked.slice(0, 3).join(', ')} and ${unchecked.length - 3} more` : unchecked.join(', ');
      advisories.push({
        code: 'requirement-unchecked',
        actionId: null,
        message: checked.size
          ? `no step gives evidence for ${named}; the run can finish but ${unchecked.length === 1 ? 'that requirement stays' : 'those requirements stay'} unverified, so add ${unchecked.length === 1 ? 'it' : 'them'} to a check step's evidenceFor`
          : `no step checks any requirement (${named}); the run can finish but never be verified, so add a check step with evidenceFor, or use bullswarm run for one bounded task`,
      });
    }
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

// One exact relative file path, or null with the reason in `issues`.
function normalizeOwnedPath(raw, at, issues) {
  if (typeof raw !== 'string' || !raw.length) {
    issues.push(`${at} must be a non-empty relative path`);
    return null;
  }
  if (raw.includes('\0')) {
    issues.push(`${at} must not contain NUL bytes`);
    return null;
  }
  if (raw.startsWith('/') || /^[A-Za-z]:[\\/]/.test(raw) || raw.startsWith('\\')) {
    issues.push(`${at} must be relative`);
    return null;
  }
  // The kernel checks ownership against exact files. A trailing slash or a
  // glob used to pass here (normalized away) and then stop the kernel right
  // after launch, leaving a run that never started (2026-09-10).
  if (/[\\/]$/.test(raw) || raw.includes('*') || raw.includes('?')) {
    issues.push(`${at} must name one exact file, not a directory or glob ("${raw}")`);
    return null;
  }
  const parts = raw.split(/[\\/]/);
  if (parts.includes('..')) {
    issues.push(`${at} must not contain dot-dot traversal`);
    return null;
  }
  const normalized = parts.filter(Boolean).join('/').replace(/^\.\//, '');
  if (!normalized || normalized === '.') {
    issues.push(`${at} must not be empty`);
    return null;
  }
  return normalized;
}

function normalizeOwnedFiles(value, at, issues) {
  if (!Array.isArray(value)) {
    issues.push(`${at} must be an array`);
    return [];
  }
  const seen = new Set();
  const result = [];
  for (const [index, raw] of value.entries()) {
    const normalized = normalizeOwnedPath(raw, `${at}[${index}]`, issues);
    if (normalized === null) continue;
    if (seen.has(normalized)) issues.push(`${at} contains duplicate "${normalized}"`);
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

// String shorthand or `{type, paths}` becomes `{type}` or `{type, paths}`.
// `paths` is checked with the same exact-file rules as ownedFiles.
function normalizeDeliverable(raw, at, issues) {
  const shape = `${at}.deliverable must be ${DELIVERABLE_TYPES.join('|')}, or an object {type, paths}`;
  let value = raw;
  if (typeof raw === 'string') {
    if (!DELIVERABLE_TYPES.includes(raw)) {
      issues.push(shape);
      return null;
    }
    value = { type: raw };
  }
  if (!isObject(value)) {
    issues.push(shape);
    return null;
  }
  for (const key of Object.keys(value)) {
    if (key !== 'type' && key !== 'paths') issues.push(`${at}.deliverable.${key} is not allowed`);
  }
  if (typeof value.type !== 'string' || !DELIVERABLE_TYPES.includes(value.type)) {
    issues.push(shape);
    return null;
  }
  const type = value.type;
  if (type === 'report' || type === 'outward') {
    if (value.paths !== undefined) issues.push(`${at}.deliverable.paths is not allowed for ${type}`);
    return { type };
  }
  if (type === 'data' || type === 'media') {
    if (value.paths === undefined || (Array.isArray(value.paths) && value.paths.length === 0)) {
      issues.push(`${at}.deliverable.paths is required for ${type}`);
      return { type };
    }
  } else if (value.paths === undefined || (Array.isArray(value.paths) && value.paths.length === 0)) {
    return { type };
  }
  if (!Array.isArray(value.paths)) {
    normalizeOwnedFiles(value.paths, `${at}.deliverable.paths`, issues);
    return { type };
  }
  const paths = normalizeOwnedFiles(value.paths, `${at}.deliverable.paths`, issues);
  return paths.length ? { type, paths } : { type };
}

const EVIDENCE_MAX_ITEMS = 5;
const EVIDENCE_CMD_MAX_BYTES = 2000;
const EVIDENCE_TIMEOUT_MAX_SEC = 600;
const EVIDENCE_OUTPUT_FILE = '$output';
const EVIDENCE_ITEM_KEYS = Object.freeze({
  command: Object.freeze(['type', 'cmd', 'timeoutSec']),
  schema: Object.freeze(['type', 'file', 'schema', 'format', 'timeoutSec']),
});

// The checks Bullswarm runs after the worker (E1-E3, E7, E29). Returns the
// normalised items, or undefined when there are none (`[]` is dropped) or the
// field is refused. Items keep their order and exactly the keys the author
// gave, written in one fixed key order so a second pass changes nothing; the
// default timeoutSec and format are never written back.
function normalizeEvidence(raw, at, issues, { relaxedGraph, kind, evidenceFor, evidenceAllowed = true }) {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw) || raw.length > EVIDENCE_MAX_ITEMS) {
    issues.push(`${at}.evidence must be an array of at most ${EVIDENCE_MAX_ITEMS} items`);
    return undefined;
  }
  if (!raw.length) return undefined;
  const refusals = [];
  if (relaxedGraph !== true) refusals.push(`${at}.evidence needs a program-mode run`);
  else if (!evidenceAllowed) refusals.push(`${at}.evidence is the caller's to declare; a dispatched planner cannot add checks (the caller adds them with bullswarm workflow plan revise)`);
  if (kind === 'digest') refusals.push(`${at} digest steps take no evidence; the kernel writes their report`);
  if (evidenceFor.length) refusals.push(`${at} review steps (evidenceFor) take no evidence; put the commands the reviewer must run in its prompt`);
  if (refusals.length) {
    issues.push(...refusals);
    return undefined;
  }
  return raw.map((item, index) => {
    const itemAt = `${at}.evidence[${index}]`;
    if (!isObject(item)) {
      issues.push(`${itemAt} must be an object {type, …}`);
      return item;
    }
    if (!STEP_EVIDENCE_TYPES.includes(item.type)) {
      issues.push(`${itemAt}.type must be command or schema; review evidence is a check step with evidenceFor, and a choice is recorded by the caller`);
      return item;
    }
    const keys = EVIDENCE_ITEM_KEYS[item.type];
    for (const key of Object.keys(item)) if (!keys.includes(key)) issues.push(`${itemAt}.${key} is not allowed for a ${item.type} item`);
    const result = { type: item.type };
    if (item.type === 'command') {
      const cmd = typeof item.cmd === 'string' ? item.cmd.trim() : null;
      if (cmd === null || !cmd.length || /[\n\r\0]/.test(cmd) || Buffer.byteLength(cmd, 'utf8') > EVIDENCE_CMD_MAX_BYTES) {
        issues.push(`${itemAt}.cmd must be one line of 1 to ${EVIDENCE_CMD_MAX_BYTES} bytes`);
      }
      result.cmd = cmd ?? item.cmd;
    } else {
      if (item.file === EVIDENCE_OUTPUT_FILE) result.file = EVIDENCE_OUTPUT_FILE;
      else {
        const file = normalizeOwnedPath(item.file, `${itemAt}.file`, issues);
        // "./$output" would normalise to the reserved value and change meaning
        // on the next pass; the reserved value is only ever written verbatim.
        if (file === EVIDENCE_OUTPUT_FILE) issues.push(`${itemAt}.file "${item.file}" names a workspace file called $output; write "$output" exactly for your final response`);
        result.file = file ?? item.file;
      }
      const schema = normalizeOwnedPath(item.schema, `${itemAt}.schema`, issues);
      result.schema = schema ?? item.schema;
      if (item.format !== undefined) {
        if (item.format !== 'json' && item.format !== 'jsonl') issues.push(`${itemAt}.format must be json or jsonl`);
        result.format = item.format;
      }
    }
    if (item.timeoutSec !== undefined) {
      if (!(Number.isInteger(item.timeoutSec) && item.timeoutSec >= 1 && item.timeoutSec <= EVIDENCE_TIMEOUT_MAX_SEC)) {
        issues.push(`${itemAt}.timeoutSec must be an integer from 1 to ${EVIDENCE_TIMEOUT_MAX_SEC} (default 120)`);
      }
      result.timeoutSec = item.timeoutSec;
    }
    return result;
  });
}

// Program-level fallbacks an author may set once instead of repeating on
// every action: `effort`, `reasoning` and `timeBox` fold onto each action;
// `verifyRounds` is the run's own budget. Lane follows the nature of the
// individual action, so there is no program-wide lane.
function programDefaults(program, issues) {
  const raw = program.defaults;
  if (raw === undefined) return {};
  if (!isObject(raw)) {
    issues.push('program.defaults must be an object');
    return {};
  }
  const defaults = {};
  for (const key of Object.keys(raw)) if (!PROGRAM_DEFAULT_FIELDS.has(key)) {
    issues.push(`program.defaults.${key} is not allowed; only effort, reasoning, timeBox and verifyRounds`);
  }
  if (raw.effort !== undefined) {
    if (EFFORTS.has(raw.effort)) defaults.effort = raw.effort;
    else issues.push('program.defaults.effort must be high|medium|low');
  }
  if (raw.reasoning !== undefined) {
    if (isReasoningLevel(raw.reasoning)) defaults.reasoning = raw.reasoning;
    else issues.push('program.defaults.reasoning must be low|medium|high|xhigh|max|default');
  }
  if (raw.timeBox !== undefined) {
    if (isTimeBox(raw.timeBox)) defaults.timeBox = raw.timeBox;
    else issues.push(`program.defaults.timeBox must be a whole number of minutes from 0 to ${TIME_BOX_MAX_MINUTES}`);
  }
  if (raw.verifyRounds !== undefined) {
    if (Number.isInteger(raw.verifyRounds) && raw.verifyRounds >= 1 && raw.verifyRounds <= VERIFY_ROUNDS_MAX) defaults.verifyRounds = raw.verifyRounds;
    else issues.push('program.defaults.verifyRounds must be 1, 2 or 3');
  }
  return defaults;
}

// The normalized top-level `verifyRounds`, when an accepted program is
// validated again. It must agree with `defaults.verifyRounds` when both are
// present.
function normalizedVerifyRounds(program, defaults, issues) {
  if (program.verifyRounds === undefined) return;
  if (!(Number.isInteger(program.verifyRounds) && program.verifyRounds >= 1 && program.verifyRounds <= VERIFY_ROUNDS_MAX)) {
    issues.push('program.verifyRounds must be 1, 2 or 3');
  } else if (defaults.verifyRounds !== undefined && defaults.verifyRounds !== program.verifyRounds) {
    issues.push('program.verifyRounds must match program.defaults.verifyRounds');
  } else defaults.verifyRounds = program.verifyRounds;
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
  // `kind` is carried so a later revision still sees that an earlier action is
  // a digest: the evidence-must-not-read-a-digest rule needs the nature, and a
  // record written before kinds existed simply has none.
  const knownFields = new Set(['id', 'dependsOn', 'affects', 'ownedFiles', 'evidenceFor', 'produces', 'kind']);
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
    if (raw.kind !== undefined && raw.kind !== null && !Object.hasOwn(KIND_DEFAULTS, raw.kind)) {
      issues.push(`${at}.kind must be ${ACTION_KINDS.join('|')}`);
    }
    const action = { id: raw.id, kind: raw.kind ?? null };
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
  normalizedVerifyRounds(program, defaults, issues);
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
    for (const key of Object.keys(raw)) if (!ACTION_FIELDS.has(key)) issues.push(`${at}.${key} is not allowed`);
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
    // Program mode only (D17), then kind/role agreement (D12). A matching role
    // is dropped before routing so the step is validated as its kind.
    if ((action.role !== undefined || action.deliverable !== undefined) && runtime.relaxedGraph !== true) {
      issues.push(`${at}.role and deliverable need a program-mode run`);
    }
    if (action.kind !== undefined && action.role !== undefined) {
      // An unknown kind already has its own issue; there is no role to compare.
      const expectedRole = Object.hasOwn(KIND_ROLES, action.kind) ? KIND_ROLES[action.kind] : action.role;
      if (expectedRole !== action.role) {
        issues.push(`${at}.role "${action.role}" does not match kind "${action.kind}" (kind ${action.kind} is role ${expectedRole}); give one of them`);
      }
      delete action.role;
    }
    // Resolve once, here, and write the resolved values back below: dispatch,
    // reports, and advisories all read concrete lane/effort/reasoning.
    const routing = resolveActionRouting(action, defaults);
    // A role-only step the role table cannot route (unknown role, combine
    // with no deliverable, a deliverable the role does not take) gets its
    // own role or deliverable issue below; a generic lane or effort issue
    // would only repeat it.
    const roleUnrouted = action.kind === undefined && action.role !== undefined;
    const laneGiven = action.lane !== undefined;
    const deliverableGiven = action.deliverable !== undefined;
    if (!LANES.has(routing.lane) && !(roleUnrouted && action.lane === undefined)) issues.push(`${at}.lane must be analyze|build|chore`);
    if (!EFFORTS.has(routing.effort) && !(roleUnrouted && action.effort === undefined)) issues.push(`${at}.effort must be high|medium|low`);
    // Optional caller override. `effort` still picks the model tier; this only
    // sets how hard that model thinks, and it outranks every configured level.
    if (action.reasoning !== undefined && !isReasoningLevel(action.reasoning)) {
      issues.push(`${at}.reasoning must be low|medium|high|xhigh|max|default`);
    }
    // Folded like effort, so `plan export` shows the box each step was given.
    if (action.timeBox !== undefined && !isTimeBox(action.timeBox)) {
      issues.push(`${at}.timeBox must be a whole number of minutes from 0 to ${TIME_BOX_MAX_MINUTES}`);
    } else if (action.timeBox === undefined && defaults.timeBox !== undefined) action.timeBox = defaults.timeBox;
    if (LANES.has(routing.lane)) action.lane = routing.lane;
    if (EFFORTS.has(routing.effort)) action.effort = routing.effort;
    if (routing.reasoning !== null) action.reasoning = routing.reasoning;
    const roleOnly = action.role !== undefined && action.kind === undefined;
    const roleKnown = roleOnly && typeof action.role === 'string' && ROLES.includes(action.role);
    if (roleOnly && !roleKnown) issues.push(`${at}.role must be ${ROLES.join('|')}`);
    if (roleKnown && action.role === 'act') {
      // No lane resolves when the deliverable is not outward; that deliverable
      // issue is the real problem, and the author set no lane to blame.
      if (routing.lane !== null && routing.lane !== 'analyze') issues.push(`${at} act steps use lane analyze; they do not write workspace files`);
      if (ownedFiles.length || evidenceFor.length) issues.push(`${at} act steps must have empty ownedFiles and evidenceFor`);
    }
    if (roleKnown && action.role === 'combine' && action.deliverable === undefined) {
      issues.push(`${at} combine steps must declare a deliverable: files (merging written work, build/high), data or media (build/medium), or report (condensing or comparing results, analyze/medium)`);
    }
    // The act rule above already names evidenceFor.
    if (roleKnown && evidenceFor.length && action.role !== 'check' && action.role !== 'act') {
      issues.push(`${at} only check steps take evidenceFor`);
    }
    if (roleKnown && action.deliverable !== undefined) {
      const explicitType = deliverableTypeOf(action.deliverable);
      if (explicitType && explicitType !== 'outward' && !ROLE_DELIVERABLES[action.role].includes(explicitType)) {
        issues.push(`${at}.deliverable ${explicitType} is not allowed for role ${action.role}; ${action.role} takes ${ROLE_DELIVERABLES[action.role].join('|')}`);
      }
    }
    let resolvedDeliverable = null;
    if (action.deliverable !== undefined) resolvedDeliverable = normalizeDeliverable(action.deliverable, at, issues);
    else if (roleKnown && ROLE_DEFAULT_DELIVERABLE[action.role]) resolvedDeliverable = { type: ROLE_DEFAULT_DELIVERABLE[action.role] };
    if (resolvedDeliverable) {
      const type = resolvedDeliverable.type;
      if (Array.isArray(resolvedDeliverable.paths) && ownedFiles.length) {
        const missing = resolvedDeliverable.paths.filter((file) => !ownedFiles.includes(file));
        if (missing.length) issues.push(`${at}.deliverable.paths must be listed in ownedFiles (missing: ${missing.join(', ')})`);
      }
      if (LANES.has(routing.lane) && !laneFitsDeliverable(routing.lane, type)) {
        if (WRITING_DELIVERABLES.includes(type)) issues.push(`${at} a ${type} deliverable needs lane build or chore; analyze steps are read-only`);
        else if (type === 'report' || type === 'outward') issues.push(`${at} a ${type} deliverable is for analyze steps; build and chore steps deliver files, data or media`);
      }
      if (action.kind === 'digest') issues.push(`${at} digest actions take no deliverable; the kernel writes their report`);
      // A role's default deliverable on a step that wrongly has evidenceFor is
      // not the author's; "only check steps take evidenceFor" covers it.
      if (evidenceFor.length && type !== 'report' && (deliverableGiven || !roleKnown)) issues.push(`${at} steps with evidenceFor take no deliverable other than report`);
      if (type === 'outward' && action.role !== 'act') issues.push(`${at}.deliverable outward needs role act`);
      if (roleKnown || action.deliverable !== undefined) action.deliverable = resolvedDeliverable;
    }
    const evidence = normalizeEvidence(action.evidence, at, issues, {
      relaxedGraph: runtime.relaxedGraph,
      kind: action.kind,
      evidenceFor,
      evidenceAllowed: runtime.evidenceAllowed !== false,
    });
    if (evidence) action.evidence = evidence;
    else delete action.evidence;
    const roleLaneOnWrongEvidence = roleKnown && action.role !== 'check' && !laneGiven;
    if (enforceRoutingPolicy && evidenceFor.length && action.lane !== 'analyze' && !roleLaneOnWrongEvidence) {
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
    // A digest exists only to condense the outputs of the actions it depends
    // on: with no dependency it has nothing to read, and it never judges a
    // requirement or writes a file. `affects` may be empty — a digest delivers
    // no acceptance slice of its own.
    if (action.kind === 'digest') {
      if (!dependsOn.length) issues.push(`${at} digest actions must depend on at least one action; a digest condenses its dependencies' outputs`);
      if (evidenceFor.length) issues.push(`${at} digest actions must have empty evidenceFor; evidence reads the real artifacts`);
      if (ownedFiles.length) issues.push(`${at} digest actions are read-only and must have empty ownedFiles`);
    }
    if (evidenceFor.length && evidencePromptOwnsOutput(action.prompt)) {
      issues.push(`${at}.prompt must describe inspection scope only; evidence output schema is supplied by the V2 kernel`);
    }
    if (action.kind !== 'digest' && !evidenceFor.length && (ownedFiles.length || (runtime.relaxedGraph === true && ['build', 'chore'].includes(action.lane))) && !affects.length) {
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
    issues.push(field === 'timeoutSec'
      ? `actions[${rawActions.indexOf(action)}].timeoutSec is not allowed in V2; a time limit belongs on an evidence item (evidence[].timeoutSec)`
      : `actions[${rawActions.indexOf(action)}].${field} is not allowed in V2`);
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
    // Evidence reads the real artifacts. A digest is an extractive summary
    // written by another agent, so it can never stand in as proof.
    if (action.evidenceFor.length) for (const dependency of action.dependsOn) {
      if (byId.get(dependency)?.kind === 'digest') issues.push(`evidence action ${action.id} must not depend on digest ${dependency}; evidence reads the real artifacts`);
    }
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
      // A digest reads its dependencies' output files, and its consumer reads
      // the digest's: the data flows through kernel-written artifacts, so
      // neither side needs a declared artifact or an overlapping owned path.
      if (action.kind === 'digest' || dependencyAction.kind === 'digest') continue;
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
  // The one exemption the repair loop needs: a kernel repair affects a
  // requirement and runs after the verify that failed it, so no evidence
  // step has to depend on it (docs/design/step-economy-0.35.2 §3.4).
  const kernelRepairs = new Set(Array.isArray(runtime.kernelRepairActionIds) ? runtime.kernelRepairActionIds : []);
  for (const action of actions) {
    if (action.evidenceFor.length) for (const requirement of action.evidenceFor) {
      for (const work of [...knownActions, ...actions].filter((candidate) => !candidate.evidenceFor.length && candidate.affects.includes(requirement) && !kernelRepairs.has(candidate.id))) {
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
  // `verifyRounds` is returned beside the actions (never folded onto them):
  // the runtime copies it into the run's verify-loop budget.
  return {
    schemaVersion: ACTION_PROGRAM_SCHEMA_VERSION,
    actions: actions.map(clone),
    ...(defaults.verifyRounds !== undefined ? { verifyRounds: defaults.verifyRounds } : {}),
  };
}

export const validateProgram = validateActionProgram;
