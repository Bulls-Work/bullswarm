// Program v3 through the revision path (0.37.0).
//
// A v3 run keeps its steps in state.program.actions and its gates and loops
// in state.program.control. `workflow step rerun` and `workflow step accept`
// go through planV2Revision with the exported program, so the export of a v3
// run stays v3 and a v3 revision is checked by the v3 validator.
//
// `workflow plan revise` is refused on v3 runs in 0.37.0 (design section 5):
// a revision may rerun or accept steps, never change or remove one, and never
// change the run's gates or loops, so no gate or loop can lose a step. Steps,
// gates and loops are added only by `workflow add`, in its append-only mode
// (below). The one change `workflow add` makes to an existing step (0.38.1):
// its fragment's `blocks` may make a step that has not started also wait for
// a step the fragment adds, so that step's dependsOn grows and nothing else.

import { PROGRAM_V3_SCHEMA_VERSION, isProgramV3, storedProgramV3 } from './program-v3.js';

const clone = (value) => JSON.parse(JSON.stringify(value));

export const V3_REVISE_REFUSED = 'a v3 run\'s steps cannot be added, changed or removed with plan revise in this build; '
  + 'add steps, gates or loops with `bullswarm workflow add`, rerun one with `bullswarm workflow step rerun`, accept one with `bullswarm workflow step accept`, or cancel and start a new run';

/** True when revisions of this run follow the v3 rules. */
export function isV3Revision(state) {
  return isProgramV3(state?.program);
}

/** The exported program of a v3 run: its live steps and its gates and loops, as stored. */
export function exportedProgramV3(state, liveActions) {
  return {
    schemaVersion: state.program.schemaVersion,
    actions: liveActions.map(clone),
    control: clone(state.program.control ?? { gates: [], loops: [] }),
  };
}

const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);

// The request's own gates and loops, normalised, or null when the request does
// not validate with them (a missing or broken control reads as a change).
function requestedControl(program, runtime) {
  try { return storedProgramV3(program, runtime).control; } catch { return null; }
}

// A step's pools route with the pool lists left out: `step rerun --avoid`
// may change them on the step it reruns, and nothing else.
function withoutPoolRoute(action) {
  if (!action?.route?.pools) return action;
  const { pools, ...route } = action.route;
  const copy = { ...action, route };
  if (!Object.keys(route).length) delete copy.route;
  return copy;
}

/**
 * The revised steps of a v3 run, checked by the v3 validator, or `issues`.
 * Any step added, changed or removed is refused, and so is any change to the
 * run's gates and loops (a request that drops or edits one). The one change
 * allowed is the pools route of a step named in `avoidRoute`, which only
 * `step rerun --avoid` sends.
 */
export function desiredActionsV3(state, program, runtime, { avoidRoute = [] } = {}) {
  const control = state.program.control ?? { gates: [], loops: [] };
  let desired;
  try {
    desired = storedProgramV3({ ...program, control: clone(control) }, runtime).actions;
  } catch (error) {
    return { issues: Array.isArray(error?.issues) ? error.issues : [error.message] };
  }
  const stored = state.program.actions;
  const rerouted = new Set(avoidRoute);
  const sameStep = (action, index) => (rerouted.has(action.id) && action.id === stored[index].id
    ? same(withoutPoolRoute(action), withoutPoolRoute(stored[index]))
    : same(action, stored[index]));
  const sameSteps = desired.length === stored.length && desired.every(sameStep);
  return sameSteps && same(requestedControl(program, runtime), control) ? { desired } : { issues: [V3_REVISE_REFUSED] };
}

// --- workflow add: an append-only v3 revision (0.37.0, design section 5) ------
//
// `workflow add` sends a revision request with `append: true` whose program is
// the run's exported program followed by the caller's fragment. It may add
// steps, gates and loops and name existing ids in dependsOn,
// route.independentOf and blindTo; it never removes or reruns what is there, and changes
// an existing step in one way only: the fragment's `blocks`
// ({newStepId: [existing step ids]}) appends a step it adds to the dependsOn
// of existing steps that have not started, are in no loop and would form no
// cycle. The request carries that edge in the step itself, so the live kernel
// that applies the request checks the step's status again under its own
// state. A step already blocked by a failed dependency stays blocked until
// that dependency is accepted or rerun. The normalised stored form of a step
// normalises to itself (program-v3.js), so an existing step reads as
// unchanged apart from its added dependsOn; one that would not is refused,
// never amended.

