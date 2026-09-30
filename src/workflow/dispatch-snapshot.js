// The workspace snapshot around an attempt: the step's territory (git's
// tracked, untracked and ignored files, or the declared files outside git),
// byte digests before and after, the diff stat, HEAD, and direct stats of
// declared deliverable paths.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { readFileSync, statSync } from 'node:fs';
import { declaredDeliverable } from './step-vocabulary.js';
import { walkFolderFiles, walkIgnoredEntries } from './folder-walk.js';
import { isV3Step } from './program-v3.js';

const GIT_OPTS = {
  encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000,
  maxBuffer: 16 * 1024 * 1024,
};

function gitText(execFile, args, cwd) {
  try {
    return execFile('git', args, { cwd, ...GIT_OPTS });
  } catch {
    return null;
  }
}

// Null when git cannot see the workspace: `git ls-files` fails, or the
// workspace folder itself is ignored by its repository (a scratch folder in
// .gitignore lists nothing and hides every write). Both count as outside git.
export function trackedFiles(targetDir, execFile) {
  const output = gitText(execFile, ['ls-files', '-z'], targetDir);
  if (output == null) return null;
  if (gitText(execFile, ['check-ignore', '-q', '.'], targetDir) != null) return null;
  return new Set(output.split('\0').filter(Boolean));
}

// Untracked, not ignored files, relative to the workspace like `ls-files`.
// `git status` prints repository-root paths, which are wrong when the
// workspace is a subfolder of the repository.
function unignoredUntrackedFiles(targetDir, execFile) {
  const output = gitText(execFile, ['ls-files', '--others', '--exclude-standard', '-z'], targetDir);
  return output == null ? null : new Set(output.split('\0').filter(Boolean));
}

