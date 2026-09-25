// bullswarm route brain — pick a pool for a lane at runtime.
//
// Doctrine:
//   R1. Lanes are WORK NATURE: analyze | build | chore. Never a hard-coded
//       lane→pool map; pools declare capability, runtime selects.
//   R2. Selection is by time-adjusted pace: surplus = elapsed% − used%.
//       Most-behind (HIGHEST surplus) wins — quota piling up unspent is
//       expiring money.
//   R3. Incumbency margin: an incumbent pool keeps the lane unless a
//       challenger beats its surplus by MARGIN points — no flapping.
//   R4. Cost guard (incumbency path only): pace may promote a challenger
//       over an incumbent only if the challenger is CHEAPER.
//   R5. The caller wins its lane only when no eligible delegate remains —
//       it has to WIN, not be protected.
//   R6. A pool whose 5h reading is exhausted at 100%, or whose recorded quota
//       retryAfter is still in the future, is exhausted; quarantined pools are
//       ineligible until their quarantine expires (the re-probe path).
//   R7. A pool at/above FIVE_HOUR_NEAR_LIMIT_PCT of its 5h window is a
//       last-mile candidate, not a hard skip. When another eligible pool is
//       behind pace, its near-limit status is a soft ordering penalty. A pick
//       in this band names the handoff that covers the wall.
//   R8. Route on the FORECAST, not on the reading. A reading is already old at
//       the moment it is read: work dispatched seconds ago has spent quota the
//       meter has not seen, and the assignment being routed will spend more.
//       When a caller attaches in-flight work (pool.inflight) and a spend model
//       (pool.spend / pool.projected*Pct), R7's soft ordering applies to the projection
//       plus this candidate's own expected consumption, a pool forecast past
//       100% is ranked last but remains eligible, and pools already carrying
//       in-flight work yield to quieter pools of similar pace — so a burst of
//       parallel actions spreads instead of stacking on the most-behind pool.
//       A measured pacing rate charges each timed in-flight record at
//       rate × remaining minutes with no artificial floor; a pool with no
//       measured rate uses DEFAULT_INFLIGHT_PENALTY_PCT as the tie-breaker.
//       With no forecast fields attached, every rule above behaves exactly as
//       it did before: an unmeasured pool is never penalized for a number
//       nobody produced.
//   R9. Load beats incumbency: an incumbent carrying more in-flight agents
//       than a challenger keeps neither its margin nor its cost guard; the
//       quieter pool wins as soon as its effective surplus is higher. Effective
//       surplus subtracts the measured remaining-work charge when a rate is
//       known, and the flat per-agent tie-breaker only when it is not.
//  R10. The near-limit line remains clock-relative for the soft penalty. A
//       forecast at/above FIVE_HOUR_NEAR_LIMIT_PCT and above the percentage of
//       the 5h window already elapsed is the last-mile case; a near-limit
//       forecast under its clock is spending at its own pace and keeps its
//       ordinary ordering. (Observed
//       2026-09-10T22:19Z: claude-code:acme, 81% used with 23 minutes left —
//       92.3% of its window elapsed — was the last-mile handoff case at 88.1%,
//       so a high-tier integrator could still use the account while its retry
//       handoff covered the wall. Spend that lands after the reset
//       belongs to the NEXT window: the candidate's minutes and each in-flight
//       record's remaining minutes are clipped at resets_at before they are
//       charged to the 5h forecast — the weekly/monthly pacing penalty is
//       never clipped, that spend does count against its window. No
//       resets_at, an unparsable one, or a reset already in the past means no
//       clock: the fixed line applies without a soft clock exemption, because
//       a pool is never treated differently for a number nobody produced (R8).
//  R11. Quota that expires sooner is worth more ("expiring soon"). A pace
//       surplus is a difference in points and says nothing about how long the
//       pool has left to spend it. (Observed 2026-09-11T04:26Z: grok held
//       +13.8 weekly points with 2h02m left in its week — 1.2% of the window —
//       while claude-code:acme held +22.9 with 13h33m left (8.1%). R2 sent the
//       run to acme on 22.9 > 13.8, and grok's 15 points expired two hours
//       later; the owner had been pinning grok by hand.) So a pool whose
//       PACING window resets within a fixed lead time — EXPIRING_SOON_MS: 24
//       hours weekly, 3 days monthly, the owner's chosen values, about a
//       seventh of a week and a tenth of a month — is ranked on
//       urgency = effective surplus / the fraction of its window still to run
//       (floored at MIN_WINDOW_LEFT_FRACTION so a reset seconds away cannot
//       divide by zero) instead of on the surplus alone. Three states:
//         urgent   — surplus still to spend and a pacing forecast (the
//                    reading, plus in-flight work and this candidate, each
//                    clipped at the pacing reset exactly as R10 clips the 5h
//                    window) below PACING_FORECAST_BLOCK_PCT; with no measured
//                    rate the reading must also sit 5 points under that line,
//                    because an unmeasured pool's forecast is only its
//                    reading. Ranks ahead of every pool not expiring soon.
//         draining — forecast at/above the line AND above the share of the
//                    pacing window already elapsed (clock-relative, exactly
//                    as R10 makes the 5h line): ranked after every normal
//                    pool and chosen only when nothing else is eligible, so a
//                    pool about to be emptied is not fed one more run that
//                    would push it over the wall. A pool whose forecast sits
//                    at/above the line but still under its clock is spending
//                    at its own pace and about to be handed a fresh window,
//                    so it is not draining. (Observed 2026-09-16: command-code,
//                    94.9% used with 98% of the month elapsed — +3.1 on pace,
//                    15h to its reset — was ranked draining by the fixed line
//                    and the 5% it had left was going to expire unspent.)
//         normal   — expiring soon but on or ahead of pace: ranked with
//                    everyone else on effective surplus, exactly as today.
//       Urgency outranks incumbency (R3/R4/R9) and a configured effort
//       assignment (preferredPool) by the same mechanism R7's tier uses —
//       selection happens among the urgent pools while one exists — so an
//       urgent challenger needs neither the 10-point margin nor the cost
//       guard. It never overrides a strict pin (workflow strictPool filters
//       the pool list before pickPool ever sees it), and never the 5h rules:
//       a pool's 5h wall is not rescued by urgency; the near-limit and
//       forecast-over-wall states remain eligible and are ordered accordingly.
//       No pacing window, no parsable paceResetsAt, a reset already
//       in the past, or any window other than weekly/monthly means there is
//       no lead time to measure and nothing about the pool changes (R8).
//  R12. A healthy free model forms a tier ahead of metered pools while it is
//       available; metered pools keep their R1-R11 ordering. A soft-benched
//       pool is out until its re-probe deadline, and the bench never overrides
//       quarantine, exhaustion, the 5h wall or last-mile ordering. Evidence steps do
//       normal routing (and prefer a pool that did not write the evidence) so
//       a free model cannot judge its own work unless it is the only option.
//  R13. Expiring quota outranks verifier independence, and independence is
//       judged by model family, not by pool account: claude-code and
//       claude-code:acme are one writer (modelFamilyOf — the provider id, the
//       pool name up to its first colon). On an evidence step an urgent (R11)
//       independent pool wins first; with none, an urgent pool whose family
//       wrote the judged work takes the step rather than let its quota expire,
//       and the reason opens `independence waived: <pool> resets in <clock>`.
//       With nothing urgent, independence stays the tie-breaker it was under
//       R12. (Observed on run is9aaa: grok took an evidence step over an urgent
//       claude-code:acme that had written the work.)
//       R12's evidence handling and R13 apply only to runs without
//       `reviewPlacement: "caller"`: a stage-3 run passes `writerPools: []`, so
//       a check keeps "no free-first" and gets independence only through its
//       own `route` (a hard filter applied before this router sees the pools).

import { FIVE_HOUR_NEAR_LIMIT_PCT, BURST_BLOCK_PCT, WINDOW_MS } from '../meters/framework.js';
// One strict numeric coercion for the whole codebase (src/lib/num.js): a
// missing measurement stays null instead of becoming a confident zero.
import { finiteOrNull as num } from './num.js';
import { isFreeModel } from './usage.js';

