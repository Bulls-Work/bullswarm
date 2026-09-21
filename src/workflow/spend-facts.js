// One honest-total vocabulary for every money surface.
//
// Home, Stats, Budget and the Runs list all print money over scopes that may
// hold attempts nobody priced: a run, a day, a pool, a period. The Run page's
// spend block has answered exactly that shape since 0.35.1 — `at least $X`
// with the `<n> estimated · <n> running · <n> unmeasured` suffix — through
// `runSpendFacts`, which stays the single implementation. This module adds no
// arithmetic of its own: it only feeds that helper a rollup-shaped usage
// aggregate, so no page can grow a second, quieter vocabulary for a partial
// total (`≈` where `at least` is the truth, or a dash where a subtotal was
// recorded).
//
// A caller with real attempts (the Run page itself) keeps calling
// `runSpendFacts(row, { rollup })` directly; `spendFacts()` is for the
// aggregate-only surfaces whose numbers come from the rollup index.

import { formatMoney } from '../lib/usage-basis.js';
import { runSpendFacts } from './run-model.js';

function finite(value) {
  if (value == null || value === '' || typeof value === 'boolean') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

/**
 * The Run spend block's facts for a scope's rollup usage aggregate.
 *
 * Accepts anything shaped like a rollup `usage` object (attempts,
 * pricedAttempts, measuredAttempts, apiUsd, apiKnownSubtotalUsd,
 * subscriptionKnownSubtotalUsd, subscriptionPricedAttempts) — a run rollup, a
 * Stats row, a day total, a Budget row. Returns null for a scope with no usage
 * record at all, so a caller never mistakes absence for a measured zero.
 */
export function spendFacts(usage) {
  if (!usage || typeof usage !== 'object') return null;
  // A rollup always writes the whole coverage block; a caller's lighter
  // aggregate may carry only the counts it knows. A missing `pricedAttempts`
  // stays missing — absence of evidence about that class, never a claim that
  // nothing was priced — while a missing `measuredAttempts` must not turn
  // every priced attempt into a claimed estimate, so it falls back to the
  // priced count and the suffix simply says nothing about the split.
  const priced = finite(usage.pricedAttempts);
  return runSpendFacts({ state: {} }, {
    rollup: {
      usage: {
        attempts: finite(usage.attempts),
        pricedAttempts: priced,
        measuredAttempts: finite(usage.measuredAttempts) ?? (priced == null ? 0 : priced),
        apiUsd: finite(usage.apiUsd),
        apiKnownSubtotalUsd: finite(usage.apiKnownSubtotalUsd),
        subscriptionKnownSubtotalUsd: finite(usage.subscriptionKnownSubtotalUsd),
        subscriptionPricedAttempts: finite(usage.subscriptionPricedAttempts),
      },
    },
  });
}

/**
 * One run's pool map as a rollup-shaped usage aggregate.
 *
 * A pre-0.35.2 entry recorded a whole amount and no coverage counts. Its
 * missing counts are absence of evidence, never a claim that nothing was
 * priced, so `complete` says whether every entry that carries an amount also
 * named its counts — and a caller that wants to word a lower bound must check
 * it first.
 */
export function poolUsageAggregate(pools) {
  if (!pools || typeof pools !== 'object' || Array.isArray(pools)) return null;
  const aggregate = { known: null, attempts: null, priced: null, measured: null, complete: true };
  let seen = false;
  for (const entry of Object.values(pools)) {
    if (!entry || typeof entry !== 'object') continue;
    seen = true;
    const value = finite(entry.apiUsd ?? entry.costUsd ?? entry.apiEquivalentUsd ?? entry.estimatedUsd);
    const subtotal = finite(entry.apiKnownSubtotalUsd) ?? value;
    if (subtotal != null) aggregate.known = (aggregate.known ?? 0) + subtotal;
    const count = finite(entry.attempts);
    const priced = finite(entry.pricedAttempts);
    const measured = finite(entry.measuredAttempts);
    if (count != null) aggregate.attempts = (aggregate.attempts ?? 0) + count;
    if (priced != null) aggregate.priced = (aggregate.priced ?? 0) + priced;
    if (measured != null) aggregate.measured = (aggregate.measured ?? 0) + measured;
    if (value != null && (count == null || priced == null)) aggregate.complete = false;
  }
  return seen ? aggregate : null;
}

/**
 * The facts for a run-shaped record: its own attempts when it has them (a
 * live run answers for itself, so a running attempt keeps its own coverage
 * class), else the usage aggregate its rollup carries, else the sum over its
 * own pool map.
 */
export function recordSpendFacts(record, attempts = null) {
  const state = record?.state ?? record ?? {};
  const list = Array.isArray(attempts) ? attempts : [
    ...(state?.preflight?.scout?.attempts ?? []),
    ...(state?.planner?.attempts ?? []),
    ...(state?.attempts ?? record?.attempts ?? []),
  ];
  if (list.length) return runSpendFacts({ state: { attempts: list } });
  const usage = spendFacts(record?.usage ?? null);
  if (usage) return usage;
  const aggregate = poolUsageAggregate(record?.pools);
  if (!aggregate) return null;
  return spendFacts({
    attempts: aggregate.complete ? aggregate.attempts : null,
    pricedAttempts: aggregate.complete ? aggregate.priced : null,
    measuredAttempts: aggregate.measured,
    apiKnownSubtotalUsd: aggregate.known,
  });
}

/**
 * `at least $299.87 api · 66 unmeasured` — the one-line shape requirement 4
 * names, for surfaces that print one money phrase rather than the Run page's
 * two-column spend block.
 *
 * A whole scope keeps the caller's own label (`whole`: Home's
 * `≈ $9.52 api summed`, `~ $4.00 api estimated`, or a bare amount), so the
 * existing estimate words survive. A scope that includes unmeasured or running
 * attempts reads `at least $X` with the Run block's own coverage suffix —
 * `at least $207.88 api · 53 estimated · 66 unmeasured`. A scope with no
 * recorded amount reads `api unknown` plus that suffix: never a guessed dollar
 * figure beside the unknown. `api` may be null where the surface's own column
 * already says API; `counts: 'unmeasured'` narrows the suffix to the classes a
 * narrow cell can hold (`at least $207.88 · 12 unmeasured`).
 */
export function honestApiTotalText(facts, { api = 'api', whole = null, counts = 'full' } = {}) {
  if (!facts) return whole ?? 'api unknown';
  const amount = finite(facts.apiKnownSubtotalUsd);
  const lowerBound = facts.unmeasured > 0 || facts.running > 0;
  const countText = counts === 'unmeasured'
    ? [
      facts.running > 0 ? `${facts.running} running` : null,
      facts.unmeasured > 0 ? `${facts.unmeasured} unmeasured` : null,
    ].filter(Boolean).join(' · ')
    : counts === 'none' ? '' : String(facts.suffix ?? '');
  const coverage = lowerBound && countText ? ` · ${countText}` : '';
  if (amount == null) {
    // Nothing was priced. Keep the caller's own label when it still names a
    // whole-scope amount (a v1 rollup carries `costUsd` without coverage
    // counts); otherwise the honest answer is unknown, with the count.
    if (coverage && (whole == null || whole === 'api unknown')) return `api unknown${coverage}`;
    return whole ?? `api unknown${coverage}`;
  }
  if (lowerBound) return `at least ${formatMoney(amount)}${api == null ? '' : ` ${api}`}${coverage}`;
  return whole ?? (api == null ? formatMoney(amount) : `${formatMoney(amount)} ${api}`);
}

export default spendFacts;
