// Workflow verbs that act on one part of a v3 run (0.37.0, design section 5):
// `workflow continue`, `workflow add` and `workflow wait`.
//
// `workflow continue <run> <gate-or-loop> [--rounds N]` passes a waiting gate,
// or gives an out-of-rounds loop N more rounds (without --rounds the loop
// passes as it stands). It writes a durable intent next to the run. A live
// kernel applies it on its next pass; with no live kernel this command applies
// it under the run's lease, sets the lifecycle back to running itself, and
// relaunches the kernel detached, as `plan revise` does.
//
// `workflow add <run> --steps part.json | --from-answer <step>` appends a v3
// fragment {steps, gates?, loops?} through the revision path in its
// append-only mode (revision-v3.js): nothing the run has changes. A finished
// run reopens and its kernel is relaunched, as `plan revise` does.
//
// `workflow wait <run> <id...>` reads state.json until every named step, gate
// or loop is finished, failed, blocked or waiting, then prints each one's
// status, facts and checked answer. It changes nothing.

import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { writeJsonAtomic } from '../lib/fsjson.js';
import { glyphs } from '../lib/glyphs.js';
import { usageLine } from '../help.js';
import {
  CONTINUE_MAX_ROUNDS, applyContinueOffline, continueRefusal, parkedWaitingFor, readContinueIntents, requestContinue,
} from './gates-loops.js';
import { isProgramV3 } from './program-v3.js';
import { appendedProgramV3, fragmentShapeIssues } from './revision-v3.js';
import { readRunFeatures, runFeatureFlags } from './run-features.js';
import { isLegacyRunDir, resolveRunId, v2RunnerLiveness } from './short-id.js';
import { createRevisionRequest, exportV2Plan, planV2Revision } from './v2-revision.js';
import { workspacePathIssues } from './v2-planner.js';
import { acquireKernelLease } from './v2-process.js';
import { reviseV2Program } from './v2-runtime.js';
import { deserializeV2DurableState, serializeV2DurableState } from './v2-state.js';
import { formatDuration } from './watch-cli.js';

const TERMINAL = new Set(['completed', 'partial', 'cancelled', 'failed']);

function readState(runDir) {
  return deserializeV2DurableState(readFileSync(join(runDir, 'state.json'), 'utf8'));
}

function tryLease(runDir) {
  try { return acquireKernelLease(runDir); } catch { return null; }
}

/** Parse --rounds: a whole number from 1 to 5, or null when absent. Throws with the usage message. */
export function parseContinueRounds(value) {
  if (value === undefined) return null;
  const text = String(value);
  const rounds = /^\d+$/.test(text) ? Number(text) : NaN;
  if (!Number.isInteger(rounds) || rounds < 1 || rounds > CONTINUE_MAX_ROUNDS) {
    throw new Error(`--rounds must be a whole number from 1 to ${CONTINUE_MAX_ROUNDS}`);
  }
  return rounds;
}

/**
 * Continue one waiting gate or loop. Resolves {code, status, ...}: status
 * `applied` (appliedBy offline|kernel), `queued` (a live kernel has not taken
 * it within waitMs), or `refused` with `why`. `relaunch(runId)` starts the
 * kernel again after an offline apply.
 */
