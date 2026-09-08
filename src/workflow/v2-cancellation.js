import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// Operator intent is separate from the kernel-owned state snapshot. Readers
// overlay it immediately, including while a caller-planned run is paused.
export function withV2Cancellation(state, runDir) {
  if (state?.schemaVersion !== 'bullswarm.workflow.state.v2') return state;
  const path = join(runDir, 'cancellation.json');
  if (!existsSync(path)) return state;
  const request = JSON.parse(readFileSync(path, 'utf8'));
  return request?.requested ? { ...state, cancellation: request } : state;
}
