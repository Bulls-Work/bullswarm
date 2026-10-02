// The read side of the kernel's former repair loop (docs/design/step-economy-0.35.2 §3).
//
// Runs saved before 0.38.0 may carry a `verifyLoop` record: verify rounds,
// kernel repair steps (`repair-<r>`) and re-reviews (`verify-round-<r+1>`).
// 0.38.0 no longer runs that loop (a program v3 declares its own loops,
// gates-loops.js); this module keeps only what the result, the Run page, Home
// and a plan revision read from a saved record. A run started by stage-3 code
// (`failureRule` marker, `countsFixes`) reads `verifyRounds` as fix cycles
// (0-3, default 1) and stores `max = verifyRounds + 1` (1-4); earlier saved
// runs keep it as total review rounds (1-3, default 3).
//
// Everything here is pure over the durable state.
//
// The loop's own record never uses the keys `verify`, `repair`, `decision`,
// `result` or `completion`: the state validator rejects those legacy names.

import { V2_TERMINAL_STATUSES } from './status.js';
import { formatMoney } from '../lib/usage-basis.js';
import { FIX_ROUNDS_DEFAULT, VERIFY_ROUNDS_DEFAULT } from './action-validator.js';
import { removedActionIds } from './execution-policy.js';

// Saved runs read `verifyRounds` as total review rounds, at most three.
const LEGACY_ROUNDS_MAX = 3;
const FIX_ROUNDS_MAX = 3;
export const VERIFY_LOOP_STOPS = Object.freeze(['passed', 'rounds', 'revision', 'step-failed', 'act-step']);
/** The status of a declared requirement that no evidence step covers. */
export const NOT_JUDGED_STATUS = 'not judged · no evidence step covers it';

function loopRounds(value, { countsFixes = false } = {}) {
  if (countsFixes) return (Number.isInteger(value) ? Math.min(FIX_ROUNDS_MAX, Math.max(0, value)) : FIX_ROUNDS_DEFAULT) + 1;
  return clampRounds(value);
}

function clampRounds(value) {
  const number = Number.isInteger(value) ? value : VERIFY_ROUNDS_DEFAULT;
  return Math.min(LEGACY_ROUNDS_MAX, Math.max(1, number));
}

const loopOf = (state) => (state?.verifyLoop && typeof state.verifyLoop === 'object' ? state.verifyLoop : null);
const definitionOf = (state, id) => (state?.program?.actions ?? []).find((action) => action.id === id) ?? null;
const runtimeOf = (state, id) => (state?.actions ?? []).find((action) => action.id === id) ?? null;
const isEvidence = (action) => (action?.evidenceFor ?? []).length > 0;

function intentOrder(state, ids) {
  const wanted = new Set(ids);
  const ordered = (state?.intent?.requirements ?? []).map((requirement) => requirement.id).filter((id) => wanted.has(id));
  for (const id of wanted) if (!ordered.includes(id)) ordered.push(id);
  return ordered;
}

function liveActions(state) {
  const removed = removedActionIds(state);
  return (state?.program?.actions ?? []).filter((action) => !removed.has(action.id));
}

/** The repair steps the kernel added, by id (never recognised by name). */
export function kernelRepairActionIds(state) {
  return (loopOf(state)?.rounds ?? []).map((round) => round.repairActionId).filter(Boolean);
}

/**
 * The declared requirements round 1 did not judge because no live evidence
 * step names them, in intent order. Derived from round 1's `toJudge` and the
 * ledger, so it needs no field of its own: a requirement counts only while it
 * is still `pending` and no live evidence step covers it (one a revision
 * later covers is judged like any other).
 */
export function notJudgedRequirements(state) {
  const first = loopOf(state)?.rounds?.[0];
  if (!first) return [];
  const judged = new Set(first.toJudge);
  const covered = new Set(liveActions(state).filter(isEvidence).flatMap((action) => action.evidenceFor));
  const requirements = state?.ledger?.requirements ?? {};
  return intentOrder(state, (state?.intent?.requirements ?? []).map((requirement) => requirement.id)
    .filter((id) => !judged.has(id) && !covered.has(id) && requirements[id]?.status === 'pending'));
}

