// The files of a folder git cannot see (0.37.0).
//
// Outside a git repository Bullswarm has no file list to compare, so a v3
// build or chore step that names no `files` used to pass without any check
// that it changed something. For those steps the dispatcher lists the folder
// itself, before and after the worker, and compares the files' bytes. The
// walk is bounded: `.git` and `node_modules` are skipped, symbolic links are
// not followed, and a folder over WALK_MAX_FILES files or WALK_MAX_BYTES bytes
// is not listed at all (the change then stays unchecked, as it was before).

import { lstatSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export const WALK_MAX_FILES = 5000;
export const WALK_MAX_BYTES = 64 * 1024 * 1024;
const SKIPPED = new Set(['.git', 'node_modules']);

/** The folder's files as relative paths ("a/b.md"), sorted; null when the folder is too large or unreadable. */
export function walkFolderFiles(root, { maxFiles = WALK_MAX_FILES, maxBytes = WALK_MAX_BYTES } = {}) {
  const files = [];
  let bytes = 0;
  const pending = [''];
  while (pending.length) {
    const relative = pending.pop();
    let entries;
    try { entries = readdirSync(join(root, relative), { withFileTypes: true }); }
    catch { if (relative === '') return null; continue; }
    for (const entry of entries) {
      const path = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!SKIPPED.has(entry.name)) pending.push(path);
        continue;
      }
      if (!entry.isFile()) continue;
      let size = 0;
      try { size = lstatSync(join(root, path)).size; } catch { continue; }
      bytes += size;
      files.push(path);
      if (files.length > maxFiles || bytes > maxBytes) return null;
    }
  }
  return files.sort();
}