// Ignored files, relative to the workspace (QA 0.37.0 rerun, N1): a step may
// write its deliverable into a folder .gitignore lists. git names each
// ignored folder once (--directory); walkIgnoredEntries lists its files,
// bounded. Null when git fails or there are too many to list.
function ignoredFiles(targetDir, execFile) {
  const output = gitText(execFile, ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z'], targetDir);
  return output == null ? null : walkIgnoredEntries(targetDir, output.split('\0').filter(Boolean));
}

export function uniquePaths(paths) {
  const out = [];
  const seen = new Set();
  for (const path of paths ?? []) {
    if (typeof path !== 'string' || !path || seen.has(path)) continue;
    seen.add(path);
    out.push(path);
  }
  return out;
}

// `git` is false when git cannot see the workspace (trackedFiles). A declared
// deliverable then hashes its exact owned files and extra paths directly
// (D21); a legacy step does not.
export function territoryFiles(targetDir, ownedFiles, execFile, extraPaths = [], { directWhenUngit = false, walkWhenUngit = false } = {}) {
  const declared = Array.isArray(ownedFiles) ? ownedFiles.filter(Boolean) : [];
  const extras = uniquePaths(extraPaths);
  const tracked = trackedFiles(targetDir, execFile);
  if (tracked == null) {
    if (!directWhenUngit) return { ok: false, files: new Set(), tracked: new Set(), git: false };
    const direct = uniquePaths([...declared, ...extras]);
    // A v3 step that names no file: the folder's own files (folder-walk.js).
    const walked = !direct.length && walkWhenUngit ? walkFolderFiles(targetDir) : null;
    if (walked) return { ok: true, files: new Set(walked), tracked: new Set(), git: false };
    if (!direct.length) return { ok: false, files: new Set(), tracked: new Set(), git: false };
    return { ok: true, files: new Set(direct), tracked: new Set(), git: false };
  }
  if (declared.length) {
    const files = new Set(uniquePaths([...declared, ...extras]));
    return {
      ok: true,
      files,
      tracked: new Set([...files].filter((file) => tracked.has(file))),
      git: true,
    };
  }
  const untracked = unignoredUntrackedFiles(targetDir, execFile);
  if (untracked == null) return { ok: false, files: new Set(), tracked, git: true };
  // Too many ignored files to list leaves them out: the gate then compares
  // the tracked and untracked files, as before ignored files were listed.
  const ignored = ignoredFiles(targetDir, execFile);
  return {
    ok: true,
    files: new Set([...tracked, ...untracked, ...(ignored ?? []), ...extras]),
    tracked,
    ignored: ignored == null ? null : new Set(ignored),
    git: true,
  };
}

function fileDigest(targetDir, relativePath) {
  try {
    const bytes = readFileSync(join(targetDir, relativePath));
    return createHash('sha1').update(bytes).digest('hex');
  } catch {
    // A missing file is represented by null. A directory or an unreadable
    // path is treated the same way: if it becomes readable, the bytes differ
    // and the path is attributed; if it stays that way, there is no change to
    // report.
    return null;
  }
}

// An ignored file's bytes, like any other file, so a build that writes the
// same output again changes nothing (QA37 wave H). A file over
// IGNORED_HASH_MAX_BYTES is compared by size and modification time instead:
// an ignored folder can hold large data, and a file only crosses that bound
// when its size changes, which is a change either way.
const IGNORED_HASH_MAX_BYTES = 4 * 1024 * 1024;
function ignoredDigest(targetDir, relativePath) {
  try {
    const stat = statSync(join(targetDir, relativePath));
    if (!stat.isFile()) return null;
    return stat.size > IGNORED_HASH_MAX_BYTES ? `stat:${stat.size}:${stat.mtimeMs}` : fileDigest(targetDir, relativePath);
  } catch {
    return null;
  }
}

export function hashTerritory(targetDir, territory) {
  const hashes = new Map();
  const ignored = territory.ignored ?? new Set();
  for (const file of territory.files) {
    hashes.set(file, ignored.has(file) ? ignoredDigest(targetDir, file) : fileDigest(targetDir, file));
  }
  return {
    ok: territory.ok,
    files: new Set(territory.files),
    tracked: new Set(territory.tracked),
    // Absent when the territory lists no ignored files (declared files);
    // null when there were too many to list.
    ...(territory.ignored !== undefined ? { ignored: territory.ignored === null ? null : new Set(territory.ignored) } : {}),
    hashes,
  };
}

function lineCount(path) {
  try {
    const body = readFileSync(path, 'utf8');
    if (!body) return 0;
    return body.split(/\r\n|\n|\r/).length - (/[\r\n]$/.test(body) ? 1 : 0);
  } catch {
    return null;
  }
}

export function trackedStat(targetDir, files, execFile) {
  if (!files.length) return '';
  // HEAD includes both staged and unstaged bytes. Fall back to the plain diff
  // (and its cached counterpart) for repositories whose initial commit has
  // not been created yet.
  const args = ['--stat', 'HEAD', '--', ...files];
  const fromHead = gitText(execFile, ['diff', ...args], targetDir);
  if (fromHead != null) return fromHead.replace(/\s+$/, '');
  return [
    gitText(execFile, ['diff', '--stat', '--cached', '--', ...files], targetDir),
    gitText(execFile, ['diff', '--stat', '--', ...files], targetDir),
  ].filter((text) => text != null).map((text) => text.replace(/\s+$/, '')).filter(Boolean).join('\n');
}

function untrackedStat(targetDir, files) {
  return files.map((file) => {
    const lines = lineCount(join(targetDir, file));
    return lines == null
      ? `${file} | deleted (untracked)`
      : `${file} | +${lines} lines (new)`;
  }).join('\n');
}

// The commit HEAD points at, or null outside git or before the first commit.
// A commit step changes no file bytes but moves HEAD.
export function headCommit(targetDir, execFile) {
  return gitText(execFile, ['rev-parse', '--verify', '-q', 'HEAD'], targetDir)?.trim() || null;
}

// Direct file stats. Never calls git. A directory is not a produced file.
export function statDeliverablePaths(targetDir, paths) {
  const stats = new Map();
  for (const path of uniquePaths(paths)) {
    let exists = false;
    let sha1 = null;
    let mtimeMs = null;
    try {
      const stat = statSync(join(targetDir, path));
      if (stat.isFile()) {
        exists = true;
        sha1 = fileDigest(targetDir, path);
        mtimeMs = stat.mtimeMs;
      }
    } catch { /* missing or unreadable */ }
    stats.set(path, { exists, sha1, mtimeMs });
  }
  return stats;
}

// Git works, or the step names exact owned files or deliverable paths (D21),
// or a v3 step's folder is small enough to list (folder-walk.js).
export function snapshotPossible(targetDir, action) {
  if (trackedFiles(targetDir, execFileSync) != null) return true;
  const owned = Array.isArray(action?.ownedFiles) ? action.ownedFiles.filter(Boolean) : [];
  return owned.length > 0 || (declaredDeliverable(action)?.paths?.length ?? 0) > 0
    || (isV3Step(action) && walkFolderFiles(targetDir) != null);
}

/**
 * Compare byte hashes taken immediately before and after the attempt. This
 * deliberately does not subtract the pre-attempt dirty set: a further edit
 * to a pre-dirty file is a change during this attempt, while new and deleted
 * paths compare against a missing hash. The stat is captured at this same
 * boundary, before sibling callbacks can edit the territory.
 */
export function captureDiffSnapshot(targetDir, ownedFiles, before, execFile = execFileSync, extraPaths = [], options = {}) {
  if (!before?.ok) return { ok: false, statText: '', changedFiles: [] };
  const afterTerritory = territoryFiles(targetDir, ownedFiles, execFile, extraPaths, options);
  if (!afterTerritory.ok) return { ok: false, statText: '', changedFiles: [] };
  // Ignored files count only when both listings have them; a listing that
  // went over its bound on one side must not read as every file appearing
  // or vanishing.
  const unlisted = before.ignored === null || afterTerritory.ignored === null
    ? new Set([...(before.ignored ?? []), ...(afterTerritory.ignored ?? [])])
    : new Set();
  const ignored = new Set([...(before.ignored ?? []), ...(afterTerritory.ignored ?? [])]);
  const files = new Set([...before.files, ...afterTerritory.files].filter((file) => !unlisted.has(file)));
  const after = hashTerritory(targetDir, { ...afterTerritory, files, ignored });
  const changedFiles = [...files].filter((file) => before.hashes.get(file) !== after.hashes.get(file)).sort();
  const tracked = changedFiles.filter((file) => before.tracked.has(file) || after.tracked.has(file));
  const untracked = changedFiles.filter((file) => !before.tracked.has(file) && !after.tracked.has(file));
  const pieces = [
    trackedStat(targetDir, tracked, execFile),
    untrackedStat(targetDir, untracked),
  ].filter(Boolean);
  return { ok: true, statText: pieces.join('\n'), changedFiles };
}
