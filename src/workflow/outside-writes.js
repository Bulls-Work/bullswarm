// Files a worker wrote outside the run's cwd (Second Mate, 2026-10-14: six
// runs edited ~/Repo/second-mate-hands from a cwd in ~/Repo/second-mate-desk
// and failed `not-produced: no file changed` though the work landed). The
// cwd diff cannot see them, so this reads the worker's own tool calls from
// its stream: the paths its Edit/Write calls name, and the absolute paths and
// `cd` targets in its shell commands. A named file counts when its mtime is
// at or after the attempt start. A directory counts only through files under
// it, changed since the start, whose name the worker's own commands mention,
// so another agent's edit nearby is not credited to this worker.
import { readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';

const FILE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'edit', 'write', 'apply_patch']);
const SKIP_DIRS = new Set(['.git', 'node_modules', '.next', 'dist', 'build', 'coverage', 'target', '__pycache__', '.venv']);
const MAX_SCAN = 5000;
const MAX_DEPTH = 4;
const MAX_LISTED = 50;
// An absolute path (or ~/ path) in a shell command, ended by a shell separator.
const PATH_IN_COMMAND = /(?:^|[\s'"=(:])((?:~\/|\/)[^\s'"`;|&<>()$*?]+)/g;
const CD_TARGET = /(?:^|[;&|(]\s*|\s)cd\s+(?:--\s+)?(['"]?)((?:~\/|\/)[^\s'"`;|&<>()]+)\1/g;

const home = () => { try { return homedir(); } catch { return ''; } };
const expand = (path) => (path.startsWith('~/') ? join(home(), path.slice(2)) : path);
const real = (path) => { try { return realpathSync(path); } catch { return resolve(path); } };
const inside = (path, dir) => path === dir || path.startsWith(dir.endsWith(sep) ? dir : dir + sep);
const statOf = (path) => { try { return statSync(path); } catch { return null; } };

function toolCalls(streamFile) {
  let text = '';
  try { text = readFileSync(streamFile, 'utf8'); } catch { return []; }
  const calls = [];
  for (const line of text.split('\n')) {
    if (!line.includes('"toolName"')) continue;
    try {
      const event = JSON.parse(line);
      if (event?.toolName) calls.push({ tool: String(event.toolName), args: event.arguments ?? {} });
    } catch { /* a torn line */ }
  }
  return calls;
}

// Paths the worker named: files it edited with a file tool, and the
// directories and paths its shell commands name. Returns absolute paths.
export function namedPaths(calls) {
  const files = new Set();
  const dirs = new Set();
  const commands = [];
  for (const { tool, args } of calls) {
    if (FILE_TOOLS.has(tool)) {
      for (const key of ['file_path', 'notebook_path', 'path']) {
        if (typeof args?.[key] === 'string' && (isAbsolute(args[key]) || args[key].startsWith('~/'))) files.add(expand(args[key]));
      }
      continue;
    }
    const command = typeof args?.command === 'string' ? args.command : Array.isArray(args?.command) ? args.command.join(' ') : null;
    if (!command) continue;
    commands.push(command);
    for (const match of command.matchAll(CD_TARGET)) dirs.add(expand(match[2]));
    for (const match of command.matchAll(PATH_IN_COMMAND)) {
      const path = expand(match[1].replace(/[.,:]+$/, ''));
      if (path.length > 1) dirs.add(path);
    }
  }
  return { files: [...files], dirs: [...dirs], commands };
}

function scanChanged(dir, [sinceMs, untilMs], mentioned, out, budget, depth = 0) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    if (budget.left-- <= 0) return;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (depth < MAX_DEPTH && !SKIP_DIRS.has(entry.name) && !entry.name.startsWith('.')) scanChanged(path, [sinceMs, untilMs], mentioned, out, budget, depth + 1);
    } else if (entry.isFile() && mentioned(entry.name)) {
      const stat = statOf(path);
      if (stat && stat.mtimeMs >= sinceMs && stat.mtimeMs <= untilMs) out.add(path);
    }
  }
}

/**
 * Files outside `targetDir` that this attempt's worker changed, from its
 * stream. `[]` when it named none or none changed since `startedAtMs`.
 * Paths are absolute and sorted, at most 50. Never throws.
 */
export function outsideWrites({ streamFile, targetDir, startedAtMs, endedAtMs = Infinity, calls = null, scratchDirs = null } = {}) {
  if (!Number.isFinite(startedAtMs)) return [];
  try {
    const cwd = real(targetDir ?? process.cwd());
    const named = namedPaths(calls ?? (streamFile ? toolCalls(streamFile) : []));
    // Bullswarm's own run folder (task, output and stream files) is not work,
    // nor a loose scratch file straight in a temp folder (/tmp/x.txt); a
    // project folder under a temp folder is.
    const temps = scratchDirs ?? [...new Set(['/tmp', '/private/tmp', real(tmpdir())])];
    const skip = (path) => inside(path, cwd) || temps.includes(dirname(path))
      || (streamFile && inside(path, real(join(streamFile, '..'))));
    const changed = new Set();
    for (const file of named.files) {
      const path = real(file);
      if (skip(path)) continue;
      const stat = statOf(path);
      if (stat?.isFile() && stat.mtimeMs >= startedAtMs && stat.mtimeMs <= endedAtMs) changed.add(path);
    }
    const text = named.commands.join('\n');
    const mentioned = (name) => name.length > 2 && text.includes(name);
    const budget = { left: MAX_SCAN };
    for (const dir of named.dirs) {
      const path = real(dir);
      // Never a broad scan: not home, its parents, or a folder right under it.
      const h = home();
      if (skip(path) || temps.includes(path) || path.split(sep).length < 3 || inside(h, path) || (h && path.startsWith(h + sep) && !path.slice(h.length + 1).includes(sep))) continue;
      const stat = statOf(path);
      if (!stat) continue;
      if (stat.isFile()) {
        if (stat.mtimeMs >= startedAtMs && stat.mtimeMs <= endedAtMs && mentioned(basename(path))) changed.add(path);
      } else if (stat.isDirectory()) {
        scanChanged(path, [startedAtMs, endedAtMs], mentioned, changed, budget);
      }
    }
    return [...changed].filter((path) => !skip(path)).sort().slice(0, MAX_LISTED);
  } catch {
    return [];
  }
}

/**
 * Marks decision-log rows that failed `not-produced` although their worker
 * wrote files outside the cwd (rows from before this check existed). Reads
 * each row's stream beside its output file and the cwd its routing names;
 * sets `falseFailure` so ok-share stats skip it. Returns how many it marked.
 * The row's `ok` and `failureKind` stay as recorded.
 */
const runCwd = (row) => {
  try { return JSON.parse(readFileSync(join(row.outFile, '..', 'project.json'), 'utf8')).cwd ?? null; } catch { return null; }
};

export function markOutsideFalseFailures(decisionLog, { cwdOf = runCwd, scratchDirs = null } = {}) {
  let marked = 0;
  const falseSteps = new Set();
  const stepOf = (row) => `${join(row.outFile, '..')}#${row.actionId ?? ''}`;
  for (const row of Array.isArray(decisionLog) ? decisionLog : []) {
    if (row?.failureKind !== 'not-produced' || typeof row.outFile !== 'string') continue;
    if (row.falseFailure) { falseSteps.add(stepOf(row)); continue; }
    // The same-pool retry a false failure caused, finding the work done.
    if (falseSteps.has(stepOf(row))) {
      row.falseFailure = 'retry after a false not-produced';
      marked += 1;
      continue;
    }
    const streamFile = join(row.outFile, '..', basename(row.outFile).replace(/^out-/, 'stream-').replace(/\.md$/, '.jsonl'));
    const endMs = Date.parse(row.ts);
    const startedAtMs = endMs - (Number(row.wallSec) || 0) * 1000;
    const targetDir = cwdOf(row);
    if (!targetDir || !Number.isFinite(startedAtMs)) continue;
    // A file changed again since the run ended carries the later mtime and is
    // missed: a backfill can under-count, never credit later work.
    const files = outsideWrites({ streamFile, targetDir, startedAtMs, endedAtMs: endMs + 60_000, scratchDirs });
    if (!files.length) continue;
    row.falseFailure = `changed outside cwd: ${files.length} file${files.length === 1 ? '' : 's'}`;
    row.changedOutsideCwd = files.length;
    falseSteps.add(stepOf(row));
    marked += 1;
  }
  return marked;
}
