// Loops that stop when a review is dry, and area reviewers (0.38.12, design
// docs/design/0.38.12-dry-loops.md).
//
// A loop whose `until` is the dry form {step, dry: n} ends after n review
// rounds in a row that found nothing worth fixing. Words used here:
//
//   finding     one problem a review reports: {title, inScope, stillOpen?, …}
//   fix-worthy  a finding that is in scope and either new or reported again
//               as still open; only fix-worthy findings make a fixer run
//   group       the review step the until names, or, with `areas`, its area
//               reviewers <id>-area-1 … <id>-area-P (program-v3.js expands them)
//   fix step    every other step of the loop: "after" the review when it
//               depends on the group, "before" it otherwise; it runs or is
//               skipped with the round
//   fixer       a fix step that can change files (lane build or chore); a
//               read-only step beside the review (a lint, a test run) is a
//               fix step but no fixer: it fixes nothing between rounds
//
// The loop record (state.controlNodes) keeps the merged rounds and the known
// findings (`findings`); everything here is a plain function of the state and
// that record. gates-loops.js calls these from the kernel's control pass, and
// step-prompts.js builds the review and fixer blocks from them.

import { createHash } from 'node:crypto';
import { deliverableTypeOf } from './step-vocabulary.js';

// The known list keeps at most this many titles; past it new titles are still
// counted (knownDropped) and kept only as a short hash of their key
// (`dropped`, at most DROPPED_MAX), so a later round knows them as repeated.
export const KNOWN_MAX = 500;
// A loop's rounds (maxRounds 1 to this), and a review's reviewers per round
// (areasPerRound 1 to this), re-exported by program-v3.js.
export const LOOP_MAX_ROUNDS = 5;
export const AREAS_PER_ROUND_MAX = 5;
const DROPPED_MAX = 5000;
const TITLE_MAX = 160;
const FINDING_SHOWN_CHARS = 1500;
const FIX_BLOCK_CHARS = 24_000;
const KNOWN_BLOCK_CHARS = 32_000;

// How much a finding matters (0.38.15), most first: `everyday` is hit in
// ordinary use of the work, `edge` by a real but less common input or
// situation, `obscure` only by a contrived combination. A loop's until
// `floor` (default edge) is the least severity that keeps it going: a round
// whose only new findings are below it is dry (benchmark 2026-10-14: five
// rounds found 38, 23, 15, 16 and 15 and never ran dry, the tail mostly
// obscure). A finding with no severity counts as at the floor.
export const SEVERITIES = Object.freeze(['everyday', 'edge', 'obscure']);
export const DEFAULT_FLOOR = 'edge';

/** True when a finding is at or above the floor (no or an unknown severity: true). */
export function atOrAboveFloor(finding, floor = DEFAULT_FLOOR) {
  const rank = SEVERITIES.indexOf(finding?.severity);
  return rank === -1 || rank <= Math.max(0, SEVERITIES.indexOf(floor));
}

// The yield stop (0.38.16): a dry loop also ends after `rounds` reviewed
// rounds in a row that each found at most `max` new or still-open findings at
// or above the floor, with every area reviewed in them. The benchmark's loop
// found 9, 4, 2, 4, 3 and 5 and never ran dry (benchmark-0.38.15-report.md).
// `until.yield: false` turns it off; it never applies when a fixer runs
// before the review.
export const YIELD_DEFAULT = Object.freeze({ max: 2, rounds: 2 });
export const YIELD_MAX_FINDINGS = 10;
export const yieldOf = (loop) => (loop?.until?.yield === false ? null : { ...YIELD_DEFAULT, ...(loop?.until?.yield ?? {}) });

/** The floor a dry loop counts from. */
export const floorOf = (loop) => (SEVERITIES.includes(loop?.until?.floor) ? loop.until.floor : DEFAULT_FLOOR);

