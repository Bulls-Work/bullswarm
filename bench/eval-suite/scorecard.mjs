#!/usr/bin/env node
// The biweekly efficiency scorecard: what Bullswarm's own run records say
// about the last N days. Read-only: it opens state.json, every run's
// state.json, result.json, answer-*.json and events.jsonl under the home, and
// optionally the fleet's order records, and writes nothing there.
//
//   node bench/eval-suite/scorecard.mjs [--home ~/.bullswarm] [--days 14]
//     [--until <ISO>] [--orders <fleet orders dir>] [--previous <scorecard.json>]
//     [--out <dir>]
//
// Every figure is measured from the records; a figure the records cannot give
// is printed as "not recorded", never estimated. The same script runs every
// eval so the trend compares like with like: change it only with a note in
// bench/eval-suite/README.md naming the eval it first applies to.

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';

const SCORECARD_VERSION = 2;

function args(argv) {
  const out = { home: join(homedir(), '.bullswarm'), days: 14, until: new Date().toISOString(), orders: null, previous: null, out: null };
  for (let i = 0; i < argv.length; i += 1) {
    const [flag, inline] = argv[i].split(/=(.*)/s);
    const value = () => inline ?? argv[++i];
    if (flag === '--home') out.home = value();
    else if (flag === '--days') out.days = Number(value());
    else if (flag === '--until') out.until = value();
    else if (flag === '--orders') out.orders = value();
    else if (flag === '--previous') out.previous = value();
    else if (flag === '--out') out.out = value();
    else throw new Error(`unknown flag ${flag}`);
  }
  if (!Number.isFinite(out.days) || out.days <= 0) throw new Error('--days must be a positive number');
  return out;
}

const readJson = (path) => { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; } };
const readLines = (path) => {
  try { return readFileSync(path, 'utf8').split('\n').filter(Boolean).flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } }); } catch { return []; }
};
const ms = (iso) => { const t = Date.parse(iso ?? ''); return Number.isFinite(t) ? t : null; };

function quantile(values, q) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}
const round = (n, d = 1) => (n == null ? null : Math.round(n * 10 ** d) / 10 ** d);
const sum = (values) => values.reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0);

// A run is a review when its goal or its only step's prompt asks for one; a
// one-step run is a task (`bullswarm run`); anything else is a workflow.
function kindOf(state) {
  const goal = String(state.intent?.goal ?? '');
  const steps = state.program?.actions ?? state.actions ?? [];
  if (/^\s*review\b/i.test(goal)) return 'review';
  return steps.length <= 1 ? 'task' : 'workflow';
}

// A run still marked running, paused or waiting whose last recorded event is
// more than a day before the window's end is abandoned (its process is gone):
// it counts as failed, not open.
function outcomeOf(state, result, lastEventMs, untilMs) {
  const status = result?.status ?? state.lifecycle?.status ?? 'unknown';
  if (status === 'completed') return 'success';
  if (status === 'cancelled') return 'cancelled';
  if (status === 'running' || status === 'paused' || status === 'waiting') {
    return lastEventMs != null && untilMs - lastEventMs > 86_400_000 ? 'failed' : 'open';
  }
  return 'failed';
}

const attemptTokens = (attempt) => attempt?.usage?.tokens?.totalKnown ?? null;
// Output plus reasoning: the tokens the model wrote. totalKnown is mostly
// cache reads, which grow with every turn of a long session.
const attemptOutput = (attempt) => {
  const t = attempt?.usage?.tokens;
  return t ? (t.output ?? 0) + (t.reasoning ?? 0) : null;
};
const attemptUsd = (attempt) => attempt?.usage?.api?.usd ?? null;
const stalledAttempt = (attempt) => attempt?.failureKind === 'stalled' || /\bstall|no file change|silence/i.test(String(attempt?.why ?? ''));

