// Program v3 through the revision path (0.37.0).
//
// A v3 run keeps its steps in state.program.actions and its gates and loops
// in state.program.control. `workflow step rerun` and `workflow step accept`
// go through planV2Revision with the exported program, so the export of a v3
// run stays v3 and a v3 revision is checked by the v3 validator.
//
// `workflow plan revise` is refused on v3 runs in 0.37.0 (design section 5):
// a revision may rerun or accept steps, never add, change or remove one. The
// control nodes are never touched here, so no gate or loop can lose a step.

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

/**
 * The revised steps of a v3 run, checked by the v3 validator, or `issues`.
 * The request keeps the run's control nodes; any step added, changed or
 * removed is refused.
 */
export function desiredActionsV3(state, program, runtime) {
  let desired;
  try {
    desired = storedProgramV3({ ...program, control: clone(state.program.control ?? { gates: [], loops: [] }) }, runtime).actions;
  } catch (error) {
    return { issues: Array.isArray(error?.issues) ? error.issues : [error.message] };
  }
  const stored = state.program.actions;
  const same = desired.length === stored.length
    && desired.every((action, index) => JSON.stringify(action) === JSON.stringify(stored[index]));
  return same ? { desired } : { issues: [V3_REVISE_REFUSED] };
}