// A review area that looks past correctness (0.38.15): the benchmark's
// reviewers all read query results, and the engine lost its points on speed,
// structure and tests. A review with areas gets this one when it names none.
export const NON_FUNCTIONAL_AREA = 'non-functional: performance, code structure and test quality';
// 0.38.16: whole words only. The 0.38.15 check was unanchored, so `scal` took
// "scalar functions", `test` took "test of NULL handling", and one word in a
// mixed area ("errors, constraints, transactions, performance") counted the
// whole area as non-functional; the benchmark's review then had no reviewer
// on structure or tests (benchmark-0.38.15-report.md).
const NON_FUNCTIONAL_TERM = new RegExp(`\\b(${[
  'non-?functional', 'performance', 'perf', 'speed', 'fast(er)?', 'slow(ness)?', 'latency', 'throughput',
  'memory (use|usage|footprint)', 'scalab(le|ility)', 'scaling', 'efficien(t|cy)',
  // Plain "structure" counts (Second Mate, 0.38.16 check); "data structure"
  // is about correctness and does not.
  '(?<!data )structure', 'structural', 'architecture', 'design', 'maintainab(le|ility)',
  'readab(le|ility)', 'refactor(ing)?', 'complexity', 'code quality', 'duplication',
  'tests', 'testing', 'test (quality|coverage|suite|suites)', 'testab(le|ility)', 'regression tests?',
].join('|')})\\b`, 'i');
// An area's parts: split on commas, semicolons, slashes and the word "and".
const areaParts = (area) => String(area ?? '').split(/[,;/]|\band\b/i).map((part) => part.trim()).filter(Boolean);
/**
 * True when the area is mainly past correctness: every part of it (split on
 * commas, semicolons, slashes and "and") names performance, structure or
 * tests. "query speed on 100k rows" and NON_FUNCTIONAL_AREA are; "errors,
 * transactions, performance" and "scalar functions" are not.
 */
export const isNonFunctionalArea = (area) => {
  const parts = areaParts(area);
  return parts.length > 0 && parts.every((part) => NON_FUNCTIONAL_TERM.test(part));
};

// The smallest answer schema a dry loop's review may declare; printed by the
// validate issue and the plan contract so a caller can paste it.
export const FINDINGS_ANSWER = Object.freeze({
  type: 'object', required: ['findings'], properties: { findings: { type: 'array', items: {
    type: 'object', required: ['title', 'inScope'],
    properties: {
      title: { type: 'string' }, inScope: { type: 'boolean' }, severity: { enum: [...SEVERITIES] },
      stillOpen: { type: 'boolean' }, where: { type: 'string' }, detail: { type: 'string' },
    },
  } } },
});

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const clone = (value) => JSON.parse(JSON.stringify(value));

function cut(text, max) {
  const chars = [...String(text)];
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : String(text);
}

// "a", "a and b", "a, b and c".
function joinAnd(items) {
  return items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
}

/** True for a loop whose until is the dry form. */
export function isDryLoop(loop) {
  return Number.isInteger(loop?.until?.dry);
}

// An object schema that refuses fields it does not list (additionalProperties
// false, or a schema a boolean would not match).
const closedObject = (schema) => schema.additionalProperties !== undefined && schema.additionalProperties !== true
  && !(isObject(schema.additionalProperties) && !Object.keys(schema.additionalProperties).length);

/**
 * Why this answer schema cannot be a dry loop's review answer, as one line,
 * or null when it can: an object whose required `findings` is an array of
 * objects whose required fields include title (string) and inScope (boolean).
 * With `stillOpen` (a loop with a fix step, whose reviews are told to mark a
 * known finding still present), items that refuse unlisted fields must list
 * stillOpen, or every answer that follows that rule would fail the schema.
 */
export function findingsSchemaIssue(answer, { stillOpen = false } = {}) {
  const findings = isObject(answer?.properties) ? answer.properties.findings : undefined;
  const items = isObject(findings) ? findings.items : undefined;
  const props = isObject(items?.properties) ? items.properties : {};
  const ok = isObject(answer) && answer.type === 'object' && Array.isArray(answer.required) && answer.required.includes('findings')
    && isObject(findings) && findings.type === 'array' && isObject(items) && items.type === 'object'
    && Array.isArray(items.required) && items.required.includes('title') && items.required.includes('inScope')
    && props.title?.type === 'string' && props.inScope?.type === 'boolean'
    && (props.stillOpen === undefined || props.stillOpen?.type === 'boolean');
  if (!ok) return `must list findings, an array of objects whose required fields include title (string) and inScope (boolean); for example ${JSON.stringify(FINDINGS_ANSWER)}`;
  if (stillOpen && props.stillOpen === undefined && closedObject(items)) {
    return 'must list stillOpen (boolean) among the properties of its findings, since they allow no other field: each review is told to mark a known finding that is still present with stillOpen: true';
  }
  return null;
}

/** A title as the loop compares it: NFKC, trimmed, lower-case, inner spaces collapsed, one trailing dot dropped. */
export function titleKey(title) {
  return String(title ?? '').normalize('NFKC').trim().toLowerCase().replace(/\s+/g, ' ').replace(/\.$/, '').trim();
}

// A title key as the known list keeps it once the list is full.
const droppedKey = (key) => createHash('sha256').update(key).digest('hex').slice(0, 16);

/** The area index reviewer `slot` (1-based) looks from in `round`, of N areas and P reviewers. */
export function areaFor(slot, round, perRound, areaCount) {
  return ((round - 1) * perRound + (slot - 1)) % areaCount;
}

