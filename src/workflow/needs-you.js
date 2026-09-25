// The needs-you block (stage-3 §2.5, D25, D26): what the watcher prints when a
// program step comes back to the caller, either because it failed with no
// automatic retry left or because the kernel's review loop handed failing
// requirements back. Pure over the durable state and the event that produced
// it: observation adds no facts. The kernel adds only `attemptIds` and
// `retries` to a failed `action.finished` payload, so a replay from an older
// cursor still names the right tries; saved runs without them are read from
// the state (retries are the attempts minus one when no `retryOf` fact exists).

import { glyphs } from '../lib/glyphs.js';
import { countRetries, declaredEvidence, NEEDS_YOU_LABELS, roleOf } from './step-vocabulary.js';
import { readRunFeatures, runFeatureFlags } from './run-features.js';
import { formatDuration } from './watch-cli.js';

const LINE_CHARS = 160;
const LIST_CAP = 5;
const EVIDENCE_ITEMS = 2;
const REVIEW_REQUIREMENTS = 3;
const OPTION_WIDTH = 17;
// A step in one of these states is done with, so it waits on nothing.
const FINISHED = new Set(['succeeded', 'failed', 'cancelled', 'interrupted', 'skipped']);
const CHECK_FAULT_LABEL = 'check could not run';

const definitionOf = (state, id) => (state?.program?.actions ?? []).find((action) => action.id === id) ?? null;
const runtimeOf = (state, id) => (state?.actions ?? []).find((action) => action.id === id) ?? null;

function clip(text, max = LINE_CHARS) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function lastLine(text) {
  const lines = String(text ?? '').split('\n').map((line) => line.trim()).filter(Boolean);
  return lines.length ? clip(lines.at(-1)) : null;
}

function plural(count, one, many = `${one}s`) {
  return `${count} ${count === 1 ? one : many}`;
}

function capped(names) {
  if (names.length <= LIST_CAP) return names.join(', ');
  return `${names.slice(0, LIST_CAP).join(', ')} and ${names.length - LIST_CAP} more`;
}

function durationSecOf(attempt) {
  const value = (Date.parse(attempt?.finishedAt ?? '') - Date.parse(attempt?.startedAt ?? '')) / 1000;
  return Number.isFinite(value) ? Math.max(0, Math.round(value)) : null;
}

function filesOf(attempt) {
  return Number.isInteger(attempt?.changedFileCount) ? attempt.changedFileCount : 0;
}

// The step's current-definition attempts: the ones the kernel named on the
// event, else the ones after the step's superseded count that had started by
// the time the event was committed (a replay reads a state that moved on).
function currentAttempts(state, stepId, attemptIds, committedAt) {
  const all = (state?.attempts ?? []).filter((attempt) => attempt?.actionId === stepId);
  if (Array.isArray(attemptIds) && attemptIds.length) {
    const byId = new Map(all.map((attempt) => [attempt.id, attempt]));
    const named = attemptIds.map((id) => byId.get(id)).filter(Boolean);
    if (named.length) return named;
  }
  const superseded = runtimeOf(state, stepId)?.supersededAttempts ?? 0;
  const current = all.filter((attempt) => !(attempt.ordinal <= superseded));
  const at = Date.parse(committedAt ?? '');
  if (!Number.isFinite(at)) return current;
  const before = current.filter((attempt) => !(Date.parse(attempt.finishedAt ?? attempt.startedAt ?? '') > at));
  return before.length ? before : current;
}

// Stage 2's F23 fact: the step declares evidence and its last attempt failed
// before any check ran.
function evidenceNotRun(definition, failureKind, attempt) {
  if (failureKind === 'failed-evidence') return false;
  return declaredEvidence(definition).length > 0 && !Array.isArray(attempt?.evidenceResults);
}

function retriesOf(state, stepId, attempts, payload, flags) {
  if (Number.isInteger(payload?.retries) && payload.retries >= 0) return payload.retries;
  if (flags.failureRule || attempts.some((attempt) => attempt.retryOf)) {
    const superseded = Math.min(...attempts.map((attempt) => attempt.ordinal).filter(Number.isFinite), Infinity);
    return countRetries(state, stepId, Number.isFinite(superseded) ? superseded - 1 : undefined);
  }
  return Math.max(0, attempts.length - 1);
}

// Running or waiting steps other than this one, and this step's unfinished
// dependents (direct or through other steps), in program order.
function neighbours(state, stepId) {
  const order = (state?.program?.actions ?? []).map((action) => action.id);
  const status = (id) => runtimeOf(state, id)?.status ?? 'pending';
  const stillRunning = order.filter((id) => id !== stepId && ['running', 'waiting'].includes(status(id)));
  const reach = new Set([stepId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const action of state?.program?.actions ?? []) {
      if (reach.has(action.id)) continue;
      if ((action.dependsOn ?? []).some((id) => reach.has(id))) { reach.add(action.id); grew = true; }
    }
  }
  const waitingOnThis = order.filter((id) => id !== stepId && reach.has(id) && !FINISHED.has(status(id)) && !stillRunning.includes(id));
  return { stillRunning, waitingOnThis };
}

