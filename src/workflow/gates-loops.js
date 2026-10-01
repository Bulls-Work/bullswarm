// Gates and loops in the kernel (0.37.0, design section 4).
//
// A v3 program declares its gates and loops in state.program.control. Each
// one is a control node: the scheduler sees it as a pseudo-action
// {id, type: "gate"|"loop", dependsOn, status}, so a step may depend on a gate
// or a loop id, and dispatch, resume and cancel never touch it (they walk
// state.actions, which holds steps only). A node's status is kept in
// state.controlNodes:
//
//   pending  its dependencies (a gate) or its body steps (a loop) are not done
//   waiting  a gate whose dependencies succeeded, or a loop out of rounds: the
//            caller decides with `workflow continue`
//   passed   counts as success for the scheduler: its dependents run
//   blocked  a dependency or a body step failed or was blocked; its dependents
//            are blocked (the failure's own block is the caller's wake-up)
//
// A gate waits once its dependencies succeeded, or passes by itself when its
// `when` condition does not hold. A loop reruns its body steps under their
// own ids through the revision rerun path (earlier rounds stay on record as
// superseded attempts) until its `until` condition holds, or it runs out of
// rounds and waits. Inside a loop, the step named by an evidence-form `until`
// is not failed by its evidence: the attempt is recorded "checked, not
// passed" and the condition reads false.
//
// Loop rounds and gates are what the caller declared, never automatic
// behaviour. v2 runs have no control nodes and none of this runs for them.

import { clone } from '../lib/clone.js';
import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { appendEvent } from './events.js';
import { controlOf, controlRecords } from './control-nodes.js';
import { PROGRAM_V3_SCHEMA_VERSION } from './program-v3.js';
import {
  commitV2Revision, exportV2Plan, planV2Revision, rejectedRevisionRecord, removeStaleReceipts, revisionEventPayload,
} from './v2-revision.js';
import { scheduleV2Actions } from './v2-scheduler.js';
import { glyphs } from '../lib/glyphs.js';

// Extra rounds `workflow continue --rounds` may give an out-of-rounds loop.
export const CONTINUE_MAX_ROUNDS = 5;

const UNSUCCESSFUL = new Set(['failed', 'blocked', 'cancelled', 'interrupted']);
const SUCCESS = new Set(['succeeded', 'passed']);
const ANSWER_SHOWN_CHARS = 4000;
const TAIL_SHOWN_LINES = 20;
const LINE_SHOWN_CHARS = 200;

export { controlOf, controlRecords };

// --- the program's control nodes ---------------------------------------------

/**
 * How a loop ended, from its record: `passed` (its condition held),
 * `continued-unmet` (the caller continued it after its rounds ran out, so its
 * condition never held), `out-of-rounds` (waiting on the caller), `blocked`,
 * or `pending` (not finished).
 */
export function loopOutcome(record) {
  if (record?.status === 'passed') return record.reason === 'continued' ? 'continued-unmet' : 'passed';
  if (record?.status === 'waiting') return 'out-of-rounds';
  if (record?.status === 'blocked') return 'blocked';
  return 'pending';
}

/** Each declared loop's outcome, `[{id, outcome, rounds, maxRounds}]`; [] for a run with none. */
export function loopOutcomes(state) {
  return controlRecords(state).filter((record) => record.type === 'loop').map((record) => ({
    id: record.id, outcome: loopOutcome(record), rounds: record.round ?? 1, maxRounds: record.maxRounds,
  }));
}

// The mark of a loop the caller continued: an arrow, like the other arrows
// the views print (glyphs.js leaves the four arrows to every font).
export const CONTINUED_MARK = '→';

/** The words for a loop the caller continued: it never passed (QA37). */
export function continuedLoopText(id, rounds, maxRounds, { by = true } = {}) {
  return `loop ${id} continued${by ? ' by the caller' : ''} after ${rounds} of ${maxRounds} rounds (condition not met)`;
}

function ensureRecords(state) {
  state.controlNodes = controlRecords(state);
  return new Map(state.controlNodes.map((record) => [record.id, record]));
}

/**
 * What the scheduler reads: the steps plus, for a v3 run with gates or loops,
 * one pseudo-action per node and its status. A v2 run gets its own lists back
 * untouched.
 */
