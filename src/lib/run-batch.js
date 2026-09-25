// `bullswarm run --batch <tasks.jsonl>`: many independent single runs from one
// call, for a caller that keeps its own control flow (a loop, or a Workflow
// script whose one wrapper agent launches N runs instead of N relay agents).
//
// Each line is one `run`: the SAME function the single command calls, with the
// line's fields as that command's flags, one attempt, no retry. What the batch
// adds is only a pool of at most N tasks at a time and one JSON array of the
// verdicts in input order. It keeps no state and cannot resume: work that
// must outlive the calling session belongs in `workflow goal`.
//
// Tasks start one after another. Each task's route is picked only once the
// task before it has booked its pool in the shared in-flight ledger (or has
// finished without dispatching), so routing sees the batch's own picks the
// same way it sees any other process's work.

import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { usageLine } from '../help.js';
import { loadConnectors } from './config.js';
import { withPoolLabels } from './pool-labels.js';
import { isReasoningLevel, REASONING_DEFAULT, REASONING_LEVELS } from './reasoning.js';
import { LANES } from './route.js';
import { runRouteFromOpts } from './run-route.js';
import { assertDepthAllowed, loadState } from './state.js';

const DEFAULT_CONCURRENCY = 4;
const EFFORTS = ['high', 'medium', 'low'];

// The `run` flags that apply to the whole batch. Everything a task needs
// (lane, directory, task text, effort, reasoning, route filters) is set per
// line instead.
const BATCH_FLAGS = ['batch', 'concurrency', 'json', 'no-caller', 'timeout', 'dry-run', 'help'];

const text = (value) => (typeof value === 'string' && value.trim() ? null : 'must be a non-empty string');

function isDir(value) {
  if (text(value)) return text(value);
  try {
    return statSync(resolve(value)).isDirectory() ? null : `is not a directory: ${value}`;
  } catch {
    return `does not exist: ${value}`;
  }
}

function taskFile(value) {
  if (text(value)) return text(value);
  try {
    return readFileSync(resolve(value), 'utf8').trim() ? null : `is empty: ${value}`;
  } catch (err) {
    return `cannot be read: ${value} (${err.code ?? err.message})`;
  }
}

// A route key takes one value or a list; each value is what one flag takes.
const oneOrMore = (v) => {
  const list = Array.isArray(v) ? v : [v];
  return list.length && list.every((item) => !text(item)) ? null : 'must be a non-empty string or a list of them';
};

// Each line key, the single-run flag it becomes, and its check. A `path` key
// resolves against the current directory, exactly as the flag would; a `list`
// key becomes the flag repeated once per value.
const LINE_KEYS = {
  lane: { flag: 'lane', check: (v) => (LANES.includes(v) ? null : `must be ${LANES.join(', ')} (got ${JSON.stringify(v)})`) },
  addDir: { flag: 'add-dir', path: true, check: isDir },
  prompt: { flag: 'prompt', check: text },
  taskFile: { flag: 'task-file', path: true, check: taskFile },
  effort: { flag: 'effort', check: (v) => (EFFORTS.includes(v) ? null : `must be ${EFFORTS.join(', ')} (got ${JSON.stringify(v)})`) },
  reasoning: {
    flag: 'reasoning',
    check: (v) => (isReasoningLevel(v) ? null : `must be one of ${[...REASONING_LEVELS, REASONING_DEFAULT].join(', ')} (got ${JSON.stringify(v)})`),
  },
  // Route filters (src/lib/run-route.js), checked in full before anything runs.
  avoidPool: { flag: 'avoid-pool', list: true, route: true, check: oneOrMore },
  useProvider: { flag: 'use-provider', list: true, route: true, check: oneOrMore },
  avoidProvider: { flag: 'avoid-provider', list: true, route: true, check: oneOrMore },
  independentOf: { flag: 'independent-of', list: true, route: true, check: oneOrMore },
};

// Keys a sibling `run` feature will read, refused until this version's
// single run has the flag, so a line never silently loses what it asked for.
const NOT_YET = {
  answerSchema: 'answer-schema',
  answerFile: 'answer-file',
};