/**
 * The review group of a dry loop: {id, steps (reviewer ids by slot), areas
 * ([] for a review without areas), perRound}. Null for any other loop.
 */
export function groupOf(state, loop) {
  if (!isDryLoop(loop)) return null;
  const reviewers = (state.program?.actions ?? [])
    .filter((action) => action.areaOf?.step === loop.until.step && loop.steps.includes(action.id))
    .sort((a, b) => a.areaOf.slot - b.areaOf.slot);
  const group = reviewers.length
    ? { id: loop.until.step, steps: reviewers.map((action) => action.id), areas: [...reviewers[0].areaOf.areas], perRound: reviewers.length }
    : { id: loop.until.step, steps: [loop.until.step], areas: [], perRound: 1 };
  // A fixer that runs before the review ([fix, review]) would leave the last
  // round's findings unfixed if a yield stop ended the loop there.
  const fixers = fixersOf(state, loop, group);
  const { after } = fixStepsOf(state, loop, group);
  if (fixers.some((id) => !after.includes(id))) group.fixFirst = true;
  return group;
}

// How many areas a group covers: a review without areas has one implicit area.
const areaCount = (group) => group.areas.length || 1;

/**
 * The area each reviewer slot takes in `round` (indexes, by slot). With every
 * area in one round, or one reviewer a round, it is the plain rotation
 * (areaFor). Otherwise, when the review has a non-functional area (0.38.15:
 * a round is never all semantic), the last slot takes the non-functional
 * areas in turn and the other slots rotate over the rest.
 */
export function roundAreas(areas, perRound, round) {
  const plain = () => Array.from({ length: perRound }, (_, k) => areaFor(k + 1, round, perRound, areas.length));
  const nonFunctional = areas.map((area, index) => (isNonFunctionalArea(area) ? index : -1)).filter((index) => index >= 0);
  const rest = areas.map((_, index) => index).filter((index) => !nonFunctional.includes(index));
  if (perRound >= areas.length || perRound < 2 || !nonFunctional.length || !rest.length) return plain();
  const slots = perRound - 1;
  const picked = Array.from({ length: slots }, (_, k) => rest[areaFor(k + 1, round, slots, rest.length)]);
  picked.push(nonFunctional[(round - 1) % nonFunctional.length]);
  return picked;
}

/** How many rounds it takes for every area to be reviewed once (roundAreas). */
export function coverRounds(areas, perRound) {
  const n = Array.isArray(areas) ? areas.length : Number(areas);
  if (!Array.isArray(areas) || perRound >= n || perRound < 2) return Math.ceil(n / Math.max(1, perRound));
  const nonFunctional = areas.filter(isNonFunctionalArea).length;
  const rest = n - nonFunctional;
  if (!nonFunctional || !rest) return Math.ceil(n / perRound);
  return Math.max(Math.ceil(rest / (perRound - 1)), nonFunctional);
}

function areaOfSlot(group, index, round) {
  return group.areas.length ? roundAreas(group.areas, group.perRound, round)[index] : 0;
}

const areaName = (group, area) => (group.areas.length && Number.isInteger(area) ? group.areas[area] : null);

/** The loop's other steps, split by whether they depend on the review group: {before, after}. */
export function fixStepsOf(state, loop, group) {
  const inGroup = new Set(group.steps);
  const deps = new Map((state.program?.actions ?? []).map((action) => [action.id, action.dependsOn ?? []]));
  const reaches = (id, seen = new Set()) => (deps.get(id) ?? []).some((dep) => {
    if (inGroup.has(dep)) return true;
    if (seen.has(dep) || !loop.steps.includes(dep)) return false;
    seen.add(dep);
    return reaches(dep, seen);
  });
  const others = loop.steps.filter((id) => !inGroup.has(id));
  return { before: others.filter((id) => !reaches(id)), after: others.filter((id) => reaches(id)) };
}

/** The dry loop a step belongs to and its role there (review, before, after), or null. */
export function dryContext(state, stepId) {
  // Read straight from the program (not control-nodes.js, which would import
  // program-v3.js back): a v2 run has no control and no dry loop.
  const loop = (state?.program?.control?.loops ?? []).find((entry) => isDryLoop(entry) && entry.steps.includes(stepId));
  if (!loop) return null;
  const group = groupOf(state, loop);
  const record = (state.controlNodes ?? []).find((entry) => entry.id === loop.id)
    ?? { id: loop.id, type: 'loop', status: 'pending', at: null, round: 1, maxRounds: loop.maxRounds };
  if (group.steps.includes(stepId)) return { loop, group, record, role: 'review' };
  const { before } = fixStepsOf(state, loop, group);
  return { loop, group, record, role: before.includes(stepId) ? 'before' : 'after' };
}