export function schedulerView(state) {
  const control = controlOf(state);
  if (!control) return { actions: state.program.actions, states: state.actions };
  const status = new Map(controlRecords(state).map((record) => [record.id, record.status]));
  const nodes = [
    ...control.loops.map((loop) => ({ id: loop.id, type: 'loop', dependsOn: [...loop.steps], ownedFiles: [] })),
    ...control.gates.map((gate) => ({ id: gate.id, type: 'gate', dependsOn: [...gate.dependsOn], ownedFiles: [] })),
  ];
  return {
    actions: [...state.program.actions, ...nodes],
    states: [...state.actions.map((action) => ({ id: action.id, status: action.status })), ...nodes.map((node) => ({ id: node.id, status: status.get(node.id) }))],
  };
}

function loopOfStep(state, stepId) {
  return controlOf(state)?.loops.find((loop) => loop.steps.includes(stepId)) ?? null;
}

// --- conditions --------------------------------------------------------------

// The step's current attempt: the latest one after the attempts a rerun superseded.
function currentAttempt(state, stepId, { succeeded = true } = {}) {
  const runtime = state.actions.find((action) => action.id === stepId);
  const floor = runtime?.supersededAttempts ?? 0;
  return state.attempts.findLast((attempt) => attempt.actionId === stepId && attempt.ordinal > floor
    && (!succeeded || attempt.status === 'succeeded')) ?? null;
}

/**
 * Read a condition ({step, field, equals} or {step, evidence: "passed"}) from
 * the step's current attempt. True or false, or null when it cannot be read
 * (no current answer, no evidence recorded).
 */
export function readCondition(state, condition) {
  if (!condition) return null;
  if (condition.evidence === 'passed') {
    const results = currentAttempt(state, condition.step)?.evidenceResults;
    if (!Array.isArray(results) || !results.length) return null;
    return results.every((item) => item?.status === 'passed');
  }
  const runtime = state.actions.find((action) => action.id === condition.step);
  const value = runtime?.answer?.value;
  if (value === null || typeof value !== 'object' || typeof value[condition.field] !== 'boolean') return null;
  return value[condition.field] === (condition.equals ?? true);
}

/** The condition in words: `check.passed is true`, `check's evidence passed`. */
export function describeCondition(condition) {
  if (!condition) return 'no condition';
  if (condition.evidence === 'passed') return `${condition.step}'s evidence passed`;
  return `${condition.step}.${condition.field} is ${condition.equals === false ? 'false' : 'true'}`;
}

/**
 * True when this step's evidence is its loop's `until` condition: a failed
 * check then reads as "checked, not passed" instead of failing the step
 * (dispatch option `evidenceAsCondition`).
 */
export function evidenceIsCondition(state, action) {
  const loop = loopOfStep(state, action?.id);
  return Boolean(loop && loop.until?.evidence === 'passed' && loop.until.step === action.id);
}

// --- the kernel's pass -------------------------------------------------------

/** The revision request that reruns a loop's body steps for its next round. */
function loopRerunRequest(state, loop, round, at) {
  const taken = new Set((state.revisions ?? []).map((entry) => entry.id));
  const base = `loop-${loop.id}-round-${round}`;
  let id = base;
  for (let k = 2; taken.has(id); k += 1) id = `${base}-${k}`;
  return {
    id, source: 'kernel', queuedAt: at, summary: `Loop ${loop.id} round ${round}: rerun ${loop.steps.join(', ')}`,
    baseRevision: state.program.revision, program: exportV2Plan(state).program, rerun: [...loop.steps], steeringIds: [],
  };
}

/**
 * Rerun a loop's body through the revision rerun path. `emit(type, payload)`
 * records an event (the kernel's persists the state). Returns true when the
 * revision applied.
 */
function rerunLoopBody(state, loop, round, { runDir, at, emit, features = null }) {
  const request = loopRerunRequest(state, loop, round, at);
  const planned = planV2Revision(state, request, { pendingSteeringIds: [], features });
  if (!planned.ok) {
    state.revisions = [...(state.revisions ?? []), rejectedRevisionRecord(request, planned.issues, at)];
    emit('program.revision_rejected', { requestId: request.id, issues: [...planned.issues], source: 'kernel' });
    return false;
  }
  const committed = commitV2Revision(state, planned, { request, runDir, at });
  emit('program.revised', revisionEventPayload(committed.record));
  removeStaleReceipts(runDir, committed.staleReceipts);
  return true;
}