export const LANES = ['analyze', 'build', 'chore'];

export const INCUMBENCY_MARGIN = 10; // surplus points a challenger must beat

/**
 * Surplus points charged per in-flight agent when no spend rate is known for
 * the pool's pacing window (or, failing that, its weekly one). It is a
 * tie-breaker, not a measurement: three points is
 * under a third of INCUMBENCY_MARGIN, so it separates pools of similar pace
 * without ever overturning a real quota difference. It applies only when the
 * pacing rate is unmeasured (and as the fallback for an untimed record); callers
 * override it with opts.inflightPenaltyPct.
 */
export const DEFAULT_INFLIGHT_PENALTY_PCT = 3;

/**
 * R11 lead times: how close a pacing window's reset has to be before the pool
 * counts as "expiring soon". The owner's chosen values — roughly a seventh of
 * a week and a tenth of a month — long enough that a run dispatched now can
 * still use the quota, short enough that the pool really is about to lose it.
 * Any window that is not one of these keys is never expiring soon.
 */
export const EXPIRING_SOON_MS = {
  weekly: 24 * 3600_000,
  monthly: 72 * 3600_000,
};

/**
 * Pacing-window forecast at/above which an expiring-soon pool is `draining`
 * rather than `urgent`: its window is about to close AND about to be emptied,
 * so one more run spends the run's next attempt on a quota failure. The line
 * is clock-relative (R11, as R10 makes the 5h line): a forecast at/above it
 * counts as draining only while it is also above the window's elapsed share,
 * so a pool on or behind pace keeps spending right up to its reset.
 */
export const PACING_FORECAST_BLOCK_PCT = 95;

/**
 * Smallest window-left fraction urgency will divide by (0.5% of the window).
 * A reset thirty seconds away is 0.005% of a week: without a floor the score
 * would be Infinity-shaped and one pool would swallow every lane.
 */
export const MIN_WINDOW_LEFT_FRACTION = 0.005;

/**
 * Points of headroom an UNMEASURED expiring-soon pool needs below
 * PACING_FORECAST_BLOCK_PCT to be called urgent. With no spend rate its
 * forecast is only its reading plus a flat penalty, so the last few points
 * before the line are exactly where that estimate is least trustworthy.
 */
export const UNMEASURED_URGENT_HEADROOM_PCT = 5;

export function elapsedPct(meter, now = Date.now()) {
  if (!meter || meter.type === 'none') return 0;
  const start = meter.windowStart ?? 0;
  const ms =
    meter.type === '5h' ? 5 * 3600_000 :
    meter.type === 'weekly' ? 7 * 24 * 3600_000 :
    0;
  if (!ms || !start) return 0;
  return Math.min(100, ((now - start) / ms) * 100);
}

export const DEFAULT_COST_RANK = 5;

/** Coerce costRank safely: missing/NaN/non-number → DEFAULT_COST_RANK. */
export function costOf(pool) {
  const c = Number(pool?.costRank);
  return Number.isFinite(c) ? c : DEFAULT_COST_RANK;
}

/**
 * Surplus = elapsed% − used%; higher = more quota about to expire.
 *
 * Shape tolerance (production bug fix): buildPools produces FLAT fields
 * (pool.pace / pool.usedPct), while tests and legacy callers build
 * pool.meter. Accept both. Never return NaN — a non-finite score would
 * break the sort comparator's totality and make picks order-dependent.
 */
export function paceScore(pool, now = Date.now()) {
  if (Number.isFinite(pool?.pace)) return pool.pace;
  const meter = pool?.meter;
  if (!meter || meter.type === 'none' || meter.usedPct == null) return 0;
  const s = elapsedPct(meter, now) - Number(meter.usedPct);
  return Number.isFinite(s) ? s : 0;
}

export function isQuarantined(pool, now = Date.now()) {
  if (!pool.quarantine) return false;
  if (pool.quarantine.until == null) return true;
  return now < pool.quarantine.until;
}

/** Whether the model selected for this pool/tier is declared free. */
export function isFree(pool) {
  if (pool?.free === true) return true;
  // Dispatchers that predate the pool-view projection still carry the resolved
  // model policy. Infer the same connector-owned declaration as a compatibility
  // path so free-first does not silently disappear between config and routing.
  const connector = pool?.connector ?? pool;
  const model = pool?.modelPolicy?.model ?? pool?.freeModel ?? connector?.model ?? null;
  return isFreeModel(connector, model);
}

/**
 * R13: the model family a pool (or bare pool name) writes with — its provider
 * id, which is the pool name up to the first colon (`claude-code:acme` is
 * `claude-code`), or null when nothing names it. A provider that fronts
 * several vendors' models is one family here: routing is not told which model
 * wrote the judged work.
 */
export function modelFamilyOf(pool) {
  const raw = (typeof pool === 'string' ? [pool] : [
    pool?.connector?.profile?.providerId, pool?.provider, pool?.name, pool?.connector?.name,
  ]).find((value) => typeof value === 'string' && value.trim());
  return raw ? raw.trim().split(':', 1)[0].toLowerCase() : null;
}

/**
 * A soft bench is active only while it has a concrete future deadline.
 * `until: null` records a first strike without taking the pool out of service;
 * this is deliberately different from quarantine, where null means forever.
 */
export function isBenched(pool, now = Date.now()) {
  const until = pool?.bench?.until;
  return until != null && Number.isFinite(Number(until)) && now < Number(until);
}

/** Round to one decimal for human-readable routing reasons. */
function tenth(value) {
  return Math.round(Number(value) * 10) / 10;
}

/** The 5h window, in minutes — 300. */
export const FIVE_HOUR_WINDOW_MINUTES = WINDOW_MS['5h'] / 60_000;

/**
 * Minutes left before this pool's 5h window resets, from the provider's
 * `fiveHourResetsAt` (src/lib/config.js, straight off the meter reading).
 *
 * null when there is no reading, when it cannot be parsed, or when the reset
 * is already at/behind `now` — an outrun deadline is unknown, not a
 * zero-length window (R8/R10).
 */
export function minutesUntilFiveHourReset(pool, now = Date.now()) {
  const resetsAtMs = Date.parse(pool?.fiveHourResetsAt ?? '');
  if (!Number.isFinite(resetsAtMs)) return null;
  const minutes = (resetsAtMs - now) / 60_000;
  return minutes > 0 ? minutes : null;
}

/**
 * How much of the 5h window has already elapsed, 0–100, or null when the
 * reset time is unknown (R10). elapsed = 100 × (300 − minutes left) / 300.
 */
export function fiveHourElapsedPct(pool, now = Date.now()) {
  const left = minutesUntilFiveHourReset(pool, now);
  if (left == null) return null;
  const elapsed = (100 * (FIVE_HOUR_WINDOW_MINUTES - left)) / FIVE_HOUR_WINDOW_MINUTES;
  return Math.max(0, Math.min(100, elapsed));
}

/**
 * In-flight minutes that fall PAST the 5h reset, summed over the records the
 * producer already charged to this window (R10). Only these minutes are
 * credited back from the projection — the rest of the record still spends
 * inside the window being forecast.
 */
function inflightOverflowMinutes(pool, minutesToReset) {
  const records = Array.isArray(pool?.inflight?.records) ? pool.inflight.records : [];
  let overflow = 0;
  for (const record of records) {
    const m = num(record?.remainingMinutes);
    if (m == null) continue;
    overflow += Math.max(0, Math.max(0, m) - minutesToReset);
  }
  return overflow;
}