const FRAGMENT_KEYS = new Set(['schemaVersion', 'steps', 'gates', 'loops', 'blocks']);
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Why this value is not a v3 fragment {steps?, gates?, loops?, blocks?}, as a list of issues ([] when it is one). */
export function fragmentShapeIssues(fragment) {
  if (!isObject(fragment)) return ['a fragment must be a JSON object {steps, gates?, loops?, blocks?}'];
  const issues = [];
  for (const key of Object.keys(fragment)) {
    if (!FRAGMENT_KEYS.has(key)) issues.push(`fragment.${key} is not allowed; a fragment has steps, gates, loops and blocks (set lane, effort and retry on each step)`);
  }
  issues.push(...blocksShapeIssues(fragment));
  if (fragment.schemaVersion !== undefined && fragment.schemaVersion !== PROGRAM_V3_SCHEMA_VERSION) issues.push(`fragment.schemaVersion must be "${PROGRAM_V3_SCHEMA_VERSION}" when given`);
  for (const name of ['steps', 'gates', 'loops']) {
    if (fragment[name] !== undefined && !Array.isArray(fragment[name])) issues.push(`fragment.${name} must be an array`);
  }
  const count = ['steps', 'gates', 'loops'].reduce((sum, name) => sum + (Array.isArray(fragment[name]) ? fragment[name].length : 0), 0);
  if (!issues.length && !count) issues.push('the fragment adds nothing: give at least one step, gate or loop');
  return issues;
}

const BLOCKS_FORM = 'blocks maps a step the fragment adds to the existing steps that must also wait for it: {"<new step id>": ["<existing step id>", ...]}';

// fragment.blocks read on its own: an object whose keys are steps the fragment adds.
function blocksShapeIssues(fragment) {
  if (fragment.blocks === undefined) return [];
  if (!isObject(fragment.blocks)) return [`fragment.blocks must be an object; ${BLOCKS_FORM}`];
  const adds = new Set((Array.isArray(fragment.steps) ? fragment.steps : []).map((step) => step?.id));
  const issues = [];
  for (const [key, targets] of Object.entries(fragment.blocks)) {
    if (!adds.has(key)) issues.push(`fragment.blocks.${key} names no step the fragment adds; ${BLOCKS_FORM}`);
    if (!Array.isArray(targets) || !targets.length || targets.some((id) => typeof id !== 'string' || !id)) {
      issues.push(`fragment.blocks.${key} must be a non-empty array of existing step ids`);
    } else {
      for (const id of new Set(targets.filter((item, index) => targets.indexOf(item) !== index))) issues.push(`fragment.blocks.${key} names ${id} twice`);
    }
  }
  return issues;
}

/**
 * Why the fragment's blocks cannot apply to this run ([] when they can): each
 * target must be a step the run has. Whether it may still wait (not started,
 * in no loop, no cycle) is checked by appendedActionsV3, where a live kernel
 * reads it too.
 */
export function blocksIssues(state, fragment) {
  const issues = [];
  const control = state.program.control ?? { gates: [], loops: [] };
  const runtime = new Map((state.actions ?? []).map((action) => [action.id, action]));
  const steps = new Set(state.program.actions.filter((action) => runtime.get(action.id)?.status !== 'removed').map((action) => action.id));
  const gates = new Set((control.gates ?? []).map((gate) => gate.id));
  const loops = new Set((control.loops ?? []).map((loop) => loop.id));
  const adds = new Set((fragment.steps ?? []).map((step) => step?.id));
  for (const [key, targets] of Object.entries(fragment.blocks ?? {})) {
    for (const id of targets) {
      if (steps.has(id)) continue;
      if (gates.has(id) || loops.has(id)) issues.push(`fragment.blocks.${key} names the ${gates.has(id) ? 'gate' : 'loop'} ${id}; blocks may name only existing steps, and a gate or loop never changes`);
      else if (adds.has(id)) issues.push(`fragment.blocks.${key} names ${id}, a step the fragment adds; give ${id} dependsOn ["${key}"] instead`);
      else issues.push(`fragment.blocks.${key} names "${id}", which is not a step of the run`);
    }
  }
  return issues;
}

