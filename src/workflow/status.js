export const TERMINAL_WORKFLOW_STATUSES = new Set([
  'completed',
  'completed_with_concerns',
  'blocked',
  'failed',
  'cancelled',
  'interrupted',
  'budget_exhausted', // legacy runs
]);

export function isTerminalWorkflowStatus(status) {
  return TERMINAL_WORKFLOW_STATUSES.has(status);
}

export function isDeliveredWorkflowStatus(status) {
  return status === 'completed' || status === 'completed_with_concerns';
}