/**
 * 5h forecast for one pool and the assignment being routed (R8 rule a):
 *
 *   forecast = (projectedFiveHourPct ?? fiveHourUsedPct)
 *              − ratePerMinute × in-flight minutes past the reset
 *              + ratePerMinute × min(candidateMinutes, minutes to the reset)
 *
 * with the candidate term added only when both of its numbers exist; anything
 * else falls back to the best available reading, and a pool with no reading
 * at all forecasts null (unknown — never gated, never deprioritized).
 *
 * R10 clipping: quota spent after `fiveHourResetsAt` lands in the NEXT 5h
 * window and cannot overflow this one, so the candidate's minutes are clipped
 * at the reset, and the in-flight minutes the producer charged past the reset
 * are credited back out of its projection (never below the pool's own
 * reading). This clip is the 5h forecast's alone — the pacing-window charge in
 * inflightLoad() is deliberately left unclipped, because that spend does count
 * against the weekly/monthly window whichever side of the 5h reset it lands
 * on. With no parsable reset time nothing is clipped at all.
 *
 * `forecasted` records whether the number is more than the raw reading. Only a
 * real projection input (a producer-supplied projectedFiveHourPct, or a rate ×
 * candidateMinutes term) turns a reading into a forecast; a bare reading keeps
 * exactly its old meaning so nothing changes for callers that attach no model.
 *
 * `nearLimit` is the raw R7 test (forecast >= FIVE_HOUR_NEAR_LIMIT_PCT);
 * `underClock` records R10's clock-relative exemption from the soft penalty —
 * near the limit, but no further into the window's quota than into the
 * window's time. A forecast over 100% is still dispatchable and is reported as
 * `overLimit` for the last-place ordering and handoff explanation.
 *
 * @param {object} pool
 * @param {number|null} [candidateMinutes] expected minutes of this assignment
 * @param {number} [now]
 * @returns {{raw: number|null, projected: number|null,
 *            ratePerMinute: number|null, candidateAdd: number|null,
 *            forecast: number|null, forecasted: boolean,
 *            minutesToReset: number|null, elapsedPct: number|null,
 *            inflightCreditPct: number, nearLimit: boolean,
 *            underClock: boolean, overLimit: boolean}}
 */
export function fiveHourForecast(pool, candidateMinutes = null, now = Date.now()) {
  const raw = num(pool?.fiveHourUsedPct);
  const projected = num(pool?.projectedFiveHourPct);
  const ratePerMinute = num(pool?.spend?.fiveHour?.ratePerMinute);
  const minutes = num(candidateMinutes);
  const minutesToReset = minutesUntilFiveHourReset(pool, now);
  const clip = (m) => (minutesToReset == null ? m : Math.min(m, minutesToReset));
  const candidateAdd =
    ratePerMinute != null && minutes != null ? ratePerMinute * clip(minutes) : null;
  // Credit back only what the producer charged past the reset; a zero credit
  // leaves the projection byte-for-byte what it was before R10.
  const overflowMinutes =
    minutesToReset == null || ratePerMinute == null
      ? 0
      : inflightOverflowMinutes(pool, minutesToReset);
  const inflightCreditPct = overflowMinutes > 0 ? ratePerMinute * overflowMinutes : 0;
  const base =
    projected == null ? raw
    : inflightCreditPct > 0
      ? Math.max(raw ?? projected - inflightCreditPct, projected - inflightCreditPct)
      : projected;
  const forecast = base == null ? null : base + (candidateAdd ?? 0);
  const elapsedPct = fiveHourElapsedPct(pool, now);
  const nearLimit = forecast != null && forecast >= FIVE_HOUR_NEAR_LIMIT_PCT;
  const overLimit = forecast != null && forecast > BURST_BLOCK_PCT;
  return {
    raw,
    projected,
    ratePerMinute,
    candidateAdd,
    forecast,
    forecasted: projected != null || candidateAdd != null,
    minutesToReset,
    elapsedPct,
    inflightCreditPct,
    nearLimit,
    overLimit,
    // R10: at/above the line but no further through its quota than through its
    // window — the reset arrives before the wall does.
    underClock: nearLimit && elapsedPct != null && forecast <= elapsedPct,
  };
}

/**
 * Pacing-window cost of the work a pool is already carrying plus the work
 * being routed to it (R8 rule c). The result is subtracted from the pace
 * surplus so that, between pools of similar pace, the quieter one wins.
 *
 * The rate is read from `spend.pacing` — the rate for the window this pool is
 * actually paced by — and falls back to `spend.weekly` when no pacing rate is
 * known (a pool paced monthly with no monthly rate, or a producer that
 * attached only the weekly one). Charging a weekly rate against a monthly
 * surplus would compare points from two different windows.
 *
 * A measured rate is charged directly: rate × each in-flight record's
 * remainingMinutes, plus rate × candidateMinutes for the assignment being
 * routed. There is no floor on that measured projection. An in-flight agent
 * whose remaining minutes nobody recorded still uses `inflightPenaltyPct` as
 * an unknown-duration fallback. When no rate is measured at all, the flat
 * `inflightPenaltyPct` per in-flight agent is the documented tie-breaker.
 *
 * Only `inflight.records[].remainingMinutes` is read: `inflight.minutes` is
 * elapsed worker-minutes (src/lib/assignments.js attachInflight), which says
 * nothing about the quota still to be spent.
 *
 * These minutes are NOT clipped at the 5h reset (R10). This charge is the
 * pacing window's — weekly or monthly — and an agent still running an hour
 * after the 5h window rolls over goes on spending the same weekly quota. Only
 * the 5h forecast in fiveHourForecast() clips at `fiveHourResetsAt`, and it
 * computes that separately from this number.
 *
 * estimateSource: `none` (nothing to charge), `penalty` (the flat fallback
 * charged because no rate was measured, or because an in-flight record had no
 * duration), or the source label of the measured rate (`history` /
 * `bootstrap`, from `spend.pacing` or `spend.weekly`); null when a rate was
 * used but the producer labeled no provenance for it.
 *
 * @returns {{count: number, penalty: number, ratePerMinute: number|null,
 *            estimateSource: string|null}}
 */
export function inflightLoad(pool, opts = {}) {
  const {
    candidateMinutes = null,
    inflightPenaltyPct = DEFAULT_INFLIGHT_PENALTY_PCT,
  } = opts;
  const count = Math.max(0, num(pool?.inflight?.count) ?? 0);
  // The pacing window's rate, or the weekly one when that window has no
  // measured rate — the surplus and the penalty stay on the same window.
  const paced = pacingRateBlock(pool);
  const rate = num(paced?.ratePerMinute);
  const minutes = num(candidateMinutes);
  const penaltyPct = num(inflightPenaltyPct) ?? DEFAULT_INFLIGHT_PENALTY_PCT;
  const sourceLabel =
    typeof paced?.source === 'string' && paced.source ? paced.source : null;

  if (rate == null) {
    return {
      count,
      penalty: count * penaltyPct,
      ratePerMinute: null,
      estimateSource: count > 0 ? 'penalty' : 'none',
    };
  }

  const records = Array.isArray(pool?.inflight?.records) ? pool.inflight.records : [];
  let measured = 0;
  let remaining = 0;
  for (const record of records) {
    const m = num(record?.remainingMinutes);
    if (m == null) continue;
    remaining += Math.max(0, m);
    measured += 1;
  }
  // An in-flight agent nobody could time still costs something: charge it the
  // flat fallback rather than pretending it will finish for free. This is an
  // unknown-duration fallback, not a floor on the measured records.
  const untimed = Math.max(0, count - measured);
  const projected = rate * remaining + rate * (minutes ?? 0) + untimed * penaltyPct;
  // A measured rate is the quota estimate. The flat tie-breaker belongs only
  // to the no-rate branch above; applying it here would demote a measured pool
  // even when its remaining work is worth materially less than the default.
  const penalty = projected;
  const estimateSource =
    penalty === 0 ? 'none'
    : measured === 0 && untimed > 0 && minutes == null ? 'penalty'
    : sourceLabel;
  return { count, penalty, ratePerMinute: rate, estimateSource };
}

/**
 * The spend block whose rate paces this pool: `spend.pacing` when it carries a
 * measured rate, else `spend.weekly`. Charging a weekly rate against a monthly
 * surplus would compare points from two different windows, so this is the only
 * fallback — and it is the one inflightLoad() has always used, shared here so
 * the pacing forecast (R11) charges the same rate the ranking charges.
 */