function candidatePools(attempt) {
  const list = Array.isArray(attempt?.routeCandidates) ? attempt.routeCandidates
    : Array.isArray(attempt?.routing?.candidates) ? attempt.routing.candidates : [];
  return list.map((candidate) => (typeof candidate === 'string' ? candidate : candidate?.pool)).filter(Boolean);
}

function optionsFor({ token, stepId, pool, attempt, output }) {
  const elsewhere = pool && candidatePools(attempt).some((name) => name !== pool);
  return {
    ...(elsewhere
      ? { rerunElsewhere: `bullswarm workflow step rerun ${token} ${stepId} --avoid ${pool}` }
      : { retryHere: `bullswarm workflow step rerun ${token} ${stepId}` }),
    changeStep: `bullswarm workflow plan export ${token} --out plan.json → plan revise ${token} --program plan.json`,
    takeOver: output,
    acceptAnyway: `bullswarm workflow step accept ${token} ${stepId} --reason "…"`,
  };
}

function takeOverText(attempt, fallback = null) {
  const output = attempt?.outputFile ?? fallback;
  return `output: ${output ?? 'none recorded'}${attempt?.diffFile ? ` · diff: ${attempt.diffFile}` : ''}`;
}

function evidenceItem(item) {
  if (item.type === 'schema') {
    return {
      type: 'schema', file: item.file ?? null, schema: item.schema ?? null, exit: item.exit ?? null,
      ...(item.exit === 1 && Number.isInteger(item.errorCount) ? { errorCount: item.errorCount } : { why: item.why ?? null }),
      tail: lastLine(item.tail),
      ...(item.fault === 'check' ? { fault: 'check' } : {}),
    };
  }
  return {
    type: 'command', cmd: item.cmd ?? null, exit: item.exit ?? null, why: item.why ?? (Number.isInteger(item.exit) ? `exit ${item.exit}` : null),
    tail: lastLine(item.tail),
    ...(item.fault === 'check' ? { fault: 'check' } : {}),
  };
}

/**
 * The §2.5 facts for one event, or null when it produces no block: a failed
 * `action.finished` of a program step, or a `workflow.verify-round` that
 * finished with `next: 'caller'`. `token` is the id the commands name (the
 * short id); `runDir` lets the marker be read; `features` overrides it.
 */
export function needsYouFacts(state, event, { token = null, runDir = null, features = undefined } = {}) {
  const payload = event?.payload ?? {};
  const id = token ?? state?.shortId ?? state?.runId ?? '?';
  const flags = runFeatureFlags(features !== undefined ? features : runDir ? readRunFeatures(runDir) : {});
  if (event?.type === 'workflow.verify-round') {
    if (payload.stage !== 'finished' || payload.next !== 'caller') return null;
    return reviewFacts(state, payload, id, flags);
  }
  if (event?.type !== 'action.finished' || payload.status !== 'failed' || !payload.actionId) return null;
  const stepId = payload.actionId;
  const runtime = runtimeOf(state, stepId);
  const attempts = currentAttempts(state, stepId, payload.attemptIds, event.committedAt);
  const last = attempts.at(-1) ?? null;
  const failureKind = payload.failureKind ?? runtime?.lastFailure?.kind ?? last?.failureKind ?? null;
  const retries = retriesOf(state, stepId, attempts, payload, flags);
  const failing = failureKind === 'failed-evidence'
    ? (Array.isArray(last?.evidenceResults) ? last.evidenceResults : []).filter((item) => item?.status === 'failed')
    : [];
  const checkFault = failing[0]?.fault === 'check';
  const labels = NEEDS_YOU_LABELS[failureKind];
  const label = checkFault ? CHECK_FAULT_LABEL
    : labels && typeof labels === 'object' ? labels[failing[0]?.type === 'schema' ? 'schema' : 'command']
      : labels ?? failureKind ?? 'failed';
  const act = flags.failureRule && retries === 0 && roleOf(definitionOf(state, stepId)) === 'act';
  const pool = last?.pool ?? null;
  return {
    variant: 'step',
    runId: state?.runId ?? null,
    shortId: state?.shortId ?? null,
    token: id,
    actionId: stepId,
    label,
    failureKind,
    retries,
    notRetried: checkFault ? 'check' : act ? 'act' : retries === 0 ? 'none' : null,
    evidence: failing.slice(0, EVIDENCE_ITEMS).map(evidenceItem),
    why: failing.length ? null : clip(payload.why ?? runtime?.lastFailure?.message ?? last?.why ?? 'no reason recorded'),
    evidenceNotRun: evidenceNotRun(definitionOf(state, stepId), failureKind, last),
    attempts: attempts.map((attempt, index) => {
      const how = attempt.retryOf?.how ?? null;
      const previous = attempts[index - 1] ?? null;
      const handoff = Boolean(attempt.handoff) && how !== 'same-pool' && (!previous || previous.pool !== attempt.pool);
      return {
        id: attempt.id ?? `${stepId}-${attempt.ordinal}`, pool: attempt.pool ?? null, model: attempt.model ?? null,
        durationSec: durationSecOf(attempt), files: filesOf(attempt),
        ...(how ? { retryOf: how } : {}), ...(handoff ? { handoff: true } : {}),
      };
    }),
    ...neighbours(state, stepId),
    options: optionsFor({ token: id, stepId, pool, attempt: last, output: takeOverText(last, runtime?.outputFile) }),
  };
}