function outcomeOf(state, records, id) {
  const step = state.actions.find((action) => action.id === id);
  return step ? step.status : records.get(id)?.status ?? 'pending';
}

function settle(record, status, at, reason) {
  record.status = status;
  record.at = at;
  if (reason) record.reason = reason;
  else delete record.reason;
}

function stepGate(state, gate, record, { at, emit, records }) {
  const deps = gate.dependsOn.map((id) => [id, outcomeOf(state, records, id)]);
  const failed = deps.find(([, status]) => UNSUCCESSFUL.has(status));
  if (record.status === 'pending' || record.status === 'blocked') {
    if (failed) {
      if (record.status === 'blocked') return false;
      settle(record, 'blocked', at, `${failed[0]} ${failed[1]}`);
      emit('gate.blocked', { gateId: gate.id, why: record.reason });
      return true;
    }
    if (!deps.every(([, status]) => SUCCESS.has(status))) {
      if (record.status !== 'blocked') return false;
      settle(record, 'pending', at);
      return true;
    }
    if (gate.when && readCondition(state, gate.when) === false) {
      settle(record, 'passed', at, 'when-false');
      emit('gate.passed', { gateId: gate.id, reason: 'when-false', condition: describeCondition(gate.when) });
      return true;
    }
    settle(record, 'waiting', at);
    emit('gate.waiting', { gateId: gate.id, note: gate.note ?? null });
    return true;
  }
  // A waiting gate whose dependencies were rerun waits for them again.
  if (record.status === 'waiting' && !deps.every(([, status]) => SUCCESS.has(status))) {
    settle(record, 'pending', at);
    return true;
  }
  return false;
}

function stepLoop(state, loop, record, { at, emit, records, rerun }) {
  if (record.status !== 'pending' && record.status !== 'blocked') return false;
  const body = loop.steps.map((id) => [id, outcomeOf(state, records, id)]);
  const failed = body.find(([, status]) => UNSUCCESSFUL.has(status));
  if (failed) {
    if (record.status === 'blocked') return false;
    settle(record, 'blocked', at, `${failed[0]} ${failed[1]}`);
    emit('loop.blocked', { loopId: loop.id, round: record.round, of: record.maxRounds, why: record.reason });
    return true;
  }
  if (!body.every(([, status]) => status === 'succeeded')) {
    if (record.status !== 'blocked') return false;
    settle(record, 'pending', at);
    return true;
  }
  const holds = readCondition(state, loop.until) === true;
  if (holds) {
    settle(record, 'passed', at);
    emit('loop.passed', { loopId: loop.id, round: record.round, of: record.maxRounds, condition: describeCondition(loop.until) });
    return true;
  }
  if (record.round >= record.maxRounds) {
    settle(record, 'waiting', at, 'out-of-rounds');
    emit('loop.out-of-rounds', { loopId: loop.id, round: record.round, of: record.maxRounds, condition: describeCondition(loop.until) });
    return true;
  }
  return nextRound(state, loop, record, { at, emit, rerun });
}

function nextRound(state, loop, record, { at, emit, rerun }) {
  const round = record.round + 1;
  if (!rerun(loop, round)) {
    settle(record, 'blocked', at, 'its next round could not start');
    emit('loop.blocked', { loopId: loop.id, round: record.round, of: record.maxRounds, why: record.reason });
    return true;
  }
  record.round = round;
  settle(record, 'pending', at);
  emit('loop.round', { loopId: loop.id, round, of: record.maxRounds, condition: describeCondition(loop.until) });
  return true;
}

/**
 * Apply one `workflow continue` intent: pass a waiting gate, or give an
 * out-of-rounds loop `rounds` more rounds (none: the loop ends continued,
 * condition not met, and the steps behind it run). Returns {applied, why}.
 */