/**
 * The requirements a caller accepted by choice on a check step (D22) whose
 * acceptance is still current: its `workRevision` equals the requirement's
 * (a later fix or rerun moves it, and the acceptance lapses, D23). Map of id
 * to `{ step, reason, at }`. A choice is not
 * proof: the ledger status never changes. The last step naming a requirement
 * wins.
 */
export function requirementAcceptances(state) {
  const requirements = state?.ledger?.requirements ?? {};
  const removed = removedActionIds(state);
  const found = new Map();
  for (const runtime of state?.actions ?? []) {
    const acceptance = runtime?.acceptance;
    if (!acceptance || runtime.status === 'removed' || removed.has(runtime.id) || !Array.isArray(acceptance.requirements)) continue;
    for (const entry of acceptance.requirements) {
      const requirement = requirements[entry?.id];
      if (!requirement || String(requirement.workRevision) !== String(entry.workRevision)) continue;
      // An entry an earlier accept made keeps that accept's reason and time (F21).
      found.set(entry.id, { step: runtime.id, reason: entry.reason ?? acceptance.reason, at: entry.at ?? acceptance.at });
    }
  }
  return found;
}

/**
 * The ids in `ids` that any live step with `role === 'act'` affects (D20a).
 * An act step's outward action is never repeated by a kernel repair.
 */
export function actAffectedRequirements(state, ids) {
  const wanted = new Set(ids ?? []);
  const hit = [];
  for (const action of liveActions(state)) {
    if (action.role !== 'act') continue;
    for (const id of action.affects ?? []) {
      if (wanted.has(id) && !hit.includes(id)) hit.push(id);
    }
  }
  return intentOrder(state, hit);
}

function currentEvidenceRecords(state, requirementId) {
  const requirement = state?.ledger?.requirements?.[requirementId];
  if (!requirement) return [];
  return (state.ledger.evidence ?? []).filter((record) => record.requirementId === requirementId
    && record.stale === false && record.inspectedRevision === requirement.workRevision);
}

// The latest semantic judgment a set of evidence steps recorded for one
// requirement, stale or not: what a later round quotes after a repair made
// the record stale.
function latestJudgment(state, requirementId, sourceIds = null) {
  const sources = sourceIds ? new Set(sourceIds) : null;
  return (state?.ledger?.evidence ?? [])
    .filter((record) => record.requirementId === requirementId
      && (!sources || sources.has(record.sourceAction)))
    .sort((a, b) => a.eventSequence - b.eventSequence)
    .at(-1) ?? null;
}

// Every step `id` depends on, directly or through other steps.
function ancestorsOf(state, id) {
  const found = new Set();
  const stack = [...(definitionOf(state, id)?.dependsOn ?? [])];
  while (stack.length) {
    const next = stack.pop();
    if (found.has(next)) continue;
    found.add(next);
    stack.push(...(definitionOf(state, next)?.dependsOn ?? []));
  }
  return found;
}

/**
 * `defaults.verifyRounds` in a revision sets the budget for the rest of the
 * run, never below the rounds already closed. Absent leaves it alone. It is
 * read through the run's marker: with `countsFixes` it is fix cycles (0-3,
 * `max` = value + 1), otherwise total rounds (1-3). Pure: the budget the
 * revision would set, or null when it changes nothing.
 */
export function revisedVerifyRounds(state, program, { countsFixes = false } = {}) {
  const loop = loopOf(state);
  if (!loop || !program || typeof program !== 'object') return null;
  const requested = program.defaults?.verifyRounds ?? program.verifyRounds;
  if (!Number.isInteger(requested)) return null;
  const closed = loop.rounds.filter((round) => round.closedAt != null).length;
  const next = Math.max(closed, loopRounds(requested, { countsFixes }));
  return next === loop.max ? null : next;
}

function clip(text, limit) {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (value.length <= limit) return value;
  const head = value.slice(0, limit - 1);
  const space = head.lastIndexOf(' ');
  return `${(space > limit / 2 ? head.slice(0, space) : head).replace(/[\s,;:—-]+$/, '')}…`;
}

function lastSucceededAttempt(state, actionId) {
  const runtime = runtimeOf(state, actionId);
  return (state?.attempts ?? []).findLast((attempt) => attempt.actionId === actionId && attempt.status === 'succeeded'
    && attempt.ordinal > (runtime?.supersededAttempts ?? 0))
    ?? (state?.attempts ?? []).findLast((attempt) => attempt.actionId === actionId && attempt.status === 'succeeded')
    ?? null;
}

