// The mode is persisted at launch. An absent mode means a saved pre-program
// workflow, whose evidence and workspace semantics must survive resume.
export function isProgramWorkflow(stateOrGoal) {
  return stateOrGoal?.config?.settings?.executionMode === 'program';
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