function applyContinue(state, intent, { at, emit, rerun }) {
  const control = controlOf(state);
  if (!control) return { applied: false, why: 'this run has no gates or loops' };
  const records = ensureRecords(state);
  const record = records.get(intent.nodeId);
  if (!record) return { applied: false, why: `the run has no gate or loop ${intent.nodeId}` };
  if (record.status !== 'waiting') return { applied: false, why: `${record.type} ${record.id} is ${record.status}; only a waiting gate or loop can be continued` };
  const rounds = intent.rounds ?? null;
  if (record.type === 'gate') {
    if (rounds != null) return { applied: false, why: `--rounds applies to a loop; ${record.id} is a gate` };
    settle(record, 'passed', at, 'continued');
    emit('gate.passed', { gateId: record.id, reason: 'continued', source: intent.source ?? 'cli' });
    return { applied: true, why: null };
  }
  const loop = control.loops.find((entry) => entry.id === record.id);
  if (rounds == null) {
    settle(record, 'passed', at, 'continued');
    emit('loop.passed', { loopId: loop.id, round: record.round, of: record.maxRounds, reason: 'continued', source: intent.source ?? 'cli' });
    return { applied: true, why: null };
  }
  record.maxRounds += rounds;
  emit('loop.continued', { loopId: loop.id, rounds, of: record.maxRounds, source: intent.source ?? 'cli' });
  nextRound(state, loop, record, { at, emit, rerun });
  return { applied: true, why: null };
}

/**
 * Before the kernel marks steps blocked behind failures: a gate or loop left
 * blocked by a step the caller has since recovered (step rerun, step accept,
 * workflow resume) goes back to pending, so the steps behind it are not
 * blocked again by its stale record. Silent, like the control pass's own
 * blocked-to-pending move.
 */
export function unblockControlNodes(state, { at }) {
  const control = controlOf(state);
  if (!control || !(state.controlNodes ?? []).some((record) => record.status === 'blocked')) return;
  const records = new Map(state.controlNodes.map((record) => [record.id, record]));
  const nodes = [...control.loops.map((loop) => [loop.id, loop.steps]), ...control.gates.map((gate) => [gate.id, gate.dependsOn])];
  for (let pass = 0; pass <= nodes.length; pass += 1) {
    let moved = false;
    for (const [id, inputs] of nodes) {
      const record = records.get(id);
      if (record?.status !== 'blocked' || inputs.some((input) => UNSUCCESSFUL.has(outcomeOf(state, records, input)))) continue;
      settle(record, 'pending', at);
      moved = true;
    }
    if (!moved) break;
  }
}

/**
 * The kernel's control-node pass: apply the caller's continue intents, then
 * move every gate and loop as far as its dependencies allow. Emits
 * gate.waiting / loop.out-of-rounds the moment a node starts waiting, even
 * while other branches run. Returns true when anything changed.
 */
function advanceControlNodes(state, { runDir, at, emit, rerun }) {
  if (!controlOf(state)) return false;
  let changed = false;
  for (const intent of readContinueIntents(runDir).filter((entry) => !entry.appliedAt)) {
    const outcome = applyContinue(state, intent, { at, emit, rerun });
    markContinueApplied(runDir, intent, { at, refused: outcome.applied ? null : outcome.why });
    if (outcome.applied) changed = true;
    else emit('control.continue_refused', { nodeId: intent.nodeId, why: outcome.why });
  }
  const control = controlOf(state);
  for (let pass = 0; pass <= control.gates.length + control.loops.length; pass += 1) {
    const records = ensureRecords(state);
    let moved = false;
    for (const loop of control.loops) moved = stepLoop(state, loop, records.get(loop.id), { at, emit, records, rerun }) || moved;
    for (const gate of control.gates) moved = stepGate(state, gate, records.get(gate.id), { at, emit, records }) || moved;
    if (!moved) break;
    changed = true;
  }
  return changed;
}

/**
 * The kernel's hook, once per loop pass (before its "no dependency-ready
 * action can run" stop, its progress check and finalize): null for a run
 * with no gates or loops; `{changed: true}` when a node moved (the kernel
 * persists and looks again); `{waiting}` when the run parked.
 */
export function kernelControlPass(state, { runDir, at, emit, features = null, active = 0, schedulingOptions = {} }) {
  if (!controlOf(state)) return null;
  const rerun = (loop, round) => rerunLoopBody(state, loop, round, { runDir, at, emit, features });
  if (advanceControlNodes(state, { runDir, at, emit, rerun })) return { changed: true };
  const graph = schedulerView(state);
  const selectable = scheduleV2Actions(graph.actions, graph.states, schedulingOptions).selected.length > 0;
  const waiting = parkIfOnlyWaiting(state, { active: active > 0, selectable });
  if (waiting) emit('workflow.waiting', { waitingFor: waiting });
  return { changed: false, waiting };
}

// --- parking -----------------------------------------------------------------

