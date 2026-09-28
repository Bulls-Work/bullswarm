// How a caller changes a step, in the words a refusal prints.
//
// A v2 run changes a step through the whole-plan revise (export, edit,
// revise). A v3 run refuses plan revise (0.37.0, design section 5): its steps
// are never edited, so the change is a new step appended with workflow add.

import { isProgramV3 } from './program-v3.js';

/** The command that changes a step of this run. */
export function changeStepHint(state, token) {
  if (isProgramV3(state?.program)) {
    return `bullswarm workflow add ${token} --steps part.json with a new step that does it the way you want (a v3 run's steps are never edited)`;
  }
  return `bullswarm workflow plan export ${token} --out plan.json, edit it, then bullswarm workflow plan revise ${token} --program plan.json`;
}

/** The command that runs a finished step again. */
export function rerunStepHint(state, token, stepId) {
  if (isProgramV3(state?.program)) return `bullswarm workflow step rerun ${token} ${stepId}`;
  return `bullswarm workflow plan export ${token} --out plan.json, then bullswarm workflow plan revise ${token} --program plan.json --rerun ${stepId}`;
}