function loadRuns(home, fromMs, toMs) {
  const root = join(home, 'workflows');
  const runs = [];
  let dirs = [];
  try { dirs = readdirSync(root); } catch { return runs; }
  for (const dir of dirs) {
    const state = readJson(join(root, dir, 'state.json'));
    if (!state?.lifecycle) continue;
    const started = ms(state.lifecycle.startedAt) ?? ms(state.attempts?.[0]?.startedAt);
    if (started == null || started < fromMs || started >= toMs) continue;
    const result = readJson(join(root, dir, 'result.json'));
    const answers = readdirSync(join(root, dir)).filter((name) => /^answer-.*\.json$/.test(name) && !name.endsWith('.schema.json'))
      .map((name) => readJson(join(root, dir, name))).filter(Boolean);
    const events = readLines(join(root, dir, 'events.jsonl'));
    runs.push({ dir, state, result, answers, events, started });
  }
  return runs.sort((a, b) => a.started - b.started);
}

function runFacts(run, untilMs) {
  const { state, result } = run;
  const lastEventMs = Math.max(...run.events.map((event) => ms(event.at ?? event.ts) ?? 0), run.started);
  const attempts = state.attempts ?? [];
  const finished = ms(state.lifecycle.finishedAt);
  const wallMin = finished != null ? (finished - run.started) / 60_000 : null;
  const byAction = new Map();
  for (const attempt of attempts) {
    const list = byAction.get(attempt.actionId) ?? [];
    list.push(attempt);
    byAction.set(attempt.actionId, list);
  }
  // A failover: after a failed attempt, the next attempt of the same step
  // ran on another pool. A switch after a success (a later loop round or a
  // rerun) is not a failover.
  let sameModelFailovers = 0;
  let crossModelFailovers = 0;
  for (const list of byAction.values()) {
    list.sort((a, b) => (a.ordinal ?? 0) - (b.ordinal ?? 0));
    for (let i = 1; i < list.length; i += 1) {
      if (list[i].pool === list[i - 1].pool || list[i - 1].status !== 'failed') continue;
      if (list[i].model === list[i - 1].model) sameModelFailovers += 1;
      else crossModelFailovers += 1;
    }
  }
  const cancelAt = ms(state.cancellation?.requestedAt);
  // A hang a person cancelled: the run was cancelled while an attempt had
  // shown no activity for at least 10 minutes.
  const hungAtCancel = cancelAt != null && attempts.some((attempt) => {
    const last = ms(attempt.lastActivityAt ?? attempt.lastEventAt ?? attempt.startedAt);
    const end = ms(attempt.finishedAt) ?? cancelAt;
    return last != null && end >= cancelAt - 1000 && cancelAt - last >= 10 * 60_000;
  });
  return {
    id: state.shortId ?? run.dir,
    dir: run.dir,
    goal: String(state.intent?.goal ?? '').split('\n')[0].slice(0, 120),
    kind: kindOf(state),
    outcome: outcomeOf(state, result, lastEventMs, untilMs),
    stalled: attempts.some(stalledAttempt),
    stalledAttempts: attempts.filter(stalledAttempt).length,
    wallMin,
    steps: (state.program?.actions ?? state.actions ?? []).length,
    attempts: attempts.length,
    tokens: sum(attempts.map(attemptTokens)),
    outputTokens: sum(attempts.map(attemptOutput)),
    usd: sum(attempts.map(attemptUsd)),
    failures: attempts.filter((attempt) => attempt.status === 'failed').map((attempt) => attempt.failureKind ?? 'unknown'),
    pools: [...new Set(attempts.map((attempt) => attempt.pool).filter(Boolean))],
    sameModelFailovers,
    crossModelFailovers,
    hungAtCancel,
    staleEvents: run.events.filter((event) => /stale/.test(String(event.type))).length,
    // Stale warnings the run saved (0.38.19+; older runs saved none): one
    // episode per level-1 warning, and the highest level reached.
    staleWarnings: run.events.filter((event) => event.type === 'attempt.stale').length,
    staleEpisodes: run.events.filter((event) => event.type === 'attempt.stale' && staleLevel(event) === 1).length,
    staleMaxLevel: Math.max(0, ...run.events.filter((event) => event.type === 'attempt.stale').map(staleLevel).filter(Number.isFinite)),
    // Which limit stopped a stalled attempt: no file change, else silence.
    stalledBy: attempts.filter(stalledAttempt).map((attempt) => attempt.stalledBy
      ?? (attempt.noProgressSec != null ? 'no-progress' : attempt.silentSec != null ? 'silence' : 'unknown')),
    loops: loopFacts(state),
    answers: run.answers,
    cwd: state.intent?.cwd ?? null,
  };
}