/** The waiting nodes, as lifecycle.waitingFor records [{id, type, since, note}]. */
function waitingNodes(state) {
  const control = controlOf(state);
  if (!control) return [];
  return controlRecords(state).filter((record) => record.status === 'waiting').map((record) => {
    let note;
    if (record.type === 'gate') note = control.gates.find((gate) => gate.id === record.id)?.note;
    else {
      const loop = control.loops.find((entry) => entry.id === record.id);
      note = `out of rounds (${record.round} of ${record.maxRounds}); ${describeCondition(loop?.until)} did not hold`;
    }
    return { id: record.id, type: record.type, since: record.at, ...(note ? { note } : {}) };
  });
}

/**
 * Park the run when nothing is active, nothing can start and only waiting
 * gates or loops remain: lifecycle waiting with waitingFor. Returns the
 * waiting list, or null when the run goes on.
 */
function parkIfOnlyWaiting(state, { active, selectable }) {
  if (active || selectable) return null;
  const waiting = waitingNodes(state);
  if (!waiting.length) return null;
  state.lifecycle.status = 'waiting';
  state.lifecycle.waitingFor = waiting;
  return clone(waiting);
}

/** A run leaving the waiting state (resume, continue, finish) drops its waitingFor. */
export function clearWaitingFor(state) {
  if (state?.lifecycle && Object.hasOwn(state.lifecycle, 'waitingFor')) delete state.lifecycle.waitingFor;
}

// --- continue intents ----------------------------------------------------------

const INTENT_FILE = /^continue-([a-z0-9][a-z0-9-]*)\.json$/;

function intentPath(runDir, nodeId) {
  return join(runDir, `continue-${nodeId}.json`);
}

