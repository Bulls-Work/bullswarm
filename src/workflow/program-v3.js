// Program v3 (0.37.0): validation and normalisation of
// bullswarm.workflow.program.v3, the program built from steps, phases, gates
// and loops.
//
// A v3 program is never squeezed into v2 authoring: v2 programs keep going
// through action-validator.js unchanged. The kernel's dispatch still reads a
// few v2 fields, so the normalised (stored) form of every step carries them,
// derived here and never authored by the caller:
//   purpose    = label, or the id
//   ownedFiles = files
//   role       = "act" for an outward deliverable (absent otherwise)
//   affects    = [the implicit requirement] for build and chore steps and for
//                any step that names files
//   evidenceFor, inputs, produces = []
// The step-level rules v2 already enforces (lanes, efforts, deliverables,
// evidence, routes, exact file paths) are checked by running the derived v2
// action list through validateActionProgram, with every dependency on a gate
// or a loop replaced by the steps behind it. The rules only v3 has (retry,
// answer, label, phase, gates, loops, the one condition form) are checked
// here.
//
// normaliseProgramV3 returns {schemaVersion, steps, gates, loops}; running it
// on its own output returns the same value, so a stored step never reads as
// amended. A run stores it as state.program = {schemaVersion, revision,
// actions: steps, control: {gates, loops}} (storedProgramV3).

import { clone } from '../lib/clone.js';
import {
  ACTION_PROGRAM_SCHEMA_VERSION, DEFAULT_EFFORT_BY_LANE, TIME_BOX_MAX_MINUTES, validateActionProgram,
} from './action-validator.js';
import { deliverableTypeOf } from './step-vocabulary.js';
import { SCHEMA_MAX_SCHEMA_BYTES, schemaSubsetIssues } from './schema-check.js';
import { isReasoningLevel } from '../lib/reasoning.js';
import {
  AREAS_PER_ROUND_MAX, DEFAULT_FLOOR, LOOP_MAX_ROUNDS, NON_FUNCTIONAL_AREA, SEVERITIES, YIELD_DEFAULT, YIELD_MAX_FINDINGS, coverRounds, findingsSchemaIssue, isNonFunctionalArea, titleKey,
} from './dry-loops.js';
// The limits live in dry-loops.js so action-validator.js can read them too.
export { AREAS_PER_ROUND_MAX, LOOP_MAX_ROUNDS };

export const PROGRAM_V3_SCHEMA_VERSION = 'bullswarm.workflow.program.v3';
// The one requirement a v3 goal carries until 0.38.0 removes requirements.
// It is not mandatory, so a v3 run is never reported "not verified": v3
// reports facts per step, never a verified verdict.
const IMPLICIT_REQUIREMENT_ID = 'goal';

const ID_RE = /^[a-z0-9][a-z0-9-]*$/;
const LANES = new Set(['analyze', 'build', 'chore']);
const EFFORTS = new Set(['high', 'medium', 'low']);
const PROGRAM_KEYS = new Set(['schemaVersion', 'defaults', 'steps', 'gates', 'loops']);
const DEFAULT_KEYS = new Set(['lane', 'effort', 'reasoning', 'retry', 'timeBox']);
const STEP_KEYS = new Set([
  'id', 'prompt', 'dependsOn', 'phase', 'label', 'lane', 'effort', 'reasoning', 'model', 'route', 'blindTo',
  'answer', 'evidence', 'deliverable', 'files', 'retry', 'timeBox', 'areas', 'areasPerRound',
]);
// Present in the stored form; accepted on input only with the derived value.
const DERIVED_KEYS = new Set(['purpose', 'ownedFiles', 'affects', 'role', 'evidenceFor', 'inputs', 'produces']);
const V2_ONLY_KEYS = new Set(['kind', 'evidenceFor', 'inputs', 'produces', 'role']);
const DERIVED_FROM = Object.freeze({
  purpose: 'label or id', ownedFiles: 'files', affects: 'the lane and files', role: 'the deliverable',
});
const GATE_KEYS = new Set(['id', 'dependsOn', 'when', 'note']);
const LOOP_KEYS = new Set(['id', 'steps', 'until', 'maxRounds']);
// A dry loop's until ({step, dry}) counts 1 to this many clean rounds in a row.
export const DRY_MAX_ROUNDS = 3;
// A review's areas (0.38.12): how many, how long each, how many reviewers at most.
export const AREAS_MAX = 8;
const AREA_MAX_CHARS = 80;
const LABEL_MAX = 200;
const PHASE_MAX = 80;
const NOTE_MAX = 1000;

class ProgramV3ValidationError extends Error {
  constructor(issues) {
    super(`workflow program v3 invalid: ${issues.length} problem(s)`);
    this.name = 'ProgramV3ValidationError';
    this.issues = [...issues];
  }
}

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const present = (value) => Object.keys(value).filter((key) => value[key] !== undefined);
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);

/** True for a v3 program, or a planner response that wraps one. */
export function isProgramV3(value) {
  return isObject(value) && (value.schemaVersion === PROGRAM_V3_SCHEMA_VERSION
    || (isObject(value.program) && value.program.schemaVersion === PROGRAM_V3_SCHEMA_VERSION));
}

/** True for a stored v3 step: only v3 steps carry `retry` (v2 actions never do). */
export function isV3Step(action) {
  return action?.retry === 0 || action?.retry === 1;
}

/** The requirement list of a v3 goal: one implicit, non-mandatory requirement. */
export function implicitV3Requirements(goal) {
  return [{ id: IMPLICIT_REQUIREMENT_ID, text: String(goal).trim(), mandatory: false }];
}

function oneLine(value, at, max, issues) {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !value.trim() || /[\r\n]/.test(value) || value.length > max) {
    issues.push(`${at} must be one line of 1 to ${max} characters`);
    return undefined;
  }
  return value;
}

