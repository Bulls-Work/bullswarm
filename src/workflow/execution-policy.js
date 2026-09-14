// The mode is persisted at launch. An absent mode means a saved pre-program
// workflow, whose evidence and workspace semantics must survive resume.
export function isProgramWorkflow(stateOrGoal) {
  return stateOrGoal?.config?.settings?.executionMode === 'program';
}

// A program the caller has revised in place (workflow plan revise). Its
// actions no longer replay revision by revision: the live graph is validated
// as one program, and actions a revision dropped stay only as history.
export function isLiveProgram(state) {
  return Array.isArray(state?.revisions) && state.revisions.some((entry) => entry?.status === 'applied');
}

export function removedActionIds(state) {
  return new Set((state?.actions ?? []).filter((action) => action.status === 'removed').map((action) => action.id));
}

export function enforcesOwnership(stateOrGoal) {
  return !isProgramWorkflow(stateOrGoal) || stateOrGoal.config.settings.workspaceMode === 'isolated';
}

export function hasPassingRequirementEvidence(state) {
  const mandatory = Object.values(state.ledger?.requirements ?? {}).filter((item) => item.mandatory);
  return mandatory.length > 0 && mandatory.every((item) => item.status === 'passed');
}

export function v2SchedulingOptions(stateOrGoal) {
  const settings = stateOrGoal.config.settings;
  return {
    concurrency: settings.concurrency ?? settings.maxParallel ?? 4,
    workspaceMode: settings.workspaceMode ?? 'shared',
    allowParallelShared: isProgramWorkflow(stateOrGoal),
  };
}