/** Problems with one parsed line, as `"key" …` phrases (empty when it is good). */
function lineProblems(task) {
  const problems = [];
  for (const key of Object.keys(task)) {
    if (key === 'id' || LINE_KEYS[key]) continue;
    problems.push(NOT_YET[key]
      ? `"${key}" is not supported yet: this version's run has no --${NOT_YET[key]}`
      : `unknown key "${key}" (allowed: id, ${Object.keys(LINE_KEYS).join(', ')})`);
  }
  if (typeof task.id !== 'string' || !task.id.trim()) problems.push('"id" must be a non-empty string');
  if (task.lane === undefined) problems.push(`"lane" is required (${LANES.join('|')})`);
  if (task.prompt === undefined && task.taskFile === undefined) problems.push('needs "prompt" or "taskFile"');
  if (task.prompt !== undefined && task.taskFile !== undefined) problems.push('choose one of "prompt" or "taskFile"');
  for (const [key, spec] of Object.entries(LINE_KEYS)) {
    if (task[key] === undefined) continue;
    const problem = spec.check(task[key]);
    if (problem) problems.push(`"${key}" ${problem}`);
  }
  return problems;
}

/** Every task in the file and every problem found (line numbers are 1-based). */
function readTasks(file) {
  let raw;
  try {
    raw = readFileSync(resolve(file), 'utf8');
  } catch (err) {
    return { errors: [`cannot read ${file} (${err.code ?? err.message})`] };
  }
  const tasks = [];
  const errors = [];
  const lineOfId = new Map();
  raw.split(/\r?\n/).forEach((source, index) => {
    const line = index + 1;
    if (!source.trim()) return;
    let task;
    try {
      task = JSON.parse(source);
    } catch (err) {
      errors.push(`line ${line}: not valid JSON (${err.message})`);
      return;
    }
    if (!task || typeof task !== 'object' || Array.isArray(task)) {
      errors.push(`line ${line}: must be a JSON object`);
      return;
    }
    const problems = lineProblems(task);
    for (const problem of problems) errors.push(`line ${line}: ${problem}`);
    if (typeof task.id === 'string' && task.id.trim()) {
      if (lineOfId.has(task.id)) errors.push(`line ${line}: id "${task.id}" is already used on line ${lineOfId.get(task.id)}`);
      else lineOfId.set(task.id, line);
    }
    // A line with a bad shape is not route-checked: its fields mean nothing yet.
    tasks.push({ line, task, checked: !problems.length });
  });
  if (!errors.length && !tasks.length) errors.push(`no tasks in ${file}`);
  return { tasks, errors };
}

// The route check a single run makes before it routes, run for every line up
// front, so a pool name or run ref that does not resolve stops the batch
// before its first task instead of failing one task part-way through.
function routeProblems(tasks, opts, bullswarmDir) {
  const routed = tasks.filter(({ task, checked }) => checked && Object.keys(task).some((key) => LINE_KEYS[key]?.route));
  if (!routed.length) return [];
  const decisionLog = loadState(bullswarmDir).decisionLog ?? [];
  let pools = null;
  // The configured pool list, built as cmdRun builds it.
  const configuredPools = () => (pools ??= Object.entries(loadConnectors(bullswarmDir, { packaged: true }))
    .map(([name, connector]) => ({ name, connector })));
  // The single run's message, in the line's own words: `"avoidPool"`, not `--avoid-pool`.
  const inLineWords = (message) => Object.entries(LINE_KEYS)
    .reduce((out, [key, spec]) => out.split(`--${spec.flag}`).join(`"${key}"`), message.replace(/^usage:\s*/, ''));
  return routed.flatMap(({ line, task }) => {
    const { error } = runRouteFromOpts(runOptions(task, opts), { decisionLog, home: bullswarmDir, configuredPools });
    return error ? [`line ${line}: ${inLineWords(error)}`] : [];
  });
}

// The line a message is about (0 for the file or the flags), to print in order.
const lineOf = (message) => Number(/^line (\d+):/.exec(message)?.[1] ?? 0);

/** The batch-wide flags, or the usage problems with them. */
function batchSettings(opts) {
  // Without --batch this is a single run that also typed --concurrency: its
  // other flags are right for that run, so they are not called batch mistakes.
  if (opts.batch === undefined) return { errors: ['--concurrency needs --batch <tasks.jsonl>'], concurrency: DEFAULT_CONCURRENCY };
  const errors = [];
  if (typeof opts.batch !== 'string' || !opts.batch) errors.push('--batch requires a file (one JSON task per line)');
  for (const flag of opts._flags ?? []) {
    if (BATCH_FLAGS.includes(flag)) continue;
    const key = Object.keys(LINE_KEYS).find((name) => LINE_KEYS[name].flag === flag);
    errors.push(key
      ? `--${flag} does not apply with --batch: set "${key}" on each line`
      : `--${flag} does not apply with --batch`);
  }
  if (opts.rest?.length) errors.push('--batch takes no trailing task text: put each task on its own line of the file');
  let concurrency = DEFAULT_CONCURRENCY;
  if (opts.concurrency !== undefined) {
    concurrency = Number(opts.concurrency);
    if (opts.concurrency === true || !Number.isInteger(concurrency) || concurrency < 1) {
      errors.push(`--concurrency must be a whole number of at least 1 (got ${JSON.stringify(opts.concurrency)})`);
    }
  }
  if (opts.timeout !== undefined) {
    const seconds = Number(opts.timeout);
    if (opts.timeout === true || !Number.isFinite(seconds) || seconds <= 0) {
      errors.push(`--timeout must be a number of seconds greater than 0 (got ${JSON.stringify(opts.timeout)})`);
    }
  }
  return { errors, concurrency };
}