function pacingRateBlock(pool) {
  return num(pool?.spend?.pacing?.ratePerMinute) != null
    ? pool.spend.pacing
    : pool?.spend?.weekly ?? null;
}

/**
 * Minutes until this pool's PACING window (weekly or monthly) resets, from
 * `pool.paceResetsAt` (src/lib/config.js, straight off the meter reading).
 *
 * null when there is no reading, when it cannot be parsed, or when the reset
 * is already at/behind `now` — an outrun deadline is unknown, not a
 * zero-length window (R8/R11). The 5h twin is minutesUntilFiveHourReset().
 */
export function minutesUntilPacingReset(pool, now = Date.now()) {
  const resetsAtMs = Date.parse(pool?.paceResetsAt ?? '');
  if (!Number.isFinite(resetsAtMs)) return null;
  const minutes = (resetsAtMs - now) / 60_000;
  return minutes > 0 ? minutes : null;
}

/** `5d22h`, `2h02m`, `45m` — how long a window has left, for humans (R11). */
export function formatResetsIn(minutes) {
  const total = Math.max(0, Math.round(num(minutes) ?? 0));
  const days = Math.floor(total / 1440);
  const hours = Math.floor((total % 1440) / 60);
  const mins = total % 60;
  if (days > 0) return `${days}d${hours}h`;
  if (hours > 0) return `${hours}h${String(mins).padStart(2, '0')}m`;
  return `${mins}m`;
}

/**
 * In-flight minutes that fall INSIDE the pacing window still to run — the
 * complement of inflightOverflowMinutes(). Everything after the reset is the
 * next window's problem (R11, mirroring R10).
 */
function inflightMinutesWithin(pool, minutesToReset) {
  const records = Array.isArray(pool?.inflight?.records) ? pool.inflight.records : [];
  let inside = 0;
  for (const record of records) {
    const m = num(record?.remainingMinutes);
    if (m == null) continue;
    const kept = Math.max(0, m);
    inside += minutesToReset == null ? kept : Math.min(kept, minutesToReset);
  }
  return inside;
}

/**
 * What this pool's PACING window (weekly or monthly) will read once the work
 * it is already carrying and the assignment being routed have landed (R11):
 *
 *   forecast = (projectedPacingPct ?? usedPct)
 *              − ratePerMinute × in-flight minutes past the pacing reset
 *              + ratePerMinute × min(candidateMinutes, minutes to the reset)
 *
 * Spend that lands after the reset belongs to the NEXT window, so both terms
 * are clipped at `paceResetsAt` exactly as fiveHourForecast() clips at the 5h
 * one: the producer's projection (src/lib/spend.js) charges every remaining
 * in-flight minute to this window, and the minutes past the reset are credited
 * back out of it — never below the pool's own reading. When the producer
 * attached no projection the same in-flight minutes are added to the reading
 * instead, which is the identical number by another route.
 *
 * With no measured rate there is nothing to multiply by: the forecast is the
 * reading plus the flat per-agent penalty inflightLoad() already charges, and
 * a pool with no reading at all forecasts null (unknown — R8).
 *
 * @returns {{raw: number|null, projected: number|null,
 *            ratePerMinute: number|null, candidateAdd: number|null,
 *            inflightCreditPct: number, minutesToReset: number|null,
 *            forecast: number|null}}
 */
export function pacingForecast(pool, candidateMinutes = null, now = Date.now(), opts = {}) {
  const { inflightPenaltyPct = DEFAULT_INFLIGHT_PENALTY_PCT } = opts;
  const raw = num(pool?.usedPct);
  const projected = num(pool?.projectedPacingPct);
  const ratePerMinute = num(pacingRateBlock(pool)?.ratePerMinute);
  const minutes = num(candidateMinutes);
  const minutesToReset = minutesUntilPacingReset(pool, now);
  const base = projected ?? raw;
  const empty = {
    raw, projected, ratePerMinute, candidateAdd: null, inflightCreditPct: 0, minutesToReset,
  };
  if (base == null) return { ...empty, forecast: null };
  if (ratePerMinute == null) {
    const count = Math.max(0, num(pool?.inflight?.count) ?? 0);
    const penaltyPct = num(inflightPenaltyPct) ?? DEFAULT_INFLIGHT_PENALTY_PCT;
    return { ...empty, forecast: base + count * penaltyPct };
  }
  const clip = (m) => (minutesToReset == null ? m : Math.min(m, minutesToReset));
  const candidateAdd = minutes == null ? 0 : ratePerMinute * clip(Math.max(0, minutes));
  const overflowMinutes =
    minutesToReset == null ? 0 : inflightOverflowMinutes(pool, minutesToReset);
  const inflightCreditPct = overflowMinutes > 0 ? ratePerMinute * overflowMinutes : 0;
  const carried =
    projected == null
      ? raw + ratePerMinute * inflightMinutesWithin(pool, minutesToReset)
      : inflightCreditPct > 0
        ? Math.max(raw ?? projected - inflightCreditPct, projected - inflightCreditPct)
        : projected;
  return {
    ...empty,
    candidateAdd,
    inflightCreditPct,
    forecast: carried + candidateAdd,
  };
}

/**
 * R11 view of one pool: is its pacing window about to close, how urgent is the
 * quota it still holds, and what will that window read once in-flight work and
 * this candidate land.
 *
 * `effective` is the ranking's own `pace − load.penalty`; pickPool passes the
 * number it already computed, and any other caller (bullswarm pools) lets this
 * recompute it from the pool.
 *
 * `windowLeftFraction` is (100 − elapsedPct) / 100, floored at
 * MIN_WINDOW_LEFT_FRACTION. A pool whose reading carries no elapsedPct has no
 * measured window position, so the fraction is 1 and urgency is just the
 * surplus — never inflated for a number nobody produced (R8).
 *
 * @returns {{expiringSoon: boolean, window: string|null,
 *            minutesToReset: number|null, windowLeftFraction: number|null,
 *            effective: number|null, urgency: number|null,
 *            forecast: number|null, ratePerMinute: number|null,
 *            state: 'urgent'|'normal'|'draining'|null}}
 */
export function expiringSoonView(pool, opts = {}) {
  const {
    now = Date.now(),
    candidateMinutes = null,
    inflightPenaltyPct = DEFAULT_INFLIGHT_PENALTY_PCT,
    effective = null,
  } = opts;
  const window = pool?.pacingWindow ?? null;
  const leadMs = EXPIRING_SOON_MS[window] ?? null;
  const minutesToReset = minutesUntilPacingReset(pool, now);
  const notSoon = {
    expiringSoon: false,
    window,
    minutesToReset,
    windowLeftFraction: null,
    effective: null,
    urgency: null,
    forecast: null,
    ratePerMinute: null,
    state: null,
  };
  if (leadMs == null || minutesToReset == null || minutesToReset * 60_000 > leadMs) {
    return notSoon;
  }

  const eff =
    num(effective)
    ?? paceScore(pool, now) - inflightLoad(pool, { candidateMinutes, inflightPenaltyPct }).penalty;
  const elapsed = num(pool?.elapsedPct);
  const windowLeftFraction = Math.max(
    MIN_WINDOW_LEFT_FRACTION,
    elapsed == null ? 1 : (100 - elapsed) / 100,
  );
  const pacing = pacingForecast(pool, candidateMinutes, now, { inflightPenaltyPct });
  const forecast = pacing.forecast;
  const used = num(pool?.usedPct);
  // An unmeasured pool's forecast is its reading: demand real headroom before
  // handing it the lane ahead of everyone else.
  const trusted =
    pacing.ratePerMinute != null ||
    (used != null && used <= PACING_FORECAST_BLOCK_PCT - UNMEASURED_URGENT_HEADROOM_PCT);
  // Draining is clock-relative: at/above the block line AND ahead of the
  // window's own clock. With no elapsed reading there is no clock, and the
  // fixed line stands (R8).
  const draining =
    forecast != null
    && forecast >= PACING_FORECAST_BLOCK_PCT
    && (elapsed == null || forecast > elapsed);
  const state =
    draining ? 'draining'
    : eff > 0 && forecast != null && trusted ? 'urgent'
    : 'normal';
  return {
    expiringSoon: true,
    window,
    minutesToReset,
    windowLeftFraction,
    effective: eff,
    urgency: eff / windowLeftFraction,
    forecast,
    ratePerMinute: pacing.ratePerMinute,
    state,
  };
}