export async function continueV2Run({
  bullswarmDir, token, nodeId, rounds = null,
  waitMs = 120_000, pollMs = 250, now = () => new Date().toISOString(), relaunch = null,
} = {}) {
  const resolved = resolveRunId(bullswarmDir, token);
  if (!resolved) return { code: 1, status: 'refused', why: `no run found for "${token}"` };
  if (isLegacyRunDir(resolved.runDir)) return { code: 2, status: 'refused', why: `run "${token}" is a legacy run; nothing drives it` };
  const { runDir } = resolved;
  let state;
  try { state = readState(runDir); } catch (err) { return { code: 1, status: 'refused', why: `cannot read the run state: ${err.message}` }; }
  const base = { runId: state.runId, shortId: state.shortId ?? null, node: nodeId, rounds };
  const id = state.shortId ?? state.runId;
  const refusal = continueRefusal(state, nodeId, rounds);
  if (refusal) return { code: /^--rounds/.test(refusal) ? 2 : 1, status: 'refused', why: refusal, ...base };
  if (TERMINAL.has(state.lifecycle.status)) {
    return { code: 1, status: 'refused', why: `the run is ${state.lifecycle.status}; start a new run or reopen it with bullswarm workflow resume ${id}`, ...base };
  }
  const intent = requestContinue(runDir, { nodeId, rounds, source: 'cli', now });
  const features = runFeatureFlags(readRunFeatures(runDir));
  const settledByKernel = () => {
    const current = readContinueIntents(runDir).find((entry) => entry.id === intent.id);
    if (!current?.appliedAt) return null;
    return current.refused
      ? { code: 1, status: 'refused', why: current.refused, appliedBy: 'kernel', ...base }
      : { code: 0, status: 'applied', appliedBy: 'kernel', ...base };
  };
  const applyOffline = () => {
    const lease = tryLease(runDir);
    if (!lease) return null;
    try {
      const settled = settledByKernel();
      if (settled) return settled;
      const current = readState(runDir);
      const outcome = applyContinueOffline(current, intent, { runDir, at: now(), features });
      serializeV2DurableState(current);
      writeJsonAtomic(join(runDir, 'state.json'), current);
      if (!outcome.applied) return { code: 1, status: 'refused', why: outcome.why, ...base };
      return { code: 0, status: 'applied', appliedBy: 'offline', lifecycle: current.lifecycle.status, ...base };
    } finally { lease.release(); }
  };
  let result = applyOffline();
  const deadline = Date.now() + Math.max(0, waitMs);
  while (!result) {
    result = settledByKernel() ?? applyOffline();
    if (result) break;
    if (Date.now() >= deadline) return { code: 0, status: 'queued', appliedBy: null, ...base };
    await new Promise((done) => setTimeout(done, pollMs));
  }
  if (result.status === 'applied' && result.appliedBy === 'offline' && result.lifecycle === 'running' && typeof relaunch === 'function') {
    try { result.relaunch = await relaunch(state.runId); }
    catch (err) { return { code: 1, status: 'applied', why: `continue applied but the kernel did not relaunch: ${err.message}`, ...result }; }
  }
  return result;
}

function describe(result, type) {
  if (result.rounds != null) return `loop ${result.node} gets ${result.rounds} more round${result.rounds === 1 ? '' : 's'}`;
  return `${type ?? 'node'} ${result.node} passed`;
}

/** `bullswarm workflow continue <runId> <gate-or-loop> [--rounds N] [--wait s] [--json]`. */
export async function wfContinue(opts, { bullswarmDir, helpText, flagErrors, launchDetachedResume }) {
  const path = ['workflow', 'continue'];
  if (opts.help) { console.log(helpText(path)); return 0; }
  const flagExit = flagErrors(opts, path);
  if (flagExit !== null) return flagExit;
  const [token, nodeId] = opts.rest;
  if (!token || !nodeId || opts.rest.length > 2) { console.error(`usage: ${usageLine(path)}`); return 2; }
  let rounds;
  try { rounds = parseContinueRounds(opts.rounds); } catch (err) { console.error(`✗ ${err.message}`); return 2; }
  const waitSec = opts.wait === undefined ? 120 : Number(opts.wait);
  if (!Number.isFinite(waitSec) || waitSec < 0) { console.error('✗ --wait must be a non-negative number of seconds'); return 2; }
  const resolved = resolveRunId(bullswarmDir, token);
  let type = null;
  try { type = resolved ? readState(resolved.runDir).program?.control?.gates?.some((gate) => gate.id === nodeId) ? 'gate' : 'loop' : null; } catch { type = null; }
  const relaunch = async (runId) => {
    const doc = JSON.parse(readFileSync(join(bullswarmDir, 'workflows', runId, 'goal.json'), 'utf8'));
    return launchDetachedResume(doc, runId, opts);
  };
  const result = await continueV2Run({ bullswarmDir, token, nodeId, rounds, waitMs: waitSec * 1000, relaunch });
  const { code, ...payload } = result;
  if (opts.json) console.log(JSON.stringify({ action: 'workflow-continue', ...payload }, null, 2));
  if (result.status === 'refused') {
    if (!opts.json) console.error(`✗ ${result.why}`);
    return code;
  }
  if (opts.json) return code;
  const id = result.shortId ?? result.runId;
  if (result.status === 'queued') {
    console.log(`✓ continue ${nodeId} queued for ${id}; its running kernel applies it at its next check`);
  } else if (result.appliedBy === 'kernel') {
    console.log(`✓ ${describe(result, type)} in ${id} (applied by its running kernel)`);
  } else {
    console.log(`✓ ${describe(result, type)} in ${id}${result.relaunch ? '; kernel relaunched' : ''}`);
    if (result.why) console.error(`✗ ${result.why}`);
  }
  console.log(`  watch    bullswarm workflow watch ${id} --until trouble`);
  return code;
}

