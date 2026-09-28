// The `bullswarm run` verdict of a one-step v3 workflow run (0.37.0).
//
// The keys callers already read stay: ok, why, failureKind, retryAfter,
// pick {pool, model, command}, outFile, and the worker verdict's own facts
// (meta, usageLimit, meterRefresh, ...). New: runId, shortId, answer and
// answerCheck. Gone: keepOnClaude. Every value comes from the run's durable
// state and the step's last dispatch, never from the worker's own report.

import { formatMoneyPair } from '../lib/usage-basis.js';
import { poolLabel, withPoolLabels } from '../lib/pool-labels.js';

// keepOnClaude is gone (0.37.0); `structured` is the answer check, carried as answerCheck.
const DROPPED = ['keepOnClaude', 'structured'];

function answerFacts(attempt) {
  const recorded = attempt?.answer;
  if (!recorded || typeof recorded !== 'object') return { answer: null, answerCheck: null };
  return {
    answer: recorded.value ?? null,
    answerCheck: { ok: recorded.ok === true, errors: [...(recorded.errors ?? [])], file: recorded.file ?? null },
  };
}

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
  const facts = {
    taskFile: last?.taskFile ?? null,
    attempts: attempts.length,
    routeWhy: last?.routeWhy ?? null,
    reasoning: last?.reasoning ?? null,
    meta: worker.meta ?? { wallSec: last?.wallSec ?? null, usage: last?.usage ?? null },
  };
  // What else the worker verdict carries (usageLimit, meterRefresh, notes, ...).
  const extra = Object.fromEntries(Object.entries(worker)
    .filter(([key]) => !DROPPED.includes(key) && !(key in core) && !(key in facts)));
  return { ...core, ...facts, ...extra };
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
  if (verdict.runId) lines.push(`run: ${verdict.shortId ?? verdict.runId} (bullswarm workflow runs show ${verdict.shortId ?? verdict.runId})`);
  if (verdict.answerCheck) {
    lines.push(verdict.answerCheck.ok
      ? `answer: ${JSON.stringify(verdict.answer)}`
      : `answer: failed its schema: ${verdict.answerCheck.errors.join('; ')}`);
  }
  if (verdict.outFile) lines.push(`output: ${verdict.outFile}`);
  const usage = verdict.meta?.usage;
  if (usage) {
    const t = usage.tokens ?? {};
    lines.push(`usage: read=${t.standardRead ?? '?'} cache-read=${t.cacheRead ?? '?'} cache-write=${t.cacheWrite ?? '?'} output=${t.output ?? '?'} reasoning=${t.reasoning ?? '?'} tokens (${usage.tokenSource})`);
    lines.push(`cost: ${formatMoneyPair(usage)}`);
  }
  return lines;
}

/** The verdict as --json prints it: the pick carries its display label. */
export function runVerdictJson(verdict, bullswarmDir) {
  const pick = verdict.pick?.pool ? { ...verdict.pick, poolLabel: poolLabel(verdict.pick.pool, bullswarmDir) } : verdict.pick;
  return JSON.stringify({ ...verdict, ...(pick ? { pick } : {}) }, null, 2);
}
