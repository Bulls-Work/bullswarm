// `workflow plan validate --try-checks` (0.38.4): run each step's command
// checks once against the current tree, the way the evidence runner runs
// them during a step (same shell, working folder, environment and timeout,
// the same tail of output), without dispatching a worker or writing into the
// run home. The results are information: validate's exit code never follows
// them, because a check that fails before the work exists is often expected.

import { lstatSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import { evidenceEnv, evidenceItemLabel, evidenceItemTimeoutSec, runEvidenceItem, stripAnsi } from './evidence-runner.js';

const MAX_LISTED = 10;
const SHOW_ALL_LINES = 30;
// 14 first lines, not 12: for `node --test <folder>` the line with MODULE_NOT_FOUND is line 13.
const SHOW_HEAD_LINES = 14;
const SHOW_TAIL_LINES = 12;
const TAIL_INDENT = ' '.repeat(11);

/** A command check that reads the step's final response, which does not exist before the step runs. */
export const readsStepOutput = (item) => /\$output\b|BULLSWARM_STEP_OUTPUT/.test(String(item?.cmd ?? ''));

/** How many command checks the program declares. */
export function commandCheckCount(actions) {
  return (actions ?? []).reduce((n, action) => n + (action.evidence ?? []).filter((item) => item?.type === 'command').length, 0);
}

function realPath(path) {
  try { return realpathSync(path); } catch { return resolve(path); }
}

// Every file under the workspace (git's own folder aside) → size, change
// times and inode, ignored and untracked files included, inside or outside a
// git repository. A check that writes, deletes or renames a file changes its
// entry. Paths are relative to the workspace.
function fileSnapshot(root) {
  const snapshot = new Map();
  const walk = (directory) => {
    let entries;
    try { entries = readdirSync(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.name === '.git') continue;
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) { walk(absolute); continue; }
      let stat;
      try { stat = lstatSync(absolute, { bigint: true }); } catch { continue; }
      snapshot.set(relative(root, absolute).split(sep).join('/'), `${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}:${stat.ino}`);
    }
  };
  walk(root);
  return snapshot;
}

function changedBetween(before, after) {
  const paths = new Set([...before.keys(), ...after.keys()]);
  return [...paths].filter((path) => before.get(path) !== after.get(path)).sort();
}

function lastLine(tail) {
  const lines = String(tail ?? '').split('\n').map((line) => line.trim()).filter(Boolean);
  if (!lines.length) return null;
  return lines[lines.length - 1];
}

/**
 * Run every command check of `actions` once, one after the other, in `cwd`.
 * Resolves to `[{ step, index, cmd, exit, timedOut, tail, changedFiles }]`
 * (index is the item's 1-based place in the step's evidence); a check that
 * reads the step's output is listed with `notTried` and never runs.
 */
export async function tryCommandChecks(actions, { cwd, env = process.env } = {}) {
  const root = realPath(cwd);
  const results = [];
  // BULLSWARM_STEP_OUTPUT and BULLSWARM_RUN_DIR point into a scratch folder
  // outside the run home, removed afterwards.
  const scratch = mkdtempSync(join(tmpdir(), 'bullswarm-try-'));
  // The full output of every check is kept here, for the caller to read.
  const logs = mkdtempSync(join(tmpdir(), 'bullswarm-try-logs-'));
  try {
    for (const action of actions ?? []) {
      const items = Array.isArray(action.evidence) ? action.evidence : [];
      for (let index = 0; index < items.length; index += 1) {
        const item = items[index];
        if (item?.type !== 'command') continue;
        const base = { step: action.id, index: index + 1, cmd: item.cmd };
        if (readsStepOutput(item)) {
          results.push({ ...base, exit: null, timedOut: false, tail: '', changedFiles: [], notTried: 'it reads the step\'s output' });
          continue;
        }
        const before = fileSnapshot(root);
        const run = await runEvidenceItem(item, {
          cwd: root,
          env: evidenceEnv(env, { cwd: root, stepId: action.id, outFile: join(scratch, 'output.md'), runDir: scratch }),
          outFile: join(scratch, 'output.md'),
          logFile: join(logs, `${results.length + 1}-${action.id.replace(/[^A-Za-z0-9._-]/g, '_')}-${index + 1}.log`),
        });
        const changedFiles = changedBetween(before, fileSnapshot(root));
        results.push({
          ...base,
          exit: run.exit,
          timedOut: Boolean(run.timedOut),
          ...(run.timedOut ? { timeoutSec: evidenceItemTimeoutSec(item) } : {}),
          ...(run.exit == null && !run.timedOut && run.why ? { why: run.why } : {}),
          tail: run.tail,
          ...(run.log ? { log: run.log } : {}),
          changedFiles,
        });
      }
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  return results;
}

// The command's own output from its log file (the file holds a header of
// `$ cmd`, `cwd:` and `timeout:` lines before it and a one-line footer after).
function logOutputLines(result) {
  let text;
  try { text = readFileSync(result.log, 'utf8'); } catch { return null; }
  const marker = text.search(/\ncwd: .*\ntimeout: \d+s\n/);
  if (marker < 0) return null;
  let body = text.slice(text.indexOf('\n', text.indexOf('\ntimeout: ', marker) + 1) + 1);
  const end = body.lastIndexOf('\n', body.length - 2);
  body = end < 0 ? '' : body.slice(0, end + 1);
  return stripAnsi(body).replace(/\s+$/, '').split('\n');
}

function failedOutput(result) {
  const lines = result.log ? logOutputLines(result) : null;
  const all = lines ?? String(result.tail ?? '').split('\n');
  const shown = !all.some((line) => line.trim()) ? [] : all.length <= SHOW_ALL_LINES
    ? all
    : [...all.slice(0, SHOW_HEAD_LINES), `… ${all.length - SHOW_HEAD_LINES - SHOW_TAIL_LINES} more lines …`, ...all.slice(-SHOW_TAIL_LINES)];
  const out = shown.map((line) => `${TAIL_INDENT}${line}`);
  if (result.log) out.push(`${TAIL_INDENT}full output: ${result.log}`);
  return out;
}

/** The `try` line for one result; a check that failed or timed out is followed by its output (all of it when short, else its first and last lines) and the log file path. */
export function tryLine(result) {
  const label = evidenceItemLabel({ type: 'command', cmd: result.cmd });
  let outcome;
  if (result.notTried) outcome = `not tried: ${result.notTried}`;
  else if (result.timedOut) outcome = `timed out after ${result.timeoutSec}s`;
  else if (result.exit == null) outcome = result.why ?? 'did not run';
  else if (result.exit === 0) {
    const line = lastLine(result.tail);
    outcome = `exit 0${line ? ` · ${line}` : ''}`;
  } else outcome = `exit ${result.exit}`;
  const changed = result.changedFiles?.length
    ? ` · changed files: ${result.changedFiles.slice(0, MAX_LISTED).join(', ')}${result.changedFiles.length > MAX_LISTED ? ` (+${result.changedFiles.length - MAX_LISTED} more)` : ''}`
    : '';
  const head = `  try      ${label} → ${outcome}${changed}`;
  const failed = !result.notTried && (result.timedOut || (result.exit != null && result.exit !== 0));
  const output = failed ? failedOutput(result) : [];
  return output.length ? [head, ...output].join('\n') : head;
}

export const CHECKS_NOT_RUN_LINE = '  checks   not run · add --try-checks to run each command check once now against the current tree (it may take time and must not change files)';
