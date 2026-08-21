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

/** surplus = elapsed% − used%; higher = more quota about to expire. */
export function paceScore(pool, now = Date.now()) {
  const meter = pool.meter;
  if (!meter || meter.type === 'none' || meter.usedPct == null) return 0;
  return elapsedPct(meter, now) - meter.usedPct;
}

export function isQuarantined(pool, now = Date.now()) {
  if (!pool.quarantine) return false;
  if (pool.quarantine.until == null) return true;
  return now < pool.quarantine.until;
}

export function isExhausted(pool) {
  return pool.meter?.usedPct != null && pool.meter.usedPct >= 100;
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
    callerName = 'claude',
    now = Date.now(),
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
      !isQuarantined(p, now) &&
      !isExhausted(p),
  );

  const scored = eligible.map((p) => ({
    pool: p,
    pace: paceScore(p, now),
  }));
  scored.sort((a, b) => b.pace - a.pace); // most-behind first

  const candidates = scored.map((e) => ({
    pool: e.pool.name,
    pace: Math.round(e.pace * 10) / 10,
    costRank: e.pool.costRank ?? null,
  }));

  if (scored.length === 0) {
    return callerEligible
      ? {
          pick: null,
          keepOnClaude: true,
          why: 'no eligible delegate pool; caller takes the lane',
          candidates,
        }
      : {
          pick: null,
          keepOnClaude: false,
          why: 'no eligible pool',
          candidates,
        };
  }

  const incumbentEntry = scored.find((e) => e.pool.incumbent === true);

  let winnerEntry;
  if (incumbentEntry) {
    // R3+R4: challenger needs margin AND strictly lower costRank.
    const challenger = scored.find(
      (e) =>
        e !== incumbentEntry &&
        e.pace >= incumbentEntry.pace + INCUMBENCY_MARGIN &&
        (e.pool.costRank ?? 99) < (incumbentEntry.pool.costRank ?? 99),
    );
    winnerEntry = challenger ?? incumbentEntry;
  } else {
    winnerEntry = scored[0];
  }

  return {
    pick: { pool: winnerEntry.pool.name, connector: winnerEntry.pool },
    keepOnClaude: false,
    why: `most-behind capable pool (surplus ${Math.round(winnerEntry.pace * 10) / 10})`,
    candidates,
  };
}