function idList(value, at, issues, { nonEmpty = false } = {}) {
  if (value === undefined && !nonEmpty) return [];
  if (!Array.isArray(value) || (nonEmpty && !value.length)) {
    issues.push(`${at} must be ${nonEmpty ? 'a non-empty' : 'an'} array of ids`);
    return [];
  }
  const seen = new Set();
  const out = [];
  for (const [index, item] of value.entries()) {
    if (typeof item !== 'string' || !ID_RE.test(item)) { issues.push(`${at}[${index}] must be a kebab-case id`); continue; }
    if (seen.has(item)) { issues.push(`${at} names "${item}" twice`); continue; }
    seen.add(item);
    out.push(item);
  }
  return out;
}

function readDefaults(raw, issues) {
  if (raw === undefined) return {};
  if (!isObject(raw)) {
    issues.push('program.defaults must be an object');
    return {};
  }
  for (const key of present(raw)) if (!DEFAULT_KEYS.has(key)) {
    issues.push(`program.defaults.${key} is not allowed; defaults take lane, effort, reasoning, retry and timeBox`);
  }
  const defaults = {};
  if (raw.lane !== undefined) {
    if (LANES.has(raw.lane)) defaults.lane = raw.lane;
    else issues.push('program.defaults.lane must be analyze|build|chore');
  }
  if (raw.effort !== undefined) {
    if (EFFORTS.has(raw.effort)) defaults.effort = raw.effort;
    else issues.push('program.defaults.effort must be high|medium|low');
  }
  if (raw.reasoning !== undefined) {
    if (isReasoningLevel(raw.reasoning)) defaults.reasoning = raw.reasoning;
    else issues.push('program.defaults.reasoning must be low|medium|high|xhigh|max|default');
  }
  if (raw.retry !== undefined) {
    if (raw.retry === 0 || raw.retry === 1) defaults.retry = raw.retry;
    else issues.push('program.defaults.retry must be 0 or 1');
  }
  if (raw.timeBox !== undefined) {
    if (Number.isInteger(raw.timeBox) && raw.timeBox >= 0 && raw.timeBox <= TIME_BOX_MAX_MINUTES) defaults.timeBox = raw.timeBox;
    else issues.push(`program.defaults.timeBox must be a whole number of minutes from 0 to ${TIME_BOX_MAX_MINUTES}`);
  }
  return defaults;
}

function readAnswer(raw, at, issues) {
  if (raw === undefined) return undefined;
  if (!isObject(raw)) {
    issues.push(`${at}.answer must be a JSON schema object`);
    return undefined;
  }
  if (Buffer.byteLength(JSON.stringify(raw)) > SCHEMA_MAX_SCHEMA_BYTES) {
    issues.push(`${at}.answer is too large (limit 1 MiB)`);
    return undefined;
  }
  for (const problem of schemaSubsetIssues(raw)) issues.push(`${at}.answer: ${problem.message}`);
  return clone(raw);
}

// The one condition form, for `until` and `when`:
//   {step, field, equals?}  a boolean top-level field of that step's answer
//   {step, evidence: "passed"}  that step's evidence passed
//   {step, dry: n}  loop until only: the review found nothing new for n
//                   rounds (dry-loops.js); step may name an area review group
function readCondition(raw, at, issues, stepsById, { groups = new Map(), loop = false, loopSteps = [] } = {}) {
  if (!isObject(raw)) {
    issues.push(`${at} must be {step, field, equals?} or {step, evidence: "passed"}${loop ? ' or {step, dry}' : ''}`);
    return undefined;
  }
  if (raw.dry !== undefined) return readDryCondition(raw, at, issues, stepsById, { groups, loop, loopSteps });
  const byEvidence = raw.evidence !== undefined;
  const allowed = byEvidence ? ['step', 'evidence'] : ['step', 'field', 'equals'];
  for (const key of present(raw)) if (!allowed.includes(key)) issues.push(`${at}.${key} is not allowed`);
  if (groups.has(raw.step)) {
    issues.push(`${at}: ${raw.step} is a group of area reviewers; only a loop's until may name it, in the dry form`);
    return undefined;
  }
  const step = stepsById.get(raw.step);
  if (!step) {
    issues.push(`${at}.step must name a step`);
    return undefined;
  }
  if (byEvidence) {
    if (raw.evidence !== 'passed') issues.push(`${at}.evidence must be "passed"`);
    if (!Array.isArray(step.raw.evidence) || !step.raw.evidence.length) issues.push(`${at}: step ${raw.step} declares no evidence`);
    return { step: raw.step, evidence: 'passed' };
  }
  if (typeof raw.field !== 'string' || !raw.field) {
    issues.push(`${at}.field must name a top-level field of step ${raw.step}'s answer`);
    return undefined;
  }
  // The field must be in every valid answer: an object-rooted schema that
  // lists it in `required`, so a condition never reads a missing value.
  if (isObject(step.answer) && step.answer.type !== 'object') {
    issues.push(`${at}: the answer schema of step ${raw.step} must have type "object"`);
  }
  const property = isObject(step.answer?.properties) ? step.answer.properties[raw.field] : undefined;
  if (!isObject(property) || property.type !== 'boolean') {
    issues.push(`${at}.field "${raw.field}" must be a boolean in the answer schema of step ${raw.step}`);
  } else if (!Array.isArray(step.answer.required) || !step.answer.required.includes(raw.field)) {
    issues.push(`${at}.field "${raw.field}" must be listed in the required fields of step ${raw.step}'s answer schema`);
  }
  if (raw.equals !== undefined && typeof raw.equals !== 'boolean') issues.push(`${at}.equals must be true or false`);
  return { step: raw.step, field: raw.field, equals: raw.equals === false ? false : true };
}

