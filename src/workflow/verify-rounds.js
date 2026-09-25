// The kernel's bounded repair loop (docs/design/step-economy-0.35.2 §3).
//
// A failed verify no longer waits for the caller. At the boundary where every
// live step has succeeded, the kernel closes the open verify round; when a
// mandatory requirement failed and rounds remain, it adds one repair step
// (`repair-<r>`) and, once that repair succeeds, one verify step
// (`verify-round-<r+1>`) that re-checks what the repair could have changed.
// There are at most `verifyLoop.max` rounds, never one more; what is still
// failing after the last one is handed to the caller. A run started by
// stage-3 code (`failureRule` marker, `countsFixes`) reads `verifyRounds` as
// fix cycles (0-3, default 1) and stores `max = verifyRounds + 1` (1-4);
// saved runs keep it as total review rounds (1-3, default 3).
//
// Everything here is pure over the durable state, except that the caller may
// hand in a text reader (repair reports) and a handoff builder (attempt
// facts). The runtime applies the steps this module plans as kernel-source
// plan revisions, so kernel steps are ordinary program steps.
//
// The loop's own record never uses the keys `verify`, `repair`, `decision`,
// `result` or `completion`: the state validator rejects those legacy names.

import { formatMoney } from '../lib/usage-basis.js';
import { FIX_ROUNDS_DEFAULT, VERIFY_ROUNDS_DEFAULT } from './action-validator.js';
import { removedActionIds } from './execution-policy.js';
import { inheritedRepairRoute, inheritedVerifyRoute } from './step-route.js';
import { declaredDeliverable, declaredEvidence } from './step-vocabulary.js';

export const VERIFY_ROUNDS_MAX = 4;
// Saved runs read `verifyRounds` as total review rounds, at most three.
const LEGACY_ROUNDS_MAX = 3;
const FIX_ROUNDS_MAX = 3;
// D33: at most this many evidence items a kernel repair inherits.
const REPAIR_EVIDENCE_CAP = 5;
const EVIDENCE_OUTPUT_FILE = '$output';
const STEP_OUTPUT_ENV = /BULLSWARM_STEP_OUTPUT/;
export const VERIFY_LOOP_STOPS = Object.freeze(['passed', 'rounds', 'revision', 'step-failed', 'act-step']);
const DISCOVERY_CAP = 20;
const DISCOVERY_CHARS = 300;
const EVIDENCE_LINES = 6;
const EVIDENCE_CHARS = 400;
const CONCERN_LINES = 3;
const CHANGED_FILES_CAP = 200;
const EFFORT_RANK = Object.freeze({ low: 1, medium: 2, high: 3 });
const DISCOVERY_PREFIX = /^\s*discovery\s*:\s*/i;
/** The status of a declared requirement that no evidence step covers. */
export const NOT_JUDGED_STATUS = 'not judged · no evidence step covers it';

const clone = (value) => value === undefined ? undefined : JSON.parse(JSON.stringify(value));

/**
 * The loop record for a program's `verifyRounds`. With `countsFixes` (marked
 * runs, D13) the value is fix cycles: 0-3, default 1, and `max` is one more
 * review round than fixes. Otherwise it is total review rounds, 1-3, default
 * 3 (a 0 clamps to 1, which also means "no fix").
 */
export function createVerifyLoop(value = undefined, { countsFixes = false } = {}) {
  return { max: loopRounds(value, { countsFixes }), stoppedBy: null, rounds: [] };
}

function loopRounds(value, { countsFixes = false } = {}) {
  if (countsFixes) return (Number.isInteger(value) ? Math.min(FIX_ROUNDS_MAX, Math.max(0, value)) : FIX_ROUNDS_DEFAULT) + 1;
  return clampRounds(value);
}

function clampRounds(value) {
  const number = Number.isInteger(value) ? value : VERIFY_ROUNDS_DEFAULT;
  return Math.min(LEGACY_ROUNDS_MAX, Math.max(1, number));
}

