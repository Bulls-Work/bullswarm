// The one predicate every reader uses to tell an authored-graph run from a V2
// one. 0.27.0 removed the authored-graph executor, so a run directory whose
// state.json lacks the V2 schemaVersion — or that has no state.json at all —
// is history: readable, listable, deletable, never driven.
export function isLegacyRunState(state) {
  return state?.schemaVersion !== 'bullswarm.workflow.state.v2';
}