function lastAttemptOf(state, stepId) {
  return (state?.attempts ?? []).filter((attempt) => attempt?.actionId === stepId).at(-1) ?? null;
}

function firstEvidenceLine(record) {
  for (const entry of [...(record?.evidence ?? []), ...(record?.concerns ?? [])]) {
    const text = typeof entry === 'string' ? entry
      : entry && typeof entry === 'object' ? entry.summary ?? entry.text ?? entry.detail ?? entry.why ?? JSON.stringify(entry) : null;
    if (text && String(text).trim()) return clip(text);
  }
  return null;
}

function reviewFacts(state, payload, id, flags) {
  const loop = state?.verifyLoop ?? null;
  const rounds = Array.isArray(loop?.rounds) ? loop.rounds : [];
  const round = rounds.find((entry) => entry.round === payload.round) ?? rounds.at(-1) ?? null;
  const verifyIds = round?.verifyActionIds ?? [];
  const stepId = verifyIds.at(-1) ?? null;
  if (!stepId) return null;
  const repairs = rounds.filter((entry) => entry.round < (round?.round ?? Infinity) && entry.repairActionId);
  const lastRepair = repairs.at(-1)?.repairActionId ?? null;
  const failed = Array.isArray(payload.failed) ? payload.failed : round?.failed ?? [];
  const verifySet = new Set(verifyIds);
  const review = failed.slice(0, REVIEW_REQUIREMENTS).map((requirementId) => {
    const records = (state?.ledger?.requirements?.[requirementId]?.evidence ?? state?.ledger?.evidence ?? [])
      .filter((record) => record?.requirementId === requirementId && !record.stale);
    const record = records.filter((entry) => verifySet.has(entry.sourceAction)).at(-1) ?? records.at(-1) ?? null;
    const judge = record?.sourceAction ?? stepId;
    const attempt = lastAttemptOf(state, judge);
    return {
      requirement: requirementId, step: judge,
      pool: record?.reviewer?.pool ?? attempt?.pool ?? null, model: record?.reviewer?.model ?? attempt?.model ?? null,
      evidence: firstEvidenceLine(record),
    };
  });
  const verifyAttempt = lastAttemptOf(state, stepId);
  const reviewerPool = review[0]?.pool ?? verifyAttempt?.pool ?? null;
  const repairAttempt = lastRepair ? lastAttemptOf(state, lastRepair) : null;
  const fixes = repairs.length;
  return {
    variant: 'review',
    runId: state?.runId ?? null,
    shortId: state?.shortId ?? null,
    token: id,
    actionId: stepId,
    label: 'review failed',
    failureKind: null,
    round: round?.round ?? payload.round ?? null,
    fixes,
    noFix: fixes === 0 ? (flags.failureRule && loop?.max === 1 ? 'verifyRounds 0' : 'none') : null,
    requirements: [...failed],
    review,
    fix: lastRepair ? {
      step: lastRepair, pool: repairAttempt?.pool ?? null, model: repairAttempt?.model ?? null,
      durationSec: durationSecOf(repairAttempt), files: filesOf(repairAttempt),
    } : null,
    ...neighbours(state, stepId),
    options: optionsFor({
      token: id, stepId, pool: reviewerPool, attempt: verifyAttempt,
      output: `output: ${verifyAttempt?.outputFile ?? runtimeOf(state, stepId)?.outputFile ?? 'none recorded'}`,
    }),
  };
}

function header(facts) {
  const head = `${glyphs().fail} ${facts.actionId} needs you · ${facts.label}`;
  if (facts.variant === 'review') {
    if (facts.noFix === 'verifyRounds 0') return `${head} · no automatic fix (verifyRounds 0)`;
    if (facts.noFix) return `${head} · no automatic fix`;
    return `${head} after ${plural(facts.fixes, 'fix', 'fixes')}`;
  }
  if (facts.notRetried === 'act') return `${head} · not retried: act step (it may have acted)`;
  if (facts.notRetried) return `${head} · not retried`;
  return `${head} after ${plural(facts.retries, 'retry', 'retries')}`;
}

