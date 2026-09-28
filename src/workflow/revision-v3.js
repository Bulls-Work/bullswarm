// Program v3 through the revision path (0.37.0).
//
// A v3 run keeps its steps in state.program.actions and its gates and loops
// in state.program.control. `workflow step rerun` and `workflow step accept`
// go through planV2Revision with the exported program, so the export of a v3
// run stays v3 and a v3 revision is checked by the v3 validator.
//
// `workflow plan revise` is refused on v3 runs in 0.37.0 (design section 5):
// a revision may rerun or accept steps, never add, change or remove one, and
// never change the run's gates or loops, so no gate or loop can lose a step.

import { isProgramV3, storedProgramV3 } from './program-v3.js';

const clone = (value) => JSON.parse(JSON.stringify(value));

export const V3_REVISE_REFUSED = 'a v3 run\'s steps cannot be added, changed or removed with plan revise in this build; '
  + 'rerun one with `bullswarm workflow step rerun`, accept one with `bullswarm workflow step accept`, or cancel and start a new run';

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

/**
 * The revised steps of a v3 run, checked by the v3 validator, or `issues`.
 * Any step added, changed or removed is refused, and so is any change to the
 * run's gates and loops (a request that drops or edits one).
 */
export function desiredActionsV3(state, program, runtime) {
  const control = state.program.control ?? { gates: [], loops: [] };
  let desired;
  try {
    desired = storedProgramV3({ ...program, control: clone(control) }, runtime).actions;
  } catch (error) {
    return { issues: Array.isArray(error?.issues) ? error.issues : [error.message] };
  }
  const stored = state.program.actions;
  const sameSteps = desired.length === stored.length && desired.every((action, index) => same(action, stored[index]));
  return sameSteps && same(requestedControl(program, runtime), control) ? { desired } : { issues: [V3_REVISE_REFUSED] };
}