export function isExhausted(pool, now = Date.now()) {
  // Flat shape (buildPools) first, legacy meter shape second. A stale
  // meterSource reading must not permanently exclude a pool: if the reading
  // is stale-labeled and older than the window could explain, trust the pool
  // may have reset — the next live poll will decide.
  const fiveHourUsed = num(pool?.fiveHourUsedPct)
    ?? (pool?.meter?.type === '5h' ? num(pool.meter.usedPct) : null)
    // Legacy meter snapshots without a dedicated 5h field were only emitted
    // by the old cache path (no pacing window); keep that compatibility shape
    // without treating a weekly/monthly `usedPct` as 5h exhaustion.
    ?? (pool?.meterSource === 'cache' && pool?.pacingWindow == null
      ? num(pool?.usedPct)
      : null);
  if (fiveHourUsed != null && fiveHourUsed >= 100) {
    if (pool.meterSource !== 'stale') return true;
  }

  // A quota failure is a recorded wall even when its meter reading is still
  // below 100%. Accept the durable quarantine shape and the retryAfter shapes
  // used by workflow/action state; auth and generic holds do not count.
  const records = [
    pool?.quarantine,
    pool?.quotaFailure,
    pool?.lastFailure,
    pool?.failure,
  ];
  for (const record of records) {
    if (!record || (record.kind ?? record.failureKind) !== 'quota') continue;
    const retryAfter = record.retryAfter ?? record.retry_after ?? record.until;
    const retryAt = typeof retryAfter === 'number'
      ? retryAfter
      : Date.parse(String(retryAfter ?? ''));
    if (Number.isFinite(retryAt) && retryAt > now) return true;
    const retryAfterMs = num(record.retryAfterMs ?? record.retry_after_ms);
    if (retryAfterMs != null && retryAfterMs > 0) {
      const failedAt = Date.parse(String(record.failedAt ?? record.failed_at ?? ''));
      const until = Number.isFinite(failedAt) ? failedAt + retryAfterMs : now + retryAfterMs;
      if (until > now) return true;
    }
  }
  return false;
}

/**
 * Pick a pool for a lane.
 * @param {string} lane   analyze | build | chore
 * @param {Array}  pools  enabled pools: {name, costRank, lanes[], meter?,
 *                        quarantine?, incumbent?}. Optional forecast fields,
 *                        attached by the caller when it tracks them:
 *                        inflight {count, minutes, records:[{remainingMinutes}]},
 *                        spend {fiveHour:{ratePerMinute, source},
 *                        weekly:{...}, monthly:{...},
 *                        pacing:{window, ratePerMinute, source}},
 *                        pacingWindow, projectedFiveHourPct,
 *                        projectedWeeklyPct, projectedPacingPct.
 * @param {object} [opts] { callerEligible=true, callerName='claude', now,
 *                        requiredCapabilities, preferredPool, effortTier,
 *                        strictPool (the --worker-pool pin the caller already
 *                        filtered `pools` down to; naming it here is what lets
 *                        the reason say the pick was pinned rather than chosen),
 *                        pinSource='--worker-pool' (who pinned it: `step
 *                        restart` or `the same pool (gate retry)` too),
 *                        routeNote=null (the step's route summary, appended to
 *                        every reason as ` · route: <summary>`; no ranking change),
 *                        evidence: { writerPools: string[] },
 *                        callerSession, candidateMinutes=null (expected minutes
 *                        of the assignment being routed),
 *                        inflightPenaltyPct=DEFAULT_INFLIGHT_PENALTY_PCT
 *                        (unmeasured-pool fallback) }
 * @returns {{pick: object|null, keepOnClaude: boolean, why: string,
 *            candidates: Array,
 *            forecast: {candidateMinutes: number|null, gated: string[]}}}
 */