// --- workflow add --------------------------------------------------------------

function readFragmentFile(path) {
  let raw;
  try { raw = readFileSync(resolve(path), 'utf8'); }
  catch (err) { throw new Error(`cannot read the steps file ${path}: ${err.message}`); }
  try { return JSON.parse(raw); }
  catch (err) { throw new Error(`the steps file ${path} is not valid JSON: ${err.message}`); }
}

/**
 * The fragment a `--from-answer <step>` names: that step's current checked
 * answer, or {refusal}. The answer is then checked like a file fragment.
 */
export function fragmentFromAnswer(state, stepId) {
  const id = state.shortId ?? state.runId;
  const definition = state.program.actions.find((action) => action.id === stepId);
  const runtime = state.actions.find((action) => action.id === stepId);
  if (!definition || !runtime || runtime.status === 'removed') return { refusal: `run ${id} has no step "${stepId}"` };
  if (definition.answer === undefined) return { refusal: `step ${stepId} declares no answer; --from-answer reads a step's checked answer` };
  if (!runtime.answer) {
    return { refusal: `step ${stepId} has no checked answer yet (it is ${runtime.status}); bullswarm workflow wait ${id} ${stepId} shows it once it has one` };
  }
  return { fragment: JSON.parse(JSON.stringify(runtime.answer.value)) };
}

/**
 * Append a v3 fragment to a run. Resolves {code, status: applied|queued|
 * rejected|error, ...}. `routeIssues(actions, doc, state)` checks the routes
 * of the added steps against today's pools; `relaunch(runId)` starts the
 * kernel after an offline apply.
 */
