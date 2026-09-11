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
//   R6. A pool at 100% used is exhausted; quarantined pools are ineligible
//       until their quarantine expires (the re-probe path).
//   R7. 5h headroom outranks pace: a pool at/above FIVE_HOUR_NEAR_LIMIT_PCT of
//       its 5h window AND above that window's elapsed share (R10 — the
//       threshold is clock-relative, not a fixed line) is chosen only when no
//       eligible pool below the threshold exists for the lane. Like quarantine
//       and burst gates, this outranks an explicit assignment and incumbency —
//       a near-limit pool that is picked anyway spends the run's next attempt
//       on a quota failure.
//   R8. Route on the FORECAST, not on the reading. A reading is already old at
//       the moment it is read: work dispatched seconds ago has spent quota the
//       meter has not seen, and the assignment being routed will spend more.
//       When a caller attaches in-flight work (pool.inflight) and a spend model
//       (pool.spend / pool.projected*Pct), R7's tiers apply to the projection
//       plus this candidate's own expected consumption, a pool projected at or
//       above BURST_BLOCK_PCT is gated out entirely, and pools already carrying
//       in-flight work yield to quieter pools of similar pace — so a burst of
//       parallel actions spreads instead of stacking on the most-behind pool.
//       With no forecast fields attached, every rule above behaves exactly as
//       it did before: an unmeasured pool is never penalized for a number
//       nobody produced.
//   R9. Load beats incumbency: an incumbent carrying more in-flight agents
//       than a challenger keeps neither its margin nor its cost guard; the
//       quieter pool wins as soon as its effective surplus is higher.
//  R10. The near-limit line is clock-relative. R7's tier is for a pool that
//       will hit its 5h wall mid-run, and that danger is time-shaped: 88%
//       projected with 23 minutes left in the window is a pool spending at its
//       own pace that is about to be handed a fresh window; 77% with four
//       hours left is a pool heading for the wall. So a pool is deprioritized
//       only when its forecast is at/above FIVE_HOUR_NEAR_LIMIT_PCT *and*
//       above the percentage of the 5h window already elapsed. (Observed
//       2026-09-10T22:19Z: claude-code:wati, 81% used with 23 minutes left —
//       92.3% of its window elapsed — was tiered down for a forecast of 88.1%,
//       so a high-tier integrator went to the one account already ahead of its
//       weekly pace while wati's quota, 34% of the week unspent with 13% of
//       the week left, expired unused.) Spend that lands after the reset
//       belongs to the NEXT window: the candidate's minutes and each in-flight
//       record's remaining minutes are clipped at resets_at before they are
//       charged to the 5h forecast — the weekly/monthly pacing penalty is
//       never clipped, that spend does count against its window. No
//       resets_at, an unparsable one, or a reset already in the past means no
//       clock: R7 keeps its fixed line and nothing is clipped, because a pool
//       is never treated differently for a number nobody produced (R8).
//  R11. Quota that expires sooner is worth more ("expiring soon"). A pace
//       surplus is a difference in points and says nothing about how long the
//       pool has left to spend it. (Observed 2026-09-11T04:26Z: grok held
//       +13.8 weekly points with 2h02m left in its week — 1.2% of the window —
//       while claude-code:wati held +22.9 with 13h33m left (8.1%). R2 sent the
//       run to wati on 22.9 > 13.8, and grok's 15 points expired two hours
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
//         draining — forecast at/above the line: ranked after every normal
//                    pool and chosen only when nothing else is eligible, so a
//                    pool about to be emptied is not fed one more run that
//                    would push it over the wall.
//         normal   — expiring soon but on or ahead of pace: ranked with
//                    everyone else on effective surplus, exactly as today.
//       Urgency outranks incumbency (R3/R4/R9) and a configured effort
//       assignment (preferredPool) by the same mechanism R7's tier uses —
//       selection happens among the urgent pools while one exists — so an
//       urgent challenger needs neither the 10-point margin nor the cost
//       guard. It never overrides a strict pin (workflow strictPool filters
//       the pool list before pickPool ever sees it), and never the 5h rules:
//       a pool tiered down by R7/R10 or gated by R8 is not rescued by
//       urgency. No pacing window, no parsable paceResetsAt, a reset already
//       in the past, or any window other than weekly/monthly means there is
//       no lead time to measure and nothing about the pool changes (R8).