function emptyRound(round, { verifyActionIds, toJudge, carried, at }) {
  return {
    round,
    verifyActionIds: [...verifyActionIds],
    startedAt: at,
    closedAt: null,
    toJudge: [...toJudge],
    carried: [...carried],
    passed: [],
    failed: [],
    discovery: [],
    repairActionId: null,
    repairRequirements: [],
    repairOwnedFiles: [],
    repairUnrestricted: false,
    repairStartedAt: null,
    repairFinishedAt: null,
    changedFiles: null,
  };
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

/** Every step the kernel added: repairs and the verify steps of rounds 2+. */
export function kernelLoopActionIds(state) {
  const rounds = loopOf(state)?.rounds ?? [];
  return [
    ...kernelRepairActionIds(state),
    ...rounds.filter((round) => round.round > 1).flatMap((round) => round.verifyActionIds),
  ];
}

/** The round an evidence step belongs to, latest first, or null. */
function roundOfVerifyStep(state, actionId) {
  return (loopOf(state)?.rounds ?? []).findLast((round) => round.verifyActionIds.includes(actionId)) ?? null;
}

function roundOfRepair(state, actionId) {
  return (loopOf(state)?.rounds ?? []).find((round) => round.repairActionId === actionId) ?? null;
}

/**
 * Round 1 opens when the first evidence step starts: it judges every
 * requirement some live evidence step names. Returns the new round, or null
 * when there is no loop or a round is already open or closed. It accounts for
 * every other declared requirement too, through `notJudgedRequirements`: one
 * no evidence step covers is not judged, never passed, and never a repair.
 */
export function openFirstRound(state, { at }) {
  const loop = loopOf(state);
  if (!loop || loop.rounds.length) return null;
  const evidence = liveActions(state).filter(isEvidence);
  if (!evidence.length) return null;
  const toJudge = intentOrder(state, evidence.flatMap((action) => action.evidenceFor));
  const round = emptyRound(1, { verifyActionIds: evidence.map((action) => action.id), toJudge, carried: [], at });
  loop.rounds.push(round);
  return round;
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
 * Mandatory requirements that fail at a boundary: `failed` or `blocked`
 * (D4), and a requirement the round was asked to judge that is still
 * `pending`. A requirement no evidence step judges is not the loop's: it goes
 * to the caller as it always has.
 */
export function failingRequirements(state, round = null) {
  const toJudge = new Set(round?.toJudge ?? []);
  const requirements = state?.ledger?.requirements ?? {};
  const accepted = requirementAcceptances(state);
  return intentOrder(state, Object.values(requirements)
    .filter((requirement) => requirement.mandatory && !accepted.has(requirement.id)
      && (requirement.status === 'failed' || requirement.status === 'blocked'
        || (requirement.status === 'pending' && toJudge.has(requirement.id))))
    .map((requirement) => requirement.id));
}

/**
 * F11: requirements a closed round listed as failing that are still
 * `pending` (a round closed at `partial` left its blocked check's
 * requirements unjudged). A later round never forgets them: they stay failing
 * until a check judges them or the caller accepts them.
 */
function rememberedPending(state) {
  const requirements = state?.ledger?.requirements ?? {};
  const accepted = requirementAcceptances(state);
  const ids = new Set((loopOf(state)?.rounds ?? []).filter((round) => round.closedAt != null).flatMap((round) => round.failed));
  return [...ids].filter((id) => requirements[id]?.mandatory && requirements[id].status === 'pending' && !accepted.has(id));
}

// What fails in the loop at `partial` (D12): the round's own failures plus
// what an earlier closed round left pending.
function loopFailingRequirements(state, round) {
  return intentOrder(state, [...failingRequirements(state, round), ...rememberedPending(state)]);
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

// The round's verify steps that succeeded and wrote a current evidence record
// for one of `ids` (D12): the only checks a narrowed repair may depend on.
function judgingVerifySteps(state, round, ids) {
  const live = new Set(liveActions(state).map((action) => action.id));
  const judged = new Set(ids.flatMap((id) => currentEvidenceRecords(state, id).map((record) => record.sourceAction)));
  return (round?.verifyActionIds ?? []).filter((actionId) => live.has(actionId)
    && runtimeOf(state, actionId)?.status === 'succeeded' && judged.has(actionId));
}

/**
 * D12 (marked runs, at the `partial` boundary): the failing requirements the
 * kernel may still repair, those whose affecting steps all succeeded and that
 * a succeeded check judged (a current evidence record). The rest go to the
 * caller.
 */
export function narrowedFailingRequirements(state, failing = failingRequirements(state)) {
  const succeeded = new Set(liveActions(state).map((action) => action.id).filter((id) => runtimeOf(state, id)?.status === 'succeeded'));
  return failing.filter((id) => affectingSteps(state, [id]).every((action) => succeeded.has(action.id))
    && currentEvidenceRecords(state, id).some((record) => succeeded.has(record.sourceAction)));
}

function repairableRequirements(state, { repairableOnly = false } = {}) {
  const all = failingRequirements(state);
  const failing = repairableOnly ? narrowedFailingRequirements(state, all) : all;
  const blocked = new Set(actAffectedRequirements(state, failing));
  return failing.filter((id) => !blocked.has(id));
}

/**
 * What the loop does at the boundary where every live step has succeeded.
 * One of: close-round, add-repair, finish-repair, finish (with stoppedBy).
 * With `repairableOnly` (marked runs at `partial`, D12) a repair is added only
 * for the narrowed set; with nothing left to repair the loop finishes
 * `step-failed` and the failures go to the caller.
 */
export function nextLoopStep(state, { repairableOnly = false } = {}) {
  const loop = loopOf(state);
  if (!loop) return { step: 'finish', stoppedBy: null };
  const current = loop.rounds.at(-1);
  if (!current) return { step: 'finish', stoppedBy: loop.stoppedBy };
  if (current.closedAt == null) return { step: 'close-round', round: current.round };
  if (current.repairActionId) {
    const runtime = runtimeOf(state, current.repairActionId);
    if (!runtime || runtime.status === 'removed') return { step: 'finish', stoppedBy: 'revision' };
    if (current.repairFinishedAt == null) {
      return runtime.status === 'succeeded'
        ? { step: 'finish-repair', round: current.round }
        : { step: 'finish', stoppedBy: 'step-failed' };
    }
    // The repair is recorded and no next round opened: its re-check set was
    // empty, or the budget was lowered below the next round.
    return { step: 'finish', stoppedBy: loop.stoppedBy ?? 'passed' };
  }
  if (loop.stoppedBy === 'rounds' || loop.stoppedBy === 'revision') return { step: 'finish', stoppedBy: loop.stoppedBy };
  // A round closed at `partial` leaves a blocked check's requirements pending
  // in `toJudge`; a later round remembers them (F11).
  const failing = repairableOnly ? loopFailingRequirements(state, current) : failingRequirements(state);
  if (!failing.length) return { step: 'finish', stoppedBy: 'passed' };
  if (current.round >= loop.max) return { step: 'finish', stoppedBy: 'rounds' };
  if (repairableOnly && !narrowedFailingRequirements(state, failing).length) return { step: 'finish', stoppedBy: 'step-failed' };
  if (!repairableRequirements(state, { repairableOnly }).length) return { step: 'finish', stoppedBy: 'act-step' };
  return { step: 'add-repair', round: current.round };
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

/** `Discovery:` concerns a middle round's verifiers reported. */
function discoveryItems(state, round) {
  const sources = new Set(round.verifyActionIds);
  const found = [];
  for (const requirementId of intentOrder(state, Object.keys(state?.ledger?.requirements ?? {}))) {
    for (const record of currentEvidenceRecords(state, requirementId)) {
      if (!sources.has(record.sourceAction)) continue;
      for (const concern of record.concerns ?? []) {
        if (!DISCOVERY_PREFIX.test(concern)) continue;
        const text = String(concern).replace(DISCOVERY_PREFIX, '').replace(/\s+/g, ' ').trim().slice(0, DISCOVERY_CHARS);
        if (text) found.push({ requirementId, text });
      }
    }
  }
  return found.slice(0, DISCOVERY_CAP);
}

function roundKind(loop, round) {
  if (round === 1) return 'first';
  return round >= loop.max ? 'final' : 'middle';
}

/**
 * Close the open round: what it passed, what fails now, and (middle rounds
 * only) the discovery items the next repair must also handle. Mutates the
 * round in place and returns the event payload. With `partial` (marked runs
 * at the `partial` boundary, D12) the caller closes it even when some of its
 * verify steps did not succeed: their requirements are still `pending` and in
 * `toJudge`, so they are failing and go to the caller; `next` is `repair`
 * only when the narrowed set is non-empty.
 */
export function closeRound(state, { at, partial = false }) {
  const loop = loopOf(state);
  const round = loop?.rounds.at(-1);
  if (!round || round.closedAt != null) return null;
  const live = new Set(liveActions(state).map((action) => action.id));
  const removed = round.verifyActionIds.length > 0 && round.verifyActionIds.every((id) => !live.has(id));
  round.closedAt = at;
  round.passed = round.toJudge.filter((id) => state.ledger.requirements[id]?.status === 'passed');
  round.failed = partial ? loopFailingRequirements(state, round) : failingRequirements(state, round);
  round.discovery = roundKind(loop, round.round) === 'middle' && !removed ? discoveryItems(state, round) : [];
  if (removed) loop.stoppedBy = 'revision';
  const notJudged = notJudgedRequirements(state);
  const candidates = partial ? narrowedFailingRequirements(state, round.failed) : round.failed;
  const repairable = candidates.filter((id) => !new Set(actAffectedRequirements(state, candidates)).has(id));
  const next = !round.failed.length ? 'finish'
    : round.round < loop.max && !['rounds', 'revision'].includes(loop.stoppedBy) && repairable.length ? 'repair' : 'caller';
  return {
    round: round.round, of: loop.max, stage: 'finished',
    passed: [...round.passed], failed: [...round.failed], discovery: round.discovery.length, next,
    ...(round.round === 1 && notJudged.length ? { notJudged } : {}),
    wallMinutes: phaseFacts(state, verifyPhaseAttempts(state, round)).wallMinutes,
  };
}

function freeActionId(state, base) {
  const taken = new Set((state?.program?.actions ?? []).map((action) => action.id));
  if (!taken.has(base)) return base;
  for (let k = 2; ; k += 1) if (!taken.has(`${base}-${k}`)) return `${base}-${k}`;
}

function highestEffort(actions, fallback) {
  let best = null;
  for (const action of actions) {
    const rank = EFFORT_RANK[action?.effort] ?? 0;
    if (rank && (!best || rank > EFFORT_RANK[best])) best = action.effort;
  }
  return best ?? fallback;
}

/** Live work steps (earlier repairs included) whose `affects` meets `ids`. */
function affectingSteps(state, ids) {
  const wanted = new Set(ids);
  return liveActions(state).filter((action) => !isEvidence(action) && action.kind !== 'digest'
    && (action.affects ?? []).some((id) => wanted.has(id)));
}

const canonical = (value) => JSON.stringify(value, (key, item) => (item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map((name) => [name, item[name]]))
  : item));

/**
 * D33: the evidence a files repair inherits from the steps it repairs, in
 * affecting-step order then item order, de-duplicated, the first five. Every
 * command is kept except one that reads BULLSWARM_STEP_OUTPUT; a schema item
 * only when its file is within the repair's reach (unrestricted, its owned
 * files, or the affecting steps' declared deliverable paths) and is not
 * "$output". Those two judge the original step's own report, which a repair
 * does not rewrite.
 */
export function inheritedRepairEvidence(affecting, { unrestricted = false, ownedFiles = [] } = {}) {
  const reach = new Set([...ownedFiles, ...affecting.flatMap((action) => declaredDeliverable(action)?.paths ?? [])]);
  const kept = [];
  const seen = new Set();
  let dropped = 0;
  for (const action of affecting) {
    for (const item of declaredEvidence(action)) {
      const eligible = item?.type === 'command' ? typeof item.cmd === 'string' && !STEP_OUTPUT_ENV.test(item.cmd)
        : item?.type === 'schema' ? item.file !== EVIDENCE_OUTPUT_FILE && (unrestricted || reach.has(item.file))
          : false;
      if (!eligible) { dropped += 1; continue; }
      const key = canonical(item);
      if (seen.has(key)) continue;
      seen.add(key);
      if (kept.length >= REPAIR_EVIDENCE_CAP) { dropped += 1; continue; }
      kept.push(clone(item));
    }
  }
  return { evidence: kept, inherited: kept.length, dropped };
}

/**
 * The repair step for the latest closed round: the failing requirements, the
 * union of the affecting steps' owned files, and the highest effort among
 * them. An unrestricted integrator among them (or no owner at all) makes the
 * repair unrestricted too. Returns { action, record, evidenceCounts } where
 * `record` is what the round records about it.
 *
 * Marked runs pass the stage-3 options: `repairableOnly` narrows `affects` to
 * the D12 set and makes `dependsOn` only the succeeded verify steps that
 * judged it (never born blocked); `inheritRoute` sets the D19 route;
 * `inheritEvidence` sets a files repair's D33 evidence (a report repair gets
 * none). `evidenceCounts` is `{ inherited, dropped }` for the started event.
 */
export function planRepairStep(state, { repairableOnly = false, inheritRoute = false, inheritEvidence = false } = {}) {
  const loop = loopOf(state);
  const round = loop?.rounds.at(-1);
  if (!round) return null;
  const failing = repairableRequirements(state, { repairableOnly });
  const affecting = affectingSteps(state, failing);
  const integrator = affecting.some((action) => ['build', 'chore'].includes(action.lane) && !(action.ownedFiles ?? []).length);
  const files = [...new Set(affecting.flatMap((action) => action.ownedFiles ?? []))].sort();
  const unrestricted = integrator || !files.length;
  const id = freeActionId(state, `repair-${round.round}`);
  const live = new Set(liveActions(state).map((action) => action.id));
  const ids = failing.join(', ');
  const prompt = `Kernel repair: make ${ids} pass. The kernel adds the failing evidence, discovery items, not-done items and handoffs below.`;
  const dependsOn = repairableOnly ? judgingVerifySteps(state, round, failing) : round.verifyActionIds.filter((actionId) => live.has(actionId));
  const route = inheritRoute ? inheritedRepairRoute(affecting) : undefined;
  const allReport = affecting.length > 0 && affecting.every((action) => declaredDeliverable(action)?.type === 'report');
  if (allReport) {
    return {
      evidenceCounts: { inherited: 0, dropped: inheritEvidence ? affecting.reduce((sum, action) => sum + declaredEvidence(action).length, 0) : 0 },
      action: {
        id,
        purpose: `Repair after verify round ${round.round}: ${ids}`,
        dependsOn,
        affects: [...failing],
        ownedFiles: [],
        lane: 'analyze',
        deliverable: 'report',
        prompt,
        kind: 'implement',
        effort: highestEffort(affecting, 'medium'),
        evidenceFor: [],
        inputs: [],
        produces: [],
        ...(route ? { route } : {}),
      },
      record: {
        repairActionId: id,
        repairRequirements: [...failing],
        repairOwnedFiles: [],
        repairUnrestricted: false,
      },
    };
  }
  const inherited = inheritEvidence
    ? inheritedRepairEvidence(affecting, { unrestricted, ownedFiles: unrestricted ? [] : files })
    : { evidence: [], inherited: 0, dropped: 0 };
  return {
    evidenceCounts: { inherited: inherited.inherited, dropped: inherited.dropped },
    action: {
      id,
      purpose: `Repair after verify round ${round.round}: ${ids}`,
      dependsOn,
      affects: [...failing],
      ownedFiles: unrestricted ? [] : files,
      prompt,
      kind: 'implement',
      effort: highestEffort(affecting, 'medium'),
      evidenceFor: [],
      inputs: [],
      produces: [],
      ...(route ? { route } : {}),
      ...(inherited.evidence.length ? { evidence: inherited.evidence } : {}),
    },
    record: {
      repairActionId: id,
      repairRequirements: [...failing],
      repairOwnedFiles: unrestricted ? [] : files,
      repairUnrestricted: unrestricted,
    },
  };
}

/**
 * Declared deliverable paths of the steps affecting this repair's requirements
 * (D20c). Derived from state, so the repair stores no extra field.
 */
export function repairInheritedPaths(state, repairActionId) {
  const round = roundOfRepair(state, repairActionId);
  if (!round) return [];
  const paths = new Set();
  for (const action of affectingSteps(state, round.repairRequirements ?? [])) {
    for (const path of declaredDeliverable(action)?.paths ?? []) paths.add(path);
  }
  return [...paths].sort();
}

/**
 * The files repair r changed: the union of `changedFiles` over its attempts,
 * or null when any attempt did not record the list (or recorded a truncated
 * one) — unknown, never guessed.
 */
export function repairChangedFiles(state, actionId) {
  const attempts = (state?.attempts ?? []).filter((attempt) => attempt.actionId === actionId && attempt.status !== 'running');
  if (!attempts.length) return null;
  const files = new Set();
  for (const attempt of attempts) {
    if (!Array.isArray(attempt.changedFiles)) return null;
    if (Number.isInteger(attempt.changedFileCount) && attempt.changedFileCount > attempt.changedFiles.length) return null;
    for (const file of attempt.changedFiles) files.add(file);
  }
  return [...files].sort().slice(0, CHANGED_FILES_CAP);
}

const FILE_EXTENSIONS = 'c|cc|cjs|conf|cpp|cs|css|csv|env|go|h|hpp|htm|html|ini|java|js|json|jsonl|jsx|kt|lock|md|mdx|mjs|php|pl|png|py|rb|rs|scss|sh|sql|svg|swift|toml|ts|tsx|txt|vue|xml|yaml|yml|zsh';
const PATH_TOKEN = new RegExp(`(?:[\\w.-]+/)+[\\w.-]+|\\b[\\w-]+(?:\\.[\\w-]+)*\\.(?:${FILE_EXTENSIONS})\\b`, 'i');
const escapeRegExp = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Evidence names `file` when its repository path appears, or its basename as
// a whole word (a path or word boundary on both sides).
function namesFile(text, file) {
  if (text.includes(file)) return true;
  const base = file.split('/').at(-1);
  if (!base) return false;
  return new RegExp(`(?:^|[^\\w./-])${escapeRegExp(base)}(?![\\w-]|\\.[\\w])`).test(text);
}

/**
 * A repair narrowed at `partial` (D12): it depends on only some of its
 * round's live verify steps, so the writers of the other requirements are not
 * upstream of it. Derived from the repair's definition, so no field records it.
 */
export function repairNarrowed(state, round) {
  const repair = definitionOf(state, round?.repairActionId);
  if (!repair) return false;
  const live = new Set(liveActions(state).map((action) => action.id));
  const dependsOn = new Set(repair.dependsOn ?? []);
  return round.verifyActionIds.some((id) => live.has(id) && !dependsOn.has(id));
}

/**
 * The re-check set after repair r: (1) the failing requirements the repair
 * worked on, plus (2) every passed requirement whose current passing evidence
 * (evidence and concern lines) names a file the repair changed. Evidence that
 * names no file at all is workspace-wide, so any change re-opens it (D3);
 * unknown changed files re-open every passed requirement. Every other passed
 * requirement carries forward.
 *
 * After a narrowed repair (D12, F5/F10) the next round re-checks exactly the
 * repaired requirements: `verify-round-(r+1)` depends only on the repair,
 * which does not reach the other writers, so every passed requirement carries
 * forward (the round brief still asks a middle round for regressions). Once a
 * loop narrowed, a later repair re-opens only a passed requirement whose
 * writers are all upstream of it, the validator's evidence rule.
 */
export function recheckSet(state, round, changedFiles) {
  const failing = intentOrder(state, round.repairRequirements ?? []);
  const failingSet = new Set(failing);
  const touched = [];
  const carried = [];
  const narrowed = repairNarrowed(state, round);
  const upstream = narrowed || !(loopOf(state)?.rounds ?? []).some((entry) => entry.round < round.round && repairNarrowed(state, entry))
    ? null : new Set([round.repairActionId, ...ancestorsOf(state, round.repairActionId)]);
  const kernelRepairs = new Set(kernelRepairActionIds(state));
  const reachable = (requirementId) => !upstream || affectingSteps(state, [requirementId])
    .every((action) => kernelRepairs.has(action.id) || upstream.has(action.id));
  for (const requirementId of intentOrder(state, Object.keys(state?.ledger?.requirements ?? {}))) {
    if (failingSet.has(requirementId)) continue;
    const requirement = state.ledger.requirements[requirementId];
    if (requirement.status !== 'passed') continue;
    if (narrowed || !reachable(requirementId)) { carried.push(requirementId); continue; }
    const lines = currentEvidenceRecords(state, requirementId)
      .filter((record) => record.status === 'passed')
      .flatMap((record) => [...(record.evidence ?? []), ...(record.concerns ?? [])])
      .map(String);
    const text = lines.join('\n');
    let reopen;
    if (changedFiles == null) reopen = true;
    else if (!changedFiles.length) reopen = false;
    else if (!PATH_TOKEN.test(text)) reopen = true;
    else reopen = changedFiles.some((file) => namesFile(text, file));
    (reopen ? touched : carried).push(requirementId);
  }
  return { failing, touched, carried, toJudge: intentOrder(state, [...failing, ...touched]) };
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
 * The verify step of round r+1: re-checks `toJudge` after the repair. With
 * `inheritRoute` it carries the D19 route of round 1's authored checks, whose
 * `independentOf` also names every repair so far. A named step must run
 * before this one (the validator's rule), and `dependsOn` stays the repair
 * alone, so names that are not upstream of the repair are left out (in a
 * marked run the repair depends only on the checks that judged it, D12).
 */
export function planVerifyStep(state, { round, repairActionId, toJudge, inheritRoute = false }) {
  const loop = loopOf(state);
  const firstRound = loop?.rounds?.[0];
  const authored = (firstRound?.verifyActionIds ?? []).map((id) => definitionOf(state, id)).filter(Boolean);
  const id = freeActionId(state, `verify-round-${round}`);
  const ids = toJudge.join(', ');
  let route;
  if (inheritRoute) {
    const repairs = [...new Set([...kernelRepairActionIds(state), repairActionId])];
    route = inheritedVerifyRoute(authored, repairs);
    if (Array.isArray(route?.independentOf)) {
      const upstream = new Set([repairActionId, ...ancestorsOf(state, repairActionId)]);
      const kept = route.independentOf.filter((stepId) => upstream.has(stepId));
      if (kept.length) route.independentOf = kept;
      else delete route.independentOf;
      if (!Object.keys(route).length) route = undefined;
    }
  }
  return {
    id,
    purpose: `Verify round ${round} of ${loop.max}: re-check ${toJudge.length} requirement${toJudge.length === 1 ? '' : 's'}`,
    dependsOn: [repairActionId],
    affects: [],
    ownedFiles: [],
    prompt: `Re-check ${ids} after ${repairActionId}.`,
    kind: 'adversarial-acceptance',
    effort: highestEffort(authored, 'high'),
    evidenceFor: [...toJudge],
    inputs: [],
    produces: [],
    ...(route ? { route } : {}),
  };
}

/** Open round r+1 for the kernel's verify step. */
export function openNextRound(state, { verifyActionId, toJudge, carried, at }) {
  const loop = loopOf(state);
  const round = emptyRound(loop.rounds.length + 1, { verifyActionIds: [verifyActionId], toJudge, carried, at });
  loop.rounds.push(round);
  return round;
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

export function applyRevisionVerifyRounds(state, program, { countsFixes = false } = {}) {
  const next = revisedVerifyRounds(state, program, { countsFixes });
  if (next === null) return false;
  loopOf(state).max = next;
  return true;
}

// --- Task text --------------------------------------------------------------

function clip(text, limit) {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (value.length <= limit) return value;
  const head = value.slice(0, limit - 1);
  const space = head.lastIndexOf(' ');
  return `${(space > limit / 2 ? head.slice(0, space) : head).replace(/[\s,;:—-]+$/, '')}…`;
}

function listText(items, limit = 20) {
  const shown = items.slice(0, limit);
  return `${shown.join(', ')}${items.length > limit ? `, and ${items.length - limit} more` : ''}`;
}

/**
 * The `### <step> · attempt <id>` block for one affecting step's durable
 * handoff: the facts `handoffBlock` prints, without the failure line and the
 * "unverified edits" line, because these attempts succeeded.
 */
export function repairHandoffBlock(facts = {}, { heading } = {}) {
  const durationMs = Date.parse(facts.finishedAt) - Date.parse(facts.startedAt);
  const duration = Number.isFinite(durationMs) ? `${Math.max(0, Math.round(durationMs / 1000))}s` : 'unknown';
  const outputPath = facts.outputFile ?? facts.partialOutput ?? null;
  const output = outputPath ? (facts.outputBytes != null ? `${outputPath} (${facts.outputBytes} bytes)` : outputPath) : 'none';
  const changed = Array.isArray(facts.changedFiles) ? facts.changedFiles : [];
  const lines = [
    heading ?? '### step',
    `- Pool: ${facts.pool ?? 'unknown'}`,
    `- Model: ${facts.model ?? (facts.pool != null ? `${facts.pool} connector default` : 'unknown')}`,
    `- Started: ${facts.startedAt ?? 'unknown'}`,
    `- Finished: ${facts.finishedAt ?? 'unknown'}`,
    `- Duration: ${duration}`,
    `- Files changed inside this step's territory: ${changed.join(', ') || 'none'}`,
    '- Diff stat at the moment it ended:',
    '```',
    facts.diffStatText || '(no diff)',
    '```',
    `- Diff snapshot: ${facts.diffFile ?? 'none taken'}`,
    `- Final answer: ${output}`,
    `- Stream file: ${facts.streamFile || 'no stream recorded'}`,
  ];
  const events = Array.isArray(facts.lastEvents) ? facts.lastEvents.slice(-3) : [];
  if (events.length) {
    lines.push('- Last response events:');
    for (const event of events) {
      const said = typeof event.summary === 'string' ? event.summary.replace(/\s+/g, ' ').trim() : '';
      lines.push(`  - ${event.at ?? 'time unknown'}: ${said || '(no summary)'}`);
    }
  }
  return lines.join('\n');
}

function lastSucceededAttempt(state, actionId) {
  const runtime = runtimeOf(state, actionId);
  return (state?.attempts ?? []).findLast((attempt) => attempt.actionId === actionId && attempt.status === 'succeeded'
    && attempt.ordinal > (runtime?.supersededAttempts ?? 0))
    ?? (state?.attempts ?? []).findLast((attempt) => attempt.actionId === actionId && attempt.status === 'succeeded')
    ?? null;
}

/**
 * The repair brief appended after a kernel repair's prompt: each failing
 * requirement with the verifier's evidence, the discovery items of a middle
 * round, the not-done items and the durable handoff of every step that
 * affects them. `handoff(attempt, formatter)` builds a handoff from the
 * attempt's durable files (the runtime passes durableAttemptHandoff).
 */
export function repairBrief(state, actionId, { handoff = null } = {}) {
  const loop = loopOf(state);
  const round = roundOfRepair(state, actionId);
  if (!loop || !round) return null;
  const sources = round.verifyActionIds;
  const requirements = new Map((state.intent?.requirements ?? []).map((item) => [item.id, item]));
  const lines = [
    `## Kernel repair after verify round ${round.round} of ${loop.max}`,
    'Make every requirement below pass. An independent verifier failed it; its evidence is quoted.',
  ];
  for (const id of round.repairRequirements) {
    const judged = latestJudgment(state, id, sources) ?? latestJudgment(state, id);
    const status = judged?.status && judged.status !== 'passed' ? judged.status : 'failed';
    lines.push('', `### ${id} · ${status} in round ${round.round} (${judged?.sourceAction ?? sources.join(', ')})`);
    lines.push(String(requirements.get(id)?.text ?? id));
    const evidence = (judged?.evidence ?? []).slice(0, EVIDENCE_LINES).map((line) => clip(line, EVIDENCE_CHARS));
    const concerns = (judged?.concerns ?? []).slice(0, CONCERN_LINES).map((line) => clip(line, EVIDENCE_CHARS));
    if (evidence.length) lines.push('Evidence:', ...evidence.map((line) => `- ${line}`));
    else lines.push(`Evidence: ${judged?.mechanicalFailure?.message ?? 'none recorded'}`);
    if (concerns.length) lines.push('Concerns:', ...concerns.map((line) => `- ${line}`));
  }
  if (round.round >= 2 && round.discovery.length) {
    lines.push('', `### Also fix: discovery items from verify round ${round.round}`);
    for (const item of round.discovery) lines.push(`- ${item.requirementId}: ${item.text}`);
  }
  const affecting = affectingSteps(state, round.repairRequirements).filter((action) => action.id !== actionId);
  const notDone = [];
  for (const step of affecting) {
    const early = lastSucceededAttempt(state, step.id)?.returnedEarly;
    for (const item of early?.items ?? []) notDone.push(`- ${step.id}: ${item}`);
  }
  if (notDone.length) lines.push('', '### Not done in the steps that affect these requirements', ...notDone);
  const blocks = [];
  if (typeof handoff === 'function') {
    for (const step of affecting) {
      const attempt = lastSucceededAttempt(state, step.id);
      if (!attempt) continue;
      const built = handoff(attempt, (facts) => repairHandoffBlock(facts, { heading: `#### ${step.id} · attempt ${attempt.id}` }));
      if (built?.block) blocks.push(built.block);
    }
  }
  if (blocks.length) lines.push('', '### What those steps did', ...blocks.flatMap((block, index) => (index ? ['', block] : [block])));
  lines.push(
    '',
    'Keep passing requirements passing. Do not weaken, skip or delete a test to make it pass. Run the focused tests and the goal\'s acceptance command. Under `## Done`, name each requirement id you fixed and the command that proves it.',
  );
  return lines.join('\n');
}

/**
 * The per-round paragraph appended to an evidence task: round 1 asks for
 * actionable failures, a middle round re-checks and looks for regressions and
 * the same defect elsewhere, the final round only re-checks. Null for a run
 * with one round, and for evidence steps outside the loop.
 */
export function roundBrief(state, actionId) {
  const loop = loopOf(state);
  const round = roundOfVerifyStep(state, actionId);
  if (!loop || !round || loop.max < 2) return null;
  if (round.round === 1) {
    return `Verify round 1 of ${loop.max}. A requirement you fail starts a kernel repair built from your evidence, so make each failing line actionable: the file, the command you ran and what it printed.`;
  }
  const previous = loop.rounds[round.round - 2];
  const repair = previous?.repairActionId ?? 'the repair';
  const changed = previous?.changedFiles == null ? 'files it did not record' : previous.changedFiles.length ? listText(previous.changedFiles) : 'no files';
  const quoted = [];
  for (const id of round.toJudge) {
    const judged = latestJudgment(state, id, previous?.verifyActionIds) ?? latestJudgment(state, id);
    const was = previous?.failed?.includes(id) ? `failed in round ${previous.round}` : `passed in round ${previous?.round ?? round.round - 1}; ${repair} changed a file its evidence names`;
    quoted.push(`- ${id} (${was}${judged?.sourceAction ? `, ${judged.sourceAction}` : ''}):`);
    for (const line of (judged?.evidence ?? []).slice(0, 3)) quoted.push(`  > ${clip(line, EVIDENCE_CHARS)}`);
  }
  const carried = round.carried.length ? round.carried.join(', ') : 'none';
  const reports = repairedReports(state, previous);
  if (roundKind(loop, round.round) === 'middle') {
    return [
      `Verify round ${round.round} of ${loop.max}: re-check and discovery. ${repair} changed: ${changed}. Re-check each requirement below as the workspace is now; the previous round's failing evidence is quoted under each. Then look for (a) regressions the repair caused in the files it changed and (b) the same defect as each re-checked failure elsewhere. Report each finding as a concern starting \`Discovery:\` that names the file, on the requirement it threatens; a finding that breaks a requirement you judge makes it failed. Carried forward, not yours to judge: ${carried}.`,
      ...reports,
      ...quoted,
    ].join('\n');
  }
  return [
    `Verify round ${round.round} of ${loop.max}: final closure. Re-check only whether each requirement below now passes (previous evidence quoted). Do not look for new problems or add \`Discovery:\` concerns: nothing runs after this.`,
    ...reports,
    ...quoted,
  ].join('\n');
}

// L6: a report repair (stage-1 D20b) changes no workspace file; it writes the
// corrected report as its own output. The next round judges that file, which
// its dependency artifacts already carry, not the repaired step's first report.
function repairedReports(state, previous) {
  const repair = definitionOf(state, previous?.repairActionId);
  if (!repair || declaredDeliverable(repair)?.type !== 'report') return [];
  const output = runtimeOf(state, repair.id)?.outputFile ?? lastSucceededAttempt(state, repair.id)?.outputFile;
  if (!output) return [];
  const kernel = new Set(kernelRepairActionIds(state));
  return affectingSteps(state, previous.repairRequirements ?? [])
    .filter((action) => !kernel.has(action.id) && declaredDeliverable(action)?.type === 'report')
    .map((action) => `The current version of ${action.id}'s report is ${output}; judge that, not the earlier output.`);
}

// --- Display ----------------------------------------------------------------

const TERMINAL_LIFECYCLE = new Set(['completed', 'partial', 'cancelled', 'failed']);

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
  if (!loop || TERMINAL_LIFECYCLE.has(state?.lifecycle?.status)) return null;
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
  if (!loop || !TERMINAL_LIFECYCLE.has(state?.lifecycle?.status)) return null;
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
 * the Run spend block's vocabulary: `$X`, `at least $X · N unmeasured`, and a
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
  const counts = [running ? `${running} running` : null, unmeasured ? `${unmeasured} unmeasured` : null].filter(Boolean).join(' · ');
  const cost = apiUsd == null ? '—'
    : (running || unmeasured) ? `at least ${formatMoney(apiUsd)}${counts ? ` · ${counts}` : ''}`
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

export const __test = Object.freeze({ namesFile, PATH_TOKEN, phaseFacts, clone });