export async function addV3Steps({
  bullswarmDir, token, fragment = null, fromAnswer = null, summary = null,
  routeIssues = () => [], waitMs = 120_000, pollMs = 250, now = () => new Date().toISOString(), relaunch = null,
} = {}) {
  const resolved = resolveRunId(bullswarmDir, token);
  if (!resolved) return { code: 1, status: 'error', why: `no run found for "${token}"` };
  if (isLegacyRunDir(resolved.runDir)) return { code: 2, status: 'error', why: `run "${token}" is a legacy run; nothing drives it` };
  let state;
  try { state = readState(resolved.runDir); } catch (err) { return { code: 1, status: 'error', why: `cannot read the run state: ${err.message}` }; }
  const id = state.shortId ?? state.runId;
  const base = { runId: state.runId, shortId: state.shortId ?? null };
  if (!isProgramV3(state.program)) {
    return { code: 1, status: 'error', why: `run ${id} is not a v3 run; workflow add appends to v3 runs. Change a v2 run's plan with bullswarm workflow plan export ${id} --out plan.json, then bullswarm workflow plan revise ${id} --program plan.json`, ...base };
  }
  let source = fragment;
  if (fromAnswer) {
    const read = fragmentFromAnswer(state, fromAnswer);
    if (read.refusal) return { code: 1, status: 'error', why: read.refusal, ...base };
    source = read.fragment;
  }
  const shape = fragmentShapeIssues(source);
  if (shape.length) return { code: 2, status: 'rejected', issues: shape, ...base, ...(fromAnswer ? { fromAnswer } : {}) };
  let doc;
  try { doc = JSON.parse(readFileSync(join(resolved.runDir, 'goal.json'), 'utf8')); }
  catch (err) { return { code: 1, status: 'error', why: `cannot read the durable goal for ${id}: ${err.message}`, ...base }; }
  const cwd = doc?.intent?.cwd;
  if (typeof cwd !== 'string' || !existsSync(cwd) || !statSync(cwd).isDirectory()) {
    return { code: 1, status: 'error', why: `goal cwd is not an existing directory: ${cwd ?? '(missing)'}; nothing was added`, ...base };
  }
  const live = exportV2Plan(state).program.actions;
  const names = (list) => (Array.isArray(list) ? list : []).map((item) => item?.id).filter((item) => typeof item === 'string');
  const body = {
    summary: summary ?? `add ${[...names(source.steps), ...names(source.gates), ...names(source.loops)].join(', ')}${fromAnswer ? ` from the answer of ${fromAnswer}` : ''}`,
    baseRevision: state.program.revision,
    program: appendedProgramV3(state, live, source),
    rerun: [], steeringIds: [], append: true,
  };
  const features = runFeatureFlags(readRunFeatures(resolved.runDir));
  const precheck = planV2Revision(state, body, { features });
  if (precheck.ok) {
    const added = new Set(precheck.changes.added);
    const actions = precheck.desired.filter((action) => added.has(action.id));
    const issues = [
      ...workspacePathIssues({ actions }, cwd, { isolated: state.config.settings.workspaceMode === 'isolated' }),
      ...routeIssues(actions, doc, state),
    ];
    if (issues.length) Object.assign(precheck, { ok: false, issues });
  }
  if (!precheck.ok) return { code: 2, status: 'rejected', issues: precheck.issues, ...base, ...(fromAnswer ? { fromAnswer } : {}) };
  const request = createRevisionRequest(body, { source: 'workflow-add', now });
  let outcome;
  try { outcome = await reviseV2Program({ bullswarmDir, runId: state.runId, request, waitMs, pollMs, now }); }
  catch (err) { return { code: 1, status: 'error', why: err.message, ...base }; }
  const result = {
    ...base, requestId: request.id, ...(fromAnswer ? { fromAnswer } : {}),
    steps: [...precheck.changes.added], control: [...(precheck.changes.addedControl ?? [])],
  };
  if (outcome.status === 'rejected') return { code: 2, status: 'rejected', issues: outcome.record?.issues ?? [], ...result };
  if (outcome.status === 'queued') return { code: 0, status: 'queued', programRevision: null, appliedBy: null, relaunch: null, ...result };
  const paused = outcome.state?.lifecycle?.status === 'paused';
  let relaunched = null;
  if (outcome.appliedBy === 'offline' && !paused && typeof relaunch === 'function') {
    try { relaunched = await relaunch(state.runId); }
    catch (err) { return { code: 1, status: 'error', why: `the steps were added to ${id} (revision ${outcome.record.programRevision}) but ${err.message}`, ...result }; }
  }
  return {
    code: 0, status: 'applied', programRevision: outcome.record.programRevision, appliedBy: outcome.appliedBy,
    reopened: outcome.reopened ?? null, paused, relaunch: relaunched, ...result,
  };
}

// What was added, with its type, for the caller's next `wait`.
function addedLines(result, state) {
  const gates = new Set((state?.program?.control?.gates ?? []).map((gate) => gate.id));
  return [
    ...result.steps.map((stepId) => `step ${stepId}`),
    ...result.control.map((nodeId) => `${gates.has(nodeId) ? 'gate' : 'loop'} ${nodeId}`),
  ];
}

