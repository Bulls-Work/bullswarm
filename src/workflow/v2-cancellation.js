import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isLegacyRunState } from './legacy-run-state.js';

// Operator intent is separate from the kernel-owned state snapshot. Readers
// overlay it immediately, including while a caller-planned run is paused.
export function withV2Cancellation(state, runDir) {
  // A legacy run has no cancellation to overlay; nothing can be driving it.
  if (isLegacyRunState(state)) return state;
  const path = join(runDir, 'cancellation.json');
  if (!existsSync(path)) return state;
  const request = JSON.parse(readFileSync(path, 'utf8'));
  return request?.requested ? { ...state, cancellation: request } : state;
}