// A dry loop's yield stop (dry-loops.js YIELD_DEFAULT): false turns it off;
// {max, rounds} changes it. Undefined: the default applies.
function readYield(value, at, issues) {
  if (value === undefined) return undefined;
  if (value === false) return false;
  if (!isObject(value)) {
    issues.push(`${at} must be false or {max, rounds} (default max ${YIELD_DEFAULT.max}, rounds ${YIELD_DEFAULT.rounds}): the loop also ends after <rounds> rounds in a row that each found at most <max>`);
    return undefined;
  }
  for (const key of Object.keys(value)) if (!['max', 'rounds'].includes(key)) issues.push(`${at}.${key} is not allowed`);
  if (value.max !== undefined && !(Number.isInteger(value.max) && value.max >= 0 && value.max <= YIELD_MAX_FINDINGS)) issues.push(`${at}.max must be a whole number from 0 to ${YIELD_MAX_FINDINGS}`);
  if (value.rounds !== undefined && !(Number.isInteger(value.rounds) && value.rounds >= 2 && value.rounds <= LOOP_MAX_ROUNDS)) issues.push(`${at}.rounds must be a whole number from 2 to ${LOOP_MAX_ROUNDS}`);
  return { ...(value.max !== undefined ? { max: value.max } : {}), ...(value.rounds !== undefined ? { rounds: value.rounds } : {}) };
}

// The dry form {step, dry}: a loop's until only, on a review (or an area
// review group) whose answer lists findings [{title, inScope, …}].
function readDryCondition(raw, at, issues, stepsById, { groups, loop, loopSteps }) {
  for (const key of present(raw)) if (!['step', 'dry', 'floor', 'nonFunctional', 'yield'].includes(key)) issues.push(`${at}.${key} is not allowed`);
  const yieldRule = readYield(raw.yield, `${at}.yield`, issues);
  if (raw.nonFunctional !== undefined && raw.nonFunctional !== false) {
    issues.push(`${at}.nonFunctional may only be false (the review then stays on correctness: no non-functional area is added and a single reviewer is not asked about performance, structure or tests)`);
  }
  if (raw.floor !== undefined && !SEVERITIES.includes(raw.floor)) {
    issues.push(`${at}.floor must be ${SEVERITIES.join(', ')} (the least severity that keeps the loop going; default ${DEFAULT_FLOOR})`);
  }
  if (!loop) {
    issues.push(`${at}: the dry form ({step, dry}) is for a loop's until only`);
    return undefined;
  }
  const group = groups.get(raw.step);
  const step = group ? stepsById.get(group.ids[0]) : stepsById.get(raw.step);
  if (!step) {
    issues.push(`${at}.step must name a step`);
    return undefined;
  }
  if (!(Number.isInteger(raw.dry) && raw.dry >= 1 && raw.dry <= DRY_MAX_ROUNDS)) {
    issues.push(`${at}.dry must be a whole number from 1 to ${DRY_MAX_ROUNDS}`);
    return undefined;
  }
  // A loop with a fix step tells its reviews to mark a known finding still
  // present with stillOpen, so their answers must be allowed to carry it.
  const members = group ? group.ids : [raw.step];
  const problem = findingsSchemaIssue(step.answer, { stillOpen: loopSteps.some((id) => !members.includes(id)) });
  if (problem) issues.push(`${at}: the answer schema of step ${raw.step} ${problem}`);
  return {
    step: raw.step, dry: raw.dry, ...(SEVERITIES.includes(raw.floor) ? { floor: raw.floor } : {}),
    ...(raw.nonFunctional === false ? { nonFunctional: false } : {}),
    ...(yieldRule !== undefined ? { yield: yieldRule } : {}),
  };
}

const cutLabel = (text) => ([...text].length > LABEL_MAX ? `${[...text].slice(0, LABEL_MAX - 1).join('')}…` : text);
const withoutKeys = (raw, keys) => Object.fromEntries(Object.entries(raw).filter(([key]) => !keys.includes(key)));

function readAreas(value, at, issues) {
  if (!Array.isArray(value) || !value.length || value.length > AREAS_MAX) {
    issues.push(`${at}.areas must be an array of 1 to ${AREAS_MAX} areas`);
    return null;
  }
  const bad = value.findIndex((area) => typeof area !== 'string' || !area.trim() || /[\r\n]/.test(area) || area.length > AREA_MAX_CHARS);
  if (bad !== -1) {
    issues.push(`${at}.areas[${bad}] must be one line of 1 to ${AREA_MAX_CHARS} characters`);
    return null;
  }
  // Two areas that differ only in case or spacing are the same angle.
  if (new Set(value.map(titleKey)).size !== value.length) {
    issues.push(`${at}.areas names an area twice`);
    return null;
  }
  return [...value];
}

// A step's id lists with a review group's id replaced by its reviewer ids.
function rewriteGroupIds(raw, groups) {
  if (!isObject(raw) || !groups.size) return raw;
  const swap = (list) => (Array.isArray(list) ? list.flatMap((id) => (groups.has(id) ? groups.get(id).ids : [id])) : list);
  const out = { ...raw };
  if (Array.isArray(raw.dependsOn)) out.dependsOn = swap(raw.dependsOn);
  if (Array.isArray(raw.blindTo)) out.blindTo = swap(raw.blindTo);
  if (isObject(raw.route) && Array.isArray(raw.route.independentOf)) out.route = { ...raw.route, independentOf: swap(raw.route.independentOf) };
  return out;
}

/**
 * The area pre-pass (0.38.12): a review step with `areas` becomes
 * `areasPerRound` ordinary steps <id>-area-1 … <id>-area-P, each carrying the
 * derived `areaOf: {step, slot, areas}`, in the review's place. Every
 * dependsOn, blindTo, route.independentOf, loop steps and gate dependsOn entry
 * naming the review is rewritten to the reviewer ids; the review's id stays
 * as the group id a dry loop's until names. A step that already carries
 * areaOf (a stored program) is not expanded again: its group is checked to be
 * whole and alike, so the stored form normalises to itself.
 * Returns {entries: [{raw, index}], groups, loops, gates}.
 */