// A saved warning's level: under payload (the runtime's event envelope), or
// at the top level as the watch builds it; NaN when neither says.
const staleLevel = (event) => Number(event.payload?.level ?? event.level ?? Number.NaN);

// How each v3 loop ended: dry, yield (low yield), continued (a caller ended
// it with `workflow continue` after it ran out of rounds: a person or agent
// was needed), rounds-spent (ended by itself at its last round, run flag
// --out-of-rounds end), passed (a plain loop's condition held), blocked,
// waiting (out of rounds, nobody answered yet) or pending.
function loopFacts(state) {
  return (state.controlNodes ?? []).filter((node) => node?.type === 'loop').map((node) => ({
    id: node.id,
    dry: node.findings !== undefined,
    end: node.status === 'passed' ? (node.reason ?? 'passed') : (node.status ?? 'pending'),
    round: node.round ?? null,
    maxRounds: node.maxRounds ?? null,
  }));
}

function loopSummary(facts) {
  const loops = facts.flatMap((f) => f.loops.map((loop) => ({ ...loop, run: f.id, usd: f.usd })));
  const byEnd = {};
  for (const loop of loops) byEnd[loop.end] = (byEnd[loop.end] ?? 0) + 1;
  const person = loops.filter((loop) => loop.end === 'continued');
  return {
    loops: loops.length,
    dryLoops: loops.filter((loop) => loop.dry).length,
    byEnd,
    neededPerson: person.length,
    // A run counts once even with two such loops.
    neededPersonRunUsd: round(sum([...new Map(person.map((loop) => [loop.run, loop.usd])).values()]), 2),
    endedByItselfOutOfRounds: loops.filter((loop) => loop.end === 'rounds-spent').length,
  };
}

function decisionRows(home, fromMs, toMs) {
  const state = readJson(join(home, 'state.json'));
  const log = Array.isArray(state?.decisionLog) ? state.decisionLog : [];
  return log.filter((row) => { const t = ms(row.ts); return t != null && t >= fromMs && t < toMs; });
}

