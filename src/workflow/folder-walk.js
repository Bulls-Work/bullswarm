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

// Folders that hold tool caches or build, coverage and test output, not
// work: a worker that only ran the tests (a __pycache__, a coverage/), ran a
// build (dist/, build/, target/) or installed packages has not produced
// anything (QA37 wave H). Log and TypeScript build-info files likewise.
const CACHES = new Set([
  ...SKIPPED, '__pycache__', '.pytest_cache', '.mypy_cache', '.ruff_cache', '.cache', '.venv', 'venv', '.tox', '.nyc_output',
  'dist', 'build', 'coverage', 'target',
]);
const OUTPUT_FILE = /\.(?:log|tsbuildinfo)$/;
export const IGNORED_MAX_FILES = 20000;

/**
 * The files of the entries `git ls-files --others --ignored --directory`
 * names (a folder ends in "/"), relative like the entries, sorted. Tool
 * caches and build output are skipped and links are not followed. Null when
 * there are more than `maxFiles` files: the ignored part is then not listed.
 */
export function walkIgnoredEntries(root, entries, { maxFiles = IGNORED_MAX_FILES } = {}) {
  const files = [];
  const pending = [];
  for (const entry of entries ?? []) {
    if (typeof entry !== 'string' || !entry) continue;
    const path = entry.replace(/\/+$/, '');
    if (path.split('/').some((part) => CACHES.has(part))) continue;
    if (entry.endsWith('/')) pending.push(path);
    else if (OUTPUT_FILE.test(path)) continue;
    else {
      try { if (lstatSync(join(root, path)).isFile()) files.push(path); } catch { /* gone */ }
    }
    if (files.length > maxFiles) return null;
  }
  while (pending.length) {
    const relative = pending.pop();
    let entriesHere;
    try { entriesHere = readdirSync(join(root, relative), { withFileTypes: true }); } catch { continue; }
    for (const entry of entriesHere) {
      if (CACHES.has(entry.name)) continue;
      const path = `${relative}/${entry.name}`;
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile() && !OUTPUT_FILE.test(entry.name)) files.push(path);
      if (files.length > maxFiles) return null;
    }
  }
  return files.sort();
}