/**
 * Each reviewer's current answer for `round`: [{step, area, attemptId, value,
 * file}], value undefined and attemptId null when it gave none (a reviewer the
 * caller accepted). What the kernel merges; the merged round records each
 * attemptId (`answers`), so it can tell a reviewer rerun since.
 */
export function groupAnswers(state, group, round) {
  return group.steps.map((step, index) => {
    const area = areaOfSlot(group, index, round);
    const current = state.actions.find((action) => action.id === step)?.answer;
    const file = current ? state.attempts.find((attempt) => attempt.id === current.attemptId)?.answer?.file ?? null : null;
    return { step, area, attemptId: current?.attemptId ?? null, value: current?.value, file };
  });
}

/**
 * The answers a merged round was built from (its `answers`: the attempt each
 * reviewer answered in, null for none), in the shape of groupAnswers. A
 * reviewer with no answer that round gives none here, whatever it answered
 * in an earlier round.
 */
export function mergedAnswers(state, group, entry) {
  return group.steps.map((step, index) => {
    const area = areaOfSlot(group, index, entry.round);
    const attemptId = entry.answers?.[step] ?? null;
    const attempt = attemptId ? state.attempts.find((item) => item.id === attemptId) : null;
    const ok = attempt?.answer?.ok === true;
    return { step, area, attemptId, value: ok ? attempt.answer.value : undefined, file: ok ? attempt.answer.file ?? null : null };
  });
}

/**
 * True when a reviewer has answered again since `entry` (the round it last
 * merged) was merged: every reviewer has succeeded, and one's current answer
 * is not the one merged (a `step rerun` or `step accept` of it).
 */
export function roundAnswersChanged(state, group, entry) {
  if (!entry?.answers) return false;
  const now = groupAnswers(state, group, entry.round);
  if (!group.steps.every((id) => state.actions.find((action) => action.id === id)?.status === 'succeeded')) return false;
  return now.some((answer) => (entry.answers[answer.step] ?? null) !== answer.attemptId);
}

/**
 * The known list as it stood before `round` was merged: {known, dropped,
 * knownDropped}, so a round can be merged again (or read as it merged).
 */
export function knownBefore(findings, round) {
  const known = (findings?.known ?? []).filter((entry) => entry.round < round)
    .map((entry) => ({ ...entry, reopened: entry.reopened.filter((item) => item < round) }));
  const dropped = (findings?.dropped ?? []).filter((entry) => entry.round < round);
  const since = (findings?.dropped ?? []).length - dropped.length;
  return { known, dropped, knownDropped: Math.max(0, (findings?.knownDropped ?? 0) - since) };
}

/**
 * Merge one round's answers into the known list. Pure: returns
 * {known, knownDropped, dropped, entry, fix}, where entry is the round's record
 * {round, reviewed, new, reopened, repeated, outOfScope, ignored} and fix the
 * fix-worthy findings [{finding, area, step, reopened}] in answer order.
 * `reopen` false (a loop with no fix step) reads stillOpen as a repeat: with
 * nothing to fix it, a finding still present is no news.
 */
