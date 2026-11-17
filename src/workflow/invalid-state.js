// A run whose state.json fails validation can never be driven: its kernel dies
// at once on load. Only the verbs that would start or signal a kernel validate
// (resume, cancel, steer, add, continue); they and a kernel that fails to load
// leave the marker state-invalid.json in the run directory. Readers (watch,
// runs show, the runs list, runs result) only read the marker; they never
// validate, so a run saved by an older Bullswarm is not suddenly "invalid".
// A later successful load removes the marker, and a marker whose state.json
// has changed since (a hand repair, a kernel's own write) is stale and ignored.
// The state is never repaired.

import { existsSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveRunId, isLegacyRunDir } from './short-id.js';
import { V2StateValidationError, deserializeV2DurableState } from './v2-state.js';

const markerPath = (runDir) => join(runDir, 'state-invalid.json');

// What state.json looked like when the marker was written: its size and mtime.
function stateStampOf(runDir) {
  try {
    const stat = statSync(join(runDir, 'state.json'));
    return { size: stat.size, mtimeMs: stat.mtimeMs };
  } catch { return null; }
}

/** null when the run's state.json is valid (or absent), else {message, file}. */
export function invalidStateOf(runDir) {
  const file = join(runDir, 'state.json');
  if (!existsSync(file) || isLegacyRunDir(runDir)) return null;
  try { deserializeV2DurableState(readFileSync(file, 'utf8')); return null; }
  catch (err) {
    // An unreadable file (EACCES, EIO) can no more be driven than an invalid one.
    if (err instanceof V2StateValidationError || err?.code) return { message: err.message, file };
    throw err;
  }
}

export function writeInvalidStateMarker(runDir, message, by) {
  try {
    const tmp = `${markerPath(runDir)}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify({ message, at: new Date().toISOString(), by, state: stateStampOf(runDir) })}\n`);
    renameSync(tmp, markerPath(runDir));
  } catch { /* the refusal itself still prints */ }
}

export function clearInvalidStateMarker(runDir) {
  try { rmSync(markerPath(runDir), { force: true }); } catch { /* best effort */ }
}

/** {message, at, by, file} when the run carries a marker, else null. */
export function readInvalidStateMarker(runDir) {
  try {
    const marker = JSON.parse(readFileSync(markerPath(runDir), 'utf8'));
    if (typeof marker?.message !== 'string') return null;
    // Stale once state.json changed since the marker was written.
    const now = stateStampOf(runDir);
    if (marker.state && (!now || now.size !== marker.state.size || now.mtimeMs !== marker.state.mtimeMs)) return null;
    return { ...marker, file: join(runDir, 'state.json') };
  } catch { return null; }
}

export function invalidStateLine(runId, invalid) {
  return `✗ run ${runId} has invalid saved state: ${invalid.message} (file: ${invalid.file})`;
}

/**
 * For a verb that would start or signal a kernel: prints the refusal, writes
 * the marker and returns 1 when the run named by `token` has invalid state;
 * otherwise clears any stale marker and returns null.
 */
export function invalidStateRefusal(bullswarmDir, token, verb) {
  const resolved = resolveRunId(bullswarmDir, token);
  if (!resolved) return null;
  const invalid = invalidStateOf(resolved.runDir);
  if (!invalid) { clearInvalidStateMarker(resolved.runDir); return null; }
  writeInvalidStateMarker(resolved.runDir, invalid.message, verb);
  console.error(invalidStateLine(resolved.shortId ?? resolved.runId, invalid));
  return 1;
}
