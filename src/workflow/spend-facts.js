// One honest-total vocabulary for every money surface.
//
// Home, Stats, Budget and the Runs list all print money over scopes that may
// hold attempts nobody priced: a run, a day, a pool, a period. The Run page's
// spend block has answered exactly that shape since 0.35.1 — `≥$X` — through
// `runSpendFacts`, which stays the single implementation. This module adds no
// arithmetic of its own: it only feeds that helper a rollup-shaped usage
// aggregate, so no page can grow a second, quieter vocabulary for a partial
// total (`≈` where `≥` is the truth, or a dash where a subtotal was
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
 * One money phrase for a scope: the caller's own whole-scope label (`whole`)
 * when every attempt was priced, `≥$X api` when some were left out or are
 * still running, `not priced` when a finished scope priced nothing, and a dash
 * while a live one has no amount yet — never a guessed dollar figure. `api`
 * may be null where the surface's own column already says API.
 */
export function honestApiTotalText(facts, { api = 'api', whole = null } = {}) {
  if (!facts) return whole ?? 'api unknown';
  const amount = finite(facts.apiKnownSubtotalUsd);
  // A lower bound is the `≥` glyph alone; the page that owns the scope says
  // how many attempts it leaves out.
  const lowerBound = facts.unmeasured > 0 || facts.running > 0;
  if (amount == null) {
    // Nothing was priced. Keep the caller's own label when it still names a
    // whole-scope amount (a v1 rollup carries `costUsd` without coverage
    // counts); otherwise a finished scope is `not priced` and a live one a dash.
    if (lowerBound && (whole == null || whole === 'api unknown')) {
      return facts.running > 0 ? '—' : 'not priced';
    }
    return whole ?? 'api unknown';
  }
  // A lower bound of nothing is `$0`, never the `$0.000` a priced zero reads.
  if (lowerBound) return `≥${amount === 0 ? '$0' : formatMoney(amount)}${api == null ? '' : ` ${api}`}`;
  return whole ?? (api == null ? formatMoney(amount) : `${formatMoney(amount)} ${api}`);
}

export default spendFacts;
