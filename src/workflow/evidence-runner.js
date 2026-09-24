// The stage-2 evidence runner (spec E5-E12, E16, E19, E26; §2.4-§2.7).
//
// After a program step's worker finishes, the kernel runs the step's declared
// checks itself: a shell command that must exit 0, or a JSON file that must
// match a schema (bin/check-schema.js in a child process). Checks run one at
// a time, asynchronously (the kernel heartbeat must keep beating), each in its
// own process group that is always killed when the shell exits, so a check
// that starts a background server leaves nothing running.
//
// Imports only Node built-ins, BoundedCapture and clipUtf8.

import { spawn as nodeSpawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  appendFileSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmdirSync, rmSync, writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BoundedCapture } from '../lib/watch.js';
import { clipUtf8 } from '../lib/attempt-stream.js';

export const EVIDENCE_MAX_ITEMS = 5;
export const EVIDENCE_DEFAULT_TIMEOUT_SEC = 120;
export const EVIDENCE_MAX_TIMEOUT_SEC = 600;
export const EVIDENCE_TAIL_BYTES = 2048;
export const EVIDENCE_LOG_BYTES = 1024 * 1024;
export const EVIDENCE_HEARTBEAT_MS = 30_000;
export const EVIDENCE_CANCEL_POLL_MS = 250;
export const EVIDENCE_KILL_GRACE_MS = 2000;
export const CHECKER_PATH = fileURLToPath(new URL('../../bin/check-schema.js', import.meta.url));
export const EVIDENCE_ENV_KEYS = Object.freeze(['BULLSWARM_EVIDENCE', 'BULLSWARM_STEP_ID', 'BULLSWARM_STEP_OUTPUT', 'BULLSWARM_RUN_DIR']);
export const EVIDENCE_OUTPUT_FILE = '$output';

const MAX_LISTED_PATHS = 20;
const MAX_STORED_ERRORS = 5;
const MAX_ERROR_CHARS = 200;
const MAX_STORED_NOTES = 3;
const LABEL_CHARS = 80;
const WHY_LINE_CHARS = 100;
const WHY_CHARS = 240;
const ITEM_WHY_CHARS = 1000;
const DEPTH_ENV = 'BULLSWARM_DEPTH';
const GIT_OPTS = { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000, maxBuffer: 64 * 1024 * 1024 };
const IGNORED_TREES = new Set(['node_modules']);

// ---------------------------------------------------------------------------
// Text helpers

const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;