/**
 * The request program of `workflow add`: the run's live steps and its gates
 * and loops as stored, then the fragment's. Items keep the fragment's order.
 * A step named in the fragment's blocks also depends on the step that names
 * it, appended to its dependsOn in the fragment's order.
 */
export function appendedProgramV3(state, liveActions, fragment) {
  const control = state.program.control ?? { gates: [], loops: [] };
  const waitsFor = new Map();
  for (const [key, targets] of Object.entries(isObject(fragment.blocks) ? fragment.blocks : {})) {
    for (const id of Array.isArray(targets) ? targets : []) waitsFor.set(id, [...(waitsFor.get(id) ?? []), key]);
  }
  const blocked = (action) => {
    const added = (waitsFor.get(action.id) ?? []).filter((id) => !action.dependsOn.includes(id));
    return added.length ? { ...action, dependsOn: [...action.dependsOn, ...added] } : action;
  };
  return {
    schemaVersion: state.program.schemaVersion,
    actions: [...liveActions.map(clone).map(blocked), ...clone(fragment.steps ?? [])],
    control: {
      gates: [...clone(control.gates ?? []), ...clone(fragment.gates ?? [])],
      loops: [...clone(control.loops ?? []), ...clone(fragment.loops ?? [])],
    },
  };
}

// An issue about the combined program, in the words of the fragment the
// caller wrote: steps[n + k] is the fragment's steps[k].
function fragmentWording(issue, counts) {
  return String(issue).replace(/\b(steps|gates|loops)\[(\d+)\]/g, (match, list, index) => {
    const at = Number(index) - counts[list];
    return at >= 0 ? `fragment ${list}[${at}]` : match;
  });
}

/**
 * The steps and control of a v3 run after an append-only revision, checked by
 * the v3 validator, or `issues`. `program` is appendedProgramV3's output.
 */