function writeIntent(path, intent) {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(intent, null, 2)}\n`);
  renameSync(tmp, path);
}

/** Record a durable continue intent; a newer one for the same node replaces an older one. */
export function requestContinue(runDir, { nodeId, rounds = null, source = 'cli', now = () => new Date().toISOString() }) {
  const intent = {
    schemaVersion: 1, id: `continue-${randomUUID().slice(0, 8)}`, nodeId,
    rounds: rounds ?? null, source, requestedAt: now(), appliedAt: null,
  };
  writeIntent(intentPath(runDir, nodeId), intent);
  return intent;
}

/** Every continue intent in the run directory, oldest first. */
export function readContinueIntents(runDir) {
  let names = [];
  try { names = readdirSync(runDir); } catch { return []; }
  const intents = [];
  for (const name of names) {
    const match = INTENT_FILE.exec(name);
    if (!match) continue;
    try {
      const intent = JSON.parse(readFileSync(join(runDir, name), 'utf8'));
      if (intent?.nodeId === match[1]) intents.push(intent);
    } catch { /* a half-written intent is read on the next poll */ }
  }
  return intents.sort((a, b) => String(a.requestedAt).localeCompare(String(b.requestedAt)));
}

/** True when an intent waits to be applied (the kernel's control poll). */
export function continuePending(runDir) {
  return readContinueIntents(runDir).some((intent) => !intent.appliedAt);
}

function markContinueApplied(runDir, intent, { at, refused = null }) {
  const path = intentPath(runDir, intent.nodeId);
  if (!existsSync(path)) return;
  writeIntent(path, { ...intent, appliedAt: at, ...(refused ? { refused } : {}) });
}

/** Why `workflow continue` cannot act on this node now, or null. */
export function continueRefusal(state, nodeId, rounds) {
  const control = controlOf(state);
  if (!control) return 'this run has no gates or loops';
  const record = controlRecords(state).find((entry) => entry.id === nodeId);
  if (!record) {
    const names = [...control.gates.map((gate) => `gate ${gate.id}`), ...control.loops.map((loop) => `loop ${loop.id}`)];
    return `the run has no gate or loop ${nodeId} (it has ${names.join(', ')})`;
  }
  if (rounds != null && record.type !== 'loop') return `--rounds applies to a loop; ${nodeId} is a gate`;
  if (record.status !== 'waiting') {
    return `${record.type} ${nodeId} is ${record.status}; only a waiting gate or an out-of-rounds loop can be continued`;
  }
  return null;
}

/**
 * Apply a continue intent to a run no kernel owns (the caller holds the
 * lease): the node moves, the lifecycle goes back to running, and the intent
 * is marked applied. The caller relaunches the kernel. Returns {applied, why}.
 */
export function applyContinueOffline(state, intent, { runDir, at, features = null }) {
  const emit = (type, payload) => appendEvent(runDir, state, type, payload);
  const rerun = (loop, round) => rerunLoopBody(state, loop, round, { runDir, at, emit, features });
  const outcome = applyContinue(state, intent, { at, emit, rerun });
  markContinueApplied(runDir, intent, { at, refused: outcome.applied ? null : outcome.why });
  if (!outcome.applied) return outcome;
  if (state.lifecycle.status === 'waiting') {
    clearWaitingFor(state);
    state.lifecycle.status = 'running';
  }
  return outcome;
}

// --- the caller's view ---------------------------------------------------------

/** The commands that move each waiting node. */
function continueCommands(token, waitingFor) {
  return (waitingFor ?? []).map((entry) => (entry.type === 'loop'
    ? `bullswarm workflow continue ${token} ${entry.id} --rounds <1-${CONTINUE_MAX_ROUNDS}>   (more rounds; without --rounds it ends continued, condition not met)`
    : `bullswarm workflow continue ${token} ${entry.id}`));
}

/**
 * The steps of a parked run that failed or are blocked, [{id, status, why}]:
 * a run parks at a gate or loop while an unrelated branch has failed, and the
 * caller has to see that failure too.
 */
export function parkedFailures(state) {
  if (!parkedWaitingFor(state)) return [];
  return (state.actions ?? []).filter((action) => action.status === 'failed' || action.status === 'blocked').map((action) => ({
    id: action.id, status: action.status,
    why: action.lastFailure?.message ?? action.lastFailure?.kind ?? null,
  }));
}

// The commands that recover each failed step (a blocked one follows its failure).
function recoverCommands(token, failed) {
  return (failed ?? []).filter((entry) => entry.status === 'failed').flatMap((entry) => [
    `bullswarm workflow step rerun ${token} ${entry.id}`,
    `bullswarm workflow step accept ${token} ${entry.id} --reason "…"`,
  ]);
}

/** The lines `goal`, `watch` and `runs` print for a parked run. */
export function waitingOutcomeLines(token, waitingFor, failed = []) {
  const lines = ['outcome: waiting'];
  for (const entry of waitingFor ?? []) lines.push(`waiting: ${entry.type} ${entry.id}${entry.note ? ` · ${entry.note}` : ''}`);
  for (const entry of failed ?? []) lines.push(`${entry.status}: step ${entry.id}${entry.why ? ` · ${entry.why}` : ''}`);
  const commands = [...continueCommands(token, waitingFor), ...recoverCommands(token, failed)];
  commands.forEach((command, index) => lines.push(`${index === 0 ? 'next:' : '  or:'} ${command}`));
  return lines;
}

/** The JSON document for a parked run; `failed` only when a step failed or is blocked. */
export function waitingDocument({ runId, shortId, waitingFor, failed = [] }) {
  const token = shortId ?? runId;
  return {
    action: 'workflow-waiting', runId, shortId: shortId ?? null, status: 'waiting',
    waitingFor: clone(waitingFor ?? []),
    ...(failed?.length ? { failed: clone(failed) } : {}),
    next: [...continueCommands(token, waitingFor), ...recoverCommands(token, failed)],
  };
}

/** The watch --jsonl line for a parked run. */
export function waitingWatchLine(token, waitingFor, failed = []) {
  return {
    type: 'waiting', waitingFor, ...(failed?.length ? { failed: clone(failed) } : {}),
    next: [...continueCommands(token, waitingFor), ...recoverCommands(token, failed)],
  };
}

/** The snapshot key a watcher reads: the waiting nodes of a parked run, or undefined. */
export function parkedWaitingFor(state) {
  const lifecycle = state?.lifecycle ?? {};
  return lifecycle.status === 'waiting' && Array.isArray(lifecycle.waitingFor) && lifecycle.waitingFor.length
    ? clone(lifecycle.waitingFor) : undefined;
}

/** One gate or loop event as a watch line's input, or null for any other event. */
export function controlWatchEvent(event, { token }) {
  const payload = event?.payload ?? {};
  switch (event?.type) {
    case 'gate.waiting': case 'gate.passed': case 'gate.blocked':
      return { type: event.type, gateId: payload.gateId ?? null, note: payload.note ?? null, reason: payload.reason ?? null, why: payload.why ?? null, condition: payload.condition ?? null, token };
    case 'loop.round': case 'loop.passed': case 'loop.out-of-rounds': case 'loop.blocked': case 'loop.continued':
      return {
        type: event.type, loopId: payload.loopId ?? null, round: payload.round ?? null, of: payload.of ?? null,
        rounds: payload.rounds ?? null, reason: payload.reason ?? null, why: payload.why ?? null, condition: payload.condition ?? null, token,
      };
    case 'control.continue_refused':
      return { type: event.type, nodeId: payload.nodeId ?? null, why: payload.why ?? null, token };
    default:
      return null;
  }
}

/** `watch --until trouble` wakes on a gate or loop that starts waiting. */
export function controlTrouble(event) {
  return event?.type === 'gate.waiting' || event?.type === 'loop.out-of-rounds' ? 'waiting' : null;
}

/**
 * A loop that finished (passed or blocked). An `--until` watch prints it
 * without waking, so the wake that follows (a gate, the end) carries each
 * loop's verdict and round and the caller needs no extra `workflow wait`.
 */
export function isLoopVerdict(event) {
  return event?.type === 'loop.passed' || event?.type === 'loop.blocked';
}

/** A gate or loop event as one human line, or null. */
export function renderControlEvent(event) {
  const g = glyphs();
  switch (event?.type) {
    case 'gate.waiting':
      return `${g.waiting} gate ${event.gateId} waiting${event.note ? ` · ${event.note}` : ''} · continue: bullswarm workflow continue ${event.token} ${event.gateId}`;
    case 'gate.passed':
      return `${g.ok} gate ${event.gateId} passed · ${event.reason === 'continued' ? 'continued by the caller' : `${event.condition ?? 'its condition'} does not hold`}`;
    case 'gate.blocked':
      return `${g.blocked} gate ${event.gateId} blocked · ${event.why ?? 'a dependency did not succeed'}`;
    case 'loop.round':
      return `${g.retry} loop ${event.loopId} round ${event.round} of ${event.of} · ${event.condition ?? 'its condition'} did not hold`;
    case 'loop.passed':
      return event.reason === 'continued'
        ? `${CONTINUED_MARK} ${continuedLoopText(event.loopId, event.round, event.of)}`
        : `${g.ok} loop ${event.loopId} passed in round ${event.round} of ${event.of} · ${event.condition ?? 'its condition'}`;
    case 'loop.out-of-rounds':
      return `${g.waiting} loop ${event.loopId} out of rounds (${event.round} of ${event.of}) · ${event.condition ?? 'its condition'} did not hold · continue: bullswarm workflow continue ${event.token} ${event.loopId} --rounds <n>`;
    case 'loop.blocked':
      return `${g.blocked} loop ${event.loopId} blocked in round ${event.round}${event.of != null ? ` of ${event.of}` : ''} · ${event.why ?? 'a step did not succeed'}`;
    case 'loop.continued':
      return `${g.started} loop ${event.loopId} continued · ${event.rounds} more round${event.rounds === 1 ? '' : 's'} (now ${event.of})`;
    case 'control.continue_refused':
      return `× continue ${event.nodeId} refused · ${event.why ?? 'no reason recorded'}`;
    default:
      return null;
  }
}

// --- loop round prompts ----------------------------------------------------------

function cut(text, max) {
  const chars = [...String(text)];
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : String(text);
}

function previousAttempt(state, stepId) {
  const runtime = state.actions.find((action) => action.id === stepId);
  const floor = runtime?.supersededAttempts ?? 0;
  const earlier = state.attempts.filter((attempt) => attempt.actionId === stepId && attempt.ordinal <= floor);
  return earlier.findLast((attempt) => attempt.status === 'succeeded') ?? earlier.at(-1) ?? null;
}

function evidenceLines(results) {
  const lines = [];
  for (const item of results ?? []) {
    const what = item.type === 'schema' ? `schema ${item.file} against ${item.schema}` : `command \`${item.cmd}\``;
    lines.push(`  - evidence ${what}: ${item.status}${item.why && item.status !== 'passed' ? ` · ${item.why}` : ''}`);
    if (item.status === 'passed') continue;
    if (item.log) lines.push(`    output: ${item.log}`);
    const rows = item.type === 'schema' && Array.isArray(item.errors) && item.errors.length
      ? item.errors : String(item.tail ?? '').split('\n').filter((line) => line.trim());
    for (const row of rows.slice(-TAIL_SHOWN_LINES)) lines.push(`      ${cut(row, LINE_SHOWN_CHARS)}`);
  }
  return lines;
}

