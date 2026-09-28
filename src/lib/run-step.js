// `bullswarm run` flags -> a one-step program v3 (0.37.0, design section 6).
//
// A single run is a one-step workflow: this module reads the run flags, says
// what is wrong with them (a usage error, exit 2), and builds the program and
// the goal document the kernel runs. It never routes and never runs anything.
//
// Deliberate differences from 0.36: the step default `retry: 1` applies to a
// run (`--no-retry` gives one attempt); the step passes by facts only, as
// every v3 step does (a build or chore run must change a file); and there is
// no keep-on-caller, so `--no-caller` is accepted and ignored for one release.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { isReasoningLevel, REASONING_DEFAULT, REASONING_LEVELS } from './reasoning.js';
import { DEFAULT_EFFORT_BY_LANE } from '../workflow/action-validator.js';
import { implicitV3Requirements, normaliseProgramV3, PROGRAM_V3_SCHEMA_VERSION } from '../workflow/program-v3.js';
import { createV2GoalDocument } from '../workflow/v2-state.js';

export const RUN_STEP_ID = 'task';
export const NO_CALLER_NOTICE = 'bullswarm run: --no-caller is ignored; the calling agent is never a pool of its own run (removed in 0.37.0)';

const LANES = ['analyze', 'build', 'chore'];
const EFFORTS = ['high', 'medium', 'low'];
const LABEL_MAX = 200;

const missing = (value) => value === true;

/** The step label and the run's goal: the task's first line, at most 200 characters. */
export function runStepLabel(taskText) {
  const line = String(taskText).split(/\r?\n/).map((part) => part.replace(/\s+/g, ' ').trim()).find(Boolean) ?? 'task';
  return line.length <= LABEL_MAX ? line : `${line.slice(0, LABEL_MAX - 1).trimEnd()}…`;
}

// A comma-separated list flag: `--avoid-pool grok,codex`.
function listFlag(opts, flag, what) {
  const value = opts[flag];
  if (value === undefined) return { list: null };
  if (missing(value) || typeof value !== 'string') return { error: `--${flag} requires ${what}` };
  const list = [...new Set(value.split(',').map((item) => item.trim()).filter(Boolean))];
  return list.length ? { list } : { error: `--${flag} requires ${what}` };
}

function readSchemaFile(path) {
  let text;
  try { text = readFileSync(resolve(path), 'utf8'); }
  catch (error) { return { error: `cannot read --answer-schema ${path}: ${error.message}` }; }
  try { return { schema: JSON.parse(text) }; }
  catch (error) { return { error: `--answer-schema ${path} is not valid JSON: ${error.message}` }; }
}

/**
 * Read `bullswarm run` options (parseArgs output). Returns `{ request }`, or
 * `{ error }` for a usage error. `answerSchema` stands in for reading the
 * `--answer-schema` file.
 */
