// A run whose state.json fails validation can never be driven: its kernel dies
// at once on load. Every verb that would start or write something checks the
// state first and says so, instead of reporting a success nothing will honour.
// The state is never repaired here.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveRunId, isLegacyRunDir } from './short-id.js';
import { V2StateValidationError, deserializeV2DurableState } from './v2-state.js';

/** null when the run's state.json is valid (or absent), else {message, file}. */
export function invalidStateOf(runDir) {
  const file = join(runDir, 'state.json');
  if (!existsSync(file) || isLegacyRunDir(runDir)) return null;
  try { deserializeV2DurableState(readFileSync(file, 'utf8')); return null; }
  catch (err) {
    if (err instanceof V2StateValidationError) return { message: err.message, file };
    throw err;
  }
}

export function invalidStateLine(runId, invalid) {
  return `✗ run ${runId} has invalid saved state: ${invalid.message} (file: ${invalid.file})`;
}

/** Prints the refusal and returns 1 when the run named by `token` has invalid state, else null. */
export function invalidStateRefusal(bullswarmDir, token) {
  const resolved = resolveRunId(bullswarmDir, token);
  if (!resolved) return null;
  const invalid = invalidStateOf(resolved.runDir);
  if (!invalid) return null;
  console.error(invalidStateLine(resolved.shortId ?? resolved.runId, invalid));
  return 1;
}