function expandAreas(rawSteps, rawLoops, rawGates, issues) {
  const groups = new Map();
  const entries = [];
  const stored = new Map();
  for (const [index, raw] of rawSteps.entries()) {
    const at = `steps[${index}]`;
    if (!isObject(raw)) { entries.push({ raw, index }); continue; }
    if (raw.areaOf !== undefined) {
      if (raw.areas !== undefined || raw.areasPerRound !== undefined) issues.push(`${at} is one area reviewer (areaOf); remove areas and areasPerRound`);
      const of = raw.areaOf;
      if (!isObject(of) || typeof of.step !== 'string' || !ID_RE.test(of.step) || !Number.isInteger(of.slot) || of.slot < 1
        || !Array.isArray(of.areas) || !of.areas.length || of.areas.some((area) => typeof area !== 'string')) {
        issues.push(`${at}.areaOf is derived from a review's areas in v3; remove it`);
        entries.push({ raw: withoutKeys(raw, ['areaOf', 'areas', 'areasPerRound']), index });
        continue;
      }
      if (!stored.has(of.step)) stored.set(of.step, []);
      stored.get(of.step).push({ raw, index });
      entries.push({ raw, index });
      continue;
    }
    if (raw.areas === undefined) {
      if (raw.areasPerRound !== undefined) issues.push(`${at}.areasPerRound needs areas`);
      entries.push({ raw: withoutKeys(raw, ['areasPerRound']), index });
      continue;
    }
    const named = readAreas(raw.areas, at, issues);
    if (!named || typeof raw.id !== 'string' || !ID_RE.test(raw.id)) {
      entries.push({ raw: withoutKeys(raw, ['areas', 'areasPerRound']), index });
      continue;
    }
    // 0.38.15: a review's areas always include one past correctness; when the
    // author named none, NON_FUNCTIONAL_AREA is added (dry-loops.js), and the
    // rotation puts one in every round (roundAreas).
    const optedOut = rawLoops.some((loop) => isObject(loop?.until) && loop.until.step === raw.id && loop.until.nonFunctional === false);
    const added = !optedOut && !named.some(isNonFunctionalArea) && named.length < AREAS_MAX;
    const areas = added ? [...named, NON_FUNCTIONAL_AREA] : named;
    const most = Math.min(areas.length, AREAS_PER_ROUND_MAX);
    let perRound = raw.areasPerRound ?? Math.min(areas.length, 3);
    if (!(Number.isInteger(perRound) && perRound >= 1 && perRound <= most)) {
      issues.push(`${at}.areasPerRound must be a whole number from 1 to ${most} (the number of areas, at most ${AREAS_PER_ROUND_MAX})`);
      perRound = Math.min(areas.length, 3);
    }
    const base = withoutKeys(raw, ['areas', 'areasPerRound', 'label']);
    const name = typeof raw.label === 'string' ? raw.label : raw.id;
    const ids = [];
    for (let slot = 1; slot <= perRound; slot += 1) {
      const id = `${raw.id}-area-${slot}`;
      ids.push(id);
      const label = cutLabel(perRound === areas.length ? `${name} · ${areas[slot - 1]}` : `${name} · area reviewer ${slot} of ${perRound}`);
      entries.push({ raw: { ...clone(base), id, label, areaOf: { step: raw.id, slot, areas: [...areas] } }, index });
    }
    groups.set(raw.id, { ids, areas, perRound, index, label: raw.label, ...(added ? { addedArea: NON_FUNCTIONAL_AREA } : {}) });
  }
  // A stored group: every slot once, the same areas, and the same step but for
  // its id, label and slot.
  for (const [step, members] of stored) {
    const sorted = [...members].sort((a, b) => a.raw.areaOf.slot - b.raw.areaOf.slot);
    const first = sorted[0].raw;
    const at = `steps[${sorted[0].index}]`;
    const alike = (raw) => same(withoutKeys(raw, ['id', 'label', 'areaOf', 'purpose']), withoutKeys(first, ['id', 'label', 'areaOf', 'purpose']));
    const whole = sorted.every((member, k) => member.raw.areaOf.slot === k + 1 && member.raw.id === `${step}-area-${k + 1}`
      && same(member.raw.areaOf.areas, first.areaOf.areas));
    if (!whole) issues.push(`${at}.areaOf: the area reviewers of ${step} must be ${step}-area-1 to ${step}-area-${sorted.length}, one per slot, with the same areas`);
    else if (!sorted.every((member) => alike(member.raw))) issues.push(`${at}: the area reviewers of ${step} must be the same step but for their id and label; one was changed`);
    if (sorted.length > Math.min(first.areaOf.areas.length, AREAS_PER_ROUND_MAX)) issues.push(`${at}.areaOf: ${step} has more area reviewers than areas`);
    groups.set(step, { ids: sorted.map((member) => member.raw.id), areas: [...first.areaOf.areas], perRound: sorted.length, index: sorted[0].index, stored: true });
  }
  const swap = (list) => (Array.isArray(list) ? list.flatMap((id) => (groups.has(id) ? groups.get(id).ids : [id])) : list);
  return {
    entries: entries.map((entry) => ({ ...entry, raw: rewriteGroupIds(entry.raw, groups) })),
    groups,
    loops: rawLoops.map((raw) => (isObject(raw) && Array.isArray(raw.steps) ? { ...raw, steps: swap(raw.steps) } : raw)),
    gates: rawGates.map((raw) => (isObject(raw) && Array.isArray(raw.dependsOn) ? { ...raw, dependsOn: swap(raw.dependsOn) } : raw)),
  };
}

// v2 issues speak of actions[i], ownedFiles, roles and check steps with
// evidenceFor; a v3 author wrote steps[i] and files, and declared no role.
// An act-role issue is dropped: the outward-deliverable issue beside it
// already says the same in v3 words.
const ACT_LANE = / act steps use lane analyze; they do not write workspace files$/;
// An outward step with files trips both the act rule and the analyze-lane
// rule (its lane is derived); the author set no lane, so only the first speaks.
const ACT_FILES = /^actions\[(\d+)\] act steps must have empty ownedFiles and evidenceFor$/;
const ANALYZE_FILES = /^actions\[(\d+)\] analyze actions must not own workspace files; use build or chore for mutations$/;

/** v2 validation issues in v3 words, each step blamed once. */
export function v3IssuesWording(issues) {
  const outwardWithFiles = new Set(issues.map((issue) => ACT_FILES.exec(String(issue))?.[1]).filter(Boolean));
  return issues
    .filter((issue) => !outwardWithFiles.has(ANALYZE_FILES.exec(String(issue))?.[1]))
    .map(v3IssueWording)
    .filter(Boolean);
}