/** `bullswarm workflow add <runId> --steps <file.json> | --from-answer <step> [--summary s] [--wait s] [--json]`. */
export async function wfAdd(opts, { bullswarmDir, helpText, flagErrors, launchDetachedResume, routeIssues }) {
  const path = ['workflow', 'add'];
  if (opts.help) { console.log(helpText(path)); return 0; }
  const flagExit = flagErrors(opts, path);
  if (flagExit !== null) return flagExit;
  const [token] = opts.rest;
  const fromFile = typeof opts.steps === 'string' ? opts.steps : null;
  const fromAnswer = typeof opts['from-answer'] === 'string' ? opts['from-answer'] : null;
  if (!token || opts.rest.length > 1 || (!fromFile && !fromAnswer)) { console.error(`usage: ${usageLine(path)}`); return 2; }
  if (fromFile && fromAnswer) { console.error('✗ --steps and --from-answer are mutually exclusive: add from a file or from a step\'s answer'); return 2; }
  const waitSec = opts.wait === undefined ? 120 : Number(opts.wait);
  if (!Number.isFinite(waitSec) || waitSec < 0) { console.error('✗ --wait must be a non-negative number of seconds'); return 2; }
  let fragment = null;
  if (fromFile) {
    try { fragment = readFragmentFile(fromFile); } catch (err) { console.error(`✗ ${err.message}`); return 2; }
  }
  const relaunch = async (runId) => {
    const doc = JSON.parse(readFileSync(join(bullswarmDir, 'workflows', runId, 'goal.json'), 'utf8'));
    return launchDetachedResume(doc, runId, opts);
  };
  const result = await addV3Steps({
    bullswarmDir, token, fragment, fromAnswer, summary: typeof opts.summary === 'string' ? opts.summary : null,
    routeIssues, waitMs: waitSec * 1000, relaunch,
  });
  const { code, ...payload } = result;
  const id = result.shortId ?? result.runId ?? token;
  const ids = [...(result.steps ?? []), ...(result.control ?? [])];
  if (result.status === 'applied' || result.status === 'queued') {
    payload.next = { wait: `bullswarm workflow wait ${id} ${ids.join(' ')}`, watch: `bullswarm workflow watch ${id} --until trouble` };
  }
  if (opts.json) { console.log(JSON.stringify({ action: 'workflow-add', ...payload }, null, 2)); return code; }
  if (result.status === 'error') { console.error(`✗ ${result.why}`); return code; }
  if (result.status === 'rejected') {
    console.error(`✗ nothing added to ${id}${fromAnswer ? ` from the answer of ${fromAnswer}` : ''} (run unchanged)`);
    for (const issue of result.issues ?? []) console.error(`  - ${issue}`);
    return code;
  }
  if (result.status === 'queued') {
    console.log(`✓ add queued for ${id}; its running kernel applies it at its next check, and watch prints "plan revised"`);
  } else {
    const by = result.appliedBy === 'kernel' ? 'applied by its running kernel'
      : result.paused ? 'applied directly; the run stays paused' : 'applied directly; kernel relaunched';
    console.log(`✓ added to ${id}${fromAnswer ? ` from the answer of ${fromAnswer}` : ''} · revision ${result.programRevision} (${by})`);
    if (result.reopened) {
      const requeued = result.reopened.requeued ?? [];
      console.log(`  reopened the ${result.reopened.previousStatus} run; its earlier result is archived${requeued.length ? `; running again: ${requeued.join(', ')}` : ''}`);
      if (result.reopened.keptCancelled?.length) console.log(`  not run again (act step, may have acted): ${result.reopened.keptCancelled.join(', ')}`);
    }
  }
  let state = null;
  try { state = readState(resolveRunId(bullswarmDir, id)?.runDir ?? ''); } catch { state = null; }
  for (const line of addedLines(result, state)) console.log(`  added    ${line}`);
  if (result.paused) console.log(`  resume   bullswarm workflow resume ${id}`);
  console.log(`  wait     ${payload.next.wait}`);
  return code;
}

// --- workflow wait -------------------------------------------------------------

// Where a step or a node stops for the caller.
const STEP_SETTLED = new Set(['succeeded', 'failed', 'blocked', 'cancelled', 'removed']);
const NODE_SETTLED = new Set(['passed', 'waiting', 'blocked']);
const UNSUCCESSFUL = new Set(['failed', 'blocked', 'cancelled', 'removed']);
// A run in one of these states moves nothing by itself.
const STOPPED = new Set([...TERMINAL, 'waiting', 'paused', 'interrupted']);

function currentAttempts(state, runtime) {
  return (state.attempts ?? [])
    .filter((attempt) => attempt.actionId === runtime.id && attempt.ordinal > (runtime.supersededAttempts ?? 0))
    .sort((left, right) => left.ordinal - right.ordinal);
}