/** The single-run options one line stands for. */
function runOptions(task, opts) {
  const out = { rest: [], _flags: [], json: true };
  for (const [key, spec] of Object.entries(LINE_KEYS)) {
    if (task[key] === undefined) continue;
    const value = task[key];
    out[spec.flag] = spec.path ? resolve(value) : spec.list ? [value].flat() : value;
  }
  for (const flag of ['no-caller', 'dry-run', 'timeout']) {
    if (opts[flag] !== undefined) out[flag] = opts[flag];
  }
  return out;
}

function printText(results, bullswarmDir, print) {
  for (const v of results) {
    const line = [
      v.ok ? 'OK' : 'FAIL',
      v.id,
      v.keepOnClaude ? '(keep-on-caller)' : '',
      v.pick?.pool ? `[${v.pick.pool}]` : '',
      v.why ?? '',
    ].filter(Boolean).join(' ');
    print(withPoolLabels(line, bullswarmDir));
    if (v.outFile) print(`  output: ${v.outFile}`);
  }
  const failed = results.filter((v) => !v.ok).length;
  const kept = results.filter((v) => v.ok && v.keepOnClaude).length;
  print(`batch: ${results.length} task${results.length === 1 ? '' : 's'} · ${results.length - failed} ok · ${failed} failed`
    + (kept ? ` · ${kept} kept on the caller (not run)` : ''));
}

/**
 * `run --batch`. `runOne(opts)` is the single-run command: it resolves to that
 * command's exit code and hands its --json verdict to `opts.onVerdict` instead
 * of printing it, and calls `opts.onDispatch` once its pool is booked.
 */
export async function cmdRunBatch(opts, {
  runOne, bullswarmDir, print = console.log, error = console.error,
}) {
  const settings = batchSettings(opts);
  const read = settings.errors.length ? { errors: [] } : readTasks(opts.batch);
  const errors = [
    ...settings.errors,
    ...(read.errors ?? []),
    ...(read.tasks ? routeProblems(read.tasks, opts, bullswarmDir) : []),
  ].sort((a, b) => lineOf(a) - lineOf(b));
  if (errors.length) {
    for (const message of errors) error(`✗ ${message}`);
    error(settings.errors.length ? `usage: ${usageLine(['run'])}` : 'nothing ran');
    return 2;
  }
  const { tasks } = read;
  const report = (results) => {
    if (opts.json) print(JSON.stringify(results, null, 2));
    else printText(results, bullswarmDir, print);
    return results.every((v) => v.ok) ? 0 : 1;
  };

  // The recursion guard every single run applies, once for the batch, so a
  // refusal is one array rather than N verdicts written past the batch's own.
  try {
    assertDepthAllowed(loadState(bullswarmDir));
  } catch (err) {
    return report(tasks.map(({ task }) => ({ id: task.id, exit: 1, ok: false, keepOnClaude: true, why: err.message })));
  }

  const results = new Array(tasks.length);
  let routing = Promise.resolve();
  const runTask = async ({ task }) => {
    let release;
    const routed = new Promise((done) => { release = done; });
    const turn = routing;
    routing = routing.then(() => routed);
    await turn;
    let verdict = null;
    try {
      const exit = await runOne({
        ...runOptions(task, opts),
        onVerdict: (v) => { verdict = v; release(); },
        onDispatch: () => release(),
      });
      return verdict
        ? { id: task.id, exit, ...verdict }
        : { id: task.id, exit, ok: false, keepOnClaude: false, why: `run refused the task with exit ${exit} (see stderr)` };
    } catch (err) {
      return { id: task.id, exit: 1, ok: false, keepOnClaude: false, why: `run failed: ${err?.message ?? err}` };
    } finally {
      release();
    }
  };
  let next = 0;
  const worker = async () => {
    while (next < tasks.length) {
      const index = next++;
      results[index] = await runTask(tasks[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(settings.concurrency, tasks.length) }, worker));
  return report(results);
}