/** One v2 issue or advisory message in v3 words, or null when it only repeats another. */
export function v3IssueWording(issue) {
  const text = String(issue);
  if (ACT_LANE.test(text)) return null;
  return text
    .replace(/ act steps must have empty ownedFiles and evidenceFor$/, ' an outward step must have empty files; it does not write workspace files')
    .replace(/ analyze actions must not own workspace files; use build or chore for mutations$/, ' analyze steps must have empty files; use lane build or chore for a step that writes files')
    .replace(/^actions\[(\d+)\]/, 'steps[$1]')
    .replace(/\.ownedFiles\b/g, '.files')
    .replace(/ ownedFiles\b/g, ' files')
    .replace(/ chore actions are /, ' chore steps are ')
    .replace(/ build\/chore actions run /, ' build/chore steps run ')
    .replace(/; review evidence is a check step with evidenceFor, and a choice is recorded by the caller$/, '; a check is an ordinary step with an answer and/or evidence');
}

/**
 * Validate a v3 program (authored or stored) and return its normalised form
 * {schemaVersion, steps, gates, loops}. Throws an error with `issues` when it
 * is invalid. `runtime` is the v2 validation runtime of the run (requirements,
 * workspace mutation, evidenceAllowed, ...); it defaults to a stand-alone
 * program-mode check against the implicit requirement.
 */