function secondsBetween(from, to) {
  const start = Date.parse(from ?? '');
  const end = Date.parse(to ?? '');
  return Number.isFinite(start) && Number.isFinite(end) && end >= start ? Math.round((end - start) / 1000) : null;
}

function evidenceFacts(results) {
  if (!Array.isArray(results)) return null;
  return results.map((item) => ({
    type: item?.type ?? null,
    ...(item?.type === 'schema' ? { file: item.file ?? null, schema: item.schema ?? null } : { cmd: item?.cmd ?? null }),
    status: item?.status ?? null,
    ...(item?.status && item.status !== 'passed' && item.why ? { why: String(item.why) } : {}),
  }));
}

function stepFacts(state, definition, runtime) {
  const attempts = currentAttempts(state, runtime);
  const last = attempts.findLast((attempt) => attempt.status === 'succeeded') ?? attempts.at(-1) ?? null;
  const failure = runtime.lastFailure ?? null;
  const deliverable = definition.deliverable === undefined ? null
    : typeof definition.deliverable === 'string' ? { type: definition.deliverable } : JSON.parse(JSON.stringify(definition.deliverable));
  const fact = {
    id: definition.id, type: 'step', status: runtime.status,
    pool: last?.pool ?? null, model: last?.model ?? null,
    durationSec: secondsBetween(runtime.startedAt, runtime.finishedAt),
    attempts: attempts.length,
    evidence: evidenceFacts(last?.evidenceResults),
    deliverable: deliverable ? {
      ...deliverable,
      produced: runtime.status === 'succeeded' ? true : failure?.kind === 'not-produced' ? false : null,
    } : null,
    outputFile: runtime.outputFile ?? null,
    ...(failure && runtime.status !== 'succeeded' ? { failure: { kind: failure.kind ?? null, why: failure.message ?? null } } : {}),
  };
  if (definition.answer !== undefined) {
    fact.answer = runtime.answer ? JSON.parse(JSON.stringify(runtime.answer.value)) : null;
    const checked = last?.answer;
    if (!runtime.answer && checked && checked.ok === false) fact.answerErrors = [...(checked.errors ?? [])];
  }
  return fact;
}

function nodeFacts(state, id) {
  const gate = (state.program.control?.gates ?? []).find((entry) => entry.id === id);
  const loop = (state.program.control?.loops ?? []).find((entry) => entry.id === id);
  const record = (state.controlNodes ?? []).find((entry) => entry.id === id) ?? null;
  const token = state.shortId ?? state.runId;
  const status = record?.status ?? 'pending';
  const fact = { id, type: gate ? 'gate' : 'loop', status, since: record?.at ?? null };
  if (gate?.note) fact.note = gate.note;
  if (loop) Object.assign(fact, { round: record?.round ?? 1, maxRounds: record?.maxRounds ?? loop.maxRounds });
  if (record?.reason) fact.reason = record.reason;
  if (status === 'waiting') {
    fact.next = gate ? `bullswarm workflow continue ${token} ${id}` : `bullswarm workflow continue ${token} ${id} --rounds <1-${CONTINUE_MAX_ROUNDS}>`;
  }
  return fact;
}

/** Each named id's facts, or {unknown} naming the ids the run does not have. */
export function waitFacts(state, ids) {
  const definitions = new Map(state.program.actions.map((action) => [action.id, action]));
  const runtimes = new Map(state.actions.map((action) => [action.id, action]));
  const control = new Set([...(state.program.control?.gates ?? []), ...(state.program.control?.loops ?? [])].map((node) => node.id));
  const unknown = ids.filter((id) => !(definitions.has(id) && runtimes.has(id)) && !control.has(id));
  if (unknown.length) return { unknown };
  return {
    nodes: ids.map((id) => (control.has(id) ? nodeFacts(state, id) : stepFacts(state, definitions.get(id), runtimes.get(id)))),
  };
}

const settled = (fact) => (fact.type === 'step' ? STEP_SETTLED : NODE_SETTLED).has(fact.status);

/**
 * The loops the named ids wait behind (through dependsOn, and a loop through
 * its steps) that have finished or stopped, each with its verdict and round:
 * what a watch woken at a gate prints, so a wait on the gate says it too.
 * A named loop is left out; it is among the nodes already.
 */