export function pickPool(lane, pools, opts = {}) {
  const {
    callerEligible = true,
    callerName = 'claude-code',
    now = Date.now(),
    requiredCapabilities = [],
    preferredPool = null,
    strictPool = null,
    candidateMinutes = null,
    inflightPenaltyPct = DEFAULT_INFLIGHT_PENALTY_PCT,
    evidence = null,
    pinSource = '--worker-pool',
    routeNote = null,
  } = opts;
  // D30: the step's route is named on every reason, and never ranks.
  const noted = (why) => (routeNote ? `${why} · route: ${routeNote}` : why);

  const candidateMins = num(candidateMinutes);
  // R13: a writer is a model family, not a pool account — the work
  // claude-code wrote is not independently judged by claude-code:acme.
  const writerFamilies = new Set(
    (Array.isArray(evidence?.writerPools) ? evidence.writerPools : [])
      .map((name) => modelFamilyOf(pools.find((p) => p?.name === name) ?? name))
      .filter(Boolean),
  );

  if (!LANES.includes(lane)) {
    return {
      pick: null,
      keepOnClaude: false,
      why: noted(`unknown lane ${lane}`),
      candidates: [],
      forecast: { candidateMinutes: candidateMins, gated: [] },
    };
  }

  // Eligibility in two stages, so an empty candidate list can say WHICH stage
  // emptied it (D7). A pool the model policy rejected is not a pool that lacks
  // a capability, and reporting the wrong one sends an operator to fix a
  // connector when the fix is `strategy set-rung`.
  const laneCapableBeforeBench = pools.filter(
    (p) =>
      p.enabled !== false &&
      (p.lanes ?? LANES).includes(lane) &&
      requiredCapabilities.every((capability) =>
        (p.capabilities ?? p.connector?.capabilities ?? []).includes(capability)) &&
      !isQuarantined(p, now) &&
      !isExhausted(p, now),
  );
  const benchedOut = laneCapableBeforeBench.filter((p) => isBenched(p, now));
  const laneCapable = laneCapableBeforeBench.filter((p) => !isBenched(p, now));
  // resolveDispatchModel() marks a pool ineligible when the persisted routing
  // policy cannot name a model for this tier — most often an effort tier whose
  // allow-list selects models on other pools only. Filtering here (instead of
  // in each caller) keeps that reason reachable; pools with no modelPolicy
  // attached at all are unaffected.
  const modelBlocked = laneCapable.filter((p) => p.modelPolicy?.eligible === false);
  const eligible = laneCapable.filter((p) => p.modelPolicy?.eligible !== false);

  const scored = eligible.map((p) => {
    const forecast = fiveHourForecast(p, candidateMins, now);
    const load = inflightLoad(p, { candidateMinutes: candidateMins, inflightPenaltyPct });
    const pace = paceScore(p, now);
    // R8c: pace minus the quota this pool's in-flight work and this
    // assignment are expected to spend. Equals pace when nothing is in
    // flight and no rate applies.
    const effective = pace - load.penalty;
    // R11: the same surplus, divided by how much of the pacing window is left
    // to spend it in. All-null for a pool whose window is not about to close.
    const expiring = expiringSoonView(p, {
      now, candidateMinutes: candidateMins, inflightPenaltyPct, effective,
    });
    return {
      pool: p,
      pace,
      effective,
      load,
      forecast,
      expiring,
      // urgent first, draining last, everything else in the middle — the tier
      // R11 adds below the soft 5h ordering key and above the pace comparison.
      urgencyRank: expiring.state === 'urgent' ? 0 : expiring.state === 'draining' ? 2 : 1,
      // R12: a free model gets its own tier, after the last-mile ordering key.
      freeRank: isFree(p) ? 0 : 1,
      // Evidence prefers a pool whose model family did not write the work it
      // is judging (R13).
      writerRank: writerFamilies.has(modelFamilyOf(p)) ? 1 : 0,
      // R7/R10: near-limit status is a soft ordering penalty only when some
      // other eligible pool is behind pace. The comparison is filled after all
      // entries exist so "another" really means another candidate.
      nearPenalty: false,
      // R8b: a forecast past the 100% wall remains eligible, but is sorted
      // behind every pool whose forecast stays within the window.
      overLimit: forecast.forecasted && forecast.forecast != null && forecast.forecast > BURST_BLOCK_PCT,
    };
  });

  // A near-limit pool gives way only when another eligible pool is also behind
  // pace. This is deliberately a score key, not an eligibility filter: a
  // configured assignment, incumbent, urgency tier, or the only remaining
  // pool can still select it, and the reason then records the last-mile handoff.
  for (const entry of scored) {
    entry.nearPenalty = entry.forecast.nearLimit
      && !entry.forecast.underClock
      && scored.some((other) => other !== entry && other.pace > 0);
    entry.tier = entry.nearPenalty ? 1 : 0;
  }

  // R13: on an evidence step expiring quota outranks verifier independence —
  // urgent independent pools, then urgent writers, then the rest with
  // independence as today's tie-breaker. Every pool is 0 on other steps.
  const evidenceTier = (e) => (evidence ? (e.urgencyRank === 0 ? 0 : 2) + e.writerRank : 0);

  // R8 before R7 before R13/R12/R11 before R2: forecasts past the wall sort
  // last, then the soft near-limit penalty, then evidence/free tiers, then
  // urgent < normal < draining, then the group's own score. The candidate
  // list is reported in this exact preference order.
  scored.sort(
    (a, b) =>
      (a.overLimit ? 1 : 0) - (b.overLimit ? 1 : 0) ||
      a.tier - b.tier ||
      evidenceTier(a) - evidenceTier(b) ||
      (evidence ? 1 : a.freeRank) - (evidence ? 1 : b.freeRank) ||
      a.urgencyRank - b.urgencyRank ||
      (a.urgencyRank === 0
        ? b.expiring.urgency - a.expiring.urgency
        : b.effective - a.effective),
  );

  const candidates = scored.map((e) => ({
    pool: e.pool.name,
    model: e.pool.modelPolicy?.model ?? null,
    modelPolicy: e.pool.modelPolicy?.source ?? null,
    pace: tenth(e.pace),
    effectiveSurplus: tenth(e.effective),
    inflight: e.load.count,
    costRank: e.pool.costRank ?? null,
    fiveHourUsedPct: e.forecast.raw,
    projectedFiveHourPct: e.forecast.projected,
    forecastFiveHourPct: e.forecast.forecast == null ? null : tenth(e.forecast.forecast),
    // R10: how far into the 5h window this reading sits; null when the
    // provider reported no reset time, in which case the fixed line applies.
    fiveHourElapsedPct: e.forecast.elapsedPct == null ? null : tenth(e.forecast.elapsedPct),
    projectedWeeklyPct: num(e.pool.projectedWeeklyPct),
    // The window this pool is paced by, and the projection in it. Equal to
    // the weekly pair for every pool that declares no monthly quota window.
    pacingWindow: e.pool.pacingWindow ?? null,
    projectedPacingPct: num(e.pool.projectedPacingPct),
    ratePerMinute: e.forecast.ratePerMinute,
    estimateSource: e.load.estimateSource,
    nearFiveHourLimit: e.forecast.nearLimit,
    nearFiveHourPenalty: e.nearPenalty,
    // Kept for consumers that already render the candidate shape. A forecast
    // past the wall is no longer gated; it is merely ranked last.
    forecastGated: false,
    forecastOverLimit: e.overLimit,
    // R11: when the pacing window resets, whether that is close enough to
    // count, and the urgency/forecast that decided the pool's standing. Every
    // field but the first is null for a pool whose window is not about to
    // close — nothing changes for a number nobody produced (R8).
    paceResetsInMinutes:
      e.expiring.minutesToReset == null ? null : tenth(e.expiring.minutesToReset),
    expiringSoon: e.expiring.expiringSoon,
    urgency: e.expiring.urgency == null ? null : tenth(e.expiring.urgency),
    forecastPacingPct: e.expiring.forecast == null ? null : tenth(e.expiring.forecast),
    urgencyState: e.expiring.state,
    free: isFree(e.pool),
    freeModel: e.pool.freeModel ?? null,
    // A benched pool is filtered before scoring; this explicit false keeps the
    // candidate shape stable for callers that render routing explanations.
    benched: false,
  }));
  const forecastReport = {
    candidateMinutes: candidateMins,
    // No forecast is a hard gate anymore. The candidate rows carry
    // `forecastOverLimit`, and the reason names those rows explicitly.
    gated: [],
  };

  if (scored.length === 0) {
    // D7: name the stage that emptied the list. A tier allow-list that matched
    // no model on any pool outranks the capability wording, which would other-
    // wise blame connectors that declare every capability the lane asked for.
    const blocked = modelPolicyReason(modelBlocked, opts.effortTier);
    const withCapabilities = requiredCapabilities.length
      ? ` with capabilities: ${requiredCapabilities.join(', ')}`
      : '';
    const emptyDelegateWhy = blocked ?? `no eligible delegate pool${withCapabilities}`;
    const emptyPoolWhy = blocked ?? `no eligible pool${withCapabilities}`;
    const benchWhy = formatBenched(benchedOut);
    return callerEligible
      ? {
          pick: null,
          keepOnClaude: true,
          why: noted(`${emptyDelegateWhy}; caller takes the lane${benchWhy ? ` · ${benchWhy}` : ''}`),
          candidates,
          forecast: forecastReport,
        }
      : {
          pick: null,
          keepOnClaude: false,
          why: noted(`${emptyPoolWhy}${benchWhy ? ` · ${benchWhy}` : ''}`),
          candidates,
          forecast: forecastReport,
        };
  }

  // Forecasts past the wall remain eligible but are the last ordering rung: use
  // every within-wall candidate while one exists, and fall back to the
  // over-limit set only when the whole eligible set is beyond the wall. This
  // is a ranking boundary, not an exhaustion filter, so the handoff can still
  // retry a run that reaches the provider's wall.
  const withinWall = scored.filter((e) => !e.overLimit);
  const open = withinWall.length ? withinWall : scored;
  const overLimitEntries = scored.filter((e) => e.overLimit);

  let winnerEntry;
  let skippedDraining = [];
  let skippedFree = [];
  let evidenceOnlyWriter = false;
  {
    // R7: every non-exhausted pool remains eligible; near-limit status is only
    // a score key, not the old headroom allow-list. The wall boundary above
    // keeps a within-wall option ahead of an over-limit forecast.
    const headroomSet = open;

    // R12 evidence and free tiers sit above the ordinary R11 selection. An
    // evidence step disables free-first and prefers non-writers whenever one
    // remains eligible; a writer is selected only when every eligible pool is
    // one of its writers.
    const nonWriter = headroomSet.filter((e) => e.writerRank === 0);
    const evidenceBase = nonWriter.length ? nonWriter : headroomSet;
    const freeSet = evidence ? [] : headroomSet.filter((e) => e.freeRank === 0);
    skippedFree = freeSet.length
      ? evidenceBase.filter((e) => e.freeRank !== 0)
      : [];

    // R11, by the same mechanism and one rung below it: while any pool's
    // quota is about to expire with room to spend it, that pool is the only
    // selectable one — which is what puts urgency ahead of incumbency and of
    // a configured effort assignment, both of which are resolved inside
    // `selectable` below. A draining pool is the mirror image: out of
    // selection until nothing else is left.
    // R13: urgency is read across writers too. An urgent independent pool
    // still wins; with none, an urgent writer takes the evidence step rather
    // than let its quota expire, and the reason says independence was waived.
    const urgentAll = headroomSet.filter((e) => e.urgencyRank === 0);
    const urgentIndependent = urgentAll.filter((e) => e.writerRank === 0);
    const urgentSet = urgentIndependent.length ? urgentIndependent : urgentAll;
    const notDraining = evidenceBase.filter((e) => e.urgencyRank !== 2);
    const selectable =
      freeSet.length ? freeSet
      : urgentSet.length ? urgentSet
      : notDraining.length ? notDraining : evidenceBase;
    skippedDraining = notDraining.length ? evidenceBase.filter((e) => e.urgencyRank === 2) : [];

    const preferredEntry = preferredPool
      ? selectable.find((entry) => entry.pool.name === preferredPool)
      : null;
    const incumbentEntry = selectable.find((e) => e.pool.incumbent === true);

    if (preferredEntry) {
      // A user-applied effort-tier assignment is an explicit choice, but it
      // never bypasses eligibility, quarantine, exhaustion, or the wall.
      winnerEntry = preferredEntry;
    } else if (incumbentEntry) {
      // R3+R4: challenger needs margin. The cost guard protects the incumbent
      // ONLY while it is a reasonable steward of its quota: a distressed
      // incumbent (deep negative surplus) forfeits cost protection, and
      // equal-cost challengers may displace (strict < caused permanent
      // lock-in between same-rank pools). R8c: the comparison is on effective
      // surplus, so an incumbent already loaded with in-flight work is easier
      // to displace than an idle one at the same reading.
      const INCUMBENT_DISTRESS = -20;
      const incumbentDistressed =
        incumbentEntry.effective <= INCUMBENT_DISTRESS || isExhausted(incumbentEntry.pool, now);
      // R9: incumbency guards against flapping on noisy pace numbers, not
      // against real concurrent load. Against a challenger carrying fewer
      // in-flight agents, a loaded incumbent keeps neither its margin nor its
      // cost protection — the quieter pool wins as soon as its effective
      // surplus is higher. (Observed 2026-09-09: an incumbent at surplus 26.7
      // with three agents in flight kept the lane against an idle pool at 23.6
      // because the challenger lacked the 10-point margin.)
      const challenger = selectable.find((e) => {
        if (e === incumbentEntry) return false;
        if (incumbentEntry.load.count > e.load.count) return e.effective > incumbentEntry.effective;
        return e.effective >= incumbentEntry.effective + INCUMBENCY_MARGIN &&
          (incumbentDistressed || costOf(e.pool) <= costOf(incumbentEntry.pool));
      });
      winnerEntry = challenger ?? incumbentEntry;
    } else {
      winnerEntry = selectable[0];
    }
  }
  const writerWon = Boolean(evidence) && winnerEntry?.writerRank === 1;
  // R13: a writer beat an eligible independent pool only because its quota
  // is about to expire; otherwise it won because nothing else was eligible.
  const independenceWaived = writerWon
    && winnerEntry.urgencyRank === 0
    && open.some((e) => e.writerRank === 0);
  evidenceOnlyWriter = writerWon && !independenceWaived;
  // R12 visibility: the pools that produced the work this evidence step is
  // judging and were therefore ranked below the winner. Without them the
  // reason said only "normal routing", which hid why an urgent writer lost
  // (seen on run is9aaa: grok picked over an urgent claude-code:acme).
  const deprioritizedWriters = evidence && !writerWon
    ? scored.filter((e) => e !== winnerEntry && e.writerRank === 1)
    : [];
  // R13 visibility: the independent pools an urgent writer was preferred to.
  const passedIndependent = independenceWaived
    ? scored.filter((e) => e.writerRank === 0)
    : [];
  // R8c visibility: pools that would have won on raw pace and lost only
  // because of the work they are already carrying. Empty unless a caller
  // attached in-flight counts, so today's reasons are unchanged.
  const yieldedBusier = scored.filter(
    (e) =>
      e !== winnerEntry &&
      !e.overLimit &&
      e.tier === winnerEntry.tier &&
      e.load.count > 0 &&
      e.pace >= winnerEntry.pace &&
      e.effective < winnerEntry.effective,
  );
  const why = noted(routingReason(winnerEntry, {
    preferred: Boolean(preferredPool) && winnerEntry.pool.name === preferredPool,
    effortTier: opts.effortTier,
    pinned: Boolean(strictPool) && winnerEntry.pool.name === strictPool,
    pinSource,
    evidence,
    evidenceOnlyWriter,
    independenceWaived,
    passedIndependent,
    deprioritizedWriters,
    skippedFree,
    benchedOut,
    skippedDraining,
    overLimit: overLimitEntries,
    yieldedBusier,
  }));

  // R5: the caller wins its lane only when no eligible delegate remains —
  // or when the caller's own pool entry genuinely wins on merit. Dispatching
  // the caller to itself as a subprocess is always wrong — BUT only when a
  // caller session actually exists. In workflow/batch contexts every pool is
  // just a worker; opts.callerSession (default: callerEligible) controls it.
  const hasCallerSession = opts.callerSession ?? callerEligible;
  if (!hasCallerSession) {
    return {
      pick: { pool: winnerEntry.pool.name, connector: winnerEntry.pool },
      keepOnClaude: false,
      why,
      candidates,
      forecast: forecastReport,
    };
  }
  const isCaller =
    winnerEntry.pool.isCaller === true ||
    winnerEntry.pool.connector?.flags?.isCaller === true ||
    (callerName && winnerEntry.pool.name === callerName);
  if (isCaller) {
    return {
      pick: null,
      keepOnClaude: true,
      why: noted('caller pool won the lane; keep work in-session'),
      candidates,
      forecast: forecastReport,
    };
  }

  return {
    pick: { pool: winnerEntry.pool.name, connector: winnerEntry.pool },
    keepOnClaude: false,
    why,
    candidates,
    forecast: forecastReport,
  };
}