/**
 * The "Previous round" block a loop step's prompt carries from round 2 on:
 * what each of the loop's steps produced in the round before (its answer, its
 * evidence and its output file). Null for round 1 and for steps in no loop.
 */
export function previousRoundBlock(state, action) {
  const loop = loopOfStep(state, action?.id);
  if (!loop) return null;
  const record = controlRecords(state).find((entry) => entry.id === loop.id);
  if (!record || record.round < 2) return null;
  const lines = [
    `## Previous round (loop ${loop.id}, now round ${record.round} of ${record.maxRounds})`,
    `The loop runs its steps again because ${describeCondition(loop.until)} did not hold after round ${record.round - 1}. What its steps produced in round ${record.round - 1}:`,
  ];
  // A step blind to another (blindTo) sees that it ran, its status and its
  // evidence (Bullswarm's own facts), never its answer or output file.
  const blind = new Set(Array.isArray(action.blindTo) ? action.blindTo : []);
  for (const stepId of loop.steps) {
    const attempt = previousAttempt(state, stepId);
    if (!attempt) { lines.push(`- ${stepId}: did not run`); continue; }
    lines.push(`- ${stepId} (attempt ${attempt.id}, ${attempt.status})`);
    if (!blind.has(stepId) && attempt.answer && attempt.answer.value !== undefined && attempt.answer.value !== null) {
      lines.push(`  - answer: ${cut(JSON.stringify(attempt.answer.value), ANSWER_SHOWN_CHARS)}`);
    }
    lines.push(...evidenceLines(attempt.evidenceResults));
    if (!blind.has(stepId) && attempt.outputFile) lines.push(`  - output: ${attempt.outputFile}`);
  }
  lines.push('Use this to make this round succeed where the last one did not.');
  return lines.join('\n');
}

