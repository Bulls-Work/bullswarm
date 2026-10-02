// Rate card against the provider's own cost: for every attempt whose stream
// carries the CLI's reported `costUsd` and whose usage Bullswarm priced from a
// rate card, the two amounts side by side (scripts/check-rate-cards.mjs).
//
// A resumed attempt (`continued`) is compared against the sum of every
// attempt of its session up to it: Claude Code reports the session's running
// total, while Bullswarm prices the attempt's own tokens (verified on
// 2026-10-02: four resumed attempts matched their session sums to the cent).

/** The last `usage.costUsd` an attempt's stream events reported, or null. */
export function reportedCostUsd(events) {
  for (const event of [...(events ?? [])].reverse()) {
    const cost = Number(event?.usage?.costUsd);
    if (event?.usage?.costUsd != null && Number.isFinite(cost)) return cost;
  }
  return null;
}

/**
 * One row per comparable attempt of a run state.
 * @param {object} state a run's state.json
 * @param {(attempt: object) => Array<object>|null} readEvents the attempt's stream events
 * @returns {Array<{shortId, actionId, pool, model, mine, provider, ratio, session: boolean}>}
 */
export function compareAttemptCosts(state, readEvents) {
  const attempts = Array.isArray(state?.attempts) ? state.attempts : [];
  const rows = [];
  attempts.forEach((attempt, index) => {
    const mine = Number(attempt?.usage?.api?.usd);
    if (attempt?.usage?.api?.usd == null || !Number.isFinite(mine)) return;
    const provider = reportedCostUsd(readEvents(attempt));
    if (provider == null || provider <= 0) return;
    const sessionId = attempt?.usage?.sessionId ?? null;
    const continued = Boolean(attempt?.continued) && sessionId != null;
    const compared = continued
      ? attempts.slice(0, index + 1)
        .filter((entry) => entry?.usage?.sessionId === sessionId)
        .reduce((sum, entry) => sum + (Number(entry?.usage?.api?.usd) || 0), 0)
      : mine;
    rows.push({
      shortId: state?.shortId ?? null,
      actionId: attempt?.actionId ?? null,
      pool: attempt?.pool ?? null,
      model: attempt?.usage?.model ?? attempt?.model ?? null,
      mine: compared,
      provider,
      ratio: compared / provider,
      session: continued,
    });
  });
  return rows;
}

/** Rows grouped by provider and model, with how many agree within `tolerance`. */
export function summarizeCostComparison(rows, { tolerance = 0.005 } = {}) {
  const groups = new Map();
  for (const row of rows) {
    const key = `${String(row.pool ?? '').split(':')[0]} ${row.model ?? 'unknown'}`;
    const group = groups.get(key) ?? { key, pairs: 0, exact: 0, off: [] };
    group.pairs += 1;
    if (Math.abs(row.ratio - 1) <= tolerance) group.exact += 1;
    else group.off.push(row);
    groups.set(key, group);
  }
  return [...groups.values()].sort((a, b) => a.key.localeCompare(b.key));
}