export function runStepRequest(opts, { cwd = process.cwd(), answerSchema } = {}) {
  const lane = opts.lane;
  if (lane === undefined || missing(lane)) return { error: `--lane is required (${LANES.join('|')})` };
  if (!LANES.includes(lane)) return { error: `--lane must be ${LANES.join(', ')} (got "${lane}")` };
  const heartbeatSec = opts.heartbeat == null || missing(opts.heartbeat) ? null : Number(opts.heartbeat);
  if (missing(opts.heartbeat) || (heartbeatSec != null && (!Number.isFinite(heartbeatSec) || heartbeatSec < 1))) {
    return { error: '--heartbeat must be a number of seconds greater than or equal to 1' };
  }
  const effort = opts.effort ?? DEFAULT_EFFORT_BY_LANE[lane] ?? 'medium';
  if (!EFFORTS.includes(effort)) return { error: '--effort must be high, medium, or low' };
  if (missing(opts.reasoning)) return { error: 'usage: --reasoning requires a value' };
  if (opts.reasoning != null && !isReasoningLevel(opts.reasoning)) {
    return { error: `--reasoning must be one of ${[...REASONING_LEVELS, REASONING_DEFAULT].join(', ')}` };
  }
  const timeoutSec = opts.timeout == null ? null : Number(opts.timeout);
  if (missing(opts.timeout) || (timeoutSec != null && !(Number.isFinite(timeoutSec) && timeoutSec > 0))) {
    return { error: '--timeout must be a number of seconds greater than 0' };
  }
  if (missing(opts['add-dir'])) return { error: 'usage: --add-dir requires a directory' };

  const taskFile = opts['task-file'];
  if (missing(taskFile) || missing(opts.prompt)
    || (taskFile != null && typeof taskFile !== 'string') || (opts.prompt != null && typeof opts.prompt !== 'string')) {
    return { error: 'usage: --prompt and --task-file require a value' };
  }
  const rest = opts.rest ?? [];
  if (taskFile && opts.prompt != null) return { error: 'usage: choose one of --prompt, --task-file, or trailing task text' };
  if (taskFile && rest.length) return { error: 'usage: choose one of --task-file or trailing task text' };
  if (opts.prompt != null && rest.length) return { error: 'usage: choose one of --prompt or trailing task text' };

  const pools = listFlag(opts, 'avoid-pool', 'a pool name');
  const useProviders = listFlag(opts, 'use-provider', 'a provider name');
  const avoidProviders = listFlag(opts, 'avoid-provider', 'a provider name');
  const listError = pools.error ?? useProviders.error ?? avoidProviders.error;
  if (listError) return { error: listError };

  let answer = answerSchema;
  if (answer === undefined && opts['answer-schema'] !== undefined) {
    if (missing(opts['answer-schema'])) return { error: '--answer-schema requires a file (a JSON schema)' };
    const read = readSchemaFile(opts['answer-schema']);
    if (read.error) return { error: read.error };
    answer = read.schema;
  }

  let taskText;
  if (taskFile) {
    try { taskText = readFileSync(taskFile, 'utf8'); }
    catch (error) { return { error: `cannot read --task-file ${taskFile}: ${error.message}` }; }
  } else taskText = opts.prompt ?? rest.join(' ');
  if (!taskText.trim()) return { error: 'empty task: pass --task-file, --prompt, or the task as arguments' };

  const route = {};
  if (pools.list) route.pools = { avoid: pools.list };
  if (useProviders.list || avoidProviders.list) {
    route.providers = {
      ...(useProviders.list ? { use: useProviders.list } : {}),
      ...(avoidProviders.list ? { avoid: avoidProviders.list } : {}),
    };
  }
  const request = {
    lane, effort, taskText,
    targetDir: resolve(opts['add-dir'] ?? cwd),
    reasoning: opts.reasoning ?? null,
    retry: opts['no-retry'] === true ? 0 : 1,
    route: Object.keys(route).length ? route : null,
    answer: answer === undefined ? null : answer,
    timeoutSec, heartbeatSec,
    dryRun: opts['dry-run'] === true,
    noCaller: opts['no-caller'] === true,
  };
  // The v3 validator decides what the program may hold (the answer schema's
  // subset, the route lists), with its own wording.
  try { normaliseProgramV3(runStepProgram(request)); }
  catch (error) {
    const issues = Array.isArray(error?.issues) ? error.issues : [error.message];
    return { error: `invalid run: ${issues.join('; ')}` };
  }
  return { request };
}

/** The one-step v3 program a run request stands for. */
export function runStepProgram(request) {
  const step = {
    id: RUN_STEP_ID,
    label: runStepLabel(request.taskText),
    prompt: request.taskText,
    lane: request.lane,
    effort: request.effort,
    retry: request.retry,
    ...(request.route ? { route: request.route } : {}),
    ...(request.answer != null ? { answer: request.answer } : {}),
  };
  return { schemaVersion: PROGRAM_V3_SCHEMA_VERSION, steps: [step] };
}

/** The goal document of a run: program mode, shared workspace, no scout, the caller as planner. */
export function runStepGoal(request) {
  const goal = runStepLabel(request.taskText);
  return createV2GoalDocument({
    goal,
    cwd: request.targetDir,
    requirements: implicitV3Requirements(goal),
    settings: { executionMode: 'program', workspaceMode: 'shared', scout: false, plannerMode: 'caller', concurrency: 1 },
    // `--reasoning` is the run-wide level, as in 0.36 (source "run").
    workerRouting: request.reasoning ? { reasoning: request.reasoning } : null,
  });
}
