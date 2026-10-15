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
// A loop whose until is the dry form {step, dry} (0.38.12, dry-loops.js)
// decides right after its review instead of at the end of the round: the
// control pass merges the review's findings into the loop's known list, skips
// the loop's other steps when nothing new is worth fixing, and ends the loop
// when the review has run dry. A skipped step is settled succeeded with a
// `skipped` marker (no worker runs), never counted as proven.
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
import { presentationStageStatus, stageForAction } from './v2-presentation.js';
import { glyphs } from '../lib/glyphs.js';
import {
  DEFAULT_FLOOR, dryContext, dryVerdict, fixStepsOf, fixersOf, floorOf, groupAnswers, groupOf, isDryLoop, knownBefore, loopFindingsSummary, mergeRound, onceFixersOf, roundAnswersChanged, skippedInRound,
} from './dry-loops.js';

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

/**
 * Each declared loop's outcome, `[{id, outcome, rounds, maxRounds, findings?}]`;
 * [] for a run with none. `findings` only on a dry loop after its first
 * review: {known, outOfScope, rounds, stillOpen?, dryIn?, unreviewed?}
 * (dry-loops.js); stillOpen (per round) only once a round reported one.
 */
export function loopOutcomes(state) {
  const loops = new Map((controlOf(state)?.loops ?? []).map((loop) => [loop.id, loop]));
  return controlRecords(state).filter((record) => record.type === 'loop').map((record) => {
    const loop = loops.get(record.id);
    const summary = isDryLoop(loop) ? loopFindingsSummary(loop, record, groupOf(state, loop)) : null;
    return {
      id: record.id, outcome: loopOutcome(record), rounds: record.round ?? 1, maxRounds: record.maxRounds,
      ...(summary ? {
        findings: {
          known: summary.known, outOfScope: summary.outOfScope, rounds: summary.rounds,
          ...(summary.stillOpen.some((count) => count > 0) ? { stillOpen: summary.stillOpen } : {}),
          ...(summary.dryIn !== undefined ? { dryIn: summary.dryIn } : {}),
          ...(summary.yieldIn !== undefined ? { yieldIn: summary.yieldIn } : {}),
          ...(summary.unreviewed ? { unreviewed: summary.unreviewed } : {}),
        },
      } : {}),
    };
  });
}