export function mergeRound({ answers, known = [], knownDropped = 0, dropped = [], round, reopen = true, floor = DEFAULT_FLOOR }) {
  const list = clone(known);
  const byKey = new Map();
  for (const entry of list) {
    // A title stored cut is found by its whole title's hash, and by the cut
    // text the known list shows, in case a reviewer copies that.
    byKey.set(`#${entry.key ?? droppedKey(titleKey(entry.title))}`, entry);
    byKey.set(titleKey(entry.title), entry);
  }
  const droppedList = clone(dropped);
  const droppedKeys = new Set(droppedList.map((entry) => entry.key));
  const entry = { round, reviewed: [], new: 0, reopened: 0, repeated: 0, outOfScope: 0, ignored: 0 };
  const fix = [];
  // New in-scope findings under the floor: recorded, not counted as new, and
  // handed to the fixer only beside findings that make the round run it.
  const low = [];
  let droppedCount = knownDropped;
  for (const { step, area, value } of answers) {
    if (!isObject(value) || !Array.isArray(value.findings)) continue;
    if (!entry.reviewed.includes(area)) entry.reviewed.push(area);
    for (const finding of value.findings) {
      // Compared whole: two long titles that differ only past the cut are two
      // findings. Every title is found by the hash of its whole key, so one
      // that is long only by its final period meets the same title without it.
      const whole = isObject(finding) && typeof finding.title === 'string' ? finding.title.trim().replace(/\s+/g, ' ') : '';
      const title = cut(whole, TITLE_MAX);
      const long = title !== whole;
      const plain = titleKey(whole);
      if (!plain) { entry.ignored += 1; continue; }
      const hashed = droppedKey(plain);
      const key = `#${hashed}`;
      const seen = byKey.get(key) ?? byKey.get(plain);
      if (!seen) {
        // A title the full list kept only as a hash: known, so a repeat.
        if (droppedKeys.has(hashed)) { entry.repeated += 1; continue; }
        const inScope = finding.inScope === true;
        const below = inScope && !atOrAboveFloor(finding, floor);
        if (below) entry.belowFloor = (entry.belowFloor ?? 0) + 1;
        else if (inScope) entry.new += 1; else entry.outOfScope += 1;
        const severity = SEVERITIES.includes(finding.severity) ? finding.severity : null;
        const item = {
          title, ...(long ? { key: hashed } : {}), round, area, inScope, ...(severity ? { severity } : {}),
          ...(below ? { belowFloor: true } : {}), from: step, reopened: [],
        };
        byKey.set(key, item);
        byKey.set(titleKey(title), item);
        if (list.length < KNOWN_MAX) list.push(item);
        else {
          droppedCount += 1;
          droppedKeys.add(hashed);
          if (droppedList.length < DROPPED_MAX) droppedList.push({ key: hashed, round });
        }
        if (below) low.push({ finding, area, step, reopened: false, belowFloor: true });
        else if (inScope) fix.push({ finding, area, step, reopened: false });
        continue;
      }
      // Two reviewers of one round disagree on its scope: in scope wins, so
      // the counts do not depend on the order they answered in (the first
      // report becomes the new in-scope one, this one its repeat).
      if (seen.round === round && !seen.inScope && finding.inScope === true) {
        const below = !atOrAboveFloor(finding, floor);
        Object.assign(seen, { inScope: true, area, from: step, ...(below ? { belowFloor: true } : {}) });
        entry.outOfScope -= 1;
        if (below) entry.belowFloor = (entry.belowFloor ?? 0) + 1; else entry.new += 1;
        entry.repeated += 1;
        (below ? low : fix).push({ finding, area, step, reopened: false, ...(below ? { belowFloor: true } : {}) });
        continue;
      }
      // A finding under the floor reported still open is no reason for
      // another round: counted as a repeat.
      if (reopen && finding.stillOpen === true && seen.inScope && !seen.belowFloor && seen.round !== round && !seen.reopened.includes(round)) {
        seen.reopened.push(round);
        entry.reopened += 1;
        fix.push({ finding, area, step, reopened: true });
        continue;
      }
      entry.repeated += 1;
    }
  }
  if (fix.length) fix.push(...low);
  return { known: list, knownDropped: droppedCount, dropped: droppedList, entry, fix };
}

const fixWorthy = (round) => round.new + round.reopened;

/**
 * The dry verdict, from the loop's record: {dry, clean, need, lastFind,
 * unreviewed (area indexes)}, or null before the first merge. Dry when at
 * least `until.dry` rounds after the last fix-worthy finding had a reviewer
 * answer, and every area was reviewed in one of them.
 */
export function dryVerdict(loop, record, group) {
  const rounds = record?.findings?.rounds ?? [];
  if (!rounds.length) return null;
  const lastFind = rounds.filter((round) => fixWorthy(round) > 0).reduce((max, round) => Math.max(max, round.round), 0);
  const since = rounds.filter((round) => round.round > lastFind);
  const clean = since.filter((round) => round.reviewed.length > 0).length;
  const seen = new Set(since.flatMap((round) => round.reviewed));
  const unreviewed = [...Array(areaCount(group)).keys()].filter((area) => !seen.has(area));
  const need = loop.until.dry;
  const dry = clean >= need && !unreviewed.length;
  // The yield stop: the last `rounds` rounds were reviewed, covered every
  // area, and each found at most `max` (YIELD_DEFAULT).
  const rule = group?.fixFirst ? null : yieldOf(loop);
  const tail = rule ? rounds.slice(-rule.rounds) : [];
  const tailSeen = new Set(tail.flatMap((round) => round.reviewed));
  const lowYield = !dry && rule != null && tail.length === rule.rounds
    // A finding whose fix did not hold (still open) always keeps it going.
    && tail.every((round) => round.reviewed.length > 0 && round.reopened === 0 && round.new >= 1 && round.new <= rule.max)
    && [...Array(areaCount(group)).keys()].every((area) => tailSeen.has(area));
  return {
    dry: dry || lowYield, ...(lowYield ? { by: 'yield', yieldRule: rule } : {}),
    clean, need, lastFind, unreviewed: lowYield ? [] : unreviewed,
  };
}

/**
 * A dry loop's findings in a few facts, for the watch, the Run page and the
 * result: {known (in-scope titles), outOfScope (titles), rounds (new per
 * round), stillOpen (known findings reported still open, per round), lastNew,
 * dryIn?, unreviewed? (area names)}. Null before the first merge.
 */