export function normaliseProgramV3(input, runtime = {}) {
  const issues = [];
  if (!isObject(input)) throw new ProgramV3ValidationError(['program must be an object']);
  const program = authoredShape(input);
  for (const key of present(program)) if (!PROGRAM_KEYS.has(key)) {
    issues.push(`program.${key} is not allowed; a v3 program has schemaVersion, defaults, steps, gates and loops`);
  }
  if (program.schemaVersion !== PROGRAM_V3_SCHEMA_VERSION) issues.push(`schemaVersion must be "${PROGRAM_V3_SCHEMA_VERSION}"`);
  const defaults = readDefaults(program.defaults, issues);
  if (!Array.isArray(program.steps) || !program.steps.length) issues.push('steps must be a non-empty array');
  const listOf = (name) => {
    if (program[name] === undefined) return [];
    if (!Array.isArray(program[name])) { issues.push(`${name} must be an array`); return []; }
    return program[name];
  };
  // A review's areas become its area reviewers before any other check.
  const expanded = expandAreas(Array.isArray(program.steps) ? program.steps : [], listOf('loops'), listOf('gates'), issues);
  const { groups } = expanded;
  const rawGates = expanded.gates;
  const rawLoops = expanded.loops;
  const reviewerOf = new Map([...groups].flatMap(([id, group]) => group.ids.map((reviewer) => [reviewer, id])));
  const requirementId = runtime.requirementId
    ?? (Array.isArray(runtime.requirements) && typeof runtime.requirements[0]?.id === 'string' ? runtime.requirements[0].id : IMPLICIT_REQUIREMENT_ID);

  // One id space for steps, gates and loops.
  const kindOf = new Map();
  const claim = (id, kind) => {
    if (typeof id !== 'string' || !ID_RE.test(id)) return false;
    if (kindOf.has(id)) {
      const group = reviewerOf.get(id);
      const named = group ? ` (${group}'s areas use ${groups.get(group).ids[0]} to ${groups.get(group).ids.at(-1)})` : '';
      issues.push(`id "${id}" is used twice; steps, gates and loops share one id space${named}`);
      return false;
    }
    kindOf.set(id, kind);
    return true;
  };

  // Steps: the v3 fields, and the derived v2 action dispatch reads.
  const steps = expanded.entries.map(({ raw, index }) => {
    const at = `steps[${index}]`;
    if (!isObject(raw)) { issues.push(`${at} must be an object`); return null; }
    for (const key of present(raw)) {
      if (STEP_KEYS.has(key) || DERIVED_KEYS.has(key) || key === 'areaOf') continue;
      issues.push(V2_ONLY_KEYS.has(key) ? `${at}.${key} is not a v3 field` : `${at}.${key} is not allowed`);
    }
    if (typeof raw.id !== 'string' || !ID_RE.test(raw.id)) issues.push(`${at}.id must be a kebab-case id`);
    claim(raw.id, 'step');
    const label = oneLine(raw.label, `${at}.label`, LABEL_MAX, issues);
    const phase = oneLine(raw.phase, `${at}.phase`, PHASE_MAX, issues);
    const lane = raw.lane ?? defaults.lane ?? 'analyze';
    const effort = raw.effort ?? defaults.effort ?? (LANES.has(lane) ? DEFAULT_EFFORT_BY_LANE[lane] : undefined);
    const reasoning = raw.reasoning ?? defaults.reasoning;
    const timeBox = raw.timeBox ?? defaults.timeBox;
    const retry = raw.retry ?? defaults.retry ?? 1;
    if (retry !== 0 && retry !== 1) issues.push(`${at}.retry must be 0 or 1`);
    const answer = readAnswer(raw.answer, at, issues);
    const files = raw.files ?? [];
    const writes = lane === 'build' || lane === 'chore';
    let deliverable = raw.deliverable;
    if (deliverable === undefined) {
      if (writes) deliverable = { type: 'files' };
      else if (answer === undefined) deliverable = { type: 'report' };
    }
    const role = deliverableTypeOf(deliverable) === 'outward' ? 'act' : undefined;
    const affects = writes || (Array.isArray(files) && files.length) ? [requirementId] : [];
    const dependsOn = idList(raw.dependsOn, `${at}.dependsOn`, issues);
    return {
      index, raw, id: raw.id, label, phase, lane, effort, reasoning, timeBox, retry, answer, files,
      deliverable, role, affects, dependsOn, purpose: label ?? (typeof raw.id === 'string' ? raw.id : ''),
    };
  });
  const stepsById = new Map(steps.filter(Boolean).map((step) => [step.id, step]));
  // A review group's id is claimed too: a dry loop's until names it.
  for (const id of groups.keys()) claim(id, 'group');

  // Gates and loops.
  const gates = rawGates.map((raw, index) => {
    const at = `gates[${index}]`;
    if (!isObject(raw)) { issues.push(`${at} must be an object`); return null; }
    for (const key of present(raw)) if (!GATE_KEYS.has(key)) issues.push(`${at}.${key} is not allowed; a gate has id, dependsOn, when and note`);
    if (typeof raw.id !== 'string' || !ID_RE.test(raw.id)) issues.push(`${at}.id must be a kebab-case id`);
    claim(raw.id, 'gate');
    return { index, raw, id: raw.id, dependsOn: idList(raw.dependsOn, `${at}.dependsOn`, issues), note: oneLine(raw.note, `${at}.note`, NOTE_MAX, issues) };
  });
  const loopOfStep = new Map();
  const loops = rawLoops.map((raw, index) => {
    const at = `loops[${index}]`;
    if (!isObject(raw)) { issues.push(`${at} must be an object`); return null; }
    for (const key of present(raw)) if (!LOOP_KEYS.has(key)) issues.push(`${at}.${key} is not allowed; a loop has id, steps, until and maxRounds`);
    if (typeof raw.id !== 'string' || !ID_RE.test(raw.id)) issues.push(`${at}.id must be a kebab-case id`);
    claim(raw.id, 'loop');
    const body = idList(raw.steps, `${at}.steps`, issues, { nonEmpty: true });
    for (const id of body) {
      if (!stepsById.has(id)) issues.push(`${at}.steps names "${id}", which is not a step`);
      else if (loopOfStep.has(id)) issues.push(`step ${id} is in two loops (${loopOfStep.get(id)} and ${raw.id}); a step belongs to at most one loop`);
      else loopOfStep.set(id, raw.id);
    }
    if (!(Number.isInteger(raw.maxRounds) && raw.maxRounds >= 1 && raw.maxRounds <= LOOP_MAX_ROUNDS)) {
      issues.push(`${at}.maxRounds must be a whole number from 1 to ${LOOP_MAX_ROUNDS}`);
    }
    return { index, raw, id: raw.id, steps: body, maxRounds: raw.maxRounds };
  });
  const gatesById = new Map(gates.filter(Boolean).map((gate) => [gate.id, gate]));
  const loopsById = new Map(loops.filter(Boolean).map((loop) => [loop.id, loop]));

  // The graph: a step or a gate depends on its dependsOn; a loop on its steps.
  const depsOf = (id) => (stepsById.get(id)?.dependsOn ?? gatesById.get(id)?.dependsOn ?? loopsById.get(id)?.steps ?? []);
  for (const node of [...steps, ...gates].filter(Boolean)) {
    for (const dep of node.dependsOn) {
      if (dep === node.id) { issues.push(`${node.id} cannot depend on itself (a cycle)`); continue; }
      if (!kindOf.has(dep)) { issues.push(`${node.id}.dependsOn references unknown step, gate or loop "${dep}"`); continue; }
      const loop = loopOfStep.get(dep);
      if (loop && loopOfStep.get(node.id) !== loop) {
        const named = reviewerOf.get(dep) ?? dep;
        const who = reviewerOf.get(node.id) ?? node.id;
        issues.push(`${who} depends on ${named} inside loop ${loop}; depend on the loop ${loop} instead`);
      }
    }
  }
  // A step that depends on an area reviewer depends on its whole group: the
  // round is merged only once every reviewer answered, and a step that started
  // after one of them would run before the loop decided whether it runs.
  for (const node of [...steps, ...gates].filter(Boolean)) {
    const partial = [...new Set(node.dependsOn.map((dep) => reviewerOf.get(dep)).filter(Boolean))]
      .filter((group) => !groups.get(group).ids.every((id) => node.dependsOn.includes(id)));
    for (const group of partial) {
      const who = reviewerOf.get(node.id) ?? node.id;
      const { ids } = groups.get(group);
      issues.push(`${who} depends on some of ${group}'s area reviewers; depend on ${group} itself (all of ${ids[0]} to ${ids.at(-1)})`);
    }
  }
  const visiting = new Set();
  const done = new Set();
  let cyclic = false;
  const visit = (id) => {
    if (done.has(id) || cyclic) return;
    if (visiting.has(id)) { cyclic = true; return; }
    visiting.add(id);
    for (const dep of depsOf(id)) if (kindOf.has(dep) && dep !== id) visit(dep);
    visiting.delete(id);
    done.add(id);
  };
  for (const id of kindOf.keys()) visit(id);
  if (cyclic) issues.push('the dependency graph contains a cycle (through steps, gates and loops)');
  // Every step, gate or loop that must finish before `id` starts.
  const ancestors = (id) => {
    const seen = new Set();
    const walk = (node) => { for (const dep of depsOf(node)) if (kindOf.has(dep) && !seen.has(dep)) { seen.add(dep); walk(dep); } };
    if (!cyclic) walk(id);
    return seen;
  };
  // A dependency on a gate or a loop stands for the steps behind it.
  const expand = (id, seen = new Set()) => {
    if (seen.has(id)) return [];
    seen.add(id);
    if (stepsById.has(id)) return [id];
    return depsOf(id).flatMap((dep) => expand(dep, seen));
  };

  const normalGates = gates.filter(Boolean).map((gate) => {
    const when = gate.raw.when === undefined ? undefined : readCondition(gate.raw.when, `gates[${gate.index}].when`, issues, stepsById, { groups });
    if (when && !ancestors(gate.id).has(when.step)) issues.push(`gates[${gate.index}].when.step must run before gate ${gate.id}; ${when.step} is not one of its dependencies`);
    return { id: gate.id, dependsOn: gate.dependsOn, ...(when ? { when } : {}), ...(gate.note !== undefined ? { note: gate.note } : {}) };
  });
  const normalLoops = loops.filter(Boolean).map((loop) => {
    const at = `loops[${loop.index}]`;
    const until = readCondition(loop.raw.until, `${at}.until`, issues, stepsById, { groups, loop: true, loopSteps: loop.steps });
    // A group id counts as the loop's step when all its reviewers are.
    const members = until ? groups.get(until.step)?.ids ?? [until.step] : [];
    const missing = members.filter((id) => !loop.steps.includes(id));
    if (until && missing.length === members.length) {
      const shown = loop.steps.map((id) => reviewerOf.get(id) ?? id).filter((id, index, list) => list.indexOf(id) === index);
      issues.push(`${at}.until.step must be one of the loop's steps (${shown.join(', ')})`);
    } else if (until && missing.length) {
      // Some of the group's reviewers are in the loop and some are not.
      issues.push(`${at}.steps must list every area reviewer of ${until.step} (${members[0]} to ${members.at(-1)}); it leaves out ${missing.join(', ')}. List ${until.step} itself to include them all`);
    }
    if (until?.dry !== undefined && Number.isInteger(loop.maxRounds) && until.dry > loop.maxRounds) {
      issues.push(`${at}.until.dry is ${until.dry} but maxRounds is ${loop.maxRounds}; the loop could never end dry`);
    } else if (until?.dry !== undefined && Number.isInteger(loop.maxRounds) && groups.has(until.step)) {
      // Dry needs every area reviewed after the last finding: with N areas and
      // P reviewers a round, that takes ceil(N / P) rounds even when no round
      // ever finds anything.
      const { areas, perRound } = groups.get(until.step);
      const cover = coverRounds(areas, perRound);
      if (cover > loop.maxRounds) {
        // The fewest reviewers a round that cover every area in maxRounds.
        const most = Math.min(areas.length, AREAS_PER_ROUND_MAX);
        const enough = Array.from({ length: most }, (_, k) => k + 1).find((p) => p > perRound && coverRounds(areas, p) <= loop.maxRounds);
        const fix = [
          ...(cover <= LOOP_MAX_ROUNDS ? [`raise maxRounds to ${cover}`] : []),
          ...(enough ? [`raise areasPerRound to ${enough}`] : []),
          'name fewer areas',
        ];
        issues.push(`${at}: ${until.step}'s ${areas.length} areas take ${cover} rounds to review at ${perRound} per round, but maxRounds is ${loop.maxRounds}; the loop could never end dry. ${fix.join(', or ').replace(/^./, (c) => c.toUpperCase())}`);
      }
    }
    return { id: loop.id, steps: loop.steps, ...(until ? { until } : {}), maxRounds: loop.maxRounds };
  });
  // Areas belong to the review a dry loop's until names: an analyze step that
  // writes nothing, since its reviewers run side by side.
  for (const [id, group] of groups) {
    const at = `steps[${group.index}]`;
    const loop = loops.find((entry) => isObject(entry?.raw.until) && entry.raw.until.dry !== undefined && entry.raw.until.step === id);
    if (!loop) issues.push(`${at}.areas: ${id} is not the until step of a loop that ends dry ({"step": "${id}", "dry": 1}); areas are only for that review`);
    const first = stepsById.get(group.ids[0]);
    if (first && first.lane !== 'analyze') issues.push(`${at}.areas: an area review must be lane analyze; its reviewers run side by side and change no file`);
    else if (first?.role === 'act') issues.push(`${at}.areas: an area review cannot have an outward deliverable`);
  }

  // A dry loop's reviewer is never handed the account of a fix step that runs
  // after it (dry-loops.js), so such a step in its blindTo is refused with
  // that reason, not with the generic "add it to dependsOn" (which would make
  // a cycle). Reviewer id -> the loop's steps that depend on its review.
  const laterFixers = new Map();
  for (const loop of loops.filter((entry) => entry && isObject(entry.raw.until) && entry.raw.until.dry !== undefined)) {
    const members = groups.get(loop.raw.until.step)?.ids ?? [loop.raw.until.step];
    const reaches = (id, seen = new Set()) => (stepsById.get(id)?.dependsOn ?? []).some((dep) => {
      if (members.includes(dep)) return true;
      if (seen.has(dep) || !loop.steps.includes(dep)) return false;
      seen.add(dep);
      return reaches(dep, seen);
    });
    const after = loop.steps.filter((id) => !members.includes(id) && reaches(id));
    for (const id of members) laterFixers.set(id, { loop: loop.id, after });
  }
  // The step-level rules v2 already has, on the derived action list.
  const live = steps.filter(Boolean);
  const mapped = live.map((step) => {
    const action = {
      id: step.id, purpose: step.purpose, prompt: step.raw.prompt,
      dependsOn: [...new Set(step.dependsOn.filter((dep) => kindOf.has(dep) && dep !== step.id).flatMap((dep) => expand(dep)))],
      affects: step.affects, ownedFiles: step.files, evidenceFor: [], lane: step.lane, effort: step.effort,
    };
    if (step.reasoning !== undefined) action.reasoning = step.reasoning;
    if (step.raw.model !== undefined) action.model = step.raw.model;
    if (step.timeBox !== undefined) action.timeBox = step.timeBox;
    if (step.role !== undefined) action.role = step.role;
    if (step.deliverable !== undefined) action.deliverable = step.deliverable;
    if (step.raw.evidence !== undefined) action.evidence = step.raw.evidence;
    if (step.raw.route !== undefined) action.route = step.raw.route;
    if (step.raw.blindTo !== undefined) {
      const later = laterFixers.get(step.id);
      const named = Array.isArray(step.raw.blindTo) && later ? step.raw.blindTo.filter((id) => later.after.includes(id)) : [];
      for (const id of [...new Set(named)]) {
        issues.push(`steps[${step.index}].blindTo names "${id}", which runs after ${reviewerOf.get(step.id) ?? step.id} in loop ${later.loop}; a review of a loop that ends dry is never handed a fix step's output or answer, so remove ${id} from blindTo (keep the steps outside the loop that wrote the work)`);
      }
      action.blindTo = named.length ? step.raw.blindTo.filter((id) => !named.includes(id)) : step.raw.blindTo;
    }
    return action;
  });
  let checked = null;
  if (mapped.length) {
    try {
      checked = validateActionProgram({ schemaVersion: ACTION_PROGRAM_SCHEMA_VERSION, actions: mapped }, {
        relaxedGraph: true, requireMandatoryEvidence: false, enforceMaxActions: false, enforceMaxParallel: false,
        ...runtime,
        allowStepModel: true,
        allowBlindTo: true,
        requirements: Array.isArray(runtime.requirements) ? runtime.requirements : [{ id: requirementId, mandatory: false }],
      });
    } catch (error) {
      // actions[i] is the i-th live step; name the step the caller wrote.
      issues.push(...v3IssuesWording(Array.isArray(error?.issues) ? error.issues : [error.message])
        .map((issue) => issue.replace(/^steps\[(\d+)\]/, (match, index) => `steps[${live[Number(index)]?.index ?? index}]`)));
    }
  }

  const normalSteps = live.map((step, index) => {
    const action = checked?.actions[index] ?? null;
    const at = `steps[${step.index}]`;
    // What the stored form carries beside the v3 fields; an input may repeat
    // it only with exactly this value.
    const derived = {
      purpose: step.purpose, ownedFiles: action?.ownedFiles ?? step.files, affects: step.affects,
      role: step.role, evidenceFor: [], inputs: [], produces: [],
    };
    for (const key of DERIVED_KEYS) {
      if (step.raw[key] === undefined || same(step.raw[key], derived[key])) continue;
      issues.push(V2_ONLY_KEYS.has(key) && !(key === 'role' && step.role)
        ? `${at}.${key} is not a v3 field`
        : `${at}.${key} is derived from ${DERIVED_FROM[key]} in v3; remove it`);
    }
    if (!action) return null;
    const out = { id: step.id };
    if (step.label !== undefined) out.label = step.label;
    if (step.phase !== undefined) out.phase = step.phase;
    out.purpose = step.purpose;
    out.prompt = action.prompt;
    out.dependsOn = [...step.dependsOn];
    out.lane = action.lane;
    out.effort = action.effort;
    if (action.reasoning !== undefined) out.reasoning = action.reasoning;
    if (action.model !== undefined) out.model = action.model;
    if (action.timeBox !== undefined) out.timeBox = action.timeBox;
    out.retry = step.retry;
    out.files = [...action.ownedFiles];
    out.ownedFiles = [...action.ownedFiles];
    out.affects = [...action.affects];
    if (action.role !== undefined) out.role = action.role;
    if (action.deliverable !== undefined) out.deliverable = clone(action.deliverable);
    if (action.evidence !== undefined) out.evidence = clone(action.evidence);
    if (action.route !== undefined) out.route = clone(action.route);
    if (action.blindTo !== undefined) out.blindTo = [...action.blindTo];
    if (step.answer !== undefined) out.answer = step.answer;
    if (step.raw.areaOf !== undefined) out.areaOf = clone(step.raw.areaOf);
    out.evidenceFor = [];
    out.inputs = [];
    out.produces = [];
    return out;
  });

  if (issues.length) throw new ProgramV3ValidationError([...new Set(issues)]);
  return { schemaVersion: PROGRAM_V3_SCHEMA_VERSION, steps: normalSteps, gates: normalGates, loops: normalLoops };
}

