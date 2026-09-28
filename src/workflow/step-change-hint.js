// How a caller changes a step, in the words a refusal prints.
//
// A v2 run changes a step through the whole-plan revise (export, edit,
// revise).

/** The command that changes a step of this run. */
export function changeStepHint(state, token) {
  return `bullswarm workflow plan export ${token} --out plan.json, edit it, then bullswarm workflow plan revise ${token} --program plan.json`;
}