export function loopsBefore(state, ids) {
  const control = state.program.control ?? {};
  const loops = new Map((control.loops ?? []).map((loop) => [loop.id, loop]));
  const depends = new Map([
    ...state.program.actions.map((action) => [action.id, action.dependsOn ?? []]),
    ...(control.gates ?? []).map((gate) => [gate.id, gate.dependsOn ?? []]),
    ...(control.loops ?? []).map((loop) => [loop.id, loop.steps ?? []]),
  ]);
  const seen = new Set();
  const found = [];
  const visit = (id) => {
    for (const dep of depends.get(id) ?? []) {
      if (seen.has(dep)) continue;
      seen.add(dep);
      visit(dep);
      if (loops.has(dep) && !ids.includes(dep)) found.push(dep);
    }
  };
  for (const id of ids) visit(id);
  return found.map((id) => nodeFacts(state, id)).filter((fact) => NODE_SETTLED.has(fact.status));
}

/**
 * Poll the run until every named id is settled, the run stops moving them,
 * or the timeout passes. Resolves {code, status: settled|stopped|timeout|
 * error, run, nodes}. Exit code: 0 when none failed or was blocked, 1 when
 * one did or the run stopped short of one, 2 on timeout or unknown ids.
 */
export async function waitV3Nodes({
  bullswarmDir, token, ids, timeoutMs = null, pollMs = 1000, liveness = v2RunnerLiveness,
} = {}) {
  const resolved = resolveRunId(bullswarmDir, token);
  if (!resolved) return { code: 2, status: 'error', why: `no run found for "${token}"` };
  if (isLegacyRunDir(resolved.runDir)) return { code: 2, status: 'error', why: `run "${token}" is a legacy run; nothing drives it` };
  const deadline = timeoutMs == null ? Infinity : Date.now() + Math.max(0, timeoutMs);
  for (;;) {
    let state = null;
    try { state = readState(resolved.runDir); } catch { state = null; }
    if (state) {
      const base = { runId: state.runId, shortId: state.shortId ?? null, run: state.lifecycle.status };
      const facts = waitFacts(state, ids);
      if (facts.unknown) {
        const known = [...state.program.actions.map((action) => action.id), ...(state.program.control?.gates ?? []).map((gate) => gate.id), ...(state.program.control?.loops ?? []).map((loop) => loop.id)];
        return { code: 2, status: 'error', why: `run ${state.shortId ?? state.runId} has no step, gate or loop ${facts.unknown.join(', ')} (it has ${known.join(', ') || 'none'})`, ...base };
      }
      const failed = facts.nodes.some((fact) => UNSUCCESSFUL.has(fact.status));
      base.loops = loopsBefore(state, ids);
      if (facts.nodes.every(settled)) return { code: failed ? 1 : 0, status: 'settled', ...base, nodes: facts.nodes };
      const alive = liveness(state, { runDir: resolved.runDir });
      const stopped = STOPPED.has(state.lifecycle.status) || (alive.checked && !alive.alive);
      if (stopped) {
        const why = alive.checked && !alive.alive && !STOPPED.has(state.lifecycle.status) ? alive.reason : `the run is ${state.lifecycle.status}`;
        // A run parked at a gate or loop: each one it waits on, with the
        // command that moves it, since that is what the named ids wait behind.
        const parked = parkedWaitingFor(state);
        const waitingFor = parked ? { waitingFor: parked.map((entry) => nodeFacts(state, entry.id)) } : {};
        return { code: 1, status: 'stopped', why, ...base, nodes: facts.nodes, ...waitingFor };
      }
      if (Date.now() >= deadline) return { code: 2, status: 'timeout', ...base, nodes: facts.nodes };
    } else if (Date.now() >= deadline) return { code: 2, status: 'timeout', why: 'the run state could not be read' };
    await new Promise((done) => setTimeout(done, pollMs));
  }
}

