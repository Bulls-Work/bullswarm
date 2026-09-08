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

import { FIVE_HOUR_NEAR_LIMIT_PCT } from '../meters/framework.js';

export const LANES = ['analyze', 'build', 'chore'];

export const INCUMBENCY_MARGIN = 10; // surplus points a challenger must beat

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

/**
 * 5h headroom tier: 0 = has headroom (or no reading at all), 1 = at/above
 * FIVE_HOUR_NEAR_LIMIT_PCT. A missing reading counts as headroom — an
 * unmetered pool must never be deprioritized for a number nobody measured.
 */
export function fiveHourTier(pool) {
  const used = pool?.fiveHourUsedPct;
  if (used == null || !Number.isFinite(Number(used))) return 0;
  return Number(used) >= FIVE_HOUR_NEAR_LIMIT_PCT ? 1 : 0;
}

/** Round to one decimal for human-readable routing reasons. */
function tenth(value) {
  return Math.round(Number(value) * 10) / 10;
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
 *                        quarantine?, incumbent?}
 * @param {object} [opts] { callerEligible=true, callerName='claude', now }
 * @returns {{pick: object|null, keepOnClaude: boolean, why: string,
 *            candidates: Array}}
 */
export function pickPool(lane, pools, opts = {}) {
  const {
    callerEligible = true,
    callerName = 'claude-code',
    now = Date.now(),
    requiredCapabilities = [],
    preferredPool = null,
  } = opts;

  if (!LANES.includes(lane)) {
    return {
      pick: null,
      keepOnClaude: false,
      why: `unknown lane ${lane}`,
      candidates: [],
    };
  }

  const eligible = pools.filter(
    (p) =>
      p.enabled !== false &&
      (p.lanes ?? LANES).includes(lane) &&
      requiredCapabilities.every((capability) =>
        (p.capabilities ?? p.connector?.capabilities ?? []).includes(capability)) &&
      !isQuarantined(p, now) &&
      !isExhausted(p),
  );

  const scored = eligible.map((p) => ({
    pool: p,
    pace: paceScore(p, now),
    tier: fiveHourTier(p),
  }));
  // R7 before R2: 5h headroom first, then most-behind within the tier. The
  // candidate list is reported in this exact preference order.
  scored.sort((a, b) => a.tier - b.tier || b.pace - a.pace);

  const candidates = scored.map((e) => ({
    pool: e.pool.name,
    model: e.pool.modelPolicy?.model ?? null,
    modelPolicy: e.pool.modelPolicy?.source ?? null,
    pace: tenth(e.pace),
    costRank: e.pool.costRank ?? null,
    fiveHourUsedPct: e.pool.fiveHourUsedPct == null || !Number.isFinite(Number(e.pool.fiveHourUsedPct))
      ? null
      : Number(e.pool.fiveHourUsedPct),
    nearFiveHourLimit: e.tier === 1,
  }));

  if (scored.length === 0) {
    return callerEligible
      ? {
          pick: null,
          keepOnClaude: true,
          why: requiredCapabilities.length
            ? `no eligible delegate pool with capabilities: ${requiredCapabilities.join(', ')}; caller takes the lane`
            : 'no eligible delegate pool; caller takes the lane',
          candidates,
        }
      : {
          pick: null,
          keepOnClaude: false,
          why: requiredCapabilities.length
            ? `no eligible pool with capabilities: ${requiredCapabilities.join(', ')}`
            : 'no eligible pool',
          candidates,
        };
  }

  // R7: selection happens only among pools with 5h headroom while any exists.
  const withHeadroom = scored.filter((e) => e.tier === 0);
  const selectable = withHeadroom.length ? withHeadroom : scored;
  const skippedNearLimit = withHeadroom.length
    ? scored.filter((e) => e.tier === 1)
    : [];

  const preferredEntry = preferredPool
    ? selectable.find((entry) => entry.pool.name === preferredPool)
    : null;
  const incumbentEntry = selectable.find((e) => e.pool.incumbent === true);

  let winnerEntry;
  if (preferredEntry) {
    // A user-applied effort-tier assignment is an explicit choice, but it
    // never bypasses eligibility, quarantine, exhaustion, or burst gates.
    winnerEntry = preferredEntry;
  } else if (incumbentEntry) {
    // R3+R4: challenger needs margin. The cost guard protects the incumbent
    // ONLY while it is a reasonable steward of its quota: a distressed
    // incumbent (deep negative surplus) forfeits cost protection, and
    // equal-cost challengers may displace (strict < caused permanent
    // lock-in between same-rank pools).
    const INCUMBENT_DISTRESS = -20;
    const incumbentDistressed =
      incumbentEntry.pace <= INCUMBENT_DISTRESS || isExhausted(incumbentEntry.pool);
    const challenger = selectable.find(
      (e) =>
        e !== incumbentEntry &&
        e.pace >= incumbentEntry.pace + INCUMBENCY_MARGIN &&
        (incumbentDistressed || costOf(e.pool) <= costOf(incumbentEntry.pool)),
    );
    winnerEntry = challenger ?? incumbentEntry;
  } else {
    winnerEntry = selectable[0];
  }
  const why = routingReason(winnerEntry, {
    preferred: Boolean(preferredEntry),
    effortTier: opts.effortTier,
    skippedNearLimit,
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
    };
  }

  return {
    pick: { pool: winnerEntry.pool.name, connector: winnerEntry.pool },
    keepOnClaude: false,
    why,
    candidates,
  };
}

/**
 * Explain the pick: why this pool, at what 5h utilization, and which
 * near-limit pools it was preferred over.
 */
function routingReason(winnerEntry, { preferred, effortTier, skippedNearLimit = [] }) {
  const used = winnerEntry.pool.fiveHourUsedPct;
  const note = used == null || !Number.isFinite(Number(used))
    ? null
    : `5h used ${tenth(used)}%`;
  const base = preferred
    ? `configured ${effortTier ?? 'effort'} assignment (${winnerEntry.pool.name}${note ? `, ${note}` : ''})`
    : `most-behind capable pool${
      note ? (winnerEntry.tier === 0 ? ' with 5h headroom' : ' near its 5h limit') : ''
    } (surplus ${tenth(winnerEntry.pace)}${note ? `, ${note}` : ''})`;
  if (!skippedNearLimit.length) return base;
  const skipped = skippedNearLimit
    .map((e) => {
      const pct = e.pool.fiveHourUsedPct;
      return `${e.pool.name}${pct == null ? '' : ` ${tenth(pct)}%`}`;
    })
    .join(', ');
  return `${base} · skipped near 5h limit: ${skipped}`;
}