export function appendedActionsV3(state, program, runtime) {
  const stored = state.program.actions;
  const control = state.program.control ?? { gates: [], loops: [] };
  const counts = { steps: stored.length, gates: (control.gates ?? []).length, loops: (control.loops ?? []).length };
  const requested = {
    steps: Array.isArray(program?.actions) ? program.actions : [],
    gates: Array.isArray(program?.control?.gates) ? program.control.gates : [],
    loops: Array.isArray(program?.control?.loops) ? program.control.loops : [],
  };
  const issues = [];
  // An existing step may depend on a step the request adds only through the
  // fragment's blocks; with those ids left out it must read as stored.
  const adds = new Set(requested.steps.slice(counts.steps).filter(isObject).map((step) => step.id));
  const withoutAdded = (action) => (isObject(action) && Array.isArray(action.dependsOn)
    ? { ...action, dependsOn: action.dependsOn.filter((id) => !adds.has(id)) } : action);
  const addedDeps = (action) => (isObject(action) && Array.isArray(action.dependsOn) ? action.dependsOn.filter((id) => adds.has(id)) : []);
  // The run's own items come first and unchanged; a fragment item never reuses an id.
  const heads = [['steps', stored], ['gates', control.gates ?? []], ['loops', control.loops ?? []]];
  const asRequested = (list, index) => (list === 'steps' ? withoutAdded(requested.steps[index]) : requested[list][index]);
  for (const [list, own] of heads) {
    if (requested[list].length < own.length || own.some((item, index) => !same(item, asRequested(list, index)))) {
      issues.push(`workflow add never changes or removes what the run has; its ${list} must come first, as stored`);
    }
  }
  if (issues.length) return { issues };
  const existing = new Set([...stored, ...(control.gates ?? []), ...(control.loops ?? [])].map((item) => item.id));
  for (const [list] of heads) {
    requested[list].slice(counts[list]).forEach((item, index) => {
      if (isObject(item) && existing.has(item.id)) {
        issues.push(`fragment ${list}[${index}] uses the id "${item.id}", which the run already has; workflow add never changes an existing step, gate or loop (rerun a step with bullswarm workflow step rerun)`);
      }
    });
  }
  // A loop reruns its steps: a new loop around a step the run already has
  // would change how that step runs.
  requested.loops.slice(counts.loops).forEach((loop, index) => {
    for (const id of Array.isArray(loop?.steps) ? loop.steps : []) {
      if (stored.some((action) => action.id === id)) issues.push(`fragment loops[${index}] names the existing step ${id}; a new loop's steps must be steps the fragment adds`);
    }
  });
  // blocks: the step must not have started, be in no loop, and not be one
  // the added step itself waits for. Read from this state, so the live kernel
  // that applies the request decides with what it has.
  const blocks = stored.map((action, index) => ({ step: action.id, waitsFor: addedDeps(requested.steps[index]) }))
    .filter((entry) => entry.waitsFor.length);
  if (blocks.length) {
    const runtimeById = new Map((state.actions ?? []).map((action) => [action.id, action]));
    const nodes = new Map([
      ...requested.steps.filter(isObject).map((step) => [step.id, Array.isArray(step.dependsOn) ? step.dependsOn : []]),
      ...requested.gates.filter(isObject).map((gate) => [gate.id, Array.isArray(gate.dependsOn) ? gate.dependsOn : []]),
      ...requested.loops.filter(isObject).map((loop) => [loop.id, Array.isArray(loop.steps) ? loop.steps : []]),
    ]);
    // True when `from` waits for `target`, through the requested graph.
    const reaches = (from, target) => {
      const seen = new Set();
      const queue = [from];
      while (queue.length) {
        for (const dep of nodes.get(queue.shift()) ?? []) {
          if (dep === target) return true;
          if (!seen.has(dep)) { seen.add(dep); queue.push(dep); }
        }
      }
      return false;
    };
    for (const { step, waitsFor } of blocks) {
      const record = runtimeById.get(step);
      const running = (state.attempts ?? []).some((attempt) => attempt.actionId === step && attempt.status === 'running');
      const loop = (control.loops ?? []).find((item) => (item.steps ?? []).includes(step));
      for (const key of waitsFor) {
        if (!record || !NOT_STARTED.has(record.status) || record.attempts > 0 || running) {
          const attempts = record?.attempts > 0 ? ` after ${record.attempts} attempt${record.attempts === 1 ? '' : 's'}` : '';
          issues.push(`fragment.blocks.${key} names step ${step}, which is ${running ? 'running' : record?.status ?? 'unknown'}${attempts}; blocks may name only steps that have not started`);
        } else if (loop) {
          issues.push(`fragment.blocks.${key} names step ${step}, which is in loop ${loop.id}; a loop's steps never change`);
        } else if (reaches(key, step)) {
          issues.push(`fragment.blocks.${key} names step ${step}, which ${key} itself waits for (a cycle)`);
        }
      }
    }
  }
  if (issues.length) return { issues };
  let normal;
  try {
    normal = storedProgramV3(program, runtime);
  } catch (error) {
    return { issues: (Array.isArray(error?.issues) ? error.issues : [error.message]).map((issue) => fragmentWording(issue, counts)) };
  }
  // The round-trip guarantee: every existing item normalises to itself.
  const changed = [
    ...stored.filter((action, index) => !same(action, withoutAdded(normal.actions[index]))
      || !same(addedDeps(normal.actions[index]), addedDeps(requested.steps[index]))).map((action) => `step ${action.id}`),
    ...(control.gates ?? []).filter((gate, index) => !same(gate, normal.control.gates[index])).map((gate) => `gate ${gate.id}`),
    ...(control.loops ?? []).filter((loop, index) => !same(loop, normal.control.loops[index])).map((loop) => `loop ${loop.id}`),
  ];
  if (changed.length) return { issues: [`workflow add would change ${changed.join(', ')} of the run; nothing was added`] };
  const addedControl = [...normal.control.gates.slice(counts.gates), ...normal.control.loops.slice(counts.loops)].map((node) => node.id);
  return { desired: normal.actions, control: normal.control, addedControl, blocks };
}

// A step that has not started: it may still be made to wait.
const NOT_STARTED = new Set(['pending', 'ready', 'blocked']);