function factLine(fact) {
  const g = glyphs();
  if (fact.type !== 'step') {
    const mark = fact.status === 'passed' ? g.ok : fact.status === 'waiting' ? g.waiting : fact.status === 'blocked' ? g.blocked : g.pending;
    const round = fact.type === 'loop' ? ` · round ${fact.round} of ${fact.maxRounds}` : '';
    const note = fact.note ? ` · ${fact.note}` : '';
    const reason = fact.reason ? ` · ${fact.reason}` : '';
    return [`${mark} ${fact.type} ${fact.id} ${fact.status}${round}${note}${reason}`, ...(fact.next ? [`  continue ${fact.next}`] : [])];
  }
  const mark = fact.status === 'succeeded' ? g.ok : fact.status === 'blocked' ? g.blocked
    : UNSUCCESSFUL.has(fact.status) ? g.fail : g.pending;
  const parts = [`${mark} ${fact.id} ${fact.status}`];
  if (fact.pool) parts.push(`${fact.pool}${fact.model ? ` · ${fact.model}` : ''}`);
  if (fact.durationSec != null) parts.push(formatDuration(fact.durationSec));
  if (fact.evidence?.length) parts.push(`evidence ${fact.evidence.filter((item) => item.status === 'passed').length}/${fact.evidence.length} passed`);
  if (fact.deliverable) parts.push(`deliverable ${fact.deliverable.type}${fact.deliverable.produced === true ? ' produced' : fact.deliverable.produced === false ? ' not produced' : ''}`);
  const lines = [parts.join(' · ')];
  if (fact.failure) lines.push(`  why      ${fact.failure.kind ?? 'failed'}: ${fact.failure.why ?? 'no reason recorded'}`);
  for (const item of fact.evidence ?? []) if (item.status !== 'passed') lines.push(`  evidence ${item.type === 'schema' ? `schema ${item.file}` : `\`${item.cmd}\``}: ${item.status}${item.why ? ` · ${item.why}` : ''}`);
  if (fact.outputFile) lines.push(`  output   ${fact.outputFile}`);
  if (Object.hasOwn(fact, 'answer')) {
    if (fact.answer === null) lines.push(`  answer   none checked${fact.answerErrors?.length ? ` · ${fact.answerErrors.join('; ')}` : ''}`);
    else lines.push('  answer', ...JSON.stringify(fact.answer, null, 2).split('\n').map((line) => `    ${line}`));
  }
  return lines;
}

/** `bullswarm workflow wait <runId> <id...> [--timeout <seconds>] [--json]`. */
export async function wfWait(opts, { bullswarmDir, helpText, flagErrors }) {
  const path = ['workflow', 'wait'];
  if (opts.help) { console.log(helpText(path)); return 0; }
  const flagExit = flagErrors(opts, path);
  if (flagExit !== null) return flagExit;
  const [token, ...ids] = opts.rest;
  if (!token || !ids.length) { console.error(`usage: ${usageLine(path)}`); return 2; }
  const timeoutSec = opts.timeout === undefined ? null : Number(opts.timeout);
  if (timeoutSec !== null && (!Number.isFinite(timeoutSec) || timeoutSec < 0)) { console.error('✗ --timeout must be a non-negative number of seconds'); return 2; }
  const result = await waitV3Nodes({ bullswarmDir, token, ids: [...new Set(ids)], timeoutMs: timeoutSec === null ? null : timeoutSec * 1000 });
  const { code, ...payload } = result;
  if (opts.json) { console.log(JSON.stringify({ action: 'workflow-wait', ...payload }, null, 2)); return code; }
  if (result.status === 'error') { console.error(`✗ ${result.why}`); return code; }
  const id = result.shortId ?? result.runId ?? token;
  for (const fact of [...(result.loops ?? []), ...(result.nodes ?? [])]) for (const line of factLine(fact)) console.log(line);
  if (result.status === 'timeout') console.log(`${glyphs().waiting} timed out after ${timeoutSec}s; the run is ${result.run ?? 'unreadable'}. Wait again: bullswarm workflow wait ${id} ${ids.join(' ')}`);
  if (result.status === 'stopped') {
    console.log(`${glyphs().stopped} ${result.why}; not every id finished. See bullswarm workflow runs show ${id}`);
    for (const node of result.waitingFor ?? []) {
      console.log(`  waiting  ${node.type} ${node.id}${node.note ? ` · ${node.note}` : ''}`);
      if (node.next) console.log(`  continue ${node.next}`);
    }
  }
  return code;
}
