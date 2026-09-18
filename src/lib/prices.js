// Published plan prices and operator-declared subscription economics.
//
// This module is intentionally offline. A plan price is money, so an absent
// or malformed source is represented by null rather than a guessed number.

import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PLAN_PRICES_SCHEMA = 'bullswarm.plan-prices.v1';
const DEFAULT_FILE = fileURLToPath(new URL('../../data/plan-prices.json', import.meta.url));
const cache = new Map();
const DAYS_PER_MONTH = 30;

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function nonNegative(value) {
  if (value == null || value === '' || typeof value === 'boolean') return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function sourceValue(source) {
  if (typeof source === 'string') return source;
  if (object(source)) return source.url ?? source.href ?? source.name ?? null;
  return null;
}

function updatedAtValue(source) {
  return object(source) ? source.updatedAt ?? source.retrievedAt ?? null : null;
}

function tableEntries(table) {
  if (!object(table)) return {};
  for (const key of ['prices', 'plans', 'pools', 'subscriptions', 'entries']) {
    if (object(table[key])) return table[key];
    if (Array.isArray(table[key])) {
      return Object.fromEntries(table[key]
        .filter((entry) => object(entry) && (entry.pool ?? entry.name ?? entry.id))
        .map((entry) => [entry.pool ?? entry.name ?? entry.id, entry]));
    }
  }
  // A small custom table may use pool names at the top level. Do not mistake
  // metadata for a plan record.
  const metadata = new Set(['schemaVersion', 'source', 'updatedAt', 'basis', 'notes', 'missingReason']);
  return Object.fromEntries(Object.entries(table).filter(([key, value]) => (
    !metadata.has(key) && object(value)
  )));
}

function fileKey(file) {
  return file ? resolve(String(file)) : DEFAULT_FILE;
}

/**
 * Load the bundled plan-price table once per file path. A custom file is
 * useful for an operator or a fixture; it is still parsed without network
 * access. An absent or malformed file returns null so callers can render an
 * explicit missing-price reason.
 */
export function planPrices({ file = null } = {}) {
  const path = fileKey(file);
  let fingerprint = null;
  try {
    const stat = statSync(path);
    fingerprint = `${stat.size}:${stat.mtimeMs}`;
  } catch {
    return null;
  }
  const cached = cache.get(path);
  if (cached?.fingerprint === fingerprint) return cached.value;
  if (!existsSync(path)) return null;
  try {
    const value = JSON.parse(readFileSync(path, 'utf8'));
    if (!object(value)) return null;
    if (value.schemaVersion != null && value.schemaVersion !== PLAN_PRICES_SCHEMA) return null;
    cache.set(path, { fingerprint, value });
    return value;
  } catch {
    return null;
  }
}

function resolvedPrice(record, { source = null, updatedAt = null, basis = null } = {}) {
  if (!object(record)) return null;
  const monthlyPriceUsd = nonNegative(record.monthlyPriceUsd);
  // No monthly price means there is no subscription-rate amount to return.
  // `includedValueUsd` by itself is not a price and must not become a guess.
  if (monthlyPriceUsd == null) return null;
  const includedValueUsd = nonNegative(record.includedValueUsd);
  return {
    monthlyPriceUsd,
    includedValueUsd,
    source: sourceValue(record.source) ?? source,
    updatedAt: record.updatedAt ?? updatedAtValue(record.source) ?? updatedAt ?? null,
    basis: record.basis ?? basis ?? 'declared monthly subscription price',
  };
}

function hasPriceOverride(record) {
  return object(record) && (
    Object.prototype.hasOwnProperty.call(record, 'monthlyPriceUsd')
    || Object.prototype.hasOwnProperty.call(record, 'includedValueUsd')
  );
}

/**
 * Resolve one pool's monthly subscription economics. State overrides are
 * checked first, including an explicit null (which intentionally suppresses
 * a table value). Otherwise the bundled published table is consulted.
 */
export function priceFor(pool, { subscriptions = {}, file = null } = {}) {
  const name = typeof pool === 'string'
    ? pool.trim()
    : String(pool?.name ?? pool?.pool ?? '').trim();
  if (!name) return null;
  const override = subscriptions?.[name];
  if (hasPriceOverride(override)) {
    return resolvedPrice(override, {
      source: sourceValue(override?.source) ?? 'user-declared',
      updatedAt: override?.updatedAt ?? null,
      basis: override?.basis ?? 'state.strategy.subscriptions override',
    });
  }

  const table = planPrices({ file });
  const entry = tableEntries(table)[name];
  return resolvedPrice(entry, {
    source: sourceValue(entry?.source) ?? sourceValue(table?.source),
    updatedAt: entry?.updatedAt ?? updatedAtValue(entry?.source)
      ?? table?.updatedAt ?? updatedAtValue(table?.source) ?? null,
    basis: entry?.basis ?? table?.basis ?? 'published plan price',
  });
}

/**
 * Pro-rate a declared monthly price over a window using the explicit 30-day
 * month convention. Accepts either the object returned by priceFor or a
 * monthly numeric value for small model callers.
 */
export function subscriptionCostUsd(price, { days = 7 } = {}) {
  const monthlyPriceUsd = nonNegative(object(price) ? price.monthlyPriceUsd : price);
  const windowDays = nonNegative(days);
  if (monthlyPriceUsd == null || windowDays == null) return null;
  return Math.round((monthlyPriceUsd * windowDays / DAYS_PER_MONTH) * 1e8) / 1e8;
}
