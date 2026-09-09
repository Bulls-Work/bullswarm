import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
// short-id.js imports withV2Cancellation from here, so this is a cycle. It is
// safe because both sides export only hoisted function declarations and this
// module does no work at evaluation time — keep it that way.
import { isLegacyRunState } from './short-id.js';

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