/**
 * The Run page phase name for a stage that is exactly one round's verify
 * steps (`verify · round 2 of 3 · 2 to re-check`) or one repair
 * (`repair · round 1 · 2 requirements`). Null otherwise, and for one-round
 * runs, whose pages read as they always have.
 */
export function loopStageLabel(state, stage) {
  const loop = loopOf(state);
  const ids = stage?.actionIds ?? (stage?.actions ?? []).map((action) => action?.id).filter(Boolean);
  if (!loop || loop.max < 2 || !ids.length) return null;
  for (const round of loop.rounds) {
    const verify = new Set(round.verifyActionIds);
    if (ids.every((id) => verify.has(id))) {
      const count = round.toJudge.length;
      return round.round === 1
        ? `verify · round 1 of ${loop.max} · ${count} to judge`
        : `verify · round ${round.round} of ${loop.max} · ${count} to re-check`;
    }
    if (round.repairActionId && ids.length === 1 && ids[0] === round.repairActionId) {
      const count = round.repairRequirements.length;
      return `repair · round ${round.round} · ${count} requirement${count === 1 ? '' : 's'}`;
    }
  }
  return null;
}

/**
 * `verify round 2/3` from the first repair until the run is terminal,
 * numbering the round being worked toward (round 2 during `repair-1` and
 * `verify-round-2`). Null before any repair and once the run is finished.
 */
export function verifyRoundLabel(state) {
  const loop = loopOf(state);
  if (!loop || V2_TERMINAL_STATUSES.has(state?.lifecycle?.status)) return null;
  if (!loop.rounds.some((round) => round.repairActionId)) return null;
  const last = loop.rounds.at(-1);
  const toward = last.repairActionId ? last.round + 1 : last.round;
  return `verify round ${Math.min(toward, loop.max)}/${loop.max}`;
}

/**
 * The finished Run header's verdict for a run with a loop: `verified`,
 * `not verified · verify rounds 3/3` when the loop handed failures back, or
 * `not verified`. Null for runs without a loop and runs still going.
 */
export function loopVerdictText(state) {
  const loop = loopOf(state);
  if (!loop || !V2_TERMINAL_STATUSES.has(state?.lifecycle?.status)) return null;
  const requirements = Object.values(state?.ledger?.requirements ?? {}).filter((requirement) => requirement.mandatory);
  const verified = state.lifecycle.status === 'completed' && requirements.length > 0
    && requirements.every((requirement) => requirement.status === 'passed');
  if (verified) return 'verified';
  const decision = callerDecisionRequirements(state);
  return decision.length && loop.max > 1 ? `not verified · verify rounds ${loop.rounds.length}/${loop.max}` : 'not verified';
}

// --- Measurement and the caller's block --------------------------------------

function attemptWindow(attempt) {
  const start = Date.parse(attempt?.startedAt ?? '');
  const end = Date.parse(attempt?.finishedAt ?? '');
  if (!Number.isFinite(start)) return null;
  return [start, Number.isFinite(end) && end >= start ? end : start];
}

function verifyPhaseAttempts(state, round) {
  const ids = new Set(round.verifyActionIds);
  const from = Date.parse(round.startedAt ?? '') || -Infinity;
  const to = Date.parse(round.closedAt ?? '') || Infinity;
  return (state?.attempts ?? []).filter((attempt) => {
    if (!ids.has(attempt.actionId)) return false;
    const started = Date.parse(attempt.startedAt ?? '');
    return !Number.isFinite(started) || (started >= from && started <= to);
  });
}

function repairPhaseAttempts(state, round) {
  return (state?.attempts ?? []).filter((attempt) => attempt.actionId === round.repairActionId);
}

