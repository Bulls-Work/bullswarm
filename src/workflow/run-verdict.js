// The `bullswarm run` verdict of a one-step v3 workflow run (0.37.0).
//
// Compact and stable (QA37 rerun, N2): a caller that reads the tail of the
// JSON still finds the run. The keys callers already read stay: ok, why,
// failureKind, retryAfter, pick {pool, model, command}, outFile, taskFile,
// meta {exitCode, ..., wallSec, outBytes, reasoning}, and the worker verdict's small
// facts (contentUsableDespiteExit, usageLimit, meterRefresh, ...). New:
// runId, shortId, answer, answerCheck, a short `usage` summary of the whole
// run, and `details`, the command for the full record (per-attempt cost
// lives in `workflow runs result <id> --json`). Every value comes from the
// run's durable state and the step's last dispatch, never from the worker's
// own report.

import { apiMoney, apiMoneyText, formatMoneyPair } from '../lib/usage-basis.js';
import { poolLabel, withPoolLabels } from '../lib/pool-labels.js';

// The worker verdict's facts a caller may need, each only when present.
const EXTRAS = [
  'cancelled', 'usageLimit', 'meterRefresh', 'notes', 'outputTruncated', 'outputSource', 'stderrTail',
  'dryRun', 'forecast', 'candidates',
];
const META = ['exitCode', 'signal', 'timedOut', 'stalled', 'cancelled', 'wallSec', 'outBytes', 'reasoning'];
const TOKEN_CLASSES = ['standardRead', 'cacheRead', 'cacheWrite', 'output', 'reasoning'];

function answerFacts(attempt) {
  const recorded = attempt?.answer;
  if (!recorded || typeof recorded !== 'object') return { answer: null, answerCheck: null };
  return {
    answer: recorded.value ?? null,
    answerCheck: { ok: recorded.ok === true, errors: [...(recorded.errors ?? [])], file: recorded.file ?? null },
  };
}

const finite = (value) => (value != null && Number.isFinite(Number(value)) ? Number(value) : null);

// Tokens, minutes and money over every attempt of the run: the run's own
// totals (result.json) when it has them, else the attempts' records.
function usageSummary(attempts, totals) {
  const tokens = {};
  let total = 0;
  let any = false;
  for (const name of TOKEN_CLASSES) {
    const values = attempts.map((attempt) => finite(attempt?.usage?.tokens?.[name])).filter((value) => value != null);
    tokens[name] = values.length ? values.reduce((sum, value) => sum + value, 0) : null;
  }
  for (const attempt of attempts) {
    const known = finite(attempt?.usage?.tokens?.totalKnown);
    if (known != null) { total += known; any = true; }
  }
  tokens.total = finite(totals?.tokens) ?? (any ? total : null);
  const wall = attempts.map((attempt) => finite(attempt?.wallSec)).filter((value) => value != null);
  const minutes = finite(totals?.minutes) ?? (wall.length ? Math.round(wall.reduce((sum, value) => sum + value, 0) / 6) / 10 : null);
  const tokenSource = totals?.tokenSource ?? attempts.at(-1)?.usage?.tokenSource ?? 'unknown';
  const money = totals ? apiMoney(totals) : null;
  return {
    attempts: finite(totals?.attempts) ?? attempts.length,
    minutes,
    tokens,
    tokenSource,
    apiUsd: money?.usd ?? null,
    money: apiMoneyText(money, tokenSource),
  };
}

const detailsCommand = (id) => `bullswarm workflow runs result ${id} --json`;

/**
 * `run` is runV2AutonomousWorkflow's return; `dispatched` is the step's last
 * dispatchV2Action result (null when the kernel never dispatched it).
 */
export function runVerdict({ run, dispatched = null, stepId }) {
  const state = run.state ?? {};
  const runtime = (state.actions ?? []).find((action) => action.id === stepId) ?? null;
  const attempts = (state.attempts ?? []).filter((attempt) => attempt.actionId === stepId);
  const last = attempts.at(-1) ?? null;
  const worker = dispatched?.verdict ?? {};
  const ok = runtime?.status === 'succeeded';
  const failure = ok ? null : runtime?.lastFailure ?? null;
  const core = {
    ok,
    // The kernel's facts, never the worker's report or the validator's wording.
    why: ok
      ? run.result?.reason ?? 'the step succeeded'
      : failure?.message ?? worker.why ?? run.result?.reason ?? `the step is ${runtime?.status ?? 'not run'}`,
    failureKind: ok ? null : failure?.kind ?? dispatched?.failureKind ?? runtime?.status ?? 'unknown',
    retryAfter: ok ? null : failure?.retryAfter ?? dispatched?.retryAfter ?? null,
    runId: run.runId,
    shortId: run.shortId ?? state.shortId ?? null,
    pick: { pool: last?.pool ?? null, model: last?.model ?? null, command: worker.pick?.command ?? null },
    outFile: last?.outputFile ?? null,
    ...answerFacts(last),
  };
  const lastMeta = worker.meta ?? {};
  const reasoning = last?.reasoning ?? lastMeta.reasoning ?? null;
  const fallback = { wallSec: last?.wallSec ?? null, reasoning, stalled: false, cancelled: false };
  const meta = Object.fromEntries(META.map((key) => [key, lastMeta[key] ?? fallback[key] ?? null]));
  const facts = {
    taskFile: last?.taskFile ?? null,
    attempts: attempts.length,
    routeWhy: last?.routeWhy ?? null,
    reasoning,
    meta,
    usage: usageSummary(attempts, run.result?.usage?.totals ?? null),
    contentUsableDespiteExit: worker.contentUsableDespiteExit === true,
  };
  const extra = Object.fromEntries(EXTRAS.filter((key) => worker[key] !== undefined).map((key) => [key, worker[key]]));
  const id = core.shortId ?? core.runId;
  return { ...core, ...facts, ...extra, ...(id ? { details: detailsCommand(id) } : {}) };
}