import { FIVE_HOUR_NEAR_LIMIT_PCT, BURST_BLOCK_PCT, WINDOW_MS } from '../meters/framework.js';
// One strict numeric coercion for the whole codebase (src/lib/num.js): a
// missing measurement stays null instead of becoming a confident zero.
import { finiteOrNull as num } from './num.js';

export const LANES = ['analyze', 'build', 'chore'];

export const INCUMBENCY_MARGIN = 10; // surplus points a challenger must beat

/**
 * Surplus points charged per in-flight agent when no spend rate is known for
 * the pool's pacing window (or, failing that, its weekly one). It is a
 * tie-breaker, not a measurement: three points is
 * under a third of INCUMBENCY_MARGIN, so it separates pools of similar pace
 * without ever overturning a real quota difference. Callers override it with
 * opts.inflightPenaltyPct.
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
 * so one more run spends the run's next attempt on a quota failure.
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
 * `underClock` is R10's exemption from it — near the limit, but no further
 * into the window's quota than into the window's time.
 *
 * @param {object} pool
 * @param {number|null} [candidateMinutes] expected minutes of this assignment
 * @param {number} [now]
 * @returns {{raw: number|null, projected: number|null,
 *            ratePerMinute: number|null, candidateAdd: number|null,
 *            forecast: number|null, forecasted: boolean,
 *            minutesToReset: number|null, elapsedPct: number|null,
 *            inflightCreditPct: number, nearLimit: boolean,
 *            underClock: boolean}}
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
 * Two bases, and the larger one is charged:
 *   1. a known rate: rate × each in-flight record's remainingMinutes,
 *      plus rate × candidateMinutes — real projected percentage points (an
 *      in-flight agent whose remaining minutes nobody recorded is charged
 *      inflightPenaltyPct instead);
 *   2. the floor: inflightPenaltyPct per in-flight agent — a documented flat
 *      default, labeled `penalty` so no reader mistakes it for a measurement.
 * The floor exists because at real subscription-window rates (about 0.05
 * points per worker-minute) a six-minute agent projects to under a point,
 * which cannot spread a burst across a pace gap of a few points; the measured
 * projection only ever raises the charge above the floor.
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
 * estimateSource: `none` (nothing to charge), `penalty` (the flat floor set the
 * charge), or the source label of the rate that was used (`history` /
 * `bootstrap`, from `spend.pacing` or `spend.weekly`) when the measured
 * projection exceeded the floor; null when a rate was used but the producer
 * labeled no provenance for it.
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
  // flat penalty rather than pretending it will finish for free.
  const untimed = Math.max(0, count - measured);
  const projected = rate * remaining + rate * (minutes ?? 0) + untimed * penaltyPct;
  // Every in-flight agent costs at least the flat penalty. At measured weekly
  // rates the projection alone is a fraction of a point per agent, which would
  // leave a burst stacked on the single most-behind pool — the very thing this
  // rule exists to prevent. The projection can only raise the charge.
  const floor = count * penaltyPct;
  const penalty = Math.max(projected, floor);
  const estimateSource =
    penalty === 0 ? 'none'
    : floor > projected ? 'penalty'
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
  const state =
    forecast != null && forecast >= PACING_FORECAST_BLOCK_PCT ? 'draining'
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

export function isExhausted(pool) {
  // Flat shape (buildPools) first, legacy meter shape second. A stale
  // meterSource reading must not permanently exclude a pool: if the reading
  // is stale-labeled and older than the window could explain, trust the pool
  // may have reset — the next live poll will decide.
  const used = pool?.usedPct ?? pool?.meter?.usedPct;
  if (!Number.isFinite(used)) return false;
  if (used < 100) return false;
  if (pool.meterSource === 'stale') return false;
  return true;
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
 *                        callerSession, candidateMinutes=null (expected minutes
 *                        of the assignment being routed),
 *                        inflightPenaltyPct=DEFAULT_INFLIGHT_PENALTY_PCT }
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
    candidateMinutes = null,
    inflightPenaltyPct = DEFAULT_INFLIGHT_PENALTY_PCT,
  } = opts;

  const candidateMins = num(candidateMinutes);

  if (!LANES.includes(lane)) {
    return {
      pick: null,
      keepOnClaude: false,
      why: `unknown lane ${lane}`,
      candidates: [],
      forecast: { candidateMinutes: candidateMins, gated: [] },
    };
  }

  // Eligibility in two stages, so an empty candidate list can say WHICH stage
  // emptied it (D7). A pool the model policy rejected is not a pool that lacks
  // a capability, and reporting the wrong one sends an operator to fix a
  // connector when the fix is `strategy set-rung`.
  const laneCapable = pools.filter(
    (p) =>
      p.enabled !== false &&
      (p.lanes ?? LANES).includes(lane) &&
      requiredCapabilities.every((capability) =>
        (p.capabilities ?? p.connector?.capabilities ?? []).includes(capability)) &&
      !isQuarantined(p, now) &&
      !isExhausted(p),
  );
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
      // R11 adds under R7's 5h tier and above the pace comparison.
      urgencyRank: expiring.state === 'urgent' ? 0 : expiring.state === 'draining' ? 2 : 1,
      // R8b: R7's tier, applied to the forecast instead of the reading — and
      // R10: only for a pool further through its 5h quota than through its 5h
      // window. A pool at 88% with 23 minutes left keeps its tier 0.
      tier: forecast.nearLimit && !forecast.underClock ? 1 : 0,
      // A pool is gated only by a FORECAST at/above the burst line — a bare
      // reading keeps its current meaning (dispatch owns that gate), so pools
      // without a spend model behave exactly as before.
      gated: forecast.forecasted && forecast.forecast != null && forecast.forecast >= BURST_BLOCK_PCT,
    };
  });
  // R8 before R7 before R11 before R2: forecast-gated pools last, then 5h
  // headroom, then urgent < normal < draining, then the group's own score —
  // urgency among the urgent, most-behind-after-load everywhere else. The
  // candidate list is reported in this exact preference order.
  scored.sort(
    (a, b) =>
      (a.gated ? 1 : 0) - (b.gated ? 1 : 0) ||
      a.tier - b.tier ||
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
    nearFiveHourLimit: e.tier === 1,
    forecastGated: e.gated,
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
  }));
  const gatedNames = scored.filter((e) => e.gated).map((e) => e.pool.name);
  const forecastReport = { candidateMinutes: candidateMins, gated: gatedNames };

  if (scored.length === 0) {
    // D7: name the stage that emptied the list. A tier allow-list that matched
    // no model on any pool outranks the capability wording, which would other-
    // wise blame connectors that declare every capability the lane asked for.
    const blocked = modelPolicyReason(modelBlocked, opts.effortTier);
    const withCapabilities = requiredCapabilities.length
      ? ` with capabilities: ${requiredCapabilities.join(', ')}`
      : '';
    return callerEligible
      ? {
          pick: null,
          keepOnClaude: true,
          why: `${blocked ?? `no eligible delegate pool${withCapabilities}`}; caller takes the lane`,
          candidates,
          forecast: forecastReport,
        }
      : {
          pick: null,
          keepOnClaude: false,
          why: blocked ?? `no eligible pool${withCapabilities}`,
          candidates,
          forecast: forecastReport,
        };
  }

  // R8b: forecast-gated pools are out of selection entirely — unless every
  // capable pool is gated, in which case routing still has to name one. The
  // least-loaded (lowest forecast) wins then, and `why` says so: returning
  // nothing would strand the action while a pool is still dispatchable.
  const open = scored.filter((e) => !e.gated);
  const gatedEntries = scored.filter((e) => e.gated);
  const allGated = open.length === 0;

  let winnerEntry;
  let skippedNearLimit = [];
  let skippedDraining = [];
  if (allGated) {
    winnerEntry = [...scored].sort(
      (a, b) =>
        (a.forecast.forecast ?? Infinity) - (b.forecast.forecast ?? Infinity) ||
        b.effective - a.effective,
    )[0];
  } else {
    // R7: selection happens only among pools with 5h headroom while any exists.
    const withHeadroom = open.filter((e) => e.tier === 0);
    const headroomSet = withHeadroom.length ? withHeadroom : open;
    skippedNearLimit = withHeadroom.length ? open.filter((e) => e.tier === 1) : [];

    // R11, by the same mechanism and one rung below it: while any pool's
    // quota is about to expire with room to spend it, that pool is the only
    // selectable one — which is what puts urgency ahead of incumbency and of
    // a configured effort assignment, both of which are resolved inside
    // `selectable` below. A draining pool is the mirror image: out of
    // selection until nothing else is left.
    const urgentSet = headroomSet.filter((e) => e.urgencyRank === 0);
    const notDraining = headroomSet.filter((e) => e.urgencyRank !== 2);
    const selectable =
      urgentSet.length ? urgentSet : notDraining.length ? notDraining : headroomSet;
    skippedDraining = notDraining.length ? headroomSet.filter((e) => e.urgencyRank === 2) : [];

    const preferredEntry = preferredPool
      ? selectable.find((entry) => entry.pool.name === preferredPool)
      : null;
    const incumbentEntry = selectable.find((e) => e.pool.incumbent === true);

    if (preferredEntry) {
      // A user-applied effort-tier assignment is an explicit choice, but it
      // never bypasses eligibility, quarantine, exhaustion, or burst gates.
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
        incumbentEntry.effective <= INCUMBENT_DISTRESS || isExhausted(incumbentEntry.pool);
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
  // R8c visibility: pools that would have won on raw pace and lost only
  // because of the work they are already carrying. Empty unless a caller
  // attached in-flight counts, so today's reasons are unchanged.
  const yieldedBusier = scored.filter(
    (e) =>
      e !== winnerEntry &&
      !e.gated &&
      e.tier === winnerEntry.tier &&
      e.load.count > 0 &&
      e.pace >= winnerEntry.pace &&
      e.effective < winnerEntry.effective,
  );
  const why = routingReason(winnerEntry, {
    preferred: !allGated && Boolean(preferredPool) && winnerEntry.pool.name === preferredPool,
    effortTier: opts.effortTier,
    skippedNearLimit,
    skippedDraining,
    gated: allGated ? [] : gatedEntries,
    gatedFallback: allGated,
    yieldedBusier,
  });

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
      why: 'caller pool won the lane; keep work in-session',
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

/**
 * Explain the pick: why this pool, at what 5h utilization (reading and, when a
 * forecast exists, the projection), how much work it is already carrying, and
 * which pools it was preferred over — near their 5h limit or forecast-gated.
 */