// --- launch and validate wording for a v3 program ------------------------------

/** A v3 program's gates and loops, from its authored ({gates, loops}) or stored ({control}) form. */
export function programControl(program) {
  const inner = program?.program && typeof program.program === 'object' ? program.program : program;
  if (inner?.schemaVersion !== PROGRAM_V3_SCHEMA_VERSION) return null;
  return { gates: inner.control?.gates ?? inner.gates ?? [], loops: inner.control?.loops ?? inner.loops ?? [] };
}

/**
 * The launch instruction of a caller-planned v3 run: work is added with
 * `workflow add`, and the run says where it stops for the caller (its gates,
 * a loop out of rounds) instead of "never waits".
 */
export function v3LaunchInstruction(control, token) {
  const gates = (control?.gates ?? []).map((gate) => `gate ${gate.id}${gate.when ? ' (unless its condition does not hold)' : ''}`);
  const loops = (control?.loops ?? []).map((loop) => `loop ${loop.id} if its ${loop.maxRounds} round${loop.maxRounds === 1 ? '' : 's'} run out`);
  const add = 'Add steps, gates or loops at any time with workflow add (nothing the run has changes), and read any step\'s facts and answer with workflow wait.';
  const stops = [...gates, ...loops];
  const purpose = stops.length
    ? `${add} The run stops for you at ${stops.join(', ')}: watch --until trouble wakes you there, and bullswarm workflow continue ${token} <id> moves it on. When it finishes, its result hands back whatever is left.`
    : `${add} It declares no gate or loop, so it never stops for you; when it finishes, its result hands back whatever is left.`;
  return { purpose, command: `bullswarm workflow add ${token} --steps part.json` };
}

/** The lines `plan validate` prints for a v3 program's gates and loops. */
export function controlSummaryLines(control) {
  const lines = [];
  for (const gate of control?.gates ?? []) {
    lines.push(`  gate ${gate.id.padEnd(19)} after ${gate.dependsOn.join(', ') || '(nothing)'}${gate.when ? ` · waits when ${describeCondition(gate.when)}` : ' · waits for you'}${gate.note ? ` · ${gate.note}` : ''}`);
  }
  for (const loop of control?.loops ?? []) {
    lines.push(`  loop ${loop.id.padEnd(19)} steps ${loop.steps.join(', ')} · until ${describeCondition(loop.until)} · at most ${loop.maxRounds} round${loop.maxRounds === 1 ? '' : 's'}`);
  }
  return lines;
}