export function stripAnsi(text) {
  return String(text ?? '').replace(ANSI, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

/**
 * The end of `text` in at most `bytes` UTF-8 bytes, never splitting a
 * character, and cut at a line start when the window holds a line break.
 */
export function tailLines(text, bytes = EVIDENCE_TAIL_BYTES) {
  const source = String(text ?? '');
  if (Buffer.byteLength(source, 'utf8') <= bytes) return source;
  let lo = 0;
  let hi = source.length;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (Buffer.byteLength(source.slice(mid), 'utf8') <= bytes) hi = mid;
    else lo = mid + 1;
  }
  if (lo < source.length && /[\uDC00-\uDFFF]/.test(source[lo])) lo += 1;
  const window = source.slice(lo);
  if (lo > 0 && source[lo - 1] !== '\n') {
    const newline = window.indexOf('\n');
    if (newline >= 0 && newline < window.length - 1) return window.slice(newline + 1);
  }
  return window;
}

function cutChars(text, max) {
  const value = String(text ?? '');
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function cutAtWord(text, max) {
  const value = String(text ?? '');
  if (value.length <= max) return value;
  const head = value.slice(0, max - 1);
  const space = head.lastIndexOf(' ');
  return `${(space >= max / 2 ? head.slice(0, space) : head).trimEnd()}…`;
}

function listPaths(paths) {
  return [...paths].slice(0, MAX_LISTED_PATHS);
}

const isOutputItem = (item) => item?.type === 'schema' && item.file === EVIDENCE_OUTPUT_FILE;

export function evidenceItemFormat(item) {
  if (item?.format === 'json' || item?.format === 'jsonl') return item.format;
  if (isOutputItem(item)) return 'json';
  return /\.(jsonl|ndjson)$/i.test(String(item?.file ?? '')) ? 'jsonl' : 'json';
}

export function evidenceItemTimeoutSec(item) {
  return Number.isInteger(item?.timeoutSec) ? item.timeoutSec : EVIDENCE_DEFAULT_TIMEOUT_SEC;
}

/** The cut `cmd`, or `schema <schema> on <file>` (`on your final response` for `$output`). */
export function evidenceItemLabel(item) {
  if (item?.type === 'schema') {
    return `schema ${item.schema} on ${isOutputItem(item) ? 'your final response' : item.file}`;
  }
  return cutAtWord(item?.cmd ?? '', LABEL_CHARS);
}

// ---------------------------------------------------------------------------
// Brief and env

/** The §2.11 brief paragraph and its conditional lines. */
export function evidenceBriefLines(items, { targetDir, checkerPath = CHECKER_PATH, role = null, privateWorkspace = false } = {}) {
  const list = Array.isArray(items) ? items : [];
  if (!list.length) return [];
  const lines = [`Bullswarm will run these after you finish, in ${targetDir}, and fails this step if any of them fails:`];
  for (const item of list) {
    const timeoutSec = evidenceItemTimeoutSec(item);
    if (item.type === 'command') {
      lines.push(`- command: \`${item.cmd}\` (passes on exit code 0; stopped after ${timeoutSec}s)`);
    } else if (isOutputItem(item)) {
      const what = evidenceItemFormat(item) === 'jsonl' ? 'only JSON Lines, one record per line,' : 'only JSON';
      lines.push(`- schema: your final response must be ${what} that matches the JSON schema ${item.schema}; Bullswarm checks the saved response`);
    } else {
      const format = evidenceItemFormat(item);
      const byName = /\.(jsonl|ndjson)$/i.test(item.file) ? 'jsonl' : 'json';
      const flag = format === byName ? '' : ` --format ${format}`;
      lines.push(`- schema: ${item.file} must match the JSON schema ${item.schema} (check it yourself: node ${checkerPath}${flag} ${item.file} ${item.schema})`);
    }
  }
  lines.push('Run them yourself before you finish and fix what fails. Do not change what they check (tests, schemas, scripts) to make them pass. A check that modifies your deliverable fails.');
  if (list.some((item) => isOutputItem(item) || (item.type === 'command' && String(item.cmd).includes('BULLSWARM_STEP_OUTPUT')))) {
    lines.push('Checks that read your final response ($BULLSWARM_STEP_OUTPUT) can only run after you finish; make your final response exactly what they expect.');
  }
  if (role === 'act') {
    lines.push('Never repeat an action to make a check pass; a failed check goes to the caller, not back to you.');
  }
  if (privateWorkspace) {
    lines.push('Only your territory files are merged back. Delete any file a check you ran created outside them before you finish, or the step fails as out of scope.');
  }
  return lines;
}

function realPath(path) {
  try { return realpathSync(path); } catch { return resolve(path); }
}

/** The E6 env: the kernel's own env with the depth raised by one, and the four BULLSWARM_* variables. */
export function evidenceEnv(parentEnv = process.env, { cwd, stepId, outFile, runDir } = {}) {
  const depth = Number.parseInt(parentEnv?.[DEPTH_ENV] ?? '0', 10);
  return {
    ...parentEnv,
    [DEPTH_ENV]: String((Number.isFinite(depth) && depth >= 0 ? depth : 0) + 1),
    PWD: realPath(cwd),
    BULLSWARM_EVIDENCE: '1',
    BULLSWARM_STEP_ID: String(stepId ?? ''),
    BULLSWARM_STEP_OUTPUT: resolve(outFile),
    BULLSWARM_RUN_DIR: resolve(runDir),
  };
}

/** In an isolated run, replace the caller's cwd inside each `cmd` with the copy (the prompt's rule). */
export function rewriteEvidenceCwd(items, fromDir, toDir) {
  if (!Array.isArray(items) || !fromDir || !toDir || fromDir === toDir) return items;
  return items.map((item) => (item?.type === 'command' && typeof item.cmd === 'string'
    ? { ...item, cmd: item.cmd.split(fromDir).join(toDir) }
    : item));
}

// ---------------------------------------------------------------------------
// One item

function parseCheckerReport(text) {
  const lines = String(text ?? '').split('\n');
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index].trim();
    if (!line.startsWith('{')) continue;
    try {
      const value = JSON.parse(line);
      if (value && typeof value === 'object' && Number.isInteger(value.exit)) return value;
    } catch { /* not the report line */ }
  }
  return null;
}

