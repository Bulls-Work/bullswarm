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

import {
  ACTION_PROGRAM_SCHEMA_VERSION, DEFAULT_EFFORT_BY_LANE, TIME_BOX_MAX_MINUTES, validateActionProgram,
} from './action-validator.js';
import { deliverableTypeOf } from './step-vocabulary.js';
import { SCHEMA_MAX_SCHEMA_BYTES, schemaSubsetIssues } from './schema-check.js';
import { isReasoningLevel } from '../lib/reasoning.js';

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
  'id', 'prompt', 'dependsOn', 'phase', 'label', 'lane', 'effort', 'reasoning', 'route',
  'answer', 'evidence', 'deliverable', 'files', 'retry', 'timeBox',
]);
// Present in the stored form; accepted on input only with the derived value.
const DERIVED_KEYS = new Set(['purpose', 'ownedFiles', 'affects', 'role', 'evidenceFor', 'inputs', 'produces']);
const V2_ONLY_KEYS = new Set(['kind', 'evidenceFor', 'inputs', 'produces', 'role']);
const DERIVED_FROM = Object.freeze({
  purpose: 'label or id', ownedFiles: 'files', affects: 'the lane and files', role: 'the deliverable',
});
const GATE_KEYS = new Set(['id', 'dependsOn', 'when', 'note']);
const LOOP_KEYS = new Set(['id', 'steps', 'until', 'maxRounds']);
export const LOOP_MAX_ROUNDS = 5;
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
const clone = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));
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
function readCondition(raw, at, issues, stepsById) {
  if (!isObject(raw)) {
    issues.push(`${at} must be {step, field, equals?} or {step, evidence: "passed"}`);
    return undefined;
  }
  const byEvidence = raw.evidence !== undefined;
  const allowed = byEvidence ? ['step', 'evidence'] : ['step', 'field', 'equals'];
  for (const key of present(raw)) if (!allowed.includes(key)) issues.push(`${at}.${key} is not allowed`);
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

// v2 issues speak of actions[i] and ownedFiles; a v3 author wrote steps[i]
// and files.
const v3Wording = (issue) => String(issue)
  .replace(/^actions\[(\d+)\]/, 'steps[$1]')
  .replace(/\.ownedFiles\b/g, '.files')
  .replace(/ ownedFiles\b/g, ' files');

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
  const rawSteps = Array.isArray(program.steps) ? program.steps : [];
  const listOf = (name) => {
    if (program[name] === undefined) return [];
    if (!Array.isArray(program[name])) { issues.push(`${name} must be an array`); return []; }
    return program[name];
  };
  const rawGates = listOf('gates');
  const rawLoops = listOf('loops');
  const requirementId = runtime.requirementId
    ?? (Array.isArray(runtime.requirements) && typeof runtime.requirements[0]?.id === 'string' ? runtime.requirements[0].id : IMPLICIT_REQUIREMENT_ID);

  // One id space for steps, gates and loops.
  const kindOf = new Map();
  const claim = (id, kind) => {
    if (typeof id !== 'string' || !ID_RE.test(id)) return false;
    if (kindOf.has(id)) { issues.push(`id "${id}" is used twice; steps, gates and loops share one id space`); return false; }
    kindOf.set(id, kind);
    return true;
  };

  // Steps: the v3 fields, and the derived v2 action dispatch reads.
  const steps = rawSteps.map((raw, index) => {
    const at = `steps[${index}]`;
    if (!isObject(raw)) { issues.push(`${at} must be an object`); return null; }
    for (const key of present(raw)) {
      if (STEP_KEYS.has(key) || DERIVED_KEYS.has(key)) continue;
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
        issues.push(`${node.id} depends on ${dep} inside loop ${loop}; depend on the loop ${loop} instead`);
      }
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
    const when = gate.raw.when === undefined ? undefined : readCondition(gate.raw.when, `gates[${gate.index}].when`, issues, stepsById);
    if (when && !ancestors(gate.id).has(when.step)) issues.push(`gates[${gate.index}].when.step must run before gate ${gate.id}; ${when.step} is not one of its dependencies`);
    return { id: gate.id, dependsOn: gate.dependsOn, ...(when ? { when } : {}), ...(gate.note !== undefined ? { note: gate.note } : {}) };
  });
  const normalLoops = loops.filter(Boolean).map((loop) => {
    const until = readCondition(loop.raw.until, `loops[${loop.index}].until`, issues, stepsById);
    if (until && !loop.steps.includes(until.step)) issues.push(`loops[${loop.index}].until.step must be one of the loop's steps (${loop.steps.join(', ')})`);
    return { id: loop.id, steps: loop.steps, ...(until ? { until } : {}), maxRounds: loop.maxRounds };
  });

  // The step-level rules v2 already has, on the derived action list.
  const live = steps.filter(Boolean);
  const mapped = live.map((step) => {
    const action = {
      id: step.id, purpose: step.purpose, prompt: step.raw.prompt,
      dependsOn: [...new Set(step.dependsOn.filter((dep) => kindOf.has(dep) && dep !== step.id).flatMap((dep) => expand(dep)))],
      affects: step.affects, ownedFiles: step.files, evidenceFor: [], lane: step.lane, effort: step.effort,
    };
    if (step.reasoning !== undefined) action.reasoning = step.reasoning;
    if (step.timeBox !== undefined) action.timeBox = step.timeBox;
    if (step.role !== undefined) action.role = step.role;
    if (step.deliverable !== undefined) action.deliverable = step.deliverable;
    if (step.raw.evidence !== undefined) action.evidence = step.raw.evidence;
    if (step.raw.route !== undefined) action.route = step.raw.route;
    return action;
  });
  let checked = null;
  if (mapped.length) {
    try {
      checked = validateActionProgram({ schemaVersion: ACTION_PROGRAM_SCHEMA_VERSION, actions: mapped }, {
        relaxedGraph: true, requireMandatoryEvidence: false, enforceMaxActions: false, enforceMaxParallel: false,
        ...runtime,
        requirements: Array.isArray(runtime.requirements) ? runtime.requirements : [{ id: requirementId, mandatory: false }],
      });
    } catch (error) {
      issues.push(...(Array.isArray(error?.issues) ? error.issues : [error.message]).map(v3Wording));
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
    if (action.timeBox !== undefined) out.timeBox = action.timeBox;
    out.retry = step.retry;
    out.files = [...action.ownedFiles];
    out.ownedFiles = [...action.ownedFiles];
    out.affects = [...action.affects];
    if (action.role !== undefined) out.role = action.role;
    if (action.deliverable !== undefined) out.deliverable = clone(action.deliverable);
    if (action.evidence !== undefined) out.evidence = clone(action.evidence);
    if (action.route !== undefined) out.route = clone(action.route);
    if (step.answer !== undefined) out.answer = step.answer;
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
    ...(action.answer !== undefined ? { answer: clone(action.answer) } : {}),
  };
}