function attemptApiUsd(attempt) {
  const value = attempt?.usage?.api?.usd ?? attempt?.usage?.cost?.estimatedUsd;
  if (value == null || value === '' || typeof value === 'boolean') return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

/**
 * Wall minutes (the union of the attempts' intervals, so parallel steps count
 * once), pools in start order, the priced API subtotal and the cost text in
 * the Run spend block's vocabulary: `$X`, `≥$X`, and a
 * dash when nothing was priced.
 */
function phaseFacts(state, attempts) {
  const windows = attempts.map(attemptWindow).filter(Boolean).sort((a, b) => a[0] - b[0]);
  let total = 0;
  let open = null;
  for (const [start, end] of windows) {
    if (!open || start > open[1]) { if (open) total += open[1] - open[0]; open = [start, end]; }
    else open[1] = Math.max(open[1], end);
  }
  if (open) total += open[1] - open[0];
  const pools = [];
  for (const attempt of [...attempts].sort((a, b) => (Date.parse(a.startedAt ?? '') || 0) - (Date.parse(b.startedAt ?? '') || 0))) {
    if (attempt.pool && !pools.includes(attempt.pool)) pools.push(attempt.pool);
  }
  let apiUsd = null;
  let unmeasured = 0;
  let running = 0;
  for (const attempt of attempts) {
    const usd = attemptApiUsd(attempt);
    if (attempt.status === 'running') running += 1;
    else if (usd == null) unmeasured += 1;
    if (usd != null) apiUsd = (apiUsd ?? 0) + usd;
  }
  const cost = apiUsd == null ? '—'
    : (running || unmeasured) ? `≥${formatMoney(apiUsd)}`
      : formatMoney(apiUsd);
  return {
    wallMinutes: windows.length ? Math.round(total / 6_000) / 10 : null,
    pools,
    apiUsd: apiUsd == null ? null : Math.round(apiUsd * 1e6) / 1e6,
    unmeasured,
    cost,
  };
}

/** One entry per verify round and per repair, in the order they ran. */
export function roundPhases(state) {
  const phases = [];
  for (const round of loopOf(state)?.rounds ?? []) {
    const notJudged = round.round === 1 ? notJudgedRequirements(state) : [];
    phases.push({
      kind: 'verify', round: round.round, steps: [...round.verifyActionIds], judged: round.toJudge.length,
      failed: [...round.failed], ...(notJudged.length ? { notJudged } : {}),
      ...phaseFacts(state, verifyPhaseAttempts(state, round)),
    });
    if (round.repairActionId) {
      phases.push({
        kind: 'repair', round: round.round, steps: [round.repairActionId], requirements: [...round.repairRequirements],
        ...phaseFacts(state, repairPhaseAttempts(state, round)),
      });
    }
  }
  return phases;
}

// Mandatory requirements still open once a closed round left failures: the
// last closed round's, or an earlier one's that is still not passed (F11: a
// round closed at `partial` is never forgotten by a later round).
function callerDecisionRequirements(state) {
  const loop = loopOf(state);
  const closed = (loop?.rounds ?? []).filter((round) => round.closedAt != null);
  if (!closed.length) return [];
  const requirements = state?.ledger?.requirements ?? {};
  const accepted = requirementAcceptances(state);
  const open = (id) => requirements[id]?.mandatory && requirements[id].status !== 'passed' && !accepted.has(id);
  if (!closed.at(-1).failed.length && !closed.some((round) => round.failed.some(open))) return [];
  return intentOrder(state, Object.values(requirements)
    .filter((requirement) => open(requirement.id))
    .map((requirement) => requirement.id));
}

const UNFINISHED = new Set(['failed', 'cancelled', 'interrupted']);

// The live check that judged `id` last, else the latest live check naming it.
function reviewerOf(state, id) {
  const checks = liveActions(state).filter((action) => (action.evidenceFor ?? []).includes(id)).map((action) => action.id);
  const covering = new Set(checks);
  const judged = (state?.ledger?.evidence ?? [])
    .filter((record) => record.requirementId === id && covering.has(record.sourceAction))
    .sort((a, b) => a.eventSequence - b.eventSequence).at(-1);
  if (judged) return judged.sourceAction;
  for (const round of [...(loopOf(state)?.rounds ?? [])].reverse()) {
    const found = round.verifyActionIds.findLast((actionId) => covering.has(actionId));
    if (found) return found;
  }
  return checks.at(-1) ?? null;
}

// The unfinished step that kept `id` from being judged again: the last repair
// of it that did not succeed, the check itself, or a failed step upstream of a
// blocked check. Null when nothing is in the way.
function stopperOf(state, id, reviewer) {
  const repair = (loopOf(state)?.rounds ?? []).findLast((round) => round.repairActionId && round.repairRequirements.includes(id));
  if (repair && UNFINISHED.has(runtimeOf(state, repair.repairActionId)?.status)) return { step: repair.repairActionId, via: null };
  const status = runtimeOf(state, reviewer)?.status;
  if (!reviewer || !status || status === 'succeeded') return null;
  if (UNFINISHED.has(status)) return { step: reviewer, via: null };
  const ancestors = ancestorsOf(state, reviewer);
  const failed = liveActions(state).find((action) => ancestors.has(action.id) && UNFINISHED.has(runtimeOf(state, action.id)?.status));
  return failed ? { step: failed.id, via: reviewer, status } : null;
}

// Whether `step accept` would take this failed step (v2-revision's
// planAcceptances): a writer of an isolated run was never merged back.
function acceptableStep(state, stepId) {
  const definition = definitionOf(state, stepId);
  if (runtimeOf(state, stepId)?.status !== 'failed' || !definition) return false;
  const isolated = state?.config?.settings?.workspaceMode === 'isolated';
  return !(isolated && !(definition.evidenceFor ?? []).length && (definition.ownedFiles ?? []).length);
}

// Marked runs (F12, L4): the spec's three options for a failing requirement,
// naming the check that judged it, and `accept` only when `step accept` would
// take it. A requirement left pending names the step that kept it from being
// judged instead (the D12 blocked check, a repair that failed).
function markedNext(state, id, { runToken, status }) {
  const fix = `fix it with a step (bullswarm workflow plan export ${runToken} --out plan.json, edit it, then bullswarm workflow plan revise ${runToken} --program plan.json)`;
  const reviewer = reviewerOf(state, id);
  if (status === 'failed' || status === 'blocked') {
    if (!reviewer) return { next: fix };
    const pool = lastSucceededAttempt(state, reviewer)?.pool ?? '<pool>';
    const rerun = `rerun the review elsewhere (bullswarm workflow step rerun ${runToken} ${reviewer} --avoid ${pool})`;
    const acceptable = ['succeeded', 'failed'].includes(runtimeOf(state, reviewer)?.status);
    return {
      next: acceptable
        ? `${fix}, ${rerun}, or accept it (bullswarm workflow step accept ${runToken} ${reviewer} --requirement ${id} --reason "…")`
        : `${fix} or ${rerun}`,
    };
  }
  const stopper = stopperOf(state, id, reviewer);
  if (!stopper) {
    return { next: reviewer ? `${fix} or rerun the review (bullswarm workflow step rerun ${runToken} ${reviewer})` : fix };
  }
  const why = stopper.via
    ? `${stopper.via} is ${stopper.status} by ${stopper.step} (${runtimeOf(state, stopper.step)?.status}), so ${id} was never judged`
    : `${stopper.step} ${runtimeOf(state, stopper.step)?.status === 'failed' ? 'failed' : 'did not finish'}, so no review judged ${id} after it`;
  const accept = acceptableStep(state, stopper.step) && stopper.step !== reviewer
    ? `, accept it (bullswarm workflow step accept ${runToken} ${stopper.step} --reason "…")` : '';
  return {
    notJudged: stopper.via ? `not judged: ${stopper.via} is ${stopper.status} by ${stopper.step} (${runtimeOf(state, stopper.step)?.status})` : null,
    next: `${why}: rerun ${stopper.step} (bullswarm workflow step rerun ${runToken} ${stopper.step})${accept}, or ${fix}`,
  };
}

const HEADING = /^ {0,3}#{1,6}\s+(.*?)\s*#*\s*$/;
const LIST_ITEM = /^ ?(?:[-*+]|\d{1,9}[.)])\s+(.*)$/;