export function loopFindingsSummary(loop, record, group) {
  const findings = record?.findings;
  if (!findings?.rounds?.length) return null;
  const verdict = dryVerdict(loop, record, group);
  const last = findings.rounds.at(-1);
  const names = group.areas.length ? verdict.unreviewed.map((area) => group.areas[area]) : [];
  return {
    known: findings.known.filter((entry) => entry.inScope && !entry.belowFloor).map((entry) => entry.title),
    // In scope but under the loop's floor: recorded, never a reason to go on.
    belowFloor: findings.known.filter((entry) => entry.inScope && entry.belowFloor).map((entry) => entry.title),
    outOfScope: findings.known.filter((entry) => !entry.inScope).map((entry) => entry.title),
    rounds: findings.rounds.map((round) => round.new),
    stillOpen: findings.rounds.map((round) => round.reopened),
    lastNew: { round: last.round, new: last.new, reopened: last.reopened, fix: last.fix },
    ...(record.status === 'passed' && record.reason === 'dry' ? { dryIn: record.round } : {}),
    ...(record.status === 'passed' && record.reason === 'yield' ? { yieldIn: record.round } : {}),
    ...(names.length && !(record.status === 'passed' && ['dry', 'yield'].includes(record.reason)) ? { unreviewed: names } : {}),
  };
}

// --- what each worker is told ----------------------------------------------------

// How a reviewer writes findings. `reopen` false (a loop with no fix step, or
// round 1, which has no known list yet): stillOpen is not asked for.
function titleRules({ reopen, floor = DEFAULT_FLOOR }) {
  const counted = SEVERITIES.slice(0, SEVERITIES.indexOf(floor) + 1).join(' or ');
  return [
    'Write each problem as one finding:',
    `- title: one short line naming what is wrong and where, under ${TITLE_MAX} characters (a longer one is shown cut). Bullswarm tells new findings from known ones by the title, ignoring case, extra spaces and a final period, so reuse a known title word for word.`,
    '- inScope: true when the contract you were given requires it; false for style, wishes or anything it does not require (recorded, never fixed, does not keep the loop going).',
    `- severity: everyday (ordinary use of the work hits it), edge (a real but less common input or situation), or obscure (only a contrived combination hits it). Judge how often it would be hit, not how bad it sounds. Only ${counted} findings keep the loop going; obscure ones are recorded and fixed only beside them.`,
    ...(reopen ? ['- stillOpen: true only when you report a finding from the list below again because it is still present; use its exact title.'] : []),
  ];
}

/**
 * The fixers of a dry loop, in loop order: its fix steps that can change
 * files (lane build or chore). A read-only step beside the review (a lint, a
 * test run) is left out: it fixes nothing, so a reviewer is not blinded to
 * it nor told a fix of its own findings might not have held.
 */
export function fixersOf(state, loop, group) {
  const inGroup = new Set(group.steps);
  const lanes = new Map((state.program?.actions ?? []).map((action) => [action.id, action.lane]));
  return loop.steps.filter((id) => !inGroup.has(id) && ['build', 'chore'].includes(lanes.get(id)));
}

/**
 * The loop's fixers that run before the review while another fixer follows
 * it (the build inside `[build, review, fix]`): the fixer after the review is
 * handed every round's findings, so these are not: they do their work in
 * round 1 and are skipped from round 2 (rebuilding every round would redo the
 * work, hand the findings to two steps, and fail "no file changed" when
 * nothing is left to change). A read-only step before the review (a test run)
 * is not one: it runs again after each fix. [] when no fixer follows the review.
 */
export function onceFixersOf(state, loop, group) {
  const { before, after } = fixStepsOf(state, loop, group);
  const fixers = fixersOf(state, loop, group);
  return after.some((id) => fixers.includes(id)) ? before.filter((id) => fixers.includes(id)) : [];
}

/**
 * True when a dry loop skipped fix step `stepId` in `round`: a step after the
 * review when that round found nothing fix-worthy, a step before it (from
 * round 2) when the round before did.
 */
export function skippedInRound(state, loop, record, stepId, round) {
  const group = groupOf(state, loop);
  if (!group || group.steps.includes(stepId)) return false;
  const before = fixStepsOf(state, loop, group).before.includes(stepId);
  if (before && round < 2) return false;
  if (onceFixersOf(state, loop, group).includes(stepId)) return true;
  const decided = before ? round - 1 : round;
  return (record?.findings?.rounds ?? []).find((entry) => entry.round === decided)?.fix === 'skipped';
}

/**
 * The steps whose account a dry loop's reviewer is not handed, beside its own
 * blindTo: the loop's fixers it depends on (in [fix, review] order). A
 * reviewer judges the work, never the fixer's report of it; a read-only step
 * it depends on (a test run) is handed to it as the caller wired it.
 * [] for any other step.
 */