// The stored shape {schemaVersion, actions, control: {gates, loops}} (what a
// run keeps, and what an accepted planner response carries) reads as the
// authored one, so accepting an accepted program changes nothing.
function authoredShape(program) {
  if (program.steps !== undefined || !Array.isArray(program.actions)) return program;
  const { actions, control, ...rest } = program;
  const shaped = { ...rest, steps: actions };
  if (control === undefined) return shaped;
  if (!isObject(control)) return { ...shaped, control };
  const { gates, loops, ...others } = control;
  return { ...shaped, ...(gates !== undefined ? { gates } : {}), ...(loops !== undefined ? { loops } : {}), ...(Object.keys(others).length ? { control: others } : {}) };
}

/** The program a run stores: actions are the normalised steps, control holds gates and loops. */
export function storedProgramV3(program, runtime = {}) {
  const normal = normaliseProgramV3(program, runtime);
  return { schemaVersion: PROGRAM_V3_SCHEMA_VERSION, actions: normal.steps, control: { gates: normal.gates, loops: normal.loops } };
}

/** Check a stored state.program ({schemaVersion, revision, actions, control}); throws with `issues`. */
export function validateStoredProgramV3(program, runtime = {}) {
  if (!isObject(program.control)) throw new ProgramV3ValidationError(['control must be an object {gates, loops}']);
  const { revision, ...stored } = program;
  return normaliseProgramV3(stored, runtime);
}