/**
 * Why the candidate list is empty when every lane-capable pool was rejected by
 * the persisted model policy, or null when the model policy is not the cause.
 *
 * `modelPolicy.source` comes from resolveDispatchModel() in src/lib/strategy.js;
 * `tier-selection-empty` means the effort tier's allow-list named no model this
 * pool can run, which is a rung problem, not a capability problem. Any other
 * ineligible source (a connector that cannot pin an allowed model, active
 * exclusions) keeps its own reason text.
 */
function modelPolicyReason(blocked, effortTier) {
  if (!blocked.length) return null;
  const tier = effortTier ?? 'effort';
  if (blocked.every((p) => p.modelPolicy?.source === 'tier-selection-empty')) {
    return `no pool has a model allowed for the ${tier} tier`;
  }
  const reasons = [...new Set(blocked.map((p) => p.modelPolicy?.reason).filter(Boolean))];
  return `no pool has an allowed ${tier} model under the current model policy${
    reasons.length ? ` (${reasons.join('; ')})` : ''
  }`;
}

function formatBenched(benchedOut) {
  return (benchedOut ?? []).map((p) => {
    const reason = p.bench?.reason ?? 'unknown';
    const until = p.bench?.until;
    const backAt = Number.isFinite(Number(until))
      ? new Date(Number(until)).toISOString()
      : 'unknown';
    return `benched (${reason}, back at ${backAt}): ${p.name}`;
  }).join(' · ');
}

/**
 * Explain the pick: why this pool, at what 5h utilization (reading and, when a
 * forecast exists, the projection), how much work it is already carrying, and
 * which pools it was preferred over — near their 5h limit or forecast over
 * the wall.
 */