// The pick matched the pacer when it went to the candidate with the highest
// effective surplus among those the route allowed (ties count as a match).
function routingFacts(rows) {
  let judged = 0;
  let matched = 0;
  const off = [];
  const rules = {};
  for (const row of rows) {
    const candidates = row.routing?.candidates;
    if (!Array.isArray(candidates) || candidates.length < 2) continue;
    const surplus = (c) => (Number.isFinite(c.effectiveSurplus) ? c.effectiveSurplus : Number.isFinite(c.pace) ? c.pace : -Infinity);
    const best = Math.max(...candidates.map(surplus));
    const picked = candidates.find((c) => c.pool === row.picked);
    judged += 1;
    if (picked && surplus(picked) >= best - 1e-9) { matched += 1; continue; }
    const reason = String(row.routing?.reason ?? '');
    // The router's own documented exceptions to "most behind": a pool whose
    // window resets soon is used first, and a pick needs 5h headroom.
    const rule = /^expiring soon/.test(reason) ? 'expiring-soon' : /5h headroom/.test(reason) ? '5h-headroom' : 'other';
    rules[rule] = (rules[rule] ?? 0) + 1;
    off.push({ ts: row.ts, picked: row.picked, rule, reason: reason.slice(0, 140) });
  }
  const kinds = {};
  for (const row of rows) if (row.failureKind) kinds[row.failureKind] = (kinds[row.failureKind] ?? 0) + 1;
  // Infrastructure failures (quota, auth, process, schema: not the work's own
  // failed evidence, not a cancel) by the pool's 5h use when it was picked.
  // Denominator: every dispatch row in the bucket that was not cancelled.
  const infra = new Set(['quota', 'auth', 'process', 'schema', 'stalled']);
  const byFiveHour = {};
  for (const row of rows) {
    const pct = row.routing?.fiveHourUsedPct;
    if (!Number.isFinite(pct) || row.failureKind === 'cancelled') continue;
    const bucket = pct < 70 ? '<70' : pct < 85 ? '70-84' : pct < 95 ? '85-94' : '95+';
    const b = (byFiveHour[bucket] ??= { dispatches: 0, infraFailures: 0 });
    b.dispatches += 1;
    if (infra.has(row.failureKind)) b.infraFailures += 1;
  }
  return {
    dispatches: rows.length,
    judged,
    matchedPacer: matched,
    notMatched: judged - matched,
    notMatchedByRule: rules,
    infraFailuresByFiveHourAtPick: byFiveHour,
    notMatchedSamples: off.filter((o) => o.rule === 'other').slice(-5),
    authErrors: kinds.auth ?? 0,
    quotaErrors: kinds.quota ?? 0,
    failureKinds: kinds,
    byPool: rows.reduce((acc, row) => { acc[row.picked] = (acc[row.picked] ?? 0) + 1; return acc; }, {}),
  };
}

// Reviews: a review run's answer with a boolean `passed`. The first try for a
// change is the first review run in the window on that review checkout (cwd).
// v1 figures read only runs whose goal starts with "Review" (kept as they
// were, so the trend compares like with like). v2 adds every review the
// records show: any run with a checked answer that carries a boolean
// `passed` (a strict review whatever its goal says), and the findings
// answers of review loops' reviewers inside workflows.
function strictReviewFacts(facts, pick) {
  const reviews = facts.filter(pick)
    .map((f) => ({ ...f, answer: f.answers.find((a) => typeof a?.passed === 'boolean') ?? null }))
    .filter((f) => f.answer);
  const seen = new Set();
  let firstTries = 0;
  let firstPassed = 0;
  for (const review of reviews) {
    const key = review.cwd ?? review.id;
    if (seen.has(key)) continue;
    seen.add(key);
    firstTries += 1;
    if (review.answer.passed) firstPassed += 1;
  }
  return { reviews: reviews.length, passed: reviews.filter((r) => r.answer.passed).length, firstTries, firstTryPassed: firstPassed,
    firstTryPassRate: firstTries ? round(firstPassed / firstTries, 3) : null };
}

function loopReviewFacts(facts) {
  const answers = facts.filter((f) => f.loops.some((loop) => loop.dry))
    .flatMap((f) => f.answers.filter((a) => Array.isArray(a?.findings) && typeof a?.passed !== 'boolean'));
  const counts = answers.map((a) => a.findings.length);
  const inScope = answers.map((a) => a.findings.filter((x) => x?.inScope === true).length);
  return {
    reviewerAnswers: answers.length,
    findingsPerAnswer: counts.length ? round(sum(counts) / counts.length, 2) : null,
    inScopePerAnswer: inScope.length ? round(sum(inScope) / inScope.length, 2) : null,
    cleanAnswers: counts.filter((n) => n === 0).length,
  };
}