export function reviewerBlindTo(state, action) {
  const context = dryContext(state, action?.id);
  if (!context || context.role !== 'review') return [];
  const fixers = new Set(fixersOf(state, context.loop, context.group));
  return (action.dependsOn ?? []).filter((id) => fixers.has(id));
}

/**
 * The block a reviewer of a dry loop is given every round: its area (with
 * areas), how to write findings, and from round 2 what the loop already
 * knows. It replaces the Previous round block: a reviewer is never handed a
 * fix step's answer or output. Null for any other step.
 */
export function reviewRoundBlock(state, action) {
  const context = dryContext(state, action?.id);
  if (!context || context.role !== 'review') return null;
  const { loop, group, record } = context;
  const round = record?.round ?? 1;
  const of = record?.maxRounds ?? loop.maxRounds;
  const fixers = fixersOf(state, loop, group);
  // The fixers that took part in the round before (not the build that runs once).
  const once = onceFixersOf(state, loop, group);
  const ran = fixers.filter((id) => !once.includes(id));
  const lines = [`## Review round (loop ${loop.id}, round ${round} of ${of})`];
  if (group.areas.length) {
    const index = group.steps.indexOf(action.id);
    const mine = group.areas[areaOfSlot(group, index, round)];
    const others = [...new Set(group.steps.map((_, slot) => group.areas[areaOfSlot(group, slot, round)]))].filter((area) => area !== mine);
    lines.push(`Focus on this area: ${mine}.${others.length ? ` Other reviewers cover ${joinAnd(others)} this round;` : ''} Report a finding outside your area only when it is serious.`);
  } else if (loop.until.nonFunctional !== false) {
    // One reviewer, no areas: it covers the non-functional side too (0.38.15).
    lines.push('Besides whether the work does what the contract asks, look at performance (an operation far slower than it needs to be on realistic input), code structure, and whether the tests would catch a regression; a problem there is a finding too.');
  }
  lines.push(...titleRules({ reopen: fixers.length > 0 && round >= 2, floor: floorOf(loop) }));
  if (round >= 2) {
    const previous = record.findings?.rounds?.find((entry) => entry.round === round - 1);
    if (fixers.length && previous) {
      lines.push(previous.fix === 'skipped'
        ? `Round ${round - 1} found nothing new to fix, so ${joinAnd(ran)} did not run.`
        : `Round ${round - 1}'s findings went to ${joinAnd(ran)}; check whether each fix holds.`);
    }
    // With a fixer, a known finding that is still present is reported
    // again (stillOpen); without one, nothing fixes it between rounds.
    lines.push(fixers.length ? '### Already known (report one again only if it is still present)' : '### Already known (do not report again)');
    // Only earlier rounds: a reviewer rerun in this round is not told this
    // round's own findings went to the fixer (the round merges again from the
    // list as it stood before it, so a finding left out here is reported again).
    const before = knownBefore(record.findings, round);
    const row = (entry) => {
      const area = areaName(group, entry.area);
      return `- [round ${entry.round}${area ? ` · ${area}` : ''}] ${entry.title}`;
    };
    // Out-of-scope findings were recorded, never handed to a fixer.
    const sections = [
      [fixers.length ? 'These were found in earlier rounds and handed to the fixer:' : 'These were found in earlier rounds:', before.known.filter((entry) => entry.inScope).map(row)],
      ['These were found in earlier rounds and recorded out of scope (not fixed):', before.known.filter((entry) => !entry.inScope).map(row)],
    ].filter(([, rows]) => rows.length);
    if (!sections.length && !before.knownDropped) lines.push('Nothing yet.');
    let used = 0;
    let hidden = before.knownDropped;
    for (const [heading, rows] of sections) {
      let shown = 0;
      for (const item of rows) {
        if (used + item.length > KNOWN_BLOCK_CHARS) break;
        if (!shown) lines.push(heading);
        lines.push(item);
        used += item.length + 1;
        shown += 1;
      }
      hidden += rows.length - shown;
    }
    if (hidden > 0) lines.push(`(${hidden} more known finding${hidden === 1 ? ' is' : 's are'} not listed here.)`);
    lines.push(fixers.length
      ? 'Report findings that are not on this list. Report one on the list again only when it is in scope and still present (its fix did not hold): use its exact title and stillOpen: true. Leave out the rest of the list.'
      : 'Report only findings that are not on this list.');
  }
  return lines.join('\n');
}

/**
 * The block a fix step of a dry loop is given when it runs: the fix-worthy
 * findings of the round it fixes (this round's review for a step after it,
 * the round before's for a step before it), de-duplicated, with each
 * reviewer's answer file. A step before the review is told in round 1 that
 * no review has run yet; a step blindTo the review is told its findings are
 * not listed (blindTo is never broken). Null when there is nothing to list.
 */
