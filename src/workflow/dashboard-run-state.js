// Reading a run's state for display: its lifecycle status and times, the
// step statuses that are terminal, and the run's one-line label.

const stateStatus = (state) => state?.lifecycle?.status;
const stateStartedAt = (state) => state?.lifecycle?.startedAt;
const stateFinishedAt = (state) => state?.lifecycle?.finishedAt;

function workflowRunLabel(row) {
  const state = row?.state ?? {};
  // A legacy row carries only the workflow name and goal it recorded.
  if (row?.legacy) return String(state.name ?? state.goal ?? row?.runId ?? 'workflow').split('\n')[0].trim();
  return String(state.intent?.goal ?? state.intent?.description ?? row?.runId ?? 'workflow')
    .split('\n')[0]
    .trim();
}

const TERMINAL_ACTIONS = new Set([
  'succeeded', 'failed', 'failed_retryable', 'failed_terminal', 'skipped', 'cancelled', 'removed',
]);

export {
  stateStatus,
  stateStartedAt,
  stateFinishedAt,
  workflowRunLabel,
  TERMINAL_ACTIONS,
};
