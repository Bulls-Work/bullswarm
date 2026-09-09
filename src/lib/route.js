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
//       its 5h window is chosen only when no eligible pool below the threshold
//       exists for the lane. Like quarantine and burst gates, this outranks an
//       explicit assignment and incumbency — a near-limit pool that is picked
//       anyway spends the run's next attempt on a quota failure.
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

import { FIVE_HOUR_NEAR_LIMIT_PCT, BURST_BLOCK_PCT } from '../meters/framework.js';
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

/**
 * 5h forecast for one pool and the assignment being routed (R8 rule a):
 *
 *   forecast = (projectedFiveHourPct ?? fiveHourUsedPct)
 *              + fiveHour.ratePerMinute × candidateMinutes
 *
 * with the candidate term added only when both of its numbers exist; anything
 * else falls back to the best available reading, and a pool with no reading
 * at all forecasts null (unknown — never gated, never deprioritized).
 *
 * `forecasted` records whether the number is more than the raw reading. Only a
 * real projection input (a producer-supplied projectedFiveHourPct, or a rate ×
 * candidateMinutes term) turns a reading into a forecast; a bare reading keeps
 * exactly its old meaning so nothing changes for callers that attach no model.
 *
 * @param {object} pool
 * @param {number|null} [candidateMinutes] expected minutes of this assignment
 * @returns {{raw: number|null, projected: number|null,
 *            ratePerMinute: number|null, candidateAdd: number|null,
 *            forecast: number|null, forecasted: boolean}}
 */
export function fiveHourForecast(pool, candidateMinutes = null) {
  const raw = num(pool?.fiveHourUsedPct);
  const projected = num(pool?.projectedFiveHourPct);
  const ratePerMinute = num(pool?.spend?.fiveHour?.ratePerMinute);
  const minutes = num(candidateMinutes);
  const base = projected ?? raw;
  const candidateAdd =
    ratePerMinute != null && minutes != null ? ratePerMinute * minutes : null;
  const forecast = base == null ? null : base + (candidateAdd ?? 0);
  return {
    raw,
    projected,
    ratePerMinute,
    candidateAdd,
    forecast,
    forecasted: projected != null || candidateAdd != null,
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
  const paced = num(pool?.spend?.pacing?.ratePerMinute) != null
    ? pool.spend.pacing
    : pool?.spend?.weekly ?? null;
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
    const forecast = fiveHourForecast(p, candidateMins);
    const load = inflightLoad(p, { candidateMinutes: candidateMins, inflightPenaltyPct });
    const pace = paceScore(p, now);
    return {
      pool: p,
      pace,
      // R8c: pace minus the quota this pool's in-flight work and this
      // assignment are expected to spend. Equals pace when nothing is in
      // flight and no rate applies.
      effective: pace - load.penalty,
      load,
      forecast,
      // R8b: R7's tier, applied to the forecast instead of the reading.
      tier: forecast.forecast != null && forecast.forecast >= FIVE_HOUR_NEAR_LIMIT_PCT ? 1 : 0,
      // A pool is gated only by a FORECAST at/above the burst line — a bare
      // reading keeps its current meaning (dispatch owns that gate), so pools
      // without a spend model behave exactly as before.
      gated: forecast.forecasted && forecast.forecast != null && forecast.forecast >= BURST_BLOCK_PCT,
    };
  });
  // R8 before R7 before R2: forecast-gated pools last, then 5h headroom, then
  // most-behind-after-load within the tier. The candidate list is reported in
  // this exact preference order.
  scored.sort(
    (a, b) => (a.gated ? 1 : 0) - (b.gated ? 1 : 0) || a.tier - b.tier || b.effective - a.effective,
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
    projectedWeeklyPct: num(e.pool.projectedWeeklyPct),
    // The window this pool is paced by, and the projection in it. Equal to
    // the weekly pair for every pool that declares no monthly quota window.
    pacingWindow: e.pool.pacingWindow ?? null,
    projectedPacingPct: num(e.pool.projectedPacingPct),
    ratePerMinute: e.forecast.ratePerMinute,
    estimateSource: e.load.estimateSource,
    nearFiveHourLimit: e.tier === 1,
    forecastGated: e.gated,
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
  if (allGated) {
    winnerEntry = [...scored].sort(
      (a, b) =>
        (a.forecast.forecast ?? Infinity) - (b.forecast.forecast ?? Infinity) ||
        b.effective - a.effective,
    )[0];
  } else {
    // R7: selection happens only among pools with 5h headroom while any exists.
    const withHeadroom = open.filter((e) => e.tier === 0);
    const selectable = withHeadroom.length ? withHeadroom : open;
    skippedNearLimit = withHeadroom.length ? open.filter((e) => e.tier === 1) : [];

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
  } else {
    base = `most-behind capable pool${
      note ? (winnerEntry.tier === 0 ? ' with 5h headroom' : ' near its 5h limit') : ''
    } (${detail})`;
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
  if (yieldedBusier.length) {
    clauses.push(
      `preferred over busier: ${yieldedBusier
        .map((e) => `${e.pool.name} (${e.load.count} in flight)`)
        .join(', ')}`,
    );
  }
  return clauses.join(' · ');
}

/** `<pool> <pct>%` using the forecast when one exists, else the raw reading. */
function poolPctLabel(entry) {
  const pct = entry.forecast.forecasted ? entry.forecast.forecast : entry.forecast.raw;
  return `${entry.pool.name}${pct == null ? '' : ` ${tenth(pct)}%`}`;
}

/** `5h used 30%` or, when a forecast adds to it, `5h used 30% -> 41% projected`. */
function fiveHourNote(entry) {
  const { raw, forecast, forecasted } = entry.forecast;
  if (raw == null) {
    return forecasted && forecast != null ? `5h projected ${tenth(forecast)}%` : null;
  }
  const reading = `5h used ${tenth(raw)}%`;
  if (!forecasted || forecast == null || tenth(forecast) === tenth(raw)) return reading;
  return `${reading} -> ${tenth(forecast)}% projected`;
}

/** `2 in flight`, or null when the caller tracks no in-flight work here. */
function inflightNote(entry) {
  return entry.load.count > 0 ? `${entry.load.count} in flight` : null;
}