function seconds(ms) {
  return `${(ms / 1000).toFixed(1)}s`;
}

function writeLog(logFile, { header, body, footer }) {
  if (!logFile) return null;
  try {
    mkdirSync(dirname(logFile), { recursive: true });
    const text = body ? (body.endsWith('\n') ? body : `${body}\n`) : '';
    writeFileSync(logFile, `${header.join('\n')}\n${text}${footer}\n`);
    return resolve(logFile);
  } catch {
    return null;
  }
}

/**
 * Run one evidence item. Resolves to
 * `{ status, exit, timedOut?, signal?, stopped?, durationMs, tail, log, why,
 *    errorCount?, errors?, notes?, fault? }` (§2.4, §2.6). `status` is
 * `passed`, `failed`, or `not-run` with `stopped: true` (E16).
 */
export function runEvidenceItem(item, {
  cwd, env = process.env, outFile, logFile, onSpawn = null, onWorkerExit = null,
  shouldCancel = () => false, onHeartbeat = null, spawn = nodeSpawn, now = Date.now,
  killGrace = EVIDENCE_KILL_GRACE_MS, heartbeatMs = EVIDENCE_HEARTBEAT_MS, pollMs = EVIDENCE_CANCEL_POLL_MS,
  checkerPath = CHECKER_PATH, execPath = process.execPath,
} = {}) {
  const timeoutSec = evidenceItemTimeoutSec(item);
  const realCwd = realPath(cwd);
  const schemaItem = item?.type === 'schema';
  const command = schemaItem ? execPath : '/bin/sh';
  const args = schemaItem
    ? [checkerPath, '--json', '--format', evidenceItemFormat(item), ...(isOutputItem(item) ? ['--unfence'] : []),
      isOutputItem(item) ? resolve(outFile) : item.file, item.schema]
    : ['-c', item.cmd];
  const shown = schemaItem ? `${command} ${args.join(' ')}` : item.cmd;
  const header = [`$ ${clipUtf8(shown, 8192)}`, `cwd: ${realCwd}`, `timeout: ${timeoutSec}s`];
  const capture = new BoundedCapture(EVIDENCE_LOG_BYTES);
  const startedAt = now();

  return new Promise((resolvePromise) => {
    let child;
    let pid = null;
    let killedFor = null;
    let exited = false;
    let settled = false;
    const timers = new Set();
    const later = (fn, ms) => { const timer = setTimeout(() => { timers.delete(timer); fn(); }, ms); timers.add(timer); return timer; };
    const clearAll = () => { for (const timer of timers) { clearTimeout(timer); clearInterval(timer); } timers.clear(); };
    const killGroup = (signal) => {
      if (!pid) return;
      try { process.kill(-pid, signal); } catch { /* ESRCH: the group is gone */ }
    };
    const stopGroup = (reason) => {
      if (killedFor || exited) return;
      killedFor = reason;
      killGroup('SIGTERM');
      later(() => killGroup('SIGKILL'), killGrace);
    };

    const finish = (result, footer) => {
      if (settled) return;
      settled = true;
      clearAll();
      const durationMs = Math.max(0, now() - startedAt);
      const raw = capture.text();
      const log = writeLog(logFile, { header, body: raw, footer: `${footer} after ${seconds(durationMs)}` });
      const tail = tailLines(stripAnsi(capture.tail(EVIDENCE_TAIL_BYTES * 4)), EVIDENCE_TAIL_BYTES).replace(/\s+$/, '');
      resolvePromise({ ...result, durationMs, tail, log });
    };

    const couldNotStart = (error) => finish(
      { status: 'failed', exit: null, why: `could not start: ${error?.message ?? String(error)}` },
      'could not start',
    );

    try {
      child = spawn(command, args, { cwd: realCwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      couldNotStart(error);
      return;
    }
    pid = child.pid ?? null;
    if (pid) {
      try { onSpawn?.(pid); } catch { /* registry errors never stop a check */ }
    }
    for (const stream of [child.stdout, child.stderr]) {
      if (!stream) continue;
      stream.setEncoding('utf8');
      stream.on('data', (chunk) => capture.push(chunk));
      stream.on('error', () => {});
    }

    child.on('error', (error) => {
      if (exited) return;
      exited = true;
      if (pid) { killGroup('SIGKILL'); try { onWorkerExit?.(pid); } catch { /* ignore */ } }
      couldNotStart(error);
    });

    if (!pid) return; // the 'error' event follows

    later(() => stopGroup('timeout'), timeoutSec * 1000);
    const poll = setInterval(() => {
      let cancel = false;
      try { cancel = Boolean(shouldCancel()); } catch { cancel = false; }
      if (cancel) stopGroup('cancel');
    }, pollMs);
    timers.add(poll);
    if (onHeartbeat && heartbeatMs > 0) {
      const beat = setInterval(() => { try { onHeartbeat({ stage: 'running' }); } catch { /* ignore */ } }, heartbeatMs);
      timers.add(beat);
    }

    child.on('exit', (code, signal) => {
      if (exited) return;
      exited = true;
      clearAll();
      // Always kill the group: a background child must not outlive the check
      // or hold the output pipes open.
      killGroup('SIGKILL');
      try { onWorkerExit?.(pid); } catch { /* ignore */ }
      let closed = false;
      const done = () => {
        if (closed) return;
        closed = true;
        child.stdout?.destroy();
        child.stderr?.destroy();
        let cancelled = false;
        try { cancelled = Boolean(shouldCancel()); } catch { cancelled = false; }
        if (killedFor === 'cancel' || cancelled) {
          finish({ status: 'not-run', exit: null, stopped: true, why: 'stopped' }, 'stopped');
          return;
        }
        if (killedFor === 'timeout') {
          finish({ status: 'failed', exit: null, timedOut: true, why: `timed out after ${timeoutSec}s` }, 'timed out');
          return;
        }
        if (signal) {
          finish({ status: 'failed', exit: null, signal, why: `killed by ${signal}` }, `killed by ${signal}`);
          return;
        }
        const exit = code ?? null;
        if (schemaItem) {
          finish(schemaOutcome(exit, parseCheckerReport(capture.text())), `exit ${exit}`);
          return;
        }
        finish(exit === 0
          ? { status: 'passed', exit: 0, why: null }
          : { status: 'failed', exit, why: `exit ${exit}` }, `exit ${exit}`);
      };
      child.once('close', done);
      const graceTimer = setTimeout(done, killGrace);
      child.once('close', () => clearTimeout(graceTimer));
    });
  });
}

function schemaOutcome(exit, report) {
  const extra = {};
  if (report) {
    if (report.errorCount > 0) extra.errorCount = report.errorCount;
    const errors = Array.isArray(report.errors) ? report.errors.slice(0, MAX_STORED_ERRORS).map((error) => cutChars(error, MAX_ERROR_CHARS)) : [];
    if (errors.length) extra.errors = errors;
    const notes = Array.isArray(report.notes) ? report.notes.slice(0, MAX_STORED_NOTES).map((note) => cutChars(note, MAX_ERROR_CHARS)) : [];
    if (notes.length) extra.notes = notes;
  }
  if (exit === 0) return { status: 'passed', exit: 0, why: null, ...extra };
  if (report && (exit === 1 || exit === 2) && report.exit === exit && report.why) {
    return { status: 'failed', exit, why: String(report.why), ...extra, ...(exit === 2 && report.fault === 'check' ? { fault: 'check' } : {}) };
  }
  return { status: 'failed', exit, why: `exit ${exit}`, ...extra };
}

// ---------------------------------------------------------------------------
// Side-effect scope (E11, §2.5)

function sha1File(absolutePath) {
  try { return createHash('sha1').update(readFileSync(absolutePath)).digest('hex'); } catch { return null; }
}

function gitText(execFile, args, cwd) {
  try { return execFile('git', args, { cwd, ...GIT_OPTS }); } catch { return null; }
}

const inIgnoredTree = (path) => path.split('/').some((segment) => IGNORED_TREES.has(segment));

// Null when git cannot see the workspace (not a repository, or the workspace
// folder is itself ignored). Paths are relative to the workspace, which may be
// a subfolder of the repository.
function gitTracked(cwd, execFile) {
  const output = gitText(execFile, ['ls-files', '-z'], cwd);
  if (output == null) return null;
  if (gitText(execFile, ['check-ignore', '-q', '.'], cwd) != null) return null;
  return output.split('\0').filter(Boolean);
}

function gitUntracked(cwd, execFile) {
  const output = gitText(execFile, ['ls-files', '--others', '--exclude-standard', '-z'], cwd);
  return output == null ? [] : output.split('\0').filter((path) => path && !inIgnoredTree(path));
}

function gitHead(cwd, execFile) {
  return gitText(execFile, ['rev-parse', '--verify', '-q', 'HEAD'], cwd)?.trim() || null;
}

function walkFiles(root) {
  const files = [];
  const walk = (directory) => {
    let entries;
    try { entries = readdirSync(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.name === '.git' || IGNORED_TREES.has(entry.name)) continue;
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) walk(absolute);
      else if (entry.isFile() || entry.isSymbolicLink()) files.push(relative(root, absolute).split(sep).join('/'));
    }
  };
  walk(root);
  return files.sort();
}

const unique = (paths) => [...new Set(paths.filter((path) => typeof path === 'string' && path))];

/**
 * The §2.5 scope for one step. `mode` is `private`, `restricted`,
 * `unrestricted` or `other`. The listing is frozen at the first `hash()`
 * (item 1). `head()` returns the commit only where HEAD is compared
 * (unrestricted, private with git), otherwise null; `observedHead()` always
 * returns it (null outside git) for the `headMoved` fact. `untracked()`
 * returns a Map of unignored untracked files outside the scope → sha1 for
 * `private` and `unrestricted`, else null.
 */
export function evidenceScope({ mode, cwd, ownedFiles = [], declaredPaths = [], extraPaths = [], outFile = null, execFile = execFileSync } = {}) {
  const root = realPath(cwd);
  const tracked = gitTracked(root, execFile);
  const git = tracked != null;
  let effective = ['private', 'restricted', 'unrestricted', 'other'].includes(mode) ? mode : 'other';
  if (effective === 'unrestricted' && !git) effective = 'other';
  const out = outFile ? resolve(outFile) : null;
  let frozen = null;

  const freeze = () => {
    if (frozen) return frozen;
    let paths;
    if (effective === 'restricted') paths = [...ownedFiles, ...declaredPaths, ...extraPaths];
    else if (effective === 'unrestricted') paths = [...(gitTracked(root, execFile) ?? []), ...declaredPaths];
    else if (effective === 'private') paths = [...(git ? (gitTracked(root, execFile) ?? []) : walkFiles(root)), ...ownedFiles, ...declaredPaths];
    else paths = [...declaredPaths];
    frozen = unique([...paths, ...(out ? [out] : [])]);
    return frozen;
  };
  const inScope = () => new Set(freeze());
  const absolute = (path) => (isAbsolute(path) ? path : join(root, path));
  const comparesHead = git && (effective === 'unrestricted' || effective === 'private');
  const listsUntracked = effective === 'unrestricted' || effective === 'private';

  return {
    mode: effective,
    git,
    comparesHead,
    cwd: root,
    paths: () => [...freeze()],
    hash() {
      const hashes = new Map();
      for (const path of freeze()) hashes.set(path, sha1File(absolute(path)));
      return hashes;
    },
    head: () => (comparesHead ? gitHead(root, execFile) : null),
    observedHead: () => (git ? gitHead(root, execFile) : null),
    untracked() {
      if (!listsUntracked) return null;
      const scope = inScope();
      const listing = git ? gitUntracked(root, execFile) : walkFiles(root);
      const result = new Map();
      for (const path of listing) if (!scope.has(path)) result.set(path, sha1File(absolute(path)));
      return result;
    },
  };
}

/**
 * E26: `{ <schema path>: sha1 | null }` for each schema item, taken at the
 * step baseline. runStepEvidence compares with the same hashing, so dispatch
 * should build `schemaBaseline` with this.
 */
export function evidenceSchemaBaseline(items, cwd) {
  const root = realPath(cwd);
  const baseline = {};
  for (const item of Array.isArray(items) ? items : []) {
    if (item?.type === 'schema' && typeof item.schema === 'string' && !Object.hasOwn(baseline, item.schema)) {
      baseline[item.schema] = sha1File(join(root, item.schema));
    }
  }
  return baseline;
}

function changedKeys(before, after) {
  const keys = new Set([...(before?.keys() ?? []), ...(after?.keys() ?? [])]);
  return [...keys].filter((key) => (before?.get(key) ?? null) !== (after?.get(key) ?? null)).sort();
}

/**
 * Delete the files a check created outside a private copy's scope, then any
 * directory that became empty (never `cwd` itself). Returns the removed paths.
 */
export function removeCreatedOutOfScope(cwd, paths) {
  const root = realPath(cwd);
  const removed = [];
  const parents = new Set();
  for (const path of paths ?? []) {
    const target = resolve(root, path);
    if (target === root || !target.startsWith(`${root}${sep}`)) continue;
    try {
      lstatSync(target);
      rmSync(target, { force: true });
      removed.push(path);
      for (let dir = dirname(target); dir !== root && dir.startsWith(`${root}${sep}`); dir = dirname(dir)) parents.add(dir);
    } catch { /* already gone */ }
  }
  for (const dir of [...parents].sort((a, b) => b.length - a.length)) {
    try { rmdirSync(dir); } catch { /* not empty */ }
  }
  return removed;
}

// ---------------------------------------------------------------------------
// The step

function baseEntry(item) {
  if (item?.type === 'schema') {
    return {
      type: 'schema', file: item.file, schema: item.schema,
      ...(item.format ? { format: item.format } : {}),
      timeoutSec: evidenceItemTimeoutSec(item),
    };
  }
  return { type: 'command', cmd: item?.cmd, timeoutSec: evidenceItemTimeoutSec(item) };
}

function notRunEntry(item, why) {
  // Never started, so there is no log: the key is absent, not null.
  return { ...baseEntry(item), status: 'not-run', exit: null, durationMs: 0, tail: '', why };
}

function displayPath(path, root) {
  if (!isAbsolute(path)) return path;
  const rel = relative(root, path);
  return rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel.split(sep).join('/') : path;
}

/**
 * Run a step's evidence items in order (E10). Resolves to
 * `{ results, failed, stopped, checkFault, why, createdOutOfScope }`.
 * `why` is the §2.7 step why when an item failed, `evidence stopped` on a stop.
 */
export async function runStepEvidence(items, {
  cwd, env = process.env, outFile, logFileFor = () => null, scope = null, schemaBaseline = null,
  onSpawn = null, onWorkerExit = null, shouldCancel = () => false, onEvidence = null,
  spawn = nodeSpawn, now = Date.now, killGrace, heartbeatMs, pollMs, checkerPath, execPath,
} = {}) {
  const list = Array.isArray(items) ? items.slice(0, EVIDENCE_MAX_ITEMS) : [];
  const root = realPath(cwd);
  const results = [];
  const emit = (event) => { try { onEvidence?.(event); } catch { /* observers never stop checks */ } };
  const cancelled = () => { try { return Boolean(shouldCancel()); } catch { return false; } };
  let stop = null;

  let prevHash = scope ? scope.hash() : null;
  let prevHead = scope ? scope.head() : null;
  const firstUntracked = scope ? scope.untracked() : null;
  let prevUntracked = firstUntracked;

  for (let index = 0; index < list.length; index += 1) {
    const item = list[index];
    if (stop === 'changed') { results.push(notRunEntry(item, 'not run: an earlier item changed the deliverable')); continue; }
    if (stop === 'stopped' || cancelled()) { stop = 'stopped'; results.push(notRunEntry(item, 'stopped')); continue; }

    const label = evidenceItemLabel(item);
    const position = { index: index + 1, of: list.length, type: item.type, label };
    emit({ stage: 'started', ...position });

    let schemaChanged = false;
    if (item.type === 'schema' && schemaBaseline) {
      const baseline = schemaBaseline instanceof Map ? schemaBaseline : new Map(Object.entries(schemaBaseline));
      if (baseline.has(item.schema)) schemaChanged = baseline.get(item.schema) !== sha1File(join(root, item.schema));
    }
    const observedBefore = scope ? scope.observedHead() : null;

    const run = await runEvidenceItem(item, {
      cwd: root, env, outFile, logFile: logFileFor(index + 1), onSpawn, onWorkerExit, shouldCancel,
      onHeartbeat: () => emit({ stage: 'running', ...position }), spawn, now,
      ...(killGrace != null ? { killGrace } : {}),
      ...(heartbeatMs != null ? { heartbeatMs } : {}),
      ...(pollMs != null ? { pollMs } : {}),
      ...(checkerPath ? { checkerPath } : {}),
      ...(execPath ? { execPath } : {}),
    });

    const entry = { ...baseEntry(item), status: run.status, exit: run.exit };
    if (run.timedOut) entry.timedOut = true;
    if (run.signal) entry.signal = run.signal;
    entry.durationMs = run.durationMs;
    if (run.errorCount != null) entry.errorCount = run.errorCount;
    if (run.errors) entry.errors = run.errors;
    if (run.notes) entry.notes = run.notes;
    let why = run.why;
    const facts = [];

    if (run.stopped) {
      stop = 'stopped';
    } else if (scope) {
      const hash = scope.hash();
      const changed = changedKeys(prevHash, hash).map((path) => displayPath(path, root));
      const head = scope.head();
      if (head !== prevHead) changed.push('HEAD');
      prevHash = hash;
      prevHead = head;
      if (!scope.comparesHead && scope.git) {
        const observedAfter = scope.observedHead();
        if (observedAfter !== observedBefore) { entry.headMoved = true; facts.push('also: HEAD moved while it ran (another step may have committed)'); }
      }
      const untracked = scope.untracked();
      if (untracked && prevUntracked) {
        const touched = changedKeys(prevUntracked, untracked);
        if (touched.length) { entry.touched = listPaths(touched); facts.push(`also: touched ${entry.touched.join(', ')}`); }
      }
      if (untracked) prevUntracked = untracked;
      if (changed.length) {
        entry.status = 'failed';
        entry.changed = listPaths(changed);
        const files = changed.filter((path) => path !== 'HEAD');
        const parts = [...files.slice(0, MAX_LISTED_PATHS), ...(changed.includes('HEAD') ? ['HEAD moved'] : [])];
        why = `changed the deliverable: ${parts.join(', ')}`;
        stop = 'changed';
      }
    }
    if (schemaChanged) entry.schemaChanged = true;
    if (run.fault) entry.fault = run.fault;
    entry.tail = run.tail;
    if (run.log) entry.log = run.log;
    entry.why = entry.status === 'passed' ? null : cutChars(why, ITEM_WHY_CHARS);
    if (run.stopped) { entry.status = 'not-run'; entry.exit = null; entry.why = 'stopped'; }
    if (facts.length && run.log) {
      try { appendFileSync(run.log, `${facts.join('\n')}\n`); } catch { /* the log is best effort */ }
    }
    results.push(entry);
    emit({ stage: 'finished', ...position, status: entry.status, why: entry.why, durationMs: entry.durationMs });
  }

  let createdOutOfScope = [];
  if (scope?.mode === 'private' && firstUntracked) {
    const finalListing = scope.untracked() ?? new Map();
    createdOutOfScope = [...finalListing.keys()].filter((path) => !firstUntracked.has(path)).sort();
  }
  const failed = results.some((result) => result.status === 'failed');
  const stopped = stop === 'stopped';
  const checkFault = results.some((result) => result.status === 'failed' && result.fault === 'check');
  return {
    results,
    failed,
    stopped,
    checkFault,
    why: stopped ? 'evidence stopped' : (failed ? evidenceFailureWhy(results) : null),
    createdOutOfScope,
  };
}

function lastTailLine(tail) {
  const lines = String(tail ?? '').split('\n').map((line) => line.trim()).filter(Boolean);
  return lines.length ? cutChars(lines[lines.length - 1], WHY_LINE_CHARS) : null;
}

/**
 * The §2.7 step why: `<label> → <item why>[: <detail>][ (+N more failed)]`,
 * `check could not run: ` first for a check fault, cut to 240 characters
 * before `suffix` (` · act steps are not retried`, ` · no retry: …`), which
 * is always kept.
 */
export function evidenceFailureWhy(results, { suffix = '' } = {}) {
  const failures = (results ?? []).filter((result) => result?.status === 'failed');
  if (!failures.length) return null;
  const first = failures[0];
  const itemWhy = String(first.why ?? 'failed');
  let detail = '';
  if (/^exit -?\d+$/.test(itemWhy) || /^killed by /.test(itemWhy)) {
    const line = lastTailLine(first.tail);
    if (line) detail = `: ${line}`;
  } else if (/^not valid:/.test(itemWhy) && first.errors?.length) {
    detail = `: ${first.errors[0]}`;
  }
  let body = `${evidenceItemLabel(first)} → ${itemWhy}${detail}`;
  if (first.fault === 'check') body = `check could not run: ${body}`;
  const more = failures.length > 1 ? ` (+${failures.length - 1} more failed)` : '';
  const kept = `${more}${suffix ?? ''}`;
  const room = Math.max(1, WHY_CHARS - kept.length);
  return `${cutChars(body, room)}${kept}`;
}
