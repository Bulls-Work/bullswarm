export const TERMINAL_WORKFLOW_STATUSES = new Set([
  'completed',
  'completed_with_concerns', // legacy runs
  'blocked',
  'failed',
  'cancelled',
  'interrupted',
  'budget_exhausted', // legacy runs
  // The V2 kernel's own terminal set (v2-runtime.js TERMINAL) has always
  // included partial, and it is not rare: 14 of the 190 V2 runs in the live
  // home finished partial. Leaving it out was the only thing that made a
  // partial run look unfinished to a reader that asked this set.
  'partial',
]);

export function isTerminalWorkflowStatus(status) {
  return TERMINAL_WORKFLOW_STATUSES.has(status);
}

export function isDeliveredWorkflowStatus(status) {
  // Keep replaying pre-qualification runs as delivered.
  return status === 'completed' || status === 'completed_with_concerns';
}