/** The human lines for a verdict (without --json). */
export function runVerdictLines(verdict, bullswarmDir) {
  const lines = [];
  const say = (line) => lines.push(withPoolLabels(line, bullswarmDir));
  say([verdict.ok ? 'OK' : 'FAIL', verdict.pick?.pool ? `[${verdict.pick.pool}]` : '', verdict.why ?? ''].filter(Boolean).join(' '));
  if (verdict.routeWhy && verdict.routeWhy !== verdict.why) say(`route: ${verdict.routeWhy}`);
  if (Array.isArray(verdict.pick?.command) && verdict.dryRun) lines.push(`command: ${verdict.pick.command.join(' ')}`);
  // The forecast the pick was made on, so a preview explains itself.
  if (verdict.forecast && verdict.dryRun) {
    const f = verdict.forecast;
    lines.push(`forecast: inflight=${f.inflight} `
      + `5h ${f.projectedFiveHourPct ?? '?'}%->${f.forecastFiveHourPct ?? '?'}% `
      + `expected=${f.expectedMinutes == null ? 'unknown' : `${f.expectedMinutes}m`} `
      + `rate=${f.ratePerMinute == null ? 'unmeasured' : `${f.ratePerMinute}%/min`} `
      + `basis=${f.estimateSource ?? 'none'}`);
  }
  if (verdict.reasoning?.applied) {
    lines.push(`reasoning: ${verdict.reasoning.applied} (${verdict.reasoning.source}${verdict.reasoning.clamped ? ', clamped' : ''})`);
  }
  if (verdict.answerCheck) {
    lines.push(verdict.answerCheck.ok
      ? `answer: ${JSON.stringify(verdict.answer)}`
      : `answer: failed its schema: ${verdict.answerCheck.errors.join('; ')}`);
  }
  if (verdict.outFile) lines.push(`output: ${verdict.outFile}`);
  const usage = verdict.usage;
  if (usage) {
    const t = usage.tokens ?? {};
    const minutes = usage.minutes == null ? '? min' : `${usage.minutes} min`;
    lines.push(`usage: ${usage.attempts} attempt${usage.attempts === 1 ? '' : 's'} · ${minutes} · ${t.total ?? '?'} tokens (${usage.tokenSource}) · ${usage.money}`);
  } else if (verdict.meta?.usage) {
    // A verdict built elsewhere (a depth refusal carries none).
    lines.push(`cost: ${formatMoneyPair(verdict.meta.usage)}`);
  }
  // Last, so a caller that reads the tail finds the run (QA37 rerun, N2).
  const id = verdict.shortId ?? verdict.runId;
  if (id) lines.push(`run: ${id} · details: bullswarm workflow runs result ${id}`);
  return lines;
}

// JSON with two-space indent, but an array of plain values on one line, so
// an argv or an error list costs one line, not one per item.
function compactJson(value, indent = '') {
  if (Array.isArray(value)) {
    if (value.every((item) => item === null || typeof item !== 'object')) return JSON.stringify(value);
    const inner = `${indent}  `;
    return `[\n${value.map((item) => `${inner}${compactJson(item, inner)}`).join(',\n')}\n${indent}]`;
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value).filter(([, item]) => item !== undefined);
    if (!entries.length) return '{}';
    const inner = `${indent}  `;
    return `{\n${entries.map(([key, item]) => `${inner}${JSON.stringify(key)}: ${compactJson(item, inner)}`).join(',\n')}\n${indent}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** The verdict as --json prints it: the pick carries its display label. */
export function runVerdictJson(verdict, bullswarmDir) {
  const pick = verdict.pick?.pool ? { ...verdict.pick, poolLabel: poolLabel(verdict.pick.pool, bullswarmDir) } : verdict.pick;
  return compactJson({ ...verdict, ...(pick ? { pick } : {}) });
}