/** The first item (or first line) under the last `Suggested next step` heading. */
export function firstSuggestedStep(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  let start = -1;
  lines.forEach((line, index) => {
    const heading = line.match(HEADING);
    if (heading && /^suggested next steps?:?$/i.test(heading[1].trim())) start = index;
  });
  if (start < 0) return null;
  for (const line of lines.slice(start + 1)) {
    if (HEADING.test(line)) break;
    const said = (line.match(LIST_ITEM)?.[1] ?? line).trim();
    if (said && !/^(?:none|nothing|n\/a|-|—)\.?$/i.test(said)) return clip(said, 300);
  }
  return null;
}

/**
 * The block a caller decides from: each still-failing mandatory requirement,
 * its latest evidence line, and one suggested next step — the repair report's
 * own `## Suggested next step` when the last repair covering it wrote one,
 * else a concrete step — and every declared requirement no evidence step
 * covers (`not judged`, mandatory or not; it never counts as passed). Null
 * when nothing is left for the caller. With `failureRule` (marked runs) the
 * step is always the spec's fix / rerun elsewhere / accept text, and the
 * repair report's suggestion follows as `suggested: …`.
 */
export function callerDecision(state, { readText = null, token = null, failureRule = false } = {}) {
  const loop = loopOf(state);
  const notJudged = new Set(notJudgedRequirements(state));
  const ids = intentOrder(state, [...callerDecisionRequirements(state), ...notJudged]);
  if (!loop || !ids.length) return null;
  const runToken = token ?? state?.shortId ?? state?.runId ?? '<run>';
  const lastVerify = loop.rounds.at(-1)?.verifyActionIds.at(-1) ?? 'the last verify step';
  const requirements = ids.map((id) => {
    if (notJudged.has(id)) {
      const text = (state.intent?.requirements ?? []).find((requirement) => requirement.id === id)?.text ?? id;
      return {
        id, status: NOT_JUDGED_STATUS, round: 1, evidence: clip(text, 200),
        next: `add an evidence step whose evidenceFor names ${id}, then judge it: bullswarm workflow plan export ${runToken} --out plan.json, edit it, then plan revise`,
      };
    }
    const status = state.ledger.requirements[id].status;
    const round = loop.rounds.findLast((entry) => entry.toJudge.includes(id) || entry.failed.includes(id))?.round ?? loop.rounds.length;
    const judged = currentEvidenceRecords(state, id).at(-1) ?? latestJudgment(state, id);
    let evidence = clip(String(judged?.evidence?.[0] ?? judged?.mechanicalFailure?.message ?? 'no evidence recorded').split(/\r?\n/, 1)[0], 200);
    const repair = loop.rounds.findLast((entry) => entry.repairActionId && entry.repairRequirements.includes(id));
    let next = null;
    if (actAffectedRequirements(state, [id]).includes(id)) {
      next = `an act step affects ${id}; Bullswarm never repeats an outward action on its own. Check what was done, then add an act step if it must be redone: bullswarm workflow plan export ${runToken} --out plan.json, edit it, then plan revise`;
    } else if (failureRule) {
      const marked = markedNext(state, id, { runToken, status });
      if (!judged && marked.notJudged) evidence = marked.notJudged;
      const report = repair && typeof readText === 'function' ? lastSucceededAttempt(state, repair.repairActionId)?.outputFile : null;
      const suggested = report ? firstSuggestedStep(readText(report)) : null;
      next = suggested ? `${marked.next}; suggested: ${suggested}` : marked.next;
    } else {
      if (repair && typeof readText === 'function') {
        const report = lastSucceededAttempt(state, repair.repairActionId)?.outputFile;
        if (report) next = firstSuggestedStep(readText(report));
      }
      if (!next) {
        const reviewer = judged?.sourceAction ?? lastVerify;
        const pool = lastSucceededAttempt(state, reviewer)?.pool ?? '<pool>';
        next = `fix it with a step (bullswarm workflow plan export ${runToken} --out plan.json → plan revise), rerun the review elsewhere (bullswarm workflow step rerun ${runToken} ${reviewer} --avoid ${pool}), or accept it (bullswarm workflow step accept ${runToken} ${reviewer} --reason "…")`;
      }
    }
    return { id, status, round, evidence, next };
  });
  return { verifyRounds: `${loop.rounds.length}/${loop.max}`, requirements };
}

/**
 * The two result keys: `verifyRounds` always, `callerDecision` when something
 * is left for the caller. `failureRule` (the run's stage-3 marker) selects the
 * marked runs' `next` text.
 */
export function verifyLoopResult(state, { readText = null, token = null, failureRule = false } = {}) {
  const loop = loopOf(state);
  if (!loop) return null;
  return {
    verifyRounds: {
      max: loop.max,
      used: loop.rounds.length,
      stoppedBy: loop.stoppedBy ?? null,
      phases: roundPhases(state),
    },
    // A verified run has only the requirements no evidence step covers left.
    callerDecision: callerDecision(state, { readText, token, failureRule }),
  };
}