/** The words for a loop that ended dry: `loop harden ended dry in round 3 of 4 (12 findings)`. */
export function dryLoopText(id, round, maxRounds, known, { yieldStop = false } = {}) {
  return `loop ${id} ended ${yieldStop ? 'on low yield' : 'dry'} in round ${round} of ${maxRounds} (${known} finding${known === 1 ? '' : 's'})`;
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
 * (no current answer, no evidence recorded). The dry form reads its loop's
 * verdict (null before the review's first round is merged).
 */
export function readCondition(state, condition) {
  if (!condition) return null;
  if (condition.dry !== undefined) {
    const loop = controlOf(state)?.loops.find((entry) => isDryLoop(entry) && entry.until.step === condition.step);
    const record = loop ? controlRecords(state).find((entry) => entry.id === loop.id) : null;
    return loop ? dryVerdict(loop, record, groupOf(state, loop))?.dry ?? null : null;
  }
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

/**
 * The condition in words: `check.passed is true`, `check's evidence passed`,
 * `review finds nothing new (1 round)` (`areas`: `…, every area`).
 */
export function describeCondition(condition, { areas = false } = {}) {
  if (!condition) return 'no condition';
  if (condition.dry !== undefined) {
    // 0.38.15: only findings at or above the floor count as new.
    const floor = condition.floor ?? DEFAULT_FLOOR;
    return `${condition.step} finds nothing new at or above ${floor} (${condition.dry} round${condition.dry === 1 ? '' : 's'}${areas ? ', every area' : ''})`;
  }
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

// A loop's until in words, saying "every area" when its review has areas.
function untilText(state, loop) {
  return describeCondition(loop?.until, { areas: Boolean(groupOf(state, loop)?.areas.length) });
}

// --- the kernel's pass -------------------------------------------------------

/** The revision request that reruns a loop's body steps for its next round. */
function loopRerunRequest(state, loop, round, at, { steps = loop.steps, summary = null } = {}) {
  const taken = new Set((state.revisions ?? []).map((entry) => entry.id));
  const base = `loop-${loop.id}-round-${round}`;
  let id = base;
  for (let k = 2; taken.has(id); k += 1) id = `${base}-${k}`;
  return {
    id, source: 'kernel', queuedAt: at, summary: summary ?? `Loop ${loop.id} round ${round}: rerun ${steps.join(', ')}`,
    baseRevision: state.program.revision, program: exportV2Plan(state).program, rerun: [...steps], steeringIds: [],
  };
}

/**
 * Rerun a loop's body through the revision rerun path. `emit(type, payload)`
 * records an event (the kernel's persists the state). `apply()` runs after the
 * rerun changed the state and before its event, so what the round also
 * changes (its number, the steps it skips) is saved with the rerun, never
 * after it. Returns true when the revision applied.
 */
function rerunLoopBody(state, loop, round, { runDir, at, emit, features = null, apply = null, steps = undefined, summary = null }) {
  const request = loopRerunRequest(state, loop, round, at, { steps, summary });
  const planned = planV2Revision(state, request, { pendingSteeringIds: [], features });
  if (!planned.ok) {
    state.revisions = [...(state.revisions ?? []), rejectedRevisionRecord(request, planned.issues, at)];
    emit('program.revision_rejected', { requestId: request.id, issues: [...planned.issues], source: 'kernel' });
    return false;
  }
  const committed = commitV2Revision(state, planned, { request, runDir, at });
  apply?.();
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
  // A waiting dry loop, or one that passed (dry, or ended by the caller's
  // `workflow continue`), still learns a reviewer's new answer (a step rerun
  // of it, or of the work it reviews): a finding it brings is never dropped,
  // and its fixer runs with it (mergeDryRound).
  if (isDryLoop(loop) && (record.status === 'waiting' || (record.status === 'passed' && ['dry', 'yield', 'continued'].includes(record.reason)))) {
    return mergeDryRound(state, loop, record, { at, emit, rerun });
  }
  if (record.status !== 'pending' && record.status !== 'blocked') return false;
  // A dry loop decides right after its review, before the scheduler can
  // start a step that comes after it, even when a step beside the review has
  // failed: the merge is what skips the fixer on a clean round.
  if (isDryLoop(loop) && mergeDryRound(state, loop, record, { at, emit, rerun })) return true;
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
  if (holds && isDryLoop(loop)) {
    // Dry since the merge; a step beside the review was still running then
    // (or, for a yield stop, the fixer had this round's findings to fix).
    settle(record, 'passed', at, dryVerdict(loop, record, groupOf(state, loop))?.by ?? 'dry');
    emitDryPassed(state, loop, record, { emit });
    return true;
  }
  if (holds) {
    settle(record, 'passed', at);
    emit('loop.passed', { loopId: loop.id, round: record.round, of: record.maxRounds, condition: untilText(state, loop) });
    return true;
  }
  if (record.round >= record.maxRounds) {
    settle(record, 'waiting', at, 'out-of-rounds');
    const findings = dryOutOfRounds(state, loop, record);
    emit('loop.out-of-rounds', { loopId: loop.id, round: record.round, of: record.maxRounds, condition: untilText(state, loop), ...(findings ? { findings } : {}) });
    return true;
  }
  return nextRound(state, loop, record, { at, emit, rerun });
}

function nextRound(state, loop, record, { at, emit, rerun }) {
  const round = record.round + 1;
  // A dry loop's steps before its review fix what the last round found: none
  // of them runs when it found nothing worth fixing.
  const last = isDryLoop(loop) ? record.findings?.rounds?.find((entry) => entry.round === round - 1) ?? null : null;
  let skipped = [];
  // The rerun forgets which steps the caller accepted (a rerun undoes an
  // accept); a step this round skips without running it was still accepted
  // last, so the loop keeps them (skipSteps puts one back).
  const accepted = isDryLoop(loop) ? acceptedStepsOf(state, loop) : null;
  // The round number and the skips go into the rerun's own state change
  // (one save), so a kernel that stops right after it never runs a skipped step.
  const started = rerun(loop, round, () => {
    record.round = round;
    settle(record, 'pending', at);
    if (!isDryLoop(loop)) return;
    if (Object.keys(accepted).length) record.accepted = accepted;
    else delete record.accepted;
    const group = groupOf(state, loop);
    // A builder before the review, with a fixer after it, runs in round 1
    // only: the fixer is handed the findings (onceFixersOf).
    skipped = skipSteps(state, onceFixersOf(state, loop, group), { loopId: loop.id, round, at, why: SKIP_ONCE_WHY, record });
    if (last && last.new + last.reopened === 0) {
      skipped = [...skipped, ...skipSteps(state, fixStepsOf(state, loop, group).before, { loopId: loop.id, round, at, record })];
    }
  });
  if (!started) {
    settle(record, 'blocked', at, 'its next round could not start');
    emit('loop.blocked', { loopId: loop.id, round: record.round, of: record.maxRounds, why: record.reason });
    return true;
  }
  emit('loop.round', {
    loopId: loop.id, round, of: record.maxRounds, condition: untilText(state, loop),
    ...(last ? { found: { new: last.new, reopened: last.reopened } } : {}),
  });
  emitSkipped(state, skipped, { at, emit });
  return true;
}

// --- dry loops (dry-loops.js) ---------------------------------------------------

const SKIP_WHY = 'nothing new to fix';
const SKIP_ONCE_WHY = 'its work was done in round 1; the review\'s findings go to the fix after it';

// Settle loop steps that have nothing to fix this round: succeeded, no worker,
// marked skipped. A step that ran in an earlier round keeps pointing at that
// run's output and checked answer, so the result still names what it did (its proof is read from
// that attempt, v2-outcome.js). Returns the ids it settled.
function skipSteps(state, ids, { loopId, round, at, why = SKIP_WHY, record = null }) {
  const settled = [];
  for (const id of ids) {
    const runtime = state.actions.find((action) => action.id === id);
    if (!runtime || !['pending', 'ready'].includes(runtime.status)) continue;
    const ran = state.attempts.findLast((attempt) => attempt.actionId === id && attempt.status === 'succeeded') ?? null;
    Object.assign(runtime, {
      status: 'succeeded', finishedAt: at, outputFile: ran?.outputFile ?? null, artifactIds: [], lastFailure: null,
      skipped: { loopId, round, why, at },
    });
    // Its checked answer from that run too (the round's rerun cleared it).
    const declared = state.program.actions.find((action) => action.id === id);
    if (declared?.answer !== undefined && ran?.answer?.ok) runtime.answer = { attemptId: ran.id, value: clone(ran.answer.value) };
    // A step the caller accepted after it failed, and no attempt has run since:
    // skipping it must not turn that accept into "nothing to fix".
    const kept = record?.accepted?.[id];
    const latest = state.attempts.findLast((attempt) => attempt.actionId === id) ?? null;
    if (kept && (latest?.id ?? null) === (kept.attemptId ?? null)) runtime.acceptance = clone(kept);
    settled.push(id);
  }
  return settled;
}

// The loop's steps the caller accepted by choice (not a check's requirement
// acceptance), by id: the record a rerun is about to erase.
function acceptedStepsOf(state, loop) {
  const found = {};
  for (const id of loop.steps) {
    const acceptance = state.actions.find((action) => action.id === id)?.acceptance;
    if (acceptance && !Array.isArray(acceptance.requirements)) found[id] = clone(acceptance);
  }
  return found;
}

// The finished event of each skipped step, then its phase started and
// completed as the kernel does for a step it settles without running (a
// blocked one), so a phase never reads as completed before it started.
function emitSkipped(state, ids, { at, emit }) {
  for (const id of ids) {
    const { loopId, round, why } = state.actions.find((action) => action.id === id).skipped;
    const stage = stageForAction(state.presentation, id);
    if (stage && !stage.startedAt) {
      stage.startedAt = at;
      emit('presentation.stage_started', { stageId: stage.id, label: stage.label, revision: stage.revision, actionIds: clone(stage.actionIds) });
    }
    emit('action.finished', { actionId: id, status: 'succeeded', skipped: { loopId, round, why } });
  }
  if (!ids.length) return;
  for (const stage of state.presentation?.stages ?? []) {
    if (!stage.startedAt || stage.completedAt) continue;
    const status = presentationStageStatus(stage, state.actions);
    if (!status.terminal) continue;
    stage.completedAt = at;
    emit('presentation.stage_completed', {
      stageId: stage.id, label: stage.label, revision: stage.revision,
      status: status.successful ? 'completed' : 'completed-with-gaps', completed: status.completed, total: status.total,
    });
  }
}

/**
 * Once every reviewer of the round has succeeded, merge its findings into the
 * loop's record (once per round, or again when a reviewer answered anew
 * since: a `step rerun` of it or of the work it reviews), skip the steps after
 * the review when nothing is worth fixing, and end the loop when the review
 * ran dry and every other step of the round has succeeded or was skipped (a
 * step beside the review may still be running; the loop then passes when it
 * is done, in stepLoop). One state change, made before any event is written,
 * so a kernel that stops in between never runs a fixer that should have been
 * skipped. A blocked loop merges too (a step beside the review failed), so its
 * skips still hold. A waiting loop only learns the round: it waits unless its
 * review has now run dry. A loop that passed (dry, or ended by `workflow
 * continue`) and is no longer dry goes back to pending in its round, so its fixer runs with the new findings; one
 * still dry stays passed. True when it merged.
 */
function mergeDryRound(state, loop, record, { at, emit, rerun }) {
  const group = groupOf(state, loop);
  const findings = record.findings ?? { rounds: [], known: [], knownDropped: 0 };
  const already = findings.rounds.find((entry) => entry.round === record.round) ?? null;
  if (already ? !roundAnswersChanged(state, group, already) : record.status === 'waiting' || record.status === 'passed') return false;
  if (!group.steps.every((id) => state.actions.find((action) => action.id === id)?.status === 'succeeded')) return false;
  const { before, after } = fixStepsOf(state, loop, group);
  const fixes = before.length + after.length > 0;
  // Only a fixer mends a known finding between rounds, so only with one is
  // a finding reported still open news (a lint beside the review is no fixer).
  const fixers = fixersOf(state, loop, group);
  const answers = groupAnswers(state, group, record.round);
  // Merged again: from the list as it stood before this round.
  const base = already ? knownBefore(findings, record.round) : { known: findings.known, knownDropped: findings.knownDropped, dropped: findings.dropped ?? [] };
  const merged = mergeRound({ answers, ...base, round: record.round, reopen: fixers.length > 0, floor: floorOf(loop) });
  const worthy = merged.entry.new + merged.entry.reopened;
  const entry = {
    ...merged.entry, fix: !fixes ? 'none' : worthy ? 'runs' : 'skipped',
    answers: Object.fromEntries(answers.map((answer) => [answer.step, answer.attemptId])),
  };
  const nextFindings = {
    rounds: [...findings.rounds.filter((item) => item.round !== record.round), entry], known: merged.known, knownDropped: merged.knownDropped,
    ...(merged.dropped.length ? { dropped: merged.dropped } : {}),
  };
  const verdict = dryVerdict(loop, { ...record, findings: nextFindings }, group);
  // A passed loop that this answer reopens must reset the steps behind it, and
  // a step still running there cannot be reset under its worker (the
  // scheduler would see it active behind an unfinished loop). Merge nothing
  // yet: the answer stays unmerged (its attempt differs from the round's
  // record), so this runs again when that step has finished, and its result
  // is then rerun with the rest.
  if (record.status === 'passed' && !verdict.dry && stepsBehind(state, loop).actions.some((id) => state.actions.find((action) => action.id === id)?.status === 'running')) return false;
  record.findings = nextFindings;
  const skipped = worthy ? [] : skipSteps(state, after, { loopId: loop.id, round: record.round, at, record });
  const done = loop.steps.every((id) => state.actions.find((action) => action.id === id)?.status === 'succeeded');
  const passes = verdict.dry && done;
  const known = merged.known.filter((item) => item.inScope).length;
  const wasPassed = record.status === 'passed';
  if (passes && !wasPassed) settle(record, 'passed', at, verdict.by ?? 'dry');
  // Passed dry, and the new answer is not dry: the round goes on.
  const reopened = !verdict.dry && wasPassed;
  if (reopened) settle(record, 'pending', at);
  emit('loop.findings', {
    loopId: loop.id, round: record.round, of: record.maxRounds,
    new: entry.new, reopened: entry.reopened, repeated: entry.repeated, outOfScope: entry.outOfScope, known,
    areas: entry.reviewed.map((area) => group.areas[area] ?? null).filter(Boolean),
    unreviewed: verdict.unreviewed.map((area) => group.areas[area]).filter(Boolean),
    clean: verdict.clean, need: verdict.need, dry: verdict.dry, ...(verdict.by ? { by: verdict.by } : {}), fix: fixWhen(entry.fix, after, fixers),
  });
  emitSkipped(state, skipped, { at, emit });
  if (passes && !wasPassed) emitDryPassed(state, loop, record, { emit });
  if (reopened) rerunStepsBehind(state, loop, record, { at, emit, rerun });
  return true;
}

// What comes after a loop, through steps, gates and later loops: {actions,
// gates} (ids), the steps and gates that depend on it directly or by way of
// another. A passed gate does not stop the walk: what is behind it was made
// from the loop's result too.
function stepsBehind(state, loop) {
  const control = controlOf(state);
  const dependents = new Map();
  const add = (from, to) => dependents.set(from, [...(dependents.get(from) ?? []), to]);
  for (const action of state.program.actions) for (const id of action.dependsOn) add(id, action.id);
  for (const gate of control.gates) for (const id of gate.dependsOn) add(id, gate.id);
  for (const other of control.loops) for (const id of other.steps) add(id, other.id);
  const reached = new Set();
  const queue = [loop.id];
  while (queue.length) for (const next of dependents.get(queue.shift()) ?? []) if (!reached.has(next)) { reached.add(next); queue.push(next); }
  return {
    actions: state.program.actions.map((action) => action.id).filter((id) => reached.has(id)),
    gates: control.gates.map((gate) => gate.id).filter((id) => reached.has(id)),
  };
}

// A loop that passed and now goes on has finished work behind it that was made
// from the old result (a ship step that ran when it passed, behind a gate or
// not), and gates the caller passed on that result. Nothing reruns those when
// the loop is at its last round (no next round reruns them), so reset them
// now, while the loop is pending and they cannot start before it ends again.
// A passed gate waits again: the approval was of the old result. Their own
// dependents follow through the revision walk. The steps are reset together
// with the gates, in one state change (the caller made sure none is running).
function rerunStepsBehind(state, loop, record, { at, emit, rerun }) {
  const behind = stepsBehind(state, loop);
  const steps = behind.actions.filter((id) => ['succeeded', 'failed'].includes(state.actions.find((entry) => entry.id === id)?.status));
  const records = ensureRecords(state);
  const reset = [];
  const reopenGates = () => {
    if (reset.length) return;
    for (const id of behind.gates) {
      const gate = records.get(id);
      if (gate?.status !== 'passed') continue;
      settle(gate, 'pending', at);
      reset.push(id);
    }
  };
  const rerunDone = steps.length > 0 && rerun(loop, record.round, reopenGates, { steps, summary: `Loop ${loop.id} reopened in round ${record.round}: rerun ${steps.join(', ')} after it` });
  reopenGates();
  for (const gateId of reset) emit('gate.reopened', { gateId, loopId: loop.id, round: record.round });
  return rerunDone;
}

// The loop.passed event of a dry loop.
function emitDryPassed(state, loop, record, { emit }) {
  const group = groupOf(state, loop);
  const verdict = dryVerdict(loop, record, group);
  emit('loop.passed', {
    loopId: loop.id, round: record.round, of: record.maxRounds, reason: record.reason === 'yield' ? 'yield' : 'dry',
    ...(record.reason === 'yield' && verdict?.yieldRule ? { yieldRule: verdict.yieldRule, perRound: (record.findings?.rounds ?? []).map((item) => item.new + item.reopened) } : {}),
    known: (record.findings?.known ?? []).filter((item) => item.inScope).length,
    areas: group.areas.length > 0, condition: untilText(state, loop),
  });
}

// A round's fix as the watch says it: 'none' for a loop with no fixer (its
// other steps only check); 'next' when the round found something and every
// fixer comes before the review ([fix, review]), so the fix runs at the start
// of the next round, never in this one; else the record's own.
function fixWhen(fix, after, fixers) {
  if (!fixers.length) return 'none';
  return fix === 'runs' && !after.some((id) => fixers.includes(id)) ? 'next' : fix;
}

// What a dry loop out of rounds still lacks: {lastNew, known, unreviewed}.
function dryOutOfRounds(state, loop, record) {
  if (!isDryLoop(loop)) return null;
  const group = groupOf(state, loop);
  const summary = loopFindingsSummary(loop, record, group);
  if (!summary) return null;
  const lastNew = { ...summary.lastNew, fix: fixWhen(summary.lastNew.fix, fixStepsOf(state, loop, group).after, fixersOf(state, loop, group)) };
  const perRound = (record.findings?.rounds ?? []).map((item) => item.new + item.reopened);
  const tokens = loopTokens(state, loop);
  return { lastNew, known: summary.known.length, unreviewed: summary.unreviewed ?? [], perRound, ...(tokens > 0 ? { tokens } : {}) };
}

// Worker tokens (output plus reasoning, as reported) of every attempt of the
// loop's steps so far: what another round is weighed against (0.38.16; the
// benchmark's rounds 5 and 6 alone cost 0.49M).
function loopTokens(state, loop) {
  let total = 0;
  for (const attempt of state.attempts ?? []) {
    if (!loop.steps.includes(attempt?.actionId)) continue;
    const tokens = attempt.usage?.tokens;
    if (tokens && typeof tokens === 'object') total += (Number(tokens.output) || 0) + (Number(tokens.reasoning) || 0);
  }
  return total;
}

const tokenText = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));

// What a round that found something says about its fix, or null for a loop
// with no fix step: a fix that ran after the review was not reviewed; a fix
// before the review has not run on these findings yet.
function lastFixText(fix) {
  if (fix === 'next') return 'not fixed yet, the fix runs first in another round';
  return fix === 'none' ? null : 'its fix was not reviewed';
}

// The waiting note of a dry loop out of rounds: what the last round found and
// which areas were not reviewed since the last finding.
function dryWaitingNote(state, loop, record) {
  const facts = dryOutOfRounds(state, loop, record);
  if (!facts) return null;
  const { lastNew, unreviewed } = facts;
  const found = lastNew.new + lastNew.reopened;
  const parts = [`out of rounds (${record.round} of ${record.maxRounds}); the review did not run dry`];
  parts.push(found
    ? `round ${lastNew.round} found ${lastNew.new} new${lastNew.reopened ? `, ${lastNew.reopened} still open` : ''}${lastFixText(lastNew.fix) ? `${lastNew.fix === 'next' ? ',' : ' and'} ${lastFixText(lastNew.fix)}` : ''}`
    : `round ${lastNew.round} found nothing new`);
  if (unreviewed.length) parts.push(`not reviewed since the last finding: ${unreviewed.join(', ')}`);
  if (facts.perRound.length > 1) parts.push(`new per round: ${facts.perRound.join(', ')}`);
  if (facts.tokens) parts.push(`its workers used ${tokenText(facts.tokens)} tokens so far, so weigh another round against that`);
  return parts.join('; ');
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
  const rerun = (loop, round, apply, extra = {}) => rerunLoopBody(state, loop, round, { runDir, at, emit, features, apply, ...extra });
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
      note = dryWaitingNote(state, loop, record) ?? `out of rounds (${record.round} of ${record.maxRounds}); ${describeCondition(loop?.until)} did not hold`;
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
  const rerun = (loop, round, apply, extra = {}) => rerunLoopBody(state, loop, round, { runDir, at, emit, features, apply, ...extra });
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
    case 'gate.reopened':
      return { type: event.type, gateId: payload.gateId ?? null, loopId: payload.loopId ?? null, round: payload.round ?? null, token };
    case 'gate.waiting': case 'gate.passed': case 'gate.blocked':
      return { type: event.type, gateId: payload.gateId ?? null, note: payload.note ?? null, reason: payload.reason ?? null, why: payload.why ?? null, condition: payload.condition ?? null, token };
    case 'loop.round': case 'loop.passed': case 'loop.out-of-rounds': case 'loop.blocked': case 'loop.continued':
      return {
        type: event.type, loopId: payload.loopId ?? null, round: payload.round ?? null, of: payload.of ?? null,
        rounds: payload.rounds ?? null, reason: payload.reason ?? null, why: payload.why ?? null, condition: payload.condition ?? null, token,
        // A dry loop's facts (dry-loops.js); absent on every other loop.
        ...(payload.found ? { found: payload.found } : {}),
        ...(payload.findings ? { findings: payload.findings } : {}),
        ...(Number.isInteger(payload.known) ? { known: payload.known, areas: payload.areas === true } : {}),
        ...(Array.isArray(payload.perRound) ? { perRound: payload.perRound } : {}),
        ...(payload.yieldRule ? { yieldRule: payload.yieldRule } : {}),
      };
    case 'loop.findings':
      return {
        type: event.type, loopId: payload.loopId ?? null, round: payload.round ?? null, of: payload.of ?? null,
        new: payload.new ?? 0, reopened: payload.reopened ?? 0, repeated: payload.repeated ?? 0, outOfScope: payload.outOfScope ?? 0,
        known: payload.known ?? 0, areas: payload.areas ?? [], unreviewed: payload.unreviewed ?? [], fix: payload.fix ?? null, token,
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
    case 'gate.reopened':
      return `${g.waiting} gate ${event.gateId} waits again · loop ${event.loopId} was reopened in round ${event.round}, so the approval of its old result no longer holds`;
    case 'gate.blocked':
      return `${g.blocked} gate ${event.gateId} blocked · ${event.why ?? 'a dependency did not succeed'}`;
    case 'loop.round':
      if (event.found) {
        const found = event.found.new + event.found.reopened;
        return `${g.retry} loop ${event.loopId} round ${event.round} of ${event.of} · ${found
          ? `the review found ${event.found.new} new${event.found.reopened ? `, ${event.found.reopened} still open` : ''}`
          : 'the review found nothing new, not yet dry'}`;
      }
      return `${g.retry} loop ${event.loopId} round ${event.round} of ${event.of} · ${event.condition ?? 'its condition'} did not hold`;
    case 'loop.findings': {
      const counts = [`${event.new} new`, ...(event.reopened ? [`${event.reopened} still open`] : []), ...(event.repeated ? [`${event.repeated} repeated`] : []), ...(event.outOfScope ? [`${event.outOfScope} out of scope`] : [])];
      const fix = event.fix === 'runs' ? 'fix runs'
        : event.fix === 'next' ? (event.round < event.of ? 'fix runs next round' : 'fix needs another round')
          : event.fix === 'skipped' ? 'fix skipped' : null;
      return `· loop ${event.loopId} round ${event.round} of ${event.of} · review${event.areas.length ? ` (${event.areas.join(', ')})` : ''}: ${counts.join(', ')} · ${event.known} known${fix ? ` · ${fix}` : ''}`;
    }
    case 'loop.passed':
      if (event.reason === 'yield') {
        return `${g.ok} loop ${event.loopId} stopped on low yield in round ${event.round} of ${event.of} · new per round ${(event.perRound ?? []).join(', ')} · the last ${event.yieldRule?.rounds ?? 2} found at most ${event.yieldRule?.max ?? 2} each · ${event.known} found in all`;
      }
      if (event.reason === 'dry') {
        return `${g.ok} loop ${event.loopId} dry in round ${event.round} of ${event.of} · no new findings${event.areas ? ', every area reviewed' : ''} · ${event.known} found in all`;
      }
      return event.reason === 'continued'
        ? `${CONTINUED_MARK} ${continuedLoopText(event.loopId, event.round, event.of)}`
        : `${g.ok} loop ${event.loopId} passed in round ${event.round} of ${event.of} · ${event.condition ?? 'its condition'}`;
    case 'loop.out-of-rounds': {
      const continueTail = `continue: bullswarm workflow continue ${event.token} ${event.loopId} --rounds <n>`;
      if (event.findings) {
        const { lastNew, unreviewed = [] } = event.findings;
        const found = lastNew.new + lastNew.reopened;
        const said = found
          ? `round ${lastNew.round} found ${lastNew.new} new${lastNew.reopened ? `, ${lastNew.reopened} still open` : ''}${lastFixText(lastNew.fix) ? ` (${lastFixText(lastNew.fix)})` : ''}`
          : `round ${lastNew.round} found nothing new`;
        const { perRound = [], tokens } = event.findings;
        const cost = `${perRound.length > 1 ? ` · new per round ${perRound.join(', ')}` : ''}${tokens ? ` · ${tokenText(tokens)} worker tokens so far` : ''}`;
        return `${g.waiting} loop ${event.loopId} out of rounds (${event.round} of ${event.of}) · ${said}${unreviewed.length ? ` · not reviewed since: ${unreviewed.join(', ')}` : ''}${cost} · ${continueTail}`;
      }
      return `${g.waiting} loop ${event.loopId} out of rounds (${event.round} of ${event.of}) · ${event.condition ?? 'its condition'} did not hold · ${continueTail}`;
    }
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
  // A dry loop's reviewer gets its review block instead (dry-loops.js): it is
  // never handed a fix step's answer or output, blindTo or not.
  const dry = dryContext(state, action.id);
  if (dry?.role === 'review') return null;
  const record = controlRecords(state).find((entry) => entry.id === loop.id);
  if (!record || record.round < 2) return null;
  const lines = [
    `## Previous round (loop ${loop.id}, now round ${record.round} of ${record.maxRounds})`,
    `The loop runs its steps again because ${untilText(state, loop)} did not hold after round ${record.round - 1}. What its steps produced in round ${record.round - 1}:`,
  ];
  // A step blind to another (blindTo) sees that it ran, its status and its
  // evidence (Bullswarm's own facts), never its answer or output file. A dry
  // loop's fix step reads the review's findings in its own block instead.
  const blind = new Set(Array.isArray(action.blindTo) ? action.blindTo : []);
  const merged = new Set(dry ? dry.group.steps : []);
  for (const stepId of loop.steps) {
    // A fix step the dry loop skipped last round did not run then; its
    // latest attempt is from an earlier round.
    if (dry && skippedInRound(state, loop, record, stepId, record.round - 1)) {
      const why = state.actions.find((item) => item.id === stepId)?.skipped?.why ?? SKIP_WHY;
      lines.push(`- ${stepId}: skipped in round ${record.round - 1} (${why})`);
      continue;
    }
    // A reviewer's round-before attempt is the one that round merged; one
    // accepted without an answer gave none (an older round's is not shown).
    const mergedEntry = merged.has(stepId) ? record.findings?.rounds?.find((entry) => entry.round === record.round - 1) : null;
    if (mergedEntry?.answers && (mergedEntry.answers[stepId] ?? null) === null) {
      lines.push(`- ${stepId}: no answer in round ${record.round - 1} (accepted without one)`);
      continue;
    }
    const attempt = mergedEntry?.answers ? state.attempts.find((item) => item.id === mergedEntry.answers[stepId]) ?? null : previousAttempt(state, stepId);
    if (!attempt) { lines.push(`- ${stepId}: did not run`); continue; }
    lines.push(`- ${stepId} (attempt ${attempt.id}, ${attempt.status})`);
    if (!blind.has(stepId) && !merged.has(stepId) && attempt.answer && attempt.answer.value !== undefined && attempt.answer.value !== null) {
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

/**
 * The lines `plan validate` prints for a v3 program's gates and loops. With
 * the program's steps, a dry loop's area reviewers read as their review.
 */
export function controlSummaryLines(control, actions = []) {
  const lines = [];
  for (const gate of control?.gates ?? []) {
    lines.push(`  gate ${gate.id.padEnd(19)} after ${gate.dependsOn.join(', ') || '(nothing)'}${gate.when ? ` · waits when ${describeCondition(gate.when)}` : ' · waits for you'}${gate.note ? ` · ${gate.note}` : ''}`);
  }
  for (const loop of control?.loops ?? []) {
    const group = groupOf({ program: { actions } }, loop);
    const reviewers = new Set(group?.areas.length ? group.steps : []);
    const shown = loop.steps.filter((id) => !reviewers.has(id) || id === group.steps[0])
      .map((id) => (reviewers.has(id) ? `${group.id} (${group.steps.length} area reviewer${group.steps.length === 1 ? '' : 's'})` : id));
    lines.push(`  loop ${loop.id.padEnd(19)} steps ${shown.join(', ')} · until ${describeCondition(loop.until, { areas: reviewers.size > 0 })} · at most ${loop.maxRounds} round${loop.maxRounds === 1 ? '' : 's'}`);
    if (reviewers.size) {
      const rotating = group.perRound < group.areas.length ? ', rotating' : '';
      lines.push(`       areas ${group.areas.join(' · ')} (${group.perRound} per round${rotating})`);
    }
  }
  return lines;
}