/**
 * Why a run cannot take a v3 program, or [] when it can: v3 is authored by
 * the caller, runs in program mode, starts a run (it is never appended to a
 * v2 plan), and needs the goal's one implicit requirement.
 */
export function programV3AcceptanceIssues({ callerMode, programMode, hasActions, requirements }) {
  const issues = [];
  if (!programMode || !callerMode) issues.push('a v3 program is authored by the caller of a program-mode run (workflow goal --program)');
  if (hasActions) issues.push('a v3 program starts a run; it cannot be added to a plan that already has steps');
  const implicit = Array.isArray(requirements) && requirements.length === 1
    && requirements[0].id === IMPLICIT_REQUIREMENT_ID && requirements[0].mandatory === false;
  if (!implicit) issues.push('a v3 program needs a run started with a v3 program: its goal carries one implicit requirement');
  return issues;
}

/** What `workflow plan validate` adds for a v3 program: its gates and loops ({} for v2). */
export function programV3Facts(program) {
  if (!isProgramV3(program)) return {};
  return { schemaVersion: PROGRAM_V3_SCHEMA_VERSION, gates: clone(program.control?.gates ?? []), loops: clone(program.control?.loops ?? []) };
}

/** What `workflow plan validate` adds for one v3 step ({} for a v2 action). */
export function stepV3Facts(action) {
  if (action?.retry === undefined) return {};
  return {
    ...(action.label !== undefined ? { label: action.label } : {}),
    ...(action.phase !== undefined ? { phase: action.phase } : {}),
    retry: action.retry, files: [...(action.files ?? [])],
    ...(action.blindTo?.length ? { blindTo: [...action.blindTo] } : {}),
    ...(action.answer !== undefined ? { answer: clone(action.answer) } : {}),
    ...(action.areaOf !== undefined ? { areaOf: clone(action.areaOf) } : {}),
  };
}
