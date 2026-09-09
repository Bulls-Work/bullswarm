// Atomic JSON persistence + torn-read-tolerant JSON reads.
//
// Lives in src/lib/ because core state (src/lib/state.js) needs the same
// temp+rename write the workflow layer already used. One module, imported
// directly by both layers — the src/workflow/fsjson.js re-export shim that
// carried the workflow importers through the move is gone.
//
// Doctrine:
//   F1. Every state/report/workflow artifact is written via temp+rename so a
//       concurrent reader can NEVER observe a half-written file (earned:
//       `bullswarm workflow tui` crashed with "Unterminated string in JSON at
//       position 138968" parsing state.json mid-write, 2026-08-29).
//   F2. Display readers tolerate a missing or torn file (returns fallback):
//       observation must never crash on the writer's timing.
//   F3. Mutating read-modify-write readers must NOT silently no-op: they
//       retry once (rename-atomic writes make the second read succeed) and
//       then throw a clear error instead of dropping the user's command.

import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';

export function atomicWriteFileSync(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${randomBytes(3).toString('hex')}`;
  writeFileSync(tmp, content);
  renameSync(tmp, path);
}

export function writeJsonAtomic(path, value) {
  atomicWriteFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

/** Display-path read: missing or torn file -> fallback, never a throw. */
export function readJsonSafe(path, fallback = null) {
  if (!existsSync(path)) return fallback;
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return fallback; }
}

/** Mutating-path read: retry once, then throw a clear actionable error. */
export function readJsonForUpdate(path, what = 'file') {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { /* torn or corrupt; retry once */ }
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch (err) {
    throw new Error(`${what} at ${path} is unreadable (${err.message}); it may be mid-write — retry the command`);
  }
}