function routingReason(
  winnerEntry,
  {
    preferred,
    effortTier,
    skippedNearLimit = [],
    skippedDraining = [],
    gated = [],
    gatedFallback = false,
    yieldedBusier = [],
  },
) {
  const note = fiveHourNote(winnerEntry);
  const inflight = inflightNote(winnerEntry);
  const detail = [`surplus ${tenth(winnerEntry.effective)}`, note, inflight]
    .filter(Boolean)
    .join(', ');
  let base;
  if (gatedFallback) {
    base = `every capable pool is forecast-gated at/above ${BURST_BLOCK_PCT}% of its 5h window; least loaded wins (${
      [winnerEntry.pool.name, note, inflight].filter(Boolean).join(', ')
    })`;
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
    // Three states, not two (R10): headroom, near the limit and tiered down,
    // or near the limit but under the window's clock — where the note itself
    // carries the explanation, so the label stays out of its way.
    const standing =
      !note ? ''
      : winnerEntry.tier === 1 ? ' near its 5h limit'
      : winnerEntry.forecast.underClock ? ''
      : ' with 5h headroom';
    base = `most-behind capable pool${standing} (${detail})`;
  }
  const clauses = [base];
  if (skippedNearLimit.length) {
    const projected = skippedNearLimit.some((e) => e.forecast.forecasted);
    clauses.push(
      `skipped near 5h limit${projected ? ' (projected)' : ''}: ${skippedNearLimit
        .map((e) => poolPctLabel(e))
        .join(', ')}`,
    );
  }
  if (gated.length) {
    clauses.push(
      `forecast-gated at/above ${BURST_BLOCK_PCT}%: ${gated.map((e) => poolPctLabel(e)).join(', ')}`,
    );
  }
  if (skippedDraining.length) {
    // R11: a pool whose window is about to close was passed over anyway,
    // because the run would spend what little it has left through the wall.
    clauses.push(
      `expiring but draining (forecast >= ${PACING_FORECAST_BLOCK_PCT}%): ${skippedDraining
        .map((e) => `${e.pool.name} ${pacingPctText(e)}`)
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
  const { minutesToReset, windowLeftFraction, urgency, window } = entry.expiring;
  const word = window === 'monthly' ? 'month' : 'week';
  const left = tenth(windowLeftFraction * 100);
  const tail = detail ? ` (${detail})` : '';
  return (
    `expiring soon: ${entry.pool.name} resets in ${formatResetsIn(minutesToReset)}, `
    + `surplus ${tenth(entry.effective)} over ${left}% of the ${word} left `
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
 * (R10): `claude-code:wati 88.1% (92.3% elapsed)`. The clock is what decided
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
