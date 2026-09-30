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
// (below).

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
// steps, gates and loops and name existing ids in dependsOn and
// route.independentOf; it never changes, removes or reruns what is there. The
// normalised stored form of a step normalises to itself (program-v3.js), so an
// existing step reads as unchanged; one that would not is refused, never
// amended.

const FRAGMENT_KEYS = new Set(['schemaVersion', 'steps', 'gates', 'loops']);
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Why this value is not a v3 fragment {steps?, gates?, loops?}, as a list of issues ([] when it is one). */
export function fragmentShapeIssues(fragment) {
  if (!isObject(fragment)) return ['a fragment must be a JSON object {steps, gates?, loops?}'];
  const issues = [];
  for (const key of Object.keys(fragment)) {
    if (!FRAGMENT_KEYS.has(key)) issues.push(`fragment.${key} is not allowed; a fragment has steps, gates and loops (set lane, effort and retry on each step)`);
  }
  if (fragment.schemaVersion !== undefined && fragment.schemaVersion !== PROGRAM_V3_SCHEMA_VERSION) issues.push(`fragment.schemaVersion must be "${PROGRAM_V3_SCHEMA_VERSION}" when given`);
  for (const name of ['steps', 'gates', 'loops']) {
    if (fragment[name] !== undefined && !Array.isArray(fragment[name])) issues.push(`fragment.${name} must be an array`);
  }
  const count = ['steps', 'gates', 'loops'].reduce((sum, name) => sum + (Array.isArray(fragment[name]) ? fragment[name].length : 0), 0);
  if (!issues.length && !count) issues.push('the fragment adds nothing: give at least one step, gate or loop');
  return issues;
}

/**
 * The request program of `workflow add`: the run's live steps and its gates
 * and loops as stored, then the fragment's. Items keep the fragment's order.
 */
export function appendedProgramV3(state, liveActions, fragment) {
  const control = state.program.control ?? { gates: [], loops: [] };
  return {
    schemaVersion: state.program.schemaVersion,
    actions: [...liveActions.map(clone), ...clone(fragment.steps ?? [])],
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
  // The run's own items come first and unchanged; a fragment item never reuses an id.
  const heads = [['steps', stored], ['gates', control.gates ?? []], ['loops', control.loops ?? []]];
  for (const [list, own] of heads) {
    if (requested[list].length < own.length || own.some((item, index) => !same(item, requested[list][index]))) {
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
  if (issues.length) return { issues };
  let normal;
  try {
    normal = storedProgramV3(program, runtime);
  } catch (error) {
    return { issues: (Array.isArray(error?.issues) ? error.issues : [error.message]).map((issue) => fragmentWording(issue, counts)) };
  }
  // The round-trip guarantee: every existing item normalises to itself.
  const changed = [
    ...stored.filter((action, index) => !same(action, normal.actions[index])).map((action) => `step ${action.id}`),
    ...(control.gates ?? []).filter((gate, index) => !same(gate, normal.control.gates[index])).map((gate) => `gate ${gate.id}`),
    ...(control.loops ?? []).filter((loop, index) => !same(loop, normal.control.loops[index])).map((loop) => `loop ${loop.id}`),
  ];
  if (changed.length) return { issues: [`workflow add would change ${changed.join(', ')} of the run; nothing was added`] };
  const addedControl = [...normal.control.gates.slice(counts.gates), ...normal.control.loops.slice(counts.loops)].map((node) => node.id);
  return { desired: normal.actions, control: normal.control, addedControl };
}
