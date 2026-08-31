export const TERMINAL_WORKFLOW_STATUSES = new Set([
  'completed',
  'completed_with_concerns', // legacy runs
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
  // Keep replaying pre-qualification runs as delivered.
  return status === 'completed' || status === 'completed_with_concerns';
}