export function findingsToFixBlock(state, action, { readOnly = action?.lane === 'analyze' } = {}) {
  const context = dryContext(state, action?.id);
  if (!context || context.role === 'review' || !context.record) return null;
  const { loop, group, record, role } = context;
  // A step that changes no file (a check beside the fix) is shown the
  // findings for reference, never told to fix them.
  const heading = `## ${readOnly ? 'Review findings' : 'Findings to fix'} (loop ${loop.id}, round ${record.round} of ${record.maxRounds})`;
  const found = role === 'after' ? record.round : record.round - 1;
  // A builder before the review, with a fixer after it: the fixer is handed
  // the findings, this step is not (a rerun of it, by the caller, in a later round).
  const once = onceFixersOf(state, loop, group);
  if (once.includes(action.id) && found >= 1) {
    const after = fixStepsOf(state, loop, group).after.filter((id) => fixersOf(state, loop, group).includes(id));
    return [heading, `The findings of the review go to ${joinAnd(after)}, after ${group.id}, not to this step: do the work your prompt asks for.`].join('\n');
  }
  if (found < 1) {
    return [heading, `No review has run yet in this loop, so this round has no findings${readOnly ? '' : ' to fix'}: ${action.id} runs before ${group.id}. Do the work your prompt asks for; ${group.id} reviews it next.`].join('\n');
  }
  const blindTo = new Set(Array.isArray(action.blindTo) ? action.blindTo : []);
  if (group.steps.some((id) => blindTo.has(id))) {
    return [heading, `You are blind to ${group.id} (blindTo), so its findings are not listed here: judge from the workspace and your other inputs.`].join('\n');
  }
  // The answers that round merged (the record names each reviewer's attempt),
  // read against the list as it stood before it, so the round reads as it
  // merged. Nothing merged yet for that round: nothing to fix.
  const entry = record.findings?.rounds?.find((item) => item.round === found);
  if (!entry) return null;
  const answers = mergedAnswers(state, group, entry);
  const merged = mergeRound({ answers, ...knownBefore(record.findings, found), round: found, floor: floorOf(loop) });
  if (!merged.fix.length) return null;
  const fresh = merged.fix.filter((item) => !item.reopened).length;
  const open = merged.fix.length - fresh;
  const fixers = fixersOf(state, loop, group).filter((id) => id !== action.id);
  // A step whose deliverable is files fails as "no file changed" when it
  // changes none, so it is told so instead of being promised another round.
  const writes = (deliverableTypeOf(action.deliverable) ?? (action.lane === 'build' ? 'files' : null)) === 'files';
  const what = readOnly
    ? `They are listed for reference: your step changes no file, so do what your prompt asks${fixers.length ? `; ${joinAnd(fixers)} ${fixers.length === 1 ? 'fixes' : 'fix'} them` : ''}.`
    : `Fix each one. If you judge one is not a problem, leave it and say why in your report. The reviewers do not read your report: one that still sees the problem reports it again as still open, and the loop then runs another fix round, until its rounds run out and the caller decides.${writes ? ' This step passes only when it changes a file: if you judge that none of them is a problem, change nothing and say why in your report; the step then stops as "no file changed" and goes to the caller.' : ''}`;
  const lines = [
    heading,
    `The review found these in round ${found} (${fresh} new${open ? `, ${open} still open` : ''}). ${what}${merged.entry.outOfScope ? ` ${merged.entry.outOfScope} out-of-scope finding${merged.entry.outOfScope === 1 ? ' was' : 's were'} recorded and ${merged.entry.outOfScope === 1 ? 'is' : 'are'} not listed.` : ''}`,
  ];
  let used = lines.join('\n').length;
  let listed = 0;
  for (const [index, item] of merged.fix.entries()) {
    const area = areaName(group, item.area);
    const row = `${index + 1}. ${area ? `[${area}] ` : ''}${item.reopened ? '(still open) ' : ''}${item.belowFloor ? '(minor, fix if cheap) ' : ''}${String(item.finding.title).trim()}\n   ${cut(JSON.stringify(item.finding), FINDING_SHOWN_CHARS)}`;
    if (used + row.length > FIX_BLOCK_CHARS) break;
    lines.push(row);
    used += row.length + 1;
    listed += 1;
  }
  if (listed < merged.fix.length) lines.push(`… ${merged.fix.length - listed} more in the answer files below.`);
  const files = answers.map((answer) => answer.file).filter(Boolean);
  if (files.length) lines.push(`Full answers: ${files.join(', ')}`);
  return lines.join('\n');
}