function routingReason(
  winnerEntry,
  {
    preferred,
    effortTier,
    pinned = false,
    pinSource = '--worker-pool',
    evidence = null,
    evidenceOnlyWriter = false,
    independenceWaived = false,
    passedIndependent = [],
    deprioritizedWriters = [],
    skippedFree = [],
    benchedOut = [],
    skippedDraining = [],
    overLimit = [],
    yieldedBusier = [],
  },
) {
  const note = fiveHourNote(winnerEntry);
  const inflight = inflightNote(winnerEntry);
  const detail = [`surplus ${tenth(winnerEntry.effective)}`, note, inflight]
    .filter(Boolean)
    .join(', ');
  let base;
  let baseDetail = null;
  if (pinned) {
    // `--worker-pool` already reduced the candidate list to one pool, so no
    // other clause describes a choice that was made. Saying the pin out loud
    // stops the reason from claiming a comparison happened (seen on run
    // uamgfi, attempt accept-1, which read "only the writer pool ... is
    // eligible" when the operator had pinned that pool themselves).
    base = `pinned to ${winnerEntry.pool.name} (${pinSource || '--worker-pool'})`;
    baseDetail = detail || null;
  } else if (independenceWaived) {
    // R13: the pool judging the work shares a model family with its writer,
    // and the only reason is the clock on its quota. Say so first, then the
    // urgency arithmetic and the independent pools it was preferred to.
    base = `independence waived: ${winnerEntry.pool.name} resets in ${
      formatResetsIn(winnerEntry.expiring.minutesToReset)
    }`;
    baseDetail = [
      urgencyArithmetic(winnerEntry, [note, inflight].filter(Boolean).join(', ')),
      passedIndependent.length
        ? `independent but not urgent: ${passedIndependent.map((e) => e.pool.name).join(', ')}`
        : null,
    ].filter(Boolean).join(' · ');
  } else if (evidenceOnlyWriter) {
    base = `evidence step: only the writer pool ${winnerEntry.pool.name} is eligible`;
  } else if (deprioritizedWriters.length) {
    base = `evidence: independent of ${deprioritizedWriters
      .map((e) => e.pool.name)
      .join(', ')} (they produced the judged work)`;
    baseDetail = detail || null;
  } else if (evidence) {
    base = 'evidence step: normal routing (free tier not applied)';
  } else if (winnerEntry.freeRank === 0) {
    const freeModel = winnerEntry.pool.freeModel ?? winnerEntry.pool.modelPolicy?.model ?? null;
    const freeDetail = [
      freeModel ? `free model ${freeModel}` : null,
      note,
      inflight,
    ].filter(Boolean).join(', ');
    base = `free pool first: ${winnerEntry.pool.name}${freeDetail ? ` (${freeDetail})` : ''}`;
  } else if (preferred) {
    base = `configured ${effortTier ?? 'effort'} assignment (${
      [winnerEntry.pool.name, note, inflight].filter(Boolean).join(', ')
    })`;
  } else if (winnerEntry.urgencyRank === 0) {
    // R11: this pool did not win on the size of its surplus but on how little
    // time is left to spend it, so the reason names the clock, the fraction of
    // the window still to run, and the forecast that kept it out of draining.
    base = urgencyClause(winnerEntry, [note, inflight].filter(Boolean).join(', '));
  } else {
    // The note carries the reading/projection; the last-mile clause below
    // explains why a near-limit winner is still safe to hand off.
    const standing =
      !note ? ''
      : winnerEntry.forecast.nearLimit ? ' near its 5h limit'
      : ' with 5h headroom';
    base = `most-behind capable pool${standing} (${detail})`;
  }
  const clauses = [base];
  // Kept as its own clause so the opening text stays exactly the pin or the
  // named-writer reason, which is what readers and tests match on.
  if (baseDetail) clauses.push(baseDetail);
  if (skippedFree.length) {
    clauses.push(
      `metered pools ranked below free: ${skippedFree
        .map((e) => `${e.pool.name} ${tenth(e.effective)}`)
        .join(', ')}`,
    );
  }
  const benchWhy = formatBenched(benchedOut);
  if (benchWhy) clauses.push(benchWhy);
  if (winnerEntry.forecast.nearLimit) {
    const pct = winnerEntry.forecast.forecasted
      ? winnerEntry.forecast.forecast
      : winnerEntry.forecast.raw;
    if (pct != null) {
      clauses.push(
        `last mile: ${winnerEntry.pool.name} ${tenth(pct)}% of 5h, handoff covers the wall`,
      );
    }
  }
  if (overLimit.length) {
    clauses.push(
      `forecast over ${BURST_BLOCK_PCT}% (still eligible; ranked last): ${overLimit
        .map((e) => poolPctLabel(e))
        .join(', ')}`,
    );
  }
  if (skippedDraining.length) {
    // R11: a pool whose window is about to close was passed over anyway,
    // because the run would spend what little it has left through the wall.
    clauses.push(
      `expiring but draining (forecast >= ${PACING_FORECAST_BLOCK_PCT}% and past its clock): ${skippedDraining
        .map((e) => `${e.pool.name} ${pacingPctText(e)}${
          num(e.pool?.elapsedPct) != null ? ` (${num(e.pool.elapsedPct).toFixed(1)}% elapsed)` : ''
        }`)
        .join(', ')}`,
    );
  }
  if (yieldedBusier.length) {
    clauses.push(
      `preferred over busier: ${yieldedBusier
        .map((e) => `${e.pool.name} (${e.load.count} in flight)`)
        .join(', ')}`,
    );
  }
  return clauses.join(' · ');
}

/**
 * R11's reason for an urgent winner:
 * `expiring soon: grok resets in 2h02m, surplus 13.8 over 1.2% of the week
 * left → urgency 1140, forecast 91.0%`. Urgency reads as a whole number: at
 * this scale a tenth of a point is noise, and the candidate row carries the
 * rounded value for anything that needs it.
 */
function urgencyClause(entry, detail) {
  return (
    `expiring soon: ${entry.pool.name} resets in ${formatResetsIn(entry.expiring.minutesToReset)}, `
    + urgencyArithmetic(entry, detail)
  );
}

/** `surplus 7.8 over 1.2% of the week left → urgency 650, forecast 91.0%`. */
function urgencyArithmetic(entry, detail) {
  const { windowLeftFraction, urgency, window } = entry.expiring;
  const word = window === 'monthly' ? 'month' : 'week';
  const left = tenth(windowLeftFraction * 100);
  const tail = detail ? ` (${detail})` : '';
  return (
    `surplus ${tenth(entry.effective)} over ${left}% of the ${word} left `
    + `→ urgency ${Math.round(urgency)}, forecast ${pacingPctText(entry)}${tail}`
  );
}

/** `91.0%` — an expiring-soon pool's pacing forecast, or `?%` with no reading. */
function pacingPctText(entry) {
  const pct = entry.expiring.forecast;
  return pct == null ? '?%' : `${Number(pct).toFixed(1)}%`;
}

/**
 * `<pool> <pct>%` using the forecast when one exists, else the raw reading —
 * and, for a pool at/above the near-limit line, where its 5h window stands
 * (R10): `claude-code:acme 88.1% (92.3% elapsed)`. The clock is what decided
 * the tier, so the number that decided it is named.
 */
function poolPctLabel(entry) {
  const pct = entry.forecast.forecasted ? entry.forecast.forecast : entry.forecast.raw;
  const clock = entry.forecast.nearLimit ? elapsedText(entry.forecast.elapsedPct) : null;
  return `${entry.pool.name}${pct == null ? '' : ` ${tenth(pct)}%`}${clock ? ` (${clock})` : ''}`;
}

/** `92.3% elapsed`, or null when the provider reported no 5h reset time. */
function elapsedText(elapsedPct) {
  return elapsedPct == null ? null : `${Number(elapsedPct).toFixed(1)}% elapsed`;
}

/**
 * `5h used 30%` or, when a forecast adds to it, `5h used 30% -> 41% projected`.
 *
 * A forecast at/above the near-limit line also carries its window's clock —
 * `, under the clock (92.3% elapsed)` when R10 exempts it from the tier,
 * `, 20.0% elapsed` when the clock is what put it there.
 */
function fiveHourNote(entry) {
  const { raw, forecast, forecasted, nearLimit, underClock, elapsedPct } = entry.forecast;
  const clock = nearLimit ? elapsedText(elapsedPct) : null;
  const suffix = clock ? `, ${underClock ? `under the clock (${clock})` : clock}` : '';
  if (raw == null) {
    return forecasted && forecast != null ? `5h projected ${tenth(forecast)}%${suffix}` : null;
  }
  const reading = `5h used ${tenth(raw)}%`;
  if (!forecasted || forecast == null || tenth(forecast) === tenth(raw)) {
    return `${reading}${suffix}`;
  }
  return `${reading} -> ${tenth(forecast)}% projected${suffix}`;
}

/** `2 in flight`, or null when the caller tracks no in-flight work here. */
function inflightNote(entry) {
  return entry.load.count > 0 ? `${entry.load.count} in flight` : null;
}