function reviewFacts(facts) {
  const reviews = facts.filter((f) => f.kind === 'review')
    .map((f) => ({ ...f, answer: f.answers.find((a) => typeof a?.passed === 'boolean') ?? null }))
    .filter((f) => f.answer);
  const seen = new Set();
  let firstTries = 0;
  let firstPassed = 0;
  for (const review of reviews) {
    const key = review.cwd ?? review.id;
    if (seen.has(key)) continue;
    seen.add(key);
    firstTries += 1;
    if (review.answer.passed) firstPassed += 1;
  }
  const findings = reviews.map((r) => (Array.isArray(r.answer.findings) ? r.answer.findings.length : null)).filter(Number.isFinite);
  const severity = {};
  for (const r of reviews) for (const f of Array.isArray(r.answer.findings) ? r.answer.findings : []) severity[f.severity ?? 'unrated'] = (severity[f.severity ?? 'unrated'] ?? 0) + 1;
  return {
    reviews: reviews.length,
    passed: reviews.filter((r) => r.answer.passed).length,
    firstTries,
    firstTryPassed: firstPassed,
    firstTryPassRate: firstTries ? round(firstPassed / firstTries, 3) : null,
    reviewsWithFindings: findings.length,
    findingsPerReview: findings.length ? round(sum(findings) / findings.length, 2) : null,
    findingsBySeverity: severity,
    allStrict: strictReviewFacts(facts, () => true),
    inLoops: loopReviewFacts(facts),
  };
}

// Rework from the fleet's order records: an order that reached CLAIMED_DONE
// and later went back to work (any state other than VERIFIED, CANCELED or
// another CLAIMED_DONE) needed rework after "done".
function reworkFacts(ordersDir, fromMs, toMs) {
  if (!ordersDir || !existsSync(ordersDir)) return null;
  const all = { claimedDone: 0, reopened: 0, backToWork: 0, failedOnly: 0, byProject: {} };
  for (const name of readdirSync(ordersDir).filter((n) => n.endsWith('.json'))) {
    const order = readJson(join(ordersDir, name));
    const history = Array.isArray(order?.history) ? order.history : [];
    const claims = history.filter((h) => h.state === 'CLAIMED_DONE' && ms(h.at) >= fromMs && ms(h.at) < toMs);
    if (!claims.length) continue;
    const first = ms(claims[0].at);
    const later = history.filter((h) => ms(h.at) > first).map((h) => h.state);
    const reopened = later.some((state) => !['VERIFIED', 'CANCELED', 'CLAIMED_DONE'].includes(state));
    const backToWork = later.some((state) => state === 'WORKING' || state === 'INPUT_REQUIRED');
    const project = String(order.project ?? 'unknown').toLowerCase();
    const p = (all.byProject[project] ??= { claimedDone: 0, reopened: 0 });
    all.claimedDone += 1; p.claimedDone += 1;
    if (reopened) { all.reopened += 1; p.reopened += 1; }
    if (reopened && backToWork) all.backToWork += 1;
    else if (reopened) all.failedOnly += 1;
  }
  all.reworkRate = all.claimedDone ? round(all.reopened / all.claimedDone, 3) : null;
  return all;
}

function byKind(facts) {
  const out = {};
  for (const kind of ['task', 'workflow', 'review', 'all']) {
    const list = kind === 'all' ? facts : facts.filter((f) => f.kind === kind);
    const done = list.filter((f) => f.outcome !== 'open');
    const success = done.filter((f) => f.outcome === 'success');
    const wall = done.map((f) => f.wallMin).filter(Number.isFinite);
    out[kind] = {
      runs: list.length,
      success: success.length,
      failed: done.filter((f) => f.outcome === 'failed').length,
      cancelled: done.filter((f) => f.outcome === 'cancelled').length,
      stalled: list.filter((f) => f.stalled).length,
      open: list.length - done.length,
      wallMinP50: round(quantile(wall, 0.5)),
      wallMinP90: round(quantile(wall, 0.9)),
      tokensPerSuccessfulRun: success.length ? Math.round(sum(success.map((f) => f.tokens)) / success.length) : null,
      outputTokensPerSuccessfulRun: success.length ? Math.round(sum(success.map((f) => f.outputTokens)) / success.length) : null,
      tokensAllRuns: sum(list.map((f) => f.tokens)),
      apiUsdEquivalent: round(sum(list.map((f) => f.usd)), 2),
    };
  }
  return out;
}