function evidenceLines(item) {
  const text = item.type === 'schema'
    ? `schema ${item.file ?? '?'} ← ${item.schema ?? '?'} → ${Number.isInteger(item.errorCount) ? plural(item.errorCount, 'error') : item.why ?? 'failed'}`
    : `${item.cmd ?? '?'} → ${item.why ?? 'failed'}`;
  return [`  evidence  ${clip(text)}`, ...(item.tail ? [`            ${item.tail}`] : [])];
}

function tryLine(attempt, index) {
  const tail = `${formatDuration(attempt.durationSec)} · ${plural(attempt.files, 'file')}`;
  if (attempt.retryOf === 'same-pool') return `  try ${index + 1}  same pool, failure attached · ${tail}`;
  return `  try ${index + 1}  ${attempt.pool ?? '?'} · ${attempt.model ?? '?'} · ${tail}`
    + (attempt.retryOf === 'wait' ? ' · moved after a usage limit' : '')
    + (attempt.handoff ? ' · handoff attached' : '');
}

function option(name, text) {
  return `    ${name.padEnd(OPTION_WIDTH)}${text}`;
}

/**
 * The block's lines. `terminal` (the run finished in the same poll) leaves
 * out `your call:` and `next:`, because the outcome and handback follow.
 * `next` is the relaunch command, printed last when given.
 */
export function renderNeedsYou(facts, { terminal = false, next = null } = {}) {
  if (!facts) return [];
  const lines = [header(facts)];
  if (facts.variant === 'review') {
    for (const item of facts.review ?? []) {
      lines.push(`  review    ${item.requirement} failed · ${item.step} on ${item.pool ?? '?'} · ${item.model ?? '?'}`);
      if (item.evidence) lines.push(`            ${item.evidence}`);
    }
    if (facts.fix) {
      lines.push(`  fix       ${facts.fix.step} · ${facts.fix.pool ?? '?'} · ${facts.fix.model ?? '?'} · `
        + `${formatDuration(facts.fix.durationSec)} · ${plural(facts.fix.files, 'file')}`);
    }
  } else {
    if (facts.evidence?.length) for (const item of facts.evidence) lines.push(...evidenceLines(item));
    else lines.push(`  why       ${facts.why ?? 'no reason recorded'}${facts.evidenceNotRun ? ' · evidence not run' : ''}`);
    facts.attempts.forEach((attempt, index) => lines.push(tryLine(attempt, index)));
  }
  const around = [
    facts.stillRunning?.length ? `still running: ${capped(facts.stillRunning)}` : null,
    facts.waitingOnThis?.length ? `waiting on this: ${capped(facts.waitingOnThis)}` : null,
  ].filter(Boolean);
  if (around.length) lines.push(`  ${around.join(' · ')}`);
  if (terminal) return lines;
  const options = facts.options ?? {};
  lines.push('  your call:');
  if (options.rerunElsewhere) lines.push(option('rerun elsewhere', options.rerunElsewhere));
  else if (options.retryHere) lines.push(option('retry here', options.retryHere));
  lines.push(option('change the step', options.changeStep));
  lines.push(option('take over', options.takeOver));
  lines.push(option('accept anyway', options.acceptAnyway));
  if (next) lines.push(`  next: ${next}`);
  return lines;
}

/** The JSONL object's fields (the watcher adds type, at, runId, shortId and sequence). */
export function needsYouJson(facts) {
  if (!facts) return null;
  const common = {
    actionId: facts.actionId, label: facts.label, failureKind: facts.failureKind,
  };
  if (facts.variant === 'review') {
    return {
      ...common, variant: 'review', round: facts.round, fixes: facts.fixes, requirements: [...facts.requirements],
      review: facts.review.map((item) => ({ ...item })), fix: facts.fix ? { ...facts.fix } : null,
      stillRunning: [...facts.stillRunning], waitingOnThis: [...facts.waitingOnThis], options: { ...facts.options },
    };
  }
  return {
    ...common, retries: facts.retries,
    ...(facts.notRetried === 'act' || facts.notRetried === 'check' ? { notRetried: facts.notRetried } : {}),
    evidence: facts.evidence.map((item) => ({ ...item })),
    ...(facts.why != null ? { why: facts.why } : {}),
    ...(facts.evidenceNotRun ? { evidenceNotRun: true } : {}),
    attempts: facts.attempts.map((attempt) => ({ ...attempt })),
    stillRunning: [...facts.stillRunning], waitingOnThis: [...facts.waitingOnThis], options: { ...facts.options },
  };
}