function trend(current, previous) {
  if (!previous) return null;
  const pick = (s) => ({
    runs: s.runsByKind.all.runs,
    successRate: s.runsByKind.all.runs ? s.runsByKind.all.success / s.runsByKind.all.runs : null,
    wallMinP50: s.runsByKind.all.wallMinP50,
    tokensPerSuccessfulRun: s.runsByKind.all.tokensPerSuccessfulRun,
    outputTokensPerSuccessfulRun: s.runsByKind.all.outputTokensPerSuccessfulRun,
    pacerMatchRate: s.routing.judged ? s.routing.matchedPacer / s.routing.judged : null,
    firstTryPassRate: s.quality.firstTryPassRate,
    firstTryPassRateAllStrict: s.quality.allStrict?.firstTryPassRate ?? null,
    stalledRuns: s.runsByKind.all.stalled,
    // v2 figures: absent from a v1 scorecard (shown as —).
    loopsNeedingPerson: s.loops?.neededPerson ?? null,
    staleEpisodes: s.stalls?.staleEpisodes ?? null,
  });
  const now = pick(current);
  const before = pick(previous);
  return Object.fromEntries(Object.keys(now).map((k) => [k, { previous: before[k], current: now[k] }]));
}

function markdown(card) {
  const k = card.runsByKind;
  const lines = [];
  lines.push(`# Bullswarm scorecard ${card.window.from.slice(0, 10)} → ${card.window.until.slice(0, 10)}`, '');
  lines.push(`Measured from ${card.source.home} (${card.source.runDirs} run directories in the window, ${card.routing.dispatches} dispatch rows). Scorecard v${card.version}.`, '');
  lines.push('Definitions: a run is in the window when it started in it. review = the goal starts with the word "Review" (the blind reviews leads launch; other reviews inside workflows count as workflow); task = any other run with one step (`bullswarm run`); workflow = the rest. success = result completed; failed = partial, interrupted, or abandoned (still marked running with no event for over a day); wall time counts every finished run (completed, partial, cancelled). v2 figures: a loop ended `continued` when its caller ended it after it ran out of rounds, `rounds-spent` when it ended itself (--out-of-rounds end); a stale episode is a saved attempt.stale warning at level 1; a strict review is any run with a checked answer carrying a boolean `passed` (first try = first per working directory); loop reviewer answers are findings lists without `passed` in runs that have a dry loop.', '');
  lines.push('## Runs', '', '| kind | runs | success | failed | cancelled | stalled | open | wall p50 (min) | wall p90 (min) | tokens / successful run (all) | output tokens / successful run | API-equivalent USD |', '|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const [kind, s] of Object.entries(k)) lines.push(`| ${kind} | ${s.runs} | ${s.success} | ${s.failed} | ${s.cancelled} | ${s.stalled} | ${s.open} | ${s.wallMinP50 ?? '—'} | ${s.wallMinP90 ?? '—'} | ${s.tokensPerSuccessfulRun?.toLocaleString('en-US') ?? '—'} | ${s.outputTokensPerSuccessfulRun?.toLocaleString('en-US') ?? '—'} | ${s.apiUsdEquivalent} |`);
  lines.push('', 'Tokens per merged or accepted outcome: not recorded (Bullswarm does not know which outputs were merged).', '');
  const r = card.routing;
  lines.push('## Routing', '');
  lines.push(`- dispatches: ${r.dispatches}; with two or more candidates: ${r.judged}; went to the most-behind candidate: ${r.matchedPacer} (${r.judged ? round((100 * r.matchedPacer) / r.judged) : '—'}%), not: ${r.notMatched} (by the router's rule: ${JSON.stringify(r.notMatchedByRule)})`);
  lines.push(`- failovers (after a failed attempt, the step's next attempt ran on another pool): same model ${card.failovers.sameModel}, cross model ${card.failovers.crossModel}`);
  lines.push(`- infrastructure failures (quota, auth, process, schema, stalled) by the pool's 5h use at pick; denominator: dispatches not cancelled: ${Object.entries(r.infraFailuresByFiveHourAtPick).map(([k, v]) => `${k}: ${v.infraFailures}/${v.dispatches} (${round((100 * v.infraFailures) / v.dispatches)}%)`).join(', ')}`);
  lines.push(`- auth errors ${r.authErrors}, quota errors ${r.quotaErrors}; all failure kinds: ${JSON.stringify(r.failureKinds)}`);
  lines.push(`- dispatches by pool: ${JSON.stringify(r.byPool)}`);
  lines.push('- subscription points per pool: not attributable from the records (each dispatch records the meter change over its own window, which overlaps other dispatches; read the pool meters at the start and end of the eval instead)', '');
  const s = card.stalls;
  lines.push('## Stalls', '', `- runs with a stalled attempt: ${s.stalledRuns} (${s.stalledAttempts} attempts; stopped by ${JSON.stringify(s.stalledBy)})`,
    `- stale warnings saved in run events: ${s.staleWarnings} in ${s.staleEpisodes} episodes across ${s.staleRuns} runs; highest level ${s.staleMaxLevel} (runs from before 0.38.19 save none, so a low figure over a window that mixes versions is a floor)`,
    `- cancelled while an attempt had been silent ≥ 10 min (a hang a person stopped): ${s.hungAtCancel}`, '');
  const l = card.loops;
  lines.push('## Review loops', '', `- v3 loops: ${l.loops} (${l.dryLoops} dry loops); how they ended: ${JSON.stringify(l.byEnd)}`,
    `- out of rounds and ended by the caller (\`workflow continue\`, a person or agent needed): ${l.neededPerson}; those runs cost $${l.neededPersonRunUsd} API-equivalent`,
    `- out of rounds and ended by themselves (--out-of-rounds end): ${l.endedByItselfOutOfRounds}`, '');
  const q = card.quality;
  lines.push('## Quality', '', `- reviews with a checked answer: ${q.reviews}; passed ${q.passed}`, `- first try per reviewed change: ${q.firstTryPassed}/${q.firstTries} passed (${q.firstTryPassRate == null ? '—' : `${round(q.firstTryPassRate * 100)}%`})`, `- findings per review (reviews whose answer has a findings list: ${q.reviewsWithFindings}): ${q.findingsPerReview ?? '—'}; by severity ${JSON.stringify(q.findingsBySeverity)}`);
  if (q.allStrict) {
    const a = q.allStrict;
    lines.push(`- every strict review (any run with a checked answer carrying \`passed\`, whatever its goal): ${a.reviews}; passed ${a.passed}; first try per reviewed change ${a.firstTryPassed}/${a.firstTries} (${a.firstTryPassRate == null ? '—' : `${round(a.firstTryPassRate * 100)}%`})`);
    const l = q.inLoops;
    lines.push(`- review loops' reviewer answers (findings lists inside workflows): ${l.reviewerAnswers}; findings per answer ${l.findingsPerAnswer ?? '—'} (in scope ${l.inScopePerAnswer ?? '—'}); clean answers ${l.cleanAnswers}`);
  }
  if (card.rework) lines.push(`- fleet orders claimed done in the window: ${card.rework.claimedDone}; not accepted as done afterwards: ${card.rework.reopened} (${card.rework.reworkRate == null ? '—' : `${round(card.rework.reworkRate * 100)}%`}): back to work ${card.rework.backToWork}, failed verification only ${card.rework.failedOnly}. Order files only (orders kept only in closed.jsonl are not counted).`);
  else lines.push('- rework after done: not recorded (no --orders directory given)');
  lines.push('', '## Five most expensive runs (API-equivalent USD)', '', '| run | kind | outcome | USD | tokens | attempts | wall (min) | failures | goal |', '|---|---|---|---|---|---|---|---|---|');
  for (const e of card.expensive) lines.push(`| ${e.id} | ${e.kind} | ${e.outcome} | ${e.usd} | ${e.tokens.toLocaleString('en-US')} | ${e.attempts} | ${e.wallMin ?? '—'} | ${e.failures.join(', ') || '—'} | ${e.goal.replace(/\|/g, '\\|')} |`);
  if (card.trend) {
    lines.push('', '## Trend against the previous eval', '', '| figure | previous | now |', '|---|---|---|');
    for (const [name, v] of Object.entries(card.trend)) lines.push(`| ${name} | ${v.previous == null ? '—' : round(v.previous, 3)} | ${v.current == null ? '—' : round(v.current, 3)} |`);
  } else lines.push('', 'Trend: this is the baseline (no previous scorecard given).');
  return `${lines.join('\n')}\n`;
}

export function scorecard({ home, days, until, orders = null, previous = null }) {
  const toMs = ms(until);
  if (toMs == null) throw new Error('--until must be an ISO time');
  const fromMs = toMs - days * 86_400_000;
  const runs = loadRuns(home, fromMs, toMs);
  const facts = runs.map((run) => runFacts(run, toMs));
  const rows = decisionRows(home, fromMs, toMs);
  const card = {
    version: SCORECARD_VERSION,
    window: { from: new Date(fromMs).toISOString(), until: new Date(toMs).toISOString(), days },
    source: { home, runDirs: runs.length },
    runsByKind: byKind(facts),
    routing: routingFacts(rows),
    failovers: { sameModel: sum(facts.map((f) => f.sameModelFailovers)), crossModel: sum(facts.map((f) => f.crossModelFailovers)) },
    stalls: {
      stalledRuns: facts.filter((f) => f.stalled).length,
      stalledAttempts: sum(facts.map((f) => f.stalledAttempts)),
      staleEvents: sum(facts.map((f) => f.staleEvents)),
      staleWarnings: sum(facts.map((f) => f.staleWarnings)),
      staleEpisodes: sum(facts.map((f) => f.staleEpisodes)),
      staleRuns: facts.filter((f) => f.staleWarnings > 0).length,
      staleMaxLevel: Math.max(0, ...facts.map((f) => f.staleMaxLevel)),
      stalledBy: facts.flatMap((f) => f.stalledBy).reduce((acc, by) => ({ ...acc, [by]: (acc[by] ?? 0) + 1 }), {}),
      hungAtCancel: facts.filter((f) => f.hungAtCancel).length,
    },
    loops: loopSummary(facts),
    quality: reviewFacts(facts),
    rework: reworkFacts(orders, fromMs, toMs),
    expensive: [...facts].sort((a, b) => b.usd - a.usd).slice(0, 5).map((f) => ({
      id: f.id, dir: f.dir, kind: f.kind, outcome: f.outcome, usd: round(f.usd, 2), tokens: f.tokens, attempts: f.attempts,
      steps: f.steps, wallMin: round(f.wallMin), failures: f.failures, pools: f.pools, goal: f.goal,
    })),
  };
  card.trend = trend(card, previous);
  return card;
}

if (import.meta.url === `file://${process.argv[1]}` || basename(process.argv[1] ?? '') === 'scorecard.mjs') {
  const opts = args(process.argv.slice(2));
  const card = scorecard({ ...opts, previous: opts.previous ? readJson(opts.previous) : null });
  const text = markdown(card);
  if (opts.out) {
    mkdirSync(opts.out, { recursive: true });
    writeFileSync(join(opts.out, 'scorecard.json'), `${JSON.stringify(card, null, 2)}\n`);
    writeFileSync(join(opts.out, 'scorecard.md'), text);
  }
  process.stdout.write(text);
}
